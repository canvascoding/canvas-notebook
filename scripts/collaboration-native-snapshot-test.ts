import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { CollaborationBlockTree, BLOCK_TREE_KEY } from '../app/lib/collaboration/block-tree';
import { authoritativeCollaborationSnapshot } from '../app/lib/collaboration/checkpoint';
import { installCollaborationDocumentReader, readCurrentCollaborationDocument } from '../app/lib/collaboration/document-access';
import { authoritativeNativeCollaborationSnapshot, inspectPersistedNativeCollaborationSnapshot, readNativeCollaborationDocument } from '../app/lib/collaboration/document-snapshot';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const workspace: WorkspaceContext = {
  workspaceId: 'native-workspace', organizationId: null, workspaceType: 'personal',
  rootPath: '/no-native-test-files', legacy: false, status: 'active',
  permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true,
    canManageWorkspace: true, canRunAgent: true },
};

function stateFor(doc: Y.Doc, representation: PersistedCollaborationState['representation']): PersistedCollaborationState {
  return {
    documentId: 'native-document', workspaceId: workspace.workspaceId, organizationId: null,
    path: 'note.md', representation, lifecycleGeneration: 1, schemaVersion: 1,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
    documentSequence: 7, checkpointSequence: 0, persistedAt: 100, checkpointedAt: null,
    canonicalHash: null, serializedHash: null, newlineStyle: 'lf', hasBom: false,
    degraded: false, status: 'active',
  };
}

function nativeOnlyDocument(): Y.Doc {
  const doc = createRichMarkdownYDoc('| Keep |\n| --- |\n| [Target](target.md) |', 'tiptap_blocks');
  const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
  for (const record of tree.records.values()) {
    if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
      (record.get('attributes') as Y.Map<unknown>).set('colwidth', [120]);
    }
  }
  tree.read().check();
  assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
  return doc;
}

test('native persisted snapshot keeps rich structure when Markdown export loses table widths', () => {
  const doc = nativeOnlyDocument();
  try {
    const state = stateFor(doc, 'tiptap_blocks');
    state.projectionError = { code: 'COLLABORATION_ROUNDTRIP_UNSTABLE', sequence: 7, permanent: false };
    const before = structuredClone(state);
    const native = authoritativeNativeCollaborationSnapshot(state);
    assert.equal(native.source, 'persisted_yjs');
    assert.equal(native.version.documentSequence, 7);
    assert.equal(native.projection.checkpointSequence, 0);
    assert.equal(native.version.stateProof, collaborationStateProof(doc, Y));
    assert.equal(native.content.kind, 'rich_text');
    if (native.content.kind === 'rich_text') {
      assert.match(JSON.stringify(native.content.document), /target\.md/u);
      assert.match(JSON.stringify(native.content.document), /"colwidth":\[120\]/u);
    }
    assert.throws(() => authoritativeCollaborationSnapshot(state), /roundtrip_unstable/u);
    assert.deepEqual(state, before, 'native inspection never changes binary, clocks, errors or byte profile');
    inspectPersistedNativeCollaborationSnapshot(state, (sameDoc, sameSnapshot) => {
      assert.equal(collaborationStateProof(sameDoc, Y), native.version.stateProof);
      assert.deepEqual(sameSnapshot, native);
    });
  } finally { doc.destroy(); }
});

test('plain snapshots preserve exact native characters and certify deletions beyond the state vector', () => {
  const doc = createPlainTextYDoc('A\tB\r\n😀\n');
  try {
    const state = stateFor(doc, 'plain_text');
    const before = authoritativeNativeCollaborationSnapshot(state);
    assert.deepEqual(before.content, { kind: 'plain_text', text: 'A\tB\r\n😀\n' });
    doc.getText('content').delete(0, 1);
    const after = authoritativeNativeCollaborationSnapshot(stateFor(doc, 'plain_text'));
    assert.equal(before.version.stateVector, after.version.stateVector);
    assert.notEqual(before.version.stateProof, after.version.stateProof);
  } finally { doc.destroy(); }
});

