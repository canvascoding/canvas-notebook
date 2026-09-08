import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import { initProseMirrorDoc } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { EditorState } from '@tiptap/pm/state';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';

import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';

const schema = getSchema(richMarkdownCodecExtensions());
const localOrigin = {};
const remoteOrigin = {};

function replicas(markdown = 'AAA\n\nBBB\n\nCCC') {
  const source = createRichMarkdownYDoc(markdown);
  const left = new Y.Doc();
  const initial = initProseMirrorDoc(source.getXmlFragment('body'), schema).doc;
  const a = CollaborationBlockTree.create(left, initial);
  source.destroy();
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  left.clientID = 10;
  right.clientID = 20;
  const b = new CollaborationBlockTree(right, schema);
  return { a, b, left, right, dispose: () => { left.destroy(); right.destroy(); } };
}

function blocks(tree: CollaborationBlockTree) {
  const result: Array<{ id: string; text: string }> = [];
  tree.read(schema).forEach((node) => result.push({ id: node.attrs.id, text: node.textContent }));
  return result;
}

function exchange(left: Y.Doc, right: Y.Doc, reverse: boolean) {
  const a = Y.encodeStateAsUpdate(left);
  const b = Y.encodeStateAsUpdate(right);
  for (const [doc, update] of reverse ? [[right, a], [left, b]] as const : [[left, b], [right, a]] as const) {
    Y.applyUpdate(doc, update);
    Y.applyUpdate(doc, update);
  }
}

function replaceText(tree: CollaborationBlockTree, id: string, text: string) {
  const current = tree.read(schema);
  let target = current.firstChild!;
  current.descendants((node) => { if (node.attrs.id === id) target = node; });
  tree.updateInlineContent(id, target.type.create(target.attrs, schema.text(text)), remoteOrigin);
}

for (const reverse of [false, true]) {
  test(`content and relative anchors survive a concurrent move (reverse=${reverse})`, () => {
    const h = replicas();
    try {
      const before = blocks(h.a);
      const id = before[1].id;
      const originalText = h.a.content(id).get(0) as Y.XmlText;
      const anchor = Y.createRelativePositionFromTypeIndex(originalText, 1);
      h.a.move({ blockId: id, parentId: null, beforeId: null, operationId: 'move-b' }, localOrigin);
      replaceText(h.b, id, 'NEW');
      exchange(h.left, h.right, reverse);
      const expected = [before[0], before[2], { id, text: 'NEW' }];
      assert.deepEqual(blocks(h.a), expected);
      assert.deepEqual(blocks(h.b), expected);
      assert.equal(h.a.content(id).get(0), originalText, 'moving preserves the integrated text object');
      assert.equal(Y.createAbsolutePositionFromRelativePosition(anchor, h.left)?.type, originalText);
      assert.equal(Y.createAbsolutePositionFromRelativePosition(anchor, h.right)?.type, h.b.content(id).get(0));
    } finally { h.dispose(); }
  });

  test(`opposing moves produce one deterministic placement without mixed text (reverse=${reverse})`, () => {
    const h = replicas();
    try {
      const before = blocks(h.a);
      h.a.move({ blockId: before[1].id, parentId: null, beforeId: null, operationId: 'left-move' }, localOrigin);
      h.b.move({ blockId: before[1].id, parentId: null, beforeId: before[0].id, operationId: 'right-move' }, remoteOrigin);
      exchange(h.left, h.right, reverse);
      const expected = [before[1], before[0], before[2]];
      assert.deepEqual(blocks(h.a), expected);
      assert.deepEqual(blocks(h.b), expected);
      assert.equal(h.a.operations.size, 2, 'both intentions are retained');
    } finally { h.dispose(); }
  });

  test(`delete wins over a concurrent move without resurrection (reverse=${reverse})`, () => {
    const h = replicas();
    try {
      const before = blocks(h.a);
      h.a.move({ blockId: before[1].id, parentId: null, beforeId: null, operationId: 'move' }, localOrigin);
      h.b.delete(before[1].id, 'delete', remoteOrigin);
      exchange(h.left, h.right, reverse);
      assert.deepEqual(blocks(h.a), [before[0], before[2]]);
      assert.deepEqual(blocks(h.b), [before[0], before[2]]);
      assert.equal(h.a.records.has(before[1].id), true, 'recovery retains the content record');
      assert.throws(() => h.a.move({ blockId: before[1].id, parentId: null, beforeId: null, operationId: 'late' }, localOrigin));
    } finally { h.dispose(); }
  });

  test(`undo and redo of a move retain a remote content edit (reverse=${reverse})`, () => {
    const h = replicas();
    const undo = h.a.createUndoManager(localOrigin);
    try {
      const before = blocks(h.a);
      const id = before[1].id;
      h.a.move({ blockId: id, parentId: null, beforeId: null, operationId: 'move' }, localOrigin);
      replaceText(h.b, id, 'agent content');
      exchange(h.left, h.right, reverse);
      undo.undo();
      h.a.move({ blockId: id, parentId: null, beforeId: null, operationId: 'move' }, localOrigin);
      exchange(h.left, h.right, reverse);
      assert.deepEqual(blocks(h.a), [before[0], { id, text: 'agent content' }, before[2]]);
      assert.deepEqual(blocks(h.a), blocks(h.b));
      undo.redo();
      exchange(h.left, h.right, reverse);
      assert.deepEqual(blocks(h.a), [before[0], before[2], { id, text: 'agent content' }]);
      assert.deepEqual(blocks(h.a), blocks(h.b));
    } finally { undo.destroy(); h.dispose(); }
  });

  test(`concurrent ancestor moves cannot create cycles (reverse=${reverse})`, () => {
    const h = replicas('> Quote A\n\nSeparator\n\n> Quote B');
    try {
      const before = blocks(h.a);
      const a = before[0].id;
      const b = before[2].id;
      h.a.move({ blockId: a, parentId: b, beforeId: null, operationId: 'a-to-b' }, localOrigin);
      h.b.move({ blockId: b, parentId: a, beforeId: null, operationId: 'b-to-a' }, remoteOrigin);
      exchange(h.left, h.right, reverse);
      assert.deepEqual(h.a.read(schema).toJSON(), h.b.read(schema).toJSON());
      assert.equal(h.a.project().parents.get(a), b);
      assert.equal(h.a.project().parents.get(b), null);
      assert.equal(h.a.project().conflicts.filter((conflict) => conflict.reason === 'cycle').length, 1);
      assert.equal(h.a.read(schema).textContent, 'SeparatorQuote BQuote A');
    } finally { h.dispose(); }
  });
}

