import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { NextRequest } from 'next/server';

async function main() {
  let authenticated = true;
  let canWrite = true;
  let revokedInsideLock = false;
  let previewCalls = 0;
  let copyCalls = 0;
  let safeCopyCalls = 0;
  let directCalls = 0;
  let auditCalls = 0;
  let lockDepth = 0;
  let receiptUnavailable = false;
  let previewError: Error | null = null;
  let status = 'applied';
  let currentReadiness: 'ready' | 'blocked' = 'ready';
  let conflict: { code: string; type: string; message: string; sourcePath: string; destPath: string } | null = null;
  const currentPlanId = 'a'.repeat(64);
  const workspace = { workspaceId: 'ws', rootPath: '/isolated/ws', workspaceType: 'personal', organizationId: 'org' };
  const submitted: Array<{ kind: string; overwrite?: boolean; expectedPlanId?: string; idempotencyKey?: string; updateLinks?: boolean }> = [];
  const jsonSuccess = (payload: Record<string, unknown>, init?: ResponseInit) => Response.json({ success: true, ...payload }, init);
  const jsonError = (error: string, code: number, details: Record<string, unknown> = {}) =>
    Response.json({ success: false, error, ...details }, { status: code });
  const operation = () => ({ batchId: 'direct-rename-job', planId: currentPlanId, workspaceId: 'ws', status,
    kind: 'rename', selections: [{ sourcePath: 'Notes/chart.png', destinationPath: 'Notes/new.png' }],
    completedActions: status === 'applied' ? 2 : 0, totalActions: 2,
    phase: status === 'applied' ? 'complete' : 'preparing', errorCode: status === 'needs_recovery' ? 'LINK_WRITE_STALE' : null });
  class WorkspacePreviewStaleError extends Error {}
  class WorkspacePreviewUnavailableError extends Error {}
  class WorkspacePreviewBlockedError extends Error {}

  mock.module('@/app/lib/auth', { exports: { auth: { api: { getSession: async () =>
    authenticated ? { user: { id: 'user' } } : null } } } });
  mock.module('@/app/lib/workspaces/request', { exports: {
    requireRequestWorkspace: async (_request: unknown, options: { permissions: string[] }) => {
      assert.deepEqual(options.permissions, ['canRead', 'canWrite', 'canDelete']);
      return canWrite && !(lockDepth && revokedInsideLock) ? { workspace, session: { user: { id: 'user' } }, response: null }
        : { response: jsonError('Forbidden', 403) };
    },
    requireSessionWorkspace: async (_session: unknown, input: { permissions: string }) =>
      input.permissions === 'canWrite' && !canWrite ? { response: jsonError('Forbidden', 403) } : { workspace },
    workspaceFileOptions: () => ({ workspace }),
  } });
  mock.module('@/app/lib/api/route-helpers', { exports: {
    applyRateLimit: () => null, invalidateWorkspaceFileViews: () => {}, jsonError, jsonSuccess,
    jsonServerError: (_prefix: string, error: unknown) => jsonError(String(error), 500),
    readJsonBody: (request: Request) => request.json(),
  } });
  mock.module('@/app/lib/audit/audit-service', { exports: { recordAuditEvent: async () => { auditCalls += 1; } } });
  mock.module('@/app/lib/filesystem/app-output-folders', { exports: { isProtectedAppOutputFolder: () => false } });
  mock.module('@/app/lib/filesystem/workspace-files', { exports: {
    checkRenameConflict: async () => conflict,
    getFileStats: async () => ({ isDirectory: true }),
    withWorkspaceCopyMutationLocks: async (_source: unknown, _target: unknown, work: () => Promise<unknown>) => {
      lockDepth += 1;
      try { return await work(); } finally { lockDepth -= 1; }
    },
    batchCopyBetweenWorkspaces: async () => {
      copyCalls += 1;
      return { copied: ['Archive/chart.png'], failed: [], skipped: [], collaborationInitializedPaths: [] };
    },
  } });
  mock.module('@/app/lib/files/workspace-mutation-lock', { exports: {
    withWorkspaceMutationLock: async (_workspaceId: string, work: () => Promise<unknown>) => {
      lockDepth += 1;
      try { return await work(); } finally { lockDepth -= 1; }
    },
  } });
  mock.module('@/app/lib/files/collaboration-policy', { exports: { initializeCopiedFileCollaborationPaths: async () => {} } });
  const preview = () => {
    previewCalls += 1;
    if (previewError) throw previewError;
    return { planId: currentPlanId, readiness: currentReadiness, pathMappings: [{ sourcePath: 'Notes/chart.png',
      destinationPath: 'Notes/new.png' }], linkEdits: [{ previousTargetLiteral: './chart.png', nextTargetLiteral: './new.png' }],
      coverage: { complete: true, omittedSources: [], unresolvedLinks: [] }, issues: [],
      previewContents: [{ path: 'Notes/start.md', content: '[Image](./new.png)' }] };
  };
  mock.module('@/app/lib/markdown/workspace-file-operation-preview', { exports: {
    WorkspacePreviewStaleError, WorkspacePreviewUnavailableError, WorkspacePreviewBlockedError,
    assertFreshWorkspaceFileOperationPlan: (plan: { planId: string; readiness: string }, expected: string) => {
      if (plan.planId !== expected) throw new WorkspacePreviewStaleError('changed');
      if (plan.readiness !== 'ready') throw new WorkspacePreviewBlockedError('blocked');
    }, buildWorkspaceFileOperationPreview: async () => preview(),
  } });
  mock.module('@/app/lib/files/workspace-file-operation-service', { exports: {
    executeWorkspaceFileOperationService: async (input: { expectedPlanId?: string }) => {
      safeCopyCalls += 1;
      if (input.expectedPlanId && input.expectedPlanId !== currentPlanId) throw new WorkspacePreviewStaleError('changed');
      return { execution: { operationId: 'safe-copy', planId: currentPlanId, status: 'complete', completedSteps: ['path'], pendingSteps: [] },
        plan: { linkEdits: [] }, copied: ['Archive/chart.png'], alreadyKnown: false };
    },
  } });
  mock.module('@/app/lib/files/workspace-path-operation-service', { exports: {
    buildWorkspacePathOperationPlan: async () => {
      assert.equal(lockDepth, 1);
      const linkPlan = { ...preview(), planId: 'b'.repeat(64) };
      return { planId: currentPlanId, readiness: currentReadiness, linkPlan };
    },
    submitDirectWorkspacePathOperation: async (input: (typeof submitted)[number]) => {
      assert.equal(lockDepth, 1, 'submission follows a refreshed permission check under the mutation lock');
      directCalls += 1; submitted.push(input);
      if (input.expectedPlanId && input.expectedPlanId !== currentPlanId) throw new WorkspacePreviewStaleError('changed');
      return { ...operation(), workspaceId: 'ws', plan: { previewContents: [{ path: 'Notes/start.md' }] } };
    },
    waitForWorkspacePathOperation: async (batch: unknown) => {
      assert.equal(lockDepth, 0, 'the worker must be able to acquire the preparation lock during the wait');
      return batch;
    },
  } });
  mock.module('@/app/lib/files/workspace-path-operation-response', { exports: {
    workspacePathOperationMetadata: operation,
    workspacePathOperationResponse: async () => {
      if (receiptUnavailable) throw Object.assign(new Error('Missing receipt'), { status: 409, code: 'BATCH_JOURNAL_UNAVAILABLE' });
      return status === 'applied' ? { operation: operation(), linkStatus: 'complete',
        linkUpdates: { updatedFiles: ['Notes/start.md'], updatedLinks: 1, warnings: [] },
        mutation: { type: 'rename', oldPath: 'Notes/chart.png', newPath: 'Notes/new.png', workspaceId: 'ws',
          operationId: 'receipted-mutation' } } : { operation: operation() };
    },
  } });
  const renameRoute = await import('../app/api/files/rename/route');
  const copyRoute = await import('../app/api/files/copy/route');
  const request = (route: string, body: Record<string, unknown>) =>
    new NextRequest(`http://localhost/api/files/${route}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const rename = (body: Record<string, unknown> = {}) => renameRoute.POST(request('rename', {
    oldPath: 'Notes/chart.png', newPath: 'Notes/new.png', ...body,
  }));

  try {
    canWrite = false;
    assert.equal((await rename({ dryRun: true })).status, 403);
    assert.equal(previewCalls, 0);
    canWrite = true;
    const renamePreview = await rename({ dryRun: true });
    const previewBody = await renamePreview.json();
    assert.equal(renamePreview.status, 200);
    assert.equal(previewBody.plan.planId, currentPlanId, 'public preview uses the exact batch identity required by apply');
    assert.equal(previewBody.plan.previewContents, undefined);
    assert.equal(previewBody.requiresRevalidation, true);
    assert.equal(directCalls, 0);
    assert.equal((await rename({ dryRun: true, overwrite: true })).status, 200, 'file overwrite uses the common preview');
    currentReadiness = 'blocked';
    const blockedPreview = await rename({ dryRun: true });
    assert.equal((await blockedPreview.json()).plan.readiness, 'blocked');
    assert.equal(directCalls, 0, 'a blocked dry run is read-only');
    currentReadiness = 'ready';
    previewError = new WorkspacePreviewStaleError('changed');
    assert.equal((await rename({ dryRun: true })).status, 409);
    previewError = new WorkspacePreviewUnavailableError('unreadable');
    assert.equal((await rename({ dryRun: true })).status, 422);
    previewError = null;
    assert.equal((await rename({ planId: 'b'.repeat(64) })).status, 409);
    const applied = await rename({ planId: currentPlanId, updateLinks: false, idempotencyKey: 'rename-request' });
    const appliedBody = await applied.json();
    assert.equal(applied.status, 200);
    assert.equal(appliedBody.linkStatus, 'complete');
    assert.equal(appliedBody.linkUpdates.updatedLinks, 1);
    assert.equal(appliedBody.mutation.operationId, 'receipted-mutation');
    assert.equal(submitted.at(-1)!.updateLinks, undefined, 'updateLinks:false cannot bypass mandatory link maintenance');
    assert.equal(submitted.at(-1)!.expectedPlanId, currentPlanId);
    assert.equal(submitted.at(-1)!.idempotencyKey, 'rename-request');
    const auditsAfterApply = auditCalls;
    for (const pending of ['queued', 'applying']) {
      status = pending;
      const response = await rename({ overwrite: true });
      const body = await response.json();
      assert.equal(response.status, 202);
      assert.equal(body.operation.status, pending);
      assert.equal(body.mutation, undefined);
      assert.equal(body.linkStatus, undefined);
    }
    for (const failed of ['blocked', 'needs_review', 'needs_recovery', 'failed']) {
      status = failed;
      const response = await rename({ overwrite: true });
      const body = await response.json();
      assert.equal(response.status, 409);
      assert.equal(body.operation.status, failed);
      assert.equal(body.mutation, undefined);
      assert.equal(body.linkUpdates, undefined, 'partial link maintenance never returns a successful result');
    }
    assert.equal(auditCalls, auditsAfterApply);
    status = 'blocked';
    for (const code of ['FILE_EXISTS', 'DIRECTORY_EXISTS', 'SOURCE_NOT_FOUND']) {
      conflict = { code, type: code === 'DIRECTORY_EXISTS' ? 'directory' : 'file', message: 'Path conflict',
        sourcePath: 'Notes/chart.png', destPath: 'Notes/new.png' };
      const response = await rename();
      const body = await response.json();
      assert.equal(response.status, 409);
      assert.equal(body.code, code, 'bulk move conflict behavior remains available');
      assert.equal(body.operation.status, 'blocked');
      assert.equal(body.sourcePath, conflict.sourcePath);
      assert.equal(body.mutation, undefined);
    }
    conflict = null;
    status = 'applied'; receiptUnavailable = true;
    const missing = await rename();
    const missingBody = await missing.json();
    assert.equal(missing.status, 409);
    assert.equal(missingBody.code, 'BATCH_JOURNAL_UNAVAILABLE');
    assert.equal(missingBody.operation.batchId, 'direct-rename-job');
    assert.equal(missingBody.mutation, undefined);
    receiptUnavailable = false; revokedInsideLock = true;
    const beforeDenied = directCalls;
    assert.equal((await rename()).status, 403);
    assert.equal(directCalls, beforeDenied);
    revokedInsideLock = false;
    assert.equal((await rename({ planId: 'invalid' })).status, 422);
    assert.equal((await rename({ oldPath: 123 })).status, 400);

    authenticated = false;
    assert.equal((await copyRoute.POST(request('copy', { sources: ['Notes/chart.png'], destDir: 'Archive', dryRun: true }))).status, 401);
    authenticated = true; canWrite = false;
    assert.equal((await copyRoute.POST(request('copy', { sources: ['Notes/chart.png'], destDir: 'Archive', dryRun: true }))).status, 403);
    canWrite = true;
    const copyPreview = await copyRoute.POST(request('copy', { sources: ['Notes/chart.png'], destDir: 'Archive', dryRun: true }));
    assert.equal((await copyPreview.json()).plan.planId, currentPlanId);
    assert.equal((await copyRoute.POST(request('copy', { sources: ['Notes/chart.png'], destDir: 'Archive', dryRun: true, overwrite: true }))).status, 422);
    assert.equal((await copyRoute.POST(request('copy', { sources: ['Notes/chart.png'], destDir: 'Archive', planId: 'b'.repeat(64) }))).status, 409);
    const copy = await copyRoute.POST(request('copy', { sources: ['Notes/chart.png'], destDir: 'Archive' }));
    assert.equal((await copy.json()).linkStatus, 'complete');
    assert.equal(copyCalls, 0);
    assert.equal(safeCopyCalls, 2);
    console.log('file operation routes: durable rename regardless updateLinks/overwrite, stable private preview, truthful pending/failure receipts, lock release, permission recheck, applied audit and unchanged copy contract OK');
  } finally { mock.reset(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
