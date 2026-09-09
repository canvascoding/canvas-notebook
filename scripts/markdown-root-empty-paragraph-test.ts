import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';
import { createRichMarkdownManager, richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { generateRichNodeIds } from '../app/lib/editor/generate-rich-node-ids';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';

const extensions = richMarkdownCodecExtensions();
const schema = getSchema(extensions);
const manager = createRichMarkdownManager();
for (const source of ['Text', '# Heading', '```text\nCode\n```', '> Quote', '- [ ] Task',
  '| A |\n| --- |\n| B |', '[^test]: Footnote', '> [!note] Title\n> Body',
  '<details>\n<summary>Summary</summary>\n\nBody\n\n</details>', '***']) {
  test(`an empty root block survives a move after ${source.split('\n')[0]}`, () => {
    const node = manager.parse(source).content![0];
    const state = generateRichNodeIds({ type: 'doc', content: [node, { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: 'Moved here' }] }] }, extensions);
    const doc = new Y.Doc();
    try {
      CollaborationBlockTree.create(doc, schema.nodeFromJSON(state));
      assert.equal(validateRichMarkdownYDoc(doc).valid, true);
      const copy = new Y.Doc();
      try {
        Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
        assert.deepEqual(new CollaborationBlockTree(copy, schema).read().toJSON(), state);
        assert.equal(validateRichMarkdownYDoc(copy).valid, true);
      } finally { copy.destroy(); }
    } finally { doc.destroy(); }
  });
}
