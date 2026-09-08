import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, Selection, type EditorState, type Transaction } from '@tiptap/pm/state';

import { BLOCK_MOVE_TRANSACTION_META } from './block-reference';
import { documentProjectionTransaction, isUnexpectedDocumentAppender } from './document-projection';
import { LocalMarkdownDocument, type LocalMarkdownView } from './local-markdown-document';
import { typingTransaction } from './typing-transaction';

export const LOCAL_MARKDOWN_PROJECTION = 'canvas-local-markdown-projection';
const bindingKey = new PluginKey('canvas-local-markdown-document');

type LocalRichOptions = { document: LocalMarkdownDocument; onError?: (error: Error) => void };
type LocalRichStorage = { binding: LocalMarkdownRichBinding | null; transaction: Transaction | null };

class LocalMarkdownViewConflict extends Error {
  constructor() { super('The local document view is no longer current.'); }
}

/** Tiptap owns the DOM; the local document owns content, identities and history. */
class LocalMarkdownRichBinding {
  private view: LocalMarkdownView;
  private unsubscribe: () => void;
  private destroyed = false;
  private writing = false;
  private projected = false;
  private revision: number;
  private notificationQueued = false;
  private compositionTime: number | null = null;

  constructor(private editor: Editor, private options: LocalRichOptions) {
    this.revision = options.document.getSnapshot().revision;
    this.view = options.document.openView('rich', () => !this.destroyed && !editor.isDestroyed && editor.isEditable);
    editor.on('beforeTransaction', this.beforeTransaction);
    this.unsubscribe = options.document.subscribe(() => {
      if (this.writing) {
        this.revision = options.document.getSnapshot().revision;
        this.notifyHistory();
      } else this.project();
    });
    // Plugin views are still being constructed.
    queueMicrotask(() => this.project());
  }

  get ready(): boolean { return this.projected && !this.destroyed && this.view.isCurrent(); }
  get composing(): boolean { return this.compositionTime !== null; }

  report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new LocalMarkdownViewConflict());
  }

  private notifyHistory(): void {
    if (this.notificationQueued) return;
    this.notificationQueued = true;
    queueMicrotask(() => {
      this.notificationQueued = false;
      if (!this.ready || this.editor.isDestroyed) return;
      this.editor.view.dispatch(this.editor.state.tr.setMeta(LOCAL_MARKDOWN_PROJECTION, this).setMeta('addToHistory', false));
    });
  }

  private beforeTransaction = ({ transaction, nextState }: { transaction: Transaction; nextState: EditorState }) => {
    if (transaction.getMeta(LOCAL_MARKDOWN_PROJECTION) === this) return;
    const previous = this.editor.state;
    if (previous.doc.eq(nextState.doc)) {
      if (transaction.selectionSet) this.view.setRichSelection(nextState.selection.toJSON());
      if (transaction.storedMarksSet) this.view.boundary();
      return;
    }
    if (!this.ready || !this.editor.isEditable) throw new LocalMarkdownViewConflict();
    const typing = typingTransaction(transaction, previous);
    this.writing = true;
    try {
      const accepted = this.view.changeRich({ revision: this.revision,
        before: previous.doc.toJSON(), after: nextState.doc.toJSON(),
        beforeSelection: previous.selection.toJSON(), afterSelection: nextState.selection.toJSON(),
        group: this.composing ? 'composition' : typing ? JSON.stringify(typing) : null,
        time: this.compositionTime ?? transaction.time });
      if (!accepted) throw new LocalMarkdownViewConflict();
    } finally { this.writing = false; }
  };

  private project(): void {
    if (this.destroyed || this.editor.isDestroyed || !this.view.isCurrent()) return;
    const snapshot = this.options.document.getSnapshot();
    if (!snapshot.richDocument) { this.projected = false; return; }
    try {
      const next = this.editor.schema.nodeFromJSON(snapshot.richDocument);
      next.check();
      const transaction = documentProjectionTransaction(this.editor.state, next);
      transaction.setSelection(Selection.fromJSON(transaction.doc, this.options.document.getRichSelection()));
      transaction.setMeta(LOCAL_MARKDOWN_PROJECTION, this).setMeta('addToHistory', false).setMeta('skipTrailingNode', true);
      this.revision = snapshot.revision;
      this.projected = true;
      this.editor.view.dispatch(transaction);
    } catch (error) { this.projected = false; this.report(error); }
  }

  history(direction: 'undo' | 'redo', dispatch: boolean): boolean {
    return !this.composing && this.view.history(direction, dispatch);
  }

  changeMetadata(markdown: string): boolean {
    return this.view.changeMetadata({ revision: this.revision, markdown });
  }

  beginComposition(): void {
    if (!this.ready || !this.editor.isEditable || this.composing) return;
    this.view.boundary();
    this.compositionTime = Date.now();
  }

  endComposition(): void {
    if (!this.composing || this.destroyed || this.editor.isDestroyed) return;
    const view = this.editor.view as typeof this.editor.view & { domObserver: { flush: () => void } };
    view.domObserver.flush();
    this.compositionTime = null;
    this.view.boundary();
  }

  destroy(): void {
    this.destroyed = true;
    this.editor.off('beforeTransaction', this.beforeTransaction);
    this.unsubscribe();
    this.view.release();
  }
}

