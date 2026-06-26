import type { Editor, Range } from '@tiptap/core';

export function isEditorPositionInsideDoc(editor: Editor, position: number) {
  return Number.isInteger(position) && position >= 0 && position <= editor.state.doc.content.size;
}

export function isEditorRangeInsideDoc(editor: Editor, range: Range) {
  return (
    Number.isInteger(range.from) &&
    Number.isInteger(range.to) &&
    range.from >= 0 &&
    range.to >= range.from &&
    range.to <= editor.state.doc.content.size
  );
}

export function clampEditorRangeToDoc(editor: Editor, range: Range): Range | null {
  if (!Number.isInteger(range.from) || !Number.isInteger(range.to) || range.to < range.from) {
    return null;
  }

  const maxPosition = editor.state.doc.content.size;
  const from = Math.min(Math.max(range.from, 0), maxPosition);
  const to = Math.min(Math.max(range.to, from), maxPosition);

  return { from, to };
}

export function getSlashCommandDeletionRange(editor: Editor, range: Range): Range | null {
  if (range.from === range.to || !isEditorRangeInsideDoc(editor, range)) {
    return null;
  }

  const rangeText = editor.state.doc.textBetween(range.from, range.to, '\n', '\n');
  return rangeText.startsWith('/') ? range : null;
}
