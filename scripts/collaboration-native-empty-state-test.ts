import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { authoritativeNativeCollaborationSnapshot, inspectPersistedNativeCollaborationSnapshot,
  readNativeCollaborationDocument } from '../app/lib/collaboration/document-snapshot';
import { installCollaborationDocumentReader } from '../app/lib/collaboration/document-access';
import { createPlainTextYDoc, createRichMarkdownYDoc,
  richMarkdownFromYDoc, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { prepareMarkdownFileImport } from '../app/lib/collaboration/markdown-file-import';
import { serializeCanonicalText } from '../app/lib/collaboration/persistence';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { cloneNativeCollaborationDocument, deserializeNativeRecoveryPayload,
  serializeNativeRecoveryPayload } from '../app/lib/collaboration/native-document-recovery';
import { inspectPersistedDocumentLinks } from '../app/lib/markdown/workspace-native-link-inventory';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const workspace: WorkspaceContext = {
  workspaceId: 'empty-native-workspace', organizationId: null, workspaceType: 'personal',
  rootPath: '/no-empty-native-test-files', legacy: false, status: 'active',
  permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true,
    canManageWorkspace: true, canRunAgent: true },
};

function stateFor(doc: Y.Doc, representation: PersistedCollaborationState['representation'], documentSequence = 0): PersistedCollaborationState {
  return { documentId: 'empty-native-document', workspaceId: workspace.workspaceId, organizationId: null,
    path: 'empty.md', representation, lifecycleGeneration: 1, schemaVersion: 1,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence,
    persistedAt: 100, checkpointedAt: null, checkpointSequence: 0, canonicalHash: null, serializedHash: null,
    newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active', projectionFinalized: false };
}

function decoded(state: PersistedCollaborationState): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state.yjsState);
  return doc;
}

test('the real seq0 XML seed loses its declared empty root and reads without native mutation', () => {
  const seed = createRichMarkdownYDoc('', 'tiptap_xml');
  try {
    assert.deepEqual([...seed.share.keys()], ['body']);
    const state = stateFor(seed, 'tiptap_xml');
    assert.deepEqual(state.yjsState, Uint8Array.of(0, 0));
    assert.deepEqual(state.stateVector, Uint8Array.of(0));
    const before = structuredClone(state);
    const native = inspectPersistedNativeCollaborationSnapshot(state, (doc, snapshot) => {
      assert.deepEqual([...doc.share.keys()], [], 'inspection must not synthesize an XML, Plain or block root');
      assert.equal(doc.store.clients.size, 0);
      assert.equal(doc.store.pendingStructs, null);
      assert.equal(doc.store.pendingDs, null);
      assert.deepEqual(Y.encodeStateAsUpdate(doc), before.yjsState);
      assert.equal(snapshot.version.stateProof, collaborationStateProof(seed, Y));
      return snapshot;
    });
    assert.deepEqual(native.content, { kind: 'rich_text', document: { type: 'doc' }, frontmatter: '', bodyFinalLineEnding: '' });
    assert.equal(native.version.documentSequence, 0);
    assert.equal(native.lifecycleGeneration, 1);
    assert.equal(native.projection.checkpointedAt, null);
    assert.deepEqual(state, before, 'bytes, clocks, identity and pending projection stay unchanged');
  } finally { seed.destroy(); }
});

test('empty initialized XML with retained body tombstones keeps its genuine deletion history', () => {
  const doc = createRichMarkdownYDoc('Temporary paragraph', 'tiptap_xml');
  try {
    const populatedProof = collaborationStateProof(doc, Y);
    const vector = Y.encodeStateVector(doc);
    const body = doc.getXmlFragment('body');
    body.delete(0, body.length);
    const state = stateFor(doc, 'tiptap_xml', 3), hydrated = decoded(state);
    try {
      assert.equal(hydrated.share.has('body'), true);
      assert.ok(hydrated.store.clients.size > 0);
      assert.ok([...hydrated.store.clients.values()].flat().some(struct => struct.deleted));
      assert.deepEqual(state.stateVector, vector, 'deletion-only change preserves the vector');
      const native = authoritativeNativeCollaborationSnapshot(state);
      assert.deepEqual(native.content, { kind: 'rich_text', document: { type: 'doc' }, frontmatter: '', bodyFinalLineEnding: '' });
      assert.equal(native.version.documentSequence, 3);
      assert.equal(native.version.stateProof, collaborationStateProof(doc, Y));
      assert.notEqual(native.version.stateProof, populatedProof);
      assert.notDeepEqual(state.yjsState, Uint8Array.of(0, 0));
      const recovered = deserializeNativeRecoveryPayload(serializeNativeRecoveryPayload([{ lineageId: 'deleted-xml-lineage', state }]));
      assert.deepEqual(recovered[0].state.yjsState, state.yjsState, 'private recovery preserves every genuine XML deletion');
    } finally { hydrated.destroy(); }
  } finally { doc.destroy(); }
});

