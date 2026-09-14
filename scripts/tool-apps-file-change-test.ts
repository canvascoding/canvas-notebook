import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Module from 'node:module';
import { parse } from 'parse5';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type { FileChangeGroupV1 } from '../app/lib/file-version-center/contracts/v1';
import { projectAgentMessageForLoadedContext } from '../app/lib/pi/message-projection';
import { projectAgentMessageForPersistence } from '../app/lib/pi/visual-data-projection';
import {
  FILE_CHANGE_APP_URI,
  fileChangeToolApp,
  readBuiltinToolAppDescriptor,
  readBuiltinToolAppMessage,
  readToolAppInvocation,
} from '../app/lib/tool-apps/types';
import { FILE_CHANGE_APP_DATA_MAX_BYTES, readFileChangeAppData } from '../app/lib/tool-apps/file-change-data';

const group: FileChangeGroupV1 = {
  contractVersion: 1,
  id: `fvcg-${'a'.repeat(64)}`,
  workspaceId: 'workspace-1',
  sourceSessionId: 'chat-1',
  toolCallId: 'call-1',
  operation: 'edit_file',
  status: 'review_required',
  createdAt: '2026-09-14T10:00:00.000Z',
  entries: [{
    id: 'entry-1', ordinal: 0, lineageId: 'lineage-1', documentId: 'document-1',
    operationId: 'operation-1', pathHint: 'docs/plan.md', outcome: 'review_required',
    additions: 3, deletions: 1,
  }],
};
const app = fileChangeToolApp(group);
const message = {
  role: 'toolResult', toolName: 'edit_file', toolCallId: group.toolCallId,
  content: [{ type: 'text', text: `Edited. ${'x'.repeat(250_000)}` }],
  details: { changeGroup: group, toolApp: app },
};
const chat = { userId: 'user-1', sessionId: group.sourceSessionId, agentId: 'agent-1' };
const dialect = new PgDialect();
const queryParams: unknown[][] = [];
let stored: string | null = JSON.stringify(message);
let accessibleGroup = group;
let currentState: 'review_required' | 'rejected' = 'review_required';

const data = () => ({
  contractVersion: 1 as const,
  id: group.id,
  workspaceId: group.workspaceId,
  operation: group.operation,
  status: currentState,
  createdAt: group.createdAt,
  entries: group.entries.map((entry) => ({
    id: entry.id, ordinal: entry.ordinal, pathHint: entry.pathHint, state: currentState,
    operationId: entry.operationId ?? null, revisionId: entry.revisionId ?? null,
    additions: entry.additions ?? null, deletions: entry.deletions ?? null,
  })),
});

const db = {
  query: { piSessions: { findFirst: async ({ where }: { where: Parameters<typeof dialect.sqlToQuery>[0] }) => {
    queryParams.push(dialect.sqlToQuery(where).params);
    return { id: 12, workspaceId: group.workspaceId };
  } } },
  select: () => ({ from: () => ({ where: (where: Parameters<typeof dialect.sqlToQuery>[0]) => {
    queryParams.push(dialect.sqlToQuery(where).params);
    return { orderBy: () => ({ limit: async () => stored ? [{ content: stored }] : [] }) };
  } }) }),
};

class AccessError extends Error {
  constructor(message: string, readonly status = 403) { super(message); }
}

const internals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => {
  if (request === '@/app/lib/db') return { db };
  if (request.includes('license/seat-limit')) return { assertUserSeatAccess: async () => undefined };
  if (request.includes('file-version-center/change-group-service')) return { fileChangeGroupService: {
    readAuthorized: async ({ access, groupId }: { access: { userId: string; requestedWorkspaceId: string }; groupId: string }) => {
      if (access.userId !== chat.userId || access.requestedWorkspaceId !== group.workspaceId || groupId !== group.id) throw new Error('denied');
      return accessibleGroup;
    },
  } };
  if (request.endsWith('/tool-apps/file-change-service') || (request === './file-change-service' && parent?.filename.endsWith('builtin-access.ts'))) {
    return { presentFileChangeAppData: async () => data() };
  }
  if (request.includes('session-workspace-context')) return { resolveAgentSessionWorkspaceForUser: async () => ({
    workspaceId: group.workspaceId, workspaceType: 'personal', organizationId: null,
    permissions: { canRead: true, canWrite: true, canRunAgent: true },
  }) };
  if (request.includes('mcp/access')) return { McpAccessError: AccessError, mcpErrorStatus: (error: unknown) => (error as AccessError).status || 500 };
  if (request.includes('automations/store') || request.includes('automations/policy')
    || request.includes('todos/store') || request.includes('public-sharing/public-file-shares')) return {};
  if (request.includes('mcp/apps-config')) return { mcpAppOrigins: () => ({ appOrigin: 'http://localhost:3000' }) };
  return originalLoad(request, parent, isMain);
};