export function updateLocalMarkdownMetadata(editor: Editor, markdown: string): boolean {
  const storage = editor.storage as typeof editor.storage & { canvasLocalMarkdown?: LocalRichStorage };
  return storage.canvasLocalMarkdown?.binding?.changeMetadata(markdown) ?? false;
}

/** Configure StarterKit.undoRedo=false when using this document binding. */
export function createLocalMarkdownRichExtension(options: LocalRichOptions) {
  return Extension.create<Record<string, never>, LocalRichStorage>({
    name: 'canvasLocalMarkdown',
    priority: 1000,
    addStorage: () => ({ binding: null, transaction: null }),
    addProseMirrorPlugins() {
      const editor = this.editor;
      const storage = this.storage;
      return [new Plugin({
        key: bindingKey,
        filterTransaction(transaction) {
          if (!transaction.docChanged || transaction.getMeta(LOCAL_MARKDOWN_PROJECTION) === storage.binding) return true;
          if (isUnexpectedDocumentAppender(transaction, storage.transaction, LOCAL_MARKDOWN_PROJECTION, storage.binding)) return false;
          return Boolean(storage.binding?.ready && editor.isEditable
            && !(storage.binding.composing && transaction.getMeta(BLOCK_MOVE_TRANSACTION_META)));
        },
        props: { handleDOMEvents: {
          compositionstart: () => { storage.binding?.beginComposition(); return false; },
          compositionupdate: () => { storage.binding?.beginComposition(); return false; },
          compositionend: () => { const binding = storage.binding; queueMicrotask(() => binding?.endComposition()); return false; },
          blur: () => { const binding = storage.binding; queueMicrotask(() => binding?.endComposition()); return false; },
        } },
        view() {
          const binding = new LocalMarkdownRichBinding(editor, options);
          storage.binding = binding;
          return { destroy() { binding.destroy(); if (storage.binding === binding) storage.binding = null; } };
        },
      })];
    },
    dispatchTransaction({ transaction, next }) {
      const previous = this.storage.transaction;
      this.storage.transaction = transaction;
      try { next(transaction); } catch (error) {
        if (!(error instanceof LocalMarkdownViewConflict)) throw error;
        this.storage.binding?.report(error);
      } finally { this.storage.transaction = previous; }
    },
    addCommands() {
      return {
        undo: () => ({ tr, dispatch }) => { tr.setMeta('preventDispatch', true); return this.storage.binding?.history('undo', Boolean(dispatch)) ?? false; },
        redo: () => ({ tr, dispatch }) => { tr.setMeta('preventDispatch', true); return this.storage.binding?.history('redo', Boolean(dispatch)) ?? false; },
      };
    },
    addKeyboardShortcuts() {
      return { 'Mod-z': () => this.editor.commands.undo(), 'Shift-Mod-z': () => this.editor.commands.redo(), 'Mod-y': () => this.editor.commands.redo() };
    },
  });
}
