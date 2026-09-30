import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import {
  FileWatcherService,
  type FileEvent,
} from '../app/lib/filesystem/file-watcher';
import { getCachedFileReferenceEntries } from '../app/lib/filesystem/file-reference-cache';
import { buildFileTreeCacheKey, fileTreeCache } from '../app/lib/utils/file-tree-cache';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

function createWorkspace(workspaceId: string, rootPath: string): WorkspaceContext {
  return {
    workspaceId,
    workspaceType: 'personal',
    rootPath,
    organizationId: null,
    ownerUserId: null,
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

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(predicate(), true, message);
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-file-watcher-'));
  const workspaceA = createWorkspace('workspace-a', path.join(root, 'a'));
  const workspaceB = createWorkspace('workspace-b', path.join(root, 'b'));
  const service = new FileWatcherService();
  const eventsA: FileEvent[] = [];
  const eventsB: FileEvent[] = [];

  try {
    service.subscribe({
      id: 'client-a',
      workspaceId: workspaceA.workspaceId,
      workspace: workspaceA,
      send: (event) => eventsA.push(event),
    });
    service.subscribe({
      id: 'client-b',
      workspaceId: workspaceB.workspaceId,
      workspace: workspaceB,
      send: (event) => eventsB.push(event),
    });
    await service.subscribeDir('client-a', '.');

    const cacheKeyA = buildFileTreeCacheKey('.', 0, workspaceA.workspaceId, false);
    const cacheKeyB = buildFileTreeCacheKey('.', 0, workspaceB.workspaceId, false);
    fileTreeCache.set(cacheKeyA, []);
    fileTreeCache.set(cacheKeyB, []);

    service.publishMutation({
      workspace: workspaceA,
      type: 'add',
      relativePath: 'docs/generated.md',
    });

    assert.equal(eventsA.length, 1, 'workspace A client should receive its own mutation');
    assert.equal(eventsA[0].workspaceId, workspaceA.workspaceId);
    assert.equal(eventsA[0].relativePath, 'docs/generated.md');
    assert.equal(eventsB.length, 0, 'workspace B client must not receive workspace A mutations');
    assert.equal(fileTreeCache.get(cacheKeyA), undefined, 'workspace A tree cache should be invalidated');
    assert.deepEqual(fileTreeCache.get(cacheKeyB), [], 'workspace B tree cache must stay intact');

    service.publishMutation({
      workspace: workspaceB,
      type: 'change',
      relativePath: 'notes/current.md',
    });

    assert.equal(eventsA.length, 1, 'workspace A client must not receive workspace B mutations');
    assert.equal(eventsB.length, 1, 'workspace B client should receive its own mutation');
    assert.equal(eventsB[0].workspaceId, workspaceB.workspaceId);

    service.publishMutation({
      workspace: workspaceA,
      type: 'addDir',
      relativePath: '.canvas-skill-drafts',
    });
    service.publishMutation({
      workspace: workspaceA,
      type: 'change',
      relativePath: '.canvas-skill-drafts/draft-id/package/SKILL.md',
    });
    assert.equal(eventsA.length, 1, 'draft namespace mutations must stay hidden from live clients');

    const draftRoot = path.join(workspaceA.rootPath, '.canvas-skill-drafts');
    const draftSkillFile = path.join(draftRoot, 'native-test', 'private-skill', 'SKILL.md');
    assert.deepEqual(service.getSubscribedDirs(workspaceA.workspaceId), ['.'], 'root watcher should be subscribed before native event assertions');
    await mkdir(path.dirname(draftSkillFile), { recursive: true });
    await writeFile(draftSkillFile, '# private draft\n', 'utf-8');
    await writeFile(path.join(workspaceA.rootPath, 'visible.txt'), 'visible\n', 'utf-8');
    await waitFor(
      () => eventsA.some((event) => event.relativePath === 'visible.txt'),
      `normal workspace filesystem events should still be delivered; got ${JSON.stringify(eventsA)}`,
    );
    assert.equal(eventsA.some((event) => event.relativePath.startsWith('.canvas-skill-drafts')), false);
    await service.subscribeDir('client-a', '.canvas-skill-drafts/native-test/private-skill');
    await writeFile(draftSkillFile, '# changed private draft\n', 'utf-8');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(eventsA.some((event) => event.relativePath.startsWith('.canvas-skill-drafts')), false, 'native root and subscribed draft events should be suppressed');

    const references = await getCachedFileReferenceEntries(true, { workspace: workspaceA });
    assert.equal(references.some((entry) => entry.path.startsWith('.canvas-skill-drafts/')), false, 'file search references must omit draft resources');
    assert.equal(references.some((entry) => entry.path === 'visible.txt'), true, 'file search still returns normal workspace files');

    await rm(draftRoot, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(eventsA.some((event) => event.relativePath === '.canvas-skill-drafts'), false, 'removing the hidden root must not publish an unlinkDir event');
  } finally {
    service.stop();
    await rm(root, { recursive: true, force: true });
  }

  console.log('file-watcher-service-test: ok');
}

void main();
