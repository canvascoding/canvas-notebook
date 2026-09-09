import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';

const schema = getSchema(richMarkdownSchemaExtensions());
const paragraph = (id: string) => schema.nodes.paragraph.create({ id }, [schema.text(`Text ${id} 👋`)]);
const quote = (id: string, children: ProseMirrorNode[]) => schema.nodes.blockquote.create({ id }, children);
const fixture = schema.topNodeType.create(null, [
  quote('a', [paragraph('a1'), quote('nested', [paragraph('n1'), paragraph('n2')]), paragraph('a2')]),
  quote('b', [paragraph('b1'), paragraph('b2')]),
  quote('c', [paragraph('c1'), paragraph('c2')]),
  paragraph('keep'),
]);
const initialIds: string[] = [];
fixture.descendants(node => { if (!node.isText) initialIds.push(node.attrs.id); });
const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const origins = [Symbol('move'), Symbol('delete'), Symbol('text')];

function cluster(actors: number[]) {
  const seed = new Y.Doc();
  seed.clientID = 1;
  CollaborationBlockTree.create(seed, fixture);
  const initial = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  const docs = actors.map(actor => { const doc = new Y.Doc(); Y.applyUpdate(doc, initial); doc.clientID = actor; return doc; });
  const trees = docs.map(doc => new CollaborationBlockTree(doc, schema));
  return { initial, docs, trees, destroy: () => docs.forEach(doc => doc.destroy()) };
}

function capture(doc: Y.Doc, action: () => void): Uint8Array {
  const updates: Uint8Array[] = [];
  const listener = (update: Uint8Array) => updates.push(update);
  doc.on('update', listener);
  try { action(); } finally { doc.off('update', listener); }
  assert.ok(updates.length, 'the tested action must actually produce an update');
  return Y.mergeUpdates(updates);
}

function find(tree: CollaborationBlockTree, id: string): ProseMirrorNode {
  let result: ProseMirrorNode | undefined;
  tree.read().descendants(node => { if (node.attrs.id === id) result = node; });
  assert.ok(result, `missing visible ${id}`);
  return result;
}

function edit(tree: CollaborationBlockTree, id: string) {
  const current = find(tree, id);
  tree.updateInlineContent(id, current.type.create(current.attrs, schema.text(`Peer ${id} 🌍`)), origins[2]);
}

function assertState(tree: CollaborationBlockTree, valid: boolean) {
  const bytes = Y.encodeStateAsUpdate(tree.doc);
  const validation = validateRichMarkdownYDoc(tree.doc);
  assert.equal(validation.valid, valid, JSON.stringify(validation));
  assert.deepEqual(Y.encodeStateAsUpdate(tree.doc), bytes, 'validation cannot repair or mutate the recovery state');
  assert.deepEqual([...tree.records.keys()].sort(), [...initialIds].sort(), 'all block records remain available');
  if (!valid) {
    assert.throws(() => tree.read(), /structure_invalid/);
    assert.ok(tree.project().conflicts.some(conflict => conflict.reason === 'orphan'));
    return;
  }
  const seen = new Set<string>();
  tree.read().descendants(node => {
    if (node.isText) return;
    assert.equal(seen.has(node.attrs.id), false);
    assert.equal(tree.project().deleted.has(node.attrs.id), false);
    seen.add(node.attrs.id);
  });
  assert.equal(tree.project().conflicts.some(conflict => conflict.reason === 'orphan'), false);
  assert.equal(find(tree, 'keep').textContent, 'Text keep 👋');
}

function replay(initial: Uint8Array, packets: Uint8Array[], order: number[], restartAfter: number) {
  let doc = new Y.Doc();
  Y.applyUpdate(doc, initial);
  for (let index = 0; index < order.length; index++) {
    if (index === restartAfter) {
      const saved = Y.encodeStateAsUpdate(doc);
      doc.destroy();
      doc = new Y.Doc();
      Y.applyUpdate(doc, saved);
    }
    Y.applyUpdate(doc, packets[order[index]]);
    Y.applyUpdate(doc, packets[order[index]]); // transport retry, including after a restart
  }
  return doc;
}

