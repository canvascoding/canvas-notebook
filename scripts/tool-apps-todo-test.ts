import assert from 'node:assert/strict';
import Module from 'node:module';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { TodoWithRelations } from '../app/lib/todos/store';
import { todoToolApp, readBuiltinToolAppMessage, readToolAppInvocation, readBuiltinToolAppDescriptor } from '../app/lib/tool-apps/types';
import { presentTodoAppData, readTodoAppData } from '../app/lib/tool-apps/todo-data';
import { projectAgentMessageForLoadedContext } from '../app/lib/pi/message-projection';
import { projectAgentMessageForPersistence } from '../app/lib/pi/visual-data-projection';

const chat = { userId: 'user-1', sessionId: 'chat-1', agentId: 'agent-1' };
const app = todoToolApp('11111111-1111-4111-8111-111111111111', 'todo-call', 'create_human_todo');
const message = { role: 'toolResult', toolName: app.operation, toolCallId: app.toolCallId,
  content: [{ type: 'text', text: 'x'.repeat(250_000) }],
  details: { todo: { id: app.entityId, description: 'x'.repeat(50_000) }, toolApp: app } };
let stored: string | null = JSON.stringify(message);
let allowed = true;
let workspaceType = 'personal';
const todo = { id: app.entityId, title: '<script>not executable</script>', status: 'open', priority: 'high',
  category: { name: 'Review' }, assignee: { name: 'Person', email: 'private@example.test' },
  dueAt: new Date('2026-10-01T12:00:00Z'), updatedAt: new Date('2026-09-10T12:00:00Z'),
  workspaceId: 'workspace-1', workspaceType: 'personal', organizationId: null, scopeKind: 'user', fileLinks: [],
  description: 'never-forward', completionComment: 'never-forward', sourceSessionId: 'never-forward',
} as unknown as TodoWithRelations;
const params: unknown[][] = [];
const dialect = new PgDialect();
const db = { query: { piSessions: { findFirst: async ({ where }: { where: Parameters<typeof dialect.sqlToQuery>[0] }) => {
  params.push(dialect.sqlToQuery(where).params); return { id: 12, workspaceId: 'workspace-1' };
} } }, select: () => ({ from: () => ({ where: (where: Parameters<typeof dialect.sqlToQuery>[0]) => {
  params.push(dialect.sqlToQuery(where).params);
  return { orderBy: () => ({ limit: async () => stored ? [{ content: stored }] : [] }) };
} }) }) };
class AccessError extends Error { constructor(message: string, readonly status = 403) { super(message); } }
const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/db') return { db };
  if (request.includes('license/seat-limit')) return { assertUserSeatAccess: async () => undefined };
  if (request.includes('automations/store') || request.includes('automations/policy')) return {};
  if (request.includes('todos/store')) return {
    getTodo: async (userId: string, id: string) => { assert.equal(userId, chat.userId); assert.equal(id, todo.id); if (!allowed) throw new Error('forbidden'); return todo; },
    createTodo: async () => todo,
    updateTodo: async (_user: string, id: string, input: { expectedUpdatedAt: Date }) => { assert.equal(id, todo.id); assert.equal(input.expectedUpdatedAt.toISOString(), todo.updatedAt.toISOString()); return todo; },
  };
  if (request.includes('agents/registry')) return { normalizeManagedAgentId: (id: string) => id };
  if (request.includes('agent-execution-context')) return { getAgentExecutionContext: () => null };
  if (request.includes('session-workspace-context')) return { resolveAgentSessionWorkspaceForUser: async () => ({ workspaceId: 'workspace-1', workspaceType, organizationId: null }) };
  if (request.includes('mcp/access')) return { McpAccessError: AccessError, mcpErrorStatus: (e: AccessError) => e.status || 500 };
  if (request.includes('mcp/apps-config')) return { isMcpAppsEnabled: () => true, mcpAppOrigins: () => ({ appOrigin: 'http://localhost:3000' }) };
  if (request.includes('mcp/apps-host')) return { issueBuiltinToolAppTicket: async () => { throw new Error('not a render test'); } };
  if (request.includes('utils/rate-limit')) return { rateLimit: () => ({ ok: true }) };
  if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => ({ user: { id: chat.userId }, session: {} }) } } };
  return originalLoad(request, parent, isMain);
};

