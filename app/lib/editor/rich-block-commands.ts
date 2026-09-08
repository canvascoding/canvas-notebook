import type { Editor, Range } from '@tiptap/core';
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

  if (currentTitle) {
    transaction.replaceWith(
      position + 1,
      position + 1 + currentTitle.nodeSize,
      currentTitle.type.create(currentTitle.attrs, content),
    );
  } else if (titleNodeType) {
    transaction.insert(position + 1, titleNodeType.create(null, content));
  }

  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}

export function updateFootnoteDefinition(editor: Editor, position: number, content: string) {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing || !isEditorPositionInsideDoc(editor, position)) return false;

  const definition = editor.state.doc.nodeAt(position);
  if (!definition || definition.type.name !== 'markdownFootnoteDefinition') return false;

  const firstBlock = definition.firstChild;
  const paragraphType = editor.schema.nodes.paragraph;
  if (!paragraphType) return false;

  const paragraph = paragraphType.create(
    firstBlock?.type.name === 'paragraph' ? firstBlock.attrs : null,
    content ? editor.schema.text(content) : undefined,
  );
  const transaction = editor.state.tr;
  if (firstBlock) {
    transaction.replaceWith(position + 1, position + 1 + firstBlock.nodeSize, paragraph);
  } else {
    transaction.insert(position + 1, paragraph);
  }
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
