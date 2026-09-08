import { EditorSelection, EditorState, Prec, Transaction, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from '@codemirror/view';
import { YSyncConfig, ySync, ySyncFacet, yRemoteSelections, yRemoteSelectionsTheme } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

type RelativeSelection = { ranges: { anchor: Y.RelativePosition; head: Y.RelativePosition }[]; mainIndex: number };
type Capture = { before: RelativeSelection; kind: string | null; recorded: boolean };
const beforeKey = Symbol('text-history-before');
const afterKey = Symbol('text-history-after');
const histories = new WeakMap<Y.Text, TextDocumentHistory>();

function captureSelection(text: Y.Text, selection: EditorSelection): RelativeSelection {
  return { mainIndex: selection.mainIndex, ranges: selection.ranges.map(({ anchor, head, assoc }) => ({
    anchor: Y.createRelativePositionFromTypeIndex(text, anchor, assoc),
    head: Y.createRelativePositionFromTypeIndex(text, head, assoc),
  })) };
}

function restoreSelection(text: Y.Text, selection: RelativeSelection | undefined): EditorSelection | null {
  if (!selection || !text.doc) return null;
  const ranges = [];
  for (const range of selection.ranges) {
    const anchor = Y.createAbsolutePositionFromRelativePosition(range.anchor, text.doc);
    const head = Y.createAbsolutePositionFromRelativePosition(range.head, text.doc);
    if (anchor?.type !== text || head?.type !== text) return null;
    ranges.push(EditorSelection.range(anchor.index, head.index));
  }
  return EditorSelection.create(ranges, selection.mainIndex);
}

/** Each Y.Text owns one selective history, independent of mounted source views. */
class TextDocumentHistory {
  private destroyed = false;
  private manager: Y.UndoManager;
  private views = new Map<object, EditorView>();
  private pending = new Map<object, Capture>();
  private previous: { origin: object; kind: string; after: RelativeSelection } | null = null;

  constructor(private text: Y.Text) {
    this.manager = new Y.UndoManager(text, { trackedOrigins: new Set(),
      captureTransaction: (transaction) => transaction.origin === this.manager || this.pending.get(transaction.origin)?.recorded === true });
    this.manager.on('stack-item-added', this.onStackItem);
    this.manager.on('stack-item-updated', this.onStackItem);
    text.doc!.on('afterTransaction', this.afterTransaction);
    text.doc!.on('destroy', this.destroy);
  }

  register(origin: object, view: EditorView): () => void {
    if (this.destroyed) return () => {};
    this.views.set(origin, view);
    this.manager.addTrackedOrigin(origin);
    return () => {
      this.views.delete(origin);
      this.pending.delete(origin);
      this.manager.removeTrackedOrigin(origin);
      if (this.previous?.origin === origin) this.boundary();
    };
  }

  boundary(): void { this.previous = null; this.manager.stopCapturing(); }
  get active(): boolean { return !this.destroyed; }

  prepare(origin: object, update: ViewUpdate, kind: string | null): void {
    const recorded = !update.transactions.some((transaction) => transaction.annotation(Transaction.addToHistory) === false);
    const previous = this.previous;
    if (!recorded || !kind || previous?.origin !== origin || previous.kind !== kind
      || !restoreSelection(this.text, previous.after)?.eq(update.startState.selection)) this.boundary();
    this.manager.captureTimeout = kind?.startsWith('composition:') ? Number.POSITIVE_INFINITY : kind ? 500 : 0;
    this.pending.set(origin, { before: captureSelection(this.text, update.startState.selection), kind, recorded });
  }

  private onStackItem = ({ origin, stackItem }: { origin: unknown; stackItem: Y.UndoManager['undoStack'][number] }) => {
    const capture = this.pending.get(origin as object);
    const view = this.views.get(origin as object);
    if (!capture || !view) return;
    if (!stackItem.meta.has(beforeKey)) stackItem.meta.set(beforeKey, capture.before);
    stackItem.meta.set(afterKey, captureSelection(this.text, view.state.selection));
  };

  private afterTransaction = (transaction: Y.Transaction) => {
    const capture = this.pending.get(transaction.origin);
    const view = this.views.get(transaction.origin);
    if (!capture || !view) return;
    this.pending.delete(transaction.origin);
    this.previous = capture.recorded && capture.kind
      ? { origin: transaction.origin, kind: capture.kind, after: captureSelection(this.text, view.state.selection) } : null;
  };

  run(direction: 'undo' | 'redo', origin: object, view: EditorView): boolean {
    if (this.destroyed || this.views.get(origin) !== view || view.state.readOnly || !view.state.facet(EditorView.editable)) return false;
    this.boundary();
    const item = this.manager[direction]();
    if (!item) return false;
    const inverse = (direction === 'undo' ? this.manager.redoStack : this.manager.undoStack).at(-1);
    if (inverse) {
      inverse.meta.set(beforeKey, item.meta.get(beforeKey));
      inverse.meta.set(afterKey, item.meta.get(afterKey));
    }
    const selection = restoreSelection(this.text, item.meta.get(direction === 'undo' ? beforeKey : afterKey));
    if (selection) view.dispatch({ selection, effects: EditorView.scrollIntoView(selection.main) });
    return true;
  }

  private destroy = () => {
    this.destroyed = true;
    this.manager.destroy();
    this.text.doc?.off('afterTransaction', this.afterTransaction);
    this.views.clear();
    this.pending.clear();
    this.previous = null;
  };
}

/** Install before yCollab(..., {undoManager:false}), with native history disabled. */
export function createTextEditorHistory(text: Y.Text): Extension {
  let history = histories.get(text);
  if (!history) { history = new TextDocumentHistory(text); histories.set(text, history); }
  const owner = history;
  const plugin = ViewPlugin.fromClass(class {
    private origin: object;
    private release: () => void;
    private composition = 0;
    private composing = false;
    constructor(private view: EditorView) {
      this.origin = view.state.facet(ySyncFacet);
      this.release = owner.register(this.origin, view);
    }
    update(update: ViewUpdate) {
      if (!update.docChanged) {
        if (update.selectionSet && !update.startState.selection.eq(update.state.selection)) owner.boundary();
        return;
      }
      // Received Yjs changes already exist in Y.Text. User changes arrive here
      // before the ySync plugin writes them, including batches with no DOM input.
      if (update.state.doc.toString() === text.toString()) return;
      const event = update.transactions.length === 1 ? update.transactions[0].annotation(Transaction.userEvent) : null;
      let kind = this.composing || event?.startsWith('input.type.compose') ? `composition:${this.composition}`
        : event === 'input.type' || event === 'delete.backward' || event === 'delete.forward' ? event : null;
      if (!kind?.startsWith('composition:')) update.changes.iterChanges((_a, _b, _c, _d, inserted) => {
        if (inserted.lines > 1) kind = null;
      });
      owner.prepare(this.origin, update, kind);
    }
    beginComposition() { if (!this.composing) { this.composing = true; this.composition++; owner.boundary(); } }
    endComposition() { this.composing = false; }
    history(direction: 'undo' | 'redo') { return !this.composing && !this.view.composing && owner.run(direction, this.origin, this.view); }
    destroy() { this.release(); }
  }, { eventHandlers: {
    compositionstart() { this.beginComposition(); },
    compositionupdate() { this.beginComposition(); },
    compositionend() { this.endComposition(); },
    blur() { this.endComposition(); },
    beforeinput(event) {
      if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return false;
      event.preventDefault();
      this.history(event.inputType === 'historyUndo' ? 'undo' : 'redo');
      return true;
    },
  } });
  const command = (direction: 'undo' | 'redo') => (view: EditorView) => { view.plugin(plugin)?.history(direction); return true; };
  return [EditorState.lineSeparator.of('\n'), plugin,
    EditorState.transactionFilter.of((transaction) => !transaction.docChanged
      || (owner.active && (transaction.newDoc.toString() === text.toString()
      || (!transaction.startState.readOnly && transaction.startState.facet(EditorView.editable)))) ? transaction : []),
    Prec.highest(keymap.of([
      { key: 'Mod-z', run: command('undo'), preventDefault: true },
      { key: 'Mod-Shift-z', run: command('redo'), preventDefault: true },
      { key: 'Mod-y', run: command('redo'), preventDefault: true },
    ]))];
}

/** Compose the public sync/cursor extensions with document-owned history. */
export function createTextEditorCollaboration(text: Y.Text, awareness: Awareness | null): Extension {
  const sync = new YSyncConfig(text, awareness);
  // YSyncConfig allocates an unused UndoManager even when yCollab's history is
  // disabled. Dispose it at construction, including extensions never mounted
  // by React, so it cannot retain document listeners or deleted text.
  sync.undoManager.destroy();
  return [createTextEditorHistory(text), ySyncFacet.of(sync), ySync,
    awareness ? [yRemoteSelectionsTheme, yRemoteSelections] : []];
}
