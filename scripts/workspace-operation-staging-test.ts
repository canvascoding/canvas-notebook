import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  computeWorkspaceFileOperationPlanId,
  createWorkspaceFileOperationPlan,
  type WorkspaceFileOperationPreview,
} from '../app/lib/markdown/workspace-file-operation-planner';
import type { WorkspaceLinkWritePreflight } from '../app/lib/markdown/workspace-link-write-executor';
import {
  WorkspaceOperationStaging,
  WorkspaceOperationStagingError,
} from '../app/lib/files/workspace-operation-staging';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const operationId = 'operation-1234567890';
const original = '[image](images/old.png)\n';
const rewritten = '[image](images/new.png)\n';
const identity = {
  operationId,
  planId: 'a'.repeat(64),
  sourceWorkspaceId: 'workspace-a',
  destinationWorkspaceId: 'workspace-a',
};
const preview: WorkspaceFileOperationPreview = {
  contractVersion: 1,
  planId: identity.planId,
  kind: 'rename',
  status: 'planned',
  readiness: 'ready',
  issues: [],
  pathMappings: [{
    sourceWorkspaceId: 'workspace-a', sourcePath: 'images/old.png',
    destinationWorkspaceId: 'workspace-a', destinationPath: 'images/new.png', sourceIdentity: 'image-id',
  }],
  linkEdits: [{
    sourceWorkspaceId: 'workspace-a', destinationWorkspaceId: 'workspace-a',
    sourcePathBefore: 'notes.md', sourcePathAfter: 'notes.md',
    expectedContentHash: hash(original),
    targetRange: { startUtf16: 8, endUtf16: 22, startUtf8Byte: 8, endUtf8Byte: 22 },
    previousTargetLiteral: 'images/old.png', nextTargetLiteral: 'images/new.png',
  }],
  coverage: { complete: true, omittedSources: [], unresolvedLinks: [] },
  expectedPathState: [],
  collisions: [],
  recoveryReady: false,
  previewContents: [{ workspaceId: 'workspace-a', path: 'notes.md', content: rewritten }],
};
const originalDocuments = [{ workspaceId: 'workspace-a', path: 'notes.md', content: original }];
preview.planId = computeWorkspaceFileOperationPlanId(preview);
identity.planId = preview.planId;
const linkPreflight: WorkspaceLinkWritePreflight = {
  planId: preview.planId,
  sources: [{ sourceWorkspaceId: 'workspace-a', sourcePathBefore: 'notes.md',
    beforeSha256: hash(original), documentId: null, mode: 'plain-file' }],
};
const stageInput = { operationId, preview, sourceWorkspaceId: identity.sourceWorkspaceId,
  destinationWorkspaceId: identity.destinationWorkspaceId, originalDocuments, linkPreflight };

async function testMultiDocumentPlanId(): Promise<void> {
  const plan = createWorkspaceFileOperationPlan({
    kind: 'rename', sourceWorkspaceId: 'workspace-a', destinationWorkspaceId: 'workspace-a',
    selections: [{ sourcePath: 'image.png', destinationPath: 'new.png' }],
    snapshots: [{ workspaceId: 'workspace-a', entries: [
      { identity: 'z', kind: 'file', path: 'z.md', markdownContent: '[image](image.png)' },
      { identity: 'a', kind: 'file', path: 'a.md', markdownContent: '[image](image.png)' },
      { identity: 'image', kind: 'file', path: 'image.png', contentHash: hash('binary') },
    ] }],
  });
  assert.equal(plan.previewContents.length, 2);
  assert.deepEqual(plan.previewContents.map((document) => document.path), ['a.md', 'z.md']);
  assert.equal(computeWorkspaceFileOperationPlanId(plan), plan.planId,
    'the published sorted two-document preview recreates its own plan identity');
  assert.equal(plan.readiness, 'ready');
  await withRoot(async (root) => {
    const staging = new WorkspaceOperationStaging({ dataRoot: root });
    const staged = await staging.stage({
      operationId, preview: plan, sourceWorkspaceId: 'workspace-a', destinationWorkspaceId: 'workspace-a',
      originalDocuments: [
        { workspaceId: 'workspace-a', path: 'z.md', content: '[image](image.png)' },
        { workspaceId: 'workspace-a', path: 'a.md', content: '[image](image.png)' },
      ],
      linkPreflight: { planId: plan.planId, sources: [
        { sourceWorkspaceId: 'workspace-a', sourcePathBefore: 'z.md',
          beforeSha256: hash('[image](image.png)'), documentId: null, mode: 'plain-file' },
        { sourceWorkspaceId: 'workspace-a', sourcePathBefore: 'a.md',
          beforeSha256: hash('[image](image.png)'), documentId: null, mode: 'plain-file' },
      ] },
    });
    assert.deepEqual(staged.preview, plan);
    assert.deepEqual((await staging.load({ ...identity, planId: plan.planId })).preview, plan);
  });
}

