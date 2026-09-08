import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, Selection, type EditorState, type Transaction } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { BLOCK_MOVE_TRANSACTION_META } from '../editor/block-reference';
import { BlockTreeConflict, CollaborationBlockTree, type BlockMoveIntent } from './block-tree';
import { captureBlockTreeSelection, restoreBlockTreeSelection, type BlockTreeSelection } from './block-tree-anchors';

export const REMOTE_BLOCK_TREE_TRANSACTION = 'canvas-block-tree-remote';
const blockTreeEditorKey = new PluginKey('canvas-block-tree-editor');

/** The document remains editable; some concurrent placement intentions lost. */
export class BlockTreePlacementNotice extends Error {
  constructor(readonly count: number) {
    super(`${count} concurrent block placement intentions could not be applied.`);
    this.name = 'BlockTreePlacementNotice';
  }
}

type BlockTreeEditorOptions = {
  document: Y.Doc;
  onError?: (error: Error) => void;
};

type BlockTreeEditorStorage = {
  binding: BlockTreeEditorBinding | null;
  transaction: Transaction | null;
};

export function isBlockTreeEditorReady(editor: Editor): boolean {
  const storage = editor.storage as typeof editor.storage & { canvasBlockTreeCollaboration?: BlockTreeEditorStorage };
  return !editor.isDestroyed && Boolean(storage.canvasBlockTreeCollaboration?.binding?.ready);
}

export function captureBlockTreeEditorSelection(editor: Editor, selection?: Selection): BlockTreeSelection | null {
  const storage = editor.storage as typeof editor.storage & { canvasBlockTreeCollaboration?: BlockTreeEditorStorage };
  return storage.canvasBlockTreeCollaboration?.binding?.captureSelection(selection) ?? null;
}

export function resolveBlockTreeEditorSelection(editor: Editor, selection: BlockTreeSelection): Selection | null {
  const storage = editor.storage as typeof editor.storage & { canvasBlockTreeCollaboration?: BlockTreeEditorStorage };
  return storage.canvasBlockTreeCollaboration?.binding?.resolveSelection(selection) ?? null;
}

/** Owns one editor view; the registry continues to own the shared document. */
class BlockTreeEditorBinding {
  readonly origin = {};
  private tree: CollaborationBlockTree | null = null;
  private undoManager: Y.UndoManager | null = null;
  private undoDestroyListeners: Array<() => void> = [];
  private selection: BlockTreeSelection | null = null;
  private destroyed = false;
  private lastError: string | null = null;
  private seenPlacementConflicts = new Set<string>();
  private compositionTree: CollaborationBlockTree | null = null;
  private compositionClientId: number | null = null;
  private historyCaptureTimeout = 0;
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
    const target = this.compositionTree ?? this.tree;
    target.applyDocumentChange(this.editor.state.doc, nextState.doc, this.origin, transaction.getMeta(BLOCK_MOVE_TRANSACTION_META) as BlockMoveIntent | undefined);
    if (this.compositionTree) {
      // Local IME edits are immediately durable/synced, while this view keeps
      // composing against its original replica until compositionend.
      Y.applyUpdate(this.options.document,
        Y.encodeStateAsUpdate(target.doc, Y.encodeStateVector(this.options.document)), this.origin);
    }
    this.lastError = null;
  };

  private beforeYTransaction = () => {
    if (this.destroyed || !this.tree || !this.ready || this.compositionTree) return;
    this.selection = captureBlockTreeSelection(this.tree, this.editor.state.doc, this.editor.state.selection);
  };

  private afterYTransaction = (transaction: Y.Transaction) => {
    if (transaction.origin !== this.origin) this.projectToEditor();
  };

  private onDocumentDestroyed = () => this.destroy();

  private projectToEditor() {
    if (this.destroyed || this.editor.isDestroyed || this.compositionTree) return;
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
      const projection = this.tree.project();
      const next = this.tree.read(this.editor.schema, projection);
      const state = this.editor.state;
      this.ready = true;
      const unseen = projection.conflicts.map((conflict) => `${conflict.operationId}:${conflict.blockId}:${conflict.reason}`)
        .filter((key) => !this.seenPlacementConflicts.has(key));
      for (const key of unseen) this.seenPlacementConflicts.add(key);
      if (unseen.length) this.options.onError?.(new BlockTreePlacementNotice(unseen.length));
      const from = state.doc.content.findDiffStart(next.content);
      if (from === null) return;
      const end = state.doc.content.findDiffEnd(next.content)!;
      const overlap = Math.max(0, from - Math.min(end.a, end.b));
      let tr = state.tr.replace(from, end.a + overlap, next.slice(from, end.b + overlap));
      // ProseMirror's slice fitter can retain a paragraph at a table/container
      // boundary. Prefer the small replacement, but always render the exact
      // validated projection. Relative selections survive either replacement.
      if (!tr.doc.eq(next)) tr = state.tr.replaceWith(0, state.doc.content.size, next.content);
      if (!tr.doc.eq(next)) throw new BlockTreeConflict('structure_invalid');
      const selection = this.selection ? restoreBlockTreeSelection(this.tree, tr.doc, this.selection) : null;
      if (selection) tr.setSelection(selection);
      else tr.setSelection(Selection.near(tr.doc.resolve(Math.min(state.selection.head, tr.doc.content.size))));
      tr.setMeta(REMOTE_BLOCK_TREE_TRANSACTION, this);
      tr.setMeta('addToHistory', false);
      // A received projection is already authoritative. StarterKit must not
      // append a view-only paragraph during hydration or a remote update.
      tr.setMeta('skipTrailingNode', true);
      this.editor.view.dispatch(tr);
      this.lastError = null;
    } catch (error) {
      this.ready = false;
      this.report(error);
    }
  }

  history(direction: 'undo' | 'redo', dispatch: boolean): boolean {
    // A merge can invalidate the current projection. Selective history is still
    // a valid recovery path: undo the user's own row/container action while
    // retaining remote edits. Permission and view-lifecycle gates still apply.
    if (this.destroyed || !this.editor.isEditable || !this.undoManager || this.compositionTree) return false;
    if (direction === 'undo' ? !this.undoManager.canUndo() : !this.undoManager.canRedo()) return false;
    if (dispatch) this.undoManager[direction]();
    return true;
  }

  get composing(): boolean { return this.compositionTree !== null; }

  captureSelection(selection: Selection = this.editor.state.selection): BlockTreeSelection | null {
    const tree = this.compositionTree ?? this.tree;
    return !this.destroyed && tree && this.ready
      ? captureBlockTreeSelection(tree, this.editor.state.doc, selection) : null;
  }

  resolveSelection(selection: BlockTreeSelection): Selection | null {
    const tree = this.compositionTree ?? this.tree;
    return !this.destroyed && tree && this.ready
      ? restoreBlockTreeSelection(tree, this.editor.state.doc, selection) : null;
  }

  beginComposition() {
    if (this.destroyed || !this.ready || !this.editor.isEditable || this.compositionTree) return;
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(this.options.document));
    if (this.compositionClientId === null) this.compositionClientId = replica.clientID;
    else replica.clientID = this.compositionClientId;
    this.compositionTree = new CollaborationBlockTree(replica, this.editor.schema);
    if (this.undoManager) {
      this.undoManager.stopCapturing();
      this.historyCaptureTimeout = this.undoManager.captureTimeout;
      this.undoManager.captureTimeout = Number.POSITIVE_INFINITY;
    }
  }

  endComposition() {
    if (!this.compositionTree || this.destroyed || this.editor.isDestroyed) return;
    // ProseMirror itself flushes this observer at composition boundaries. Drain
    // pending DOM input before releasing the composing replica as well.
    const view = this.editor.view as typeof this.editor.view & { domObserver: { flush: () => void } };
    view.domObserver.flush();
    this.selection = this.captureSelection();
    this.compositionTree.doc.destroy();
    this.compositionTree = null;
    if (this.undoManager) {
      this.undoManager.stopCapturing();
      this.undoManager.captureTimeout = this.historyCaptureTimeout;
    }
    this.projectToEditor();
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
    this.compositionTree?.doc.destroy();
    this.compositionTree = null;
    this.tree = null;
    this.selection = null;
  }
}

