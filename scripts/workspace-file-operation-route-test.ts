import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { NextRequest } from 'next/server';

async function main() {
  let authenticated = true;
  let canWrite = true;
  let previewCalls = 0;
  let renameCalls = 0;
  let copyCalls = 0;
  let linkWriteFails = false;
  let previewError: Error | null = null;
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
    withWorkspaceCopyMutationLocks: async (_source: unknown, _target: unknown, operation: () => Promise<unknown>) => operation(),
    batchCopyBetweenWorkspaces: async () => {
      copyCalls += 1;
      return { copied: ['Archive/chart.png'], failed: [], skipped: [], collaborationInitializedPaths: [] };
    },
  } });
  mock.module('@/app/lib/files/rename-service', { exports: {
    renameWorkspacePath: async () => {
      renameCalls += 1;
      return { warnings: [], mutation: { type: 'rename', oldPath: 'Notes/chart.png',
        newPath: 'Notes/new.png', workspaceId: 'ws', operationId: 'rename-1' } };
    },
  } });
  mock.module('@/app/lib/files/collaboration-policy', { exports: {
    initializeCopiedFileCollaborationPaths: async () => {},
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
  mock.module('@/app/lib/markdown/workspace-file-operation-preview', { exports: {
    WorkspacePreviewStaleError,
    WorkspacePreviewUnavailableError,
    buildWorkspaceFileOperationPreview: async () => {
      previewCalls += 1;
      if (previewError) throw previewError;
      return { planId: 'preview-1', readiness: 'ready', pathMappings: [{
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
    assert.equal(renamePreviewBody.plan.planId, 'preview-1');
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
    assert.equal((await copyPreview.json()).plan.planId, 'preview-1');
    assert.equal(copyCalls, 0, 'copy dry run must not mutate');
    const overwritePreview = await copyRoute.POST(request('copy', { sources: ['Notes/chart.png'],
      destDir: 'Archive', dryRun: true, overwrite: true }));
    assert.equal(overwritePreview.status, 422);
    assert.equal((await overwritePreview.json()).code, 'PREVIEW_UNSUPPORTED_COLLISION_POLICY');

    const rename = await renameRoute.POST(request('rename', { oldPath: 'Notes/chart.png',
      newPath: 'Notes/new.png' }));
    const renameBody = await rename.json();
    assert.equal(renameBody.linkStatus, 'partial', 'PNG target incoming Markdown link must not be declared complete');
    assert.match(renameBody.linkUpdates.warnings.join(' '), /incoming Wiki links only/u);
    assert.equal(renameCalls, 1);
    linkWriteFails = true;
    const failedLinkWrite = await renameRoute.POST(request('rename', { oldPath: 'Notes/chart.png',
      newPath: 'Notes/new.png' }));
    const failedLinkWriteBody = await failedLinkWrite.json();
    assert.equal(failedLinkWrite.status, 200, 'committed path change must retain a result');
    assert.equal(failedLinkWriteBody.linkStatus, 'partial');
    assert.match(failedLinkWriteBody.linkUpdates.warnings.join(' '), /disk write failed/u);
    assert.equal(renameCalls, 2);
    const copy = await copyRoute.POST(request('copy', { sources: ['Notes/chart.png'], destDir: 'Archive' }));
    assert.equal((await copy.json()).linkStatus, 'incomplete');
    assert.equal(copyCalls, 1);
    console.log('workspace-file-operation-route-test: ok');
  } finally {
    mock.reset();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
