import { CommandManager, type Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { ySyncPluginKey } from '@tiptap/y-tiptap';

import { analyzeMarkdownRichMode, type MarkdownRichModeReason, type MarkdownSafeNormalization } from '../markdown/rich-markdown-codec';
import type { MarkdownFrontmatterMode } from '../markdown/editor-document';
import { generateRichNodeIds } from './generate-rich-node-ids';
import { invalidateEditorTarget, resolveEditorRangeTarget, type EditorRangeTarget } from './interaction-target';

export type PreparedMarkdownInsertion =
  | { ok: true; body: string; normalizations: MarkdownSafeNormalization[] }
  | { ok: false; reason: 'empty' | 'frontmatter' | MarkdownRichModeReason };

export function prepareMarkdownInsertion(
  markdown: string,
  frontmatter: MarkdownFrontmatterMode = 'metadata',
): PreparedMarkdownInsertion {
  if (!markdown.trim()) return { ok: false, reason: 'empty' };
  const analysis = analyzeMarkdownRichMode(markdown, frontmatter);
  if (analysis.mode === 'source') return { ok: false, reason: analysis.reason };
  // Inserting a body must never silently discard or replace document metadata.
  if (analysis.prefix) return { ok: false, reason: 'frontmatter' };
  return { ok: true, body: analysis.mode === 'normalizable' ? analysis.normalizedBody : analysis.body,
    normalizations: analysis.mode === 'normalizable' ? analysis.normalizations : [] };
}

export type MarkdownInsertionResult = { ok: true } | { ok: false; reason: 'target_changed' | 'invalid_content' };

function retainsInsertedBlocks(doc: ProseMirrorNode, inserted: ProseMirrorNode): boolean {
  const expected = new Map<string, ProseMirrorNode>();
  inserted.forEach((node) => expected.set(node.attrs.id, node));
  if (expected.size !== inserted.childCount) return false;
  let intact = true;
  doc.descendants((node) => {
    const original = expected.get(node.attrs.id);
    if (!original) return;
    if (!node.eq(original)) intact = false;
    expected.delete(node.attrs.id);
    return false;
  });
  return intact && expected.size === 0;
}

/** Prepare the native command without dispatch, then reject lossy schema fitting. */
export function insertPreparedMarkdown(
  editor: Editor,
  target: EditorRangeTarget | null,
  prepared: Extract<PreparedMarkdownInsertion, { ok: true }>,
): MarkdownInsertionResult {
  const range = resolveEditorRangeTarget(editor, target);
  if (!range) return { ok: false, reason: 'target_changed' };
  // Legacy XML collaboration cannot safely undo structural insertion yet.
  if (ySyncPluginKey.getState(editor.state)) return { ok: false, reason: 'invalid_content' };
  const state = editor.state;
  const transaction = state.tr;
  try {
    if (!editor.markdown || !prepared.body.trim()) return { ok: false, reason: 'invalid_content' };
    const parsed = generateRichNodeIds(editor.markdown.parse(prepared.body), editor.options.extensions);
    const inserted = editor.schema.nodeFromJSON(parsed);
    inserted.check();
    if (!inserted.childCount) return { ok: false, reason: 'invalid_content' };
    const $from = state.doc.resolve(range.from);
    const $to = state.doc.resolve(range.to);
    const inline = inserted.childCount === 1 && inserted.firstChild?.type.name === 'paragraph'
      && $from.sameParent($to) && $from.parent.inlineContent;
    const content = inline ? inserted.firstChild!.content : inserted.content;
    const accepted = new CommandManager({ editor, state }).createChain(transaction)
      .command(({ tr }) => { tr.setStoredMarks([]); return true; })
      .insertContentAt(range, content, { errorOnInvalidContent: true, updateSelection: true }).run();
    if (!accepted || !transaction.docChanged) return { ok: false, reason: 'invalid_content' };
    transaction.doc.check();
    const preserved = inline
      ? transaction.doc.slice(range.from, range.from + content.size).content.eq(content)
      : retainsInsertedBlocks(transaction.doc, inserted);
    if (!preserved) return { ok: false, reason: 'invalid_content' };
    if (editor.state !== state || !resolveEditorRangeTarget(editor, target)) return { ok: false, reason: 'target_changed' };
  } catch {
    return { ok: false, reason: 'invalid_content' };
  }
  editor.view.dispatch(closeHistory(transaction).setMeta('uiEvent', 'paste'));
  if (editor.state === state) return { ok: false, reason: 'target_changed' };
  // StarterKit needs an end boundary; local/block history also isolates paste.
  editor.view.dispatch(closeHistory(editor.state.tr).setMeta('addToHistory', false));
  invalidateEditorTarget(target);
  return { ok: true };
}
