import assert from 'node:assert/strict';
import Module from 'node:module';
import { NextRequest, NextResponse } from 'next/server';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main() {
  const workspace: WorkspaceContext = { workspaceId: 'workspace-a', workspaceType: 'personal',
    displayName: 'A', rootPath: '/private/a', legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
      canManageWorkspace: true, canRunAgent: true } };
  const problemId = 'a'.repeat(64);
  const batchId = 'batch-abcdefghijklmnop';
  const calls: Array<{ lane: string; itemId?: string; workspaceId: string }> = [];
  let authenticated = true;
  let legacyAvailable = false;
  let directAvailable = true;
  let updateFound = true;
  const directItems = [{ id: `file-path-problem:${problemId}`, type: 'file.operation_attention',
    title: 'File action needs attention', detail: 'EACCES', previewUrl: null,
    deepLink: `/notebook?workspaceId=workspace-a&workspacePathProblem=${problemId}`, occurredAt: new Date(100).toISOString(),
    unread: true, priority: 'high', workspaceId: workspace.workspaceId, workspaceName: workspace.displayName,
    target: { kind: 'file_path_operation', workspaceId: workspace.workspaceId, operationKind: 'delete', status: 'failed', problemId } }];
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  internals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => authenticated ? { user: { id: 'owner' } } : null } } };
    if (request === '@/app/lib/api/route-helpers') return {
      jsonServerError: (_label: unknown, _error: unknown, message: string) => NextResponse.json({ success: false, error: message }, { status: 500 }),
    };
    if (request === '@/app/lib/utils/rate-limit') return { rateLimit: () => ({ ok: true }) };
    if (request === '@/app/lib/mobile/inbox-scope') return { loadMobileInboxScope: async () => ({ includedWorkspaces: [workspace] }) };
    if (request === '@/app/lib/todos/api-mode') return { requestedTodoApiMode: () => 'lifecycle' };
    if (request === '@/app/lib/mobile/inbox') return {
      MobileInboxError: class extends Error {}, markMobileAggregateInboxRead: async () => ({ updated: 0 }),
      markMobileInboxRead: async () => { throw new Error('File path action fell through to legacy inbox.'); },
      countMobileUnreadNotifications: async () => 0,
      listMobileAggregateInbox: async () => ({ items: [], counts: { chat: 0, studio: 0, automation: 0 } }),
    };
    if (request === '@/app/lib/email/inbox-attention') return { listEmailAttention: async () => [] };
    if (request === '@/app/lib/todos/store') return { listTodos: async () => [], listLifecycleTodoAttention: async () => ({ todos: [], total: 0 }) };
    if (request === '@/app/lib/memory/approval-attention') return {
      listMemoryApprovalAttention: async () => [], markAllMemoryApprovalAttentionRead: async () => ({ updated: 0 }),
      markMemoryApprovalAttentionRead: async () => ({ updated: 0 }),
    };
    if (request === '@/app/lib/mcp/connection-attention') return {
      listMcpConnectionAttention: async () => [], markMcpConnectionAttentionRead: async () => ({ updated: 0 }),
    };
    if (request === '@/app/lib/license/team-license-attention') return {
      listTeamLicenseAttention: async () => [], markTeamLicenseAttentionRead: async () => ({ updated: 0 }),
    };
    if (request === '@/app/lib/files/workspace-operation-notification-source') return {
      workspaceOperationNotificationSource: {
        list: async () => { if (!legacyAvailable) throw new Error('/private/legacy-review-failure'); return { items: [], unreadCount: 0 }; },
        markRead: async ({ workspace: selected, itemId }: { workspace: WorkspaceContext; itemId?: string }) => {
          calls.push({ lane: 'review', itemId, workspaceId: selected.workspaceId }); return { updated: 1 };
        },
      },
      workspacePathOperationNotificationSource: {
        list: async () => { if (!directAvailable) throw new Error('/private/direct-source-failure'); return { items: directItems, unreadCount: 3 }; },
        markRead: async ({ workspace: selected, itemId }: { workspace: WorkspaceContext; itemId?: string }) => {
          calls.push({ lane: 'path', itemId, workspaceId: selected.workspaceId }); return { updated: updateFound ? 1 : 0 };
        },
      },
    };
    return originalLoad(request, parent, isMain);
  };
  try {
    const route = await import('../app/api/notifications/summary/route');
    const get = () => route.GET(new NextRequest('https://canvas.test/api/notifications/summary'));
    const patch = (payload: unknown) => route.PATCH(new NextRequest('https://canvas.test/api/notifications/summary', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }));
    let response = await get();
    assert.equal(response.status, 200);
    let payload = await response.json();
    assert.equal(payload.data.sources.fileOperations.available, false);
    assert.equal(payload.data.sources.filePathOperations.available, true);
    assert.equal(payload.data.unreadCount, 3, 'legacy review source failure cannot suppress direct failure counts');
    assert.equal(payload.data.sections.notifications[0].target.problemId, problemId);
    assert.equal(JSON.stringify(payload).includes('/private/'), false);
    assert.equal(JSON.stringify(warnings).includes('/private/'), false);
    legacyAvailable = true;
    directAvailable = false;
    response = await get();
    payload = await response.json();
    assert.equal(payload.data.sources.fileOperations.available, true);
    assert.equal(payload.data.sources.filePathOperations.available, false);
    assert.equal(payload.data.unreadCount, 0, 'failed direct source is explicitly unavailable');
    directAvailable = true;
    for (const itemId of [`file-path-problem:${problemId}`, `file-path-operation:${batchId}`]) {
      response = await patch({ action: 'mark_item_read', itemId, workspaceId: workspace.workspaceId });
      assert.equal(response.status, 200);
      assert.deepEqual(calls.at(-1), { lane: 'path', itemId, workspaceId: workspace.workspaceId });
      const count = calls.length;
      for (const action of ['dismiss_item', 'set_item_read_state']) {
        response = await patch({ action, itemId, workspaceId: workspace.workspaceId, read: true });
        assert.equal(response.status, 400, 'reading cannot dismiss or resolve a durable operation problem');
      }
      assert.equal(calls.length, count);
      response = await patch({ action: 'mark_item_read', itemId, workspaceId: 'foreign-workspace' });
      assert.equal(response.status, 404);
      assert.equal(calls.length, count, 'foreign workspace requests never reach storage');
      updateFound = false;
      response = await patch({ action: 'mark_item_read', itemId, workspaceId: workspace.workspaceId });
      assert.equal(response.status, 404);
      updateFound = true;
    }
    calls.length = 0;
    response = await patch({ action: 'mark_all_read' });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ lane: 'review', itemId: undefined, workspaceId: workspace.workspaceId },
      { lane: 'path', itemId: undefined, workspaceId: workspace.workspaceId }]);
    response = await patch({ action: 'mark_item_read', itemId: 'file-operation:old-review', workspaceId: workspace.workspaceId });
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1)?.lane, 'review', 'existing real review notifications keep their route');
    authenticated = false;
    const count = calls.length;
    assert.equal((await get()).status, 401);
    assert.equal((await patch({ action: 'mark_all_read' })).status, 401);
    assert.equal(calls.length, count);
    console.log('workspace-path-operation-notification-summary-test: ok');
  } finally {
    internals._load = originalLoad;
    console.warn = originalWarn;
  }
}

void main();
