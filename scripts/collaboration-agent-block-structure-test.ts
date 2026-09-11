import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';

import { hashAgentBlockJson, readAgentBlockStructure } from '../app/lib/collaboration/agent-block-structure';
import { BLOCK_TREE_KEY, CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';

const schema = getSchema(richMarkdownCodecExtensions());

function copy(doc: Y.Doc) {
  const cloned = new Y.Doc();
  Y.applyUpdate(cloned, Y.encodeStateAsUpdate(doc));
  return cloned;
}

test('fingerprints sort nested JSON keys while preserving child order, identities and attributes', () => {
  const left = { type: 'paragraph', attrs: { id: 'paragraph', align: 'left' }, content: [{ type: 'text', text: 'Hello' }] };
  const right = { content: [{ text: 'Hello', type: 'text' }], attrs: { align: 'left', id: 'paragraph' }, type: 'paragraph' };
  assert.equal(hashAgentBlockJson(left), hashAgentBlockJson(right));
  assert.notEqual(hashAgentBlockJson(left), hashAgentBlockJson({ ...left, attrs: { ...left.attrs, id: 'other' } }));
  assert.notEqual(hashAgentBlockJson(left), hashAgentBlockJson({ ...left, attrs: { ...left.attrs, align: 'right' } }));
  assert.notEqual(hashAgentBlockJson(['a', 'b']), hashAgentBlockJson(['b', 'a']));
  assert.throws(() => hashAgentBlockJson(undefined), /JSON value/u);
});

test('rich root, list and table blocks expose their visible hierarchy without writing Yjs', () => {
  const doc = createRichMarkdownYDoc('# Title\n\n- **First**\n- Second\n\n| A | B |\n| --- | --- |\n| one | two |', 'tiptap_blocks');
  try {
    const before = Y.encodeStateAsUpdate(doc);
    let updates = 0;
    doc.on('update', () => { updates++; });
    const blocks = readAgentBlockStructure(doc);
    const roots = blocks.filter((block) => block.parentId === null);
    assert.deepEqual(roots.map((block) => block.type), ['heading', 'bulletList', 'table']);
    assert.equal(roots[0].text, 'Title');
    assert.equal(roots[0].attrs.level, 1);
    assert.deepEqual(roots.map((block) => block.beforeId), [roots[1].id, roots[2].id, null]);
    const items = blocks.filter((block) => block.parentId === roots[1].id);
    assert.deepEqual(items.map((block) => [block.type, block.text]), [['listItem', 'First'], ['listItem', 'Second']]);
    assert.equal(items[0].beforeId, items[1].id);
    assert.equal(items[1].beforeId, null);
    assert.equal(blocks.find((block) => block.parentId === items[0].id)?.type, 'paragraph');
    const rows = blocks.filter((block) => block.parentId === roots[2].id);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((block) => block.type === 'tableRow'));
    assert.deepEqual(blocks.filter((block) => block.parentId === rows[0].id).map((block) => block.type), ['tableHeader', 'tableHeader']);
    assert.deepEqual(blocks.filter((block) => block.parentId === rows[1].id).map((block) => block.text), ['one', 'two']);
    assert.equal(new Set(blocks.map((block) => block.id)).size, blocks.length);
    assert.ok(blocks.every((block) => block.attrs.id === block.id && /^[a-f0-9]{64}$/u.test(block.subtreeHash)
      && /^[a-f0-9]{64}$/u.test(block.placementHash)));
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
    assert.equal(updates, 0);
    roots[0].attrs.level = 6;
    assert.equal(readAgentBlockStructure(doc).find((block) => block.id === roots[0].id)?.attrs.level, 1,
      'returned attributes cannot mutate the source document');
  } finally { doc.destroy(); }
});

test('moving preserves identity and subtree contents while updating the block placement fingerprint', () => {
  const doc = createRichMarkdownYDoc('AAA\n\nBBB\n\nCCC', 'tiptap_blocks');
  try {
    const before = readAgentBlockStructure(doc);
    const target = before[1];
    const tree = new CollaborationBlockTree(doc, schema);
    tree.move({ blockId: target.id, parentId: null, beforeId: before[0].id, operationId: 'move-b' }, 'agent');
    const after = readAgentBlockStructure(doc);
    assert.equal(after[0].id, target.id);
    assert.equal(after[0].beforeId, before[0].id);
    assert.equal(after[0].subtreeHash, target.subtreeHash);
    assert.notEqual(after[0].placementHash, target.placementHash);
    assert.equal(after.find((block) => block.id === before[0].id)?.placementHash, before[0].placementHash,
      'another block moving nearby does not alter the untouched block placement history');
  } finally { doc.destroy(); }
});

