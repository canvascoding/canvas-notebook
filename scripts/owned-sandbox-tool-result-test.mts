import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { request } from '@playwright/test';
import { readTextWindow } from '../app/lib/pi/text-read-window';
import { readOwnedSandboxToolResult } from '../tests/helpers/owned-sandbox-tool-result';

type RecordValue = Record<string, unknown>;
type Input = Omit<Parameters<typeof readOwnedSandboxToolResult>[0], 'request'>;
type Page = { content: string; offset: number; nextOffset: number | null; totalChars: number; eof: boolean; sha256: string };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; disconnect?: boolean };
type Scenario = { change?: (input: Input) => void; reply?: (page: Page, index: number) => Reply; requests: number };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown) => { assert(value && typeof value === 'object' && !Array.isArray(value)); return value as RecordValue; };
const metadata = (result: RecordValue) => record(record(result.details).toolOutput);
const reference = (result: RecordValue) => (metadata(result).references as RecordValue[])[0];

function original() {
  // Put a surrogate pair across the first 10000-character boundary. Pagination
  // uses the production UTF-16 window function; byte counts use real UTF-8.
  const prefix = '{"content":[{"type":"text","text":"';
  const text = 'x'.repeat(9999 - prefix.length) + '😀' + 'Grüße 漢字 🧪\n'.repeat(2200);
  const result = { content: [{ type: 'text', text }], details: {
    kind: 'skill_script_result', success: true, id: 'python', runtime: 'python', files: [],
    stdout: JSON.stringify({ kind: 'native-markdown-sandbox-receipt', runtime: 'python', mode: 'edit', edited: true }),
    toolResults: [{ toolName: 'read', result: { content: [{ type: 'text', text: '{"source":"blocks"}' }],
      details: { collaboration: { source: 'live_yjs', documentId: 'owned-document', lifecycleGeneration: 3 } } } },
    { toolName: 'edit_file', result: { content: [{ type: 'text', text: 'Applied.' }], details: {
      kind: 'file_mutation', outcome: 'applied', path: 'owned.md', afterSha256: 'b'.repeat(64),
      collaboration: { operationId: 'owned-operation', operationStatus: 'persisted_yjs', durability: 'persisted_yjs', reviewRequired: false },
    } } }],
  } };
  const content = JSON.stringify(result);
  assert.equal(content.slice(9999, 10001), '😀');
  const toolCallId = 'call_owned_sandbox_archive_contract';
  const ref = { reference: `tool-output://call-${hash(toolCallId)}/output-${'1'.repeat(32)}.json`,
    bytes: Buffer.byteLength(content), characters: content.length, sha256: hash(content), complete: true };
  const live = { content: [{ type: 'text', text: 'Bounded original preview.' }], details: {
    kind: 'skill_script_result', success: true, toolOutput: { version: 1, policyVersion: 'tool-output-v1',
      rawChars: content.length, modelChars: 25, storedBytes: ref.bytes, references: [ref] },
  } };
  const input: Input = { sessionId: 'owned-contract-session', agentId: 'owned-contract-agent', workspaceId: 'owned-contract-workspace',
    toolCallId, live, persisted: { role: 'toolResult', toolCallId, toolName: 'run_canvas_skill_script', isError: false,
      ...structuredClone(live) } };
  return { result, content, input, ref };
}

function changeBoth(input: Input, change: (ref: RecordValue) => void) {
  change(reference(input.live)); change(reference(input.persisted));
}

/** A bounded HTTP protocol fixture, not an authorization or runtime acceptance
 * test. It verifies the real Playwright request transport and response contract;
 * only the application's original E2E can prove actual user/session access. */
