import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { NextRequest } from 'next/server';

async function main() {
  let authenticated = true;
  let canWrite = true;
  let previewCalls = 0;
  let renameCalls = 0;
  let copyCalls = 0;
  let safeCalls = 0;
  let safeNeedsRecovery = false;
  let linkWriteFails = false;
  let previewError: Error | null = null;
  const currentPlanId = 'a'.repeat(64);
  let currentReadiness: 'ready' | 'blocked' = 'ready';
  let lockDepth = 0;
  const workspace = {
    workspaceId: 'ws', workspaceType: 'personal', organizationId: 'org',
  };
  const jsonSuccess = (payload: Record<string, unknown>) => Response.json({ success: true, ...payload });
  const jsonError = (error: string, status: number, details: Record<string, unknown> = {}) =>
    Response.json({ success: false, error, ...details }, { status });

  mock.module('@/app/lib/auth', { exports: { auth: { api: { getSession: async () =>
    authenticated ? { user: { id: 'user' } } : null } } } });
  mock.module('@/app/lib/workspaces/request', { exports: {
    requireRequestWorkspace: async () => canWrite
      ? { workspace, session: { user: { id: 'user' } } }
      : { response: jsonError('Forbidden', 403) },
    requireSessionWorkspace: async (_session: unknown, input: { permissions: string }) =>
      input.permissions === 'canWrite' && !canWrite
        ? { response: jsonError('Forbidden', 403) }
        : { workspace },
    workspaceFileOptions: () => ({ workspace }),
  } });
  mock.module('@/app/lib/api/route-helpers', { exports: {
    applyRateLimit: () => null,
    invalidateWorkspaceFileViews: () => {},
    jsonError,
    jsonServerError: (_prefix: string, error: unknown) => jsonError(String(error), 500),
    jsonSuccess,
    readJsonBody: (request: Request) => request.json(),
  } });
  mock.module('@/app/lib/audit/audit-service', { exports: { recordAuditEvent: async () => {} } });
  mock.module('@/app/lib/filesystem/app-output-folders', { exports: { isProtectedAppOutputFolder: () => false } });
  mock.module('@/app/lib/filesystem/workspace-files', { exports: {
    checkRenameConflict: async () => null,
    getFileStats: async () => ({ isDirectory: true }),
    withWorkspaceCopyMutationLocks: async (_source: unknown, _target: unknown, operation: () => Promise<unknown>) => {
      lockDepth += 1;
      try { return await operation(); } finally { lockDepth -= 1; }
    },
    batchCopyBetweenWorkspaces: async () => {
      assert.equal(lockDepth, 1, 'copy must remain inside the validation lock');
      copyCalls += 1;
      return { copied: ['Archive/chart.png'], failed: [], skipped: [], collaborationInitializedPaths: [] };
    },
  } });
  mock.module('@/app/lib/files/workspace-mutation-lock', { exports: {
    withWorkspaceMutationLock: async (_workspaceId: string, operation: () => Promise<unknown>) => {
      lockDepth += 1;
      try { return await operation(); } finally { lockDepth -= 1; }
    },
  } });
  mock.module('@/app/lib/files/rename-service', { exports: {
    renameWorkspacePath: async () => {
      assert.equal(lockDepth, 1, 'rename must remain inside the validation lock');
      renameCalls += 1;
      return { warnings: [], mutation: { type: 'rename', oldPath: 'Notes/chart.png',
        newPath: 'Notes/new.png', workspaceId: 'ws', operationId: 'rename-1' } };
    },
  } });
  mock.module('@/app/lib/files/collaboration-policy', { exports: {
    initializeCopiedFileCollaborationPaths: async () => {},
  } });
  mock.module('@/app/lib/files/workspace-file-operation-service', { exports: {
    executeWorkspaceFileOperationService: async (input: { kind: 'rename' | 'copy'; expectedPlanId?: string }) => {
      safeCalls += 1;
      if (input.expectedPlanId && input.expectedPlanId !== currentPlanId) throw new WorkspacePreviewStaleError('changed');
      if (currentReadiness !== 'ready') throw new WorkspacePreviewBlockedError('blocked');
      const status = safeNeedsRecovery ? 'needs_recovery' : 'complete';
      return {
        execution: { operationId: 'safe-operation', planId: currentPlanId, status,
          completedSteps: status === 'complete' ? ['path:all', 'link:one'] : ['path:all'],
          pendingSteps: status === 'complete' ? [] : ['link:one'], errorCode: safeNeedsRecovery ? 'LINK_WRITE_STALE' : null },
        plan: { linkEdits: [{ previousTargetLiteral: './chart.png', nextTargetLiteral: './new.png' }],
          previewContents: [{ path: 'Notes/start.md' }] },
        rename: input.kind === 'rename' ? { mutation: { type: 'rename', oldPath: 'Notes/chart.png',
          newPath: 'Notes/new.png', workspaceId: 'ws', operationId: 'rename-safe' } } : null,
        copied: input.kind === 'copy' ? ['Archive/chart.png'] : [], alreadyKnown: false,
      };
    },
  } });
  mock.module('@/app/lib/markdown/workspace-link-index', { exports: {
    buildWorkspaceLinkIndex: async () => ({
      edges: [{ kind: 'markdown', status: 'resolved', sourcePath: 'Notes/start.md',
        targetPath: 'Notes/chart.png' }],
      coverage: { complete: true, omittedSources: [], unresolvedLinks: [] },
    }),
    applyWorkspaceLinkRename: async () => {
      if (linkWriteFails) throw new Error('disk write failed');
      return { updatedFiles: [], updatedLinks: 0, warnings: [] };
    },
  } });
  class WorkspacePreviewStaleError extends Error {}
  class WorkspacePreviewUnavailableError extends Error {}
  class WorkspacePreviewBlockedError extends Error {}
  mock.module('@/app/lib/markdown/workspace-file-operation-preview', { exports: {
    WorkspacePreviewStaleError,
    WorkspacePreviewUnavailableError,
    WorkspacePreviewBlockedError,
    assertFreshWorkspaceFileOperationPlan: (plan: { planId: string; readiness: string }, expected: string) => {
      assert.equal(lockDepth, 1, 'plan must be revalidated while locked');
      if (plan.planId !== expected) throw new WorkspacePreviewStaleError('changed');
      if (plan.readiness !== 'ready') throw new WorkspacePreviewBlockedError('blocked');
    },
    buildWorkspaceFileOperationPreview: async () => {
      previewCalls += 1;
      if (previewError) throw previewError;
      return { planId: currentPlanId, readiness: currentReadiness, pathMappings: [{
        sourcePath: 'Notes/chart.png', destinationPath: 'Notes/new.png',
      }], linkEdits: [{ previousTargetLiteral: './chart.png', nextTargetLiteral: './new.png' }],
      coverage: { complete: true, omittedSources: [], unresolvedLinks: [] }, issues: [],
      previewContents: [{ path: 'Notes/start.md', content: '[Image](./new.png)' }] };
    },
  } });

  const renameRoute = await import('../app/api/files/rename/route');
  const copyRoute = await import('../app/api/files/copy/route');
  const request = (route: string, body: Record<string, unknown>) =>
    new NextRequest(`http://localhost/api/files/${route}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  try {
    canWrite = false;
    assert.equal((await renameRoute.POST(request('rename', { oldPath: 'Notes/chart.png',
      newPath: 'Notes/new.png', dryRun: true }))).status, 403);
    assert.equal(previewCalls, 0, 'authorization must precede preview');
    canWrite = true;
    const renamePreview = await renameRoute.POST(request('rename', { oldPath: 'Notes/chart.png',
      newPath: 'Notes/new.png', dryRun: true }));
    const renamePreviewBody = await renamePreview.json();
    assert.equal(renamePreviewBody.plan.planId, currentPlanId);
    assert.equal(renamePreviewBody.requiresRevalidation, true);
    assert.equal(renamePreviewBody.plan.previewContents, undefined, 'full file contents must stay off response');
    assert.equal(renameCalls, 0, 'rename dry run must not mutate');
    const overwriteRenamePreview = await renameRoute.POST(request('rename', { oldPath: 'Notes/chart.png',
      newPath: 'Notes/new.png', dryRun: true, overwrite: true }));
    assert.equal(overwriteRenamePreview.status, 422);
    assert.equal((await overwriteRenamePreview.json()).code, 'PREVIEW_UNSUPPORTED_COLLISION_POLICY');
    previewError = new WorkspacePreviewStaleError('changed');
    const stalePreview = await renameRoute.POST(request('rename', { oldPath: 'Notes/chart.png',
      newPath: 'Notes/new.png', dryRun: true }));
    assert.equal(stalePreview.status, 409);
    assert.equal((await stalePreview.json()).code, 'PREVIEW_STALE');
    previewError = new WorkspacePreviewUnavailableError('unreadable');
    const unreadablePreview = await renameRoute.POST(request('rename', { oldPath: 'Notes/chart.png',
      newPath: 'Notes/new.png', dryRun: true }));
    assert.equal(unreadablePreview.status, 422);
    assert.equal((await unreadablePreview.json()).code, 'PREVIEW_UNREADABLE');
    previewError = null;

    authenticated = false;
    assert.equal((await copyRoute.POST(request('copy', { sources: ['Notes/chart.png'],
      destDir: 'Archive', dryRun: true }))).status, 401);
    authenticated = true;
    canWrite = false;
    assert.equal((await copyRoute.POST(request('copy', { sources: ['Notes/chart.png'],
      destDir: 'Archive', dryRun: true }))).status, 403);
    canWrite = true;
    const copyPreview = await copyRoute.POST(request('copy', { sources: ['Notes/chart.png'],
      destDir: 'Archive', dryRun: true, renameOnCollision: true }));
    assert.equal((await copyPreview.json()).plan.planId, currentPlanId);
    assert.equal(copyCalls, 0, 'copy dry run must not mutate');
    const overwritePreview = await copyRoute.POST(request('copy', { sources: ['Notes/chart.png'],
      destDir: 'Archive', dryRun: true, overwrite: true }));
    assert.equal(overwritePreview.status, 422);
    assert.equal((await overwritePreview.json()).code, 'PREVIEW_UNSUPPORTED_COLLISION_POLICY');

    const staleRename = await renameRoute.POST(request('rename', { oldPath: 'Notes/chart.png',
      newPath: 'Notes/new.png', planId: 'b'.repeat(64) }));
    assert.equal(staleRename.status, 409);
    assert.equal((await staleRename.json()).code, 'PREVIEW_STALE');
    assert.equal(renameCalls, 0, 'stale rename must not use the legacy mutation');
    const staleCopy = await copyRoute.POST(request('copy', { sources: ['Notes/chart.png'],
      destDir: 'Archive', planId: 'b'.repeat(64) }));
    assert.equal(staleCopy.status, 409);
    assert.equal((await staleCopy.json()).code, 'PREVIEW_STALE');
    assert.equal(copyCalls, 0, 'stale copy must not use the legacy mutation');
    currentReadiness = 'blocked';
    const blockedRename = await renameRoute.POST(request('rename', { oldPath: 'Notes/chart.png',
      newPath: 'Notes/new.png', planId: currentPlanId }));
    assert.equal(blockedRename.status, 409);
    assert.equal((await blockedRename.json()).code, 'PREVIEW_BLOCKED');
    assert.equal(renameCalls, 0, 'blocked rename must not mutate');
    currentReadiness = 'ready';

    const rename = await renameRoute.POST(request('rename', { oldPath: 'Notes/chart.png',
      newPath: 'Notes/new.png', planId: currentPlanId }));
    const renameBody = await rename.json();
    assert.equal(renameBody.linkStatus, 'complete', 'the planned Markdown target must be written');
    assert.equal(renameBody.linkUpdates.updatedLinks, 1);
    assert.equal(renameBody.operation.operationId, 'safe-operation');
    assert.equal(renameCalls, 0);
    safeNeedsRecovery = true;
    const partial = await renameRoute.POST(request('rename', { oldPath: 'Notes/chart.png',
      newPath: 'Notes/new.png', planId: currentPlanId }));
    const partialBody = await partial.json();
    assert.equal(partialBody.linkStatus, 'partial');
    assert.equal(partialBody.operation.pendingSteps.length, 1);
    assert.match(partialBody.linkUpdates.warnings.join(' '), /need recovery/u);
    safeNeedsRecovery = false;
    linkWriteFails = true;
    const failedLinkWrite = await renameRoute.POST(request('rename', { oldPath: 'Notes/chart.png',
      newPath: 'Notes/new.png', overwrite: true }));
    const failedLinkWriteBody = await failedLinkWrite.json();
    assert.equal(failedLinkWrite.status, 200, 'committed path change must retain a result');
    assert.equal(failedLinkWriteBody.linkStatus, 'partial');
    assert.match(failedLinkWriteBody.linkUpdates.warnings.join(' '), /disk write failed/u);
    assert.equal(renameCalls, 1);
    const copy = await copyRoute.POST(request('copy', { sources: ['Notes/chart.png'], destDir: 'Archive' }));
    assert.equal((await copy.json()).linkStatus, 'complete');
    assert.equal(copyCalls, 0);
    assert.ok(safeCalls >= 6);
    console.log('workspace-file-operation-route-test: ok');
  } finally {
    mock.reset();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
