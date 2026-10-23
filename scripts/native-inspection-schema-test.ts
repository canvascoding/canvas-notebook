import assert from 'node:assert/strict';
import test from 'node:test';
import type { Schema } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { authoritativeCollaborationSnapshot } from '../app/lib/collaboration/checkpoint';
import { CollaborationCheckpointValidationError } from '../app/lib/collaboration/checkpoint-errors';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownFromYDoc,
  validateRichMarkdownStructure, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { cloneNativeCollaborationDocument } from '../app/lib/collaboration/native-document-recovery';
import { assertNativeDocumentSchema, NativeDocumentSchemaError } from '../app/lib/collaboration/native-document-schema';
import { getNativeInspectionSchema, withNativeInspectionSchema } from '../app/lib/collaboration/native-inspection-schema';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { nativeRichDocumentFixture, nativeTableWidthFixture } from './helpers/rich-markdown-projection-fixtures';

type Representation = PersistedCollaborationState['representation'];
const expired = (error: unknown) => error instanceof Error
  && Reflect.get(error, 'code') === 'NATIVE_INSPECTION_SCHEMA_SCOPE_EXPIRED';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function nativeInspectionState(doc: Y.Doc, representation: Representation): PersistedCollaborationState {
  return { documentId: 'inspection-document', workspaceId: 'inspection-workspace', organizationId: null,
    path: 'note.md', representation, lifecycleGeneration: 1, schemaVersion: 1,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: 7,
    checkpointSequence: 0, persistedAt: 100, checkpointedAt: null, canonicalHash: null, serializedHash: null,
    newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
}

function unchangedNativeBytes<T>(doc: Y.Doc, operation: () => T): T {
  const before = { update: Y.encodeStateAsUpdate(doc), vector: Y.encodeStateVector(doc) };
  try { return operation(); }
  finally {
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before.update, 'Inspection must preserve every original native byte.');
    assert.deepEqual(Y.encodeStateVector(doc), before.vector, 'Inspection must preserve the original native clock.');
  }
}

function grammarSurface(schema: Schema) {
  return structuredClone({ nodes: Object.keys(schema.nodes), marks: Object.keys(schema.marks),
    emptyDocument: schema.topNodeType.createAndFill()?.toJSON(),
    paragraph: schema.nodes.paragraph.createAndFill()?.toJSON(),
    hardBreak: schema.nodes.hardBreak.create().toJSON(),
    tableCell: schema.nodes.tableCell.createAndFill()?.toJSON() });
}

function richFixture(representation: 'tiptap_xml' | 'tiptap_blocks'): Y.Doc {
  return nativeRichDocumentFixture({ type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'ABC\t😀', marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'target.md' } }] },
  ] }] }, representation);
}

function richFragments(doc: Y.Doc, representation: 'tiptap_xml' | 'tiptap_blocks'): Y.XmlFragment[] {
  return representation === 'tiptap_xml' ? [doc.getXmlFragment('body')]
    : [...new CollaborationBlockTree(doc, getNativeInspectionSchema()).records.values()]
      .map(record => record.get('content') as Y.XmlFragment);
}

function firstRichText(doc: Y.Doc, representation: 'tiptap_xml' | 'tiptap_blocks'): Y.XmlText {
  const find = (fragment: Y.XmlFragment): Y.XmlText | undefined => {
    for (const child of fragment.toArray()) {
      if (child instanceof Y.XmlText && child.length) return child;
      if (child instanceof Y.XmlElement) { const found = find(child); if (found) return found; }
    }
  };
  for (const fragment of richFragments(doc, representation)) { const found = find(fragment); if (found) return found; }
  throw new Error('The actual native fixture has no editable XML text.');
}

// These frames share grammar data only. No SQL, actor, room or filesystem
// authority is fabricated or inferred from their schema identity.
test('outside getters create fresh schemas with stable grammar and native default attributes', () => {
  const first = getNativeInspectionSchema(), second = getNativeInspectionSchema();
  assert.notEqual(first, second); assert.deepEqual(grammarSurface(first), grammarSurface(second));
  assert.equal(first.nodes.paragraph.create().attrs.id, second.nodes.paragraph.create().attrs.id);
  assert.deepEqual(first.nodes.tableCell.createAndFill()?.attrs, second.nodes.tableCell.createAndFill()?.attrs);
});

