import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';

/** Prefer a small replacement, but never accept the slice fitter's approximation. */
export function documentProjectionTransaction(state: EditorState, next: ProseMirrorNode): Transaction {
  const from = state.doc.content.findDiffStart(next.content);
  if (from === null) return state.tr;
  const end = state.doc.content.findDiffEnd(next.content)!;
  const overlap = Math.max(0, from - Math.min(end.a, end.b));
  let transaction = state.tr.replace(from, end.a + overlap, next.slice(from, end.b + overlap));
  if (!transaction.doc.eq(next)) transaction = state.tr.replaceWith(0, state.doc.content.size, next.content);
  if (!transaction.doc.eq(next)) throw new Error('The editor could not apply the exact document projection.');
  return transaction;
}

/** Appended transactions must not turn projection, focus or selection into a write.
 * ProseMirror only attaches appendedTransaction metadata after filtering. */
export function isUnexpectedDocumentAppender(transaction: Transaction, root: Transaction | null,
  projectionMeta: string, origin: object | null): boolean {
  return transaction.docChanged && Boolean(root && root !== transaction
    && (!root.docChanged || root.getMeta(projectionMeta) === origin));
}
