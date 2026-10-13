import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import { inspectArchivedNativeSnapshot } from '../app/lib/collaboration/archived-native-snapshot';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { Y } from '../app/lib/collaboration/server-runtime';
import { COLLABORATION_SCHEMA_VERSION } from '../app/lib/collaboration/types';

function stateFor(doc: InstanceType<typeof Y.Doc>, representation: PersistedCollaborationState['representation'] = 'plain_text'): PersistedCollaborationState {
  return { documentId: 'archived-doc', workspaceId: 'archive-workspace', organizationId: null, path: 'original.md',
    representation, lifecycleGeneration: 2, schemaVersion: COLLABORATION_SCHEMA_VERSION,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: 7, persistedAt: 100,
    checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null,
    newlineStyle: 'crlf', hasBom: true, degraded: false, status: 'archived' };
}

test('archived inspection preserves actual status, CRDT history and exact native characters without authorizing active reads', () => {
  const doc = createPlainTextYDoc('Keep 😀\r\n');
  try {
    const state = stateFor(doc), original = structuredClone(state), snapshot = inspectArchivedNativeSnapshot(state);
    assert.equal(snapshot.status, 'archived'); assert.equal(snapshot.lifecycleGeneration, 2);
    assert.deepEqual(snapshot.content, { kind: 'plain_text', text: 'Keep 😀\r\n' });
    assert.throws(() => authoritativeNativeCollaborationSnapshot(state), /identity/u);
    assert.throws(() => inspectArchivedNativeSnapshot({ ...state, status: 'active' }), /archived/u);
    assert.deepEqual(state, original);
    doc.getText('content').delete(0, 1);
    const deleted = inspectArchivedNativeSnapshot(stateFor(doc));
    assert.equal(deleted.version.stateVector, snapshot.version.stateVector);
    assert.notEqual(deleted.version.stateProof, snapshot.version.stateProof);
  } finally { doc.destroy(); }
});

test('archived nonexportable Rich structure and stable node IDs survive native inspection', () => {
  const doc = createRichMarkdownYDoc('| Keep |\n| --- |\n| [Target](target.md) |', 'tiptap_blocks');
  try {
    const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
    for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
      (record.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth', [120]);
    }
    assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
    const state = stateFor(doc, 'tiptap_blocks');
    state.projectionError = { code: 'COLLABORATION_ROUNDTRIP_UNSTABLE', sequence: 7, permanent: false };
    const before = structuredClone(state), snapshot = inspectArchivedNativeSnapshot(state);
    assert.match(JSON.stringify(snapshot.content), /"colwidth":\[120\]/u); assert.deepEqual(state, before);
  } finally { doc.destroy(); }
});

test('archived snapshot rejects quarantine, schema/scope/type drift, mismatched vectors and trailing bytes', () => {
  const doc = createPlainTextYDoc('Exact');
  try {
    const state = stateFor(doc);
    for (const change of [{ degraded: true }, { schemaVersion: 3 }, { lifecycleGeneration: 0 }, { path: '../escape.md' },
      { checkpointSequence: 8 }, { stateVector: new Uint8Array([0]) }, { representation: 'tiptap_xml' },
      { projectionError: { code: 'COLLABORATION_ROUNDTRIP_UNSTABLE', sequence: 7, permanent: true } }]) {
      assert.throws(() => inspectArchivedNativeSnapshot({ ...state, ...change } as PersistedCollaborationState));
    }
    assert.throws(() => inspectArchivedNativeSnapshot({ ...state, yjsState: Uint8Array.from([...state.yjsState, 0]) }), /trailing/u);
  } finally { doc.destroy(); }
});