test('empty initialized block and Plain documents keep their declared representation and history', () => {
  for (const representation of ['tiptap_blocks', 'plain_text'] as const) {
    for (const hasHistory of [false, true]) {
      const doc = representation === 'plain_text' ? createPlainTextYDoc('') : createRichMarkdownYDoc('', representation);
      try {
        if (hasHistory) {
          if (representation === 'plain_text') {
            const text = doc.getText('content'); text.insert(0, 'Temporary'); text.delete(0, text.length);
          } else {
            // Keep the empty block seed's genuine block identity; no XML repair.
            const marker = doc.getText('frontmatter'); marker.insert(0, 'Temporary'); marker.delete(0, marker.length);
          }
        }
        const state = stateFor(doc, representation, hasHistory ? 2 : 0), before = structuredClone(state);
        const native = authoritativeNativeCollaborationSnapshot(state);
        assert.equal(native.representation, representation);
        assert.equal(native.version.stateProof, collaborationStateProof(doc, Y));
        if (representation === 'plain_text') assert.deepEqual(native.content, { kind: 'plain_text', text: '' });
        else {
          assert.equal(native.content.kind, 'rich_text');
          if (native.content.kind === 'rich_text') {
            assert.equal(native.content.document.content?.[0]?.type, 'paragraph');
            assert.equal(native.content.document.content?.[0]?.content, undefined);
            assert.equal(typeof native.content.document.content?.[0]?.attrs?.id, 'string');
          }
        }
        assert.deepEqual(state, before);
      } finally { doc.destroy(); }
    }
  }
});

test('empty XML is available through the existing live reader, graph, native recovery and fresh clone', async () => {
  const seed = createRichMarkdownYDoc('', 'tiptap_xml');
  const state = stateFor(seed, 'tiptap_xml'), before = structuredClone(state);
  const live = decoded(state);
  const restore = installCollaborationDocumentReader(async (_documentId, _workspaceId, read) => read(live, state));
  try {
    const read = await readNativeCollaborationDocument({ workspace, documentId: state.documentId, path: state.path });
    assert.equal(read.observed.durable, true);
    assert.deepEqual(read.observed.content, { kind: 'rich_text', document: { type: 'doc' }, frontmatter: '', bodyFinalLineEnding: '' });
    assert.deepEqual([...live.share.keys()], [], 'live inspection also leaves the rootless seed intact');
    const inventory = inspectPersistedDocumentLinks(state);
    assert.equal(inventory.coverage.complete, true);
    assert.deepEqual(inventory.links, []);
    const recovered = deserializeNativeRecoveryPayload(serializeNativeRecoveryPayload([{ lineageId: 'empty-lineage', state }]));
    assert.equal(recovered.length, 1);
    assert.deepEqual(recovered[0].state.yjsState, before.yjsState);
    assert.deepEqual(authoritativeNativeCollaborationSnapshot(recovered[0].state).content, read.observed.content);
    const clone = cloneNativeCollaborationDocument(state);
    try {
      const clonedState = stateFor(clone.doc, 'tiptap_xml');
      assert.deepEqual(authoritativeNativeCollaborationSnapshot(clonedState).content, read.observed.content);
      assert.equal(Object.getPrototypeOf(clone.blockIdMapping), null);
      assert.deepEqual(Object.keys(clone.blockIdMapping), []);
    } finally { clone.doc.destroy(); }
    assert.deepEqual(state, before);
  } finally { restore(); live.destroy(); seed.destroy(); }
});

