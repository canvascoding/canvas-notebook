import assert from 'node:assert/strict';

import {
  copyWorkspacePaths,
  previewWorkspaceCopy,
  previewWorkspaceRename,
  renameWorkspacePath,
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
    const rename = await renameWorkspacePath('a.png', 'b.png', false, 'ws');
    assert.equal(rename.linkStatus, 'partial');
    assert.deepEqual(rename.linkUpdates?.warnings, ['Markdown link not rewritten']);
    const copyPreview = await previewWorkspaceCopy({ sources: ['a.png'], destDir: '.',
      sourceWorkspaceId: 'ws', renameOnCollision: true });
    assert.equal(copyPreview.plan.planId, 'copy-plan');
    assert.equal(requests[2].body.dryRun, true);
    const copy = await copyWorkspacePaths({ sources: ['a.png'], destDir: '.', sourceWorkspaceId: 'ws' });
    assert.equal(copy.linkStatus, 'incomplete');
    assert.equal(requests[3].body.dryRun, undefined);
    console.log('workspace-file-operation-client-test: ok');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
