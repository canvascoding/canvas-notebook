import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';
import { synchronizeEditorSelectionFromDom } from '@/app/lib/markdown/core/dom-selection';

export function synchronizeMarkdownTextSelection(view: EditorView) {
  const selection = view.dom.ownerDocument.getSelection();
  if (view.state.selection instanceof CellSelection || !selection?.anchorNode || !selection.focusNode
    || selection.anchorNode === view.dom || selection.focusNode === view.dom) return false;
  const anchor = selection.anchorNode.nodeType === 1 ? selection.anchorNode as Element : selection.anchorNode.parentElement;
  if (anchor?.closest('[contenteditable="false"]')) return false;
  return synchronizeEditorSelectionFromDom(view);
}

export const MarkdownDomSelection = Extension.create({
  name: 'canvasDomSelection',
  addProseMirrorPlugins() {
    return [new Plugin({ props: { handleDOMEvents: {
      keydown(view, event) {
        if (!['Enter', 'Backspace', 'Delete'].includes(event.key)
          || !(event.target instanceof Element) || event.target.closest('[contenteditable="false"]')) return false;
        synchronizeMarkdownTextSelection(view);
        return false;
      },
      beforeinput(view) { synchronizeMarkdownTextSelection(view); return false; },
    } } })];
  },
});