test('text edits change subtree hashes including their ancestors but never placement fingerprints', () => {
  const doc = createRichMarkdownYDoc('- **First**\n- Second', 'tiptap_blocks');
  try {
    const before = readAgentBlockStructure(doc);
    const paragraph = before.find((block) => block.type === 'paragraph' && block.text === 'First')!;
    const tree = new CollaborationBlockTree(doc, schema);
    const text = tree.content(paragraph.id).get(0) as Y.XmlText;
    text.insert(text.length, ' peer');
    const after = readAgentBlockStructure(doc);
    for (const entry of before) {
      const current = after.find((block) => block.id === entry.id)!;
      assert.equal(current.placementHash, entry.placementHash);
      if (entry.text.includes('First')) assert.notEqual(current.subtreeHash, entry.subtreeHash);
      else assert.equal(current.subtreeHash, entry.subtreeHash);
    }
  } finally { doc.destroy(); }
});

test('deleted containers and descendants disappear even though their records remain recoverable', () => {
  const doc = createRichMarkdownYDoc('Keep\n\n- First\n- Second', 'tiptap_blocks');
  try {
    const before = readAgentBlockStructure(doc);
    const list = before.find((block) => block.type === 'bulletList')!;
    const tree = new CollaborationBlockTree(doc, schema);
    tree.delete(list.id, 'delete-list', 'agent');
    const after = readAgentBlockStructure(doc);
    assert.deepEqual(after.map((block) => block.text), ['Keep']);
    for (const removed of before.filter((block) => block.text !== 'Keep')) {
      assert.ok(tree.records.has(removed.id));
      assert.ok(!after.some((block) => block.id === removed.id));
    }
  } finally { doc.destroy(); }
});

test('inserting an independent sibling does not invalidate existing placement hashes', () => {
  const doc = createRichMarkdownYDoc('AAA\n\nBBB\n\nCCC', 'tiptap_blocks');
  try {
    const before = readAgentBlockStructure(doc);
    const tree = new CollaborationBlockTree(doc, schema);
    const current = tree.read();
    const inserted = schema.nodes.paragraph.create({ id: 'inserted-sibling' }, schema.text('Peer'));
    const next = schema.topNodeType.create(null, [current.child(0), inserted, current.child(1), current.child(2)]);
    tree.applyDocumentChange(current, next, 'peer');
    const after = readAgentBlockStructure(doc);
    assert.deepEqual(after.map((block) => block.text), ['AAA', 'Peer', 'BBB', 'CCC']);
    assert.equal(after[0].beforeId, 'inserted-sibling', 'the current next sibling can change independently of placement history');
    for (const entry of before) assert.equal(after.find((block) => block.id === entry.id)?.placementHash, entry.placementHash);
  } finally { doc.destroy(); }
});

for (const prefix of ['a', 'z']) {
  test(`multiple inserts with lexically ${prefix === 'a' ? 'earlier' : 'later'} IDs never invent moves of existing siblings`, () => {
    const paragraph = (id: string) => schema.nodes.paragraph.create({ id }, schema.text(id));
    const original = schema.topNodeType.create(null, ['m-first', 'm-second', 'm-third'].map(paragraph));
    const doc = new Y.Doc();
    const tree = CollaborationBlockTree.create(doc, original);
    try {
      const before = readAgentBlockStructure(doc);
      // Include adjacent inserts and both ends, in non-lexical authored order.
      const inserted = [3, 2, 1, 0].map((index) => paragraph(`${prefix}-new-${index}`));
      const next = schema.topNodeType.create(null, [inserted[0], original.child(0), inserted[1], inserted[2],
        original.child(1), original.child(2), inserted[3]]);
      tree.applyDocumentChange(original, next, 'peer');
      assert.deepEqual(tree.read().toJSON(), next.toJSON());
      const after = readAgentBlockStructure(doc);
      for (const entry of before) assert.equal(after.find((block) => block.id === entry.id)?.placementHash, entry.placementHash);
      const moves = [...tree.operations.values()];
      assert.equal(moves.length, inserted.length, 'every new block receives exactly one explicit placement');
      assert.ok(moves.every((operation) => operation.kind === 'move' && operation.blockId.startsWith(`${prefix}-new-`)));
    } finally { doc.destroy(); }
  });
}

