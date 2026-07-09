export type TextEditorGuardReason = 'large-document' | 'long-line' | 'slash-runaway';

export interface TextEditorGuardAnalysis {
  length: number;
  maxLineLength: number;
  maxRepeatedSlashRun: number;
  maxSlashDenseLineBlock: number;
}

export interface TextEditorPerformanceProfile {
  disableLanguageExtension: boolean;
  disableLineWrapping: boolean;
  reasons: TextEditorGuardReason[];
}

export const MARKDOWN_RICH_TEXT_CHARACTER_LIMIT = 180_000;
export const TEXT_EDITOR_LIGHTWEIGHT_CHARACTER_LIMIT = 260_000;
export const TEXT_EDITOR_LONG_LINE_LIMIT = 12_000;
export const RUNAWAY_SLASH_SEQUENCE_LIMIT = 220;
export const RUNAWAY_SLASH_DENSE_LINE_MIN_LENGTH = 48;
export const RUNAWAY_SLASH_DENSE_LINE_RATIO = 0.85;
export const RUNAWAY_SLASH_DENSE_LINE_BLOCK_LIMIT = 8;

export function analyzeTextEditorContent(content: string): TextEditorGuardAnalysis {
  let maxLineLength = 0;
  let lineLength = 0;
  let lineSlashCount = 0;
  let maxRepeatedSlashRun = 0;
  let repeatedSlashRun = 0;
  let repeatedSlashChar: '/' | '\\' | null = null;
  let slashDenseLineBlock = 0;
  let maxSlashDenseLineBlock = 0;
  let previousWasCarriageReturn = false;

  const finishLine = () => {
    maxLineLength = Math.max(maxLineLength, lineLength);

    const isSlashDenseLine =
      lineLength >= RUNAWAY_SLASH_DENSE_LINE_MIN_LENGTH &&
      lineSlashCount / lineLength >= RUNAWAY_SLASH_DENSE_LINE_RATIO;

    if (isSlashDenseLine) {
      slashDenseLineBlock += 1;
      maxSlashDenseLineBlock = Math.max(maxSlashDenseLineBlock, slashDenseLineBlock);
    } else {
      slashDenseLineBlock = 0;
    }

    lineLength = 0;
    lineSlashCount = 0;
    repeatedSlashRun = 0;
    repeatedSlashChar = null;
  };

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === '\r' || char === '\n') {
      if (!(char === '\n' && previousWasCarriageReturn)) {
        finishLine();
      }
      previousWasCarriageReturn = char === '\r';
      continue;
    }

    previousWasCarriageReturn = false;
    lineLength += 1;

    if (char === '/' || char === '\\') {
      lineSlashCount += 1;
      if (repeatedSlashChar === char) {
        repeatedSlashRun += 1;
      } else {
        repeatedSlashChar = char;
        repeatedSlashRun = 1;
      }
      maxRepeatedSlashRun = Math.max(maxRepeatedSlashRun, repeatedSlashRun);
      continue;
    }

    repeatedSlashRun = 0;
    repeatedSlashChar = null;
  }

  finishLine();

  return {
    length: content.length,
    maxLineLength,
    maxRepeatedSlashRun,
    maxSlashDenseLineBlock,
  };
}

export function getRunawaySlashContentMessage(content: string): string | null {
  const analysis = analyzeTextEditorContent(content);

  if (analysis.maxRepeatedSlashRun >= RUNAWAY_SLASH_SEQUENCE_LIMIT) {
    return `Detected ${analysis.maxRepeatedSlashRun} repeated slash/backslash characters in a row`;
  }

  if (analysis.maxSlashDenseLineBlock >= RUNAWAY_SLASH_DENSE_LINE_BLOCK_LIMIT) {
    return `Detected ${analysis.maxSlashDenseLineBlock} consecutive slash-dominated lines`;
  }

  return null;
}

export function getMarkdownSourceModeReason(content: string): TextEditorGuardReason | null {
  const analysis = analyzeTextEditorContent(content);

  if (
    analysis.maxRepeatedSlashRun >= RUNAWAY_SLASH_SEQUENCE_LIMIT ||
    analysis.maxSlashDenseLineBlock >= RUNAWAY_SLASH_DENSE_LINE_BLOCK_LIMIT
  ) {
    return 'slash-runaway';
  }

  if (analysis.maxLineLength >= TEXT_EDITOR_LONG_LINE_LIMIT) {
    return 'long-line';
  }

  if (analysis.length >= MARKDOWN_RICH_TEXT_CHARACTER_LIMIT) {
    return 'large-document';
  }

  return null;
}

export function getTextEditorPerformanceProfile(content: string): TextEditorPerformanceProfile {
  const analysis = analyzeTextEditorContent(content);
  const reasons: TextEditorGuardReason[] = [];

  if (analysis.length >= TEXT_EDITOR_LIGHTWEIGHT_CHARACTER_LIMIT) {
    reasons.push('large-document');
  }
  if (analysis.maxLineLength >= TEXT_EDITOR_LONG_LINE_LIMIT) {
    reasons.push('long-line');
  }
  if (
    analysis.maxRepeatedSlashRun >= RUNAWAY_SLASH_SEQUENCE_LIMIT ||
    analysis.maxSlashDenseLineBlock >= RUNAWAY_SLASH_DENSE_LINE_BLOCK_LIMIT
  ) {
    reasons.push('slash-runaway');
  }

  return {
    disableLanguageExtension: reasons.length > 0,
    disableLineWrapping: reasons.includes('long-line'),
    reasons,
  };
}
