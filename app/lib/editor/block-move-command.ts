import { Extension, type Editor } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { createEditorSelectionTarget } from './interaction-target';
import { createNativeBlockDragPlugin } from './native-block-drag';
import { applyReorderableBlockMove, getReorderableBlockRangeAt, getSelectedReorderableBlockRange, resolveReorderableBlockRange,
  type BlockDropTarget, type BlockMoveResult, type ReorderableBlockRange } from './reorderable-blocks';

export type BlockMoveDirection = 'up' | 'down';

/** A command acts on one selected block or list item, never a guessed range. */
export function captureBlockMoveSource(editor: Editor): ReorderableBlockRange | null {
  if (!createEditorSelectionTarget(editor)) return null;
  return getSelectedReorderableBlockRange(editor);
}

export function blockMoveSibling(editor: Editor, captured: ReorderableBlockRange, direction: BlockMoveDirection): BlockDropTarget | null {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing) return null;
  const source = resolveReorderableBlockRange(editor, captured);
  if (!source || (direction === 'up' ? source.from === source.parentFrom : source.to === source.parentTo)) return null;
  const position = direction === 'up' ? source.from - 1 : source.to;
  const target = getReorderableBlockRangeAt(editor, position, source);
  if (!target || target.from === source.from) return null;
  return { target, placement: direction === 'up' ? 'before' : 'after',
    insertPosition: direction === 'up' ? target.from : target.to };
}

/** Keyboard and menu actions use the same identity-based mutation as dragging. */
export function moveBlockInDirection(editor: Editor, direction: BlockMoveDirection,
  captured: ReorderableBlockRange | null = captureBlockMoveSource(editor)): BlockMoveResult {
  const selection = createEditorSelectionTarget(editor);
  if (!selection) return { ok: false, reason: 'read_only' };
  if (!captured || !resolveReorderableBlockRange(editor, captured)) return { ok: false, reason: 'source_changed' };
  const destination = blockMoveSibling(editor, captured, direction);
  if (!destination) return { ok: false, reason: 'no_change' };
  return applyReorderableBlockMove(editor, captured, destination, { preserveSelection: true });
}

export const MarkdownBlockMovement = Extension.create<{ onRejected?: () => void }>({
  name: 'canvasBlockMovement',
  priority: 11000,
  addOptions: () => ({}),
  addProseMirrorPlugins() {
    const editor = this.editor;
    const onRejected = this.options.onRejected;
    return [createNativeBlockDragPlugin(editor, onRejected), new Plugin({ props: { handleKeyDown(view, event) {
      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey
        || !['ArrowUp', 'ArrowDown'].includes(event.key) || event.isComposing || view.composing
        || (event.target instanceof Element && event.target.closest('[contenteditable="false"]'))) return false;
      const source = captureBlockMoveSource(editor);
      if (!source) return false;
      const result = moveBlockInDirection(editor, event.key === 'ArrowUp' ? 'up' : 'down', source);
      if (!result.ok && result.reason !== 'no_change') onRejected?.();
      // At the first/last sibling this shortcut is a no-op, not text navigation.
      return true;
    } } })];
  },
});