export function createBlockTreeCollaborationExtension(options: BlockTreeEditorOptions) {
  return Extension.create<Record<string, never>, BlockTreeEditorStorage>({
    name: 'canvasBlockTreeCollaboration',
    priority: 1000,
    addStorage: () => ({ binding: null, transaction: null }),
    addProseMirrorPlugins() {
      const editor = this.editor;
      const storage = this.storage;
      return [new Plugin({
        key: blockTreeEditorKey,
        filterTransaction(transaction) {
          if (!transaction.docChanged || transaction.getMeta(REMOTE_BLOCK_TREE_TRANSACTION) === storage.binding) return true;
          // ProseMirror sets appendedTransaction metadata only after filtering.
          // The dispatch scope identifies appenders before they can diverge the
          // view from a received projection or turn selection/focus into a write.
          const root = storage.transaction;
          if (root && root !== transaction && (!root.docChanged
            || root.getMeta(REMOTE_BLOCK_TREE_TRANSACTION) === storage.binding)) return false;
          return Boolean(storage.binding?.ready && editor.isEditable
            && !(storage.binding.composing && transaction.getMeta(BLOCK_MOVE_TRANSACTION_META)));
        },
        props: {
          handleDOMEvents: {
            compositionstart: () => { storage.binding?.beginComposition(); return false; },
            compositionupdate: () => { storage.binding?.beginComposition(); return false; },
            compositionend: () => {
              const binding = storage.binding;
              queueMicrotask(() => binding?.endComposition());
              return false;
            },
            blur: () => {
              const binding = storage.binding;
              queueMicrotask(() => binding?.endComposition());
              return false;
            },
          },
        },
        view() {
          const binding = new BlockTreeEditorBinding(editor, options);
          storage.binding = binding;
          return { destroy() { binding.destroy(); if (storage.binding === binding) storage.binding = null; } };
        },
      })];
    },
    dispatchTransaction({ transaction, next }) {
      const previous = this.storage.transaction;
      this.storage.transaction = transaction;
      try { next(transaction); } catch (error) {
        if (!(error instanceof BlockTreeConflict)) throw error;
        this.storage.binding?.report(error);
      } finally { this.storage.transaction = previous; }
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