test('an awaited frame keeps one fixed grammar across real await boundaries and then expires', async () => {
  const before = getNativeInspectionSchema();
  const held = await withNativeInspectionSchema(async () => {
    const first = getNativeInspectionSchema(); assert.notEqual(first, before);
    await Promise.resolve(); assert.equal(getNativeInspectionSchema(), first);
    const gate = deferred(); const pending = gate.promise.then(() => getNativeInspectionSchema());
    gate.resolve(); assert.equal(await pending, first); return first;
  });
  const after = getNativeInspectionSchema(); assert.notEqual(after, held);
  assert.deepEqual(grammarSurface(after), grammarSurface(held));
});

test('nested grammar frames are fresh and restore the outer instance after success or callback error', async () => {
  await withNativeInspectionSchema(async () => {
    const outer = getNativeInspectionSchema();
    const inner = await withNativeInspectionSchema(async () => {
      const current = getNativeInspectionSchema(); assert.notEqual(current, outer);
      await Promise.resolve(); assert.equal(getNativeInspectionSchema(), current); return current;
    });
    assert.notEqual(inner, outer); assert.equal(getNativeInspectionSchema(), outer);
    const primary = new Error('Nested grammar callback failed.');
    await assert.rejects(withNativeInspectionSchema(() => {
      assert.notEqual(getNativeInspectionSchema(), outer); throw primary;
    }), error => error === primary);
    assert.equal(getNativeInspectionSchema(), outer);
  });
});

test('concurrent awaited frames retain separate actual schema instances', async () => {
  const firstEntered = deferred(), secondEntered = deferred(), release = deferred();
  let firstSchema!: Schema, secondSchema!: Schema;
  const first = withNativeInspectionSchema(async () => {
    firstSchema = getNativeInspectionSchema(); firstEntered.resolve(); await release.promise;
    assert.equal(getNativeInspectionSchema(), firstSchema); return firstSchema;
  });
  await firstEntered.promise;
  const second = withNativeInspectionSchema(async () => {
    secondSchema = getNativeInspectionSchema(); secondEntered.resolve(); await release.promise;
    assert.equal(getNativeInspectionSchema(), secondSchema); return secondSchema;
  });
  await secondEntered.promise;
  try {
    assert.notEqual(firstSchema, secondSchema);
    const outside = getNativeInspectionSchema(); assert.notEqual(outside, firstSchema); assert.notEqual(outside, secondSchema);
  } finally { release.resolve(); }
  assert.deepEqual(grammarSurface(await first), grammarSurface(await second));
});

for (const outcome of ['success', 'error'] as const) test(`genuinely deferred children cannot read or revive a grammar frame after ${outcome}`, async () => {
  const gate = deferred(), primary = new Error('Original grammar callback error.');
  let retained!: Schema, getterChild!: Promise<Schema>, wrapperChild!: Promise<unknown>;
  const operation = withNativeInspectionSchema(() => {
    retained = getNativeInspectionSchema();
    getterChild = (async () => { await gate.promise; return getNativeInspectionSchema(); })();
    wrapperChild = (async () => { await gate.promise; return withNativeInspectionSchema(() => getNativeInspectionSchema()); })();
    if (outcome === 'error') throw primary;
    return retained;
  });
  if (outcome === 'error') await assert.rejects(operation, error => error === primary);
  else assert.equal(await operation, retained);
  gate.resolve(); await assert.rejects(getterChild, expired); await assert.rejects(wrapperChild, expired);
  const outside = getNativeInspectionSchema(); assert.notEqual(outside, retained);
  assert.deepEqual(grammarSurface(outside), grammarSurface(retained));
});

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) test(`${representation}: actual native validation and snapshot semantics stay equal inside and outside the frame`, async () => {
  const doc = representation === 'plain_text' ? createPlainTextYDoc('A\tB\r\n😀\n') : richFixture(representation);
  const inspect = () => unchangedNativeBytes(doc, () => {
    assertNativeDocumentSchema(doc, representation, getNativeInspectionSchema());
    const native = authoritativeNativeCollaborationSnapshot(nativeInspectionState(doc, representation));
    if (representation === 'plain_text') return { native, rich: null };
    assert.equal(validateRichMarkdownStructure(doc).valid, true); assert.equal(validateRichMarkdownYDoc(doc).valid, true);
    return { native, rich: { json: readRichDocumentJson(doc), markdown: richMarkdownFromYDoc(doc) } };
  });
  try {
    const before = inspect();
    await withNativeInspectionSchema(async () => {
      const schema = getNativeInspectionSchema(); assert.deepEqual(inspect(), before);
      await Promise.resolve(); assert.deepEqual(inspect(), before); assert.equal(getNativeInspectionSchema(), schema);
    });
    assert.deepEqual(inspect(), before);
  } finally { doc.destroy(); }
});

