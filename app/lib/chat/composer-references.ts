export type ComposerReferenceKind = 'file' | 'capability' | 'all';
export type ComposerReferenceTrigger = '@' | '+';

export interface ComposerReferenceMatch {
  kind: ComposerReferenceKind;
  trigger: ComposerReferenceTrigger;
  query: string;
  startIndex: number;
  endIndex: number;
}

function isFileBoundaryCharacter(character: string | undefined): boolean {
  return !character || /\s|[\(\[\{"'`,;]/.test(character);
}

function getFileReferenceMatchForTrigger(value: string, cursorPosition: number, trigger: '@' | '+'): ComposerReferenceMatch | null {
  const lastTriggerIndex = value.lastIndexOf(trigger, cursorPosition);
  if (lastTriggerIndex === -1 || cursorPosition <= lastTriggerIndex) {
    return null;
  }

  if (!isFileBoundaryCharacter(value[lastTriggerIndex - 1])) {
    return null;
  }

  const query = value.slice(lastTriggerIndex + 1, cursorPosition);
  const hasUnsupportedWhitespace = /[\r\n\t]/.test(query) || query.includes('  ');
  const hasCompletedQuote = query.includes('"') && query.indexOf('"') < query.length - 1;
  const hasAnotherAt = query.includes('@');
  const hasAnotherPlus = query.includes('+');
  const previousText = value.slice(0, lastTriggerIndex).trimEnd();
  const isLikelyArithmetic = trigger === '+'
    && /\d$/.test(previousText)
    && /^[\s]*[\d.]/.test(query);

  if (hasUnsupportedWhitespace || hasCompletedQuote || hasAnotherAt || hasAnotherPlus || isLikelyArithmetic) {
    return null;
  }

  return {
    kind: 'all',
    trigger,
    query,
    startIndex: lastTriggerIndex,
    endIndex: cursorPosition,
  };
}

function getFileReferenceMatch(value: string, cursorPosition: number): ComposerReferenceMatch | null {
  const atMatch = getFileReferenceMatchForTrigger(value, cursorPosition, '@');
  const plusMatch = getFileReferenceMatchForTrigger(value, cursorPosition, '+');

  if (atMatch && plusMatch) {
    return atMatch.startIndex > plusMatch.startIndex ? atMatch : plusMatch;
  }

  return atMatch || plusMatch;
}

export function findActiveComposerReference(value: string, cursorPosition: number): ComposerReferenceMatch | null {
  return getFileReferenceMatch(value, cursorPosition);
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
