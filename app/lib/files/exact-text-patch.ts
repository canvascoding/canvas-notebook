export type ExactTextEdit = {
  oldText: string;
  newText: string;
  expectedOccurrences?: number;
  replaceAll?: boolean;
};

export class ExactTextPatchError extends Error {
  readonly code: 'invalid_occurrences' | 'conflicting_occurrence_mode' | 'empty_source' | 'occurrence_mismatch';
  readonly editIndex: number;
  readonly expectedOccurrences: number | null;
  readonly actualOccurrences: number | null;
  readonly matchMode: 'exact' | 'all';
  readonly oldTextPreview: string;
  readonly occurrenceLines: number[];

  constructor(input: {
    message: string;
    code: ExactTextPatchError['code'];
    editIndex: number;
    expectedOccurrences?: number | null;
    actualOccurrences?: number | null;
    matchMode?: 'exact' | 'all';
    oldText?: string;
    occurrenceLines?: number[];
  }) {
    super(input.message);
    this.name = 'ExactTextPatchError';
    this.code = input.code;
    this.editIndex = input.editIndex;
    this.expectedOccurrences = input.expectedOccurrences ?? null;
    this.actualOccurrences = input.actualOccurrences ?? null;
    this.matchMode = input.matchMode ?? 'exact';
    this.oldTextPreview = previewExactText(input.oldText ?? '');
    this.occurrenceLines = input.occurrenceLines ?? [];
  }
}

function previewExactText(value: string): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function lineNumbersForOffsets(content: string, offsets: number[]): number[] {
  const lines: number[] = [];
  let offsetIndex = 0;
  let line = 1;
  for (let index = 0; index <= content.length && offsetIndex < offsets.length; index += 1) {
    while (offsetIndex < offsets.length && offsets[offsetIndex] === index) {
      lines.push(line);
      offsetIndex += 1;
    }
    if (content[index] === '\n') line += 1;
  }
  return lines;
}

export function findExactTextOccurrenceOffsets(content: string, needle: string): number[] {
  if (!needle) return [];

  const offsets: number[] = [];
  let index = 0;
  while (index <= content.length) {
    const found = content.indexOf(needle, index);
    if (found === -1) break;
    offsets.push(found);
    index = found + needle.length;
  }
  return offsets;
}

export function countExactTextOccurrences(content: string, needle: string): number {
  return findExactTextOccurrenceOffsets(content, needle).length;
}

export function resolveExactTextEditMatchCount(input: {
  content: string;
  edit: ExactTextEdit;
  label: string;
  editIndex: number;
}): number {
  const { content, edit, label, editIndex } = input;
  const matchMode = edit.replaceAll ? 'all' : 'exact';
  if (edit.replaceAll && edit.expectedOccurrences !== undefined) {
    throw new ExactTextPatchError({
      message: `Invalid edit ${editIndex + 1} for ${label}: replaceAll cannot be combined with expectedOccurrences.`,
      code: 'conflicting_occurrence_mode',
      editIndex,
      expectedOccurrences: edit.expectedOccurrences,
      matchMode,
      oldText: edit.oldText,
    });
  }

  const expectedOccurrences = edit.replaceAll ? null : edit.expectedOccurrences ?? 1;
  if (expectedOccurrences !== null && (!Number.isInteger(expectedOccurrences) || expectedOccurrences < 1)) {
    throw new ExactTextPatchError({
      message: `Invalid expectedOccurrences for ${label}. Use a positive integer.`,
      code: 'invalid_occurrences',
      editIndex,
      expectedOccurrences,
      matchMode,
      oldText: edit.oldText,
    });
  }
  if (!edit.oldText) {
    throw new ExactTextPatchError({
      message: `oldText must not be empty for ${label}.`,
      code: 'empty_source',
      editIndex,
      expectedOccurrences,
      matchMode,
    });
  }

  const offsets = findExactTextOccurrenceOffsets(content, edit.oldText);
  const occurrences = offsets.length;
  const occurrenceLines = lineNumbersForOffsets(content, offsets.slice(0, 10));
  if (expectedOccurrences === null && occurrences === 0) {
    throw new ExactTextPatchError({
      message: `Refusing to edit ${label}: replaceAll found no matches. No changes were written.`,
      code: 'occurrence_mismatch',
      editIndex,
      expectedOccurrences: null,
      actualOccurrences: occurrences,
      matchMode,
      oldText: edit.oldText,
      occurrenceLines,
    });
  }
  if (expectedOccurrences !== null && occurrences !== expectedOccurrences) {
    throw new ExactTextPatchError({
      message: `Refusing to edit ${label}: oldText matched ${occurrences} time(s), expected ${expectedOccurrences}. No changes were written.`,
      code: 'occurrence_mismatch',
      editIndex,
      expectedOccurrences,
      actualOccurrences: occurrences,
      matchMode,
      oldText: edit.oldText,
      occurrenceLines,
    });
  }
  return occurrences;
}

export function applyExactTextEdits(
  content: string,
  edits: ExactTextEdit[],
  label = 'text',
): string {
  let nextContent = content;
  for (const [editIndex, edit] of edits.entries()) {
    resolveExactTextEditMatchCount({ content: nextContent, edit, label, editIndex });
    nextContent = nextContent.split(edit.oldText).join(edit.newText);
  }
  return nextContent;
}
