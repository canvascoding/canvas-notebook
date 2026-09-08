import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, Selection, type EditorState, type Transaction } from '@tiptap/pm/state';
import type * as Y from 'yjs';

import { BLOCK_MOVE_TRANSACTION_META } from '../editor/block-reference';
import { BlockTreeConflict, CollaborationBlockTree, type BlockMoveIntent } from './block-tree';
import { captureBlockTreeSelection, restoreBlockTreeSelection, type BlockTreeSelection } from './block-tree-anchors';

const REMOTE_BLOCK_TREE_TRANSACTION = 'canvas-block-tree-remote';
const blockTreeEditorKey = new PluginKey('canvas-block-tree-editor');

type BlockTreeEditorOptions = {
  document: Y.Doc;
  onError?: (error: Error) => void;
};

type BlockTreeEditorStorage = {
  binding: BlockTreeEditorBinding | null;
};

/** Owns one editor view; the registry continues to own the shared document. */
class BlockTreeEditorBinding {
  readonly origin = {};
  private tree: CollaborationBlockTree | null = null;
  private undoManager: Y.UndoManager | null = null;
  private undoDestroyListeners: Array<() => void> = [];
  private selection: BlockTreeSelection | null = null;
  private destroyed = false;
  private lastError: string | null = null;
  ready = false;

  constructor(private editor: Editor, private options: BlockTreeEditorOptions) {
    editor.on('beforeTransaction', this.beforeEditorTransaction);
    options.document.on('beforeTransaction', this.beforeYTransaction);
    options.document.on('afterTransaction', this.afterYTransaction);
    options.document.on('destroy', this.onDocumentDestroyed);
    // Plugin views are still being constructed at this point.
    queueMicrotask(() => this.projectToEditor());
  }

  report(error: unknown) {
    const failure = error instanceof Error ? error : new BlockTreeConflict('structure_invalid');
    if (this.lastError === failure.message) return;
    this.lastError = failure.message;
    this.options.onError?.(failure);
  }

  private beforeEditorTransaction = ({ transaction, nextState }: { transaction: Transaction; nextState: EditorState }) => {
    if (transaction.getMeta(REMOTE_BLOCK_TREE_TRANSACTION) === this || this.editor.state.doc.eq(nextState.doc)) return;
    if (this.destroyed || !this.ready || !this.editor.isEditable || !this.tree) throw new BlockTreeConflict('target_changed');
    this.tree.applyDocumentChange(this.editor.state.doc, nextState.doc, this.origin, transaction.getMeta(BLOCK_MOVE_TRANSACTION_META) as BlockMoveIntent | undefined);
    this.lastError = null;
  };

  private beforeYTransaction = () => {
    if (this.destroyed || !this.tree || !this.ready) return;
    this.selection = captureBlockTreeSelection(this.tree, this.editor.state.doc, this.editor.state.selection);
  };

  private afterYTransaction = (transaction: Y.Transaction) => {
    if (transaction.origin !== this.origin) this.projectToEditor();
  };

  private onDocumentDestroyed = () => this.destroy();

