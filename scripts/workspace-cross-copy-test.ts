import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

import { summarizeWorkspaceBatchResult } from '@/app/lib/files/operation-flows';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

function createWorkspaceContext(rootPath: string, workspaceId: string, type: WorkspaceContext['workspaceType']): WorkspaceContext {
  return {
    workspaceId,
    workspaceType: type,
    rootPath,
    rootRelativePath: path.basename(rootPath),
    displayName: workspaceId,
    status: 'active',
    organizationId: 'org_test',
    ownerUserId: type === 'personal' ? 'user_test' : null,
    permissions: {
      canRead: true,
      canWrite: true,
      canDelete: true,
      canCreatePublicLinks: true,
      canManageWorkspace: true,
      canRunAgent: true,
    },
    legacy: false,
  };
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-workspace-cross-copy-'));
  const previousData = process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATA_ROOT = tempRoot;
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  let guardDepth = 0;
  let activePath: { workspaceId: string; path: string } | null = null;
  const initialized: string[] = [];
  internals._load = (request, parent, isMain) => {
    if (request === '@/app/lib/files/workspace-file-lifecycle-guard') return {
      withWorkspaceFileLifecycleGuards: async (scopes: Array<{ workspaceId: string; paths: string[] }>, work: () => Promise<unknown>) => {
        if (activePath && scopes.some((scope) => scope.workspaceId === activePath!.workspaceId
          && scope.paths.some((candidate) => candidate === activePath!.path || activePath!.path.startsWith(candidate + '/')))) {
          throw Object.assign(new Error('busy'), { status: 409, code: 'COLLABORATION_FILE_LIFECYCLE_BUSY' });
        }
        guardDepth += 1;
        try { return await work(); } finally { guardDepth -= 1; }
      },
    };
    if (request === '@/app/lib/files/collaboration-policy' || request === path.resolve('app/lib/files/collaboration-policy.ts')) return {
      assertNoActiveOfficeLeases: async () => {},
      initializeCopiedFileCollaborationPaths: async (input: { paths: string[] }) => {
        assert.equal(guardDepth, 1, 'copied metadata is finalized before the actual target guard is released');
        initialized.push(...input.paths);
      },
    };
    return originalLoad(request, parent, isMain);
  };
  try {
    const { batchCopy, batchCopyBetweenWorkspaces, copyFileBetweenWorkspaces } = await import('../app/lib/filesystem/workspace-files');
    const sourceRoot = path.join(tempRoot, 'personal');
    const targetRoot = path.join(tempRoot, 'team');
    await mkdir(path.join(sourceRoot, 'docs', 'nested'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'docs', 'other'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'imports'), { recursive: true });
    await mkdir(path.join(targetRoot, 'imports'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'docs', 'nested', 'a.txt'), 'alpha\n');
    await writeFile(path.join(sourceRoot, 'docs', 'other', 'a.txt'), 'second alpha\n');
    await writeFile(path.join(sourceRoot, 'docs', 'b.txt'), 'beta\n');
    await writeFile(path.join(targetRoot, 'imports', 'b.txt'), 'existing\n');

    const source = createWorkspaceContext(sourceRoot, 'ws_personal', 'personal');
    const target = createWorkspaceContext(targetRoot, 'ws_team', 'team');

    const result = await batchCopyBetweenWorkspaces(
      ['docs/b.txt', 'docs/nested'],
      'imports',
      false,
      true,
      { source: { workspace: source }, target: { workspace: target } }
    );

    assert.deepEqual(result.failed, []);
    assert.equal(result.skipped.length, 0);
    assert.ok(result.copied.includes('imports/b (1).txt'));
    assert.ok(result.copied.includes('imports/nested'));
    assert.equal(await readFile(path.join(targetRoot, 'imports', 'b (1).txt'), 'utf8'), 'beta\n');
    assert.equal(await readFile(path.join(targetRoot, 'imports', 'nested', 'a.txt'), 'utf8'), 'alpha\n');
    assert.equal(await readFile(path.join(sourceRoot, 'docs', 'b.txt'), 'utf8'), 'beta\n');
    assert.deepEqual(result.collaborationInitializedPaths?.sort(), result.copied.slice().sort());
    assert.ok(initialized.includes('imports/b (1).txt'));

    // An unrelated open file must not prevent a closed file from being copied
    // to a new top-level target. The collision name is chosen by shipped code.
    await writeFile(path.join(targetRoot, 'sentinel.txt'), 'unrelated live bytes');
    activePath = { workspaceId: target.workspaceId, path: 'sentinel.txt' };
    const sentinelCopy = await copyFileBetweenWorkspaces('docs/b.txt', '.', false, true,
      { source: { workspace: source }, target: { workspace: target } });
    assert.equal(sentinelCopy.copied, 'b.txt');
    activePath = { workspaceId: target.workspaceId, path: 'b.txt' };
    const collisionCopy = await copyFileBetweenWorkspaces('docs/b.txt', '.', false, true,
      { source: { workspace: source }, target: { workspace: target } });
    assert.equal(collisionCopy.copied, 'b (1).txt', 'an occupied live basename is untouched when copying with a new name');
    await assert.rejects(() => copyFileBetweenWorkspaces('docs/b.txt', '.', true, false,
      { source: { workspace: source }, target: { workspace: target } }), { code: 'COLLABORATION_FILE_LIFECYCLE_BUSY' });
    assert.equal(await readFile(path.join(targetRoot, 'b.txt'), 'utf8'), 'beta\n');
    assert.equal(await readFile(path.join(targetRoot, 'sentinel.txt'), 'utf8'), 'unrelated live bytes');
    activePath = null;

    const traversalResult = await batchCopyBetweenWorkspaces(
      ['../outside.txt'],
      'imports',
      false,
      true,
      { source: { workspace: source }, target: { workspace: target } }
    );
    assert.equal(traversalResult.copied.length, 0);
    assert.equal(traversalResult.failed.length, 1);

    const nestedSelectionResult = await batchCopy(
      ['docs', 'docs/nested', 'docs/b.txt'],
      'imports',
      false,
      true,
      { workspace: source }
    );
    assert.deepEqual(nestedSelectionResult.failed, []);
    assert.deepEqual(nestedSelectionResult.skipped, []);
    assert.deepEqual(nestedSelectionResult.copied, ['imports/docs']);
    assert.equal(await readFile(path.join(sourceRoot, 'imports', 'docs', 'nested', 'a.txt'), 'utf8'), 'alpha\n');

    const partialResult = await batchCopy(
      ['docs/b.txt', '../outside.txt'],
      'imports',
      false,
      true,
      { workspace: source }
    );
    assert.equal(partialResult.copied.length, 1);
    assert.equal(partialResult.failed.length, 1);
    assert.equal(partialResult.skipped.length, 0);
    assert.deepEqual(summarizeWorkspaceBatchResult(partialResult), {
      copiedCount: 1,
      unresolvedCount: 1,
      hasUnresolved: true,
      hasCopied: true,
    });

    const sameNameResult = await batchCopy(
      ['docs/nested/a.txt', 'docs/other/a.txt'],
      'imports',
      false,
      true,
      { workspace: source }
    );
    assert.deepEqual(sameNameResult.failed, []);
    assert.ok(sameNameResult.copied.includes('imports/a.txt'));
    assert.ok(sameNameResult.copied.includes('imports/a (1).txt'));
    assert.equal(await readFile(path.join(sourceRoot, 'imports', 'a.txt'), 'utf8'), 'alpha\n');
    assert.equal(await readFile(path.join(sourceRoot, 'imports', 'a (1).txt'), 'utf8'), 'second alpha\n');

    const selfCopyResult = await batchCopy(
      ['docs'],
      'docs/nested',
      false,
      true,
      { workspace: source }
    );
    assert.equal(selfCopyResult.copied.length, 0);
    assert.equal(selfCopyResult.failed.length, 1);
    assert.match(selfCopyResult.failed[0]?.error ?? '', /Cannot copy a directory into itself/);

    console.log('workspace-cross-copy-test passed');
  } finally {
    internals._load = originalLoad;
    if (previousData === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousData;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
