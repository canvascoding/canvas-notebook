import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import {
  FileWatcherService,
  type FileEvent,
} from '../app/lib/filesystem/file-watcher';
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
  } finally {
    service.stop();
    await rm(root, { recursive: true, force: true });
  }

  console.log('file-watcher-service-test: ok');
}

void main();
