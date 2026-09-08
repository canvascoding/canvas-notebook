import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection, type EditorState, type Selection, type Transaction } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import type * as Y from 'yjs';

import { BLOCK_MOVE_TRANSACTION_META } from '../editor/block-reference';
import type { CollaborationBlockTree } from './block-tree';
import { captureBlockTreeSelection, restoreBlockTreeSelection, type BlockTreeSelection } from './block-tree-anchors';

const histories = new WeakMap<Y.Doc, BlockTreeHistory>();
const beforeSelectionKey = Symbol('block-history-selection-before');
const afterSelectionKey = Symbol('block-history-selection-after');
type Typing = { blockId: string; kind: 'insert' | 'backspace' | 'delete'; marks: string };
type Capture = { origin: object; kind: Typing | 'composition'; after: BlockTreeSelection | null };

function typingTransaction(transaction: Transaction, state: EditorState): Typing | null {
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

/** History lasts as long as the shared document, independently of its mounted views. */
export class BlockTreeHistory {
  private manager: Y.UndoManager;
  private origins = new Set<object>();
  private listeners = new Set<() => void>();
  private previous: Capture | null = null;

  constructor(tree: CollaborationBlockTree) {
    this.manager = tree.createUndoManager(Symbol('block-history'));
    this.manager.on('stack-item-added', this.notify);
    this.manager.on('stack-item-updated', this.notify);
    this.manager.on('stack-cleared', this.notify);
    tree.doc.on('destroy', this.destroy);
  }

  private notify = () => { for (const listener of this.listeners) listener(); };

  register(origin: object, onChange: () => void): () => void {
    this.origins.add(origin);
    this.manager.addTrackedOrigin(origin);
    this.listeners.add(onChange);
    return () => {
      this.origins.delete(origin);
      this.manager.removeTrackedOrigin(origin);
      this.listeners.delete(onChange);
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
    return direction === 'undo' ? this.manager.canUndo() : this.manager.canRedo();
  }

  run(direction: 'undo' | 'redo', tree: CollaborationBlockTree, currentDoc: () => ProseMirrorNode): Selection | null {
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
    const selection = item?.meta.get(direction === 'undo' ? beforeSelectionKey : afterSelectionKey) as BlockTreeSelection | null | undefined;
    return selection ? restoreBlockTreeSelection(tree, currentDoc(), selection) : null;
  }

  private destroy = () => {
    this.manager.destroy();
    this.origins.clear();
    this.listeners.clear();
    this.previous = null;
  };
}

export function getBlockTreeHistory(tree: CollaborationBlockTree): BlockTreeHistory {
  let history = histories.get(tree.doc);
  if (!history) { history = new BlockTreeHistory(tree); histories.set(tree.doc, history); }
  return history;
}