async function main() {
  try {
    assert.equal(app.resourceUri, FILE_CHANGE_APP_URI);
    assert.deepEqual(readBuiltinToolAppDescriptor(app), app);
    assert.equal(readBuiltinToolAppDescriptor({ ...app, entityId: 'fvcg-forged' }), null);
    assert.equal(readBuiltinToolAppDescriptor({ ...app, operation: 'delete' }), null);
    assert.equal(readBuiltinToolAppDescriptor({ ...app, hidden: 'x' }), null, 'File-change descriptors reject extra fields');
    assert.deepEqual(readBuiltinToolAppMessage(message), app);
    assert.equal(readBuiltinToolAppMessage({ ...message, isError: true }), null);
    assert.equal(readBuiltinToolAppMessage({ ...message, toolCallId: 'foreign-call' }), null);
    assert.equal(readBuiltinToolAppMessage({ ...message, toolName: 'write' }), null);
    assert.equal(readBuiltinToolAppMessage({ ...message, details: { ...message.details, changeGroup: { ...group, sourceSessionId: '' } } }), null);
    assert.equal(readBuiltinToolAppMessage({ ...message, details: { ...message.details, changeGroup: { ...group, status: 'failed', entries: [{ ...group.entries[0], outcome: 'failed' }] } } }), null);
    const oversized = { ...data(), padding: 'x'.repeat(FILE_CHANGE_APP_DATA_MAX_BYTES) };
    assert.equal(readFileChangeAppData(oversized), null);
    assert.deepEqual(readFileChangeAppData(data()), data());

    const persisted = projectAgentMessageForPersistence(message as unknown as AgentMessage);
    const display = projectAgentMessageForLoadedContext(persisted, 'display');
    assert.deepEqual(readToolAppInvocation(display), { kind: 'builtin', descriptor: app });
    assert.deepEqual((display as unknown as { details: { changeGroup: unknown } }).details.changeGroup, group);
    assert.ok(JSON.stringify(display).length < 30_000);
    assert.equal(readToolAppInvocation(projectAgentMessageForLoadedContext(persisted, 'context')), null);

    const { requireBuiltinToolAppAccess } = await import('../app/lib/tool-apps/builtin-access');
    assert.deepEqual(await requireBuiltinToolAppAccess(chat, app), data());
    assert.ok(queryParams.some((params) => params.includes(chat.userId) && params.includes(chat.sessionId) && params.includes(chat.agentId)));
    assert.ok(queryParams.some((params) => params.includes(12) && params.includes(app.toolCallId)));
    currentState = 'rejected';
    assert.equal((await requireBuiltinToolAppAccess(chat, app) as ReturnType<typeof data>).status, 'rejected', 'reload resolves current state');
    accessibleGroup = { ...group, sourceSessionId: 'foreign-session' };
    await assert.rejects(requireBuiltinToolAppAccess(chat, app), { status: 404 });
    accessibleGroup = group;
    stored = null;
    await assert.rejects(requireBuiltinToolAppAccess(chat, app), { status: 425 });
    stored = JSON.stringify({ ...message, isError: true });
    await assert.rejects(requireBuiltinToolAppAccess(chat, app), { status: 403 });

    const html = await readFile('public/_canvas-tool-apps/file-change-group-v1.html', 'utf8');
    type Node = { nodeName: string; childNodes?: Node[] };
    const scriptCount = (node: Node): number => Number(node.nodeName === 'script')
      + (node.childNodes || []).reduce((sum, child) => sum + scriptCount(child), 0);
    assert.equal(scriptCount(parse(html)), 1);
    assert.ok(Buffer.byteLength(html) < 2 * 1024 * 1024);
    console.log('File-change widget descriptor, persisted reload, access and security tests passed');
  } finally {
    internals._load = originalLoad;
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
