import { Annotation, EditorSelection, EditorState, Prec, Transaction, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';

import { LocalMarkdownDocument, type LocalMarkdownView, type LocalSourceSelection } from './local-markdown-document';

const projection = Annotation.define<object>();

function captureSourceSelection(selection: EditorSelection): LocalSourceSelection {
  return { anchor: selection.main.anchor, head: selection.main.head, mainIndex: selection.mainIndex,
    ranges: selection.ranges.map(({ anchor, head }) => ({ anchor, head })) };
}

function restoreSourceSelection(selection: LocalSourceSelection | null, length: number): EditorSelection {
  const clamp = (position: number) => Math.max(0, Math.min(length, position));
  const ranges = selection?.ranges ?? [{ anchor: selection?.anchor ?? 0, head: selection?.head ?? 0 }];
  return EditorSelection.create(ranges.map((range) => EditorSelection.range(clamp(range.anchor), clamp(range.head))), selection?.mainIndex ?? 0);
}

/** Use with EditorView's dispatchTransactions option so obsolete transactions
 * are rejected before CodeMirror changes its state or emits update callbacks. */
export function createLocalMarkdownSourceBinding(document: LocalMarkdownDocument) {
  class SourceBinding {
    private lease: LocalMarkdownView;
    private unsubscribe: () => void;
    private destroyed = false;
    private writing = false;
    private revision = document.getSnapshot().revision;
    private compositionTime: number | null = null;

    constructor(readonly editor: EditorView) {
      this.lease = document.openView('source', () => this.writable);
      this.unsubscribe = document.subscribe(() => {
        if (this.writing) this.revision = document.getSnapshot().revision;
        else this.project();
      });
      queueMicrotask(() => this.project());
    }

    get writable(): boolean {
      return !this.destroyed && !this.editor.state.readOnly && this.editor.state.facet(EditorView.editable);
    }

    project(): void {
      if (this.destroyed || !this.lease.isCurrent()) return;
      const snapshot = document.getSnapshot();
      this.revision = snapshot.revision;
      const previous = this.editor.state.doc.toString();
      this.editor.dispatch({
        changes: previous === snapshot.markdown ? undefined : { from: 0, to: previous.length, insert: snapshot.markdown },
        selection: restoreSourceSelection(document.getSourceSelection(), snapshot.markdown.length),
        annotations: [projection.of(this), Transaction.addToHistory.of(false)],
      });
    }

    dispatch(transactions: readonly Transaction[]): void {
      if (this.destroyed || !this.lease.isCurrent() || !transactions.length) return;
      // A previously constructed transaction can arrive after external state
      // replacement. Neither its document nor its selection belongs here now.
      let previous = this.editor.state;
      for (const transaction of transactions) {
        if (transaction.startState !== previous) return;
        previous = transaction.state;
      }
      const ownProjection = transactions.every((transaction) => transaction.annotation(projection) === this);
      if (ownProjection) { this.editor.update(transactions); return; }
      if (transactions.some((transaction) => transaction.annotation(projection))) return;
      const next = transactions.at(-1)!.state;
      const changed = transactions.some((transaction) => transaction.docChanged);
      if (changed) {
        if (!this.writable || this.revision !== document.getSnapshot().revision) return;
        const event = transactions.length === 1 ? transactions[0].annotation(Transaction.userEvent) : null;
        const group = this.compositionTime !== null ? 'composition'
          : event === 'input.type' || event === 'delete.backward' || event === 'delete.forward' ? event : null;
        this.writing = true;
        try {
          if (!this.lease.changeSource({ revision: this.revision, markdown: next.doc.toString(),
            beforeSelection: captureSourceSelection(this.editor.state.selection),
            afterSelection: captureSourceSelection(next.selection), group,
            time: this.compositionTime ?? transactions[0].annotation(Transaction.time) })) return;
        } finally { this.writing = false; }
      }
      this.editor.update(transactions);
      if (!changed && transactions.some((transaction) => transaction.selection)) {
        this.lease.setSourceSelection(captureSourceSelection(next.selection));
      }
    }

    history(direction: 'undo' | 'redo'): boolean {
      return this.compositionTime === null && this.lease.history(direction);
    }

    beginComposition(): void {
      if (!this.writable || this.compositionTime !== null) return;
      this.lease.boundary();
      this.compositionTime = Date.now();
    }

    endComposition(): void {
      if (this.destroyed || this.compositionTime === null) return;
      this.compositionTime = null;
      this.lease.boundary();
    }

    destroy(): void {
      this.destroyed = true;
      this.unsubscribe();
      this.lease.release();
    }
  }

  const plugin = ViewPlugin.fromClass(SourceBinding, { eventHandlers: {
    compositionstart() { this.beginComposition(); },
    compositionupdate() { this.beginComposition(); },
    compositionend() { queueMicrotask(() => this.endComposition()); },
    blur() { queueMicrotask(() => this.endComposition()); },
  } });
  const history = (direction: 'undo' | 'redo') => (view: EditorView) => view.plugin(plugin)?.history(direction) ?? false;
  const extensions: Extension[] = [
    // Keep CR, LF and mixed endings in the actual source string. Default
    // CodeMirror newline splitting would silently normalize existing CRLF.
    EditorState.lineSeparator.of('\n'),
    plugin,
    Prec.highest(keymap.of([
      { key: 'Mod-z', run: history('undo'), preventDefault: true },
      { key: 'Mod-Shift-z', run: history('redo'), preventDefault: true },
      { key: 'Mod-y', run: history('redo'), preventDefault: true },
    ])),
  ];
  return { extensions,
    dispatchTransactions: (transactions: readonly Transaction[], view: EditorView) => view.plugin(plugin)?.dispatch(transactions),
    undo: history('undo'), redo: history('redo'),
  };
}
