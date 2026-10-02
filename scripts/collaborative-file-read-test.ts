import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import ts from 'typescript';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';

import { collaborativeReadSnapshot } from '../app/lib/files/collaborative-read-snapshot';
import { BLOCK_TREE_KEY, CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { COLLABORATION_CHECKPOINT_ERROR_CODES } from '../app/lib/collaboration/checkpoint-errors';
import { createRichMarkdownYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
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

function richFixture(doc: Y.Doc) {
  const initial = fixture();
  const state: PersistedCollaborationState = { ...initial.state, path: 'rich.md',
    representation: 'tiptap_blocks', schemaVersion: 3,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
  const collaboration: FileCollaborationState = { ...initial.collaboration, path: state.path,
    document: { ...initial.collaboration.document!, path: state.path },
    latestRevision: { ...initial.collaboration.latestRevision!, path: state.path } };
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
  const controls = { ...fixture(), denied: false, metadata: false, bootstrap: false,
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
    `https://canvas.test/api/files/read?path=${encodeURIComponent(controls.collaboration.path)}${controls.metadata ? '&meta=1' : ''}${controls.bootstrap ? '&collaborationBootstrap=1' : ''}`)) };
}

test('a native-only rich document reopens through metadata and recovers without reading or versioning disk bytes', async () => {
  const h = await harness();
  const doc = createRichMarkdownYDoc('| First | Second |\n| --- | --- |\n| Seed | Neighbor |\n\nPeer paragraph', 'tiptap_blocks');
  const schema = getSchema(richMarkdownSchemaExtensions());
  const tree = new CollaborationBlockTree(doc, schema);
  const paragraph = tree.read().firstChild!.child(1).firstChild!.firstChild!;
  const originalError = console.error; console.error = () => undefined;
  try {
    tree.updateInlineContent(paragraph.attrs.id, paragraph.type.create(paragraph.attrs,
      schema.text('odd\\|pipe', [schema.marks.code.create()])), 'human');
    assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable', 'the actual serializer must reject the lossy projection');
    Object.assign(h.controls, richFixture(doc));
    const persisted = structuredClone(h.controls.state);
    h.controls.bootstrap = true;
    const bootstrap = await h.read(); assert.equal(bootstrap.status, 200);
    const { data } = await bootstrap.json();
    assert.equal(data.path, 'rich.md'); assert.equal(data.content, ''); assert.equal(data.contentUnavailable, true);
    assert.equal(data.stats.sha256, undefined); assert.equal(data.revision, null);
    assert.equal(data.collaboration.document.id, h.controls.state!.documentId);
    assert.deepEqual(h.controls.state, persisted, 'read-only bootstrap must preserve binary, vector, sequences and degradation');
    assert.equal(h.calls.diskReads, 0); assert.equal(h.calls.revisionWrites, 0);
    h.controls.bootstrap = false;
    const ordinary = await h.read(); assert.equal(ordinary.status, 422);
    assert.deepEqual(await ordinary.json(), { success: false,
      error: 'The rich-text document could not be safely synchronized.',
      code: COLLABORATION_CHECKPOINT_ERROR_CODES.roundtripUnstable, validationCode: 'roundtrip_unstable' });

    tree.updateInlineContent(paragraph.attrs.id, paragraph.type.create(paragraph.attrs, schema.text('odd\\|pipe')), 'human');
    assert.equal(validateRichMarkdownYDoc(doc).valid, true);
    Object.assign(h.controls, richFixture(doc));
    h.controls.state!.documentSequence++;
    const recoveredState = structuredClone(h.controls.state);
    for (const bootstrapRead of [true, false]) {
      h.controls.bootstrap = bootstrapRead;
      const recovered = await h.read(); assert.equal(recovered.status, 200);
      const recoveredData = (await recovered.json()).data;
      assert.equal(recoveredData.contentUnavailable, undefined);
      assert.match(recoveredData.content, /Neighbor/u);
      assert.equal(recoveredData.stats.sha256, hash(Buffer.from(recoveredData.content)));
      assert.equal(recoveredData.revision, null, 'the old physical revision cannot certify the recovered native content');
      assert.deepEqual(h.controls.state, recoveredState);
    }
    assert.equal(h.calls.diskReads, 0); assert.equal(h.calls.revisionWrites, 0);
  } finally { console.error = originalError; doc.destroy(); }
});

test('rich bootstrap remains closed for foreign identity, denied access, corrupt state, schema, IDs and serializer failures', async () => {
  const h = await harness();
  const doc = createRichMarkdownYDoc('- A\n\nKeep', 'tiptap_blocks');
  const schema = getSchema(richMarkdownSchemaExtensions());
  const tree = new CollaborationBlockTree(doc, schema);
  const paragraph = tree.read().firstChild!.firstChild!.firstChild!;
  const originalError = console.error; console.error = () => undefined;
  try {
    tree.updateInlineContent(paragraph.attrs.id, paragraph.type.create(paragraph.attrs, schema.text('A\t\nB')), 'human');
    assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
    const rich = richFixture(doc); Object.assign(h.controls, rich); h.controls.bootstrap = true;
    for (const change of [{ documentId: 'foreign' }, { workspaceId: 'foreign' }, { organizationId: 'foreign' },
      { path: 'other.md' }, { status: 'archived' as const }]) {
      h.controls.state = { ...rich.state, ...change };
      const before = structuredClone(h.controls.state);
      assert.equal((await h.read()).status, 409);
      assert.deepEqual(h.controls.state, before);
    }
    h.controls.state = rich.state; h.controls.denied = true;
    assert.equal((await h.read()).status, 403); h.controls.denied = false;
    for (const change of [{ stateVector: new Uint8Array([0]) }, { yjsState: new Uint8Array([255]) }]) {
      h.controls.state = { ...rich.state, ...change };
      const before = structuredClone(h.controls.state);
      const response = await h.read(); assert.equal(response.status, 500);
      assert.equal((await response.json()).success, false);
      assert.deepEqual(h.controls.state, before);
    }
    const invalidCases = [
      { code: 'schema_invalid', publicCode: COLLABORATION_CHECKPOINT_ERROR_CODES.schemaInvalid,
        mutate: (invalid: Y.Doc) => invalid.getMap(BLOCK_TREE_KEY).set('version', 99), format: 'tiptap_blocks' as const },
      { code: 'stable_id_missing', publicCode: COLLABORATION_CHECKPOINT_ERROR_CODES.stableIdMissing,
        mutate: (invalid: Y.Doc) => (invalid.getXmlFragment('body').get(0) as Y.XmlElement).removeAttribute('id'), format: 'tiptap_xml' as const },
      { code: 'stable_id_duplicate', publicCode: COLLABORATION_CHECKPOINT_ERROR_CODES.stableIdDuplicate,
        mutate: (invalid: Y.Doc) => (invalid.getXmlFragment('body').get(1) as Y.XmlElement).setAttribute('id',
          (invalid.getXmlFragment('body').get(0) as Y.XmlElement).getAttribute('id')!), format: 'tiptap_xml' as const },
      { code: 'serialization_failed', publicCode: COLLABORATION_CHECKPOINT_ERROR_CODES.serializationFailed,
        mutate: (invalid: Y.Doc) => {
          const imageTree = new CollaborationBlockTree(invalid, schema);
          const image = imageTree.read().firstChild!;
          assert.equal(image.type.name, 'image');
          (imageTree.records.get(image.attrs.id)!.get('attributes') as Y.Map<unknown>).set('width', '50%');
        }, format: 'tiptap_blocks' as const, markdown: '![Sample](image.png)' },
    ];
    for (const invalidCase of invalidCases) {
      const invalid = createRichMarkdownYDoc(invalidCase.markdown ?? 'First\n\nSecond', invalidCase.format);
      try {
        invalidCase.mutate(invalid);
        assert.equal(validateRichMarkdownYDoc(invalid).code, invalidCase.code);
        const reopened = new Y.Doc();
        try {
          Y.applyUpdate(reopened, Y.encodeStateAsUpdate(invalid));
          assert.equal(validateRichMarkdownYDoc(reopened).code, invalidCase.code, 'the invalid native fixture must survive binary hydration');
        } finally { reopened.destroy(); }
        Object.assign(h.controls, richFixture(invalid)); h.controls.state!.representation = invalidCase.format;
        const before: PersistedCollaborationState | null = structuredClone(h.controls.state);
        const response = await h.read(); assert.equal(response.status, 422, invalidCase.code);
        const failure = await response.json();
        assert.equal(failure.success, false); assert.equal(failure.code, invalidCase.publicCode);
        assert.equal(failure.validationCode, invalidCase.code); assert.equal(failure.data, undefined);
        assert.deepEqual(h.controls.state, before);
      } finally { invalid.destroy(); }
    }
    assert.equal(h.calls.diskReads, 0); assert.equal(h.calls.revisionWrites, 0);
  } finally { console.error = originalError; doc.destroy(); }
});

test('quarantined opening returns scoped metadata without disk bytes, a hash, a revision or state changes', async () => {
  const h = await harness();
  const state = h.controls.state!;
  h.controls.state = { ...state, degraded: true, projectionError: { code: 'COLLABORATION_SCHEMA_INVALID',
    phase: 'snapshot_validate', sequence: 2, permanent: true } };
  const binary = Buffer.from(state.yjsState);
  const originalError = console.error; console.error = () => undefined;
  try {
    assert.equal((await h.read()).status, 409, 'ordinary content reads stay closed');
    h.controls.bootstrap = true;
    const response = await h.read(); assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.content, ''); assert.equal(data.contentUnavailable, true);
    assert.equal(data.stats.sha256, undefined); assert.equal(data.revision, null);
    assert.equal(data.collaboration.document.id, state.documentId);
    assert.equal(h.calls.diskReads, 0); assert.equal(h.calls.revisionWrites, 0);
    assert(h.controls.state);
    assert.deepEqual(Buffer.from(h.controls.state.yjsState), binary);
    assert.equal(h.controls.state.degraded, true);
    h.controls.state.documentId = 'foreign';
    assert.equal((await h.read()).status, 409, 'metadata cannot bypass the document identity check');
    h.controls.denied = true;
    assert.equal((await h.read()).status, 403);
  } finally { console.error = originalError; }
});

test('a pending binary-storage retry can read its validated persisted snapshot without clearing the failure', () => {
  const { state, collaboration } = fixture();
  const pending: PersistedCollaborationState = { ...state, degraded: true,
    projectionError: { code: 'COLLABORATION_YJS_PERSISTENCE_FAILED', phase: 'binary_persist',
      sequence: 2, permanent: false } };
  assert.equal(collaborativeReadSnapshot({ workspace, collaboration, state: pending })?.toString(), 'Price: 130 €\n');
  assert.equal(pending.degraded, true);
});

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
