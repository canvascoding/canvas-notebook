import type { Editor } from '@tiptap/core';
import { createEditorNodeTarget, resolveEditorNodeTarget } from './interaction-target';

/** Native details events belong to their current ProseMirror DOM and view lifetime. */
export function attachMarkdownDetailsInteractions(editor: Editor): () => void {
  if (editor.isDestroyed) return () => {};
  const element = editor.view.dom;
  let active = true;
  const positionOf = (details: HTMLDetailsElement): number | null => {
    if (!active || editor.isDestroyed || !element.contains(details)) return null;
    const id = details.dataset.id;
    if (id) {
      const matches: number[] = [];
      editor.state.doc.descendants((node, position) => {
        if (node.type.name === 'canvasDetails' && node.attrs.id === id) matches.push(position);
      });
      // A missing/duplicate ID cannot fall back to a neighbouring DOM position.
      return matches.length === 1 && editor.view.nodeDOM(matches[0]) === details ? matches[0] : null;
    }
    try {
      const resolved = editor.state.doc.resolve(editor.view.posAtDOM(details, 0));
      for (let depth = resolved.depth; depth > 0; depth -= 1) {
        const position = resolved.before(depth);
        if (resolved.node(depth).type.name === 'canvasDetails' && editor.view.nodeDOM(position) === details) return position;
      }
    } catch { /* A DOM event can arrive while its node is being replaced. */ }
    return null;
  };
  const setOpen = (details: HTMLDetailsElement, open: boolean) => {
    const position = positionOf(details);
    if (position === null) return;
    const target = createEditorNodeTarget(editor, position);
    const current = resolveEditorNodeTarget(editor, target);
    if (current === null) return;
    const node = editor.state.doc.nodeAt(current)!;
    if (Boolean(node.attrs.open) === open) {
      details.open = open;
      return;
    }
    editor.view.dispatch(editor.state.tr.setNodeMarkup(current, node.type, { ...node.attrs, open }));
  };
  const click = (event: MouseEvent) => {
    if (!active || editor.isDestroyed || !editor.isEditable || !(event.target instanceof Element)) return;
    const summary = event.target.closest('summary[data-type="canvas-details-summary"]');
    const details = summary?.closest('details[data-type="canvas-details"]');
    if (!(details instanceof HTMLDetailsElement) || !element.contains(details)) return;
    event.preventDefault();
    const position = positionOf(details);
    if (position !== null) setOpen(details, !details.open);
  };
  // Native toggle also fires for remote projection and read-only browsing;
  // only activating the summary expresses an intent to change the document.
  element.addEventListener('click', click, true);
  const detach = () => {
    active = false;
    element.removeEventListener('click', click, true);
    editor.off('destroy', detach);
  };
  editor.on('destroy', detach);
  return detach;
}
