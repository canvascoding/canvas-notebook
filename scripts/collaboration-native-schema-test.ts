import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';
import { BLOCK_TREE_KEY, CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { authoritativeCollaborationSnapshot } from '../app/lib/collaboration/checkpoint';
import { CollaborationCheckpointValidationError } from '../app/lib/collaboration/checkpoint-errors';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { richMarkdownFromYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc,
  validateRichMarkdownStructure } from '../app/lib/collaboration/markdown-state';
import { cloneNativeCollaborationDocument, deserializeNativeRecoveryPayload, serializeNativeRecoveryPayload,
  NativeDocumentRecoveryError } from '../app/lib/collaboration/native-document-recovery';
import { assertNativeDocumentSchema, NativeDocumentSchemaError } from '../app/lib/collaboration/native-document-schema';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { nativeRichDocumentFixture, nativeTableWidthFixture } from './helpers/rich-markdown-projection-fixtures';

const schema = getSchema(richMarkdownSchemaExtensions());
const formats = ['tiptap_xml', 'tiptap_blocks'] as const;
type Format = typeof formats[number];
function fixture(format: Format): Y.Doc {
  return nativeRichDocumentFixture({ type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'A\tB\r\n😀', marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'destination.md' } }] },
  ] }] }, format);
}
function persisted(doc: Y.Doc, representation: Format): PersistedCollaborationState {
  return { documentId: 'native-schema-document', workspaceId: 'native-schema-workspace', organizationId: null,
    path: 'note.md', representation, lifecycleGeneration: 3, schemaVersion: 1,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: 5,
    checkpointSequence: 2, persistedAt: 1000, checkpointedAt: 999, canonicalHash: null, serializedHash: null,
    newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
}
function inlineFragments(doc: Y.Doc, format: Format): Y.XmlFragment[] {
  return format === 'tiptap_xml' ? [doc.getXmlFragment('body')]
    : [...new CollaborationBlockTree(doc, schema).records.values()].map(record => record.get('content') as Y.XmlFragment);
}
function addUnknownMark(doc: Y.Doc, format: Format): void {
  let found = false;
  const visit = (fragment: Y.XmlFragment) => {
    for (const child of fragment.toArray()) {
      if (child instanceof Y.XmlText) {
        for (const part of child.toDelta()) if (part.attributes?.link) {
          child.format(0, child.length, { link: { ...part.attributes.link, futureUrl: 'private-destination.md' } }); found = true;
        }
      } else if (child instanceof Y.XmlElement) visit(child);
    }
  };
  for (const fragment of inlineFragments(doc, format)) visit(fragment);
  assert.equal(found, true, 'fixture must contain a real raw XML link mark');
}

for (const format of formats) {
  test(`${format}: recognized raw attributes, marks and controls remain losslessly exportable and cloneable`, () => {
    const doc = fixture(format);
    try {
      assert.doesNotThrow(() => assertNativeDocumentSchema(doc, format, schema));
      assert.equal(validateRichMarkdownYDoc(doc).valid, true);
      const source = persisted(doc, format);
      assert.ok(authoritativeCollaborationSnapshot(source).canonicalContent);
      const cloned = cloneNativeCollaborationDocument(source);
      try {
        assert.equal(validateRichMarkdownYDoc(cloned.doc).valid, true);
        assert.equal(richMarkdownFromYDoc(cloned.doc), richMarkdownFromYDoc(doc));
      } finally { cloned.doc.destroy(); }
    } finally { doc.destroy(); }
  });

  const cases: { name: string; inject: (doc: Y.Doc) => void }[] = [
    { name: 'unknown document root', inject: doc => { doc.getMap('future-native-root').set('futureUrl', 'private-destination.md'); } },
    { name: 'unknown native node attribute', inject: doc => {
      if (format === 'tiptap_xml') (doc.getXmlFragment('body').get(0) as Y.XmlElement).setAttribute('futureUrl', 'private-destination.md');
      else ([...new CollaborationBlockTree(doc, schema).records.values()][0].get('attributes') as Y.Map<unknown>)
        .set('futureUrl', 'private-destination.md');
    } },
    { name: 'unknown raw XML link mark attribute', inject: doc => addUnknownMark(doc, format) },
  ];
  if (format === 'tiptap_blocks') cases.push(
    { name: 'unknown block-tree root field', inject: doc => { doc.getMap(BLOCK_TREE_KEY).set('futureField', 'private'); } },
    { name: 'unknown block record field', inject: doc => { [...new CollaborationBlockTree(doc, schema).records.values()][0].set('futureField', 'private'); } },
    { name: 'unknown block shape field', inject: doc => {
      const record = [...new CollaborationBlockTree(doc, schema).records.values()][0];
      record.set('shape', { ...record.get('shape') as object, futureField: 'private' });
    } },
    { name: 'unknown initial-placement field', inject: doc => {
      const record = [...new CollaborationBlockTree(doc, schema).records.values()][0];
      record.set('initial', { ...record.get('initial') as object, futureField: 'private' });
    } },
    { name: 'unknown block receipt field', inject: doc => {
      const tree = new CollaborationBlockTree(doc, schema); const blockId = [...tree.records.keys()][0];
      tree.receipts.set('op-1', { id: 'op-1', clock: 1, actor: 1, transactionId: 'tx-1', ordinal: 0,
        kind: 'move', blockId, parentId: null, beforeId: null, futureField: 'private' } as never);
    } },
  );
  for (const item of cases) test(`${format}: ${item.name} remains binary-backed while clone/export/checkpoint reject normalization`, () => {
    const doc = fixture(format);
    try {
      assert.equal(validateRichMarkdownYDoc(doc).valid, true);
      const normalizedBefore = readRichDocumentJson(doc);
      item.inject(doc);
      const binary = Y.encodeStateAsUpdate(doc); const vector = Y.encodeStateVector(doc);
      assert.deepEqual(readRichDocumentJson(doc), normalizedBefore, 'PM normalization would hide this unsupported raw field');
      assert.equal(validateRichMarkdownStructure(doc).valid, true, 'native semantic inspection remains separate from strict export');
      const source = persisted(doc, format);
      assert.ok(authoritativeNativeCollaborationSnapshot(source));
      const [recovered] = deserializeNativeRecoveryPayload(serializeNativeRecoveryPayload([{ lineageId: 'native-schema-lineage', state: source }]));
      assert.deepEqual(recovered.state.yjsState, binary, 'private backup retains every opaque native byte');
      assert.deepEqual(recovered.state.stateVector, vector);
      assert.throws(() => assertNativeDocumentSchema(doc, format, schema), NativeDocumentSchemaError);
      assert.deepEqual(validateRichMarkdownYDoc(doc), { valid: false, code: 'schema_invalid' });
      assert.throws(() => richMarkdownFromYDoc(doc), NativeDocumentSchemaError);
      assert.throws(() => cloneNativeCollaborationDocument(source), NativeDocumentRecoveryError);
      assert.throws(() => authoritativeCollaborationSnapshot(source), error => error instanceof CollaborationCheckpointValidationError
        && error.validationCode === 'schema_invalid');
      assert.deepEqual(Y.encodeStateAsUpdate(doc), binary, 'rejection must not normalize or mutate native source');
      assert.deepEqual(Y.encodeStateVector(doc), vector);
    } finally { doc.destroy(); }
  });

  test(`${format}: recognized native table widths remain cloneable but unavailable as lossless GFM`, () => {
    const doc = nativeTableWidthFixture(format);
    try {
      assert.doesNotThrow(() => assertNativeDocumentSchema(doc, format, schema));
      assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
      const cloned = cloneNativeCollaborationDocument(persisted(doc, format));
      try { assert.match(JSON.stringify(readRichDocumentJson(cloned.doc)), /"colwidth":\[120\]/u); }
      finally { cloned.doc.destroy(); }
    } finally { doc.destroy(); }
  });
}
