import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';

import { BLOCK_MOVE_TRANSACTION_META } from './block-reference';

export type Typing = { blockId: string; kind: 'insert' | 'backspace' | 'delete'; marks: string };

export function typingTransaction(transaction: Transaction, state: EditorState): Typing | null {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty || transaction.steps.length !== 1
    || transaction.getMeta('uiEvent') || transaction.getMeta(BLOCK_MOVE_TRANSACTION_META)) return null;
  const step = transaction.steps[0];
  if (!(step instanceof ReplaceStep) || step.slice.openStart || step.slice.openEnd
    || step.from < selection.$from.start() || step.to > selection.$from.end()) return null;
  const parent = selection.$from.parent;
  const blockId = parent.attrs.id;
  if (!parent.inlineContent || typeof blockId !== 'string' || !blockId) return null;
  const onlyText = (doc: ProseMirrorNode) => {
    let result = true;
    doc.descendants((node) => { if (!node.isText) result = false; });
    return result;
  };
  if (!onlyText(parent.copy(step.slice.content)) || !onlyText(parent.copy(state.doc.slice(step.from, step.to).content))) return null;
  const inserted = step.slice.content.size;
  const deleted = step.to - step.from;
  let kind: Typing['kind'];
  if (!deleted && inserted && selection.from === step.from) kind = 'insert';
  else if (!inserted && deleted && selection.from === step.to) kind = 'backspace';
  else if (!inserted && deleted && selection.from === step.from) kind = 'delete';
  else return null;
  return { blockId, kind, marks: JSON.stringify(step.slice.content.firstChild?.marks.map((mark) => mark.toJSON()) ?? []) };
}
