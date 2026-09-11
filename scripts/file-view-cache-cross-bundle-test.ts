import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import ts from 'typescript';
import type { FileNode } from '../app/lib/files/types';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

type TreeModule = typeof import('../app/lib/utils/file-tree-cache');
type ReferenceModule = typeof import('../app/lib/filesystem/file-reference-cache');
type WatcherModule = typeof import('../app/lib/filesystem/file-watcher');

/** Execute two independent compiled modules, as Next and the custom server do. */
async function compile<T>(file: string, mocks: Record<string, unknown> = {}): Promise<T> {
  const filename = path.resolve(file);
  const load = createRequire(filename);
  const exports = {};
  const compiled = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  new Function('require', 'module', 'exports', 'setInterval', 'clearInterval', compiled)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports,
    () => ({ unref() {} }), () => undefined,
  );
  return exports as T;
}
const node = (name: string): FileNode => ({ name, path: name, type: 'file', size: 1 });
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
function workspace(): WorkspaceContext {
  return { workspaceId: `cache-bundle-${randomUUID()}`, workspaceType: 'personal', rootPath: '/synthetic-cache-fixture',
    ownerUserId: null, organizationId: null, legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canManageWorkspace: true,
      canCreatePublicLinks: true, canRunAgent: true } };
}
async function modules(listDirectory: () => Promise<FileNode[]>) {
  const a = { tree: await compile<TreeModule>('app/lib/utils/file-tree-cache.ts'),
    references: await compile<ReferenceModule>('app/lib/filesystem/file-reference-cache.ts', { './workspace-files': { listDirectory } }) };
  const b = { tree: await compile<TreeModule>('app/lib/utils/file-tree-cache.ts'),
    references: await compile<ReferenceModule>('app/lib/filesystem/file-reference-cache.ts', { './workspace-files': { listDirectory } }) };
  const watcherModule = await compile<WatcherModule>('app/lib/filesystem/file-watcher.ts', {
    '@/app/lib/utils/file-tree-cache': b.tree,
    '@/app/lib/filesystem/file-reference-cache': b.references,
    '@/app/lib/filesystem/workspace-files': {
      validatePath: (relativePath: string, options: { workspace: WorkspaceContext }) => path.join(options.workspace.rootPath, relativePath),
    },
    '@/app/lib/collaboration/presence': {},
  });
  return { a, b, watcher: new watcherModule.FileWatcherService() };
}

test('the actual watcher invalidation reaches an HTTP tree cache in a separately compiled bundle', async () => {
  const fixture = await modules(async () => [node('before.md')]);
  const scope = workspace(); const other = workspace();
  const key = fixture.a.tree.buildFileTreeCacheKey('.', 0, scope.workspaceId, false);
  const otherKey = fixture.a.tree.buildFileTreeCacheKey('.', 0, other.workspaceId, false);
  try {
    for (const bundle of [fixture.a, fixture.b]) {
      bundle.tree.fileTreeCache.set(key, [node('before.md')]);
      bundle.tree.fileTreeCache.set(otherKey, [node('other-workspace.md')]);
    }
    fixture.watcher.publishMutation({ workspace: scope, type: 'change', relativePath: 'after.md' });
    assert.equal(fixture.b.tree.fileTreeCache.get(key), undefined, 'the watcher bundle itself is invalidated');
    assert.equal(fixture.a.tree.fileTreeCache.get(key), undefined,
      'the separately compiled HTTP cache must not retain the old tree for its five-minute TTL');
    assert.deepEqual(fixture.a.tree.fileTreeCache.get(otherKey), [node('other-workspace.md')]);
  } finally {
    fixture.watcher.stop();
    for (const bundle of [fixture.a, fixture.b]) {
      bundle.tree.clearFileTreeCache(scope.workspaceId); bundle.tree.clearFileTreeCache(other.workspaceId);
    }
  }
});

test('the actual watcher invalidation reaches a separately compiled file-reference cache', async () => {
  let names = [node('before.md')];
  const fixture = await modules(async () => names);
  const scope = workspace(); const options = { workspace: scope };
  try {
    assert.equal((await fixture.a.references.getCachedFileReferenceEntries(false, options))[0].path, 'before.md');
    assert.equal((await fixture.b.references.getCachedFileReferenceEntries(false, options))[0].path, 'before.md');
    names = [node('after.md')];
    fixture.watcher.publishMutation({ workspace: scope, type: 'change', relativePath: 'after.md' });
    assert.equal((await fixture.b.references.getCachedFileReferenceEntries(false, options))[0].path, 'after.md');
    assert.equal((await fixture.a.references.getCachedFileReferenceEntries(false, options))[0].path, 'after.md',
      'an HTTP reference lookup must not reuse its old bundle-local snapshot after the watcher invalidates');
  } finally {
    fixture.watcher.stop();
    for (const bundle of [fixture.a, fixture.b]) bundle.references.invalidateFileReferenceCache(options);
  }
});

