import assert from 'node:assert/strict';
import { getSchema, type Editor } from '@tiptap/core';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import { initProseMirrorDoc, updateYFragment } from '@tiptap/y-tiptap';
import type { Doc } from 'yjs';

import { richMarkdownCodecExtensions } from '../../app/lib/markdown/rich-markdown-codec';
import { createRichMarkdownYDoc } from '../../app/lib/collaboration/markdown-state';
import { CollaborationBlockTree } from '../../app/lib/collaboration/block-tree';
import { richDocumentFormat } from '../../app/lib/collaboration/rich-document';
import { BLOCK_MOVE_TRANSACTION_META } from '../../app/lib/editor/block-reference';

/** Real document/schema/transactions; no DOM, provider, database or browser. */
export function createBlockTestEditor(document: Doc = createRichMarkdownYDoc('AAA\n\nBBB\n\nCCC')) {
  const schema = getSchema(richMarkdownCodecExtensions());
  const tree = richDocumentFormat(document) === 'tiptap_blocks' ? new CollaborationBlockTree(document, schema) : null;
  const initial = tree ? { doc: tree.read(), meta: { mapping: new Map(), isOMark: new Map() } }
    : initProseMirrorDoc(document.getXmlFragment('body'), schema);
  let state = EditorState.create({ schema, doc: initial.doc });
  const dispatch = (transaction: Transaction) => {
    const next = state.apply(transaction);
    if (tree) tree.applyDocumentChange(state.doc, next.doc, 'test-editor', transaction.getMeta(BLOCK_MOVE_TRANSACTION_META));
    else updateYFragment(document, document.getXmlFragment('body'), next.doc, initial.meta);
    state = next;
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