test('plain native unknown roots are still rejected without changing native bytes', async () => {
  const doc = createPlainTextYDoc('Exact original text'); doc.getMap('future-root').set('futureField', 'opaque');
  const inspect = () => unchangedNativeBytes(doc, () => assert.throws(
    () => assertNativeDocumentSchema(doc, 'plain_text', getNativeInspectionSchema()), NativeDocumentSchemaError));
  try { inspect(); await withNativeInspectionSchema(inspect); inspect(); }
  finally { doc.destroy(); }
});

for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) for (const field of ['root', 'node-attribute', 'link-mark-attribute'] as const) test(`${representation}: unknown raw ${field} remains rejected in every grammar scope`, async () => {
  const doc = richFixture(representation);
  if (field === 'root') doc.getMap('future-root').set('futureField', 'opaque');
  else if (field === 'node-attribute') {
    if (representation === 'tiptap_xml') (doc.getXmlFragment('body').get(0) as Y.XmlElement).setAttribute('futureField', 'opaque');
    else ([...new CollaborationBlockTree(doc, getNativeInspectionSchema()).records.values()][0].get('attributes') as Y.Map<unknown>)
      .set('futureField', 'opaque');
  } else {
    const text = firstRichText(doc, representation); const mark = text.toDelta().find((part: { attributes?: { link?: Record<string, unknown> } }) => part.attributes?.link)?.attributes?.link;
    assert(mark, 'The fixture must contain an actual raw XML link mark.');
    text.format(0, text.length, { link: { ...mark, futureField: 'opaque' } });
  }
  const inspect = () => unchangedNativeBytes(doc, () => {
    assert.throws(() => assertNativeDocumentSchema(doc, representation, getNativeInspectionSchema()), NativeDocumentSchemaError);
    assert.deepEqual(validateRichMarkdownYDoc(doc), { valid: false, code: 'schema_invalid' });
    return authoritativeNativeCollaborationSnapshot(nativeInspectionState(doc, representation));
  });
  try { const before = inspect(); await withNativeInspectionSchema(async () => {
    assert.deepEqual(inspect(), before); await Promise.resolve(); assert.deepEqual(inspect(), before);
  }); assert.deepEqual(inspect(), before); }
  finally { doc.destroy(); }
});

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) test(`${representation}: real Yjs deletions change the native proof despite an unchanged state vector`, async () => {
  const doc = representation === 'plain_text' ? createPlainTextYDoc('ABC') : createRichMarkdownYDoc('ABC', representation);
  const inspect = () => unchangedNativeBytes(doc, () => {
    assertNativeDocumentSchema(doc, representation, getNativeInspectionSchema());
    return authoritativeNativeCollaborationSnapshot(nativeInspectionState(doc, representation));
  });
  try {
    const before = inspect();
    if (representation === 'plain_text') doc.getText('content').delete(0, 1);
    else firstRichText(doc, representation).delete(0, 1);
    const deleted = inspect(); assert.equal(deleted.version.stateVector, before.version.stateVector);
    assert.notEqual(deleted.version.stateProof, before.version.stateProof);
    await withNativeInspectionSchema(async () => { assert.deepEqual(inspect(), deleted); await Promise.resolve(); assert.deepEqual(inspect(), deleted); });
    assert.deepEqual(inspect(), deleted);
  } finally { doc.destroy(); }
});

