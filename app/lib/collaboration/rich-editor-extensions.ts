import type { Extensions } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';

import { createBlockTreeCollaborationExtension, REMOTE_BLOCK_TREE_TRANSACTION } from './block-tree-editor';
import { createBlockTreeCaretExtension } from './block-tree-carets';
import { createAgentTargetDecorationExtension } from './agent-target-decorations';
import type { RichTextCollaborationRepresentation } from './types';

type CaretUser = { name: string; color: string; colorLight?: string };

/** One binding is selected from the server-confirmed representation. */
export function createRichEditorCollaborationExtensions(options: {
  document: Y.Doc;
  representation: RichTextCollaborationRepresentation;
  awareness: Awareness | null;
  user: CaretUser;
  renderCaret?: (user: Record<string, unknown>) => HTMLElement;
  selectionRender?: (user: Record<string, unknown>) => Record<string, string>;
  onError?: (error: Error) => void;
}): Extensions {
  const extensions: Extensions = options.representation === 'tiptap_blocks'
    ? [createBlockTreeCollaborationExtension({ document: options.document, onError: options.onError })]
    : [Collaboration.configure({ document: options.document, field: 'body' })];
  if (options.awareness) {
    extensions.push(options.representation === 'tiptap_blocks'
      ? createBlockTreeCaretExtension({ document: options.document, awareness: options.awareness,
          user: options.user, render: options.renderCaret, selectionRender: options.selectionRender })
      : CollaborationCaret.configure({ provider: { awareness: options.awareness }, user: options.user,
          ...(options.renderCaret ? { render: options.renderCaret } : {}),
          ...(options.selectionRender ? { selectionRender: options.selectionRender } : {}) }));
  }
  extensions.push(createAgentTargetDecorationExtension(options.document));
  return extensions;
}

export function isRemoteRichEditorTransaction(transaction: Transaction): boolean {
  return isChangeOrigin(transaction) || Boolean(transaction.getMeta(REMOTE_BLOCK_TREE_TRANSACTION));
}
