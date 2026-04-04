export type ComposerReferenceKind = 'file' | 'skill';
export type ComposerReferenceTrigger = '@' | '/';

export interface ComposerReferenceMatch {
  kind: ComposerReferenceKind;
  trigger: ComposerReferenceTrigger;
  query: string;
  startIndex: number;
  endIndex: number;
}

function isSlashBoundaryCharacter(character: string | undefined): boolean {
  return !character || /\s|[\(\[\{"'`,;]/.test(character);
}

function getFileReferenceMatch(value: string, cursorPosition: number): ComposerReferenceMatch | null {
  const lastAtIndex = value.lastIndexOf('@', cursorPosition);
  if (lastAtIndex === -1 || cursorPosition <= lastAtIndex) {
    return null;
  }

  const query = value.slice(lastAtIndex + 1, cursorPosition);
  const hasSpace = query.includes(' ');
  const hasCompletedQuote = query.includes('"') && query.indexOf('"') < query.length - 1;
  const hasAnotherAt = query.includes('@');

  if (hasSpace || hasCompletedQuote || hasAnotherAt) {
    return null;
  }

  return {
    kind: 'file',
    trigger: '@',
    query,
    startIndex: lastAtIndex,
    endIndex: cursorPosition,
  };
}

function getSkillReferenceMatch(value: string, cursorPosition: number): ComposerReferenceMatch | null {
  const lastSlashIndex = value.lastIndexOf('/', cursorPosition);
  if (lastSlashIndex === -1 || cursorPosition <= lastSlashIndex) {
    return null;
  }

  if (!isSlashBoundaryCharacter(value[lastSlashIndex - 1])) {
    return null;
  }

  if (value[lastSlashIndex + 1] === '/') {
    return null;
  }

  const query = value.slice(lastSlashIndex + 1, cursorPosition);
  if (/\s/.test(query) || query.includes('/') || query.includes(':') || query.includes('.')) {
    return null;
  }

  return {
    kind: 'skill',
    trigger: '/',
    query,
    startIndex: lastSlashIndex,
    endIndex: cursorPosition,
  };
}

export function findActiveComposerReference(value: string, cursorPosition: number): ComposerReferenceMatch | null {
  const fileMatch = getFileReferenceMatch(value, cursorPosition);
  const skillMatch = getSkillReferenceMatch(value, cursorPosition);

  if (fileMatch && skillMatch) {
    return fileMatch.startIndex > skillMatch.startIndex ? fileMatch : skillMatch;
  }

  return fileMatch || skillMatch;
}

export function replaceComposerReference(
  value: string,
  match: ComposerReferenceMatch,
  replacement: string,
): { nextValue: string; nextCursorPosition: number } {
  const before = value.slice(0, match.startIndex);
  const after = value.slice(match.endIndex);
  const nextValue = `${before}${replacement}${after}`;
  return {
    nextValue,
    nextCursorPosition: before.length + replacement.length,
  };
}