test('legal metadata-only XML files and deleted bodies retain their complete native metadata', () => {
  for (const source of ['---\ntitle: Metadata\n---\n', '\n', '---\ntitle: Metadata\n---\n\n']) {
    const seed = createRichMarkdownYDoc(source, 'tiptap_xml');
    try {
      const state = stateFor(seed, 'tiptap_xml'), before = structuredClone(state);
      const native = inspectPersistedNativeCollaborationSnapshot(state, (doc, snapshot) => {
        assert.equal(doc.share.has('body'), false, 'the real empty XML body was omitted from the update');
        assert.ok(doc.share.size > 0);
        assert.ok([...doc.share.keys()].every(name => ['frontmatter', 'bodyFinalLineEnding'].includes(name)));
        assert.deepEqual(Y.encodeStateAsUpdate(doc), before.yjsState);
        return snapshot;
      });
      assert.equal(native.content.kind, 'rich_text');
      if (native.content.kind === 'rich_text') {
        assert.deepEqual(native.content.document, { type: 'doc' });
        assert.equal(native.content.frontmatter + native.content.bodyFinalLineEnding, source);
      }
      const recovered = decoded(state);
      try { assert.equal(richMarkdownFromYDoc(recovered), source); }
      finally { recovered.destroy(); }
      assert.deepEqual(state, before);
    } finally { seed.destroy(); }
  }
  const seed = createRichMarkdownYDoc('---\ntitle: Retained\n---\nParagraph\n', 'tiptap_xml');
  try {
    const body = seed.getXmlFragment('body'); body.delete(0, body.length);
    const state = stateFor(seed, 'tiptap_xml', 5), native = authoritativeNativeCollaborationSnapshot(state);
    assert.equal(native.content.kind, 'rich_text');
    if (native.content.kind === 'rich_text') {
      assert.deepEqual(native.content.document, { type: 'doc' });
      assert.equal(native.content.frontmatter, '---\ntitle: Retained\n---\n');
      assert.equal(native.content.bodyFinalLineEnding, '\n');
    }
    assert.equal(native.version.stateProof, collaborationStateProof(seed, Y));
  } finally { seed.destroy(); }
});

test('complete XML imports of empty, BOM-only, metadata-only and blank-line files remain original-byte exact', () => {
  for (const source of ['', '\uFEFF', '\n', '\r\n', '---\ntitle: Metadata\n---\n', '\uFEFF---\r\ntitle: Metadata\r\n---\r\n']) {
    const prepared = prepareMarkdownFileImport(Buffer.from(source), { representation: 'tiptap_xml' });
    const seed = new Y.Doc();
    try {
      const state = { ...stateFor(seed, 'tiptap_xml'), yjsState: prepared.yjsState, stateVector: prepared.stateVector,
        hasBom: prepared.hasBom, newlineStyle: prepared.newlineStyle };
      const native = authoritativeNativeCollaborationSnapshot(state);
      assert.equal(prepared.sourceFallbackReason, undefined);
      assert.equal(native.representation, 'tiptap_xml');
      assert.equal(native.content.kind, 'rich_text');
      assert.equal(serializeCanonicalText(prepared.canonical, prepared), source);
      if (native.content.kind === 'rich_text') {
        assert.deepEqual(native.content.document, { type: 'doc' });
        assert.equal(native.content.frontmatter + native.content.bodyFinalLineEnding, prepared.canonical);
      }
      assert.deepEqual(state.yjsState, prepared.yjsState);
    } finally { seed.destroy(); }
  }
});

test('nontext metadata, nonempty competing roots and foreign deleted histories do not repair a missing XML body', () => {
  const variants = [
    ['map metadata', (doc: Y.Doc) => doc.getMap('frontmatter').set('value', 'Hidden content')],
    ['marked metadata', (doc: Y.Doc) => doc.getText('frontmatter').insert(0, 'Metadata', { futureMark: true })],
    ['embedded metadata', (doc: Y.Doc) => doc.getText('bodyFinalLineEnding').insertEmbed(0, { future: true })],
    ['Plain content', (doc: Y.Doc) => doc.getText('content').insert(0, 'Hidden text')],
    ['unknown map', (doc: Y.Doc) => doc.getMap('future-root').set('value', 'Hidden content')],
    ['foreign deleted text', (doc: Y.Doc) => { const text = doc.getText('foreign'); text.insert(0, 'Temporary'); text.delete(0, text.length); }],
  ] as const;
  for (const [label, mutate] of variants) {
    const doc = new Y.Doc();
    try {
      mutate(doc);
      const state = stateFor(doc, 'tiptap_xml', 3), hydrated = decoded(state);
      try {
        assert.equal(hydrated.share.has('body'), false, label);
        assert.ok(hydrated.store.clients.size > 0, label);
        assert.throws(() => authoritativeNativeCollaborationSnapshot(state), /schema_invalid/u, label);
      } finally { hydrated.destroy(); }
    } finally { doc.destroy(); }
  }
});