test('binary persistence retains block identity, placements and pending text updates', () => {
  const h = replicas();
  const restored = new Y.Doc();
  try {
    const before = blocks(h.a);
    const vector = Y.encodeStateVector(h.left);
    h.a.move({ blockId: before[1].id, parentId: null, beforeId: null, operationId: 'move' }, localOrigin);
    const update = Y.encodeStateAsUpdate(h.left, vector);
    replaceText(h.b, before[1].id, 'delayed edit');
    // Out-of-order delivery to an empty replica; dependencies arrive later.
    Y.applyUpdate(restored, update);
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(h.right));
    Y.applyUpdate(restored, update);
    const tree = new CollaborationBlockTree(restored, schema);
    assert.deepEqual(blocks(tree), [before[0], before[2], { ...before[1], text: 'delayed edit' }]);
    assert.equal(restored.share.has('body'), false, 'there is one authoritative representation');
  } finally { h.dispose(); restored.destroy(); }
});

test('operation retries are idempotent and a mismatched payload cannot reuse an ID', () => {
  const h = replicas();
  try {
    const id = blocks(h.a)[1].id;
    const input = { blockId: id, parentId: null, beforeId: null, operationId: 'retry' };
    h.a.move(input, localOrigin);
    const state = Y.encodeStateAsUpdate(h.left);
    h.a.move(input, localOrigin);
    assert.deepEqual(Y.encodeStateAsUpdate(h.left), state);
    assert.throws(() => h.a.move({ ...input, blockId: blocks(h.a)[0].id }, localOrigin));
  } finally { h.dispose(); }
});

test('deleting a drop anchor after an accepted move does not undo that earlier placement', () => {
  const h = replicas('AAA\n\nBBB\n\nCCC\n\nDDD');
  try {
    const before = h.a.read();
    h.a.move({ blockId: before.child(3).attrs.id, parentId: null, beforeId: before.child(1).attrs.id, operationId: 'move-first' }, localOrigin);
    h.a.delete(before.child(1).attrs.id, 'delete-later', localOrigin);
    assert.deepEqual(blocks(h.a).map((block) => block.text), ['AAA', 'DDD', 'CCC']);
    assert.deepEqual(h.a.project().conflicts, [], 'a causally later deletion is not a failed move');
    exchange(h.left, h.right, true);
    assert.deepEqual(h.a.read().toJSON(), h.b.read().toJSON());
  } finally { h.dispose(); }
});

