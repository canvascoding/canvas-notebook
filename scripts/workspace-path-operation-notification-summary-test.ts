import assert from 'node:assert/strict';
import Module from 'node:module';
import { NextRequest, NextResponse } from 'next/server';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { NotificationItem } from '../app/components/notifications/notification-summary';

async function main() {
  const workspace: WorkspaceContext = { workspaceId: 'workspace-a', workspaceType: 'personal',
    displayName: 'A', rootPath: '/private/a', legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
      canManageWorkspace: true, canRunAgent: true } };
  const problemId = 'a'.repeat(64);
  const batchId = 'batch-abcdefghijklmnop';
  const calls: Array<{ lane: string; itemId?: string; workspaceId: string; expectedRevision?: string }> = [];
  let authenticated = true;
  let legacyAvailable = false;
  let directAvailable = true;
  let updateFound = true;
  let dismissFailed = false;
  const directItems: NotificationItem[] = [{ id: `file-path-problem:${problemId}`, type: 'file.operation_attention',
    title: 'File action needs attention', detail: 'EACCES',
    deepLink: `/notebook?workspaceId=workspace-a&workspacePathProblem=${problemId}`, occurredAt: new Date(100).toISOString(),
    unread: true, notificationRevision: '100', priority: 'high', workspaceId: workspace.workspaceId, workspaceName: workspace.displayName ?? null,
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
        dismiss: async ({ workspace: selected, itemId, expectedRevision }: { workspace: WorkspaceContext; itemId: string; expectedRevision: string }) => {
          calls.push({ lane: 'review-dismiss', itemId, expectedRevision, workspaceId: selected.workspaceId });
          return { updated: updateFound ? 1 : 0 };
        },
      },
      workspacePathOperationNotificationSource: {
        list: async () => { if (!directAvailable) throw new Error('/private/direct-source-failure'); return { items: directItems, unreadCount: 3 }; },
        markRead: async ({ workspace: selected, itemId }: { workspace: WorkspaceContext; itemId?: string }) => {
          calls.push({ lane: 'path', itemId, workspaceId: selected.workspaceId }); return { updated: updateFound ? 1 : 0 };
        },
        dismiss: async ({ workspace: selected, itemId, expectedRevision }: { workspace: WorkspaceContext; itemId: string; expectedRevision: string }) => {
          if (dismissFailed) throw new Error('/private/storage-failure');
          calls.push({ lane: 'path-dismiss', itemId, expectedRevision, workspaceId: selected.workspaceId });
          return { updated: updateFound ? 1 : 0 };
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
        assert.equal(response.status, 400, 'dismissal requires the displayed version; arbitrary read-state changes stay unsupported');
      }
      assert.equal(calls.length, count);
      response = await patch({ action: 'dismiss_item', itemId, workspaceId: workspace.workspaceId, expectedRevision: '100' });
      assert.equal(response.status, 200);
      assert.deepEqual(calls.at(-1), { lane: 'path-dismiss', itemId, workspaceId: workspace.workspaceId, expectedRevision: '100' });
      updateFound = false;
      response = await patch({ action: 'dismiss_item', itemId, workspaceId: workspace.workspaceId, expectedRevision: '100' });
      assert.equal(response.status, 409, 'stale dismissals ask the user to refresh');
      updateFound = true;
      const afterDismiss = calls.length;
      response = await patch({ action: 'dismiss_item', itemId, workspaceId: 'foreign-workspace', expectedRevision: '100' });
      assert.equal(response.status, 404);
      for (const expectedRevision of [5, 'invalid', '100.5']) {
        response = await patch({ action: 'dismiss_item', itemId, workspaceId: workspace.workspaceId, expectedRevision });
        assert.equal(response.status, 400);
      }
      assert.equal(calls.length, afterDismiss, 'invalid dismissals never reach storage');
      response = await patch({ action: 'mark_item_read', itemId, workspaceId: 'foreign-workspace' });
      assert.equal(response.status, 404);
      assert.equal(calls.length, afterDismiss, 'foreign workspace requests never reach storage');
      updateFound = false;
      response = await patch({ action: 'mark_item_read', itemId, workspaceId: workspace.workspaceId });
      assert.equal(response.status, 404);
      updateFound = true;
    }

    const preparationRequestId='11111111-2222-3333-4444-555555555555';
    const preparationItemId='file-path-preparation:'+preparationRequestId;
    const beforePreparationGet=calls.length;
    directItems.push({...directItems[0],id:preparationItemId,title:'Pending preparation',detail:'Docs/target.md',priority:'normal',
      deepLink:'/notebook?workspaceId=workspace-a&workspacePathPreparation='+preparationRequestId,
      target:{kind:'file_path_operation',workspaceId:workspace.workspaceId,operationKind:'rename',status:'pending',preparationRequestId}});
    response=await get(); assert.equal(response.status,200); payload=await response.json();
    const pending=payload.data.sections.notifications.find((item:{id:string})=>item.id===preparationItemId);
    assert(pending); assert.equal(pending.target.preparationRequestId,preparationRequestId);
    assert.equal(calls.length,beforePreparationGet,'summary discovery never marks read, resumes or creates an operation');
    response=await patch({action:'mark_item_read',itemId:preparationItemId,workspaceId:workspace.workspaceId});
    assert.equal(response.status,200);
    assert.deepEqual(calls.at(-1),{lane:'path',itemId:preparationItemId,workspaceId:workspace.workspaceId},'pending mark-read uses the central path source');
    const afterPreparationRead=calls.length;
    response=await patch({action:'mark_item_read',itemId:preparationItemId,workspaceId:'foreign-workspace'});
    assert.equal(response.status,404); assert.equal(calls.length,afterPreparationRead);
    response=await patch({action:'set_item_read_state',itemId:preparationItemId,workspaceId:workspace.workspaceId,read:true});
    assert.equal(response.status,400); assert.equal(calls.length,afterPreparationRead);

    calls.length = 0;
    response = await patch({ action: 'mark_all_read' });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ lane: 'review', itemId: undefined, workspaceId: workspace.workspaceId },
      { lane: 'path', itemId: undefined, workspaceId: workspace.workspaceId }]);
    response = await patch({ action: 'mark_item_read', itemId: 'file-operation:old-review', workspaceId: workspace.workspaceId });
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1)?.lane, 'review', 'existing real review notifications keep their route');
    response = await patch({ action: 'dismiss_item', itemId: 'file-operation:old-review', workspaceId: workspace.workspaceId, expectedRevision: '100' });
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1)?.lane, 'review-dismiss');
    dismissFailed = true;
    response = await patch({ action: 'dismiss_item', itemId: directItems[0].id, workspaceId: workspace.workspaceId, expectedRevision: '100' });
    assert.equal(response.status, 500, 'failed storage must not report dismissal success');
    assert.equal(JSON.stringify(await response.json()).includes('/private/'), false);
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
