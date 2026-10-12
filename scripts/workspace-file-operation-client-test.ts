import assert from 'node:assert/strict';

import {
  copyWorkspacePaths,
  previewWorkspaceCopy,
  previewWorkspaceRename,
  renameWorkspacePath,
  WorkspaceFileApiError,
  type WorkspacePathConflictError,
} from '../app/lib/files/client';
import { WorkspacePathOperationClientError } from '../app/lib/files/workspace-path-operation-client';
import type { WorkspacePathOperationPublic } from '../app/lib/files/workspace-path-operation-public';

async function main() {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let renameFailure: Record<string, unknown> | null = null;
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
      if (renameFailure) return Response.json(renameFailure, { status: 409 });
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

    const blockedOperation: WorkspacePathOperationPublic = {
      batchId: 'rename-client-batch-1234567890', planId: 'a'.repeat(64), workspaceId: 'ws',
      status: 'blocked', completedActions: 0, totalActions: 2, phase: 'preparing',
      errorCode: 'PREVIEW_BLOCKED', kind: 'move',
      selections: [{ sourcePath: 'a.png', destinationPath: 'b.png' }],
      issues: [{ code: 'unevaluated-link', path: 'Bild.md' }, { code: 'unknown', path: '' }],
    };
    const failure = { error: 'Links could not be checked', code: 'PREVIEW_BLOCKED', type: 'file',
      sourcePath: 'a.png', destPath: 'b.png' };
    renameFailure = { ...failure, operation: { ...blockedOperation, privatePlan: { content: 'private document text' },
      selections: [{ ...blockedOperation.selections[0], absolutePath: '/private/data/a.png' }],
      issues: [{ ...blockedOperation.issues![0], rawHtml: '<private>', diagnostic: 'private detail' }, blockedOperation.issues![1]] } };
    const beforeBlocked = requests.length;
    await assert.rejects(renameWorkspacePath('a.png', 'b.png', false, 'ws', blockedOperation.planId), (error: unknown) => {
      assert.ok(error instanceof WorkspacePathOperationClientError);
      assert.deepEqual(error.operation, blockedOperation, 'initial 409 retains only the safe public operation and issues');
      assert.equal(error.message, failure.error);
      const conflict = error as WorkspacePathConflictError;
      assert.equal(conflict.code, failure.code);
      assert.equal(conflict.type, failure.type);
      assert.equal(conflict.sourcePath, failure.sourcePath);
      assert.equal(conflict.destPath, failure.destPath);
      return true;
    });
    assert.equal(requests.length, beforeBlocked + 1, 'a rejected initial action is never followed as a success');

    renameFailure = { ...failure, operation: { ...blockedOperation, status: 'applied', phase: 'complete', completedActions: 2 } };
    await assert.rejects(renameWorkspacePath('a.png', 'b.png', false, 'ws', blockedOperation.planId),
      WorkspacePathOperationClientError, 'even a settled operation in a non-2xx response cannot acknowledge a successful rename');

    for (const invalid of [
      { ...blockedOperation, workspaceId: 'foreign-workspace' },
      { ...blockedOperation, planId: 'b'.repeat(64) },
      { ...blockedOperation, batchId: '../private-batch' },
      { ...blockedOperation, status: 'invented' },
      { ...blockedOperation, phase: 'invented' },
      { ...blockedOperation, completedActions: -1 },
      { ...blockedOperation, completedActions: 3 },
      { ...blockedOperation, totalActions: 2.5 },
      { ...blockedOperation, status: 'applied', phase: 'preparing' },
      ...['../private.md', '/private/data.md', 'folder\\private.md', 'https://private.test/file', 'private\u0000.md'].map((path) =>
        ({ ...blockedOperation, issues: [{ code: 'unevaluated-link', path }] })),
    ]) {
      renameFailure = { ...failure, operation: invalid };
      const beforeInvalid = requests.length;
      await assert.rejects(renameWorkspacePath('a.png', 'b.png', false, 'ws', blockedOperation.planId), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof WorkspacePathOperationClientError), 'foreign or malformed initial operations are not accepted');
        return true;
      });
      assert.equal(requests.length, beforeInvalid + 1, 'invalid initial operations cannot initiate polling');
    }

    renameFailure = { error: 'Destination already exists', code: 'FILE_EXISTS', type: 'file', sourcePath: 'a.png', destPath: 'b.png' };
    await assert.rejects(renameWorkspacePath('a.png', 'b.png', false, 'ws'), (error: unknown) => {
      assert.ok(error instanceof Error);
      const conflict = error as WorkspacePathConflictError;
      assert.equal(conflict.code, 'FILE_EXISTS');
      assert.equal(conflict.type, 'file');
      assert.equal(conflict.sourcePath, 'a.png');
      assert.equal(conflict.destPath, 'b.png');
      assert.equal(conflict.message, 'Destination already exists');
      return true;
    });
    console.log('workspace-file-operation-client-test: ok');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
