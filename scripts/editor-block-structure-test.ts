import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBlockTestEditor } from '../tests/fixtures/editor-block-test-harness';
import { createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { applyReorderableBlockMove, getReorderableBlockRangeAt, moveReorderableBlock, type BlockDropTarget } from '../app/lib/editor/reorderable-blocks';

test('a move preserves edits received after drag start', () => {
  const h = createBlockTestEditor();
  try {
    const before = h.blocks();
    const from = h.textPosition('BBB');
    const source = getReorderableBlockRangeAt(h.editor, from)!;
    h.dispatch(h.editor.state.tr.insertText('NEW', from, from + 3));
    assert.equal(moveReorderableBlock(h.editor, source, h.editor.state.doc.content.size), true);
    assert.deepEqual(h.blocks(), [before[0], before[2], { ...before[1], text: 'NEW' }]);
  } finally { h.document.destroy(); }
});

test('inserting before a dragged block does not delete a neighbor or duplicate its source', () => {
  const h = createBlockTestEditor();
  try {
    const before = h.blocks();
    const source = getReorderableBlockRangeAt(h.editor, h.textPosition('BBB'))!;
    h.dispatch(h.editor.state.tr.insert(0, h.editor.schema.nodes.paragraph.create({ id: 'inserted' }, h.editor.schema.text('XXX'))));
    assert.equal(moveReorderableBlock(h.editor, source, h.editor.state.doc.content.size), true);
    assert.deepEqual(h.blocks(), [{ id: 'inserted', text: 'XXX' }, before[0], before[2], before[1]]);
  } finally { h.document.destroy(); }
});

test('a deleted drag source is never resurrected', () => {
  const h = createBlockTestEditor();
  try {
    const source = getReorderableBlockRangeAt(h.editor, h.textPosition('AAA'))!;
    h.dispatch(h.editor.state.tr.delete(source.from, source.to));
    const beforeDrop = h.blocks();
    assert.equal(moveReorderableBlock(h.editor, source, h.editor.state.doc.content.size), false);
    assert.deepEqual(h.blocks(), beforeDrop);
  } finally { h.document.destroy(); }
});

test('a drag cannot apply after editing permission is removed', () => {
  const h = createBlockTestEditor();
  try {
    const before = h.blocks();
    const source = getReorderableBlockRangeAt(h.editor, h.textPosition('BBB'))!;
    Object.defineProperty(h.editor, 'isEditable', { value: false });
    assert.equal(moveReorderableBlock(h.editor, source, h.editor.state.doc.content.size), false);
    assert.deepEqual(h.blocks(), before);
  } finally { h.document.destroy(); }
});

test('a task item is selected independently of its task list', () => {
  const h = createBlockTestEditor(createRichMarkdownYDoc('- [ ] First\n- [x] Second'));
  try {
    const source = getReorderableBlockRangeAt(h.editor, h.textPosition('Second'))!;
    assert.equal(source.node.type.name, 'taskItem');
    assert.equal(source.kind, 'listItem');
  } finally { h.document.destroy(); }
});

test('the drop follows a target that moved while the source text grew', () => {
  const h = createBlockTestEditor();
  try {
    const before = h.blocks();
    const source = getReorderableBlockRangeAt(h.editor, h.textPosition('AAA'))!;
    const target = getReorderableBlockRangeAt(h.editor, h.textPosition('CCC'))!;
    const destination: BlockDropTarget = { target, placement: 'after', insertPosition: target.to };
    const from = h.textPosition('AAA');
    h.dispatch(h.editor.state.tr.insertText('longer current content', from, from + 3));
    assert.equal(moveReorderableBlock(h.editor, source, destination), true);
    assert.deepEqual(h.blocks(), [before[1], before[2], { ...before[0], text: 'longer current content' }]);
  } finally { h.document.destroy(); }
});

test('a removed target cancels a move without modifying other blocks', () => {
  const h = createBlockTestEditor();
  try {
    const source = getReorderableBlockRangeAt(h.editor, h.textPosition('AAA'))!;
    const target = getReorderableBlockRangeAt(h.editor, h.textPosition('BBB'))!;
    h.dispatch(h.editor.state.tr.delete(target.from, target.to));
    const before = h.blocks();
    assert.deepEqual(applyReorderableBlockMove(h.editor, source, {
      target, placement: 'after', insertPosition: target.to,
    }), { ok: false, reason: 'target_changed' });
    assert.deepEqual(h.blocks(), before);
  } finally { h.document.destroy(); }
});

test('another editor cannot apply a captured reference even to the same document', () => {
  const h = createBlockTestEditor();
  const other = createBlockTestEditor(h.document);
  try {
    const source = getReorderableBlockRangeAt(h.editor, h.textPosition('AAA'))!;
    const before = other.blocks();
    assert.deepEqual(applyReorderableBlockMove(other.editor, source, other.editor.state.doc.content.size), {
      ok: false, reason: 'source_changed',
    });
    assert.deepEqual(other.blocks(), before);
  } finally { h.document.destroy(); }
});

test('duplicate identity is an explicit conflict, never a first-match move', () => {
  const h = createBlockTestEditor();
  try {
    const source = getReorderableBlockRangeAt(h.editor, h.textPosition('AAA'))!;
    const target = getReorderableBlockRangeAt(h.editor, h.textPosition('BBB'))!;
    h.dispatch(h.editor.state.tr.setNodeAttribute(target.from, 'id', source.node.attrs.id));
    const before = h.blocks();
    assert.deepEqual(applyReorderableBlockMove(h.editor, source, h.editor.state.doc.content.size), {
      ok: false, reason: 'source_changed',
    });
    assert.deepEqual(h.blocks(), before);
  } finally { h.document.destroy(); }
});

test('a task move keeps its checkbox, descendants and updated parent boundaries', () => {
  const h = createBlockTestEditor(createRichMarkdownYDoc('- [ ] First\n- [x] Second\n- [ ] Third'));
  try {
    const source = getReorderableBlockRangeAt(h.editor, h.textPosition('Second'))!;
    const target = getReorderableBlockRangeAt(h.editor, h.textPosition('First'))!;
    const from = h.textPosition('Third');
    h.dispatch(h.editor.state.tr.insertText('Third item grew', from, from + 5));
    assert.equal(moveReorderableBlock(h.editor, source, { target, placement: 'before', insertPosition: target.from }), true);
    const list = h.editor.state.doc.firstChild!;
    assert.deepEqual(Array.from({ length: list.childCount }, (_, i) => list.child(i).textContent), [
      'Second', 'First', 'Third item grew',
    ]);
    assert.equal(list.firstChild!.attrs.checked, true);
    assert.equal(list.firstChild!.attrs.id, source.node.attrs.id);
    assert.equal(list.firstChild!.firstChild!.attrs.id, source.node.firstChild!.attrs.id);
  } finally { h.document.destroy(); }
});

test('drops into text, descendants, outside the parent or after destruction do nothing', () => {
  const h = createBlockTestEditor(createRichMarkdownYDoc('- A\n- B\n\nTail'));
  try {
    const source = getReorderableBlockRangeAt(h.editor, h.textPosition('A'))!;
    const before = h.editor.state.doc;
    for (const position of [h.textPosition('B') + 1, h.editor.state.doc.content.size, -1, NaN]) {
      assert.deepEqual(applyReorderableBlockMove(h.editor, source, position), { ok: false, reason: 'invalid_destination' });
      assert.equal(h.editor.state.doc, before);
    }
    Object.defineProperty(h.editor, 'isDestroyed', { value: true });
    assert.deepEqual(applyReorderableBlockMove(h.editor, source, source.parentTo), { ok: false, reason: 'read_only' });
    assert.equal(h.editor.state.doc, before);
  } finally { h.document.destroy(); }
});
