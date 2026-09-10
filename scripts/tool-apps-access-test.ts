import assert from 'node:assert/strict';
import Module from 'node:module';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  AUTOMATION_APP_URI, readBuiltinToolAppDescriptor, readBuiltinToolAppMessage, readToolAppInvocation, type BuiltinToolAppDescriptor,
} from '../app/lib/tool-apps/types';

const app = { kind: 'builtin' as const, version: 1 as const, resourceUri: AUTOMATION_APP_URI,
  toolCallId: 'call-1', operation: 'create_automation_job' as const, entityId: 'job-11111111-1111-4111-8111-111111111111' } satisfies BuiltinToolAppDescriptor;
const chat = { userId: 'user-1', sessionId: 'chat-1', agentId: 'agent-1' };
const message = { role: 'toolResult', toolName: 'automations', toolCallId: 'call-1',
  details: { action: 'call', operation: app.operation, toolApp: app, job: { id: app.entityId } } };
const originalMessage = JSON.stringify(message);
let stored: string | null = originalMessage;
let chatAllowed = true;
let jobAllowed = true;
let seatAllowed = true;
let activeSession = true;
let workspaceAllowed = true;
const job: { id: string; deletedAt: null | string } = { id: app.entityId, deletedAt: null };
const queryParams: unknown[][] = [];
const dialect = new PgDialect();
const recordQuery = (where: Parameters<typeof dialect.sqlToQuery>[0]) => { queryParams.push(dialect.sqlToQuery(where).params); };
const db = {
  query: {
    piSessions: { findFirst: async ({ where }: { where: Parameters<typeof dialect.sqlToQuery>[0] }) => {
      recordQuery(where); return chatAllowed ? { id: 12, workspaceId: 'workspace-1' } : null;
    } },
    session: { findFirst: async () => activeSession ? {} : null },
  },
  select: () => ({ from: () => ({ where: (where: Parameters<typeof dialect.sqlToQuery>[0]) => {
    recordQuery(where);
    return { orderBy: () => ({ limit: async () => stored === null ? [] : [{ content: stored }] }) };
  } }) }),
};
class AccessError extends Error { constructor(message: string, readonly status = 403) { super(message); } }
const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/db') return { db };
  if (request.includes('license/seat-limit')) return { assertUserSeatAccess: async () => { if (!seatAllowed) throw new AccessError('seat'); } };
  if (request.includes('automations/store')) return { getAutomationJob: async (id: string) => { assert.equal(id, app.entityId); return job; } };
  if (request.includes('automations/policy')) return { assertCanAccessAutomationJob: async () => { if (!jobAllowed) throw new Error('denied'); } };
  if (request.includes('agents/access')) return { requireAgentAccess: async () => undefined };
  if (request.includes('session-workspace-context')) return { resolveAgentSessionWorkspaceForUser: async () => {
    if (!workspaceAllowed) throw new Error('denied'); return { workspaceId: 'workspace-1' };
  } };
  if (request.includes('mcp/access')) return { McpAccessError: AccessError, mcpErrorStatus: (error: unknown) => (error as AccessError).status || 500 };
  if (request.includes('mcp/apps-config')) return { isMcpAppsEnabled: () => true,
    mcpAppOrigins: () => ({ appOrigin: 'http://localhost:3000', frameOrigin: 'http://localhost:3000' }),
    isMcpAppFrameHost: () => true };
  if (request.includes('mcp/manager')) return {};
  if (request.includes('tool-apps/registry')) return { readBuiltinToolAppResource: async () => '<!doctype html><title>Automation</title>' };
  if (request.includes('utils/rate-limit')) return { rateLimit: () => ({ ok: true }) };
  if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => activeSession
    ? { user: { id: chat.userId }, session: { id: 'login-1', expiresAt: new Date(Date.now() + 60_000) } } : null } } };
  return originalLoad(request, parent, isMain);
};

