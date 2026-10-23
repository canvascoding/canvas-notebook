import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { getSchema } from '@tiptap/core';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { createPlainTextYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { cloneNativeCollaborationDocument, deserializeNativeRecoveryPayload, serializeNativeRecoveryPayload,
  NativeDocumentRecoveryError } from '../app/lib/collaboration/native-document-recovery';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { nativeTableWidthFixture } from './helpers/rich-markdown-projection-fixtures';

function state(doc: Y.Doc, representation: PersistedCollaborationState['representation']): PersistedCollaborationState {
  return { documentId: 'source-document', workspaceId: 'native-recovery-workspace', organizationId: null,
    path: 'folder/note.md', representation, lifecycleGeneration: 7, schemaVersion: 1,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
    documentSequence: 13, persistedAt: 1000, checkpointSequence: 8, checkpointedAt: 999,
    canonicalHash: null, serializedHash: null, newlineStyle: 'crlf', hasBom: true,
    degraded: false, status: 'active',
    projectionError: { code: 'COLLABORATION_ROUNDTRIP_UNSTABLE', sequence: 13, permanent: false } };
}

for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
  test(`${representation}: private recovery preserves exact binary and profile despite unavailable Markdown`, () => {
    const doc = nativeTableWidthFixture(representation, 'A\tB\r\n😀');
    try {
      doc.getText('frontmatter').insert(0, '---\r\ntitle: Private fixture\r\n---\r\n');
      doc.getText('bodyFinalLineEnding').insert(0, '\r\n\r\n');
      assert.equal(validateRichMarkdownYDoc(doc).valid, false);
      const source = state(doc, representation);
      const encoded = serializeNativeRecoveryPayload([{ lineageId: 'source-lineage', state: source }]);
      const [decoded] = deserializeNativeRecoveryPayload(encoded);
      assert.equal(decoded.lineageId, 'source-lineage');
      assert.deepEqual(decoded.state, source);
      assert.deepEqual(authoritativeNativeCollaborationSnapshot(decoded.state), authoritativeNativeCollaborationSnapshot(source));
      assert.throws(() => deserializeNativeRecoveryPayload(Buffer.concat([encoded, Buffer.from([0])])), NativeDocumentRecoveryError);
      assert.throws(() => deserializeNativeRecoveryPayload(encoded.subarray(0, -1)), NativeDocumentRecoveryError);
      const corrupted = Buffer.from(encoded); corrupted[corrupted.length - 1] ^= 1;
      assert.throws(() => deserializeNativeRecoveryPayload(corrupted), NativeDocumentRecoveryError);
    } finally { doc.destroy(); }
  });

  test(`${representation}: independent semantic clone retains widths, marks, text and metadata`, () => {
    const doc = nativeTableWidthFixture(representation, 'A\tB\r\n😀');
    try {
      doc.getText('frontmatter').insert(0, '---\r\ntitle: Clone fixture\r\n---\r\n');
      doc.getText('bodyFinalLineEnding').insert(0, '\r\n\r\n');
      const source = state(doc, representation);
      const before = authoritativeNativeCollaborationSnapshot(source);
      const cloned = cloneNativeCollaborationDocument(source);
      try {
        const after = authoritativeNativeCollaborationSnapshot(state(cloned.doc, representation));
        assert.notEqual(after.version.stateProof, before.version.stateProof);
        assert.notEqual(after.version.stateVector, before.version.stateVector);
        assert.equal(after.content.kind, 'rich_text');
        assert.ok(Object.keys(cloned.blockIdMapping).length > 0);
        assert.equal(new Set(Object.values(cloned.blockIdMapping)).size, Object.keys(cloned.blockIdMapping).length);
        assert.ok(Object.keys(cloned.blockIdMapping).every(id => !Object.values(cloned.blockIdMapping).includes(id)));
        for (const clientId of cloned.doc.store.clients.keys()) assert.equal(doc.store.clients.has(clientId), false);
        if (after.content.kind === 'rich_text' && before.content.kind === 'rich_text') {
          const mapped = structuredClone(before.content.document);
          const remap = (node: typeof mapped) => {
            if (node.attrs?.id) node.attrs.id = cloned.blockIdMapping[node.attrs.id];
            for (const child of node.content ?? []) remap(child);
          }; remap(mapped);
          assert.deepEqual(JSON.parse(JSON.stringify(after.content.document)), JSON.parse(JSON.stringify(mapped)));
          assert.equal(after.content.frontmatter, before.content.frontmatter);
          assert.equal(after.content.bodyFinalLineEnding, before.content.bodyFinalLineEnding);
          assert.match(JSON.stringify(after.content.document), /"colwidth":\[120\]/u);
        }
        assert.deepEqual(source, state(doc, representation));
        if (representation === 'tiptap_blocks') {
          const tree = new CollaborationBlockTree(cloned.doc, getSchema(richMarkdownSchemaExtensions()));
          assert.equal(tree.operations.size, 0); assert.equal(tree.receipts.size, 0);
        }
      } finally { cloned.doc.destroy(); }
    } finally { doc.destroy(); }
  });

  test(`${representation}: unknown native attrs stay in backup and block semantic clone`, () => {
    const doc = nativeTableWidthFixture(representation);
    try {
      if (representation === 'tiptap_blocks') {
        const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
        const record = [...tree.records.values()][0];
        (record.get('attributes') as Y.Map<unknown>).set('futureAttribute', { retained: true });
      } else {
        (doc.getXmlFragment('body').get(0) as Y.XmlElement).setAttribute('futureAttribute', 'retained');
      }
      const source = state(doc, representation);
      const [decoded] = deserializeNativeRecoveryPayload(serializeNativeRecoveryPayload([{ lineageId: 'source-lineage', state: source }]));
      assert.deepEqual(decoded.state.yjsState, source.yjsState);
      assert.throws(() => cloneNativeCollaborationDocument(source), NativeDocumentRecoveryError);
    } finally { doc.destroy(); }
  });
}

