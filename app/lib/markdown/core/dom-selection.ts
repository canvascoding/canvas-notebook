import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

function selectionNodeBelongsToEditor(view: EditorView, node: Node): boolean {
  return node === view.dom || view.dom.contains(node);
}

/**
 * Reconciles the browser's visible DOM selection with ProseMirror immediately
 * before input, copy/cut, caret scrolling, or a controlled document replacement.
 * On iOS the native caret/selection handles can update the DOM range before
 * ProseMirror observes the corresponding selectionchange event. Consumers that
 * use editor.state.selection in that gap would act on a stale document position.
 */
export function synchronizeEditorSelectionFromDom(view: EditorView): boolean {
  // The browser owns the transient DOM selection while an IME or autocorrect
  // composition is active. Dispatching a ProseMirror selection transaction in
  // that interval can prematurely commit or move the composing text.
  if (view.composing) return false;

  const domSelection = view.dom.ownerDocument.getSelection();
  const { anchorNode, focusNode } = domSelection || {};
  if (
    !domSelection
    || !anchorNode
    || !focusNode
    || !selectionNodeBelongsToEditor(view, anchorNode)
    || !selectionNodeBelongsToEditor(view, focusNode)
  ) return false;

  try {
    const anchor = view.posAtDOM(anchorNode, domSelection.anchorOffset, 1);
    const head = view.posAtDOM(focusNode, domSelection.focusOffset, 1);
    const selection = TextSelection.between(
      view.state.doc.resolve(anchor),
      view.state.doc.resolve(head),
      anchor <= head ? 1 : -1,
    );
    if (selection.eq(view.state.selection)) return false;
    view.dispatch(view.state.tr.setSelection(selection));
    return true;
  } catch {
    return false;
  }
}