test('a reference build invalidated in flight cannot overwrite a newer completed snapshot', async () => {
  const scope = workspace(); const options = { workspace: scope };
  let releaseOld!: (entries: FileNode[]) => void;
  let calls = 0;
  const references = await compile<ReferenceModule>('app/lib/filesystem/file-reference-cache.ts', {
    './workspace-files': { listDirectory: async () => ++calls === 1
      ? new Promise<FileNode[]>((resolve) => { releaseOld = resolve; }) : [node('after.md')] },
  });
  try {
    const old = references.getCachedFileReferenceEntries(false, options); await flush();
    references.invalidateFileReferenceCache(options);
    assert.equal((await references.getCachedFileReferenceEntries(false, options))[0].path, 'after.md');
    releaseOld([node('before.md')]);
    assert.equal((await old)[0].path, 'before.md', 'existing readers may finish with their original snapshot');
    assert.equal((await references.getCachedFileReferenceEntries(false, options))[0].path, 'after.md',
      'the invalidated build must not replace the fresh cached result');
  } finally { releaseOld?.([]); references.invalidateFileReferenceCache(options); }
});

test('an invalidated build completion cannot remove the newer pending build from deduplication', async () => {
  const scope = workspace(); const options = { workspace: scope };
  const releases: Array<(entries: FileNode[]) => void> = [];
  const references = await compile<ReferenceModule>('app/lib/filesystem/file-reference-cache.ts', {
    './workspace-files': { listDirectory: async () => new Promise<FileNode[]>((resolve) => releases.push(resolve)) },
  });
  try {
    const old = references.getCachedFileReferenceEntries(false, options); await flush();
    references.invalidateFileReferenceCache(options);
    const fresh = references.getCachedFileReferenceEntries(false, options); await flush();
    assert.equal(releases.length, 2);
    releases[0]([node('before.md')]); await old;
    const joined = references.getCachedFileReferenceEntries(true, options); await flush();
    assert.equal(releases.length, 2, 'the obsolete finally handler must not erase a different pending build');
    releases[1]([node('after.md')]);
    assert.equal(await joined, await fresh);
  } finally {
    for (const resolve of releases) resolve([]);
    await flush(); references.invalidateFileReferenceCache(options);
  }
});

test('separate bundles share in-flight reference work while keeping workspaces isolated', async () => {
  const scope = workspace(); const options = { workspace: scope };
  const other = workspace(); const otherOptions = { workspace: other };
  const releases: Array<(entries: FileNode[]) => void> = [];
  const fixture = await modules(async () => new Promise<FileNode[]>((resolve) => releases.push(resolve)));
  try {
    const a = fixture.a.references.getCachedFileReferenceEntries(false, options); await flush();
    const b = fixture.b.references.getCachedFileReferenceEntries(true, options); await flush();
    assert.equal(releases.length, 1, 'both bundles share the same pending workspace read');
    const unrelated = fixture.a.references.getCachedFileReferenceEntries(false, otherOptions); await flush();
    assert.equal(releases.length, 2, 'a different workspace has its own read');
    releases[0]([node('shared.md')]); releases[1]([node('other.md')]);
    assert.equal(await a, await b);
    assert.equal((await unrelated)[0].path, 'other.md');
    fixture.watcher.publishMutation({ workspace: scope, type: 'unlink', relativePath: 'shared.md' });
    assert.equal((await fixture.b.references.getCachedFileReferenceEntries(false, otherOptions))[0].path, 'other.md');
    assert.equal(releases.length, 2, 'workspace invalidation keeps the unrelated cache');
  } finally {
    fixture.watcher.stop();
    for (const resolve of releases) resolve([]);
    await flush();
    fixture.a.references.invalidateFileReferenceCache(options);
    fixture.a.references.invalidateFileReferenceCache(otherOptions);
  }
});

test('an obsolete failed build cannot erase a fresh pending read in another bundle', async () => {
  const scope = workspace(); const options = { workspace: scope };
  const builds: Array<{ resolve: (entries: FileNode[]) => void; reject: (error: Error) => void }> = [];
  const fixture = await modules(async () => new Promise<FileNode[]>((resolve, reject) => builds.push({ resolve, reject })));
  try {
    const oldError = new Error('original directory read failed');
    const old = fixture.a.references.getCachedFileReferenceEntries(false, options);
    const failed = assert.rejects(old, (error) => error === oldError);
    await flush();
    fixture.b.references.invalidateFileReferenceCache(options);
    const fresh = fixture.b.references.getCachedFileReferenceEntries(false, options); await flush();
    builds[0].reject(oldError); await failed;
    const joined = fixture.a.references.getCachedFileReferenceEntries(false, options); await flush();
    assert.equal(builds.length, 2, 'a failed obsolete finally must preserve the fresh shared promise');
    builds[1].resolve([node('fresh.md')]);
    assert.equal(await joined, await fresh);
    assert.equal((await fixture.a.references.getCachedFileReferenceEntries(false, options))[0].path, 'fresh.md');
  } finally {
    fixture.watcher.stop();
    for (const build of builds) build.resolve([]);
    await flush(); fixture.a.references.invalidateFileReferenceCache(options);
  }
});