for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) test(`${representation}: known table widths remain native and cloneable while lossless GFM export stays rejected`, async () => {
  const doc = nativeTableWidthFixture(representation);
  const inspect = () => unchangedNativeBytes(doc, () => {
    assertNativeDocumentSchema(doc, representation, getNativeInspectionSchema());
    assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
    const state = nativeInspectionState(doc, representation), native = authoritativeNativeCollaborationSnapshot(state);
    assert.match(JSON.stringify(native.content), /"colwidth":\[120\]/u);
    assert.throws(() => authoritativeCollaborationSnapshot(state), error => error instanceof CollaborationCheckpointValidationError
      && error.validationCode === 'roundtrip_unstable' && error.code === 'COLLABORATION_ROUNDTRIP_UNSTABLE');
    const clone = cloneNativeCollaborationDocument(state);
    try { assert.match(JSON.stringify(readRichDocumentJson(clone.doc)), /"colwidth":\[120\]/u); }
    finally { clone.doc.destroy(); }
    return native;
  });
  try { const before = inspect(); await withNativeInspectionSchema(async () => {
    assert.deepEqual(inspect(), before); await Promise.resolve(); assert.deepEqual(inspect(), before);
  }); assert.deepEqual(inspect(), before); }
  finally { doc.destroy(); }
});

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) test(`${representation}: two actual clones in one grammar frame retain independent IDs, clocks and content`, async () => {
  const source = representation === 'plain_text' ? createPlainTextYDoc('Exact source\t😀\n') : richFixture(representation);
  const state = nativeInspectionState(source, representation), stateBefore = structuredClone(state);
  const sourceBytes = Y.encodeStateAsUpdate(source), sourceVector = Y.encodeStateVector(source);
  try {
    await withNativeInspectionSchema(async () => {
      const schema = getNativeInspectionSchema(), defaults = grammarSurface(schema);
      const first = cloneNativeCollaborationDocument(state);
      let second: ReturnType<typeof cloneNativeCollaborationDocument> | undefined;
      try {
        await Promise.resolve(); second = cloneNativeCollaborationDocument(state);
        assert.notEqual(first.doc, second.doc); assert.notEqual(first.doc.guid, second.doc.guid);
        assert.notEqual(first.doc.clientID, second.doc.clientID);
        assert(first.doc.store.clients.size > 0); assert(second.doc.store.clients.size > 0);
        for (const id of first.doc.store.clients.keys()) {
          assert.equal(source.store.clients.has(id), false); assert.equal(second.doc.store.clients.has(id), false);
        }
        for (const id of second.doc.store.clients.keys()) assert.equal(source.store.clients.has(id), false);
        assertNativeDocumentSchema(first.doc, representation, schema); assertNativeDocumentSchema(second.doc, representation, schema);
        if (representation === 'plain_text') {
          assert.equal(first.doc.getText('content').toString(), source.getText('content').toString());
          assert.equal(second.doc.getText('content').toString(), source.getText('content').toString());
          assert.equal(Object.keys(first.blockIdMapping).length, 0); assert.equal(Object.keys(second.blockIdMapping).length, 0);
        } else {
          const sourceIds = Object.keys(first.blockIdMapping); assert(sourceIds.length > 0);
          assert.deepEqual(Object.keys(second.blockIdMapping).sort(), [...sourceIds].sort());
          const firstIds = new Set(Object.values(first.blockIdMapping)), secondIds = new Set(Object.values(second.blockIdMapping));
          assert.equal(firstIds.size, sourceIds.length); assert.equal(secondIds.size, sourceIds.length);
          for (const id of firstIds) { assert.equal(sourceIds.includes(id), false); assert.equal(secondIds.has(id), false); }
          for (const id of secondIds) assert.equal(sourceIds.includes(id), false);
          assert.equal(richMarkdownFromYDoc(first.doc), richMarkdownFromYDoc(source));
          assert.equal(richMarkdownFromYDoc(second.doc), richMarkdownFromYDoc(source));
        }
        const secondBytes = Y.encodeStateAsUpdate(second.doc), secondVector = Y.encodeStateVector(second.doc);
        if (representation === 'plain_text') first.doc.getText('content').insert(0, 'Only first clone: ');
        else firstRichText(first.doc, representation).insert(0, 'Only first clone: ');
        assert.deepEqual(Y.encodeStateAsUpdate(second.doc), secondBytes);
        assert.deepEqual(Y.encodeStateVector(second.doc), secondVector);
        assert.equal(getNativeInspectionSchema(), schema); assert.deepEqual(grammarSurface(schema), defaults);
        assert.deepEqual(state, stateBefore);
      } finally { first.doc.destroy(); second?.doc.destroy(); }
    });
  } finally {
    assert.deepEqual(Y.encodeStateAsUpdate(source), sourceBytes); assert.deepEqual(Y.encodeStateVector(source), sourceVector);
    assert.deepEqual(state, stateBefore); source.destroy();
  }
});