test('GC-only missing-root history is structurally undecidable and is not an empty XML seed', () => {
  // A valid native update can contain only a GC struct, with no surviving root
  // name/type. Neither a deletion nor zero visible content proves a body root.
  const encoder = encoding.createEncoder();
  for (const value of [1, 1, 11, 0, 0, 1, 0]) encoding.writeVarUint(encoder, value);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, encoding.toUint8Array(encoder));
    assert.deepEqual([...doc.share.keys()], []);
    assert.equal(doc.store.clients.size, 1);
    assert.equal([...doc.store.clients.values()][0][0].constructor.name, 'GC');
    assert.equal(doc.store.pendingStructs, null);
    assert.equal(doc.store.pendingDs, null);
    assert.throws(() => authoritativeNativeCollaborationSnapshot(stateFor(doc, 'tiptap_xml', 3)), /schema_invalid/u);
  } finally { doc.destroy(); }
});

test('wrong declared body type, corrupt pending update and missing block root remain rejected', () => {
  const wrongType = new Y.Doc();
  const seed = new Y.Doc();
  try {
    wrongType.getMap('body').set('value', 'Hidden content');
    assert.throws(() => authoritativeNativeCollaborationSnapshot(stateFor(wrongType, 'tiptap_xml')), /schema_invalid/u);
    const hydratedWrongType = decoded(stateFor(wrongType, 'tiptap_xml'));
    try {
      assert.deepEqual(validateRichMarkdownYDoc(hydratedWrongType), { valid: false, code: 'schema_invalid' });
      assert.throws(() => richMarkdownFromYDoc(hydratedWrongType), /unsupported schema fields/u);
    } finally { hydratedWrongType.destroy(); }
    assert.throws(() => authoritativeNativeCollaborationSnapshot(stateFor(seed, 'tiptap_blocks')), /schema_invalid/u);
    const partial = new Y.Doc();
    const source = new Y.Doc();
    try {
      source.getText('content').insert(0, 'Base'); const vector = Y.encodeStateVector(source);
      source.getText('content').insert(4, 'Later'); Y.applyUpdate(partial, Y.encodeStateAsUpdate(source, vector));
      assert.ok(partial.store.pendingStructs);
      assert.throws(() => authoritativeNativeCollaborationSnapshot({ ...stateFor(seed, 'tiptap_xml'), yjsState: Y.encodeStateAsUpdate(partial) }), /incomplete/u);
    } finally { partial.destroy(); source.destroy(); }
  } finally { wrongType.destroy(); seed.destroy(); }
});

test('deleted Map fields retain their wrong-root type evidence and are never cleared to repair XML', () => {
  const source = new Y.Doc();
  try {
    const body = source.getMap('body'); body.set('value', 'Temporary'); body.delete('value');
    const state = stateFor(source, 'tiptap_xml', 2), before = structuredClone(state), hydrated = decoded(state);
    try {
      const root = hydrated.share.get('body');
      assert.ok(root);
      assert.equal(root._map.size, 1);
      assert.ok([...root._map.values()].every(item => item.deleted));
      assert.equal(root._start, null, 'Map tombstones are different from genuine XML item history');
      assert.throws(() => authoritativeNativeCollaborationSnapshot(state), /schema_invalid/u);
      assert.deepEqual(validateRichMarkdownYDoc(hydrated), { valid: false, code: 'schema_invalid' });
      assert.throws(() => serializeNativeRecoveryPayload([{ lineageId: 'wrong-type-lineage', state }]), /schema_invalid/u);
      assert.deepEqual(Y.encodeStateAsUpdate(hydrated), before.yjsState, 'the rejected native binary and deletion evidence remain intact');
      assert.deepEqual(state, before, 'backup rejection does not clear, normalize or replace native bytes');
    } finally { hydrated.destroy(); }
  } finally { source.destroy(); }
});