async function fixture(scenario: Omit<Scenario, 'requests'> = {}) {
  const archive = original(); scenario.change?.(archive.input);
  const before = structuredClone(archive.input), observed: Array<{ offset: number; nextOffset: number }> = [], failures: unknown[] = [];
  const server = createServer((incoming, outgoing) => {
    try {
      assert(observed.length < 70, 'The reader exceeded this fixture request budget.');
      const url = new URL(incoming.url!, 'http://127.0.0.1');
      assert.equal(incoming.method, 'GET');
      assert.equal(url.pathname, `/api/sessions/${encodeURIComponent(archive.input.sessionId)}/tool-output`);
      assert.equal(incoming.headers.cookie, 'owned-contract-session=fixture-only');
      assert.deepEqual([...url.searchParams.keys()].sort(), ['agentId', 'maxChars', 'offset', 'reference', 'workspaceId']);
      assert.equal(url.searchParams.get('agentId'), archive.input.agentId);
      assert.equal(url.searchParams.get('workspaceId'), archive.input.workspaceId);
      assert.equal(url.searchParams.get('reference'), reference(archive.input.live).reference);
      assert.equal(url.searchParams.get('maxChars'), '10000');
      const offset = Number(url.searchParams.get('offset'));
      assert(Number.isSafeInteger(offset) && offset >= 0);
      const window = readTextWindow(archive.content, offset, 10000);
      const page: Page = { content: window.text, offset: window.offset, nextOffset: window.nextOffset,
        totalChars: window.totalChars, eof: window.eof, sha256: archive.ref.sha256 };
      const index = observed.length; observed.push({ offset, nextOffset: page.nextOffset! });
      const reply = scenario.reply?.(page, index) ?? { body: page };
      if (reply.disconnect) { incoming.socket.destroy(); return; }
      outgoing.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
      outgoing.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? page));
    } catch (failure) {
      failures.push(failure); outgoing.writeHead(500); outgoing.end('{"error":"Invalid fixture request."}');
    }
  });
  server.maxRequestsPerSocket = 80; server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address === 'object');
  const client = await request.newContext({ baseURL: `http://127.0.0.1:${address.port}`, timeout: 5000,
    storageState: { cookies: [{ name: 'owned-contract-session', value: 'fixture-only', domain: '127.0.0.1', path: '/',
      expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] } });
  return { ...archive, observed,
    read: () => readOwnedSandboxToolResult({ request: client, ...archive.input }),
    async close() {
      try { await client.dispose(); }
      finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
      assert.deepEqual(failures, [], 'The reader must send the actual public endpoint request contract.');
      assert.deepEqual(archive.input, before, 'The reader must preserve both retained evidence inputs even on rejection.');
      assert.equal(server.listening, false);
    },
  };
}

function pageCount(content: string) {
  let offset = 0, pages = 0;
  while (offset < content.length) { offset = readTextWindow(content, offset, 10000).nextOffset; pages++; }
  return pages;
}

test('inline originals require no HTTP and return a separate complete retained result', { timeout: 10000 }, async () => {
  const owned = await fixture({ change(input) {
    input.live = { ...original().result, details: { ...original().result.details, toolOutput: {
      version: 1, policyVersion: 'tool-output-v1', rawChars: 100, modelChars: 100, storedBytes: 0, references: [] } } };
    input.persisted = structuredClone(input.live);
  } });
  try {
    const output = await owned.read();
    assert.deepEqual(output.source, { kind: 'inline' }); assert.deepEqual(output.result, owned.input.live);
    assert.notEqual(output.result, owned.input.live); assert.notEqual(output.result.details, owned.input.live.details);
    assert.deepEqual(record(output.result.details).toolResults, owned.result.details.toolResults);
    assert.equal(owned.observed.length, 0);
  } finally { await owned.close(); }
});

test('multiple real HTTP pages preserve Unicode, exact SHA/UTF8 bytes and every nested native receipt', { timeout: 10000 }, async () => {
  const owned = await fixture();
  try {
    const output = await owned.read(); assert.deepEqual(output.result, owned.result);
    assert.deepEqual(record(output.result.details).toolResults, owned.result.details.toolResults);
    assert.deepEqual(output.source, { kind: 'archive', reference: owned.ref.reference, sha256: hash(owned.content),
      bytes: Buffer.byteLength(owned.content), characters: owned.content.length, pages: pageCount(owned.content) });
    assert(owned.observed.length >= 4); assert.equal(owned.observed[0].nextOffset, 9999);
    assert.equal(owned.observed[1].offset, 9999);
    assert.equal(owned.observed.at(-1)!.nextOffset, owned.content.length);
    assert(owned.ref.bytes > owned.ref.characters, 'The fixture must distinguish UTF-8 bytes from UTF-16 indices.');
  } finally { await owned.close(); }
});

