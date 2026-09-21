import { FILE_VERSION_CENTER_CONTRACT_LIMITS, type FileVersionDiffHunkV1 } from './contracts/v1';

type DiffOperation = { kind: 'context' | 'addition' | 'deletion'; text: string };
type NumberedDiffOperation = DiffOperation & { oldLineNumber: number | null; newLineNumber: number | null };

export function fileVersionTextLines(value: string): string[] {
  if (value.length === 0) return [];
  const normalized = value.replace(/\r\n?/gu, '\n');
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
}

function patienceAnchors(
  before: string[], after: string[], beforeStart: number, beforeEnd: number, afterStart: number, afterEnd: number,
): Array<[number, number]> {
  const beforeUnique = new Map<string, number>();
  const afterUnique = new Map<string, number>();
  for (let index = beforeStart; index < beforeEnd; index += 1) {
    const value = before[index]!;
    beforeUnique.set(value, beforeUnique.has(value) ? -1 : index);
  }
  for (let index = afterStart; index < afterEnd; index += 1) {
    const value = after[index]!;
    afterUnique.set(value, afterUnique.has(value) ? -1 : index);
  }
  const pairs = [...beforeUnique]
    .filter(([value, index]) => index >= 0 && (afterUnique.get(value) ?? -1) >= 0)
    .map(([, index]) => [index, afterUnique.get(before[index]!)!] as [number, number])
    .sort((left, right) => left[0] - right[0]);
  if (pairs.length < 2) return pairs;

  const tails: number[] = [];
  const previous = new Array<number>(pairs.length).fill(-1);
  for (let index = 0; index < pairs.length; index += 1) {
    const afterIndex = pairs[index]![1];
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (pairs[tails[middle]!]![1] < afterIndex) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1]!;
    tails[low] = index;
  }
  const result: Array<[number, number]> = [];
  let cursor = tails.at(-1) ?? -1;
  while (cursor >= 0) {
    result.push(pairs[cursor]!);
    cursor = previous[cursor]!;
  }
  return result.reverse();
}

function diffLines(before: string[], after: string[]): DiffOperation[] {
  const result: DiffOperation[] = [];
  const visit = (beforeStart: number, beforeEnd: number, afterStart: number, afterEnd: number): void => {
    while (beforeStart < beforeEnd && afterStart < afterEnd && before[beforeStart] === after[afterStart]) {
      result.push({ kind: 'context', text: before[beforeStart]! });
      beforeStart += 1;
      afterStart += 1;
    }
    let suffix = 0;
    while (beforeStart + suffix < beforeEnd && afterStart + suffix < afterEnd
      && before[beforeEnd - suffix - 1] === after[afterEnd - suffix - 1]) suffix += 1;
    const middleBeforeEnd = beforeEnd - suffix;
    const middleAfterEnd = afterEnd - suffix;
    const anchors = patienceAnchors(before, after, beforeStart, middleBeforeEnd, afterStart, middleAfterEnd);
    if (anchors.length > 0) {
      let nextBefore = beforeStart;
      let nextAfter = afterStart;
      for (const [beforeIndex, afterIndex] of anchors) {
        visit(nextBefore, beforeIndex, nextAfter, afterIndex);
        result.push({ kind: 'context', text: before[beforeIndex]! });
        nextBefore = beforeIndex + 1;
        nextAfter = afterIndex + 1;
      }
      visit(nextBefore, middleBeforeEnd, nextAfter, middleAfterEnd);
    } else {
      for (let index = beforeStart; index < middleBeforeEnd; index += 1) {
        result.push({ kind: 'deletion', text: before[index]! });
      }
      for (let index = afterStart; index < middleAfterEnd; index += 1) {
        result.push({ kind: 'addition', text: after[index]! });
      }
    }
    for (let index = suffix; index > 0; index -= 1) {
      result.push({ kind: 'context', text: before[beforeEnd - index]! });
    }
  };
  visit(0, before.length, 0, after.length);
  return result;
}

function numberOperations(operations: DiffOperation[]): NumberedDiffOperation[] {
  let oldLine = 1;
  let newLine = 1;
  return operations.map((operation) => {
    if (operation.kind === 'context') {
      const numbered = { ...operation, oldLineNumber: oldLine, newLineNumber: newLine };
      oldLine += 1;
      newLine += 1;
      return numbered;
    }
    if (operation.kind === 'deletion') {
      const numbered = { ...operation, oldLineNumber: oldLine, newLineNumber: null };
      oldLine += 1;
      return numbered;
    }
    const numbered = { ...operation, oldLineNumber: null, newLineNumber: newLine };
    newLine += 1;
    return numbered;
  });
}

function hunkStart(operations: NumberedDiffOperation[], start: number, side: 'old' | 'new'): number {
  for (let index = start; index < operations.length; index += 1) {
    const value = side === 'old' ? operations[index]!.oldLineNumber : operations[index]!.newLineNumber;
    if (value !== null) return value;
  }
  for (let index = start - 1; index >= 0; index -= 1) {
    const value = side === 'old' ? operations[index]!.oldLineNumber : operations[index]!.newLineNumber;
    if (value !== null) return value + 1;
  }
  return 1;
}

function createHunks(operations: DiffOperation[]): { hunks: FileVersionDiffHunkV1[]; lineTextTruncated: boolean } {
  const numbered = numberOperations(operations);
  const changed = numbered.flatMap((operation, index) => operation.kind === 'context' ? [] : [index]);
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - 3);
    const end = Math.min(numbered.length, index + 4);
    const previous = ranges.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else ranges.push([start, end]);
  }
  const hunks: FileVersionDiffHunkV1[] = [];
  let lineTextTruncated = false;
  for (const [rangeStart, rangeEnd] of ranges) {
    for (let start = rangeStart; start < rangeEnd; start += FILE_VERSION_CENTER_CONTRACT_LIMITS.diffLinesPerHunk) {
      const end = Math.min(rangeEnd, start + FILE_VERSION_CENTER_CONTRACT_LIMITS.diffLinesPerHunk);
      const slice = numbered.slice(start, end);
      const safeLines = slice.map((operation) => {
        if (operation.text.length > FILE_VERSION_CENTER_CONTRACT_LIMITS.diffLineCharacters) lineTextTruncated = true;
        return { kind: operation.kind, oldLineNumber: operation.oldLineNumber,
          newLineNumber: operation.newLineNumber,
          text: operation.text.slice(0, FILE_VERSION_CENTER_CONTRACT_LIMITS.diffLineCharacters) };
      });
      hunks.push({
        id: `hunk-${hunks.length + 1}`,
        oldStart: hunkStart(numbered, start, 'old'),
        oldLines: slice.filter((operation) => operation.kind !== 'addition').length,
        newStart: hunkStart(numbered, start, 'new'),
        newLines: slice.filter((operation) => operation.kind !== 'deletion').length,
        lines: safeLines,
      });
    }
  }
  return { hunks, lineTextTruncated };
}

export function projectFileVersionTextDiff(before: string[], after: string[]): {
  summary: { additions: number; deletions: number; unchanged: number };
  hunks: FileVersionDiffHunkV1[];
  lineTextTruncated: boolean;
} {
  const operations = diffLines(before, after);
  const summary = operations.reduce((value, operation) => ({
    additions: value.additions + Number(operation.kind === 'addition'),
    deletions: value.deletions + Number(operation.kind === 'deletion'),
    unchanged: value.unchanged + Number(operation.kind === 'context'),
  }), { additions: 0, deletions: 0, unchanged: 0 });
  return { summary, ...createHunks(operations) };
}