  private projectToEditor() {
    if (this.destroyed || this.editor.isDestroyed) return;
    try {
      if (!this.tree) {
        // An empty client is waiting for provider/IndexedDB hydration. It must
        // never initialize a second document from the editor's empty paragraph.
        if (!this.options.document.share.has('canvas-block-tree-v1')) return;
        this.tree = new CollaborationBlockTree(this.options.document, this.editor.schema);
        const previousDestroyListeners = new Set(this.options.document._observers.get('destroy'));
        this.undoManager = this.tree.createUndoManager(this.origin);
        // Yjs 13's UndoManager.destroy does not remove its anonymous document
        // destroy listener. Track only the listeners added by our own manager.
        this.undoDestroyListeners = [...this.options.document._observers.get('destroy') ?? []]
          .filter((listener) => !previousDestroyListeners.has(listener));
      }
      const next = this.tree.read();
      const state = this.editor.state;
      this.ready = true;
      const from = state.doc.content.findDiffStart(next.content);
      if (from === null) return;
      const end = state.doc.content.findDiffEnd(next.content)!;
      const overlap = Math.max(0, from - Math.min(end.a, end.b));
      const tr = state.tr.replace(from, end.a + overlap, next.slice(from, end.b + overlap));
      if (!tr.doc.eq(next)) throw new BlockTreeConflict('structure_invalid');
      const selection = this.selection ? restoreBlockTreeSelection(this.tree, tr.doc, this.selection) : null;
      if (selection) tr.setSelection(selection);
      else tr.setSelection(Selection.near(tr.doc.resolve(Math.min(state.selection.head, tr.doc.content.size))));
      tr.setMeta(REMOTE_BLOCK_TREE_TRANSACTION, this);
      tr.setMeta('addToHistory', false);
      this.editor.view.dispatch(tr);
      this.lastError = null;
    } catch (error) {
      this.ready = false;
      this.report(error);
    }
  }

  history(direction: 'undo' | 'redo', dispatch: boolean): boolean {
    if (this.destroyed || !this.ready || !this.editor.isEditable || !this.undoManager) return false;
    if (direction === 'undo' ? !this.undoManager.canUndo() : !this.undoManager.canRedo()) return false;
    if (dispatch) this.undoManager[direction]();
    return true;
  }

  destroy() {
    this.destroyed = true;
    this.ready = false;
    this.editor.off('beforeTransaction', this.beforeEditorTransaction);
    this.options.document.off('beforeTransaction', this.beforeYTransaction);
    this.options.document.off('afterTransaction', this.afterYTransaction);
    this.options.document.off('destroy', this.onDocumentDestroyed);
    this.undoManager?.destroy();
    for (const listener of this.undoDestroyListeners) this.options.document.off('destroy', listener);
    this.undoDestroyListeners = [];
    this.undoManager = null;
    this.tree = null;
    this.selection = null;
  }
}

export function createBlockTreeCollaborationExtension(options: BlockTreeEditorOptions) {
  return Extension.create<Record<string, never>, BlockTreeEditorStorage>({
    name: 'canvasBlockTreeCollaboration',
    priority: 1000,
    addStorage: () => ({ binding: null }),
    addProseMirrorPlugins() {
      const editor = this.editor;
      const storage = this.storage;
      return [new Plugin({
        key: blockTreeEditorKey,
        filterTransaction(transaction) {
          if (!transaction.docChanged || transaction.getMeta(REMOTE_BLOCK_TREE_TRANSACTION) === storage.binding) return true;
          return Boolean(storage.binding?.ready && editor.isEditable);
        },
        view() {
          const binding = new BlockTreeEditorBinding(editor, options);
          storage.binding = binding;
          return { destroy() { binding.destroy(); if (storage.binding === binding) storage.binding = null; } };
        },
      })];
    },
    dispatchTransaction({ transaction, next }) {
      try { next(transaction); } catch (error) {
        if (!(error instanceof BlockTreeConflict)) throw error;
        this.storage.binding?.report(error);
      }
    },
    addCommands() {
      return {
        undo: () => ({ tr, dispatch }) => {
          tr.setMeta('preventDispatch', true);
          return this.storage.binding?.history('undo', Boolean(dispatch)) ?? false;
        },
        redo: () => ({ tr, dispatch }) => {
          tr.setMeta('preventDispatch', true);
          return this.storage.binding?.history('redo', Boolean(dispatch)) ?? false;
        },
      };
    },
    addKeyboardShortcuts() {
      return {
        'Mod-z': () => this.editor.commands.undo(),
        'Shift-Mod-z': () => this.editor.commands.redo(),
        'Mod-y': () => this.editor.commands.redo(),
      };
    },
  });
}