test('unintegrated Yjs dependency and pending deletion are never complete archived authority', () => {
  const doc = new Y.Doc(); let base: Uint8Array, increment: Uint8Array, deletion: Uint8Array;
  try {
    doc.getText('content').insert(0, 'base'); base = Y.encodeStateVector(doc);
    doc.getText('content').insert(4, ' dependent'); increment = Y.encodeStateAsUpdate(doc, base);
    doc.getText('content').delete(0, 2); deletion = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc));
    for (const update of [increment, deletion]) {
      assert.throws(() => inspectArchivedNativeSnapshot({ ...stateFor(new Y.Doc()), yjsState: update, stateVector: new Uint8Array([0]) }), /incomplete/u);
    }
  } finally { doc.destroy(); }
});

for (const variant of ['xml-node-attribute', 'block-node-attribute', 'block-record-field', 'plain-unknown-root',
  'xml-mark-attribute', 'block-mark-attribute', 'block-operation-field'] as const) {
  test(`archived raw schema rejects ${variant} before normalization and preserves original bytes`, () => {
    const representation = variant === 'plain-unknown-root' ? 'plain_text' : variant.startsWith('xml') ? 'tiptap_xml' : 'tiptap_blocks';
    const schema = getSchema(richMarkdownSchemaExtensions());
    const doc = representation === 'plain_text' ? createPlainTextYDoc('Exact')
      : createRichMarkdownYDoc(variant.includes('mark') ? '[Target](target.md)' : 'Exact', representation);
    try {
      if (variant === 'xml-node-attribute') (doc.getXmlFragment('body').toArray()[0] as InstanceType<typeof Y.XmlElement>)
        .setAttribute('unknown-future-attr', 'private-marker');
      if (variant === 'block-node-attribute' || variant === 'block-record-field') {
        const record = [...new CollaborationBlockTree(doc, schema).records.values()][0];
        if (variant === 'block-node-attribute') (record.get('attributes') as InstanceType<typeof Y.Map>).set('unknown-future-attr', 'private-marker');
        else record.set('unknown-future-field', 'private-marker');
      }
      if (variant === 'plain-unknown-root') doc.getMap('unknown-future-root').set('hidden', 'private-marker');
      if (variant === 'xml-mark-attribute' || variant === 'block-mark-attribute') {
        let marked = false;
        const visit = (fragment: InstanceType<typeof Y.XmlFragment>) => {
          for (const child of fragment.toArray()) {
            if (child instanceof Y.XmlText) {
              for (const part of child.toDelta()) if (part.attributes?.link) {
                child.format(0, child.length, { link: { ...part.attributes.link, futureField: 'private-marker' } }); marked = true;
              }
            } else if (child instanceof Y.XmlElement) visit(child);
          }
        };
        if (representation === 'tiptap_xml') visit(doc.getXmlFragment('body'));
        else for (const record of new CollaborationBlockTree(doc, schema).records.values()) visit(record.get('content') as InstanceType<typeof Y.XmlFragment>);
        assert.equal(marked, true, 'The real persisted link mark must carry the unsupported field.');
      }
      if (variant === 'block-operation-field') {
        const tree = new CollaborationBlockTree(doc, schema), blockId = [...tree.records.keys()][0];
        tree.move({ blockId, parentId: null, beforeId: null, operationId: 'real-block-move' }, 'schema-fixture');
        const operation = tree.operations.get('real-block-move'); assert(operation);
        assert.equal(inspectArchivedNativeSnapshot(stateFor(doc, representation)).status, 'archived', 'The genuine move operation is valid before adding the unknown field.');
        const unsupportedOperation = { ...operation, futureField: 'private-marker' };
        tree.operations.set(operation.id, unsupportedOperation);
      }
      const state = stateFor(doc, representation), before = structuredClone(state), updateBefore = Y.encodeStateAsUpdate(doc);
      assert.throws(() => inspectArchivedNativeSnapshot(state), { code: 'schema_invalid' });
      assert.deepEqual(state, before);
      assert.deepEqual(Y.encodeStateAsUpdate(doc), updateBefore);
    } finally { doc.destroy(); }
  });
}
