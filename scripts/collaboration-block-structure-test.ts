import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc, XmlElement, XmlText } from 'yjs';

import { createBlockTestEditor } from '../tests/fixtures/editor-block-test-harness';
import { createRichMarkdownYDoc, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { Y, TiptapTransformer } from '../app/lib/collaboration/server-runtime';
import { getReorderableBlockRangeAt, moveReorderableBlock } from '../app/lib/editor/reorderable-blocks';

function blocks(doc: Doc) {
  const json = TiptapTransformer.fromYdoc(doc, 'body') as {
    content: Array<{ attrs: { id: string }; content?: Array<{ text?: string }> }>;
  };
  return json.content.map((node) => ({ id: node.attrs.id, text: node.content?.map((child) => child.text ?? '').join('') ?? '' }));
}

function replicas() {
  const left = createRichMarkdownYDoc('AAA\n\nBBB\n\nCCC');
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  // Fixed client IDs make every failure repeatable, independent of random IDs.
  left.clientID = 10;
  right.clientID = 20;
  return { left, right };
}

function exchange(left: Doc, right: Doc) {
  const leftUpdate = Y.encodeStateAsUpdate(left);
  const rightUpdate = Y.encodeStateAsUpdate(right);
  Y.applyUpdate(left, rightUpdate);
  Y.applyUpdate(right, leftUpdate);
  // Delivery retries must not change the result.
  Y.applyUpdate(left, rightUpdate);
  Y.applyUpdate(right, leftUpdate);
}

test('a concurrent text edit follows its moved block, not the block at its old position', () => {
  const { left, right } = replicas();
  try {
    const before = blocks(left);
    const moved = createBlockTestEditor(left);
    const source = getReorderableBlockRangeAt(moved.editor, moved.textPosition('BBB'))!;
    moveReorderableBlock(moved.editor, source, moved.editor.state.doc.content.size);
    const target = (right.getXmlFragment('body').get(1) as XmlElement).get(0) as XmlText;
    right.transact(() => { target.delete(0, 3); target.insert(0, 'NEW'); }, { actorType: 'agent' });
    exchange(left, right);
    const expected = [before[0], before[2], { ...before[1], text: 'NEW' }];
    assert.deepEqual(blocks(left), expected);
    assert.deepEqual(blocks(right), expected);
    assert.equal(validateRichMarkdownYDoc(left).valid, true);
  } finally { left.destroy(); right.destroy(); }
});

test('two concurrent moves preserve one copy of each block and every original text', () => {
  const { left, right } = replicas();
  try {
    const before = blocks(left);
    for (const [doc, destination] of [[left, 'end'], [right, 'start']] as const) {
      const h = createBlockTestEditor(doc);
      moveReorderableBlock(h.editor, getReorderableBlockRangeAt(h.editor, h.textPosition('BBB'))!,
        destination === 'end' ? h.editor.state.doc.content.size : 0);
    }
    exchange(left, right);
    assert.deepEqual(blocks(left), blocks(right), 'replicas converge');
    const byId = (entries: ReturnType<typeof blocks>) => [...entries].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(byId(blocks(left)), byId(before), 'convergence must also preserve identity and content');
    assert.equal(validateRichMarkdownYDoc(left).valid, true);
  } finally { left.destroy(); right.destroy(); }
});
