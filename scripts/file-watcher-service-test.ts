import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import {
  FileWatcherService,
  type FileEvent,
} from '../app/lib/filesystem/file-watcher';
import { getCachedFileReferenceEntries } from '../app/lib/filesystem/file-reference-cache';
import { buildFileTreeCacheKey, fileTreeCache } from '../app/lib/utils/file-tree-cache';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { getWorkspacePresenceSnapshot, subscribeWorkspacePresence, upsertDocumentPresenceEntry } from '../app/lib/collaboration/presence';
import type { FilePresenceEntry, WorkspacePresenceMessage } from '../app/lib/collaboration/types';

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
  const deadline = Date.now() + 5_000;
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
    await mkdir(workspaceA.rootPath, { recursive: true });
    await mkdir(workspaceB.rootPath, { recursive: true });
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

    const hiddenOld = '.canvas-skill-drafts/native-test/private-skill/SKILL.md';
    const hiddenNew = '.canvas-skill-drafts/native-test/private-skill/renamed.md';
    const mutation = { type: 'rename' as const, operationId: 'draft-rename', workspaceId: workspaceA.workspaceId,
      oldPath: hiddenOld, newPath: hiddenNew };
    const beforeRename = eventsA.length;
    await service.withRename(workspaceA, mutation, () => rename(draftSkillFile, path.join(workspaceA.rootPath, hiddenNew)));
    assert.equal(eventsA.length, beforeRename, 'managed renames within a draft must not broadcast');
    await service.withRename(workspaceA, { ...mutation, operationId: 'draft-export', oldPath: hiddenNew, newPath: 'exported.md' },
      () => rename(path.join(workspaceA.rootPath, hiddenNew), path.join(workspaceA.rootPath, 'exported.md')));
    const exported = eventsA.at(-1)!;
    assert.equal(exported.relativePath, 'exported.md');
    assert.equal(exported.type, 'add');
    assert.equal(exported.mutation, undefined, 'visible add must not expose its hidden source');
    const presence: FilePresenceEntry = { workspaceId: workspaceA.workspaceId, path: 'exported.md', documentId: 'draft-move-document',
      userId: 'agent', actorType: 'agent', sessionId: 'test-session', initiatedByUserId: null, displayName: 'Agent',
      color: '#000', colorLight: '#fff', activity: 'editing', updatedAt: Date.now() };
    upsertDocumentPresenceEntry(presence);
    const presenceMessages: WorkspacePresenceMessage[] = [];
    const unsubscribePresence = subscribeWorkspacePresence(workspaceA.workspaceId, (message) => presenceMessages.push(message));
    await service.withRename(workspaceA, { ...mutation, operationId: 'draft-import', oldPath: 'exported.md', newPath: hiddenNew },
      () => rename(path.join(workspaceA.rootPath, 'exported.md'), path.join(workspaceA.rootPath, hiddenNew)));
    const imported = eventsA.at(-1)!;
    assert.equal(imported.relativePath, 'exported.md');
    assert.equal(imported.type, 'unlink');
    assert.equal(imported.mutation, undefined, 'visible unlink must not expose its hidden destination');
    assert.equal(getWorkspacePresenceSnapshot(workspaceA.workspaceId).entries.length, 0, 'moving into a draft clears visible presence');
    upsertDocumentPresenceEntry({ ...presence, updatedAt: Date.now() + 1 });
    assert.equal(getWorkspacePresenceSnapshot(workspaceA.workspaceId).entries.length, 0, 'late awareness cannot restore presence for a hidden destination');
    assert.equal(presenceMessages.length, 1);
    assert.equal(JSON.stringify(presenceMessages).includes('.canvas-skill-drafts'), false);
    upsertDocumentPresenceEntry({ ...presence, documentId: 'previously-unseen-draft-document', path: hiddenNew });
    assert.equal(getWorkspacePresenceSnapshot(workspaceA.workspaceId).entries.length, 0, 'incoming awareness cannot expose a draft without an earlier presence entry');
    await service.withRename(workspaceA, { ...mutation, operationId: 'draft-reexport', oldPath: hiddenNew, newPath: 'reexported.md' },
      () => rename(path.join(workspaceA.rootPath, hiddenNew), path.join(workspaceA.rootPath, 'reexported.md')));
    upsertDocumentPresenceEntry({ ...presence, updatedAt: Date.now() + 2 });
    assert.equal(getWorkspacePresenceSnapshot(workspaceA.workspaceId).entries[0]?.path, 'reexported.md', 'moving back to a visible path restores the identity for awareness');
    assert.equal(JSON.stringify(presenceMessages).includes('.canvas-skill-drafts'), false);
    unsubscribePresence();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(JSON.stringify(eventsA).includes('.canvas-skill-drafts'), false, 'no live mutation payload may contain a draft path');

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
