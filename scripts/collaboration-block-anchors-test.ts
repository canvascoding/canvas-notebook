import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import { initProseMirrorDoc } from '@tiptap/y-tiptap';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { captureBlockTreeSelection, createBlockTreeAnchor, resolveBlockTreeAnchor, restoreBlockTreeSelection } from '../app/lib/collaboration/block-tree-anchors';

const schema = getSchema(richMarkdownCodecExtensions());

function fixture(markdown = 'AAA\n\nBBB\n\nCCC') {
  const legacy = createRichMarkdownYDoc(markdown);
  const doc = new Y.Doc();
  const initial = initProseMirrorDoc(legacy.getXmlFragment('body'), schema).doc;
  legacy.destroy();
  const tree = CollaborationBlockTree.create(doc, initial);
  return { tree, doc, initial };
}

test('a text selection follows identity across a move and subsequent insertion', () => {
  const h = fixture();
  try {
    const offset = h.initial.firstChild!.nodeSize;
    const id = h.initial.child(1).attrs.id;
    const selected = captureBlockTreeSelection(h.tree, h.initial, TextSelection.create(h.initial, offset + 2, offset + 3))!;
    h.tree.move({ blockId: id, parentId: null, beforeId: null, operationId: 'move' }, {});
    const text = h.tree.content(id).get(0) as Y.XmlText;
    text.insert(0, 'prefix');
    const current = h.tree.read();
    const selection = restoreBlockTreeSelection(h.tree, current, selected)!;
    assert.equal(selection.from, h.initial.child(0).nodeSize + h.initial.child(2).nodeSize + 8);
    assert.equal(current.textBetween(selection.from, selection.to), 'B');
  } finally { h.doc.destroy(); }
});

test('an anchor cannot be redirected to an equal-looking block or a deleted block', () => {
  const h = fixture('Same\n\nSame\n\nTail');
  try {
    const anchor = createBlockTreeAnchor(h.tree, h.initial, 2)!;
    const otherId = h.initial.child(1).attrs.id;
    assert.equal(resolveBlockTreeAnchor(h.tree, h.initial, { ...anchor, blockId: otherId }), null);
    h.tree.delete(anchor.blockId, 'delete', {});
    assert.equal(resolveBlockTreeAnchor(h.tree, h.tree.read(), anchor), null);
  } finally { h.doc.destroy(); }
});

test('inline atoms, marks, Unicode and block boundaries roundtrip without anchor drift', () => {
  const h = fixture('**A👩🏽‍💻** $x$ B  \nC\n\nTail');
  try {
    const block = h.initial.firstChild!;
    for (let offset = 0; offset <= block.content.size; offset += 1) {
      const anchor = createBlockTreeAnchor(h.tree, h.initial, offset + 1);
      assert.ok(anchor, `missing anchor at ${offset}`);
      assert.equal(resolveBlockTreeAnchor(h.tree, h.initial, anchor), offset + 1);
    }
  } finally { h.doc.destroy(); }
});

test('a node selection follows a moved container and survives binary restore', () => {
  const h = fixture('> Quote\n\nTail');
  const restored = new Y.Doc();
  try {
    const selection = captureBlockTreeSelection(h.tree, h.initial, NodeSelection.create(h.initial, 0))!;
    h.tree.move({ blockId: h.initial.firstChild!.attrs.id, parentId: null, beforeId: null, operationId: 'move' }, {});
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(h.doc));
    const tree = new CollaborationBlockTree(restored, schema);
    const current = tree.read();
    const resolved = restoreBlockTreeSelection(tree, current, selection)!;
    assert.ok(resolved instanceof NodeSelection);
    assert.equal(resolved.from, current.firstChild!.nodeSize);
    assert.equal(resolved.node.textContent, 'Quote');
  } finally { h.doc.destroy(); restored.destroy(); }
});