test('native snapshots reject corrupt vectors, archived identities, quarantine and invalid representation', () => {
  const doc = nativeOnlyDocument();
  try {
    const state = stateFor(doc, 'tiptap_blocks');
    assert.throws(() => authoritativeNativeCollaborationSnapshot({ ...state, stateVector: new Uint8Array([0]) }), /vector/u);
    assert.throws(() => authoritativeNativeCollaborationSnapshot({ ...state, status: 'archived' }), /identity/u);
    assert.throws(() => authoritativeNativeCollaborationSnapshot({ ...state, lifecycleGeneration: 0 }), /identity/u);
    assert.throws(() => authoritativeNativeCollaborationSnapshot({ ...state, schemaVersion: 2 }), /identity/u);
    for (const change of [{ documentId: 1 }, { workspaceId: {} }, { path: '../escaped.md' },
      { path: '/absolute.md' }, { path: 'safe\\unsafe.md' }, { organizationId: 7 },
      { degraded: 'false' }, { persistedAt: -1 }]) {
      assert.throws(() => authoritativeNativeCollaborationSnapshot({ ...state, ...change } as unknown as PersistedCollaborationState), /identity/u);
    }
    assert.throws(() => authoritativeNativeCollaborationSnapshot({ ...state, degraded: true }), /quarantined/u);
    assert.throws(() => authoritativeNativeCollaborationSnapshot({ ...state,
      projectionError: { code: 'COLLABORATION_ROUNDTRIP_UNSTABLE', sequence: 7, permanent: true } }), /quarantined/u);
    assert.throws(() => authoritativeNativeCollaborationSnapshot({ ...state, representation: 'tiptap_xml' }), /schema_invalid/u);
    assert.throws(() => authoritativeNativeCollaborationSnapshot({ ...state, representation: 'plain_text' }), /schema_invalid/u);
    const empty = new Y.Doc();
    try { assert.throws(() => authoritativeNativeCollaborationSnapshot(stateFor(empty, 'tiptap_blocks')), /schema_invalid/u); }
    finally { empty.destroy(); }
    const xml = createRichMarkdownYDoc('Keep XML content', 'tiptap_xml');
    try {
      assert.equal(authoritativeNativeCollaborationSnapshot(stateFor(xml, 'tiptap_xml')).content.kind, 'rich_text');
      assert.throws(() => authoritativeNativeCollaborationSnapshot(stateFor(xml, 'plain_text')), /schema_invalid/u);
      xml.getText('content').insert(0, 'hidden competing content');
      assert.throws(() => authoritativeNativeCollaborationSnapshot(stateFor(xml, 'tiptap_xml')), /schema_invalid/u);
    } finally { xml.destroy(); }
  } finally { doc.destroy(); }
});

test('the existing persisted fallback supplies the exact same scoped metadata as its hydrated document', async () => {
  const doc = createPlainTextYDoc('fallback text');
  try {
    const state = stateFor(doc, 'plain_text');
    const snapshot = await readCurrentCollaborationDocument({
      documentId: state.documentId, workspaceId: state.workspaceId,
      loadState: async () => state,
      read: (hydrated, metadata) => {
        assert.equal(metadata, state);
        assert.equal(collaborationStateProof(hydrated, Y), authoritativeNativeCollaborationSnapshot(metadata!).version.stateProof);
        return authoritativeNativeCollaborationSnapshot(metadata!);
      },
    });
    assert.deepEqual(snapshot.content, { kind: 'plain_text', text: 'fallback text' });
  } finally { doc.destroy(); }
});

test('native inspection refuses trailing bytes, asynchronous callbacks and mutations under an old proof', () => {
  const doc = createPlainTextYDoc('durable');
  try {
    const state = stateFor(doc, 'plain_text');
    const before = structuredClone(state);
    for (const suffix of [new Uint8Array([0]), new Uint8Array([255, 255])]) {
      const bytes = new Uint8Array(state.yjsState.length + suffix.length);
      bytes.set(state.yjsState); bytes.set(suffix, state.yjsState.length);
      assert.throws(() => authoritativeNativeCollaborationSnapshot({ ...state, yjsState: bytes }), /trailing bytes/u);
    }
    assert.throws(() => inspectPersistedNativeCollaborationSnapshot(state, async (_doc, snapshot) => snapshot), /synchronous/u);
    assert.throws(() => inspectPersistedNativeCollaborationSnapshot(state, (inspected, snapshot) => {
      inspected.getText('content').insert(0, 'uncertified ');
      return snapshot;
    }), /must not change/u);
    assert.deepEqual(state, before);
    assert.deepEqual(authoritativeNativeCollaborationSnapshot(state).content, { kind: 'plain_text', text: 'durable' });
  } finally { doc.destroy(); }
});

