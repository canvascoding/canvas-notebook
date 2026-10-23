import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import ts from 'typescript';
import * as operationFlows from '../app/lib/files/operation-flows';
import * as pathUtils from '../app/lib/files/path-utils';
import * as exportAccess from '../app/lib/workspaces/export-access';
import * as sceneHttp from '../app/lib/excalidraw-collaboration/http';
import * as checkpointErrors from '../app/lib/collaboration/checkpoint-errors';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import { withNativeWorkspaceFileRead } from '../app/lib/collaboration/workspace-native-file-read';
import { Y } from '../app/lib/collaboration/server-runtime';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type * as DownloadRoute from '../app/api/files/download/route';
import { nativeTableWidthFixture } from './helpers/rich-markdown-projection-fixtures';

async function harness() {
  const workspace: WorkspaceContext = { workspaceId: 'download-workspace', organizationId: null, workspaceType: 'personal',
    rootPath: '/unused-download-fixture', legacy: false, status: 'active', ownerUserId: 'reader',
    permissions: { canRead: true, canWrite: false, canDelete: false, canManageWorkspace: false, canCreatePublicLinks: false, canRunAgent: false } };
  const doc = createPlainTextYDoc('Fresh native\nSecond\n');
  const state: PersistedCollaborationState = { documentId: 'native-download', workspaceId: workspace.workspaceId,
    organizationId: null, path: 'note.bin', representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: 0, persistedAt: 100,
    checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null,
    newlineStyle: 'crlf', hasBom: true, degraded: false, status: 'active' };
  doc.destroy();
  const controls = { state: state as PersistedCollaborationState | null, authority: 'initialized' as WorkspaceDocumentCatalogueEntry['authority'],
    denied: false, physical: Buffer.from([0xff, 0x00, 0x42]), path: state.path,
    cataloguePath: null as string | null, directory: false, missingPhysical: false,
    archiveError: null as Error | null, userId: 'reader', sessionId: 'reader-session',
    archiveBytes: Buffer.from([0x50, 0x4b, 0, 0]) };
  const calls = { diskStats: 0, diskStreams: 0, nativeReads: 0, active: false, archivePaths: [] as string[][] };
  const filename = path.resolve('app/api/files/download/route.ts'), require = createRequire(filename);
  const javascript = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const mocks: Record<string, unknown> = {
    // The eval boundary uses real bundled pure helpers; require() cannot resolve
    // TypeScript aliases in the ESM runner. Only I/O remains fixture controlled.
    '@/app/lib/files/operation-flows': operationFlows,
    '@/app/lib/files/path-utils': pathUtils,
    '@/app/lib/workspaces/export-access': exportAccess,
    '@/app/lib/excalidraw-collaboration/http': sceneHttp,
    '@/app/lib/collaboration/checkpoint-errors': checkpointErrors,
    '@/app/lib/excalidraw-collaboration/checkpoint-worker': {
      ensureExcalidrawCheckpointsCurrent: async (input: { workspaceId: string; paths: string[] }) => {
        assert.equal(input.workspaceId, workspace.workspaceId);
        assert(input.paths.length > 0);
      },
    },
    '@/app/lib/filesystem/workspace-files': {
      getFileStats: async () => { assert(calls.active); calls.diskStats++;
        if (controls.missingPhysical) throw Object.assign(new Error('Missing physical projection'), { code: 'ENOENT' });
        return { isDirectory: controls.directory, size: controls.physical.byteLength }; },
      createReadStream: async () => { assert(calls.active); calls.diskStreams++; return { stream: Readable.from([controls.physical]) }; },
    },
    '@/app/lib/utils/rate-limit': { rateLimit: () => ({ ok: true }) },
    '@/app/lib/admin-auth': { isAdminUser: () => false },
    '@/app/lib/workspaces/request': {
      requireRequestWorkspace: async () => controls.denied ? { response: new Response(null, { status: 403 }) }
        : { workspace, session: { user: { id: controls.userId }, session: { id: controls.sessionId } } }, workspaceFileOptions: () => ({}),
    },
    '@/app/lib/collaboration/workspace-native-file-read': {
      withNativeWorkspaceFileRead: <T>(input: Parameters<typeof withNativeWorkspaceFileRead>[0], consume: (native: import('../app/lib/collaboration/workspace-native-file-read').NativeWorkspaceFileRead | null) => Promise<T>) => {
        calls.nativeReads++;
        return withNativeWorkspaceFileRead(input, consume, {
          openConnection: async () => ({ run: async sql => {
            if (sql.startsWith('BEGIN')) calls.active = true;
            if (sql === 'COMMIT' || sql === 'ROLLBACK') calls.active = false;
            assert(!/^(INSERT|UPDATE|DELETE)/u.test(sql));
          }, get: async () => undefined, all: async () => [], close: async () => { assert(!calls.active); } }),
          readCatalogue: async () => [{ id: 'native-download', path: controls.cataloguePath ?? controls.path, lifecycle_generation: 1,
            authority: controls.authority } as WorkspaceDocumentCatalogueEntry],
          loadState: async () => controls.state,
        });
      },
    },
    '@/app/lib/files/workspace-download-archive': {
      materializeWorkspaceDownloadArchive: async (current: WorkspaceContext, paths: string[]) => {
        assert.equal(current.workspaceId, workspace.workspaceId);
        assert.equal(calls.active, false, 'Archive scope must begin after the single-file read fence closes.');
        calls.archivePaths.push([...paths]);
        if (controls.archiveError) throw controls.archiveError;
        const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'canvas-download-route-test-'));
        const archivePath = path.join(tempDirectory, 'selection.zip');
        await writeFile(archivePath, controls.archiveBytes, { mode: 0o600 });
        return { archivePath, tempDirectory };
      },
    },
  };
  const exports = {} as typeof DownloadRoute;
  new Function('require', 'exports', javascript)((name: string) => mocks[name] ?? require(name), exports);
  return { workspace, controls, calls, request: (query: string) => exports.GET(new NextRequest(`https://canvas.test/api/files/download?${query}`)),
    download: (suffix = '') => exports.GET(new NextRequest(
    `https://canvas.test/api/files/download?path=${encodeURIComponent(controls.path)}${suffix}`)) };
}

