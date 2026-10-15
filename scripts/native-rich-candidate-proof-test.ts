/** Run: node --import tsx scripts/native-rich-candidate-proof-test.ts */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from '@playwright/test';
import type { JSONContent } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import * as Y from 'yjs';

import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { readNativeRichCandidate } from '../tests/helpers/native-rich-candidate';

const selector = '.candidate-editor';
const paragraphId = 'candidate-paragraph';
const schema = new Schema({ nodes: {
  doc: { content: 'paragraph*' },
  paragraph: { attrs: { id: { default: null } }, content: 'text*' },
  text: {},
} });

function fixture(gc = true, update?: Uint8Array) {
  const doc = new Y.Doc({ gc }); doc.clientID = update ? 22 : 11;
  let tree: CollaborationBlockTree;
  if (update) {
    Y.applyUpdate(doc, update); tree = new CollaborationBlockTree(doc, schema);
  } else {
    tree = CollaborationBlockTree.create(doc, schema.node('doc', null,
      [schema.node('paragraph', { id: paragraphId }, schema.text('ABC'))]));
  }
  const binding: {
    ready: boolean; destroyed: boolean; lastError: string | null;
    composing: boolean; compositionTree: unknown; options: { document: Y.Doc };
    tree: { doc: Y.Doc; root: unknown; records: unknown } | null;
  } = { ready: true, destroyed: false, lastError: null, composing: false, compositionTree: null,
    options: { document: doc }, tree };
  const editor = { isDestroyed: false, getJSON: (): JSONContent => tree.read().toJSON(),
    storage: { canvasBlockTreeCollaboration: { binding } } };
  const element = { editor } as unknown as HTMLElement;
  let evaluations = 0;
  // This seam invokes the exact function supplied to Locator.evaluate by the
  // helper. There is no second metadata-extraction or proof algorithm here.
  const page = { locator(target: string) {
    assert.equal(target, selector);
    return { async evaluate(callback: (value: HTMLElement) => unknown) {
      evaluations++;
      return callback(element);
    } };
  } } as unknown as Page;
  return { doc, tree, binding, editor, page, evaluations: () => evaluations };
}

type Fixture = ReturnType<typeof fixture>;
function text(value: Fixture): Y.XmlText {
  const result = value.tree.content(paragraphId).get(0);
  assert.ok(result instanceof Y.XmlText);
  return result;
}

async function capture(value: Fixture) {
  const calls = value.evaluations();
  let emitted = 0;
  const observe = () => { emitted++; };
  value.doc.on('update', observe);
  try {
    const result = await readNativeRichCandidate(value.page, selector);
    assert.equal(value.evaluations(), calls + 1, 'execute the actual browser callback once');
    assert.equal(result.stateProof, collaborationStateProof(value.doc, Y), 'match the original product proof');
    assert.equal(result.stateVector, Buffer.from(Y.encodeStateVector(value.doc)).toString('base64'));
    assert.equal(result.localClient, value.doc.clientID); assert.equal(result.guid, value.doc.guid);
    // Browser serialization returns plain JSON objects, unlike PM attrs' prototype.
    assert.deepEqual(result.document, JSON.parse(JSON.stringify(value.editor.getJSON())));
    assert.equal(emitted, 0, 'candidate reads do not emit document updates');
    return result;
  } finally { value.doc.off('update', observe); }
}

test('candidate matches the original proof before/after a deletion-only edit with either GC mode', async () => {
  for (const gc of [false, true]) {
    const value = fixture(gc);
    try {
      const before = await capture(value);
      text(value).delete(0, 1);
      const after = await capture(value);
      assert.equal(after.stateVector, before.stateVector, 'deleting text creates no insertion clock');
      assert.notEqual(after.stateProof, before.stateProof);
      assert.equal(after.document.content![0].content![0].text, 'BC');
    } finally { value.doc.destroy(); }
  }
});

test('equal vectors with different deletion sets receive different exact candidate proofs', async () => {
  const source = fixture(false);
  const baseline = Y.encodeStateAsUpdate(source.doc);
  const left = fixture(false, baseline), right = fixture(true, baseline);
  try {
    text(left).delete(0, 1); text(right).delete(1, 1);
    const a = await capture(left), b = await capture(right);
    assert.equal(a.stateVector, b.stateVector); assert.notEqual(a.stateProof, b.stateProof);
  } finally { source.doc.destroy(); left.doc.destroy(); right.doc.destroy(); }
});

