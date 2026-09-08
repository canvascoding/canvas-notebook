import assert from 'node:assert/strict';
import { getSchema, type Editor } from '@tiptap/core';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import { initProseMirrorDoc, updateYFragment } from '@tiptap/y-tiptap';
import type { Doc } from 'yjs';

import { richMarkdownCodecExtensions } from '../../app/lib/markdown/rich-markdown-codec';
import { createRichMarkdownYDoc } from '../../app/lib/collaboration/markdown-state';

/** Real document/schema/transactions; no DOM, provider, database or browser. */
export function createBlockTestEditor(document: Doc = createRichMarkdownYDoc('AAA\n\nBBB\n\nCCC')) {
  const schema = getSchema(richMarkdownCodecExtensions());
  const initial = initProseMirrorDoc(document.getXmlFragment('body'), schema);
  let state = EditorState.create({ schema, doc: initial.doc });
  const dispatch = (transaction: Transaction) => {
    state = state.apply(transaction);
    updateYFragment(document, document.getXmlFragment('body'), state.doc, initial.meta);
  };
  const editor = {
    get state() { return state; },
    schema,
    isEditable: true,
    isDestroyed: false,
    view: { dispatch },
    commands: { focus: () => true },
  } as unknown as Editor;
  return {
    editor,
    document,
    dispatch,
    textPosition(text: string) {
      let position: number | undefined;
      state.doc.descendants((node, pos) => {
        if (node.isText && node.text === text && position === undefined) position = pos;
      });
      assert.notEqual(position, undefined, `missing text: ${text}`);
      return position!;
    },
    blocks() {
      const blocks: Array<{ id: string; text: string }> = [];
      state.doc.forEach((node) => blocks.push({ id: node.attrs.id, text: node.textContent }));
      return blocks;
    },
  };
}
