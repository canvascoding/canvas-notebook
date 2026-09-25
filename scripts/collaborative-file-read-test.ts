import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import ts from 'typescript';
import * as Y from 'yjs';

import { collaborativeReadSnapshot } from '../app/lib/files/collaborative-read-snapshot';
import type { FileCollaborationState } from '../app/lib/files/collaboration-policy';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type * as Route from '../app/api/files/read/route';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const workspace: WorkspaceContext = {
  workspaceId: 'workspace-one', workspaceType: 'personal', organizationId: null,
  rootPath: '/unused-test-root', legacy: false, status: 'active',
  permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true,
    canManageWorkspace: true, canRunAgent: true },
};

function fixture() {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'Price: 130 €\n');
  const state: PersistedCollaborationState = {
    documentId: 'document-one', workspaceId: workspace.workspaceId, organizationId: null,
    path: 'note.txt', representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
    documentSequence: 2, persistedAt: 200, checkpointedAt: 100, checkpointSequence: 1,
    canonicalHash: null, serializedHash: null, newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active',
  };
  doc.destroy();
  const collaboration: FileCollaborationState = {
    lineageId: 'lineage-one', path: state.path, strategy: 'crdt_text', crdtCapable: true,
    sceneCapable: false, lockRequired: false, requiresRevisionCheck: false, activeLock: null,
    document: { id: state.documentId, organizationId: null, customerId: null, projectId: null,
      workspaceId: workspace.workspaceId, workspaceType: workspace.workspaceType, path: state.path,
      provider: 'yjs', stateVersion: 2, snapshotRevisionId: 'revision-new', status: 'active', createdAt: 100, updatedAt: 200 },
    latestRevision: { id: 'revision-new', lineageId: 'lineage-one', organizationId: null, customerId: null, projectId: null,
      workspaceId: workspace.workspaceId, workspaceType: workspace.workspaceType, path: state.path,
      contentHash: hash(Buffer.from('Price: 130 €\n')), sizeBytes: Buffer.byteLength('Price: 130 €\n'),
      createdByUserId: 'reviewer', createdByActorType: 'user', sourceSessionId: 'session-one', baseRevisionId: 'revision-old', createdAt: 200 },
  };
  return { state, collaboration };
}

test('collaborative reads serialize the durable Yjs snapshot and preserve its byte profile', () => {
  const { state, collaboration } = fixture();
  assert.equal(collaborativeReadSnapshot({ workspace, collaboration, state })?.toString(), 'Price: 130 €\n');
  assert.equal(collaborativeReadSnapshot({ workspace, collaboration,
    state: { ...state, newlineStyle: 'crlf', hasBom: true } })?.toString(), '\uFEFFPrice: 130 €\r\n');
  assert.equal(collaborativeReadSnapshot({ workspace, collaboration, state: null }), null);
});

test('collaborative reads fail closed for foreign, archived, degraded or corrupt persisted state', () => {
  const { state, collaboration } = fixture();
  for (const change of [ { documentId: 'foreign' }, { workspaceId: 'foreign' }, { organizationId: 'foreign' },
    { path: 'other.txt' }, { status: 'archived' as const }, { degraded: true } ]) {
    assert.throws(() => collaborativeReadSnapshot({ workspace, collaboration, state: { ...state, ...change } }), { status: 409 });
  }
  assert.throws(() => collaborativeReadSnapshot({ workspace: { ...workspace,
    permissions: { ...workspace.permissions, canRead: false } }, collaboration, state }), { status: 409 });
  assert.throws(() => collaborativeReadSnapshot({ workspace, collaboration,
    state: { ...state, stateVector: new Uint8Array([0]) } }), /state vector do not match/u);
});

async function harness() {
  const controls = { ...fixture(), denied: false, metadata: false,
    state: fixture().state as PersistedCollaborationState | null, disk: Buffer.from('Price: 100 €\n') };
  const calls = { diskReads: 0, revisionWrites: 0, stateReads: 0 };
  const filename = path.resolve('app/api/files/read/route.ts');
  const runtimeRequire = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const mocks: Record<string, unknown> = {
    '@/app/lib/filesystem/workspace-files': {
      getFileStats: async () => ({ size: controls.disk.byteLength, modified: 100, permissions: 'rw', fileVersion: 1 }),
      readFile: async () => { calls.diskReads++; return controls.disk; },
    },
    '@/app/lib/files/revision-guard': { sha256Buffer: hash },
    '@/app/lib/files/collaboration-policy': {
      isDocxPath: () => false,
      getFileCollaborationState: async () => controls.collaboration,
      ensureFileRevisionForCurrentContent: async (input: { contentHash: string }) => {
        calls.revisionWrites++; return { id: 'captured-noncollaborative-revision', contentHash: input.contentHash };
      },
    },
    '@/app/lib/office/document-service': {}, '@/app/lib/office/editor-compatibility': {},
    '@/app/lib/utils/rate-limit': { rateLimit: () => ({ ok: true }) },
    '@/app/lib/excalidraw-file': { isExcalidrawFilePath: () => false },
    '@/app/lib/workspaces/request': {
      requireRequestWorkspace: async () => controls.denied ? { response: new Response(null, { status: 403 }) }
        : { workspace, session: { user: { id: 'reviewer' } } }, workspaceFileOptions: () => ({}),
    },
    '@/app/lib/collaboration/persistence': { loadCollaborationState: async () => { calls.stateReads++; return controls.state; } },
    '@/app/lib/files/collaborative-read-snapshot': { collaborativeReadSnapshot },
  };
  const route = {} as typeof Route;
  new Function('require', 'module', 'exports', source)(
    (name: string) => mocks[name] ?? runtimeRequire(name), { exports: route }, route,
  );
  return { controls, calls, read: () => route.GET(new NextRequest(
    `https://canvas.test/api/files/read?path=note.txt${controls.metadata ? '&meta=1' : ''}`)) };
}

test('opening a lagging file projection never records old -> new -> old history', async () => {
  const h = await harness();
  for (let index = 0; index < 3; index++) {
    const response = await h.read();
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.content, 'Price: 130 €\n');
    assert.equal(data.stats.sha256, hash(Buffer.from(data.content)));
    assert.equal(data.stats.size, Buffer.byteLength(data.content));
    assert.equal(data.revision.id, 'revision-new');
  }
  assert.deepEqual(h.calls, { diskReads: 0, revisionWrites: 0, stateReads: 3 });
  h.controls.collaboration.latestRevision!.contentHash = hash(h.controls.disk);
  assert.equal((await (await h.read()).json()).data.revision, null, 'a stale ledger cannot certify different returned bytes');
  assert.equal(h.calls.revisionWrites, 0);
});

test('not-yet-joined Yjs files and metadata reads do not capture history; ordinary files still do', async () => {
  const h = await harness();
  h.controls.state = null;
  assert.equal((await (await h.read()).json()).data.content, h.controls.disk.toString());
  assert.equal(h.calls.revisionWrites, 0);
  h.controls.metadata = true;
  assert.equal((await (await h.read()).json()).data.content, '');
  assert.equal(h.calls.stateReads, 1);
  h.controls.metadata = false;
  h.controls.collaboration.document = null;
  assert.equal((await (await h.read()).json()).data.revision.id, 'captured-noncollaborative-revision');
  assert.equal(h.calls.revisionWrites, 1);
  h.controls.denied = true;
  assert.equal((await h.read()).status, 403);
  assert.equal(h.calls.revisionWrites, 1);
});
