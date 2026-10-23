import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileWatcherService, type FileEvent } from '../app/lib/filesystem/file-watcher';
import { buildFileTreeCacheKey, fileTreeCache } from '../app/lib/utils/file-tree-cache';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(predicate(), true, 'the actual filesystem watcher must deliver the event');
}

async function fixture(classify: (input: { workspace: WorkspaceContext; event: FileEvent }) => Promise<FileEvent>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-native-projection-events-'));
  const workspace: WorkspaceContext = { workspaceId: 'native-projection-events', workspaceType: 'personal',
    rootPath: root, legacy: false, permissions: { canRead: true, canWrite: true, canDelete: true,
      canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
  const service = new FileWatcherService({ classifyFilesystemEvent: classify });
  const events: FileEvent[] = [];
  const subscribe = (id: string) => service.subscribe({ id, workspaceId: workspace.workspaceId, workspace,
    send: event => events.push(event) });
  const close = subscribe('original'); await service.subscribeDir('original', '.');
  return { root, workspace, service, events, close, subscribe,
    async cleanup() { service.stop(); await rm(root, { recursive: true, force: true }); } };
}

test('a native logical birth is not repeated by late first projection, replacement or removal', { timeout: 5_000 }, async () => {
  const f = await fixture(async ({ workspace, event }) => {
    assert.equal(workspace.workspaceId, 'native-projection-events');
    if (event.relativePath !== 'native.txt') return event;
    const { fileVersion: _physicalVersion, ...native } = event;
    return { ...native, type: 'change' };
  });
  try {
    f.service.publishMutation({ workspace: f.workspace, type: 'add', relativePath: 'native.txt' });
    assert.equal(f.events.filter(event => event.type === 'add').length, 1);
    await writeFile(path.join(f.root, 'native.txt'), 'first projection');
    await waitFor(() => f.events.length > 1);
    assert.equal(f.events.filter(event => event.relativePath === 'native.txt' && event.type === 'add').length, 1);
    assert(f.events.slice(1).filter(event => event.relativePath === 'native.txt')
      .every(event => event.type === 'change' && event.fileVersion === undefined));
    let before = f.events.length;
    await writeFile(path.join(f.root, '.replacement'), 'new projection');
    await rename(path.join(f.root, '.replacement'), path.join(f.root, 'native.txt'));
    await waitFor(() => f.events.slice(before).some(event => event.relativePath === 'native.txt'));
    before = f.events.length;
    await unlink(path.join(f.root, 'native.txt'));
    await waitFor(() => f.events.slice(before).some(event => event.relativePath === 'native.txt'));
    assert.deepEqual(f.events.filter(event => event.relativePath === 'native.txt').map(event => event.type),
      ['add', ...f.events.filter(event => event.relativePath === 'native.txt').slice(1).map(() => 'change')]);
  } finally { await f.cleanup(); }
});

test('ordinary physical file births and deletions retain their event types', { timeout: 5_000 }, async () => {
  const f = await fixture(async ({ event }) => event);
  try {
    await writeFile(path.join(f.root, 'asset.pdf'), 'ordinary asset bytes');
    await waitFor(() => f.events.some(event => event.relativePath === 'asset.pdf' && event.type === 'add'));
    await unlink(path.join(f.root, 'asset.pdf'));
    await waitFor(() => f.events.some(event => event.relativePath === 'asset.pdf' && event.type === 'unlink'));
  } finally { await f.cleanup(); }
});

test('an authority result from a closed watcher cannot leak into its replacement subscription', { timeout: 5_000 }, async () => {
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async ({ event }) => { reached(); await pending; return event; });
  try {
    await writeFile(path.join(f.root, 'held.txt'), 'held'); await entered;
    f.close(); const closeNew = f.subscribe('replacement'); await f.service.subscribeDir('replacement', '.');
    release();
    // Ordered behind the classifier continuation; this probe is a real service mutation.
    await new Promise(resolve => setImmediate(resolve));
    f.service.publishMutation({ workspace: f.workspace, type: 'change', relativePath: 'live-probe.txt' });
    assert.deepEqual(f.events.map(event => event.relativePath), ['live-probe.txt']); closeNew();
  } finally { release(); await f.cleanup(); }
});

test('authority failures refresh caches without inventing a file birth or deletion', { timeout: 5_000 }, async () => {
  const f = await fixture(async () => { throw new Error('private namespace diagnostic'); });
  const warnings: unknown[][] = [], originalWarn = console.warn;
  const key = buildFileTreeCacheKey('.', 0, f.workspace.workspaceId, false);
  try {
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    fileTreeCache.set(key, []);
    await writeFile(path.join(f.root, 'uncertain.md'), 'uncertain projection');
    await waitFor(() => warnings.length > 0);
    assert.deepEqual(f.events, []);
    assert.equal(fileTreeCache.get(key), undefined);
    assert(warnings.every(args => JSON.stringify(args) === '["[FileWatcher]",{"code":"FILESYSTEM_AUTHORITY_UNAVAILABLE"}]'));
  } finally { console.warn = originalWarn; await f.cleanup(); }
});