test('a ProseMirror move uses current content and retains the actual moved identity', () => {
  const h = replicas();
  try {
    const before = h.a.read();
    const b = before.child(1);
    const start = before.child(0).nodeSize;
    const state = EditorState.create({ schema, doc: before });
    const tr = state.tr.delete(start, start + b.nodeSize).insert(0, b);
    h.a.applyDocumentChange(before, tr.doc, localOrigin, { blockId: b.attrs.id, parentId: null, beforeId: before.firstChild!.attrs.id });
    replaceText(h.b, b.attrs.id, 'NEW');
    exchange(h.left, h.right, false);
    assert.deepEqual(blocks(h.a).map((block) => block.text), ['NEW', 'AAA', 'CCC']);
    const moves = [...h.a.operations.values()].filter((op) => op.kind === 'move');
    assert.equal(moves.length, 1);
    assert.equal(moves[0].kind === 'move' && moves[0].blockId, b.attrs.id);
  } finally { h.dispose(); }
});

test('insertion, deletion and reparenting are atomic ProseMirror structure changes', () => {
  const h = replicas();
  try {
    const before = h.a.read();
    const quote = schema.nodes.blockquote.create({ id: 'new-quote' }, before.child(1));
    const next = schema.topNodeType.create(null, [before.child(0), quote]);
    h.a.applyDocumentChange(before, next, localOrigin);
    assert.deepEqual(h.a.read().toJSON(), next.toJSON());
    assert.equal(h.a.project().parents.get(before.child(1).attrs.id), 'new-quote');
    replaceText(h.b, before.child(1).attrs.id, 'current child');
    exchange(h.left, h.right, false);
    assert.deepEqual(blocks(h.a).map((block) => block.text), ['AAA', 'current child']);
    assert.deepEqual(h.a.read().toJSON(), h.b.read().toJSON());
  } finally { h.dispose(); }
});

test('invalid containers and stale editor transactions cannot partially mutate storage', () => {
  const h = replicas();
  try {
    const before = h.a.read();
    const state = Y.encodeStateAsUpdate(h.left);
    assert.throws(() => h.a.move({ blockId: before.child(1).attrs.id, parentId: before.child(0).attrs.id, beforeId: null, operationId: 'invalid' }, localOrigin));
    assert.deepEqual(Y.encodeStateAsUpdate(h.left), state);
    replaceText(h.a, before.child(1).attrs.id, 'changed');
    const currentState = Y.encodeStateAsUpdate(h.left);
    assert.throws(() => h.a.applyDocumentChange(before, schema.topNodeType.create(null, [before.child(1), before.child(0), before.child(2)]), localOrigin));
    assert.deepEqual(Y.encodeStateAsUpdate(h.left), currentState);
  } finally { h.dispose(); }
});

test('moving a task or table preserves every nested identity and marked Unicode text', () => {
  const h = replicas('- [x] **Wörter 👩🏽‍💻**\n- [ ] Other\n\n| Name | Value |\n| --- | --- |\n| Price | **71,69 €** |');
  try {
    const before = h.a.read();
    const next = schema.topNodeType.create(null, [before.child(1), before.child(0)]);
    const contentTypes = new Map([...h.a.records.keys()].map((id) => [id, h.a.content(id)]));
    h.a.applyDocumentChange(before, next, localOrigin, { blockId: before.child(1).attrs.id, parentId: null, beforeId: before.child(0).attrs.id });
    assert.deepEqual(h.a.read().toJSON(), next.toJSON());
    for (const [id, content] of contentTypes) assert.equal(h.a.content(id), content);
    exchange(h.left, h.right, true);
    assert.deepEqual(h.b.read().toJSON(), next.toJSON());
  } finally { h.dispose(); }
});

function reorderColumns(doc: ProseMirrorNode, order: number[]): ProseMirrorNode {
  const table = doc.firstChild!;
  const rows: ProseMirrorNode[] = [];
  table.forEach((row) => rows.push(row.copy(Fragment.fromArray(order.map((index) => row.child(index))))));
  return doc.copy(Fragment.from(table.copy(Fragment.fromArray(rows))));
}

