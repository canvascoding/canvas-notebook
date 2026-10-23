import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';
import { getFileStats } from '../app/lib/filesystem/workspace-files';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import { Y } from '../app/lib/collaboration/server-runtime';
import { withNativeWorkspaceFileRead } from '../app/lib/collaboration/workspace-native-file-read';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import * as pathGuard from '../app/lib/workspaces/path-guard';
import type * as Route from '../app/api/files/exists/route';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'canvas-native-exists-')); roots.push(rootPath);
  const workspace: WorkspaceContext = { workspaceId: 'native-exists-workspace', organizationId: null, workspaceType: 'personal',
    rootPath, legacy: false, status: 'active', permissions: { canRead: true, canWrite: false, canDelete: false,
      canManageWorkspace: false, canCreatePublicLinks: false, canRunAgent: false } };
  const doc = createPlainTextYDoc('Actual native existence');
  const state: PersistedCollaborationState = { documentId: 'exists-document', workspaceId: workspace.workspaceId, organizationId: null,
    path: 'note.md', representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: 7,
    persistedAt: 123000, checkpointSequence: 7, checkpointedAt: null, canonicalHash: null, serializedHash: null,
    newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
  doc.destroy();
  const controls = { workspace, state: state as PersistedCollaborationState | null, path: state.path, unregistered: false,
    authority: 'initialized' as WorkspaceDocumentCatalogueEntry['authority'], denied: false, limited: false };
  const calls = { active: false, physical: 0, aliases: 0, reads: 0, closes: 0, commands: [] as string[] };
  const filename = path.resolve('app/api/files/exists/route.ts'), require = createRequire(filename);
  const javascript = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const mocks: Record<string, unknown> = {
    '@/app/lib/filesystem/workspace-files': { getFileStats: async (filePath: string) => {
      assert.equal(calls.active, filePath !== '.'); calls.physical++;
      return getFileStats(filePath, { workspace });
    } },
    '@/app/lib/workspaces/path-guard': { ...pathGuard,
      assertWorkspacePathHasNoAliases: async (...args: Parameters<typeof pathGuard.assertWorkspacePathHasNoAliases>) => {
        assert.equal(calls.active, args[1] !== '.'); calls.aliases++; return pathGuard.assertWorkspacePathHasNoAliases(...args);
      } },
    '@/app/lib/utils/rate-limit': { rateLimit: () => controls.limited ? { ok: false, response: NextResponse.json({}, { status: 429 }) } : { ok: true } },
    '@/app/lib/workspaces/request': {
      requireRequestWorkspace: async () => controls.denied ? { response: NextResponse.json({}, { status: 403 }) }
        : { workspace, session: { user: { id: 'exists-reader' } } },
      workspaceFileOptions: () => ({ workspace }),
    },
    '@/app/lib/collaboration/workspace-native-file-read': {
      withNativeWorkspaceFileRead: <T>(input: Parameters<typeof withNativeWorkspaceFileRead>[0], consume: Parameters<typeof withNativeWorkspaceFileRead<T>>[1]) => {
        calls.reads++; assert.equal(input.mode, 'metadata');
        return withNativeWorkspaceFileRead(input, consume, {
          openConnection: async () => ({
            run: async sql => { calls.commands.push(sql);
              if (sql.startsWith('BEGIN')) { assert.equal(calls.active, false); calls.active = true; }
              if (sql === 'COMMIT' || sql === 'ROLLBACK') { assert(calls.active); calls.active = false; }
            },
            get: async sql => { assert(calls.active); assert.match(sql, /pg_advisory_xact_lock_shared/u); return undefined; },
            all: async () => [], close: async () => { assert.equal(calls.active, false); calls.closes++; },
          }),
          readCatalogue: async () => controls.unregistered ? [] : [{
            id: state.documentId, path: controls.path, authority: controls.authority, lifecycle_generation: 1,
          } as WorkspaceDocumentCatalogueEntry],
          loadState: async () => { assert(calls.active); return controls.state; },
        });
      },
    },
  };
  const exports = {} as typeof Route;
  new Function('require', 'exports', javascript)((name: string) => mocks[name] ?? require(name), exports);
  return { controls, calls, exists: () => exports.GET(new NextRequest(`http://localhost/api/files/exists?${new URLSearchParams({ path: controls.path })}`)) };
}

test('native existence remains true after projection unlink, for stale empty projections and renamed suffixes', async () => {
  for (const physical of [false, true]) {
    const f = await fixture(); if (physical) await writeFile(path.join(f.controls.workspace.rootPath, 'note.md'), '');
    const response = await f.exists(); assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.exists, true); assert.equal(data.path, 'note.md'); assert.equal(data.type, 'file');
    assert.equal(data.isDirectory, false); assert.equal(data.isFile, true); assert.deepEqual(data.stats, { modified: 123 });
    assert.equal(f.calls.physical + f.calls.aliases, 0); assert.equal(f.calls.closes, 1); assert.equal(f.calls.commands.at(-1), 'COMMIT');
  }
  const f = await fixture(); f.controls.path = f.controls.state!.path = 'renamed.docx';
  assert.equal((await f.exists()).status, 200); assert.equal(f.calls.physical, 0);
});

