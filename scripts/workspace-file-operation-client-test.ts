import assert from 'node:assert/strict';

import {
  copyWorkspacePaths,
  previewWorkspaceCopy,
  previewWorkspaceRename,
  renameWorkspacePath,
  WorkspaceFileApiError,
} from '../app/lib/files/client';

async function main() {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, body });
    if (url === '/api/files/rename' && body.dryRun === true) {
      return Response.json({ dryRun: true, requiresRevalidation: true, plan: {
        planId: 'plan-1', readiness: 'ready', pathMappings: [{ sourcePath: 'a.png', destinationPath: 'b.png' }],
        linkEdits: [{ previousTargetLiteral: 'a.png', nextTargetLiteral: 'b.png' }],
        coverage: { complete: true, omittedSources: [], unresolvedLinks: [] }, issues: [],
      } });
    }
    if (url === '/api/files/rename') {
      return Response.json({ mutation: { type: 'rename', oldPath: 'a.png', newPath: 'b.png',
        workspaceId: 'ws', operationId: 'op' }, linkStatus: 'partial',
      linkUpdates: { updatedFiles: [], updatedLinks: 0, warnings: ['Markdown link not rewritten'] } });
    }
    if (url === '/api/files/copy' && body.dryRun === true) {
      return Response.json({ dryRun: true, requiresRevalidation: true, plan: {
        planId: 'copy-plan', readiness: 'ready', pathMappings: [], linkEdits: [],
        coverage: { complete: true, omittedSources: [], unresolvedLinks: [] }, issues: [],
      } });
    }
    if (url === '/api/files/copy') {
      if (body.planId === 'stale') return Response.json({ error: 'changed', code: 'PREVIEW_STALE' }, { status: 409 });
      return Response.json({ copied: ['b.png'], failed: [], skipped: [], linkStatus: 'incomplete',
        linkWarnings: ['Copied Markdown links were not checked or rewritten.'] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const preview = await previewWorkspaceRename('a.png', 'b.png', 'ws');
    assert.equal(preview.plan.linkEdits[0].nextTargetLiteral, 'b.png');
    assert.equal(preview.requiresRevalidation, true);
    assert.deepEqual(requests[0], { url: '/api/files/rename', body: { oldPath: 'a.png', newPath: 'b.png', dryRun: true } });
    const rename = await renameWorkspacePath('a.png', 'b.png', false, 'ws', preview.plan.planId);
    assert.equal(rename.linkStatus, 'partial');
    assert.deepEqual(rename.linkUpdates?.warnings, ['Markdown link not rewritten']);
    assert.equal(requests[1].body.planId, preview.plan.planId);
    const copyPreview = await previewWorkspaceCopy({ sources: ['a.png'], destDir: '.',
      sourceWorkspaceId: 'ws', renameOnCollision: true });
    assert.equal(copyPreview.plan.planId, 'copy-plan');
    assert.equal(requests[2].body.dryRun, true);
    const copy = await copyWorkspacePaths({ sources: ['a.png'], destDir: '.', sourceWorkspaceId: 'ws',
      planId: copyPreview.plan.planId });
    assert.equal(copy.linkStatus, 'incomplete');
    assert.equal(requests[3].body.dryRun, undefined);
    assert.equal(requests[3].body.planId, copyPreview.plan.planId);
    await assert.rejects(copyWorkspacePaths({ sources: ['a.png'], destDir: '.', planId: 'stale' }),
      (error) => error instanceof WorkspaceFileApiError && error.code === 'PREVIEW_STALE');
    console.log('workspace-file-operation-client-test: ok');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