async function main() {
  try {
    const { requireBuiltinToolAppAccess } = await import('../app/lib/tool-apps/builtin-access');
    const data = presentTodoAppData(todo);
    assert.deepEqual(readTodoAppData(data), data);
    assert.ok(!JSON.stringify(data).includes('never-forward'));
    assert.ok(!JSON.stringify(data).includes('private@example'));
    assert.equal(readTodoAppData({ ...data, dueAt: 'invalid' }), null);
    assert.equal(readTodoAppData({ ...data, status: 'active' }), null);
    assert.equal(readBuiltinToolAppDescriptor({ ...app, operation: 'create_automation_job' }), null);
    assert.deepEqual(readBuiltinToolAppMessage(message), app);
    assert.equal(readBuiltinToolAppMessage({ ...message, toolName: 'automation_manage', details: { ...message.details, action: 'call', operation: app.operation } }), null);
    assert.equal(readBuiltinToolAppMessage({ ...message, details: { ...message.details, todo: { id: 'foreign' } } }), null);
    const persisted = projectAgentMessageForPersistence(message as unknown as AgentMessage);
    const display = projectAgentMessageForLoadedContext(persisted, 'display');
    assert.deepEqual(readToolAppInvocation(display), { kind: 'builtin', descriptor: app });
    assert.ok(JSON.stringify(display).length < 30_000);
    assert.ok(!JSON.stringify(projectAgentMessageForLoadedContext(persisted, 'context')).includes('toolApp'));
    assert.deepEqual(await requireBuiltinToolAppAccess(chat, app), data);
    assert.ok(params.some(p => p.includes(chat.userId) && p.includes(chat.agentId) && p.includes(chat.sessionId)));
    assert.ok(params.some(p => p.includes(12) && p.includes(app.toolCallId)));
    todo.status = 'done'; assert.equal((await requireBuiltinToolAppAccess(chat, app)).status, 'done');
    allowed = false; await assert.rejects(requireBuiltinToolAppAccess(chat, app), { status: 404 }); allowed = true;
    workspaceType = 'team'; await assert.rejects(requireBuiltinToolAppAccess(chat, app), { status: 404 }); workspaceType = 'personal';
    todo.scopeKind = 'workspace'; todo.workspaceId = 'another-workspace';
    await assert.rejects(requireBuiltinToolAppAccess(chat, app), { status: 404 }); todo.workspaceId = 'workspace-1';
    await requireBuiltinToolAppAccess(chat, app);
    stored = null; await assert.rejects(requireBuiltinToolAppAccess(chat, app), { status: 425 });
    stored = JSON.stringify({ ...message, isError: true }); await assert.rejects(requireBuiltinToolAppAccess(chat, app), { status: 403 });
    const { createHumanTodoTool, createInspectHumanTodoTool, createUpdateHumanTodoTool } = await import('../app/lib/pi/human-todo-tool');
    for (const [tool, input] of [
      [createHumanTodoTool(chat), { title: 'Review', assigneeUserId: 'me' }],
      [createInspectHumanTodoTool(chat), { todoId: todo.id }],
      [createUpdateHumanTodoTool(chat), { todoId: todo.id, expectedUpdatedAt: todo.updatedAt.toISOString(), title: 'Updated' }],
    ] as const) {
      const result = await tool.execute('actual-call', input);
      assert.equal(readBuiltinToolAppMessage({ ...result, role: 'toolResult', toolName: tool.name, toolCallId: 'actual-call' })?.operation, tool.name);
    }
    const { POST } = await import('../app/api/chat/tool-apps/route');
    const request = new Request('http://localhost:3000/api/chat/tool-apps', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'status', app, ...chat, status: 'active', expectedRevision: 1, expectedUpdatedAt: todo.updatedAt.toISOString() }) });
    assert.equal((await POST(request as Parameters<typeof POST>[0])).status, 400, 'Todo cannot invoke automation actions');
    console.log('Todo widget tool wiring, data, history, authorization and action isolation passed');
  } finally { internals._load = originalLoad; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