const pages = pageCount(original().content);
const negatives: Array<[string, Scenario]> = [
  ['missing live metadata', { change(input) { delete record(input.live.details).toolOutput; }, requests: 0 }],
  ['missing persisted metadata', { change(input) { delete record(input.persisted.details).toolOutput; }, requests: 0 }],
  ['different persisted reference', { change(input) { reference(input.persisted).sha256 = 'a'.repeat(64); }, requests: 0 }],
  ['multiple ambiguous references', { change(input) { for (const result of [input.live, input.persisted]) (metadata(result).references as unknown[]).push(structuredClone(reference(result))); }, requests: 0 }],
  ['incomplete original', { change(input) { changeBoth(input, ref => { ref.complete = false; }); }, requests: 0 }],
  ['missing completion evidence', { change(input) { changeBoth(input, ref => { delete ref.complete; }); }, requests: 0 }],
  ['unavailable live storage', { change(input) { metadata(input.live).storageError = 'Unavailable.'; }, requests: 0 }],
  ['unavailable persisted storage', { change(input) { metadata(input.persisted).storageError = 'Unavailable.'; }, requests: 0 }],
  ['foreign call reference', { change(input) { changeBoth(input, ref => { ref.reference = `tool-output://call-${hash('foreign-call')}/output-${'1'.repeat(32)}.json`; }); }, requests: 0 }],
  ['non-JSON reference', { change(input) { changeBoth(input, ref => { ref.reference = String(ref.reference).replace('.json', '.txt'); }); }, requests: 0 }],
  ['invalid SHA syntax', { change(input) { changeBoth(input, ref => { ref.sha256 = 'not-a-sha'; }); }, requests: 0 }],
  ['zero byte metadata', { change(input) { changeBoth(input, ref => { ref.bytes = 0; }); }, requests: 0 }],
  ['oversize byte metadata', { change(input) { changeBoth(input, ref => { ref.bytes = 2 * 1024 * 1024 + 1; }); }, requests: 0 }],
  ['oversize character metadata', { change(input) { changeBoth(input, ref => { ref.characters = 500001; }); }, requests: 0 }],
  ['first-page wrong SHA', { reply(page) { return { body: { ...page, sha256: 'a'.repeat(64) } }; }, requests: 1 }],
  ['second-page changing SHA', { reply(page, index) { return { body: { ...page, ...(index === 1 ? { sha256: 'a'.repeat(64) } : {}) } }; }, requests: 2 }],
  ['wrong totalChars', { reply(page) { return { body: { ...page, totalChars: page.totalChars + 1 } }; }, requests: 1 }],
  ['second-page changing totalChars', { reply(page, index) { return { body: { ...page, ...(index === 1 ? { totalChars: page.totalChars - 1 } : {}) } }; }, requests: 2 }],
  ['wrong initial offset', { reply(page) { return { body: { ...page, offset: 1 } }; }, requests: 1 }],
  ['overlapping second-page offset', { reply(page, index) { return { body: { ...page, ...(index === 1 ? { offset: 0 } : {}) } }; }, requests: 2 }],
  ['wrong nextOffset', { reply(page) { return { body: { ...page, nextOffset: page.nextOffset! + 1 } }; }, requests: 1 }],
  ['no page progress', { reply(page) { return { body: { ...page, content: '', nextOffset: 0 } }; }, requests: 1 }],
  ['oversize page characters', { reply(page) { return { body: { ...page, content: 'x'.repeat(10001) } }; }, requests: 1 }],
  ['truncated response marked EOF', { reply(page) { return { body: { ...page, eof: true } }; }, requests: 1 }],
  ['nonboolean EOF', { reply(page) { return { body: { ...page, eof: 'false' } }; }, requests: 1 }],
  ['missing final EOF', { reply(page) { return { body: { ...page, eof: false } }; }, requests: pages }],
  ['null final nextOffset', { reply(page) { return { body: { ...page, ...(page.eof ? { nextOffset: null } : {}) } }; }, requests: pages }],
  ['final UTF8 byte mismatch', { change(input) { changeBoth(input, ref => { ref.bytes = Number(ref.bytes) + 1; }); }, requests: pages }],
  ['final digest differs despite stable advertised SHA', { change(input) { changeBoth(input, ref => { ref.sha256 = 'a'.repeat(64); }); }, reply(page) { return { body: { ...page, sha256: 'a'.repeat(64) } }; }, requests: pages }],
  ['over 64 valid but tiny pages', { reply(page) { const content = original().content.slice(page.offset, page.offset + 1); return { body: { ...page, content, nextOffset: page.offset + 1, eof: false } }; }, requests: 64 }],
  ['oversize HTTP body', { reply() { return { body: ' '.repeat(128 * 1024 + 1) }; }, requests: 1 }],
  ['invalid JSON page', { reply() { return { body: '{truncated' }; }, requests: 1 }],
  ['unavailable HTTP archive', { reply() { return { status: 404, body: { error: 'Stored output is unavailable.' } }; }, requests: 1 }],
  ['unauthenticated HTTP request', { reply() { return { status: 401, body: { error: 'Unauthorized' } }; }, requests: 1 }],
  ['unauthorized HTTP workspace', { reply() { return { status: 403, body: { error: 'Workspace or agent inaccessible.' } }; }, requests: 1 }],
  ['rate limited HTTP request', { reply() { return { status: 429, body: { error: 'Limited.' } }; }, requests: 1 }],
  ['HTTP server failure', { reply() { return { status: 503, body: { error: 'Unavailable.' } }; }, requests: 1 }],
  ['HTTP redirect must not be followed', { reply() { return { status: 302, headers: { Location: '/foreign-archive' }, body: {} }; }, requests: 1 }],
  ['disconnected HTTP response must not be retried', { reply() { return { disconnect: true }; }, requests: 1 }],
];

for (const [name, scenario] of negatives) {
  test(`reject ${name} without retrying or changing retained evidence`, { timeout: 10000 }, async () => {
    const owned = await fixture(scenario);
    try { await assert.rejects(owned.read()); assert.equal(owned.observed.length, scenario.requests); }
    finally { await owned.close(); }
  });
}
