import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

type WatcherModule = typeof import('../app/lib/filesystem/file-watcher');
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

/** Actual service code, with only directory I/O held at its two asynchronous boundaries. */
async function fixture(gate: 1 | 2) {
  let release: (() => void) | undefined;
  let statCalls = 0;
  let watches = 0;
  let closed = 0;
  const filesystem = {
    promises: {
      mkdir: async () => undefined,
      realpath: async (value: string) => value,
      stat: async () => {
        if (++statCalls === gate) await new Promise<void>(resolve => { release = resolve; });
        return { isDirectory: () => true };
      },
    },
    watch: () => {
      watches++;
      return { close: () => { closed++; } };
    },
  };
  const mocks: Record<string, unknown> = {
    fs: filesystem,
    '@/app/lib/collaboration/presence': {},
    '@/app/lib/utils/file-tree-cache': {},
    '@/app/lib/filesystem/file-reference-cache': {},
    '@/app/lib/filesystem/workspace-files': {
      validatePath: (value: string, options: { workspace: WorkspaceContext }) => path.join(options.workspace.rootPath, value),
    },
  };
  const filename = path.resolve('app/lib/filesystem/file-watcher.ts');
  const load = createRequire(filename);
  const exports = {};
  const compiled = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  new Function('require', 'module', 'exports', 'setInterval', 'clearInterval', compiled)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports,
    () => ({ unref() {} }), () => undefined,
  );
  const service = new (exports as WatcherModule).FileWatcherService();
  const workspace: WorkspaceContext = {
    workspaceId: 'lifecycle-fixture', workspaceType: 'personal', rootPath: '/synthetic-lifecycle-fixture', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true,
      canManageWorkspace: true, canRunAgent: true },
  };
  return {
    service, workspace,
    subscribe(id: string) { return service.subscribe({ id, workspaceId: workspace.workspaceId, workspace, send() {} }); },
    release() { assert.ok(release, 'the real service reached the selected filesystem boundary'); release(); },
    counts: () => ({ watches, closed }),
    async cleanup() { service.stop(); release?.(); await flush(); service.stop(); },
  };
}

for (const gate of [1, 2] as const) {
  test(`closing a client during ${gate === 1 ? 'directory validation' : 'watcher startup'} cannot resurrect its subscription`, async () => {
    const f = await fixture(gate);
    try {
      const close = f.subscribe('first'); await flush();
      close(); f.release(); await flush();
      assert.deepEqual(f.service.getSubscribedDirs(f.workspace.workspaceId), []);
      assert.deepEqual(f.counts(), { watches: 0, closed: 0 }, 'no owner means no native watcher');
    } finally { await f.cleanup(); }
  });
}

test('an obsolete startup cannot overwrite a replacement subscription and leak its native watcher', async () => {
  const f = await fixture(2);
  try {
    const closeOld = f.subscribe('old'); await flush(); closeOld();
    const closeNew = f.subscribe('new'); await flush();
    assert.deepEqual(f.counts(), { watches: 1, closed: 0 });
    f.release(); await flush();
    assert.deepEqual(f.counts(), { watches: 1, closed: 0 }, 'the replacement retains its single owned watcher');
    assert.deepEqual(f.service.getSubscribedDirs(f.workspace.workspaceId), ['.']);
    closeNew();
    assert.deepEqual(f.counts(), { watches: 1, closed: 1 });
    assert.deepEqual(f.service.getSubscribedDirs(f.workspace.workspaceId), []);
  } finally { await f.cleanup(); }
});

test('closing one client preserves a pending shared watcher that still has a live peer', async () => {
  const f = await fixture(2);
  try {
    const closeFirst = f.subscribe('first'); await flush();
    const closePeer = f.subscribe('peer'); await flush(); closeFirst();
    f.release(); await flush();
    assert.deepEqual(f.counts(), { watches: 1, closed: 0 });
    assert.deepEqual(f.service.getSubscribedDirs(f.workspace.workspaceId), ['.']);
    closePeer();
    assert.deepEqual(f.counts(), { watches: 1, closed: 1 });
    assert.deepEqual(f.service.getSubscribedDirs(f.workspace.workspaceId), []);
  } finally { await f.cleanup(); }
});