test('single native-only download exports exact BOM/CRLF bytes without physical stats or stream, independent of suffix', async () => {
  const h = await harness(), response = await h.download();
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.toString(), '\uFEFFFresh native\r\nSecond\r\n');
  assert.equal(response.headers.get('content-length'), String(bytes.byteLength));
  assert.match(response.headers.get('content-disposition')!, /note\.bin/u);
  assert.equal(h.calls.diskStats + h.calls.diskStreams, 0);
});

test('lost initialized state and changed identity never fall back to projected bytes', async () => {
  for (const kind of ['missing', 'foreign'] as const) {
    const h = await harness();
    if (kind === 'missing') { h.controls.state = null; h.controls.authority = 'missing-state'; }
    else h.controls.state!.workspaceId = 'foreign';
    const response = await h.download();
    assert.equal(response.status, 409); assert.equal(h.calls.diskStats + h.calls.diskStreams, 0);
  }
});

test('invalid native schema remains an explicit export error with no old physical download', async () => {
  const h = await harness(); h.controls.state!.schemaVersion = 999;
  const response = await h.download();
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /identity or version is unavailable/u);
  assert.equal(h.calls.diskStats + h.calls.diskStreams, 0);
});

test('a schema-valid rich table with an unavailable Markdown export returns its explicit 422 code, never projection bytes', async () => {
  const h = await harness(), doc = nativeTableWidthFixture('tiptap_blocks', 'Retain native width');
  try {
    h.controls.state = { ...h.controls.state!, representation: 'tiptap_blocks',
      yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
    const response = await h.download();
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, 'COLLABORATION_ROUNDTRIP_UNSTABLE');
    assert.equal(h.calls.diskStats + h.calls.diskStreams, 0);
  } finally { doc.destroy(); }
});

test('explicitly pristine binary fallback opens its stream inside the same admission read fence', async () => {
  const h = await harness(); h.controls.authority = 'pristine'; h.controls.state = null;
  const response = await h.download();
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), h.controls.physical);
  assert.equal(h.calls.diskStats, 1); assert.equal(h.calls.diskStreams, 1); assert.equal(h.calls.active, false);
});

test('denied access and invalid path requests inspect neither native state nor disk bytes', async () => {
  const h = await harness(); h.controls.denied = true;
  assert.equal((await h.download()).status, 403); assert.equal(h.calls.nativeReads, 0);
  h.controls.denied = false; h.controls.path = '../outside';
  assert.equal((await h.download()).status, 400); assert.equal(h.calls.nativeReads, 0);
  assert.equal(h.calls.diskStats + h.calls.diskStreams, 0);
});

test('mixed selections dispatch once to the scoped archive reader without an initial physical stat or single-file read', async () => {
  const h = await harness(), response = await h.download('&path=other.bin');
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0x50, 0x4b, 0, 0]));
  assert.deepEqual(h.calls.archivePaths, [['note.bin', 'other.bin']]);
  assert.equal(h.calls.diskStats + h.calls.diskStreams + h.calls.nativeReads, 0);
});

test('physical and native-only virtual folder requests materialize outside the closed single-file fence', async () => {
  for (const missing of [false, true]) {
    const h = await harness(); h.controls.path = 'folder'; h.controls.cataloguePath = 'folder/native.md';
    h.controls.directory = true; h.controls.missingPhysical = missing;
    const response = await h.download();
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/zip');
    await response.arrayBuffer();
    assert.deepEqual(h.calls.archivePaths, [['folder']]); assert.equal(h.calls.diskStreams, 0);
    assert.equal(h.calls.active, false);
  }
});