async function main() {
  try {
    const { requireBuiltinToolAppAccess } = await import('../app/lib/tool-apps/builtin-access');
    const { issueBuiltinToolAppTicket, deliverMcpAppTicket } = await import('../app/lib/mcp/apps-host');
    const { POST } = await import('../app/api/chat/tool-apps/route');
    assert.deepEqual(readBuiltinToolAppMessage(message), app);
    assert.deepEqual(readBuiltinToolAppMessage({ ...message, toolName: app.operation }), app);
    assert.equal(readBuiltinToolAppMessage({ ...message, toolName: 'mcp' }), null);
    assert.equal(readBuiltinToolAppMessage({ ...message, isError: true }), null);
    assert.equal(readBuiltinToolAppMessage({ ...message, toolCallId: 'another-call' }), null);
    assert.equal(readBuiltinToolAppDescriptor({ ...app, resourceUri: 'file:///etc/passwd' }), null);
    assert.equal(readBuiltinToolAppDescriptor({ ...app, operation: 'delete_automation_job' }), null);
    assert.equal(readBuiltinToolAppDescriptor({ ...app, version: 2 }), null);
    assert.equal(readToolAppInvocation(message)?.kind, 'builtin');
    assert.equal(readToolAppInvocation({ details: { mcpApp: { version: 1, connectionId: '11111111-1111-4111-8111-111111111111',
      toolName: 'chart', resourceUri: 'ui://chart/v1' }, mcpToolInput: {}, result: { content: [] } } })?.kind, 'mcp');
    assert.equal((await requireBuiltinToolAppAccess(chat, app)).id, app.entityId);
    assert.ok(queryParams.some((params) => params.includes(chat.userId) && params.includes(chat.sessionId) && params.includes(chat.agentId)));
    assert.ok(queryParams.some((params) => params.includes(12) && params.includes(app.toolCallId) && params.includes('toolResult')));
    await assert.rejects(requireBuiltinToolAppAccess(chat, { ...app, entityId: 'job-22222222-2222-4222-8222-222222222222' }), { status: 403 });
    stored = null; await assert.rejects(requireBuiltinToolAppAccess(chat, app), { status: 425 }); stored = originalMessage;
    stored = JSON.stringify({ ...message, isError: true }); await assert.rejects(requireBuiltinToolAppAccess(chat, app), { status: 403 }); stored = originalMessage;
    chatAllowed = false; await assert.rejects(requireBuiltinToolAppAccess(chat, app), { status: 403 }); chatAllowed = true;
    jobAllowed = false; await assert.rejects(requireBuiltinToolAppAccess(chat, app), { status: 404 }); jobAllowed = true;
    seatAllowed = false; await assert.rejects(requireBuiltinToolAppAccess(chat, app), { status: 403 }); seatAllowed = true;
    job!.deletedAt = new Date().toISOString(); await assert.rejects(requireBuiltinToolAppAccess(chat, app), { status: 404 }); job!.deletedAt = null;
    const issued = await issueBuiltinToolAppTicket({ ...chat, app, authSessionId: 'login-1', authSessionExpiresAt: new Date(Date.now() + 60_000) });
    const ticket = issued.frameUrl.split('/')[4];
    const deliver = () => deliverMcpAppTicket(new Request(issued.frameUrl), ticket, 'document');
    assert.equal((await deliver()).status, 200);
    jobAllowed = false; assert.equal((await deliver()).status, 404); jobAllowed = true;
    workspaceAllowed = false; assert.equal((await deliver()).status, 404); workspaceAllowed = true;
    activeSession = false; assert.equal((await deliver()).status, 404); activeSession = true;
    const request = (body: unknown, origin = 'http://localhost:3000') => new Request('http://localhost:3000/api/chat/tool-apps', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) as Parameters<typeof POST>[0];
    const render = { action: 'render', app, sessionId: chat.sessionId, agentId: chat.agentId };
    assert.equal((await POST(request(render))).status, 200);
    assert.equal((await POST(request(render, 'https://foreign.example'))).status, 403);
    assert.equal((await POST(request({ ...render, padding: 'x'.repeat(9000) }))).status, 413);
    assert.equal((await POST(request({ ...render, action: 'call', tool: 'delete_automation_job' }))).status, 400);
    assert.equal((await POST(request([]))).status, 400);
    console.log('tool-apps-access-test: ok');
  } finally { internals._load = originalLoad; }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