test('native snapshots reject duplicate/missing IDs and competing rich roots without an export', () => {
  for (const variant of ['duplicate', 'missing', 'competing'] as const) {
    const doc = createRichMarkdownYDoc('First\n\nSecond', 'tiptap_blocks');
    try {
      const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
      const paragraphs = [...tree.records.entries()].filter(([, record]) => (record.get('shape') as { type: string }).type === 'paragraph');
      if (variant === 'competing') {
        const text = new Y.XmlText(); text.insert(0, 'Foreign body');
        const element = new Y.XmlElement('paragraph'); element.insert(0, [text]);
        doc.getXmlFragment('body').insert(0, [element]);
      } else {
        const attributes = paragraphs[1][1].get('attributes') as Y.Map<unknown>;
        if (variant === 'missing') attributes.delete('id');
        else attributes.set('id', (paragraphs[0][1].get('attributes') as Y.Map<unknown>).get('id'));
      }
      assert.throws(() => authoritativeNativeCollaborationSnapshot(stateFor(doc, 'tiptap_blocks')),
        /schema_invalid|stable_id_missing|stable_id_duplicate/u, variant);
    } finally { doc.destroy(); }
  }
});

test('a partial update with unintegrated structures cannot receive a complete native proof', () => {
  const doc = createPlainTextYDoc('base');
  try {
    const vector = Y.encodeStateVector(doc);
    doc.getText('content').insert(4, ' next');
    const partial = Y.encodeStateAsUpdate(doc, vector);
    const state = stateFor(doc, 'plain_text'); state.yjsState = partial;
    assert.throws(() => authoritativeNativeCollaborationSnapshot(state), /incomplete updates/u);
  } finally { doc.destroy(); }
});

test('live reads distinguish newer observed content from the last confirmed durable proof', async () => {
  const doc = createPlainTextYDoc('durable');
  const state = stateFor(doc, 'plain_text');
  const uninstall = installCollaborationDocumentReader(async (_id, _workspaceId, read) => read(doc, state));
  try {
    const input = { workspace, documentId: state.documentId, path: state.path, lifecycleGeneration: 1 };
    const durable = await readNativeCollaborationDocument(input);
    assert.equal(durable.observed.durable, true);
    assert.equal(durable.source, 'persisted_yjs');
    doc.getText('content').insert(7, ' plus live');
    const live = await readNativeCollaborationDocument(input);
    assert.equal(live.source, 'live_yjs');
    assert.deepEqual(live.observed.content, { kind: 'plain_text', text: 'durable plus live' });
    assert.equal(live.observed.durable, false);
    assert.equal(live.durable.documentSequence, 7);
    assert.equal(live.durable.stateProof, durable.durable.stateProof);
    assert.notEqual(live.observed.stateProof, live.durable.stateProof);
    assert.equal('documentSequence' in live.observed, false, 'older sequence cannot certify newer live text');
    state.yjsState = Y.encodeStateAsUpdate(doc); state.stateVector = Y.encodeStateVector(doc); state.documentSequence++;
    assert.equal((await readNativeCollaborationDocument(input)).observed.durable, true);
  } finally { uninstall(); doc.destroy(); }
});

test('native room reads bind workspace, organization, path and lifecycle and retain permanent quarantine', async () => {
  const doc = nativeOnlyDocument();
  const state = stateFor(doc, 'tiptap_blocks');
  let reads = 0;
  const uninstall = installCollaborationDocumentReader(async (_id, _workspaceId, read) => { reads++; return read(doc, state); });
  try {
    const input = { workspace, documentId: state.documentId, path: state.path, lifecycleGeneration: 1 };
    await assert.rejects(readNativeCollaborationDocument({ ...input,
      workspace: { ...workspace, permissions: { ...workspace.permissions, canRead: false } } }), /unavailable/u);
    assert.equal(reads, 0);
    await assert.rejects(readNativeCollaborationDocument({ ...input, path: 'replacement.md' }), /changed/u);
    await assert.rejects(readNativeCollaborationDocument({ ...input, documentId: 'foreign' }), /changed/u);
    await assert.rejects(readNativeCollaborationDocument({ ...input, lifecycleGeneration: 2 }), /changed/u);
    await assert.rejects(readNativeCollaborationDocument({ ...input, workspace: { ...workspace, organizationId: 'foreign' } }), /changed/u);
    const native = await readNativeCollaborationDocument(input);
    assert.equal(native.observed.durable, true);
    state.degraded = true;
    await assert.rejects(readNativeCollaborationDocument(input), /quarantined/u);
    assert.equal(state.degraded, true);
    assert(doc.share.has(BLOCK_TREE_KEY));
  } finally { uninstall(); doc.destroy(); }
});
