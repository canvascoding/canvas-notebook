import { Extension, getSchema, type JSONContent } from '@tiptap/core';
import { generateUniqueIds } from '@tiptap/extension-unique-id';
import { closeHistory, history, redo, redoDepth, undo, undoDepth } from '@tiptap/pm/history';
import { EditorState, Selection, type Transaction } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import { analyzeMarkdownRichMode, createRichMarkdownManager, restoreRichMarkdownFinalLineEnding, richMarkdownCodecExtensions } from '../markdown/rich-markdown-codec';
import { splitMarkdownEditorDocument, type MarkdownFrontmatterMode } from '../markdown/editor-document';
import { composeCanvasMarkdownDocument } from '../markdown/obsidian-metadata';
import { preserveAlignedStableIds, stableIdCounts } from './rich-node-identities';

const SOURCE = 'canvasLocalSource';
const RICH = 'canvasLocalRichAvailable';
const SOURCE_SELECTION = 'canvasLocalSourceSelection';
const localSourceAttributes = Extension.create({
  name: 'canvasLocalSourceAttributes',
  addGlobalAttributes: () => [{ types: ['doc'], attributes: {
    [SOURCE]: { default: '', rendered: false },
    [RICH]: { default: false, rendered: false },
    [SOURCE_SELECTION]: { default: null, rendered: false },
  } }],
});

export type LocalSourceSelection = { anchor: number; head: number; ranges?: { anchor: number; head: number }[]; mainIndex?: number };
export type LocalMarkdownSnapshot = {
  revision: number;
  markdown: string;
  richDocument: JSONContent | null;
  canUndo: boolean;
  canRedo: boolean;
};
export type LocalMarkdownChange = { origin: 'rich' | 'source' | 'history' | 'external'; snapshot: LocalMarkdownSnapshot };
type RichSelection = ReturnType<Selection['toJSON']>;
type EditOptions = { group?: string | null; time?: number };

/** A view capability is revoked when the view is replaced or released. */
export type LocalMarkdownView = {
  isCurrent: () => boolean;
  boundary: () => void;
  changeRich: (input: { revision: number; before: JSONContent; after: JSONContent;
    beforeSelection: RichSelection; afterSelection: RichSelection } & EditOptions) => boolean;
  changeSource: (input: { revision: number; markdown: string;
    beforeSelection: LocalSourceSelection; afterSelection: LocalSourceSelection } & EditOptions) => boolean;
  changeMetadata: (input: { revision: number; markdown: string }) => boolean;
  setRichSelection: (selection: RichSelection) => boolean;
  setSourceSelection: (selection: LocalSourceSelection) => boolean;
  history: (direction: 'undo' | 'redo', dispatch?: boolean) => boolean;
  release: () => void;
};

/** Local documents use one ProseMirror history independently of their views.
 * The original source and its rich projection are changed in one transaction.
 * Source-only syntax stays verbatim in the source attribute; its stale rich
 * projection is unavailable until a later source version is representable. */
export class LocalMarkdownDocument {
  private readonly extensions = [...richMarkdownCodecExtensions(), localSourceAttributes];
  private readonly schema = getSchema(this.extensions);
  private readonly manager = createRichMarkdownManager();
  private state: EditorState;
  private revision = 0;
  private snapshot: LocalMarkdownSnapshot;
  private listeners = new Set<(change: LocalMarkdownChange) => void>();
  private activeView: object | null = null;
  private lastGroup: string | null = null;

  constructor(markdown: string, readonly frontmatter: MarkdownFrontmatterMode = 'metadata') {
    const empty = this.schema.topNodeType.createAndFill()!;
    this.state = this.createState(this.sourceDocument(markdown, empty));
    this.snapshot = this.createSnapshot();
  }

  private createState(doc: ProseMirrorNode): EditorState {
    return EditorState.create({ doc, schema: this.schema, plugins: [history()] });
  }

  private richJson(doc: ProseMirrorNode): JSONContent {
    const json = doc.toJSON() as JSONContent;
    const { [SOURCE]: _source, [RICH]: _rich, [SOURCE_SELECTION]: _selection, ...attrs } = json.attrs ?? {};
    return { ...json, attrs };
  }