test('plain clone preserves exact native text with fresh CRDT identity; malformed payloads stay unavailable', () => {
  const doc = createPlainTextYDoc('A\tB\r\n😀');
  try {
    const source = { ...state(doc, 'plain_text'), projectionError: undefined };
    const cloned = cloneNativeCollaborationDocument(source);
    try {
      assert.equal(cloned.doc.getText('content').toString(), doc.getText('content').toString());
      assert.deepEqual(Object.keys(cloned.blockIdMapping), []);
      for (const clientId of cloned.doc.store.clients.keys()) assert.equal(doc.store.clients.has(clientId), false);
    } finally { cloned.doc.destroy(); }
    assert.throws(() => serializeNativeRecoveryPayload([{ lineageId: '', state: source }]), NativeDocumentRecoveryError);
    assert.throws(() => serializeNativeRecoveryPayload([{ lineageId: 'lineage', state: source }, { lineageId: 'lineage', state: source }]), NativeDocumentRecoveryError);
    assert.throws(() => deserializeNativeRecoveryPayload(Buffer.from('invalid')), NativeDocumentRecoveryError);
    doc.getMap('futureRoot').set('private', 'preserved');
    const withUnknown = state(doc, 'plain_text');
    assert.deepEqual(deserializeNativeRecoveryPayload(serializeNativeRecoveryPayload([{ lineageId: 'lineage', state: withUnknown }]))[0].state, withUnknown);
    assert.throws(() => cloneNativeCollaborationDocument(withUnknown), NativeDocumentRecoveryError);
  } finally { doc.destroy(); }
});

test('recovery rejects invalid typed metadata, duplicate scope, unknown header fields and changed proofs', () => {
  const doc = createPlainTextYDoc('Private native metadata fixture');
  try {
    const valid = serializeNativeRecoveryPayload([{ lineageId: 'source-lineage', state: state(doc, 'plain_text') }]);
    const changeHeader = (change: (value: { version: number; records: Array<Record<string, unknown>> }) => void) => {
      const size = valid.readUInt32BE(8);
      const value = JSON.parse(valid.subarray(12, 12 + size).toString('utf8'));
      change(value);
      const header = Buffer.from(JSON.stringify(value));
      const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
      return Buffer.concat([valid.subarray(0, 8), length, header, valid.subarray(12 + size)]);
    };
    for (const [field, bad] of [['documentId', 7], ['workspaceId', true], ['path', '../escape.md'],
      ['organizationId', []], ['lineageId', 0], ['hasBom', 1], ['projectionFinalized', 'yes'],
      ['checkpointedAt', 'today'], ['canonicalHash', 'not-a-hash'], ['stateProof', 'false-proof']] as const) {
      assert.throws(() => deserializeNativeRecoveryPayload(changeHeader(header => { header.records[0][field] = bad; })), NativeDocumentRecoveryError, field);
    }
    assert.throws(() => deserializeNativeRecoveryPayload(changeHeader(header => { (header as Record<string, unknown>).future = true; })), NativeDocumentRecoveryError);
    assert.throws(() => deserializeNativeRecoveryPayload(changeHeader(header => {
      header.records[0].projectionError = { code: 'COLLABORATION_CHECKPOINT_FAILED', sequence: 1, permanent: false, future: 'secret' };
    })), NativeDocumentRecoveryError);
    const other = { ...state(doc, 'plain_text'), documentId: 'other-document' };
    assert.throws(() => serializeNativeRecoveryPayload([{ lineageId: 'source-lineage', state: state(doc, 'plain_text') },
      { lineageId: 'other-lineage', state: other }]), NativeDocumentRecoveryError);
  } finally { doc.destroy(); }
});

test('XML unknown link mark attributes are preserved privately and never normalized into a clone', () => {
  const doc = nativeTableWidthFixture('tiptap_xml');
  try {
    const visit = (fragment: Y.XmlFragment): boolean => {
      for (const child of fragment.toArray()) {
        if (child instanceof Y.XmlText) {
          for (const part of child.toDelta()) {
            if (part.attributes?.link) {
              child.format(0, child.length, { link: { ...part.attributes.link, futurePrivateAttr: 'must-stay' } });
              return true;
            }
          }
        } else if (child instanceof Y.XmlElement && visit(child)) return true;
      }
      return false;
    };
    assert.equal(visit(doc.getXmlFragment('body')), true);
    const source = state(doc, 'tiptap_xml');
    const [recovered] = deserializeNativeRecoveryPayload(serializeNativeRecoveryPayload([{ lineageId: 'source-lineage', state: source }]));
    assert.deepEqual(recovered.state.yjsState, source.yjsState);
    assert.throws(() => cloneNativeCollaborationDocument(source), NativeDocumentRecoveryError);
  } finally { doc.destroy(); }
});
