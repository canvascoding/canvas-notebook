import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';
import ts from 'typescript';
import { getFileStats } from '../app/lib/filesystem/workspace-files';
import { filesystemFileVersion } from '../app/lib/filesystem/file-version';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import { installCollaborationDocumentReader } from '../app/lib/collaboration/document-access';
import { withNativeWorkspaceFileRead } from '../app/lib/collaboration/workspace-native-file-read';
import { Y } from '../app/lib/collaboration/server-runtime';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { WorkspaceDocumentCatalogueError, type WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { FileNode } from '../app/lib/files/types';
import type * as InfoRoute from '../app/api/files/info/route';
import { nativeTableWidthFixture } from './helpers/rich-markdown-projection-fixtures';

const temporaryRoots: string[] = [];
afterEach(async () => { for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function harness() {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'canvas-native-file-info-')); temporaryRoots.push(rootPath);
  await writeFile(path.join(rootPath, 'note.md'), '');
  const workspace: WorkspaceContext = { workspaceId: 'info-workspace', organizationId: null, workspaceType: 'personal',
    rootPath, legacy: false, status: 'active', permissions: { canRead: true, canWrite: false, canDelete: false,
      canManageWorkspace: false, canCreatePublicLinks: false, canRunAgent: false } };
  const doc = createPlainTextYDoc('Actual native document');
  const state: PersistedCollaborationState = { documentId: 'info-document', workspaceId: workspace.workspaceId,
    organizationId: null, path: 'note.md', lifecycleGeneration: 1, representation: 'plain_text', schemaVersion: 1,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: 0,
    persistedAt: Date.UTC(2026, 9, 13, 12), checkpointSequence: 0, checkpointedAt: null,
    canonicalHash: null, serializedHash: null, newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
  doc.destroy();
  const controls = { state: state as PersistedCollaborationState | null, authority: 'initialized' as WorkspaceDocumentCatalogueEntry['authority'],
    cataloguePath: state.path, path: state.path, denied: false, unregistered: false, workspace,
    catalogueFailure: null as WorkspaceDocumentCatalogueError | null };
  const calls = { diskStats: 0, states: 0, fences: 0, enrichment: 0, active: false, commands: [] as string[] };
  const filename = path.resolve('app/api/files/info/route.ts'), require = createRequire(filename);
  const javascript = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const mocks: Record<string, unknown> = {
    '@/app/lib/filesystem/workspace-files': { getFileStats: async (filePath: string) => {
      assert.equal(calls.active, filePath !== '.', 'physical fallback must remain inside the existing shared read fence');
      calls.diskStats++; return getFileStats(filePath, { workspace: controls.workspace });
    } },
    '@/app/lib/files/workspace-file-metadata': { enrichWorkspaceFileNodes: async (input: {
      nodes: FileNode[]; workspace: WorkspaceContext; userId: string;
    }) => {
      assert(calls.active); assert.equal(input.workspace.workspaceId, workspace.workspaceId); assert.equal(input.userId, 'info-reader');
      calls.enrichment++; return input.nodes.map(node => ({ ...node, title: 'Workspace title', isFavorite: true }));
    } },
    '@/app/lib/workspaces/request': {
      requireRequestWorkspace: async () => controls.denied ? { response: new Response(null, { status: 403 }) }
        : { workspace: controls.workspace, session: { user: { id: 'info-reader' } } }, workspaceFileOptions: (current: WorkspaceContext) => ({ workspace: current }),
    },
    '@/app/lib/collaboration/workspace-native-file-read': {
      withNativeWorkspaceFileRead: <T>(input: Parameters<typeof withNativeWorkspaceFileRead>[0], consume: Parameters<typeof withNativeWorkspaceFileRead<T>>[1]) => {
        calls.fences++; assert.equal(input.mode, 'metadata', 'file info must never request a Markdown export');
        return withNativeWorkspaceFileRead(input, consume, {
          openConnection: async () => ({ run: async sql => {
            calls.commands.push(sql); assert(!/^(INSERT|UPDATE|DELETE)/u.test(sql));
            if (sql.startsWith('BEGIN')) calls.active = true;
            if (sql === 'COMMIT' || sql === 'ROLLBACK') calls.active = false;
          }, get: async sql => { assert(calls.active); assert(sql.includes('pg_advisory_xact_lock_shared')); return undefined; },
          all: async () => [], close: async () => { assert.equal(calls.active, false); } }),
          readCatalogue: async (_db, _workspace, options) => {
            if (controls.catalogueFailure) throw controls.catalogueFailure;
            return controls.unregistered || !options?.paths?.some(scope =>
              controls.cataloguePath === scope || controls.cataloguePath.startsWith(`${scope}/`)) ? [] : [{
                id: state.documentId, path: controls.cataloguePath, lifecycle_generation: 1, authority: controls.authority,
              } as WorkspaceDocumentCatalogueEntry];
          },
          loadState: async () => { assert(calls.active); calls.states++; return controls.state; },
        });
      },
    },
  };
  const exports = {} as typeof InfoRoute;
  new Function('require', 'exports', javascript)((name: string) => mocks[name] ?? require(name), exports);
  return { controls, calls, info: () => exports.GET(new NextRequest(
    `https://canvas.test/api/files/info?path=${encodeURIComponent(controls.path)}`)) };
}

test('native-only and lagging zero-byte projections supply durable epoch-second metadata without physical values', async () => {
  for (const missingProjection of [false, true]) {
    const h = await harness(); if (missingProjection) await rm(path.join(h.controls.workspace.rootPath, 'note.md'));
    const response = await h.info(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const { data } = await response.json();
    assert.equal(data.modified, Date.UTC(2026, 9, 13, 12) / 1000); assert.equal(data.path, 'note.md'); assert.equal(data.type, 'file');
    assert.deepEqual(data.metadataTarget, { version: 1, kind: 'native_file', workspaceId: h.controls.workspace.workspaceId,
      path: h.controls.state!.path, documentId: h.controls.state!.documentId, lifecycleGeneration: h.controls.state!.lifecycleGeneration });
    assert.equal(data.title, 'Workspace title'); assert.equal(data.isFavorite, true);
    for (const key of ['size', 'created', 'permissions', 'sha256', 'fileVersion']) assert.equal(Object.hasOwn(data, key), false, key);
    assert.equal(h.calls.diskStats, 0); assert.equal(h.calls.states, 1); assert.equal(h.calls.enrichment, 1);
    assert.equal(h.calls.commands.at(-1), 'COMMIT');
  }
});

test('native-valid nonexportable rich content and quarantined metadata remain accessible without exporting or changing bytes', async () => {
  const h = await harness(), doc = nativeTableWidthFixture('tiptap_blocks');
  try {
    h.controls.state = { ...h.controls.state!, representation: 'tiptap_blocks', yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
    const before = structuredClone(h.controls.state);
    const initial = await h.info(); assert.equal(initial.status, 200); assert.deepEqual(h.controls.state, before);
    const expectedTarget = { version: 1, kind: 'native_file', workspaceId: h.controls.workspace.workspaceId,
      path: before.path, documentId: before.documentId, lifecycleGeneration: before.lifecycleGeneration };
    assert.deepEqual((await initial.json()).data.metadataTarget, expectedTarget);
    h.controls.state.degraded = true;
    const response = await h.info(); assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.modified, before.persistedAt / 1000); assert.deepEqual(data.metadataTarget, expectedTarget);
    assert.equal(h.calls.diskStats, 0); assert.deepEqual(h.controls.state.yjsState, before.yjsState);
  } finally { doc.destroy(); }
});

test('pending live edits omit the older durable modification time', async () => {
  const h = await harness(), live = new Y.Doc(); Y.applyUpdate(live, h.controls.state!.yjsState);
  live.getText('content').insert(0, 'Unpersisted ');
  const uninstall = installCollaborationDocumentReader(async (id, _workspace, read, loadState) => read(live, await loadState!(id) ?? undefined));
  try {
    const response = await h.info(); assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(Object.hasOwn(data, 'modified'), false); assert.equal(h.calls.diskStats, 0);
    assert.deepEqual(data.metadataTarget, { version: 1, kind: 'native_file', workspaceId: h.controls.workspace.workspaceId,
      path: h.controls.state!.path, documentId: h.controls.state!.documentId, lifecycleGeneration: h.controls.state!.lifecycleGeneration });
  } finally { uninstall(); live.destroy(); }
});

test('lost initialized state, foreign identity and typed catalogue failures stay conflicts without old physical metadata', async () => {
  for (const kind of ['missing', 'foreign', 'catalogue-identity', 'catalogue-orphan'] as const) {
    const h = await harness();
    if (kind === 'missing') { h.controls.authority = 'missing-state'; h.controls.state = null; }
    else if (kind === 'foreign') h.controls.state!.organizationId = 'foreign-organization';
    else h.controls.catalogueFailure = new WorkspaceDocumentCatalogueError(
      kind === 'catalogue-identity' ? 'identity-conflict' : 'orphan-state', 'private-foreign-document', 'private-foreign.md');
    const response = await h.info();
    assert.equal(response.status, 409); assert.equal(h.calls.diskStats + h.calls.enrichment, 0);
    assert.doesNotMatch(await response.text(), /private-foreign/u);
    assert.equal(h.calls.commands.at(-1), 'ROLLBACK');
  }
});

test('native authority precedes a DOCX suffix while unregistered Office remains read-only physical metadata', async () => {
  const h = await harness(); h.controls.path = h.controls.cataloguePath = h.controls.state!.path = 'document.docx';
  const native = await h.info(); assert.equal(native.status, 200); assert.equal(h.calls.diskStats, 0);
  assert.deepEqual((await native.json()).data.metadataTarget, { version: 1, kind: 'native_file',
    workspaceId: h.controls.workspace.workspaceId, path: 'document.docx', documentId: h.controls.state!.documentId,
    lifecycleGeneration: h.controls.state!.lifecycleGeneration });
  h.controls.unregistered = true; h.controls.state = null;
  await writeFile(path.join(h.controls.workspace.rootPath, h.controls.path), Buffer.from([0x50, 0x4b, 0xff]));
  const response = await h.info(); assert.equal(response.status, 200); const { data } = await response.json();
  assert.equal(data.size, 3); assert.equal(typeof data.modified, 'number'); assert.equal(typeof data.permissions, 'string');
  assert.deepEqual(data.metadataTarget, { version: 1, kind: 'filesystem', workspaceId: h.controls.workspace.workspaceId,
    path: h.controls.path, fileVersion: filesystemFileVersion(await stat(path.join(h.controls.workspace.rootPath, h.controls.path))),
    entryType: 'file' });
  assert.equal(h.calls.diskStats, 1); assert.equal(h.calls.states, 1);
});

test('canonical native registry paths retain meaningful filename spaces', async () => {
  const h = await harness(); h.controls.path = h.controls.cataloguePath = h.controls.state!.path = ' native note.md ';
  const response = await h.info(); assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.path, ' native note.md '); assert.equal(h.calls.diskStats, 0);
  assert.deepEqual(data.metadataTarget, { version: 1, kind: 'native_file', workspaceId: h.controls.workspace.workspaceId,
    path: ' native note.md ', documentId: h.controls.state!.documentId, lifecycleGeneration: h.controls.state!.lifecycleGeneration });
});

test('an exact leading-space Markdown physical target never rebinds its native trimmed neighbor', async () => {
  const h = await harness(), before = structuredClone(h.controls.state!);
  const normalPath = path.join(h.controls.workspace.rootPath, 'note.md'), exactPath = path.join(h.controls.workspace.rootPath, ' note.md');
  const normalStats = await stat(normalPath), normalBytes = await readFile(normalPath);
  h.controls.path = ' note.md';
  let response = await h.info(); assert.equal(response.status, 404);
  assert.equal(h.calls.fences, 1); assert.equal(h.calls.states, 0); assert.equal(h.calls.enrichment, 0);
  assert.equal(h.calls.commands.at(-1), 'ROLLBACK'); assert.equal(h.calls.active, false);
  assert.deepEqual(h.controls.state, before); assert.equal(h.controls.cataloguePath, 'note.md');
  const content = Buffer.from('Distinct exact physical leading-space Markdown bytes.');
  await writeFile(exactPath, content, { flag: 'wx', mode: 0o600 }); const exactStats = await stat(exactPath);
  assert.notEqual(exactStats.ino, normalStats.ino);
  response = await h.info(); assert.equal(response.status, 200); const physical = (await response.json()).data;
  assert.equal(physical.path, ' note.md'); assert.equal(physical.size, content.byteLength);
  assert.deepEqual(physical.metadataTarget, { version: 1, kind: 'filesystem', workspaceId: h.controls.workspace.workspaceId,
    path: ' note.md', fileVersion: filesystemFileVersion(exactStats), entryType: 'file' });
  assert.equal(h.calls.states, 0); assert.equal(h.calls.commands.at(-1), 'COMMIT'); assert.equal(h.calls.active, false);
  assert.deepEqual(await readFile(exactPath), content); assert.deepEqual(h.controls.state, before);
  await rm(exactPath);
  response = await h.info(); assert.equal(response.status, 404); assert.equal(h.calls.states, 0);
  assert.equal(h.calls.commands.at(-1), 'ROLLBACK'); assert.equal(h.calls.active, false);
  h.controls.path = 'note.md';
  response = await h.info(); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.metadataTarget, { version: 1, kind: 'native_file',
    workspaceId: h.controls.workspace.workspaceId, path: 'note.md', documentId: before.documentId,
    lifecycleGeneration: before.lifecycleGeneration });
  assert.equal(h.calls.states, 1); assert.equal(h.calls.fences, 4); assert.equal(h.calls.diskStats, 3);
  assert.equal(h.calls.commands.at(-1), 'COMMIT'); assert.equal(h.calls.active, false);
  assert.deepEqual(h.controls.state, before); assert.equal(h.controls.cataloguePath, 'note.md');
  assert.deepEqual(await readFile(normalPath), normalBytes); assert.equal(filesystemFileVersion(await stat(normalPath)), filesystemFileVersion(normalStats));
});

test('pristine files and physical folders retain actual filesystem metadata under the same read fence', async () => {
  const h = await harness(); h.controls.authority = 'pristine'; h.controls.state = null;
  await writeFile(path.join(h.controls.workspace.rootPath, 'note.md'), 'Known physical bytes');
  let response = await h.info(); assert.equal(response.status, 200); const physical = (await response.json()).data;
  assert.equal(physical.size, 20);
  assert.deepEqual(physical.metadataTarget, { version: 1, kind: 'filesystem', workspaceId: h.controls.workspace.workspaceId,
    path: 'note.md', fileVersion: filesystemFileVersion(await stat(path.join(h.controls.workspace.rootPath, 'note.md'))),
    entryType: 'file' });
  h.controls.path = 'folder'; h.controls.cataloguePath = 'folder/native.md';
  await mkdir(path.join(h.controls.workspace.rootPath, 'folder')); await writeFile(path.join(h.controls.workspace.rootPath, 'folder/physical.txt'), 'ABC');
  response = await h.info(); assert.equal(response.status, 200); const { data } = await response.json();
  assert.equal(data.type, 'directory'); assert.equal(data.size, 3); assert.equal(typeof data.modified, 'number');
  assert.deepEqual(data.metadataTarget, { version: 1, kind: 'filesystem', workspaceId: h.controls.workspace.workspaceId,
    path: 'folder', fileVersion: filesystemFileVersion(await stat(path.join(h.controls.workspace.rootPath, 'folder'))),
    entryType: 'directory' });
  assert.equal(h.calls.states, 0);
});

test('registry-only virtual folders explicitly return 404 without inventing namespace or aggregate metadata', async () => {
  const h = await harness(); h.controls.path = 'virtual'; h.controls.cataloguePath = 'virtual/native.md';
  assert.equal((await h.info()).status, 404); assert.equal(h.calls.enrichment, 0); assert.equal(h.calls.states, 0);
});

test('the actual root is a physical directory with no native fence or title-database claim', async () => {
  const h = await harness(); h.controls.path = '.';
  const response = await h.info(); assert.equal(response.status, 200); const { data } = await response.json();
  assert.equal(data.path, '.'); assert.equal(data.type, 'directory'); assert.equal(typeof data.modified, 'number');
  assert.equal(Object.hasOwn(data, 'metadataTarget'), false);
  assert.equal(h.calls.fences + h.calls.enrichment + h.calls.states, 0); assert.equal(h.calls.diskStats, 1);
});

test('physical paths with outer filename spaces cannot obtain the trimmed file target', async () => {
  const h = await harness(); h.controls.unregistered = true; h.controls.state = null; h.controls.path = 'note.md ';
  const response = await h.info(); assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(Object.hasOwn(payload, 'data'), false);
  assert.doesNotMatch(JSON.stringify(payload), /metadataTarget|fileVersion/u);
  assert.equal(h.calls.diskStats + h.calls.states + h.calls.enrichment, 0);
  assert.equal(h.calls.commands.at(-1), 'ROLLBACK');
});

test('denied, invalid and symlink-alias requests never expose stale projection statistics', async () => {
  const h = await harness(); h.controls.denied = true;
  assert.equal((await h.info()).status, 403); assert.equal(h.calls.fences + h.calls.diskStats, 0);
  h.controls.denied = false; h.controls.path = '../outside.md';
  assert.equal((await h.info()).status, 400); assert.equal(h.calls.fences + h.calls.diskStats, 0);
  h.controls.path = 'alias.md'; await symlink('note.md', path.join(h.controls.workspace.rootPath, 'alias.md'));
  assert.equal((await h.info()).status, 409); assert.equal(h.calls.diskStats + h.calls.enrichment, 0);
  h.controls.path = './note.md';
  const response = await h.info(); assert.equal(response.status, 200); assert.equal((await response.json()).data.path, 'note.md');
});