test('one column action cannot interleave its cell moves with a concurrent column action', () => {
  const h = replicas('| r0c0 | r0c1 | r0c2 | r0c3 |\n| --- | --- | --- | --- |\n| r1c0 | r1c1 | r1c2 | r1c3 |\n| r2c0 | r2c1 | r2c2 | r2c3 |');
  try {
    h.a.applyDocumentChange(h.a.read(), reorderColumns(h.a.read(), [0, 3, 1, 2]), localOrigin);
    h.b.applyDocumentChange(h.b.read(), reorderColumns(h.b.read(), [1, 0, 2, 3]), remoteOrigin);
    exchange(h.left, h.right, false);
    const orders: string[] = [];
    h.a.read().firstChild!.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => cells.push(cell.textContent.slice(-1)));
      orders.push(cells.join(''));
    });
    assert.equal(new Set(orders).size, 1, `header and data columns must agree: ${orders.join('/')}`);
    assert.deepEqual(h.a.read().toJSON(), h.b.read().toJSON());
  } finally { h.dispose(); }
});

test('all four-column permutations converge with identities and columns intact in both delivery orders', () => {
  const permutations = (values: number[]): number[][] => values.length
    ? values.flatMap((value, index) => permutations(values.filter((_, other) => other !== index)).map((rest) => [value, ...rest]))
    : [[]];
  const seed = createRichMarkdownYDoc('| r0c0 | r0c1 | r0c2 | r0c3 |\n| --- | --- | --- | --- |\n| r1c0 | r1c1 | r1c2 | r1c3 |\n| r2c0 | r2c1 | r2c2 | r2c3 |', 'tiptap_blocks');
  const update = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  for (const leftOrder of permutations([0, 1, 2, 3])) for (const rightOrder of permutations([0, 1, 2, 3])) for (const reverse of [false, true]) {
    const left = new Y.Doc();
    const right = new Y.Doc();
    try {
      Y.applyUpdate(left, update);
      Y.applyUpdate(right, update);
      left.clientID = 10;
      right.clientID = 20;
      const a = new CollaborationBlockTree(left, schema);
      const b = new CollaborationBlockTree(right, schema);
      const identityContent = new Map<string, string>();
      a.read().descendants((node) => { if (node.inlineContent) identityContent.set(node.attrs.id, node.textContent); });
      a.applyDocumentChange(a.read(), reorderColumns(a.read(), leftOrder), localOrigin);
      b.applyDocumentChange(b.read(), reorderColumns(b.read(), rightOrder), remoteOrigin);
      exchange(left, right, reverse);
      const result = a.read();
      const rowOrders: string[] = [];
      result.firstChild!.forEach((row) => {
        const cells: string[] = [];
        row.forEach((cell) => cells.push(cell.textContent.slice(-1)));
        rowOrders.push(cells.join(''));
      });
      assert.equal(new Set(rowOrders).size, 1, `${leftOrder}/${rightOrder}: ${rowOrders}`);
      assert.deepEqual(result.toJSON(), b.read().toJSON());
      const finalContent = new Map<string, string>();
      result.descendants((node) => { if (node.inlineContent) finalContent.set(node.attrs.id, node.textContent); });
      assert.deepEqual(finalContent, identityContent);
    } finally { left.destroy(); right.destroy(); }
  }
});

function insertColumn(doc: ProseMirrorNode, actor: string): ProseMirrorNode {
  const rows: ProseMirrorNode[] = [];
  doc.firstChild!.forEach((row, _offset, rowIndex) => {
    // Opposite lexical cell-ID order in alternating rows exposes accidental
    // ordering by random identities instead of the user's column action.
    const prefix = `${rowIndex % 2 ? (actor === 'A' ? 'z' : 'a') : actor}-${rowIndex}`;
    const paragraph = schema.nodes.paragraph.create({ id: `${prefix}-paragraph` }, schema.text(actor));
    const cell = row.firstChild!.type.create({ ...row.firstChild!.attrs, id: `${prefix}-cell` }, paragraph);
    rows.push(row.copy(Fragment.fromArray([row.firstChild!, cell, row.child(1)])));
  });
  return doc.copy(Fragment.from(doc.firstChild!.copy(Fragment.fromArray(rows))));
}

