import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import * as Y from 'yjs';

import { BlockTreeConflict, CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import type { BlockPlacementOperation } from '../app/lib/collaboration/block-tree-placement';
import { richMarkdownSchemaExtensions } from '../app/lib/collaboration/markdown-state';

const schema = getSchema(richMarkdownSchemaExtensions());
const paragraph = (id: string, text = id) => schema.nodes.paragraph.create({ id }, schema.text(text));
const quote = (id: string, children: ProseMirrorNode[]) => schema.nodes.blockquote.create({ id }, children);
const document = (children: ProseMirrorNode[]) => schema.topNodeType.create(null, children);
const simple = () => document(['a', 'b', 'c', 'd'].map((id) => paragraph(id)));
const treeFor = (initial = simple()) => {
  const doc = new Y.Doc();
  return { doc, tree: CollaborationBlockTree.create(doc, initial) };
};
const reopen = (doc: Y.Doc) => {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return { doc: copy, tree: new CollaborationBlockTree(copy, schema) };
};
const operation = (tree: CollaborationBlockTree, id: string): BlockPlacementOperation => {
  const receipt = tree.receipts.get(id);
  assert.ok(receipt);
  return structuredClone(receipt);
};
const roots = (tree: CollaborationBlockTree) => tree.project().children.get(null);
const rejectsWithoutMutation = (tree: CollaborationBlockTree, expected: BlockPlacementOperation[], code = 'target_changed') => {
  const bytes = Y.encodeStateAsUpdate(tree.doc);
  assert.throws(() => tree.revertPlacementOperations(expected, 'agent-revert'),
    (error: unknown) => error instanceof BlockTreeConflict && error.code === code);
  assert.deepEqual(Y.encodeStateAsUpdate(tree.doc), bytes, 'a rejected group never changes live Yjs bytes');
};

test('move reversion preserves concurrent text, records, receipts and binary retry idempotence', () => {
  const initial = simple();
  const local = treeFor(initial);
  const peer = reopen(local.doc);
  let restored: ReturnType<typeof reopen> | undefined;
  try {
    const record = local.tree.records.get('a');
    const content = local.tree.content('a');
    local.tree.move({ blockId: 'a', parentId: null, beforeId: null, operationId: 'agent-move' }, 'agent');
    const expected = operation(local.tree, 'agent-move');
    peer.tree.updateInlineContent('a', paragraph('a', 'Human text survives'), 'human');
    Y.applyUpdate(local.doc, Y.encodeStateAsUpdate(peer.doc));
    assert.deepEqual(roots(local.tree), ['b', 'c', 'd', 'a']);
    local.tree.revertPlacementOperations([expected], 'agent-revert');
    assert.deepEqual(roots(local.tree), ['a', 'b', 'c', 'd']);
    assert.equal(local.tree.read().firstChild?.textContent, 'Human text survives');
    assert.equal(local.tree.records.get('a'), record);
    assert.equal(local.tree.content('a'), content);
    assert.deepEqual(local.tree.receipts.get(expected.id), expected);
    assert.equal(local.tree.operations.has(expected.id), false);
    restored = reopen(local.doc);
    const bytes = Y.encodeStateAsUpdate(restored.doc);
    restored.tree.revertPlacementOperations([expected], 'retry-revert');
    restored.tree.move({ blockId: 'a', parentId: null, beforeId: null, operationId: expected.id }, 'retry-apply');
    assert.deepEqual(Y.encodeStateAsUpdate(restored.doc), bytes, 'neither retry replays an undone operation');
    assert.equal(restored.tree.read().firstChild?.textContent, 'Human text survives');
  } finally { local.doc.destroy(); peer.doc.destroy(); restored?.doc.destroy(); }
});

test('delete reversion restores the same subtree and current text after a binary reload', () => {
  const initial = document([paragraph('keep'), quote('q', [paragraph('q1'), paragraph('q2')]), paragraph('tail')]);
  const local = treeFor(initial);
  const peer = reopen(local.doc);
  let restored: ReturnType<typeof reopen> | undefined;
  try {
    local.tree.delete('q', 'agent-delete', 'agent');
    const expected = operation(local.tree, 'agent-delete');
    assert.equal(expected.kind, 'delete');
    peer.tree.updateInlineContent('q1', paragraph('q1', 'Concurrent retained text'), 'human');
    Y.applyUpdate(local.doc, Y.encodeStateAsUpdate(peer.doc));
    restored = reopen(local.doc);
    const records = new Map(restored.tree.records);
    restored.tree.revertPlacementOperations([expected], 'agent-revert');
    assert.deepEqual(roots(restored.tree), ['keep', 'q', 'tail']);
    assert.deepEqual(restored.tree.project().children.get('q'), ['q1', 'q2']);
    assert.equal(restored.tree.read().child(1).firstChild?.textContent, 'Concurrent retained text');
    for (const [id, record] of records) assert.equal(restored.tree.records.get(id), record);
    assert.deepEqual(restored.tree.receipts.get(expected.id), expected);
    const bytes = Y.encodeStateAsUpdate(restored.doc);
    restored.tree.delete('q', expected.id, 'retry-delete');
    restored.tree.revertPlacementOperations([expected], 'retry-revert');
    assert.deepEqual(Y.encodeStateAsUpdate(restored.doc), bytes);
  } finally { local.doc.destroy(); peer.doc.destroy(); restored?.doc.destroy(); }
});

test('a complete multi-placement group is validated and reverted as one transaction', () => {
  const initial = document([quote('p', [paragraph('a')]), quote('q', [paragraph('b')]), paragraph('tail')]);
  const next = document([quote('p', [paragraph('b')]), quote('q', [paragraph('a')]), paragraph('tail')]);
  const { doc, tree } = treeFor(initial);
  try {
    tree.applyDocumentChange(initial, next, 'agent-swap');
    const expected = [...tree.operations.values()].map((value) => structuredClone(value));
    assert.ok(expected.length >= 2);
    rejectsWithoutMutation(tree, [expected[0], { ...expected[1], actor: expected[1].actor + 1 }]);
    rejectsWithoutMutation(tree, [expected[0], expected[0]], 'identity_invalid');
    let changes = 0;
    doc.on('update', () => { changes++; });
    tree.revertPlacementOperations(expected, 'agent-revert');
    assert.equal(changes, 1, 'the whole live change is a single Yjs update');
    assert.ok(tree.read().eq(initial));
    assert.equal(tree.operations.size, 0);
    assert.equal(tree.receipts.size, expected.length);
  } finally { doc.destroy(); }
});

for (const dependency of ['blockId', 'beforeId', 'delete'] as const) {
  test(`later foreign ${dependency} dependencies reject the entire reversion`, () => {
    const { doc, tree } = treeFor();
    try {
      tree.move({ blockId: 'a', parentId: null, beforeId: null, operationId: 'agent-move' }, 'agent');
      const expected = operation(tree, 'agent-move');
      if (dependency === 'blockId') tree.move({ blockId: 'a', parentId: null, beforeId: 'c', operationId: 'human-move' }, 'human');
      else if (dependency === 'beforeId') tree.move({ blockId: 'b', parentId: null, beforeId: 'a', operationId: 'human-move' }, 'human');
      else tree.delete('a', 'human-delete', 'human');
      rejectsWithoutMutation(tree, [expected]);
      assert.ok(tree.operations.has(dependency === 'delete' ? 'human-delete' : 'human-move'));
    } finally { doc.destroy(); }
  });
}

for (const dependency of ['parentId', 'descendant'] as const) {
  test(`later foreign ${dependency} dependencies on a moved container are retained`, () => {
    const { doc, tree } = treeFor(document([quote('q', [paragraph('q1'), paragraph('q2')]), paragraph('a'), paragraph('b')]));
    try {
      tree.move({ blockId: 'q', parentId: null, beforeId: null, operationId: 'agent-move' }, 'agent');
      const expected = operation(tree, 'agent-move');
      if (dependency === 'parentId') tree.move({ blockId: 'a', parentId: 'q', beforeId: 'q1', operationId: 'human-move' }, 'human');
      else tree.move({ blockId: 'q1', parentId: 'q', beforeId: null, operationId: 'human-move' }, 'human');
      rejectsWithoutMutation(tree, [expected]);
    } finally { doc.destroy(); }
  });
}

test('a different concurrent deletion can never be undone by removing the agent deletion', () => {
  const local = treeFor();
  const peer = reopen(local.doc);
  try {
    local.tree.delete('a', 'agent-delete', 'agent');
    const expected = operation(local.tree, 'agent-delete');
    peer.tree.delete('a', 'human-delete', 'human');
    Y.applyUpdate(local.doc, Y.encodeStateAsUpdate(peer.doc));
    rejectsWithoutMutation(local.tree, [expected]);
    assert.equal(local.tree.project().deleted.has('a'), true);
    assert.ok(local.tree.operations.has('human-delete'));
  } finally { local.doc.destroy(); peer.doc.destroy(); }
});

test('a previously rejected foreign move cannot become active during delete reversion', () => {
  const local = treeFor();
  const peer = reopen(local.doc);
  try {
    local.tree.delete('a', 'agent-delete', 'agent');
    const expected = operation(local.tree, 'agent-delete');
    peer.tree.updateInlineContent('d', paragraph('d', 'advance the independent causal clock'), 'human');
    peer.tree.move({ blockId: 'b', parentId: null, beforeId: 'a', operationId: 'human-move' }, 'human');
    Y.applyUpdate(local.doc, Y.encodeStateAsUpdate(peer.doc));
    assert.ok(local.tree.project().conflicts.some((conflict) => conflict.operationId === 'human-move'));
    rejectsWithoutMutation(local.tree, [expected]);
  } finally { local.doc.destroy(); peer.doc.destroy(); }
});

test('unrelated later placements and earlier moves of the same source remain valid', () => {
  const { doc, tree } = treeFor();
  try {
    tree.move({ blockId: 'a', parentId: null, beforeId: 'c', operationId: 'earlier-move' }, 'human');
    tree.move({ blockId: 'a', parentId: null, beforeId: null, operationId: 'agent-move' }, 'agent');
    const expected = operation(tree, 'agent-move');
    tree.move({ blockId: 'd', parentId: null, beforeId: 'b', operationId: 'later-unrelated' }, 'human');
    tree.revertPlacementOperations([expected], 'agent-revert');
    assert.deepEqual(roots(tree), ['d', 'b', 'a', 'c']);
    assert.ok(tree.operations.has('earlier-move'));
    assert.ok(tree.operations.has('later-unrelated'));
  } finally { doc.destroy(); }
});

test('missing or tampered receipts and active operations never authorize a removal', () => {
  const { doc, tree } = treeFor();
  try {
    tree.move({ blockId: 'a', parentId: null, beforeId: null, operationId: 'agent-move' }, 'agent');
    const expected = operation(tree, 'agent-move');
    rejectsWithoutMutation(tree, [{ ...expected, transactionId: 'another-transaction' }]);
    tree.operations.set(expected.id, { ...expected, ordinal: expected.ordinal + 1 });
    rejectsWithoutMutation(tree, [expected]);
    tree.operations.set(expected.id, expected);
    tree.receipts.delete(expected.id);
    rejectsWithoutMutation(tree, [expected]);
    tree.operations.delete(expected.id);
    rejectsWithoutMutation(tree, [expected]);
  } finally { doc.destroy(); }
});
