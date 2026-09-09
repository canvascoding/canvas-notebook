import type { Editor } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import { dropPoint } from '@tiptap/pm/transform';
import { applyReorderableBlockMove, getReorderableBlockRangeAt, resolveReorderableBlockRange,
  type ReorderableBlockRange } from './reorderable-blocks';

export const NATIVE_BLOCK_DRAG_TYPE = 'application/x-canvas-native-block';

function nativeSource(editor: Editor, event: DragEvent): ReorderableBlockRange | null {
  const view = editor.view;
  const selection = view.state.selection;
  if (selection instanceof NodeSelection) {
    const source = getReorderableBlockRangeAt(editor, selection.from);
    const nodeDOM = source && view.nodeDOM(source.from);
    if (source?.from === selection.from && source.to === selection.to
      && (event.target === view.dom || (nodeDOM instanceof Element && nodeDOM.contains(event.target as Node)))) return source;
  }
  // Native image dragging can begin before the image becomes selected.
  if (!(event.target instanceof Element) || event.target === view.dom
    || event.target.closest('button,input,textarea,select')) return null;
  try {
    const source = getReorderableBlockRangeAt(editor, view.posAtDOM(event.target, 0));
    return source?.node.type.spec.draggable ? source : null;
  } catch { return null; }
}

/** Native node drags use the same live, identity-based move as the block grip. */
export function createNativeBlockDragPlugin(editor: Editor, onRejected?: () => void) {
  let gesture: { token: string; source: ReorderableBlockRange } | null = null;
  const clear = () => { gesture = null; };
  const writable = () => !editor.isDestroyed && editor.isEditable && !editor.view.composing;
  const isCopy = (event: DragEvent) => /Mac|iP(hone|ad|od)/u.test(navigator.platform) ? event.altKey : event.ctrlKey;
  const hasData = (data: DataTransfer | null) => Boolean(data && Array.from(data.types).includes(NATIVE_BLOCK_DRAG_TYPE));
  return new Plugin({
    key: new PluginKey('canvasNativeBlockDrag'),
    props: { handleDOMEvents: {
      dragstart(view, event) {
        clear();
        if (editor.isDestroyed || !event.dataTransfer) return false;
        const source = nativeSource(editor, event);
        if (!source) return false;
        if (!writable()) { event.preventDefault(); return true; }
        const selection = NodeSelection.create(view.state.doc, source.from);
        if (!view.state.selection.eq(selection)) view.dispatch(view.state.tr.setSelection(selection));
        if (!writable() || !view.state.selection.eq(selection)) { event.preventDefault(); return true; }
        const clipboard = view.serializeForClipboard(new Slice(Fragment.from(source.node), 0, 0));
        const token = crypto.randomUUID();
        event.dataTransfer.clearData();
        event.dataTransfer.setData('text/html', clipboard.dom.innerHTML);
        event.dataTransfer.setData('text/plain', clipboard.text);
        event.dataTransfer.setData(NATIVE_BLOCK_DRAG_TYPE, token);
        event.dataTransfer.effectAllowed = 'copyMove';
        gesture = { token, source };
        view.dragging = null;
        // Do not prevent dragstart: the browser still owns the native gesture.
        return true;
      },
      drop(view, event) {
        if (!hasData(event.dataTransfer)) return false;
        const intent = gesture;
        clear();
        if (!intent || event.dataTransfer!.getData(NATIVE_BLOCK_DRAG_TYPE) !== intent.token || !writable()) {
          event.preventDefault(); onRejected?.(); return true;
        }
        // A modifier makes this an ordinary HTML copy; the UniqueID paste path
        // creates new identities and ProseMirror has no source to delete.
        if (isCopy(event)) return false;
        event.preventDefault();
        const source = resolveReorderableBlockRange(editor, intent.source);
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
        const position = source && at ? dropPoint(view.state.doc, at.pos, new Slice(Fragment.from(source.node), 0, 0)) : null;
        const result = position === null ? null : applyReorderableBlockMove(editor, intent.source, position, { preserveSelection: true });
        if (!result || (!result.ok && result.reason !== 'no_change')) onRejected?.();
        return true;
      },
      compositionstart() { clear(); return false; },
    } },
    view(view) {
      const started = (event: DragEvent) => { if (!view.dom.contains(event.target as Node)) clear(); };
      const ended = (event: DragEvent) => {
        const token = event.dataTransfer?.getData(NATIVE_BLOCK_DRAG_TYPE);
        if (!token || token === gesture?.token) clear();
      };
      const key = (event: KeyboardEvent) => { if (event.key === 'Escape') clear(); };
      const visibility = () => { if (document.hidden) clear(); };
      window.addEventListener('dragstart', started);
      window.addEventListener('dragend', ended);
      window.addEventListener('keydown', key);
      document.addEventListener('visibilitychange', visibility);
      editor.on('destroy', clear);
      return {
        update() { if (gesture && (!writable() || !resolveReorderableBlockRange(editor, gesture.source))) clear(); },
        destroy() {
          clear(); editor.off('destroy', clear);
          window.removeEventListener('dragstart', started);
          window.removeEventListener('dragend', ended);
          window.removeEventListener('keydown', key);
          document.removeEventListener('visibilitychange', visibility);
        },
      };
    },
  });
}
