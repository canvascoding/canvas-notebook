import assert from 'node:assert/strict';
import Module from 'node:module';
import type { FileChangeAppData } from '../app/lib/tool-apps/file-change-data';
import { FILE_CHANGE_APP_URI, TODO_APP_URI, type BuiltinToolAppDescriptor } from '../app/lib/tool-apps/types';

const chat = { userId: 'user-1', sessionId: 'chat-1', agentId: 'agent-1' };
class McpAccessError extends Error {
  constructor(message: string, readonly status = 403) { super(message); }
}
const app = (index: number): BuiltinToolAppDescriptor => ({
  kind: 'builtin', version: 1, resourceUri: FILE_CHANGE_APP_URI,
  entityId: `fvcg-${index.toString(16).padStart(64, '0')}`,
  toolCallId: `call-${index}`, operation: 'write',
});
const failures = new Map<string, number>();
const accessCalls: BuiltinToolAppDescriptor[] = [];
let state: 'applied' | 'rejected' = 'applied';
let signedIn = true;
let chatAllowed = true;
let limited = false;
let large = false;
let chatChecks = 0;
const rateLimits: Array<Record<string, unknown>> = [];
const group = (descriptor: BuiltinToolAppDescriptor): FileChangeAppData => ({
  contractVersion: 1, id: descriptor.entityId, workspaceId: 'workspace-1',
  operation: 'write', status: state, createdAt: '2026-09-30T10:00:00.000Z',
  entries: Array.from({ length: large ? 100 : 1 }, (_, index) => ({
    id: `entry-${index}`, ordinal: index, pathHint: large ? `docs/${'x'.repeat(1000)}-${index}.md` : 'docs/plan.md',
    state, operationId: null, revisionId: 'revision-1', additions: 3, deletions: 1,
  })),
});

const internals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => {
  if (request.endsWith('mcp/access')) return { McpAccessError, mcpErrorStatus: (error: unknown) => (error as McpAccessError).status || 500 };
  if (request.endsWith('/tool-apps/builtin-access') || request === './builtin-access') return {
    requireBuiltinToolAppAccess: async (input: typeof chat, descriptor: BuiltinToolAppDescriptor) => {
      assert.deepEqual(input, chat);
      accessCalls.push(descriptor);
      const status = failures.get(descriptor.entityId);
      if (status) throw new McpAccessError('Unavailable', status);
      return group(descriptor);
    },
  };
  if (request.includes('mcp/apps-config')) return { mcpAppOrigins: () => ({ appOrigin: 'http://localhost:3000' }) };
  if (request.includes('mcp/apps-host')) return {
    requireMcpAppChatAccess: async (input: typeof chat) => {
      assert.deepEqual(input, chat);
      chatChecks++;
      if (!chatAllowed) throw new McpAccessError('Denied', 403);
      return 'workspace-1';
    },
  };
  if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => signedIn ? { user: { id: chat.userId } } : null } } };
  if (request.includes('utils/rate-limit')) return {
    dualRateLimit: (_request: Request, input: Record<string, unknown>) => {
      rateLimits.push(input);
      return limited ? { ok: false, response: new Response(null, { status: 429, headers: { 'Retry-After': '7' } }) } : { ok: true };
    },
  };
  return originalLoad(request, parent, isMain);
};

async function main() {
  try {
    const { readAuthorizedFileChangeSummary, readFileChangeSummaryApps, MAX_FILE_CHANGE_SUMMARY_GROUP_BYTES } = await import('../app/lib/tool-apps/file-change-summary-service');
    const { POST } = await import('../app/api/chat/file-changes/route');
    const request = (body: unknown, origin = 'http://localhost:3000', contentType = 'application/json') => new Request('http://localhost:3000/api/chat/file-changes', {
      method: 'POST', headers: { origin, 'content-type': contentType }, body: JSON.stringify(body),
    }) as Parameters<typeof POST>[0];
    const body = { sessionId: chat.sessionId, agentId: chat.agentId, apps: [app(1), app(2)] };

    assert.deepEqual(readFileChangeSummaryApps([app(1), app(1)]), [app(1)]);
    for (const invalid of [[], Array.from({ length: 101 }, (_, i) => app(i)), [null],
      [{ ...app(1), resourceUri: TODO_APP_URI }], [{ ...app(1), snapshot: group(app(1)) }]]) {
      assert.throws(() => readFileChangeSummaryApps(invalid), { status: 400 });
    }
    assert.equal(accessCalls.length, 0, 'Invalid references never invoke access/data reads');
    let response = await POST(request(body));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual((await response.json()).data.groups, [group(app(1)), group(app(2))]);
    assert.equal(chatChecks, 1);
    assert.equal(rateLimits[0].verifiedUserId, chat.userId);
    assert.equal(rateLimits[0].keyPrefix, 'file-version-center:chat-summary');
    const before = accessCalls.length;
    assert.equal((await readAuthorizedFileChangeSummary(chat, [app(1), app(1)])).groups.length, 1);
    assert.equal(accessCalls.length - before, 1, 'Duplicate references are authorized/read once');
    state = 'rejected';
    assert.equal((await readAuthorizedFileChangeSummary(chat, [app(1)])).groups[0].status, 'rejected', 'Reload presents current server state');
    state = 'applied';

    failures.set(app(2).entityId, 425);
    failures.set(app(3).entityId, 403);
    failures.set(app(4).entityId, 404);
    response = await POST(request({ ...body, apps: [app(1), app(2), app(3), app(4)] }));
    const partial = (await response.json()).data;
    assert.equal(response.status, 200);
    assert.equal(partial.groups.length, 1);
    assert.deepEqual(partial.unavailable.map((item: { status: number; retryable: boolean }) => [item.status, item.retryable]), [[425, true], [403, false], [404, false]]);
    failures.clear();
    failures.set(app(1).entityId, 500);
    assert.equal((await POST(request(body))).status, 500, 'Unexpected backend failures are not permanent per-item unavailability');
    failures.clear();

    assert.equal((await POST(request(body, 'https://foreign.example'))).status, 403);
    signedIn = false;
    assert.equal((await POST(request(body))).status, 401);
    signedIn = true;
    chatAllowed = false;
    const deniedCalls = accessCalls.length;
    assert.equal((await POST(request(body))).status, 403);
    assert.equal(accessCalls.length, deniedCalls, 'Denied chats reveal no group data');
    chatAllowed = true;
    for (const invalid of [{ ...body, apps: [] }, { ...body, apps: [{ ...app(1), snapshot: group(app(1)) }] },
      { ...body, sessionId: '' }, { ...body, agentId: 'a'.repeat(201) }, { ...body, userId: 'other-user' }]) {
      assert.equal((await POST(request(invalid))).status, 400);
    }
    assert.equal((await POST(request(body, 'http://localhost:3000', 'text/plain'))).status, 415);
    assert.equal((await POST(request({ ...body, padding: 'x'.repeat(65536) }))).status, 413);
    limited = true;
    response = await POST(request(body));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('retry-after'), '7');
    limited = false;

    large = true;
    const bounded = await readAuthorizedFileChangeSummary(chat, Array.from({ length: 20 }, (_, index) => app(index)));
    assert.ok(Buffer.byteLength(JSON.stringify(bounded.groups)) <= MAX_FILE_CHANGE_SUMMARY_GROUP_BYTES);
    assert.ok(bounded.groups.length > 0 && bounded.groups.length < 20);
    assert.ok(bounded.unavailable.every((item) => item.status === 413 && !item.retryable));
    console.log('File-change summary API authorization, partial results and payload bounds passed');
  } finally { internals._load = originalLoad; }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