test('exact spaced native names remain present without consulting an occupied trimmed neighbor', async () => {
  const f = await fixture(); f.controls.path = f.controls.state!.path = ' native.md ';
  await writeFile(path.join(f.controls.workspace.rootPath, 'native.md'), 'Different physical neighbor');
  const response = await f.exists(); assert.equal(response.status, 200);
  const { data } = await response.json(); assert.equal(data.exists, true); assert.equal(data.path, ' native.md ');
  assert.equal(f.calls.physical + f.calls.aliases, 0);
});

test('missing or foreign initialized state produces a conflict rather than false absence or physical fallback', async () => {
  for (const mode of ['missing-state', 'missing-row', 'foreign'] as const) {
    const f = await fixture();
    if (mode === 'missing-state') f.controls.authority = 'missing-state';
    else if (mode === 'missing-row') f.controls.state = null;
    else f.controls.state!.workspaceId = 'foreign-workspace';
    const response = await f.exists(); assert.equal(response.status, 409);
    const payload = await response.json(); assert.equal(payload.success, false); assert.equal(Object.hasOwn(payload, 'data'), false);
    assert.equal(f.calls.physical + f.calls.aliases, 0); assert.equal(f.calls.commands.at(-1), 'ROLLBACK');
  }
});

test('pristine and unregistered originals retain actual physical existence inside the same read fence', async () => {
  for (const unregistered of [false, true]) {
    const f = await fixture(); f.controls.state = null; f.controls.authority = 'pristine'; f.controls.unregistered = unregistered;
    await writeFile(path.join(f.controls.workspace.rootPath, 'note.md'), 'Physical original');
    const response = await f.exists(); assert.equal(response.status, 200);
    const { data } = await response.json(); assert.equal(data.exists, true); assert.equal(data.stats.size, 17);
    assert.equal(typeof data.stats.permissions, 'string'); assert.equal(f.calls.physical, 1); assert.equal(f.calls.aliases, 1);
    assert.equal(f.calls.commands.at(-1), 'COMMIT');
  }
});

test('physical absence remains false while an outer-space alias cannot select the trimmed original', async () => {
  const f = await fixture(); f.controls.unregistered = true; f.controls.state = null;
  let response = await f.exists(); assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, { exists: false });
  await writeFile(path.join(f.controls.workspace.rootPath, 'note.md'), 'Occupied trimmed original');
  f.controls.path = 'note.md ';
  const physicalBefore = f.calls.physical, aliasesBefore = f.calls.aliases;
  response = await f.exists(); assert.equal(response.status, 409); assert.equal(Object.hasOwn(await response.json(), 'data'), false);
  assert.equal(f.calls.physical, physicalBefore); assert.equal(f.calls.aliases, aliasesBefore);
});

test('exact leading-space Markdown physical existence never selects an occupied trimmed neighbor', async () => {
  const f = await fixture(); f.controls.unregistered = true; f.controls.state = null; f.controls.path = ' note.md';
  const neighbor = path.join(f.controls.workspace.rootPath, 'note.md');
  const exact = path.join(f.controls.workspace.rootPath, f.controls.path);
  const neighborBytes = Buffer.from('The trimmed neighbor must remain unchanged.\n');
  const exactBytes = Buffer.from('Exact leading-space Markdown bytes.\n');
  await writeFile(neighbor, neighborBytes);

  let response = await f.exists(); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { exists: false });
  assert.deepEqual(await readFile(neighbor), neighborBytes);

  await writeFile(exact, exactBytes);
  response = await f.exists(); assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.exists, true); assert.equal(data.path, f.controls.path);
  assert.equal(data.type, 'file'); assert.equal(data.isFile, true); assert.equal(data.isDirectory, false);
  const stats = await getFileStats(f.controls.path, { workspace: f.controls.workspace });
  assert.equal(data.stats.size, exactBytes.length); assert.equal(data.stats.size, stats.size);
  assert.equal(data.stats.modified, stats.modified); assert.equal(data.stats.permissions, stats.permissions);
  assert.deepEqual(await readFile(exact), exactBytes); assert.deepEqual(await readFile(neighbor), neighborBytes);

  await rm(exact);
  response = await f.exists(); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { exists: false });
  assert.deepEqual(await readFile(neighbor), neighborBytes);
  assert.equal(f.calls.closes, 3); assert.equal(f.calls.commands.at(-1), 'ROLLBACK');
});

test('physical folders and the actual root preserve their directory existence contract', async () => {
  const f = await fixture(); f.controls.unregistered = true; f.controls.state = null; f.controls.path = 'folder';
  await mkdir(path.join(f.controls.workspace.rootPath, 'folder'));
  let response = await f.exists(); assert.equal(response.status, 200); assert.equal((await response.json()).data.isDirectory, true);
  const reads = f.calls.reads; f.controls.path = '.';
  response = await f.exists(); assert.equal(response.status, 200); assert.equal((await response.json()).data.isDirectory, true);
  assert.equal(f.calls.reads, reads); assert.equal(f.calls.active, false);
});

test('denied and rate-limited requests never begin a native or physical existence read', async () => {
  const f = await fixture(); f.controls.denied = true;
  assert.equal((await f.exists()).status, 403); f.controls.denied = false; f.controls.limited = true;
  assert.equal((await f.exists()).status, 429); assert.equal(f.calls.reads + f.calls.physical + f.calls.aliases, 0);
});