async function withRoot(test: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-operation-stage-'));
  try { await test(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function testStageAndRestart(): Promise<void> {
  await withRoot(async (root) => {
    let completed = false;
    const completionLookup = async () => completed ? {
      ...identity, status: 'completed' as const,
    } : { ...identity, status: 'running' as const };
    const staging = new WorkspaceOperationStaging({ dataRoot: root, completionLookup });
    const input = stageInput;
    const first = await staging.stage(input);
    assert.equal(first.preview.previewContents[0]?.content, rewritten);
    assert.deepEqual(first.originalDocuments, originalDocuments);
    assert.deepEqual(first.linkPreflight, linkPreflight);
    assert.equal(first.payloadSha256.length, 64);
    assert.equal((await staging.stage(input)).payloadSha256, first.payloadSha256, 'same operation stages idempotently');

    const storage = path.join(root, 'workspace-operation-staging', operationId);
    const mode = (await fs.stat(storage)).mode & 0o777;
    assert.equal(mode, 0o700);
    for (const file of ['manifest.json', 'document-000000.md', 'document-000001.md']) {
      assert.equal((await fs.stat(path.join(storage, file))).mode & 0o777, 0o600);
    }
    assert.deepEqual((await fs.readdir(path.dirname(storage))).filter((name) => name.startsWith('.tmp-')), []);

    const restarted = new WorkspaceOperationStaging({ dataRoot: root, completionLookup });
    const loaded = await restarted.load(identity);
    assert.deepEqual(loaded.preview, preview, 'restart loads exact planned edits and rewritten Markdown');
    assert.deepEqual(loaded.originalDocuments, originalDocuments, 'restart loads original bytes for rollback');
    await assert.rejects(restarted.removeCompleted(identity), (error: unknown) =>
      error instanceof WorkspaceOperationStagingError && error.code === 'NOT_COMPLETED');
    completed = true;
    await restarted.removeCompleted(identity);
    await restarted.removeCompleted(identity);
    await assert.rejects(restarted.load(identity), (error: unknown) =>
      error instanceof WorkspaceOperationStagingError && error.code === 'CORRUPT_STAGE');
  });
}

async function testRejectsMismatchAndCorruption(): Promise<void> {
  await withRoot(async (root) => {
    const staging = new WorkspaceOperationStaging({ dataRoot: root });
    const input = stageInput;
    await assert.rejects(staging.stage({ ...input, linkPreflight: null }),
      (error: unknown) => error instanceof WorkspaceOperationStagingError && error.code === 'STAGE_CONFLICT');
    await assert.rejects(staging.stage({ ...input, linkPreflight: {
      ...linkPreflight, sources: [{ ...linkPreflight.sources[0]!, beforeSha256: 'b'.repeat(64) }],
    } }), (error: unknown) => error instanceof WorkspaceOperationStagingError && error.code === 'STAGE_CONFLICT');
    await assert.rejects(staging.stage({ ...input, linkPreflight: {
      ...linkPreflight, sources: [{ ...linkPreflight.sources[0]!, content: 'must not persist' }],
    } as never }), (error: unknown) => error instanceof WorkspaceOperationStagingError && error.code === 'STAGE_CONFLICT');
    await assert.rejects(staging.stage({ ...input, originalDocuments: [{ ...originalDocuments[0]!, content: 'changed' }] }),
      (error: unknown) => error instanceof WorkspaceOperationStagingError && error.code === 'STAGE_CONFLICT');
    await assert.rejects(staging.stage({ ...input, preview: { ...preview, readiness: 'blocked' } }),
      (error: unknown) => error instanceof WorkspaceOperationStagingError && error.code === 'STAGE_CONFLICT');
    await assert.rejects(staging.stage({ ...input, originalDocuments: [{ ...originalDocuments[0]!, content: 'x'.repeat(4 * 1024 * 1024 + 1) }] }),
      (error: unknown) => error instanceof WorkspaceOperationStagingError && error.code === 'STAGE_TOO_LARGE');
    const inconsistent = structuredClone(preview);
    inconsistent.previewContents[0]!.content = '[image](images/different.png)\n';
    inconsistent.planId = computeWorkspaceFileOperationPlanId(inconsistent);
    await assert.rejects(staging.stage({ ...input, preview: inconsistent }),
      (error: unknown) => error instanceof WorkspaceOperationStagingError && error.code === 'STAGE_CONFLICT',
      'even a valid plan ID cannot cover an after-text inconsistent with the link edits');
    await staging.stage(input);
    await assert.rejects(staging.stage({ ...input, preview: {
      ...preview, previewContents: [{ ...preview.previewContents[0]!, content: `${rewritten}extra` }],
    } }), (error: unknown) => error instanceof WorkspaceOperationStagingError && error.code === 'STAGE_CONFLICT');

    const storage = path.join(root, 'workspace-operation-staging', operationId);
    await fs.writeFile(path.join(storage, 'document-000000.md'), 'tampered');
    await assert.rejects(staging.load(identity), (error: unknown) =>
      error instanceof WorkspaceOperationStagingError && error.code === 'CORRUPT_STAGE');
  });
}

async function testRehashedManifestCannotReuseOldPlanId(): Promise<void> {
  await withRoot(async (root) => {
    const staging = new WorkspaceOperationStaging({ dataRoot: root });
    await staging.stage(stageInput);
    const manifestPath = path.join(root, 'workspace-operation-staging', operationId, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      preview: { pathMappings: Array<{ destinationPath: string }> };
      payloadSha256: string;
    };
    manifest.preview.pathMappings[0]!.destinationPath = 'images/other.png';
    const { payloadSha256: ignored, ...payload } = manifest;
    void ignored;
    manifest.payloadSha256 = hash(JSON.stringify(payload));
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(staging.load(identity), (error: unknown) =>
      error instanceof WorkspaceOperationStagingError && error.code === 'CORRUPT_STAGE',
      'a rehashed manifest cannot conceal a stale planner identity');
  });
}

async function testRejectsSymlinks(): Promise<void> {
  await withRoot(async (root) => {
    const staging = new WorkspaceOperationStaging({ dataRoot: root });
    const input = stageInput;
    await staging.stage(input);
    const storage = path.join(root, 'workspace-operation-staging', operationId);
    await fs.rename(storage, `${storage}-real`);
    await fs.symlink(`${storage}-real`, storage);
    await assert.rejects(staging.load(identity), (error: unknown) =>
      error instanceof WorkspaceOperationStagingError && error.code === 'UNSAFE_STORAGE');
    await fs.unlink(storage);
    await fs.rename(`${storage}-real`, storage);
    await fs.unlink(path.join(storage, 'document-000000.md'));
    await fs.symlink('/etc/hosts', path.join(storage, 'document-000000.md'));
    await assert.rejects(staging.load(identity));
  });
}

async function testCleanupAfterInterruptedRemoval(): Promise<void> {
  await withRoot(async (root) => {
    const staging = new WorkspaceOperationStaging({
      dataRoot: root,
      completionLookup: async () => ({ ...identity, status: 'completed' as const }),
    });
    await staging.stage(stageInput);
    const parent = path.join(root, 'workspace-operation-staging');
    await fs.rename(path.join(parent, operationId),
      path.join(parent, `.completed-${operationId}-${randomUUID()}`));
    await staging.removeCompleted(identity);
    assert.deepEqual((await fs.readdir(parent)).filter((name) => name.startsWith('.completed-')), []);
  });
}

async function testAuthoritativeDocumentFenceSurvivesInodeSwap(): Promise<void> {
  await withRoot(async (root) => {
    const activePreflight: WorkspaceLinkWritePreflight = {
      planId: preview.planId,
      sources: [{ ...linkPreflight.sources[0]!, documentId: 'document-123', mode: 'active-yjs' }],
    };
    const staging = new WorkspaceOperationStaging({ dataRoot: root });
    const staged = await staging.stage({ ...stageInput, linkPreflight: activePreflight });
    assert.equal(staged.linkPreflight?.sources[0]?.documentId, 'document-123');
    const workspaceFile = path.join(root, 'workspace-notes.md');
    await fs.writeFile(workspaceFile, original);
    const oldInode = (await fs.stat(workspaceFile)).ino;
    const checkpoint = path.join(root, 'checkpoint-notes.md');
    await fs.writeFile(checkpoint, original);
    await fs.rename(checkpoint, workspaceFile);
    assert.notEqual((await fs.stat(workspaceFile)).ino, oldInode, 'atomic checkpoint replaces the file inode');
    const restarted = new WorkspaceOperationStaging({ dataRoot: root });
    assert.deepEqual((await restarted.load(identity)).linkPreflight, activePreflight,
      'recovery retains the document ID and mode independently of a file inode');
    await assert.rejects(staging.stage({ ...stageInput, linkPreflight: {
      ...activePreflight, sources: [{ ...activePreflight.sources[0]!, documentId: 'different-document' }],
    } }), (error: unknown) => error instanceof WorkspaceOperationStagingError && error.code === 'STAGE_CONFLICT');

    const manifestPath = path.join(root, 'workspace-operation-staging', operationId, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      linkPreflight: WorkspaceLinkWritePreflight;
      payloadSha256: string;
    };
    manifest.linkPreflight.sources[0]!.documentId = 'tampered-document';
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(restarted.load(identity), (error: unknown) =>
      error instanceof WorkspaceOperationStagingError && error.code === 'CORRUPT_STAGE',
      'the manifest hash covers the saved authoritative document identity');
    const { payloadSha256: ignored, ...payload } = manifest;
    void ignored;
    manifest.linkPreflight.sources[0]!.mode = 'plain-file';
    manifest.payloadSha256 = hash(JSON.stringify(payload));
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(restarted.load(identity), (error: unknown) =>
      error instanceof WorkspaceOperationStagingError && error.code === 'CORRUPT_STAGE',
      'mode and document ID must remain coherent even with a recomputed manifest hash');
  });
}

async function main(): Promise<void> {
  await testMultiDocumentPlanId();
  await testStageAndRestart();
  await testRejectsMismatchAndCorruption();
  await testRehashedManifestCannotReuseOldPlanId();
  await testRejectsSymlinks();
  await testCleanupAfterInterruptedRemoval();
  await testAuthoritativeDocumentFenceSurvivesInodeSwap();
  console.log('workspace-operation-staging-test: ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