  private sourceDocument(markdown: string, previous: ProseMirrorNode): ProseMirrorNode {
    const analysis = analyzeMarkdownRichMode(markdown, this.frontmatter);
    let content = previous.content;
    if (analysis.mode === 'rich') {
      const parsed = this.manager.parse(analysis.body);
      const current = this.richJson(previous);
      preserveAlignedStableIds(current, parsed, stableIdCounts(current));
      content = this.schema.nodeFromJSON(generateUniqueIds(parsed, this.extensions)).content;
    }
    const doc = previous.type.create({ ...previous.attrs, [SOURCE]: markdown, [RICH]: analysis.mode === 'rich' }, content);
    doc.check();
    return doc;
  }

  private createSnapshot(): LocalMarkdownSnapshot {
    return { revision: this.revision, markdown: this.state.doc.attrs[SOURCE],
      richDocument: this.state.doc.attrs[RICH] ? this.richJson(this.state.doc) : null,
      canUndo: undoDepth(this.state) > 0, canRedo: redoDepth(this.state) > 0 };
  }

  getSnapshot = (): LocalMarkdownSnapshot => this.snapshot;
  getRichSelection = (): RichSelection => this.state.selection.toJSON();
  getSourceSelection = (): LocalSourceSelection | null => {
    const selection = this.state.doc.attrs[SOURCE_SELECTION] as LocalSourceSelection | null;
    return selection ? structuredClone(selection) : null;
  };
  subscribe = (listener: (change: LocalMarkdownChange) => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(origin: LocalMarkdownChange['origin']): void {
    this.revision++;
    this.snapshot = this.createSnapshot();
    for (const listener of this.listeners) listener({ origin, snapshot: this.snapshot });
  }

  /** An authoritative external replacement starts a new history. Parent echoes
   * of the current local value are acknowledged without changing identities. */
  replaceExternal(markdown: string): void {
    if (markdown === this.snapshot.markdown) return;
    const doc = this.sourceDocument(markdown, this.state.doc);
    this.state = this.createState(doc.type.create({ ...doc.attrs, [SOURCE_SELECTION]: null }, doc.content));
    this.lastGroup = null;
    this.publish('external');
  }

  private sourceSelectionValid(selection: LocalSourceSelection, length: number): boolean {
    const valid = (range: { anchor: number; head: number }) => Number.isSafeInteger(range.anchor) && Number.isSafeInteger(range.head)
      && range.anchor >= 0 && range.head >= 0 && range.anchor <= length && range.head <= length;
    if (!valid(selection)) return false;
    if (!selection.ranges) return selection.mainIndex === undefined;
    const index = selection.mainIndex ?? 0;
    return selection.ranges.length > 0 && selection.ranges.every(valid)
      && Number.isSafeInteger(index) && index >= 0 && index < selection.ranges.length
      && selection.ranges[index].anchor === selection.anchor && selection.ranges[index].head === selection.head;
  }

  private setRichSelection(selection: RichSelection): boolean {
    try {
      const resolved = Selection.fromJSON(this.state.doc, selection);
      if (!resolved.eq(this.state.selection)) {
        this.state = this.state.apply(closeHistory(this.state.tr.setSelection(resolved)).setMeta('addToHistory', false));
        this.lastGroup = null;
      }
      return true;
    } catch { return false; }
  }

  private setSourceSelection(selection: LocalSourceSelection): boolean {
    if (!this.sourceSelectionValid(selection, this.snapshot.markdown.length)) return false;
    if (JSON.stringify(selection) !== JSON.stringify(this.getSourceSelection())) {
      this.state = this.state.apply(closeHistory(this.state.tr.setDocAttribute(SOURCE_SELECTION, structuredClone(selection))).setMeta('addToHistory', false));
      this.lastGroup = null;
    }
    return true;
  }

  private commit(transaction: Transaction, origin: 'rich' | 'source', options: EditOptions): void {
    const group = options.group ? `${origin}:${options.group}` : null;
    if (!group || group !== this.lastGroup) closeHistory(transaction);
    if (options.time !== undefined) transaction.setTime(options.time);
    this.state = this.state.apply(transaction);
    this.lastGroup = group;
    this.publish(origin);
  }

  openView(kind: 'rich' | 'source', writable: () => boolean): LocalMarkdownView {
    const token = {};
    this.activeView = token;
    this.lastGroup = null;
    const active = () => this.activeView === token && writable();
    return {
      isCurrent: () => this.activeView === token,
      boundary: () => {
        if (this.activeView !== token) return;
        this.state = this.state.apply(closeHistory(this.state.tr).setMeta('addToHistory', false));
        this.lastGroup = null;
      },
      changeRich: (input) => {
        if (!active() || kind !== 'rich' || input.revision !== this.revision || !this.snapshot.richDocument) return false;
        const before = this.schema.nodeFromJSON(input.before);
        const after = this.schema.nodeFromJSON(input.after);
        after.check();
        if (!before.content.eq(this.state.doc.content)) return false;
        const afterSelection = Selection.fromJSON(after, input.afterSelection);
        if (!this.setRichSelection(input.beforeSelection)) return false;
        if (after.content.eq(this.state.doc.content)) return this.setRichSelection(input.afterSelection);
        const parts = splitMarkdownEditorDocument(this.snapshot.markdown, this.frontmatter);
        const markdown = composeCanvasMarkdownDocument(parts.prefix,
          restoreRichMarkdownFinalLineEnding(parts.body, this.manager.serialize(input.after)));
        const transaction = this.state.tr.replaceWith(0, this.state.doc.content.size, after.content)
          .setDocAttribute(SOURCE, markdown).setDocAttribute(RICH, true);
        transaction.setSelection(Selection.fromJSON(transaction.doc, afterSelection.toJSON()));
        this.commit(transaction, 'rich', input);
        return true;
      },
      changeSource: (input) => {
        if (!active() || kind !== 'source' || input.revision !== this.revision
          || !this.sourceSelectionValid(input.afterSelection, input.markdown.length)) return false;
        if (input.markdown === this.snapshot.markdown) return this.setSourceSelection(input.afterSelection);
        const next = this.sourceDocument(input.markdown, this.state.doc);
        if (!this.setSourceSelection(input.beforeSelection)) return false;
        const transaction = this.state.tr.replaceWith(0, this.state.doc.content.size, next.content)
          .setDocAttribute(SOURCE, input.markdown).setDocAttribute(RICH, next.attrs[RICH])
          .setDocAttribute(SOURCE_SELECTION, structuredClone(input.afterSelection));
        this.commit(transaction, 'source', input);
        return true;
      },
      changeMetadata: (input) => {
        if (!active() || kind !== 'rich' || input.revision !== this.revision || this.frontmatter !== 'metadata') return false;
        const prefix = splitMarkdownEditorDocument(input.markdown, this.frontmatter).prefix;
        const body = splitMarkdownEditorDocument(this.snapshot.markdown, this.frontmatter).body;
        const next = composeCanvasMarkdownDocument(prefix, body);
        if (next === this.snapshot.markdown) return true;
        const richAvailable = analyzeMarkdownRichMode(next, this.frontmatter).mode === 'rich';
        this.commit(this.state.tr.setDocAttribute(SOURCE, next).setDocAttribute(RICH, richAvailable), 'rich', {});
        return true;
      },
      setRichSelection: (selection) => active() && kind === 'rich' && this.setRichSelection(selection),
      setSourceSelection: (selection) => active() && kind === 'source' && this.setSourceSelection(selection),
      history: (direction, dispatch = true) => {
        if (!active()) return false;
        const command = direction === 'undo' ? undo : redo;
        return command(this.state, dispatch ? (transaction) => {
          this.state = this.state.apply(transaction);
          this.lastGroup = null;
          this.publish('history');
        } : undefined);
      },
      release: () => { if (this.activeView === token) { this.activeView = null; this.lastGroup = null; } },
    };
  }
}
