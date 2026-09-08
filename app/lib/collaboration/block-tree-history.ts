import type { EditorState, Selection, Transaction } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type * as Y from 'yjs';

import { typingTransaction, type Typing } from '../editor/typing-transaction';
import type { CollaborationBlockTree } from './block-tree';
import { captureBlockTreeSelection, restoreBlockTreeSelection, type BlockTreeSelection } from './block-tree-anchors';

const histories = new WeakMap<Y.Doc, BlockTreeHistory>();
const beforeSelectionKey = Symbol('block-history-selection-before');
const afterSelectionKey = Symbol('block-history-selection-after');
type Capture = { origin: object; kind: Typing | 'composition'; after: BlockTreeSelection | null };

/** History lasts as long as the shared document, independently of its mounted views. */
export class BlockTreeHistory {
  private manager: Y.UndoManager;
  private origins = new Set<object>();
  private listeners = new Set<() => void>();
  private previous: Capture | null = null;
  private destroyed = false;

  constructor(tree: CollaborationBlockTree) {
    this.manager = tree.createUndoManager(Symbol('block-history'));
    this.manager.on('stack-item-added', this.notify);
    this.manager.on('stack-item-updated', this.notify);
    this.manager.on('stack-cleared', this.notify);
    tree.doc.on('destroy', this.destroy);
  }

  private notify = () => { for (const listener of this.listeners) listener(); };

  subscribe = (onChange: () => void): (() => void) => {
    if (this.destroyed) return () => {};
    this.listeners.add(onChange);
    return () => { this.listeners.delete(onChange); };
  };

  register(origin: object, onChange: () => void): () => void {
    if (this.destroyed) throw new Error('The history document has been released.');
    this.origins.add(origin);
    this.manager.addTrackedOrigin(origin);
    const unsubscribe = this.subscribe(onChange);
    return () => {
      this.origins.delete(origin);
      this.manager.removeTrackedOrigin(origin);
      unsubscribe();
      this.boundary(origin);
    };
  }

  boundary(origin?: object) {
    if (origin && this.previous?.origin !== origin) return;
    this.previous = null;
    this.manager.stopCapturing();
  }

  capture(tree: CollaborationBlockTree, origin: object, state: EditorState, next: EditorState,
    transaction: Transaction, composing: boolean, apply: () => void): void {
    if (!this.origins.has(origin)) throw new Error('The history view has been released.');
    const recorded = transaction.getMeta('addToHistory') !== false;
    const kind = composing ? 'composition' : typingTransaction(transaction, state);
    const previous = this.previous;
    const continuous = recorded && kind && previous?.origin === origin && (
      kind === 'composition' ? previous.kind === 'composition'
        : previous.kind !== 'composition' && JSON.stringify(kind) === JSON.stringify(previous.kind)
          && previous.after && restoreBlockTreeSelection(tree, state.doc, previous.after)?.eq(state.selection)
    );
    if (!continuous) this.boundary();
    this.manager.captureTimeout = kind === 'composition' ? Number.POSITIVE_INFINITY : kind ? 500 : 0;
    const before = captureBlockTreeSelection(tree, state.doc, state.selection);
    const oldItem = this.manager.undoStack.at(-1);
    if (!recorded) this.manager.removeTrackedOrigin(origin);
    try {
      apply();
      if (recorded) {
        const after = captureBlockTreeSelection(tree, next.doc, next.selection);
        const item = this.manager.undoStack.at(-1);
        if (item) {
          if (item !== oldItem) item.meta.set(beforeSelectionKey, before);
          item.meta.set(afterSelectionKey, after);
        }
        this.previous = kind ? { origin, kind, after } : null;
      }
    } catch (error) {
      this.boundary();
      throw error;
    } finally {
      if (!recorded) this.manager.addTrackedOrigin(origin);
    }
  }

  can(direction: 'undo' | 'redo'): boolean {
    return !this.destroyed && (direction === 'undo' ? this.manager.canUndo() : this.manager.canRedo());
  }

  private applyHistory(direction: 'undo' | 'redo') {
    if (this.destroyed) return null;
    this.boundary();
    const item = this.manager[direction]();
    // Yjs creates the inverse stack item during undo/redo; keep both selection
    // endpoints so any later view can restore the same action's caret.
    const inverse = (direction === 'undo' ? this.manager.redoStack : this.manager.undoStack).at(-1);
    if (item && inverse) {
      inverse.meta.set(beforeSelectionKey, item.meta.get(beforeSelectionKey));
      inverse.meta.set(afterSelectionKey, item.meta.get(afterSelectionKey));
    }
    this.notify();
    return item;
  }

  /** Recover the document even when no valid ProseMirror view can be mounted. */
  undoLastLocalChange(): boolean {
    return Boolean(this.applyHistory('undo'));
  }

  run(direction: 'undo' | 'redo', tree: CollaborationBlockTree, currentDoc: () => ProseMirrorNode): Selection | null {
    const item = this.applyHistory(direction);
    const selection = item?.meta.get(direction === 'undo' ? beforeSelectionKey : afterSelectionKey) as BlockTreeSelection | null | undefined;
    return selection ? restoreBlockTreeSelection(tree, currentDoc(), selection) : null;
  }

  private destroy = () => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.manager.destroy();
    this.notify();
    this.origins.clear();
    this.listeners.clear();
    this.previous = null;
  };
}

export function getBlockTreeHistory(tree: CollaborationBlockTree): BlockTreeHistory {
  if (tree.doc.isDestroyed) throw new Error('The history document has been released.');
  let history = histories.get(tree.doc);
  if (!history) { history = new BlockTreeHistory(tree); histories.set(tree.doc, history); }
  return history;
}

/** Looking up recovery availability never creates a new history or a new writer. */
export function findBlockTreeHistory(doc: Y.Doc): BlockTreeHistory | null {
  return doc.isDestroyed ? null : histories.get(doc) ?? null;
}
