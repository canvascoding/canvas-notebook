import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import ts from 'typescript';
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
    denied: false, physical: Buffer.from([0xff, 0x00, 0x42]), path: state.path };
  const calls = { diskStats: 0, diskStreams: 0, nativeReads: 0, active: false };
  const filename = path.resolve('app/api/files/download/route.ts'), require = createRequire(filename);
  const javascript = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const mocks: Record<string, unknown> = {
    '@/app/lib/filesystem/workspace-files': {
      getFileStats: async () => { assert(calls.active); calls.diskStats++; return { isDirectory: false, size: controls.physical.byteLength }; },
      createReadStream: async () => { assert(calls.active); calls.diskStreams++; return { stream: Readable.from([controls.physical]) }; },
    },
    '@/app/lib/utils/rate-limit': { rateLimit: () => ({ ok: true }) },
    '@/app/lib/admin-auth': { isAdminUser: () => false },
    '@/app/lib/workspaces/request': {
      requireRequestWorkspace: async () => controls.denied ? { response: new Response(null, { status: 403 }) }
        : { workspace, session: { user: { id: 'reader' } } }, workspaceFileOptions: () => ({}),
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
          readCatalogue: async () => [{ id: 'native-download', path: controls.path, lifecycle_generation: 1,
            authority: controls.authority } as WorkspaceDocumentCatalogueEntry],
          loadState: async () => controls.state,
        });
      },
    },
  };
  const exports = {} as typeof DownloadRoute;
  new Function('require', 'exports', javascript)((name: string) => mocks[name] ?? require(name), exports);
  return { controls, calls, download: (suffix = '') => exports.GET(new NextRequest(
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
