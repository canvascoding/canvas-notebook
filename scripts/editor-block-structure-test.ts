import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBlockTestEditor } from '../tests/fixtures/editor-block-test-harness';
import { createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { getReorderableBlockRangeAt, moveReorderableBlock } from '../app/lib/editor/reorderable-blocks';

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
    const source = getReorderableBlockRangeAt(h.editor, h.textPosition('BBB'))!;
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
