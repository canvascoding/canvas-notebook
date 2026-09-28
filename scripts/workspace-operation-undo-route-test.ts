import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { NextRequest } from 'next/server';

async function main(): Promise<void> {
  const operationId = 'a'.repeat(64);
  const workspace = { workspaceId: 'ws', organizationId: null };
  let authorized = true;
  let undoAvailable = true;
  let posts = 0;
  let audits = 0;
  let invalidations = 0;
  const jsonError = (error: string, status: number, details: Record<string, unknown> = {}) =>
    Response.json({ success: false, error, ...details }, { status });
  mock.module('@/app/lib/workspaces/request', { exports: {
    requireRequestWorkspace: async () => authorized
      ? { response: null, workspace, session: { user: { id: 'user', name: 'User' } } }
      : { response: jsonError('Forbidden', 403) },
    workspaceFileOptions: () => ({ workspace }),
  } });
  mock.module('@/app/lib/files/workspace-operation-undo-service', { exports: {
    getWorkspaceOperationUndoCapability: async () => ({ available: undoAvailable,
      reason: undoAvailable ? null : 'Operation already undone.', undoOperationId: 'b'.repeat(64) }),
    undoWorkspaceFileOperation: async () => {
      posts += 1;
      return { originalOperationId: operationId, undoOperationId: 'b'.repeat(64),
        kind: 'move', status: 'applied', restoredPaths: ['old.md'], removedPaths: ['new.md'],
        linkStatus: 'complete', alreadyKnown: posts > 1 };
    },
  } });
  mock.module('@/app/lib/audit/audit-service', { exports: {
    recordAuditEvent: async () => { audits += 1; },
  } });
  mock.module('@/app/lib/api/route-helpers', { exports: {
    applyRateLimit: () => null,
    invalidateWorkspaceFileViews: () => { invalidations += 1; },
    jsonError,
    jsonServerError: (_prefix: string, error: unknown) => jsonError(String(error), 500),
    jsonSuccess: (payload: unknown, init?: ResponseInit) => Response.json({ success: true, ...payload as object }, init),
  } });
  mock.module('@/app/lib/files/path-utils', { exports: { getParentDirectory: () => '.' } });
  const route = await import('../app/api/files/operations/[operationId]/undo/route');
  const context = { params: Promise.resolve({ operationId }) };
  const request = (method: string) => new NextRequest(`http://localhost/api/files/operations/${operationId}/undo`,
    { method, headers: { 'x-workspace-id': 'ws' } });
  try {
    authorized = false;
    assert.equal((await route.GET(request('GET'), context)).status, 403);
    assert.equal((await route.POST(request('POST'), context)).status, 403);
    authorized = true;
    const capability = await route.GET(request('GET'), context);
    assert.equal(capability.status, 200);
    assert.equal(capability.headers.get('Cache-Control'), 'no-store');
    assert.equal((await capability.json()).undo.available, true);
    const applied = await route.POST(request('POST'), context);
    assert.equal(applied.status, 200);
    const body = await applied.json();
    assert.equal(body.undo.status, 'applied');
    assert.deepEqual(body.undo.restoredPaths, ['old.md']);
    assert.deepEqual(body.undo.removedPaths, ['new.md']);
    assert.equal(invalidations, 1);
    assert.equal(audits, 1);
    undoAvailable = false;
    assert.equal((await (await route.GET(request('GET'), context)).json()).undo.available, false);
    const replay = await route.POST(request('POST'), context);
    assert.equal((await replay.json()).undo.alreadyKnown, true);
    assert.equal(posts, 2);
    console.log('workspace operation undo route: auth, capability, apply, idempotent replay, audit OK');
  } finally { mock.reset(); }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
