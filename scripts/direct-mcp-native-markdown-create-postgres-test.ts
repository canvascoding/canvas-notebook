import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { DirectMcpFileReceipt } from '../app/lib/mcp/server/file-ingest';
import type { DirectMcpFileReference } from '../app/lib/mcp/server/ingest-download';
import type { DocumentReadPageV1 } from '../app/lib/documents/contracts';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';
import { signalOwnChild, ownedGroupEmpty } from './run-yjs-authority-e2e';

// Actual registered MCP -> fixed native engine -> PG/FD/Birth/ID-read. Only
// owned syscall acknowledgements are paused; no auth, SQL, download or writer
// result is substituted. HTTPS uses the real downloader; OAuth issuance,
// compiled HTTP and host-reference mediation remain separate acceptance gates.
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => {
  assert(value && typeof value === 'object' && !Array.isArray(value)); return value as ObjectValue;
};
const sha = (value: string | Uint8Array): string => crypto.createHash('sha256').update(value).digest('hex');
let currentCase = 'setup', passed = 0, completed = false, rpcId = 0;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

async function rpc(token: string, method: string, params: ObjectValue): Promise<ObjectValue> {
  const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
  const id = ++rpcId, response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }));
  assert.equal(response.status, 200, 'The actual MCP transport must authenticate and dispatch.');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const body = object(await response.json()); assert.equal(body.id, id); assert.equal(body.jsonrpc, '2.0');
  assert.equal(Object.hasOwn(body, 'error'), false); return object(body.result);
}
const call = (token: string, name: string, args: ObjectValue): Promise<ObjectValue> => rpc(token, 'tools/call', { name, arguments: args });
function receipt(result: ObjectValue): DirectMcpFileReceipt {
  if (result.isError === true) {
    const detail = result.structuredContent;
    const actualCode = detail && typeof detail === 'object' && !Array.isArray(detail) ? Reflect.get(detail, 'code') : undefined;
    const code = typeof actualCode === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(actualCode) ? actualCode : 'UNCLASSIFIED';
    console.error('Native MCP unexpected tool error:', { currentCase, code });
  }
  assert.notEqual(result.isError, true, `Actual Create failed: ${String(object(result.structuredContent).code)}`);
  const value = object(result.structuredContent); assert(Array.isArray(result.content)); assert.equal(result.content.length, 1);
  assert.deepEqual(JSON.parse(String(object(result.content[0]).text)), value);
  assert(['created', 'already_created'].includes(String(value.status)));
  for (const field of ['operation_id', 'revision_id', 'path', 'workspace_id', 'sha256']) assert.equal(typeof value[field], 'string');
  assert.equal(typeof value.size, 'number'); return value as DirectMcpFileReceipt;
}
function failure(result: ObjectValue, code?: string): void {
  assert.equal(result.isError, true); const detail = object(result.structuredContent);
  assert.equal(typeof detail.code, 'string'); if (code) assert.equal(detail.code, code);
  for (const key of ['document_id', 'lineage_id', 'revision_id', 'status']) assert.equal(Object.hasOwn(detail, key), false);
}

type ImportWorkerSource = { tool: 'import_knowledge_file'; file: DirectMcpFileReference };
type WorkerInput = { token: string; workspaceId: string; target: string; key: string;
  pause: 'intent_durable' | 'before_link' | 'legacy_prepared'; operationId: string }
  & ({ tool: 'create_knowledge_source'; content: string } | ImportWorkerSource);
// The same actual ESM bundle starts the second Node instance. Its inherited
// DATA/PGOPTIONS/JWKS refer to the ONE existing fixture, never a new database.
async function worker(descriptor: string): Promise<void> {
  const info = await fs.lstat(descriptor); assert(info.isFile() && !info.isSymbolicLink());
  assert.equal(info.mode & 0o777, 0o600); assert.equal(info.uid, process.getuid?.());
  const input = JSON.parse(await fs.readFile(descriptor, 'utf8')) as WorkerInput;
  const runtime = await import('../app/lib/db'), pool = runtime.getPostgresRuntimeQueryable(); assert(pool);
  const childModule = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
  const originalSpawn = childModule.spawn, originalRename = fs.rename;
  const lockPath = path.join(process.env.DATA!, 'canvas-file-locks', `${sha(input.workspaceId)}.lock`);
  const journal = path.join(process.env.DATA!, 'system/mcp-file-ingest', `${input.operationId}.json`);
  let go!: () => void, release!: () => void, heldHelper: ChildProcess | undefined, didHold = false;
  const goGate = new Promise<void>(resolve => { go = resolve; }), holdGate = new Promise<void>(resolve => { release = resolve; });
  const pending: Promise<void>[] = [];
  const originalFetch = globalThis.fetch;
  const send = (message: ObjectValue): void => { assert(process.connected); process.send!(message); };
  const onMessage = (message: unknown): void => {
    if (message === 'go') go(); else if (message === 'release') release();
    else if (message === 'kill-helper') { assert(heldHelper?.pid); assert.equal(heldHelper.kill('SIGKILL'), true); }
  };
  process.on('message', onMessage);
  let result: ObjectValue | undefined;
  try {
  globalThis.fetch = async () => { throw new Error('External network is forbidden in the Generated Create worker.'); };
  childModule.spawn = ((...args: Parameters<typeof originalSpawn>) => {
    const child = originalSpawn(...args), argv = Array.isArray(args[1]) ? args[1] : [];
    if (argv.some(value => String(value).endsWith('/workspace-file-lock.py'))) {
      const options = object(args[2]), stdio = options.stdio;
      assert(Array.isArray(stdio)); const fd = stdio[3]; assert(typeof fd === 'number');
      const actual = syncFs.fstatSync(fd);
      let named: ReturnType<typeof syncFs.lstatSync> | undefined;
      try { named = syncFs.lstatSync(lockPath); } catch (error) {
        if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'ENOENT') throw error;
      }
      if (named && actual.dev === named.dev && actual.ino === named.ino) {
        send({ event: 'flock-start', dev: String(actual.dev), ino: String(actual.ino) });
        let output = ''; child.stdout?.on('data', chunk => {
          output += String(chunk); if (output === 'locked\n') send({ event: 'flock-acquired' });
        });
      }
    }
    if (argv.some(value => String(value).endsWith('/markdown-create-birth.py'))) {
      let output = '', stage = ''; const stdin = child.stdin; assert(stdin); const originalWrite = stdin.write;
      child.stdout?.on('data', chunk => { output += String(chunk); for (let end = output.indexOf('\n'); end >= 0; end = output.indexOf('\n')) {
        const line = output.slice(0, end); output = output.slice(end + 1); const value = object(JSON.parse(line));
        if (typeof value.stage === 'string') stage = value.stage;
      } });
      stdin.write = ((...writes: Parameters<typeof stdin.write>) => {
        if (!didHold && input.pause === stage && String(writes[0]) === 'continue\n') {
          didHold = true; heldHelper = child; send({ event: 'held', stage });
          const task = holdGate.then(() => { if (!child.killed) Reflect.apply(originalWrite, stdin, writes); });
          void task.catch(() => undefined); pending.push(task); return true;
        }
        return Reflect.apply(originalWrite, stdin, writes);
      }) as typeof stdin.write;
    }
    return child;
  }) as typeof originalSpawn;
  fs.rename = async (...args: Parameters<typeof originalRename>) => {
    await originalRename(...args);
    if (!didHold && input.pause === 'legacy_prepared' && String(args[1]) === journal) {
      const actual = object(JSON.parse(await fs.readFile(journal, 'utf8'))); assert.equal(actual.phase, 'prepared');
      didHold = true; send({ event: 'held', stage: 'legacy_prepared' }); await holdGate;
    }
  };
  syncBuiltinESMExports();
    // Import both workers before either retained ACK is held. Slow module
    // initialization must not consume the genuine publication-phase budget.
    await import('../app/lib/mcp/server/streamable-http');
    send({ event: 'ready' }); await goGate;
    result = input.tool === 'import_knowledge_file'
      ? await call(input.token, 'import_knowledge_file', { workspace_id: input.workspaceId,
        path: input.target, file: input.file, idempotency_key: input.key })
      : await call(input.token, 'create_knowledge_source', { workspace_id: input.workspaceId,
        path: input.target, content: input.content, idempotency_key: input.key });
  } finally {
    release(); await Promise.allSettled(pending); childModule.spawn = originalSpawn; fs.rename = originalRename;
    globalThis.fetch = originalFetch; syncBuiltinESMExports(); process.off('message', onMessage); await pool.end();
  }
  assert(result); await new Promise<void>((resolve, reject) => process.send!({ event: 'result', result }, error => error ? reject(error) : resolve()));
  completed = true; if (process.connected) { assert(process.disconnect); process.disconnect(); }
}