test('own insert/Undo returns to the old PM document but retains new clocks and a different proof', async () => {
  const value = fixture();
  const origin = {};
  const history = new Y.UndoManager(text(value), { trackedOrigins: new Set([origin]), captureTimeout: 0 });
  try {
    const before = await capture(value);
    value.doc.transact(() => text(value).insert(text(value).length, ' Own edit.'), origin);
    const inserted = await capture(value);
    assert.ok(history.undo());
    const undone = await capture(value);
    assert.deepEqual(undone.document, before.document);
    assert.equal(undone.stateVector, inserted.stateVector);
    assert.notEqual(undone.stateVector, before.stateVector);
    assert.notEqual(undone.stateProof, before.stateProof); assert.notEqual(undone.stateProof, inserted.stateProof);
  } finally { history.destroy(); value.doc.destroy(); }
});

test('deleted native parents and GC structs stay in the proof even when the visible document is empty', async () => {
  for (const gc of [false, true]) {
    const value = fixture(gc);
    let reopened: Fixture | undefined;
    try {
      const before = await capture(value);
      value.tree.records.delete(paragraphId);
      const after = await capture(value);
      assert.equal(after.stateVector, before.stateVector); assert.notEqual(after.stateProof, before.stateProof);
      assert.equal(after.document.content?.length ?? 0, 0);
      const structs = [...value.doc.store.clients.values()].flat();
      assert.ok(structs.some(struct => struct.deleted));
      assert.equal(structs.some(struct => struct instanceof Y.GC), gc, 'exercise collected descendants as well as retained Items');
      reopened = fixture(!gc, Y.encodeStateAsUpdate(value.doc));
      assert.equal((await capture(reopened)).stateProof, after.stateProof, 'GC/retained representation has the same canonical snapshot');
    } finally { reopened?.doc.destroy(); value.doc.destroy(); }
  }
});

test('out-of-order missing structures and missing deletions fail instead of certifying their integrated subset', async () => {
  for (const kind of ['structures', 'deletions'] as const) {
    const value = fixture(), branch = new Y.Doc(); branch.clientID = 99;
    try {
      branch.getText('frontmatter').insert(0, 'A');
      const initialVector = Y.encodeStateVector(branch);
      if (kind === 'structures') branch.getText('frontmatter').insert(1, 'B');
      else branch.getText('frontmatter').delete(0, 1);
      Y.applyUpdate(value.doc, Y.encodeStateAsUpdate(branch, initialVector));
      assert.ok(kind === 'structures' ? value.doc.store.pendingStructs : value.doc.store.pendingDs);
      assert.equal(collaborationStateProof(value.doc, Y), null);
      await assert.rejects(readNativeRichCandidate(value.page, selector), /document is incomplete/u);
      Y.applyUpdate(value.doc, Y.encodeStateAsUpdate(branch));
      assert.equal(value.doc.store.pendingStructs, null); assert.equal(value.doc.store.pendingDs, null);
      await capture(value);
    } finally { value.doc.destroy(); branch.destroy(); }
  }
});

test('missing pending-state fields are invalid rather than silently treated as empty', async () => {
  const value = fixture();
  try {
    Reflect.deleteProperty(value.doc.store, 'pendingDs');
    await assert.rejects(readNativeRichCandidate(value.page, selector), /document is incomplete/u);
  } finally { Reflect.set(value.doc.store, 'pendingDs', null); value.doc.destroy(); }
});

test('client/document bounds reject the full candidate instead of truncating a snapshot', async () => {
  const value = fixture();
  try {
    const baseline = Y.encodeStateAsUpdate(value.doc);
    for (let index = 0; index < 64; index++) {
      const writer = new Y.Doc(); writer.clientID = 1000 + index;
      try {
        Y.applyUpdate(writer, baseline);
        writer.getText('frontmatter').insert(0, 'x');
        Y.applyUpdate(value.doc, Y.encodeStateAsUpdate(writer));
      } finally { writer.destroy(); }
    }
    assert.equal(value.doc.store.clients.size, 65);
    await assert.rejects(readNativeRichCandidate(value.page, selector), /client bound exceeded/u);
  } finally { value.doc.destroy(); }
  const oversized = fixture();
  try {
    oversized.editor.getJSON = () => ({ type: 'doc', content: [{ type: 'paragraph',
      content: [{ type: 'text', text: 'x'.repeat(1_048_577) }] }] });
    await assert.rejects(readNativeRichCandidate(oversized.page, selector), /document bound exceeded/u);
  } finally { oversized.doc.destroy(); }
});

test('unready/composing/stale/destroyed bindings never yield a candidate', async () => {
  for (const kind of ['unready', 'composing', 'stale-records', 'destroyed-doc'] as const) {
    const value = fixture();
    try {
      if (kind === 'unready') value.binding.ready = false;
      else if (kind === 'composing') { value.binding.composing = true; value.binding.compositionTree = {}; }
      else if (kind === 'stale-records') value.binding.tree = { doc: value.doc, root: value.tree.root, records: new Map() };
      else value.doc.destroy();
      await assert.rejects(readNativeRichCandidate(value.page, selector), /Native rich candidate:/u);
    } finally { value.doc.destroy(); }
  }
});