test('concurrent inserted columns keep their cells aligned despite unrelated cell identities', () => {
  const h = replicas('| H1 | H2 |\n| --- | --- |\n| D1 | D2 |');
  try {
    h.a.applyDocumentChange(h.a.read(), insertColumn(h.a.read(), 'A'), localOrigin);
    h.b.applyDocumentChange(h.b.read(), insertColumn(h.b.read(), 'B'), remoteOrigin);
    exchange(h.left, h.right, false);
    const inserted: string[] = [];
    h.a.read().firstChild!.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => { if (cell.textContent === 'A' || cell.textContent === 'B') cells.push(cell.textContent); });
      inserted.push(cells.join(''));
    });
    assert.deepEqual(inserted, ['AB', 'AB']);
    assert.deepEqual(h.a.read().toJSON(), h.b.read().toJSON());
  } finally { h.dispose(); }
});

test('column deletion and reorder converge, and column undo retains a remote cell edit', () => {
  for (const reverse of [false, true]) {
    const h = replicas('| H0 | H1 | H2 | H3 |\n| --- | --- | --- | --- |\n| D0 | D1 | D2 | D3 |');
    const undo = h.a.createUndoManager(localOrigin);
    try {
      const initial = h.a.read();
      const editedId = initial.firstChild!.child(1).child(2).firstChild!.attrs.id;
      h.a.applyDocumentChange(initial, reorderColumns(initial, [0, 3, 1, 2]), localOrigin);
      const operationGroups = new Set([...h.a.operations.values()].map((op) => `${op.clock}:${op.actor}:${op.transactionId}`));
      assert.equal(operationGroups.size, 1);
      replaceText(h.b, editedId, 'remote D2');
      exchange(h.left, h.right, reverse);
      undo.undo();
      assert.equal(h.a.read().firstChild!.child(1).child(2).textContent, 'remote D2');
      undo.redo();
      assert.equal(h.a.read().firstChild!.child(1).child(3).textContent, 'remote D2');
      exchange(h.left, h.right, reverse);
      const beforeA = h.a.read();
      const beforeB = h.b.read();
      h.a.applyDocumentChange(beforeA, reorderColumns(beforeA, [1, 0, 2, 3]), localOrigin);
      h.b.applyDocumentChange(beforeB, reorderColumns(beforeB, [0, 2, 3]), remoteOrigin);
      exchange(h.left, h.right, reverse);
      const rows: string[] = [];
      h.a.read().firstChild!.forEach((row) => {
        const order: string[] = [];
        row.forEach((cell) => order.push(cell.textContent.slice(-1)));
        rows.push(order.join(''));
      });
      assert.equal(new Set(rows).size, 1);
      assert.deepEqual(h.a.read().toJSON(), h.b.read().toJSON());
    } finally { undo.destroy(); h.dispose(); }
  }
});

test('incompatible concurrent row and column insertions retain recovery data without exposing a broken table', () => {
  const h = replicas('| H1 | H2 |\n| --- | --- |\n| D1 | D2 |');
  const reopened = new Y.Doc();
  try {
    const before = h.a.read();
    const row = schema.nodes.tableRow.create({ id: 'new-row' }, ['new-left', 'new-right'].map((id) => (
      schema.nodes.tableCell.create({ id: `${id}-cell` }, schema.nodes.paragraph.create({ id }, schema.text(id)))
    )));
    const table = before.firstChild!;
    const next = before.copy(Fragment.from(table.copy(table.content.append(Fragment.from(row)))));
    h.a.applyDocumentChange(before, next, localOrigin);
    h.b.applyDocumentChange(h.b.read(), insertColumn(h.b.read(), 'B'), remoteOrigin);
    exchange(h.left, h.right, true);
    assert.throws(() => h.a.read(), /structure_invalid/);
    assert.throws(() => h.b.read(), /structure_invalid/);
    assert.equal(h.a.content('new-left').toString(), 'new-left');
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(h.left));
    const recovered = new CollaborationBlockTree(reopened, schema);
    assert.equal(recovered.content('new-right').toString(), 'new-right');
    assert.equal(recovered.records.size, h.a.records.size);
    assert.throws(() => recovered.read(), /structure_invalid/);
  } finally { h.dispose(); reopened.destroy(); }
});