export async function directMcpNativeMarkdownCreatePostgresTest(): Promise<void> {
  // Independent public fixture IO happens before the fixture forbids fetch.
  // Production import below keeps that prohibition and uses its actual HTTPS
  // transport. No token, cookie, caller headers or redirect is forwarded here.
  const sourceUrl = 'https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/c518f7a927cff918bce35d3522fcdb046d264d7c/README.md';
  const originalResponse = await fetch(sourceUrl, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30_000) });
  assert(originalResponse.body, 'The immutable public fixture must return a body.');
  const reader = originalResponse.body.getReader(), chunks: Uint8Array[] = []; let sourceSize = 0;
  try {
    assert.equal(originalResponse.status, 200, 'The immutable public fixture must return HTTP 200.');
    assert.equal(originalResponse.url, sourceUrl);
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      sourceSize += chunk.value.byteLength;
      assert(sourceSize <= 10_000, 'The immutable README must remain within its small fixture budget.');
      chunks.push(chunk.value);
    }
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  const originalBytes = Buffer.concat(chunks), sourceHash = sha(originalBytes);
  assert(originalBytes.length >= 128 && originalBytes.length === sourceSize);
  assert.match(sourceHash, /^[a-f0-9]{64}$/u);
  const originalText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(originalBytes);
  assert(Buffer.from(originalText).equals(originalBytes)); assert(originalText.includes('# Model Context Protocol (MCP)'));
  // A second actual official body at the same immutable commit is used only
  // as a changed-byte host capability. Its availability is checked by Root's
  // eventual run; no fallback URL or invented response makes it pass.
  const changedSourceUrl = 'https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/c518f7a927cff918bce35d3522fcdb046d264d7c/LICENSE';
  const changedResponse = await fetch(changedSourceUrl, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30_000) });
  assert(changedResponse.body, 'The second immutable public fixture must return a body.');
  const changedReader = changedResponse.body.getReader(), changedChunks: Uint8Array[] = []; let changedSize = 0;
  try {
    assert.equal(changedResponse.status, 200, 'The second immutable public fixture must return HTTP 200.');
    assert.equal(changedResponse.url, changedSourceUrl);
    for (;;) {
      const chunk = await changedReader.read(); if (chunk.done) break;
      changedSize += chunk.value.byteLength;
      assert(changedSize <= 16_384, 'The immutable LICENSE must remain within its explicit 16 KiB fixture budget.');
      changedChunks.push(chunk.value);
    }
  } finally { try { await changedReader.cancel(); } finally { changedReader.releaseLock(); } }
  const changedBytes = Buffer.concat(changedChunks), changedHash = sha(changedBytes);
  assert(changedBytes.length >= 128 && changedBytes.length === changedSize); assert.notEqual(changedHash, sourceHash);
  assert.equal(changedHash, '0382b0057770ca05e9c350a50aa3b1c1fea84da0bc81d723bf00b9aa841be58a');
  const changedText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(changedBytes);
  assert(Buffer.from(changedText).equals(changedBytes)); assert(changedText.includes('Permission is hereby granted, free of charge'));
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { admin, workspaceId, clientId, workspaceRoot, dataRoot } = fixture;
    process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1';
    process.env.FILE_VERSION_CENTER_MODE = 'shadow'; // Real capture enabled; no history/review UI activation.
    process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source,search_knowledge,create_knowledge_source,import_knowledge_file';
    assert.equal((await admin.query(`UPDATE organization_user_permissions SET can_write_team_workspace=1
      WHERE organization_id='tool-dispatch-org' AND user_id='reader' AND status='active'`)).rowCount, 1);
    await admin.query(`UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2 AND user_id='reader'`,
      [JSON.stringify(['knowledge:read', 'knowledge:search', 'knowledge:write']), clientId]);
    const token = await fixture.issue({ scope: 'knowledge:read knowledge:search knowledge:write' });
    const authInfo = (actualToken = token): AuthInfo => ({ token: actualToken, clientId: 'untrusted', scopes: [] });
    const { persistAndProjectDirectMcpMarkdownCreate } = await import('../app/lib/collaboration/markdown-file-import-persistence');
    const { observeOptionalMarkdownCreateBirth } = await import('../app/lib/files/markdown-create-birth');
    const keyFor = (key: string): string => sha(JSON.stringify([clientId, 'reader', workspaceId, key]));
    const args = (target: string, content: string, key = crypto.randomUUID()): ObjectValue =>
      ({ workspace_id: workspaceId, path: target, content, idempotency_key: key });
    const create = async (target: string, content: string, key = crypto.randomUUID(), actualToken = token): Promise<DirectMcpFileReceipt> =>
      receipt(await call(actualToken, 'create_knowledge_source', args(target, content, key)));
    const observe = (operationId: string) => observeOptionalMarkdownCreateBirth({ workspaceRoot, workspaceId, operationId });
    const nativeRows = async (operationId: string) => ({
      receipt: (await admin.query(`SELECT *,xmin::text AS original_xmin FROM collaboration_markdown_file_import_receipts
        WHERE workspace_id=$1 AND operation_id=$2`, [workspaceId, operationId])).rows,
      birth: (await admin.query(`SELECT *,xmin::text AS original_xmin FROM collaboration_markdown_create_births
        WHERE workspace_id=$1 AND operation_id=$2`, [workspaceId, operationId])).rows,
      history: (await admin.query(`SELECT c.*,c.xmin::text AS original_xmin,b.content_sha256,b.raw_size_bytes
        FROM file_revision_contents c JOIN file_version_blobs b ON b.blob_id=c.blob_id AND b.workspace_id=c.workspace_id
        WHERE c.workspace_id=$1 AND c.revision_id=(SELECT revision_id FROM collaboration_markdown_create_births
          WHERE workspace_id=$1 AND operation_id=$2)`, [workspaceId, operationId])).rows,
    });
    const noTarget = async (target: string): Promise<void> => { await assert.rejects(fs.lstat(path.join(workspaceRoot, target)), { code: 'ENOENT' }); };
    const journal = (operationId: string): string => path.join(dataRoot, 'system/mcp-file-ingest', `${operationId}.json`);
    const check = async (name: string, action: () => Promise<void>): Promise<void> => {
      currentCase = name; await action(); passed++; console.log(`PASS Native MCP Create: ${name}`);
    };
    const verify = async (value: DirectMcpFileReceipt, source: string, session = 'reader-session'): Promise<void> => {
      assert.equal(value.workspace_id, workspaceId); assert.equal(typeof value.document_id, 'string'); assert(value.document_id);
      assert.equal(typeof value.lineage_id, 'string'); assert(value.lineage_id);
      const rows = await nativeRows(value.operation_id); assert.equal(rows.receipt.length, 1); assert.equal(rows.birth.length, 1);
      const r = rows.receipt[0], b = rows.birth[0], privateResult = object(r.private_result), target = object(privateResult.target);
      assert.equal(r.actor_user_id, 'reader'); assert.equal(r.actor_session_id, session);
      assert.equal(r.request_id, `mcp-create:${value.operation_id}`); assert.equal(privateResult.sourceHash, sha(Buffer.from(source)));
      assert.equal(Number(privateResult.sourceBytes), Buffer.byteLength(source));
      assert.equal(target.documentId, value.document_id); assert.equal(target.lineageId, value.lineage_id);
      assert.equal(b.document_id, value.document_id); assert.equal(Number(b.lifecycle_generation), 1);
      assert.equal(Number(b.finalized), 1); assert.equal(b.revision_id, value.revision_id); assert.equal(b.serialized_hash, value.sha256);
      const d = (await admin.query(`SELECT d.id,d.lineage_id,d.provider,d.yjs_state_lifecycle,d.status,s.document_id,
        s.lifecycle_generation,s.document_sequence,l.id AS actual_lineage,l.status AS lineage_status
        FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id
        JOIN file_collaboration_lineages l ON l.id=d.lineage_id WHERE d.id=$1 AND d.workspace_id=$2`,
      [value.document_id, workspaceId])).rows[0];
      assert(d); assert.equal(d.provider, 'yjs'); assert.equal(d.yjs_state_lifecycle, 'initialized'); assert.equal(d.status, 'active');
      assert.equal(d.actual_lineage, value.lineage_id); assert.equal(d.lineage_status, 'active');
      assert.equal(Number(d.lifecycle_generation), 1); assert.equal(Number(d.document_sequence), 0);
      const p = (await admin.query('SELECT * FROM collaboration_file_projections WHERE document_id=$1', [value.document_id])).rows[0];
      assert(p); assert.equal(Number(p.finalized), 1); assert.equal(p.revision_id, value.revision_id);
      const revision = (await admin.query('SELECT * FROM file_revisions WHERE id=$1 AND workspace_id=$2', [value.revision_id, workspaceId])).rows[0];
      assert(revision); assert.equal(revision.created_by_user_id, 'reader'); assert.equal(revision.created_by_actor_type, 'agent');
      assert.equal(revision.source_session_id, session); assert.equal(revision.lineage_id, value.lineage_id);
      assert.equal(rows.history.length, 1); const history = rows.history[0];
      assert.equal(history.source, 'external_import'); assert.equal(history.revision_id, value.revision_id);
      assert.equal(history.lineage_id, value.lineage_id); assert.equal(history.content_sha256, value.sha256);
      assert.equal(Number(history.raw_size_bytes), value.size);
      const bytes = await fs.readFile(path.join(workspaceRoot, value.path)); assert.equal(sha(bytes), value.sha256);
      assert.equal(bytes.length, value.size); assert.deepEqual(bytes, Buffer.from(source));
      const claim = await observe(value.operation_id); assert(claim); assert.equal(claim.complete, true);
      assert.equal(claim.id, b.claim_id); assert.equal(claim.fingerprint, b.claim_fingerprint);
      const provenance = object(claim.intent.source), origin = object(claim.intent.origin);
      assert.equal(provenance.kind, 'direct-mcp-markdown-v1'); assert.equal(provenance.clientId, clientId);
      assert.equal(provenance.actorSessionId, session); assert.equal(origin.sessionId, session); assert.equal(origin.clientId, clientId);
      assert.equal(provenance.sourceHash, sha(Buffer.from(source))); assert.equal(provenance.sourceBytes, Buffer.byteLength(source));
      assert.equal(provenance.tool, 'create_knowledge_source'); assert.equal(provenance.fileId, null); assert.equal(provenance.declaredMimeType, null);
      assert.equal(provenance.operationId, value.operation_id); assert.equal(provenance.requestId, r.request_id);
      assert.equal(typeof provenance.ingestValidationJson, 'string');
      await assert.rejects(fs.lstat(journal(value.operation_id)), { code: 'ENOENT' });
    };
    const readNative = async (value: DirectMcpFileReceipt, expectedVersion?: string): Promise<DocumentReadPageV1> => {
      const result = await call(token, 'read_knowledge_source', { workspace_id: workspaceId, document_id: value.document_id,
        format: 'native', max_bytes: 262144, ...(expectedVersion ? { expected_version: expectedVersion } : {}) });
      assert.notEqual(result.isError, true);
      const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/server/validators/ajv');
      const { DOCUMENT_READ_PAGE_JSON_SCHEMA_V1 } = await import('../app/lib/documents/read-json-schema');
      const validated = new AjvJsonSchemaValidator().getValidator<DocumentReadPageV1>(DOCUMENT_READ_PAGE_JSON_SCHEMA_V1)(result.structuredContent);
      assert.equal(validated.valid, true, validated.errorMessage ?? 'The actual native page must match its schema.');
      const page = validated.data; assert(page);
      assert.equal(page.apiVersion, 1); assert.equal(page.format, 'native'); assert.equal(page.document.documentId, value.document_id);
      assert.equal(page.document.lineageId, value.lineage_id); assert.equal(page.document.lifecycleGeneration, 1);
      assert.match(page.document.version, /^[^\s]+$/u); assert.equal(page.complete, true); assert.equal(page.nextCursor, null);
      assert.equal(page.byteLength, Buffer.byteLength(page.fragment)); assert.equal(page.totalBytes, page.byteLength);
      const body = object(JSON.parse(page.fragment)); assert.equal(body.bodyVersion, 1); assert(object(body.content));
      assert.equal(Object.hasOwn(page, 'sha256'), false); return page;
    };

    type GuardedChild = Parameters<typeof signalOwnChild>[0];
    type OwnedWorker = { entry: GuardedChild; name: string; closed: Promise<void>; result: Promise<ObjectValue>;
      ready: Promise<void>; held: Promise<void>; flock: Promise<ObjectValue>; acquired: number;
      send: (message: 'go' | 'release' | 'kill-helper') => void };
    const workers: OwnedWorker[] = [];
    const startWorker = async (target: string, content: string | ImportWorkerSource, key: string, pause: WorkerInput['pause']): Promise<OwnedWorker> => {
      const nonce = crypto.randomUUID().replaceAll('-', ''), file = path.join(dataRoot, `mcp-worker-${nonce}.json`);
      // Keep the actual application_name below PostgreSQL's 63-byte bound;
      // otherwise a query for the untruncated requested name proves nothing.
      const name = `mcp-native-child-${nonce}`; assert(Buffer.byteLength(name) < 63);
      const common = { token, workspaceId, target, key, pause, operationId: keyFor(key) };
      const input: WorkerInput = typeof content === 'string' ? { ...common, tool: 'create_knowledge_source', content }
        : { ...common, tool: 'import_knowledge_file', file: content.file };
      await fs.writeFile(file, JSON.stringify(input), { flag: 'wx', mode: 0o600 });
      const child = spawn(process.execPath, ['--conditions=react-server', process.argv[1]], { cwd: process.cwd(),
        env: { ...process.env, PGOPTIONS: `${process.env.PGOPTIONS} -c application_name=${name}`,
          CANVAS_NATIVE_MCP_CREATE_CHILD: file }, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      assert(child.pid); let closedResolve!: () => void, readyResolve!: () => void, heldResolve!: () => void;
      let flockResolve!: (value: ObjectValue) => void, resultResolve!: (value: ObjectValue) => void;
      let resultReject!: (error: unknown) => void, primary: unknown;
      const closed = new Promise<void>(resolve => { closedResolve = resolve; });
      const result = new Promise<ObjectValue>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
      void result.catch(() => undefined);
      const owner: OwnedWorker = { entry: { process: child, pid: child.pid, started: '', cwd: process.cwd(), ended: false,
        closed, logPath: `${file}.log` }, name, closed, result, acquired: 0,
        ready: new Promise<void>(resolve => { readyResolve = resolve; }),
        held: new Promise<void>(resolve => { heldResolve = resolve; }),
        flock: new Promise<ObjectValue>(resolve => { flockResolve = resolve; }),
        send: message => { assert(child.connected); child.send(message); } };
      workers.push(owner);
      const timer = setTimeout(() => { primary = new Error('Own MCP worker exceeded its finite wall budget.');
        resultReject(primary); void signalOwnChild(owner.entry, 'SIGKILL').catch(resultReject); }, 120000);
      let outputBytes = 0; const output = (chunk: Buffer): void => { outputBytes += chunk.byteLength;
        if (outputBytes > 65536) { primary = new Error('Own MCP worker output exceeded its bound.'); resultReject(primary);
          void signalOwnChild(owner.entry, 'SIGKILL').catch(resultReject); } };
      child.stdout?.on('data', output); child.stderr?.on('data', output);
      child.once('error', error => { primary = error; resultReject(error); });
      let actualResult: ObjectValue | undefined;
      child.on('message', value => { const message = object(value);
        if (message.event === 'ready') readyResolve(); else if (message.event === 'held') heldResolve();
        else if (message.event === 'flock-start') flockResolve(message);
        else if (message.event === 'flock-acquired') owner.acquired++;
        else if (message.event === 'result') actualResult = object(message.result);
      });
      child.once('close', (code, signal) => { clearTimeout(timer); owner.entry.ended = true; closedResolve();
        if (primary) resultReject(primary); else if (code !== 0 || signal || !actualResult) resultReject(new Error('Own MCP worker did not finish normally.'));
        else resultResolve(actualResult); });
      for (let attempt = 0; attempt < 40 && !owner.entry.ended; attempt++) {
        try { owner.entry.started = execFileSync('ps', ['-p', String(child.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
          if (owner.entry.started) break; } catch { /* Observe only this actual just-spawned PID. */ }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert(owner.entry.started || owner.entry.ended); return owner;
    };
    const event = <T>(owner: OwnedWorker, wanted: Promise<T>): Promise<T> => Promise.race([
      wanted, owner.result.then(() => { throw new Error('Own worker ended before its required real boundary.'); }),
    ]);
    const closedWorker = async (owner: OwnedWorker): Promise<void> => {
      await owner.closed; assert(ownedGroupEmpty(owner.entry));
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1', [owner.name])).rows[0].count, 0);
    };
    let primary: unknown, hasPrimary = false;
    try {
      await check('registered generated native creation and ID read survive missing projection', async () => {
        const initialized = await rpc(token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {},
          clientInfo: { name: 'native-create-owned-fixture', version: '1' } }); assert(object(initialized.serverInfo));
        const listed = await rpc(token, 'tools/list', {}); assert(Array.isArray(listed.tools));
        for (const name of ['create_knowledge_source', 'import_knowledge_file', 'read_knowledge_source']) {
          const tool = object(listed.tools.find(value => object(value).name === name)); assert(object(tool.inputSchema));
        }
        const source = '# Native MCP\n\nActual **rich** body.\n', created = await create('native/deep/created.md', source);
        assert.equal(created.status, 'created'); await verify(created, source); const first = await readNative(created);
        assert(first.fragment.includes('Native MCP'), 'The full native body must contain the actually submitted heading.');
        const before = await fixture.snapshot(); await fs.unlink(path.join(workspaceRoot, created.path)); await noTarget(created.path);
        const absent = await readNative(created, first.document.version); assert.deepEqual(absent.document, first.document); assert.equal(absent.fragment, first.fragment);
        assert.deepEqual(await fixture.snapshot(), before); await noTarget(created.path);
      });
      await check('empty and source-only content retain MCP provenance and source byte profiles', async () => {
        for (const [target, source] of [['empty.markdown', ''], ['source-only.md', '\uFEFF%% keep source %%\r\nBody 🦊\r\n']] as const) {
          const created = await create(target, source); await verify(created, source); await readNative(created);
          const claim = await observe(created.operation_id); assert(claim);
          assert.equal(object(claim.intent.source).kind, 'direct-mcp-markdown-v1');
          assert.notEqual(object(claim.intent.source).kind, 'manual-empty-v1');
        }
      });
      await check('renewed actual SID B preserves immutable original A and agent revision attribution', async () => {
        const key = crypto.randomUUID(), source = '# Original session A\n', created = await create('renewed.md', source, key);
        const before = await nativeRows(created.operation_id), original = await observe(created.operation_id); assert(original);
        const sid = `mcp-native-${crypto.randomUUID()}`;
        await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
          VALUES($1,$2,'reader',$3,$4,$4)`, [sid, crypto.randomBytes(32).toString('hex'), Date.now() + 3600000, Date.now()]);
        const fresh = await fixture.issue({ sid, scope: 'knowledge:read knowledge:write' });
        await admin.query(`UPDATE "session" SET expires_at=1 WHERE id='reader-session'`);
        try { const retried = await create(created.path, source, key, fresh); assert.equal(retried.status, 'already_created');
          assert.equal(retried.operation_id, created.operation_id); assert.equal(retried.revision_id, created.revision_id);
          assert.equal(retried.document_id, created.document_id); assert.equal(retried.lineage_id, created.lineage_id);
          await verify(retried, source); assert.deepEqual(await nativeRows(created.operation_id), before);
          assert.deepEqual(await observe(created.operation_id), original);
        } finally { await fixture.restoreReaderSession(); await admin.query('DELETE FROM "session" WHERE id=$1', [sid]); }
      });
      await check('cross-instance Native/Legacy same key reserves one original in both winner orders', async () => {
        for (const firstKind of ['native', 'legacy'] as const) {
          const key = crypto.randomUUID(), op = keyFor(key), nativePath = `cross-${firstKind}.md`, legacyPath = `cross-${firstKind}.txt`;
          const firstPath = firstKind === 'native' ? nativePath : legacyPath, otherPath = firstKind === 'native' ? legacyPath : nativePath;
          const second = await startWorker(otherPath, 'Different actual source\n', key, 'intent_durable');
          const first = await startWorker(firstPath, 'First actual source\n', key, firstKind === 'native' ? 'intent_durable' : 'legacy_prepared');
          await Promise.all([event(first, first.ready), event(second, second.ready)]);
          first.send('go'); await event(first, first.held); assert(first.acquired > 0);
          second.send('go'); const lock = await event(second, second.flock);
          const named = await fs.lstat(path.join(dataRoot, 'canvas-file-locks', `${sha(workspaceId)}.lock`));
          assert.equal(lock.dev, String(named.dev)); assert.equal(lock.ino, String(named.ino)); assert.equal(second.acquired, 0);
          // Independently prove the actual named kernel lock is still held
          // while the second real helper has started on that same inode.
          const probe = spawnSync(process.env.CANVAS_PYTHON_PATH?.trim() || 'python3', ['-I', '-c',
            'import fcntl,os,sys\nf=os.open(sys.argv[1],os.O_RDWR|os.O_NOFOLLOW)\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(7)\nsys.exit(0)',
            path.join(dataRoot, 'canvas-file-locks', `${sha(workspaceId)}.lock`)], { timeout: 5000, encoding: 'utf8' });
          assert.equal(probe.error, undefined); assert.equal(probe.signal, null); assert.equal(probe.status, 7);
          first.send('release'); const winner = receipt(await first.result); const loser = await second.result;
          await closedWorker(first); await closedWorker(second); failure(loser, 'MCP_INGEST_IDEMPOTENCY_CONFLICT');
          assert.equal(winner.status, 'created'); assert.equal(winner.operation_id, op); assert.equal(winner.path, firstPath);
          assert.deepEqual(await fs.readFile(path.join(workspaceRoot, firstPath)), Buffer.from('First actual source\n')); await noTarget(otherPath);
          const rows = await nativeRows(op), claim = await observe(op);
          if (firstKind === 'native') { assert.equal(rows.birth.length, 1); assert(claim); await verify(winner, 'First actual source\n'); }
          else { assert.equal(rows.birth.length, 0); assert.equal(rows.receipt.length, 0); assert.equal(claim, null);
            assert.equal(object(JSON.parse(await fs.readFile(journal(op), 'utf8'))).phase, 'completed'); }
        }
      });
      await check('genuine existing Legacy Markdown uses explicit sentinel without fabricated Native origin', async () => {
        const { createDirectMcpIngestAuthority } = await import('../app/lib/mcp/server/ingest-authority');
        const { createDirectMcpWorkspaceFile, directMcpIngestFingerprint } = await import('../app/lib/mcp/server/file-ingest');
        const { encodeDirectMcpTextContent, validateDirectMcpIngestContent } = await import('../app/lib/mcp/server/ingest-validation');
        const target = 'legacy-existing.md', source = '# Actual old legacy writer\n', key = crypto.randomUUID();
        const authority = await createDirectMcpIngestAuthority({ token, tool: 'create_knowledge_source', workspaceId });
        process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '0';
        let legacy: DirectMcpFileReceipt;
        try { legacy = await createDirectMcpWorkspaceFile({ ...authority, path: target, idempotencyKey: key,
          fingerprint: directMcpIngestFingerprint(['create_knowledge_source', target, source]), loadContent: async () => {
            const content = encodeDirectMcpTextContent(source); return { content,
              validation: await validateDirectMcpIngestContent({ path: target, content, source: 'generated' }) };
          } }); } finally { process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1'; }
        const before = await fs.readFile(journal(legacy.operation_id));
        assert.deepEqual(await persistAndProjectDirectMcpMarkdownCreate(authInfo(),
          { workspaceId, path: target, idempotencyKey: key, tool: 'create_knowledge_source', content: source }), { kind: 'legacy-original' });
        const retried = await create(target, source, key); assert.equal(retried.status, 'already_created');
        assert.equal(retried.revision_id, legacy.revision_id); assert.deepEqual(await fs.readFile(journal(legacy.operation_id)), before);
        assert.equal(await observe(legacy.operation_id), null); assert.deepEqual(await nativeRows(legacy.operation_id), { receipt: [], birth: [], history: [] });
      });
      await check('pending original rejects changed request then exact source resumes the same Native birth', async () => {
        const key = crypto.randomUUID(), target = 'pending-exact.md', source = '# Pending source\n', op = keyFor(key);
        const actual = await startWorker(target, source, key, 'before_link'); await event(actual, actual.ready); actual.send('go');
        await event(actual, actual.held); const pending = await nativeRows(op); assert.equal(pending.birth.length, 1);
        assert.equal(pending.receipt.length, 1); assert.equal(Number(pending.birth[0].finalized), 0); await noTarget(target);
        actual.send('kill-helper'); failure(await actual.result); await closedWorker(actual);
        const original = await observe(op); assert(original); assert.equal(original.complete, false);
        failure(await call(token, 'create_knowledge_source', args(target, '# Different source\n', key)), 'MCP_INGEST_IDEMPOTENCY_CONFLICT');
        assert.deepEqual(await nativeRows(op), pending); await noTarget(target);
        const sid = `mcp-pending-${crypto.randomUUID()}`;
        await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
          VALUES($1,$2,'reader',$3,$4,$4)`, [sid, crypto.randomBytes(32).toString('hex'), Date.now() + 3600000, Date.now()]);
        const fresh = await fixture.issue({ sid, scope: 'knowledge:read knowledge:write' });
        await admin.query(`UPDATE "session" SET expires_at=1 WHERE id='reader-session'`);
        try {
          const resumed = await create(target, source, key, fresh); assert.equal(resumed.document_id, pending.birth[0].document_id);
          await verify(resumed, source); assert.equal((await nativeRows(op)).receipt[0].request_fingerprint, pending.receipt[0].request_fingerprint);
          const recovered = await observe(op); assert(recovered); assert.deepEqual(recovered.intent, original.intent);
        } finally { await fixture.restoreReaderSession(); await admin.query('DELETE FROM "session" WHERE id=$1', [sid]); }
      });
      await check('present claim with missing intent and invalid generated text never become a new original', async () => {
        const key = crypto.randomUUID(), source = '# Retained original\n', created = await create('corrupt-intent.md', source, key);
        const claim = await observe(created.operation_id); assert(claim); const pointer = object(JSON.parse(await fs.readFile(path.join(dataRoot, 'canvas-markdown-create-births-anchor.json'), 'utf8')));
        const store = pointer.version === 1 ? 'canvas-markdown-create-births' : String(pointer.storeName);
        assert.match(store, /^canvas-markdown-create-births(?:-[a-f0-9]{32})?$/u);
        const intent = path.join(dataRoot, store, claim.id, 'intent.json'), backup = `${intent}.owned-backup`;
        const before = await nativeRows(created.operation_id), bytes = await fs.readFile(intent); await fs.rename(intent, backup);
        try { await assert.rejects(persistAndProjectDirectMcpMarkdownCreate(authInfo(),
          { workspaceId, path: created.path, idempotencyKey: key, tool: 'create_knowledge_source', content: source }));
          assert.deepEqual(await nativeRows(created.operation_id), before); await assert.rejects(fs.lstat(intent), { code: 'ENOENT' });
          assert.deepEqual(await fs.readFile(backup), bytes);
        } finally { await fs.rename(backup, intent); }
        assert.equal((await create(created.path, source, key)).revision_id, created.revision_id);
        for (const [bad, code] of [['---\ntitle: [\n---\nBody\n', 'invalid_frontmatter'], ['NUL\u0000', 'invalid_text'],
          [String.fromCharCode(0xd800), 'invalid_utf8']] as const) {
          const requestKey = crypto.randomUUID(), target = `invalid-${requestKey}.md`, beforeDomain = await fixture.snapshot();
          failure(await call(token, 'create_knowledge_source', args(target, bad, requestKey)), code); await noTarget(target);
          assert.deepEqual(await fixture.snapshot(), beforeDomain); assert.equal(await observe(keyFor(requestKey)), null);
        }
      });
      await check('real public HTTPS import preserves Native source evidence and completed retry skips unusable URL', async () => {
        const targetPath = 'https/original-mcp-readme.md', key = crypto.randomUUID();
        const file = { download_url: sourceUrl, file_id: 'primary-mcp-readme-c518f7a9', file_name: 'README.md', mime_type: 'text/markdown' };
        const importArgs = { workspace_id: workspaceId, path: targetPath, file, idempotency_key: key };
        const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
        assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
        const imported = receipt(await call(token, 'import_knowledge_file', importArgs));
        assert.equal(imported.status, 'created'); assert.equal(imported.operation_id, keyFor(key));
        assert.equal(imported.path, targetPath); assert.equal(imported.workspace_id, workspaceId);
        assert(imported.document_id && imported.lineage_id); assert.equal(imported.mime_type, 'text/markdown');
        const rows = await nativeRows(imported.operation_id); assert.equal(rows.receipt.length, 1); assert.equal(rows.birth.length, 1);
        const r = rows.receipt[0], b = rows.birth[0], privateResult = object(r.private_result), target = object(privateResult.target);
        // Source evidence describes independently downloaded bytes. Receipt,
        // projection and history separately describe the actual serialized file.
        assert.equal(r.actor_user_id, 'reader'); assert.equal(r.actor_session_id, 'reader-session');
        assert.equal(r.request_id, `mcp-create:${imported.operation_id}`);
        assert.equal(privateResult.sourceHash, sourceHash); assert.equal(Number(privateResult.sourceBytes), originalBytes.length);
        assert.equal(target.documentId, imported.document_id); assert.equal(target.lineageId, imported.lineage_id);
        assert.equal(b.document_id, imported.document_id); assert.equal(Number(b.lifecycle_generation), 1);
        assert.equal(Number(b.finalized), 1); assert.equal(b.revision_id, imported.revision_id); assert.equal(b.serialized_hash, imported.sha256);
        const serializedBytes = await fs.readFile(path.join(workspaceRoot, targetPath));
        assert.equal(sha(serializedBytes), imported.sha256); assert.equal(serializedBytes.length, imported.size);
        // Complete-file import promises byte preservation, including its profile.
        assert.deepEqual(serializedBytes, originalBytes);
        const revision = (await admin.query('SELECT *,xmin::text AS original_xmin FROM file_revisions WHERE id=$1 AND workspace_id=$2',
          [imported.revision_id, workspaceId])).rows[0];
        assert(revision); assert.equal(revision.created_by_user_id, 'reader'); assert.equal(revision.created_by_actor_type, 'agent');
        assert.equal(revision.source_session_id, 'reader-session'); assert.equal(revision.lineage_id, imported.lineage_id);
        assert.equal(revision.content_hash, imported.sha256); assert.equal(Number(revision.size_bytes), imported.size);
        assert.equal(rows.history.length, 1); const history = rows.history[0];
        assert.equal(history.source, 'external_import'); assert.equal(history.revision_id, imported.revision_id);
        assert.equal(history.lineage_id, imported.lineage_id); assert.equal(history.content_sha256, sha(serializedBytes));
        assert.equal(Number(history.raw_size_bytes), serializedBytes.length);
        const claim = await observe(imported.operation_id); assert(claim); assert.equal(claim.complete, true);
        assert.equal(claim.id, b.claim_id); assert.equal(claim.fingerprint, b.claim_fingerprint);
        assert.equal(claim.revisionId, imported.revision_id); assert.equal(claim.serializedHash, imported.sha256);
        const provenance = object(claim.intent.source), origin = object(claim.intent.origin);
        assert.equal(provenance.kind, 'direct-mcp-markdown-v1'); assert.equal(provenance.tool, 'import_knowledge_file');
        assert.equal(provenance.clientId, clientId); assert.equal(provenance.actorUserId, 'reader');
        assert.equal(provenance.actorSessionId, 'reader-session'); assert.equal(origin.sessionId, 'reader-session');
        assert.equal(origin.clientId, clientId); assert.equal(provenance.fileId, file.file_id);
        assert.equal(provenance.declaredMimeType, file.mime_type); assert.equal(provenance.sourceHash, sourceHash);
        assert.equal(provenance.sourceBytes, originalBytes.length); assert.equal(provenance.operationId, imported.operation_id);
        assert.equal(provenance.requestId, r.request_id); assert.equal(typeof provenance.ingestValidationJson, 'string');
        const retainedMetadata = JSON.stringify([claim.intent, privateResult]);
        assert.equal(retainedMetadata.includes(sourceUrl), false); assert.equal(retainedMetadata.includes('download_url'), false);
        await assert.rejects(fs.lstat(journal(imported.operation_id)), { code: 'ENOENT' });
        const first = await readNative(imported); assert(first.fragment.includes('Model Context Protocol'));
        assert.equal(first.currency.source, 'persisted_yjs'); assert.equal(first.currency.observedDurable, true);
        assert.equal(first.document.version, first.currency.observedVersion); assert.equal(first.document.version, first.currency.durableVersion);
        const markdownResult = await call(token, 'read_knowledge_source', { workspace_id: workspaceId, document_id: imported.document_id,
          format: 'markdown', max_bytes: 262144, expected_version: first.document.version });
        assert.notEqual(markdownResult.isError, true);
        const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/server/validators/ajv');
        const { DOCUMENT_READ_PAGE_JSON_SCHEMA_V1 } = await import('../app/lib/documents/read-json-schema');
        const markdownPage = new AjvJsonSchemaValidator().getValidator<DocumentReadPageV1>(DOCUMENT_READ_PAGE_JSON_SCHEMA_V1)(markdownResult.structuredContent);
        assert.equal(markdownPage.valid, true, markdownPage.errorMessage ?? 'The real Markdown export must match its page schema.');
        const markdown = markdownPage.data; assert(markdown); assert.equal(markdown.format, 'markdown');
        assert.deepEqual(markdown.document, first.document); assert.equal(markdown.complete, true); assert.equal(markdown.nextCursor, null);
        assert.equal(markdown.fragment, originalText.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n'));
        const original = { domain: await fixture.snapshot(), rows: await nativeRows(imported.operation_id),
          blobs: (await admin.query(`SELECT b.*,b.xmin::text AS original_xmin FROM file_version_blobs b
            JOIN file_revision_contents c ON c.workspace_id=b.workspace_id AND c.blob_id=b.blob_id
            WHERE c.workspace_id=$1 AND c.revision_id=$2 ORDER BY b.blob_id`, [workspaceId, imported.revision_id])).rows,
          claim: await observe(imported.operation_id), file: await fs.readFile(path.join(workspaceRoot, targetPath)) };
        const unusableUrl = 'https://127.0.0.1:1/expired-reference';
        // The real downloader rejects this address. A completed original must
        // return before entering that path; no fetch/DNS/HTTP result is replaced.
        const retry = receipt(await call(token, 'import_knowledge_file', { ...importArgs, file: { ...file, download_url: unusableUrl } }));
        assert.deepEqual(retry, { ...imported, status: 'already_created' });
        const after = await readNative(retry, first.document.version);
        assert.deepEqual(after.document, first.document); assert.deepEqual(after.currency, first.currency); assert.equal(after.fragment, first.fragment);
        assert.deepEqual({ domain: await fixture.snapshot(), rows: await nativeRows(imported.operation_id),
          blobs: (await admin.query(`SELECT b.*,b.xmin::text AS original_xmin FROM file_version_blobs b
            JOIN file_revision_contents c ON c.workspace_id=b.workspace_id AND c.blob_id=b.blob_id
            WHERE c.workspace_id=$1 AND c.revision_id=$2 ORDER BY b.blob_id`, [workspaceId, imported.revision_id])).rows,
          claim: await observe(imported.operation_id), file: await fs.readFile(path.join(workspaceRoot, targetPath)) }, original);
        assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
        console.log('Native MCP HTTPS source evidence:', JSON.stringify({ fixture: 'official-mcp-readme-c518f7a9',
          sourceSha256: sourceHash, sourceBytes: originalBytes.length, serializedSha256: imported.sha256, serializedBytes: imported.size }));
      });
      await check('pending HTTPS import rejects changed host bytes and renewed SID resumes only the original Native birth', async () => {
        const key = crypto.randomUUID(), targetPath = 'https/pending-original.md', op = keyFor(key);
        const file = { download_url: sourceUrl, file_id: 'pending-host-reference-fixed-id', file_name: 'README.md', mime_type: 'text/markdown' };
        const importArgs = { workspace_id: workspaceId, path: targetPath, file, idempotency_key: key };
        const child = await startWorker(targetPath, { tool: 'import_knowledge_file', file }, key, 'before_link');
        await event(child, child.ready); child.send('go'); await event(child, child.held);
        child.send('kill-helper'); failure(await child.result); await closedWorker(child); await noTarget(targetPath);
        const pending = await nativeRows(op); assert.equal(pending.birth.length, 1); assert.equal(pending.receipt.length, 1);
        assert.equal(Number(pending.birth[0].finalized), 0); assert.equal(pending.history.length, 0);
        const pendingTarget = object(object(pending.receipt[0].private_result).target);
        const original = await observe(op); assert(original); assert.equal(original.complete, false);
        const originalSource = object(original.intent.source), originalOrigin = object(original.intent.origin);
        assert.equal(originalSource.tool, 'import_knowledge_file'); assert.equal(originalSource.clientId, clientId);
        assert.equal(originalSource.fileId, file.file_id); assert.equal(originalSource.declaredMimeType, file.mime_type);
        assert.equal(originalSource.sourceHash, sourceHash); assert.equal(originalSource.sourceBytes, originalBytes.length);
        assert.equal(originalSource.actorUserId, 'reader'); assert.equal(originalSource.actorSessionId, 'reader-session');
        assert.equal(originalOrigin.sessionId, 'reader-session'); assert.equal(originalOrigin.clientId, clientId);
        const beforeRejectedRetry = await fixture.snapshot();
        // Same host file ID and MIME are deliberately retained. Only an actual
        // public HTTPS capability changes, producing independently known bytes.
        failure(await call(token, 'import_knowledge_file', { ...importArgs, file: { ...file, download_url: changedSourceUrl } }),
          'MCP_INGEST_IDEMPOTENCY_CONFLICT');
        assert.deepEqual(await fixture.snapshot(), beforeRejectedRetry); assert.deepEqual(await nativeRows(op), pending);
        assert.deepEqual(await observe(op), original); await noTarget(targetPath);
        await assert.rejects(fs.lstat(journal(op)), { code: 'ENOENT' });
        const sid = `mcp-https-pending-${crypto.randomUUID()}`;
        await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
          VALUES($1,$2,'reader',$3,$4,$4)`, [sid, crypto.randomBytes(32).toString('hex'), Date.now() + 3600000, Date.now()]);
        try {
          const fresh = await fixture.issue({ sid, scope: 'knowledge:read knowledge:write' });
          await admin.query(`UPDATE "session" SET expires_at=1 WHERE id='reader-session'`);
          const resumed = receipt(await call(fresh, 'import_knowledge_file', importArgs));
          assert.equal(resumed.operation_id, op); assert.equal(resumed.document_id, pending.birth[0].document_id);
          assert.equal(resumed.document_id, pendingTarget.documentId); assert.equal(resumed.lineage_id, pendingTarget.lineageId);
          assert.equal(resumed.path, targetPath); assert.equal(resumed.workspace_id, workspaceId);
          const rows = await nativeRows(op); assert.deepEqual(rows.receipt, pending.receipt);
          assert.equal(rows.birth.length, 1); assert.equal(rows.birth[0].claim_id, pending.birth[0].claim_id);
          assert.equal(rows.birth[0].claim_fingerprint, pending.birth[0].claim_fingerprint);
          assert.equal(rows.birth[0].request_fingerprint, pending.birth[0].request_fingerprint);
          assert.equal(Number(rows.birth[0].finalized), 1); assert.equal(rows.birth[0].revision_id, resumed.revision_id);
          assert.equal(rows.birth[0].serialized_hash, resumed.sha256);
          const recovered = await observe(op); assert(recovered); assert.equal(recovered.complete, true);
          assert.deepEqual(recovered.intent, original.intent); assert.equal(recovered.id, original.id);
          assert.equal(recovered.fingerprint, original.fingerprint); assert.equal(recovered.revisionId, resumed.revision_id);
          const serialized = await fs.readFile(path.join(workspaceRoot, targetPath)); assert.deepEqual(serialized, originalBytes);
          assert.equal(sha(serialized), resumed.sha256); assert.equal(serialized.length, resumed.size);
          const revision = (await admin.query('SELECT * FROM file_revisions WHERE workspace_id=$1 AND id=$2',
            [workspaceId, resumed.revision_id])).rows[0];
          assert(revision); assert.equal(revision.created_by_user_id, 'reader'); assert.equal(revision.created_by_actor_type, 'agent');
          assert.equal(revision.source_session_id, 'reader-session'); assert.notEqual(revision.source_session_id, sid);
          assert.equal(revision.lineage_id, resumed.lineage_id); assert.equal(rows.history.length, 1);
          assert.equal(rows.history[0].source, 'external_import'); assert.equal(rows.history[0].revision_id, resumed.revision_id);
          assert.equal(rows.history[0].content_sha256, resumed.sha256); assert.equal(Number(rows.history[0].raw_size_bytes), resumed.size);
          const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/server/validators/ajv');
          const { DOCUMENT_READ_PAGE_JSON_SCHEMA_V1 } = await import('../app/lib/documents/read-json-schema');
          const validatePage = new AjvJsonSchemaValidator().getValidator<DocumentReadPageV1>(DOCUMENT_READ_PAGE_JSON_SCHEMA_V1);
          const nativeResult = await call(fresh, 'read_knowledge_source', { workspace_id: workspaceId,
            document_id: resumed.document_id, format: 'native', max_bytes: 262144 });
          assert.notEqual(nativeResult.isError, true); const nativePage = validatePage(nativeResult.structuredContent);
          assert.equal(nativePage.valid, true, nativePage.errorMessage ?? 'Recovered Native body must match its page schema.');
          const native = nativePage.data; assert(native); assert.equal(native.format, 'native'); assert.equal(native.complete, true);
          assert.equal(native.nextCursor, null); assert.equal(native.document.documentId, pendingTarget.documentId);
          assert.equal(native.document.lineageId, pendingTarget.lineageId); assert.equal(native.document.lifecycleGeneration, 1);
          assert(native.fragment.includes('Model Context Protocol'));
          const markdownResult = await call(fresh, 'read_knowledge_source', { workspace_id: workspaceId,
            document_id: resumed.document_id, format: 'markdown', max_bytes: 262144, expected_version: native.document.version });
          assert.notEqual(markdownResult.isError, true); const markdownPage = validatePage(markdownResult.structuredContent);
          assert.equal(markdownPage.valid, true, markdownPage.errorMessage ?? 'Recovered Markdown body must match its page schema.');
          const markdown = markdownPage.data; assert(markdown); assert.equal(markdown.format, 'markdown');
          assert.equal(markdown.complete, true); assert.equal(markdown.nextCursor, null); assert.deepEqual(markdown.document, native.document);
          assert.equal(markdown.fragment, originalText.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n'));
          console.log('Native MCP pending HTTPS source evidence:', JSON.stringify({ fixture: 'official-mcp-readme-and-license-c518f7a9',
            originalSha256: sourceHash, originalBytes: originalBytes.length, changedSha256: changedHash, changedBytes: changedBytes.length }));
        } finally { await fixture.restoreReaderSession(); await admin.query('DELETE FROM "session" WHERE id=$1', [sid]); }
      });
      await check('test-owned adversarial both-original records require recovery while legacy-only mismatch stays conflict', async () => {
        // This installs deliberate test-owned corruption in the real V1 record
        // format, not a claim that normal writers can create both originals.
        const pin = async (filePath: string) => {
          const info = await fs.lstat(filePath); assert(info.isFile() && !info.isSymbolicLink());
          assert.equal(info.uid, process.getuid?.()); assert.equal(info.nlink, 1);
          return { dev: String(info.dev), ino: String(info.ino), uid: info.uid, mode: info.mode, size: info.size };
        };
        const addPrepared = async (operationId: string, fingerprint: string, contentHash: string) => {
          const recordPath = journal(operationId), directory = path.dirname(recordPath);
          await fs.mkdir(directory, { recursive: true, mode: 0o700 });
          assert.equal(await fs.realpath(directory), path.join(await fs.realpath(dataRoot), 'system', 'mcp-file-ingest'));
          const bytes = Buffer.from(JSON.stringify({ version: 1, fingerprint, sha256: contentHash, phase: 'prepared' }));
          const handle = await fs.open(recordPath, 'wx', 0o600);
          try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
          const identity = await pin(recordPath); assert.equal(identity.mode & 0o777, 0o600);
          return { recordPath, bytes, identity };
        };
        const assertRecord = async (record: Awaited<ReturnType<typeof addPrepared>>) => {
          assert.deepEqual(await pin(record.recordPath), record.identity);
          assert.deepEqual(await fs.readFile(record.recordPath), record.bytes);
        };
        const classification = (result: ObjectValue, expected: string) => {
          const detail = object(result.structuredContent), actual = detail.code;
          const code = typeof actual === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(actual) ? actual : 'UNCLASSIFIED';
          console.log('Native MCP original classification evidence:', { currentCase, code, expected });
          failure(result, expected);
        };
        const legacyKey = crypto.randomUUID(), legacyPath = 'adversarial-legacy-only.md', legacySource = '# Requested native candidate\n';
        const legacyOp = keyFor(legacyKey), expectedLegacyFingerprint = sha(JSON.stringify(['create_knowledge_source', legacyPath, legacySource]));
        const legacyFingerprint = sha(JSON.stringify(['create_knowledge_source', legacyPath, '# Different legacy original\n']));
        assert.notEqual(legacyFingerprint, expectedLegacyFingerprint);
        const legacy = await addPrepared(legacyOp, legacyFingerprint, sha('Different legacy bytes\n'));
        assert.equal(await observe(legacyOp), null); await noTarget(legacyPath);
        const legacyBefore = { domain: await fixture.snapshot(), rows: await nativeRows(legacyOp) };
        const legacyResult = await call(token, 'create_knowledge_source', args(legacyPath, legacySource, legacyKey));
        assert.deepEqual({ domain: await fixture.snapshot(), rows: await nativeRows(legacyOp) }, legacyBefore);
        assert.equal(await observe(legacyOp), null); await noTarget(legacyPath); await assertRecord(legacy);
        await fs.unlink(legacy.recordPath); classification(legacyResult, 'MCP_INGEST_IDEMPOTENCY_CONFLICT');

        const key = crypto.randomUUID(), targetPath = 'adversarial-both-originals.md', source = '# Actual native original\n';
        const created = await create(targetPath, source, key); await verify(created, source);
        const requestFingerprint = sha(JSON.stringify(['create_knowledge_source', targetPath, source]));
        const differentFingerprint = sha(JSON.stringify(['create_knowledge_source', targetPath, '# Different legacy request\n']));
        assert.notEqual(differentFingerprint, requestFingerprint);
        const nativeOriginal = await observe(created.operation_id); assert(nativeOriginal); assert.equal(nativeOriginal.complete, true);
        assert.equal(object(nativeOriginal.intent.source).ingestRequestFingerprint, requestFingerprint);
        const pointer = object(JSON.parse(await fs.readFile(path.join(dataRoot, 'canvas-markdown-create-births-anchor.json'), 'utf8')));
        const store = pointer.version === 1 ? 'canvas-markdown-create-births' : String(pointer.storeName);
        assert.match(store, /^canvas-markdown-create-births(?:-[a-f0-9]{32})?$/u);
        const intentPath = path.join(dataRoot, store, nativeOriginal.id, 'intent.json');
        const record = await addPrepared(created.operation_id, differentFingerprint, created.sha256);
        const snapshotBoth = async () => ({ domain: await fixture.snapshot(), rows: await nativeRows(created.operation_id),
          claim: await observe(created.operation_id), file: { bytes: await fs.readFile(path.join(workspaceRoot, targetPath)),
            identity: await pin(path.join(workspaceRoot, targetPath)) },
          intent: { bytes: await fs.readFile(intentPath), identity: await pin(intentPath) },
          journal: { bytes: await fs.readFile(record.recordPath), identity: await pin(record.recordPath) } });
        const before = await snapshotBoth();
        const result = await call(token, 'create_knowledge_source', args(targetPath, source, key));
        // Inspect preservation before checking the error class, so an actual
        // RED still proves no adoption/mutation of any captured original.
        assert.deepEqual(await snapshotBoth(), before); await assertRecord(record);
        await fs.unlink(record.recordPath); classification(result, 'MCP_INGEST_RECOVERY_REQUIRED');
      });
    } catch (error) { primary = error; hasPrimary = true; }
    finally {
      const errors: unknown[] = [];
      for (const owner of workers) {
        try { if (!owner.entry.ended || !ownedGroupEmpty(owner.entry)) await signalOwnChild(owner.entry, 'SIGKILL');
          await Promise.allSettled([owner.result]); await closedWorker(owner);
        } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(hasPrimary ? [primary, ...errors] : errors, 'Own Native MCP Create workers did not close cleanly.');
    }
    if (hasPrimary) throw primary;
  });
  assert.equal(passed, 10); completed = true;
  console.log(`Direct MCP Native Markdown Create PostgreSQL: ${passed}/10 genuine registered/SQL/FD/process/HTTPS families; OAuth issuance, compiled HTTP and host/browser acceptance remain separate.`);
}

const descriptor = process.env.CANVAS_NATIVE_MCP_CREATE_CHILD;
void (descriptor ? worker(descriptor) : directMcpNativeMarkdownCreatePostgresTest()).catch(error => {
  console.error('Native MCP Create test failed:', { currentCase, passed,
    name: error instanceof Error ? error.name : typeof error,
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined });
  process.exitCode = 1; if (descriptor && process.connected) { assert(process.disconnect); process.disconnect(); }
});
