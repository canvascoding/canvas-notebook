import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { NextRequest } from 'next/server';

async function main() {
  const operationId = 'a'.repeat(64);
  const planId = 'b'.repeat(64);
  const requestJson = JSON.stringify({ kind: 'rename', selections: [
    { sourcePath: 'Notes/old.md', destinationPath: 'Notes/new.md' },
  ] });
  let authenticated = true;
  let authorized = true;
  let owner = 'user';
  let recoveryCalls = 0;
  let received: Record<string, unknown> | null = null;
  const record = {
    operationId, planId, sourceWorkspaceId: 'ws', destinationWorkspaceId: 'ws',
    actor: { type: 'user', id: owner }, requestJson, status: 'recovery_required',
    phase: 'link', revision: 3, errorCode: 'LINK_WRITE_STALE',
    steps: [{ stepKey: 'path:all', phase: 'path', status: 'applied',
      receiptJson: '{"secret":"never expose"}' }],
  };
  const workspace = { workspaceId: 'ws', permissions: { canRead: true, canWrite: true, canDelete: true } };
  const jsonError = (error: string, status: number, details: Record<string, unknown> = {}) =>
    Response.json({ success: false, error, ...details }, { status });
  mock.module('@/app/lib/auth', { exports: { auth: { api: { getSession: async () =>
    authenticated ? { user: { id: 'user', name: 'User' } } : null } } } });
  mock.module('@/app/lib/api/route-helpers', { exports: {
    applyRateLimit: () => null, jsonError,
    jsonServerError: (_prefix: string, error: unknown) => jsonError(String(error), 500),
    jsonSuccess: (payload: unknown, init?: ResponseInit) => Response.json({ success: true, ...payload as object }, init),
  } });
  mock.module('@/app/lib/workspaces/request', { exports: {
    requireSessionWorkspace: async () => authorized ? { workspace } : { response: jsonError('Forbidden', 403) },
    workspaceFileOptions: () => ({ workspace }),
  } });
  mock.module('@/app/lib/files/workspace-operation-journal', { exports: {
    WorkspaceOperationJournal: class { async get() { return { ...record, actor: { type: 'user', id: owner } }; } },
  } });
  mock.module('@/app/lib/files/workspace-file-operation-service', { exports: {
    executeWorkspaceFileOperationService: async (input: Record<string, unknown>) => {
      recoveryCalls += 1;
      received = input;
      return { execution: { operationId, planId, status: 'complete', completedSteps: ['path:all'],
        pendingSteps: [], errorCode: null } };
    },
  } });
  const route = await import('../app/api/files/operations/[operationId]/route');
  const request = (method: string) => new NextRequest(`http://localhost/api/files/operations/${operationId}`, { method });
  const context = { params: Promise.resolve({ operationId }) };
  try {
    authenticated = false;
    assert.equal((await route.GET(request('GET'), context))!.status, 401);
    authenticated = true;
    owner = 'other';
    assert.equal((await route.GET(request('GET'), context))!.status, 404);
    owner = 'user';
    authorized = false;
    assert.equal((await route.POST(request('POST'), context))!.status, 403);
    authorized = true;
    const status = (await route.GET(request('GET'), context))!;
    assert.equal(status.status, 200);
    assert.equal(status.headers.get('Cache-Control'), 'no-store');
    const body = await status.json();
    assert.equal(body.operation.status, 'recovery_required');
    assert.equal(body.operation.steps[0].status, 'applied');
    assert.equal(JSON.stringify(body).includes('never expose'), false);
    assert.equal(JSON.stringify(body).includes('requestJson'), false);
    const recovered = (await route.POST(request('POST'), context))!;
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).operation.status, 'complete');
    assert.equal(recoveryCalls, 1);
    const recoveryInput = received as Record<string, unknown> | null;
    assert.ok(recoveryInput);
    assert.equal(recoveryInput.operationId, operationId);
    assert.equal(recoveryInput.expectedPlanId, planId);
    assert.equal(recoveryInput.kind, 'rename');
    console.log('workspace-file-operation-recovery-route-test: ok');
  } finally {
    mock.reset();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
