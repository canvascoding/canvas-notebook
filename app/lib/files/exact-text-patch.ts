export type ExactTextEdit = {
  oldText: string;
  newText: string;
  expectedOccurrences?: number;
};

export class ExactTextPatchError extends Error {
  readonly code: 'invalid_occurrences' | 'empty_source' | 'occurrence_mismatch';
  readonly editIndex: number;
  readonly expectedOccurrences: number;
  readonly actualOccurrences: number | null;

  constructor(input: {
    message: string;
    code: ExactTextPatchError['code'];
    editIndex: number;
    expectedOccurrences: number;
    actualOccurrences?: number | null;
  }) {
    super(input.message);
    this.name = 'ExactTextPatchError';
    this.code = input.code;
    this.editIndex = input.editIndex;
    this.expectedOccurrences = input.expectedOccurrences;
    this.actualOccurrences = input.actualOccurrences ?? null;
  }
}

export function countExactTextOccurrences(content: string, needle: string): number {
  if (!needle) return 0;

  let count = 0;
  let index = 0;
  while (index <= content.length) {
    const found = content.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

export function applyExactTextEdits(
  content: string,
  edits: ExactTextEdit[],
  label = 'text',
): string {
  let nextContent = content;
  for (const [editIndex, edit] of edits.entries()) {
    const expectedOccurrences = edit.expectedOccurrences ?? 1;
    if (!Number.isInteger(expectedOccurrences) || expectedOccurrences < 1) {
      throw new ExactTextPatchError({
        message: `Invalid expectedOccurrences for ${label}. Use a positive integer.`,
        code: 'invalid_occurrences',
        editIndex,
        expectedOccurrences,
      });
    }
    if (!edit.oldText) {
      throw new ExactTextPatchError({
        message: `oldText must not be empty for ${label}.`,
        code: 'empty_source',
        editIndex,
        expectedOccurrences,
      });
    }

    const occurrences = countExactTextOccurrences(nextContent, edit.oldText);
    if (occurrences !== expectedOccurrences) {
      throw new ExactTextPatchError({
        message: `Refusing to edit ${label}: oldText matched ${occurrences} time(s), expected ${expectedOccurrences}. No changes were written.`,
        code: 'occurrence_mismatch',
        editIndex,
        expectedOccurrences,
        actualOccurrences: occurrences,
      });
    }
    nextContent = nextContent.split(edit.oldText).join(edit.newText);
  }
  return nextContent;
}
