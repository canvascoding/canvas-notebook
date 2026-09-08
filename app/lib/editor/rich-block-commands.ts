import type { Editor, Range } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { preserveAlignedStableIds, stableIdCounts } from './rich-node-identities';
import { isEditorPositionInsideDoc, isEditorRangeInsideDoc } from './prosemirror-ranges';

export function replaceRichBlockTitle(
  editor: Editor,
  position: number,
  blockType: string,
  titleType: string,
  title: string,
  attrs: Record<string, unknown>,
) {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing || !isEditorPositionInsideDoc(editor, position)) return false;
  const node = editor.state.doc.nodeAt(position);
  if (!node || node.type.name !== blockType) return false;

  const transaction = editor.state.tr.setNodeMarkup(position, node.type, {
    ...node.attrs,
    ...attrs,
  });
  const currentTitle = node.firstChild?.type.name === titleType ? node.firstChild : null;
  const titleNodeType = editor.schema.nodes[titleType];
  const content = title ? editor.schema.text(title) : undefined;

  if (currentTitle && currentTitle.textContent !== title) {
    transaction.replaceWith(
      position + 1,
      position + 1 + currentTitle.nodeSize,
      currentTitle.type.create(currentTitle.attrs, content),
    );
  } else if (!currentTitle && titleNodeType) {
    transaction.insert(position + 1, titleNodeType.create(null, content));
  }

  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}

export function updateFootnoteDefinition(editor: Editor, position: number, content: string) {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing || !isEditorPositionInsideDoc(editor, position)) return false;

  const definition = editor.state.doc.nodeAt(position);
  if (!definition || definition.type.name !== 'markdownFootnoteDefinition') return false;

  const parsed = parseFootnoteContent(editor, content);
  if (!parsed) return false;
  const next = { ...definition.toJSON(), content: parsed.content.toJSON() };
  preserveAlignedStableIds(definition.toJSON(), next, stableIdCounts(editor.state.doc.toJSON()));
  const replacement = editor.schema.nodeFromJSON(next);
  const transaction = editor.state.tr.replaceWith(position + 1, position + definition.nodeSize - 1, replacement.content);
  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}

export function insertMathAtRange(
  editor: Editor,
  kind: 'inlineMath' | 'blockMath',
  latex: string,
  range: Range,
) {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing || !isEditorRangeInsideDoc(editor, range)) return false;
  const chain = editor.chain().focus().deleteRange(range);
  return kind === 'inlineMath'
    ? chain.insertInlineMath({ latex, pos: range.from }).run()
    : chain.insertBlockMath({ latex, pos: range.from }).run();
}

/** The draft is Markdown so multiple blocks and inline formatting remain editable. */
export function richBlockContentMarkdown(editor: Editor, node: ProseMirrorNode): string | null {
  if (!editor.markdown) return null;
  return editor.markdown.serialize({ type: 'doc', content: node.content.toJSON() });
}

function parseFootnoteContent(editor: Editor, markdown: string): ProseMirrorNode | null {
  if (!editor.markdown) return null;
  try {
    const parsed = editor.schema.nodeFromJSON(editor.markdown.parse(markdown));
    parsed.check();
    return parsed;
  } catch { return null; }
}

export function insertRichFootnoteAtRange(editor: Editor, content: string, range: Range): boolean {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing || !isEditorRangeInsideDoc(editor, range)) return false;
  const parsed = parseFootnoteContent(editor, content);
  if (!parsed) return false;
  return editor.chain().focus().insertMarkdownFootnote({ content: '', range }).command(({ tr }) => {
    // insertMarkdownFootnote appends its new definition in this same transaction.
    const definition = tr.doc.lastChild;
    if (definition?.type.name !== 'markdownFootnoteDefinition') return false;
    const position = tr.doc.content.size - definition.nodeSize;
    tr.replaceWith(position + 1, tr.doc.content.size - 1, parsed.content);
    return true;
  }).run();
}