for (const scenario of [
  { name: 'delete source parent while moving its child out', block: 'a1', parent: 'a', causal: false },
  { name: 'delete ancestor while moving a nested descendant out', block: 'n1', parent: 'a', causal: false },
  { name: 'delete target parent while moving a child in', block: 'a1', parent: 'b', causal: false },
  { name: 'delete source parent after observing the child leave', block: 'a1', parent: 'a', causal: true },
  { name: 'delete target parent after observing the child arrive', block: 'a1', parent: 'b', causal: true },
]) test(scenario.name, () => {
  for (const actorOrder of orders) {
    const actors = actorOrder.map(index => (index + 1) * 10);
    const h = cluster(actors);
    const movedContent = h.trees[0].content(scenario.block);
    const undoIndex = scenario.parent === 'b' && !scenario.causal ? 0 : 1;
    const undo = h.trees[undoIndex].createUndoManager(origins[undoIndex]);
    try {
      const move = { blockId: scenario.block, parentId: 'b', beforeId: null, operationId: 'move-child' };
      const moveUpdate = capture(h.docs[0], () => h.trees[0].move(move, origins[0]));
      assert.equal(h.trees[0].content(scenario.block), movedContent, 'move cannot replace the integrated text fragment');
      if (scenario.causal) Y.applyUpdate(h.docs[1], moveUpdate);
      const deleteUpdate = capture(h.docs[1], () => h.trees[1].delete(scenario.parent, 'delete-parent', origins[1]));
      const editUpdate = capture(h.docs[2], () => edit(h.trees[2], scenario.block));
      const packets = [moveUpdate, deleteUpdate, editUpdate];
      const orphan = !scenario.causal && scenario.parent === 'b' && actors[0] < actors[1];
      const deleted = scenario.parent === 'a' ? !scenario.causal : scenario.causal;
      let expected: ReturnType<CollaborationBlockTree['project']> | undefined;
      let expectedDocument: ReturnType<ProseMirrorNode['toJSON']> | undefined;
      for (const delivery of orders) for (const restart of [0, 1, 2]) {
        const doc = replay(h.initial, packets, delivery, restart);
        try {
          const tree = new CollaborationBlockTree(doc, schema);
          assertState(tree, !orphan);
          assert.equal(tree.content(scenario.block).toString(), `Peer ${scenario.block} 🌍`);
          assert.equal(tree.project().deleted.has(scenario.block), deleted);
          assert.equal(tree.project().deleted.has(scenario.parent), true);
          if (expected) assert.deepEqual(tree.project(), expected, 'delivery and restart order cannot change placement/conflicts');
          else expected = tree.project();
          if (!orphan) {
            const json = tree.read().toJSON();
            if (expectedDocument) assert.deepEqual(json, expectedDocument);
            else expectedDocument = json;
            if (!deleted) assert.equal(find(tree, scenario.block).textContent, `Peer ${scenario.block} 🌍`);
          }
        } finally { doc.destroy(); }
      }
      for (const doc of h.docs) for (const update of packets) Y.applyUpdate(doc, update);
      const undoUpdate = capture(h.docs[undoIndex], () => undo.undo());
      for (const doc of h.docs) Y.applyUpdate(doc, undoUpdate);
      for (const tree of h.trees) {
        assertState(tree, true);
        assert.equal(find(tree, scenario.block).textContent, `Peer ${scenario.block} 🌍`, 'selective undo retains the third participant text');
        assert.deepEqual(tree.read().toJSON(), h.trees[undoIndex].read().toJSON());
        if (undoIndex === 0) assert.equal(tree.project().deleted.has('b'), true, 'undo of move does not undo peer deletion');
        else assert.equal(tree.project().parents.get(scenario.block), 'b', 'undo of deletion retains peer movement');
      }
      const stateBeforeRetry = Y.encodeStateAsUpdate(h.docs[undoIndex]);
      if (undoIndex === 0) h.trees[0].move(move, origins[0]);
      else h.trees[1].delete(scenario.parent, 'delete-parent', origins[1]);
      assert.deepEqual(Y.encodeStateAsUpdate(h.docs[undoIndex]), stateBeforeRetry, 'retry cannot redo an undone operation');
      const redoUpdate = capture(h.docs[undoIndex], () => undo.redo());
      for (const doc of h.docs) Y.applyUpdate(doc, redoUpdate);
      for (const tree of h.trees) {
        assertState(tree, !orphan);
        assert.equal(tree.content(scenario.block).toString(), `Peer ${scenario.block} 🌍`);
      }
    } finally { undo.destroy(); h.destroy(); }
  }
});

test('three concurrent ancestor moves converge without cycles across delivery, retry and restart', () => {
  for (const actorOrder of orders) {
    const h = cluster(actorOrder.map(index => (index + 1) * 10));
    try {
      const ids = ['a', 'b', 'c'];
      const packets = ids.map((id, index) => capture(h.docs[index], () => {
        h.trees[index].move({ blockId: id, parentId: ids[(index + 1) % 3], beforeId: null, operationId: `move-${id}` }, origins[index]);
        edit(h.trees[index], `${id}1`);
      }));
      let expected: ReturnType<ProseMirrorNode['toJSON']> | undefined;
      for (const delivery of orders) for (const restart of [0, 1, 2]) {
        const doc = replay(h.initial, packets, delivery, restart);
        try {
          const tree = new CollaborationBlockTree(doc, schema);
          assertState(tree, true);
          assert.equal(tree.project().conflicts.filter(conflict => conflict.reason === 'cycle').length, 1);
          assert.equal(tree.project().deleted.size, 0);
          for (const id of ids) assert.equal(find(tree, `${id}1`).textContent, `Peer ${id}1 🌍`);
          const json = tree.read().toJSON();
          if (expected) assert.deepEqual(json, expected);
          else expected = json;
        } finally { doc.destroy(); }
      }
    } finally { h.destroy(); }
  }
});