test('a failed mixed native archive reports the scoped conflict instead of a partial or stale download', async () => {
  const h = await harness(); h.controls.archiveError = Object.assign(new Error('Native namespace changed'), { status: 409, code: 'ARCHIVE_SOURCE_CHANGED' });
  const response = await h.download('&path=other.bin');
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'ARCHIVE_SOURCE_CHANGED');
  assert.equal(h.calls.diskStats + h.calls.diskStreams, 0);
});


test('prepared workspace native archive returns owner-bound JSON and serves the original central artifact once', async () => {
  const h = await harness(), query = new URLSearchParams({ scope: 'workspace', workspaceId: h.workspace.workspaceId, prepare: '1' });
  const prepared = await h.request(query.toString());
  assert.equal(prepared.status, 200); assert.equal(prepared.headers.get('cache-control'), 'no-store');
  assert.match(prepared.headers.get('content-type')!, /application\/json/u);
  const { downloadUrl } = await prepared.json() as { downloadUrl: string };
  const ticket = new URL(downloadUrl, 'https://canvas.test');
  assert.equal(ticket.pathname, '/api/files/download'); assert.equal(ticket.searchParams.get('workspaceId'), h.workspace.workspaceId);
  assert.match(ticket.searchParams.get('ticket')!, /^[a-f0-9-]{36}$/u);
  assert.deepEqual(h.calls.archivePaths, [['.']]);
  assert.equal(h.calls.diskStats + h.calls.diskStreams + h.calls.nativeReads, 0);
  // A subsequent source change must not rematerialize or retarget this ticket.
  h.controls.archiveBytes = Buffer.from('later bytes');
  const response = await h.request(ticket.searchParams.toString());
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0x50, 0x4b, 0, 0]));
  assert.deepEqual(h.calls.archivePaths, [['.']]);
  const reused = await h.request(ticket.searchParams.toString());
  assert.equal(reused.status, 410); assert.equal((await reused.json()).code, 'DOWNLOAD_EXPIRED');
});

test('prepared archive rejects changed user, session, workspace and revoked access before consuming the owner ticket', async () => {
  for (const changed of ['user', 'session', 'workspace', 'denied'] as const) {
    const h = await harness();
    const prepared = await h.request(new URLSearchParams({ scope: 'workspace', workspaceId: h.workspace.workspaceId, prepare: '1' }).toString());
    assert.equal(prepared.status, 200);
    const { downloadUrl } = await prepared.json() as { downloadUrl: string }, query = new URL(downloadUrl, 'https://canvas.test').searchParams;
    const originalWorkspace = h.workspace.workspaceId;
    if (changed === 'user') { h.controls.userId = 'other'; h.workspace.ownerUserId = 'other'; }
    if (changed === 'session') h.controls.sessionId = 'other';
    if (changed === 'workspace') { h.workspace.workspaceId = 'other'; query.set('workspaceId', 'other'); }
    if (changed === 'denied') h.controls.denied = true;
    const refused = await h.request(query.toString());
    assert.equal(refused.status, 403);
    if (changed !== 'denied') assert.equal((await refused.json()).code, 'DOWNLOAD_OWNER_MISMATCH');
    h.controls.userId = 'reader'; h.workspace.ownerUserId = 'reader'; h.controls.sessionId = 'reader-session';
    h.workspace.workspaceId = originalWorkspace; query.set('workspaceId', originalWorkspace); h.controls.denied = false;
    const allowed = await h.request(query.toString()); assert.equal(allowed.status, 200); await allowed.arrayBuffer();
    assert.deepEqual(h.calls.archivePaths, [['.']]);
  }
});

test('prepared native archive expiry and scoped materialization failures remain explicit without physical fallback', async () => {
  const h = await harness();
  const prepareQuery = new URLSearchParams({ scope: 'workspace', workspaceId: h.workspace.workspaceId, prepare: '1' }).toString();
  h.controls.archiveError = Object.assign(new Error('Native namespace changed'), { status: 409, code: 'ARCHIVE_SOURCE_CHANGED' });
  const failed = await h.request(prepareQuery); assert.equal(failed.status, 409);
  assert.equal((await failed.json()).code, 'ARCHIVE_SOURCE_CHANGED');
  assert.equal(h.calls.diskStats + h.calls.diskStreams + h.calls.nativeReads, 0);
  h.controls.archiveError = null;
  const prepared = await h.request(prepareQuery); assert.equal(prepared.status, 200);
  const { downloadUrl } = await prepared.json() as { downloadUrl: string }, query = new URL(downloadUrl, 'https://canvas.test').searchParams;
  const now = Date.now;
  try {
    Date.now = () => now() + 301_000;
    const expired = await h.request(query.toString());
    assert.equal(expired.status, 410); assert.equal((await expired.json()).code, 'DOWNLOAD_EXPIRED');
  } finally { Date.now = now; }
  assert.deepEqual(h.calls.archivePaths, [['.'], ['.']]);
});
