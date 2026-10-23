import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import type * as Finalizer from '../app/lib/files/workspace-operation-copy-view-finalizer';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

// Real finalizer body; the existing cache/event boundary is an explicit spy.
// Private owner facts and real COMMIT semantics are tested separately in PG.
async function finalizerHarness() {
  const file = path.resolve('app/lib/files/workspace-operation-copy-view-finalizer.ts'), load = createRequire(file);
  const calls: unknown[] = [], finalizerModule = { exports: {} as typeof Finalizer };
  const code = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  new Function('require', 'module', 'exports', code)((name: string) => {
    if (name === 'server-only') return {};
    if (name === '../api/route-helpers') return { invalidateWorkspaceFileViews: (value: unknown) => { calls.push(value); } };
    return load(name);
  }, finalizerModule, finalizerModule.exports);
  const workspace: WorkspaceContext = { workspaceId: 'actual-destination-selector', workspaceType: 'team', rootPath: '/declared/destination',
    rootRelativePath: 'declared/destination', organizationId: 'org', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canManageWorkspace: false, canCreatePublicLinks: false, canRunAgent: false } };
  const fileOptions = { workspace, mutationActorUserId: 'member' };
  return { calls, workspace, fileOptions, run: finalizerModule.exports.finalizeWorkspaceNativeCopyViews };
}
test('published file, folder and parent facts use the existing full target-tree/reference invalidation and exact events', async () => {
  const h = await finalizerHarness();
  const entries = [{ path: 'new', type: 'addDir' }, { path: 'new/folder', type: 'addDir' }, { path: 'new/folder/note.md', type: 'add' }] as const;
  h.run({ fileOptions: h.fileOptions, outcome: { kind: 'published', destinationWorkspaceId: h.workspace.workspaceId, entries } });
  assert.deepEqual(h.calls, [{ fileOptions: h.fileOptions, fullTree: true, mutations: entries }]);
  assert.notEqual((h.calls[0] as { mutations: readonly object[] }).mutations[0], entries[0], 'Notification rows are copied at the boundary.');
});
test('historical completion refreshes the same target views with no invented addition', async () => {
  const h = await finalizerHarness();
  h.run({ fileOptions: h.fileOptions, outcome: { kind: 'historical', destinationWorkspaceId: h.workspace.workspaceId } });
  assert.deepEqual(h.calls, [{ fileOptions: h.fileOptions, fullTree: true, mutations: [] }]);
});
test('foreign workspace options cannot redirect a private Copy view fact', async () => {
  const h = await finalizerHarness();
  assert.throws(() => h.run({ fileOptions: h.fileOptions,
    outcome: { kind: 'published', destinationWorkspaceId: 'foreign-source', entries: [{ path: 'note.md', type: 'add' }] } }));
  assert.deepEqual(h.calls, []);
});
test('missing destination context fails before global cache invalidation', async () => {
  const h = await finalizerHarness();
  assert.throws(() => h.run({ fileOptions: {}, outcome: { kind: 'historical', destinationWorkspaceId: h.workspace.workspaceId } }));
  assert.deepEqual(h.calls, []);
});