test('nested inserts preserve placement hashes of existing containers and their children', () => {
  const paragraph = (id: string) => schema.nodes.paragraph.create({ id }, schema.text(id));
  const nested = schema.nodes.blockquote.create({ id: 'm-nested' }, [paragraph('m-nested-a'), paragraph('m-nested-b')]);
  const quote = schema.nodes.blockquote.create({ id: 'm-quote' }, [paragraph('m-a'), nested, paragraph('m-b')]);
  const original = schema.topNodeType.create(null, [paragraph('m-before'), quote, paragraph('m-after')]);
  const doc = new Y.Doc();
  const tree = CollaborationBlockTree.create(doc, original);
  const origin = {};
  const undo = tree.createUndoManager(origin);
  try {
    const before = readAgentBlockStructure(doc);
    const nextNested = nested.copy(schema.nodes.doc.create(null, [paragraph('z-new-inner-before'), nested.child(0),
      paragraph('a-new-inner-middle'), nested.child(1)]).content);
    const newList = schema.nodes.bulletList.create({ id: 'z-new-list' }, [
      schema.nodes.listItem.create({ id: 'a-new-item' }, paragraph('z-new-item-body')),
    ]);
    const nextQuote = quote.copy(schema.nodes.doc.create(null, [quote.child(0), newList, nextNested,
      paragraph('z-new-outer'), quote.child(2)]).content);
    const next = schema.topNodeType.create(null, [original.child(0), paragraph('a-new-root'), nextQuote, original.child(2)]);
    tree.applyDocumentChange(original, next, origin);
    assert.deepEqual(tree.read().toJSON(), next.toJSON());
    const after = readAgentBlockStructure(doc);
    for (const entry of before) assert.equal(after.find((block) => block.id === entry.id)?.placementHash, entry.placementHash);
    assert.ok([...tree.operations.values()].every((operation) => operation.kind === 'move' && !operation.blockId.startsWith('m-')));
    undo.undo();
    assert.deepEqual(readAgentBlockStructure(doc), before, 'undo removes only the inserted blocks and their placements');
  } finally { undo.destroy(); doc.destroy(); }
});

test('an insert before a simultaneously reparented anchor is reconciled after the anchor arrives', () => {
  const paragraph = (id: string) => schema.nodes.paragraph.create({ id }, schema.text(id));
  const left = schema.nodes.blockquote.create({ id: 'left' }, [paragraph('left-keep'), paragraph('moving')]);
  const right = schema.nodes.blockquote.create({ id: 'right' }, paragraph('right-keep'));
  const original = schema.topNodeType.create(null, [left, right]);
  const doc = new Y.Doc();
  const tree = CollaborationBlockTree.create(doc, original);
  try {
    const next = schema.topNodeType.create(null, [left.copy(schema.nodes.doc.create(null, left.child(0)).content),
      right.copy(schema.nodes.doc.create(null, [paragraph('new-before-moving'), left.child(1), right.child(0)]).content)]);
    tree.applyDocumentChange(original, next, 'peer');
    assert.deepEqual(tree.read().toJSON(), next.toJSON());
    const blocks = readAgentBlockStructure(doc);
    assert.equal(blocks.find((block) => block.id === 'new-before-moving')?.beforeId, 'moving');
    assert.equal(blocks.find((block) => block.id === 'moving')?.parentId, 'right');
  } finally { doc.destroy(); }
});

test('undo restores the prior placement fingerprint while durable receipts remain', () => {
  const doc = createRichMarkdownYDoc('AAA\n\nBBB', 'tiptap_blocks');
  const tree = new CollaborationBlockTree(doc, schema);
  const origin = {};
  const undo = tree.createUndoManager(origin);
  try {
    const before = readAgentBlockStructure(doc);
    tree.move({ blockId: before[1].id, parentId: null, beforeId: before[0].id, operationId: 'move-b' }, origin);
    assert.notEqual(readAgentBlockStructure(doc)[0].placementHash, before[1].placementHash);
    undo.undo();
    assert.ok(tree.receipts.has('move-b'));
    assert.deepEqual(readAgentBlockStructure(doc), before);
  } finally { undo.destroy(); doc.destroy(); }
});

test('operation delivery order and binary reopening do not change fingerprints', () => {
  const base = createRichMarkdownYDoc('AAA\n\nBBB\n\nCCC', 'tiptap_blocks');
  const left = copy(base); const right = copy(base); const reopened = new Y.Doc();
  try {
    const blocks = readAgentBlockStructure(base);
    const a = new CollaborationBlockTree(left, schema); const b = new CollaborationBlockTree(right, schema);
    a.move({ blockId: blocks[1].id, parentId: null, beforeId: blocks[0].id, operationId: 'move-left' }, 'left');
    b.move({ blockId: blocks[1].id, parentId: null, beforeId: null, operationId: 'move-right' }, 'right');
    const leftUpdate = Y.encodeStateAsUpdate(left); const rightUpdate = Y.encodeStateAsUpdate(right);
    Y.applyUpdate(left, rightUpdate);
    Y.applyUpdate(right, leftUpdate);
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(left));
    assert.deepEqual(readAgentBlockStructure(left), readAgentBlockStructure(right));
    assert.deepEqual(readAgentBlockStructure(reopened), readAgentBlockStructure(left));
  } finally { for (const doc of [base, left, right, reopened]) doc.destroy(); }
});

test('legacy XML and empty documents are rejected without importing a block root', () => {
  for (const doc of [createRichMarkdownYDoc('Legacy', 'tiptap_xml'), new Y.Doc()]) {
    try {
      const before = Y.encodeStateAsUpdate(doc);
      assert.throws(() => readAgentBlockStructure(doc), /tiptap_blocks/u);
      assert.equal(doc.share.has(BLOCK_TREE_KEY), false);
      assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
    } finally { doc.destroy(); }
  }
});
