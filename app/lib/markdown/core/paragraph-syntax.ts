// Inline serialization escapes emphasis but not punctuation that can introduce
// a block. After deletion, paragraph text such as "-" must remain paragraph text.
const BLOCK_START = /^( {0,3})(#{1,6}(?=[\t ]|\r?$)|[-+](?=[\t ]|\r?$)|\d{1,9}[.)](?=[\t ]|\r?$)|>|(?:\*[\t ]*){3,}(?=\r?$)|(?:_[\t ]*){3,}(?=\r?$)|(?:-[\t ]*){3,}(?=\r?$)|((?:=+|-+)[\t ]*(?=\r?$)|(?:\|[\t ]*)?:?-+:?[\t ]*(?:\|[\t ]*:?-+:?[\t ]*)*\|?(?=\r?$)))/gmu;

/** Matched backtick spans are literal code, including their physical newlines. */
function inlineCodeRanges(markdown: string): Array<{ from: number; to: number }> {
  const runs = Array.from(markdown.matchAll(/`+/gu));
  const nextMatchingRun: Array<number | undefined> = [];
  const nextByLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index--) {
    const length = runs[index][0].length;
    nextMatchingRun[index] = nextByLength.get(length);
    nextByLength.set(length, index);
  }
  const ranges: Array<{ from: number; to: number }> = [];
  for (let index = 0; index < runs.length; index++) {
    const start = runs[index].index!;
    let backslashes = 0;
    for (let position = start - 1; position >= 0 && markdown[position] === '\\'; position--) backslashes++;
    if (backslashes % 2) continue;
    const closing = nextMatchingRun[index];
    if (closing === undefined) continue;
    ranges.push({ from: start, to: runs[closing].index! + runs[closing][0].length });
    index = closing;
  }
  return ranges;
}

/** Escape block syntax only when the caller is serializing an authored paragraph. */
export function escapeParagraphBlockSyntax(markdown: string): string {
  if (!markdown.match(BLOCK_START)) return markdown;
  const code = inlineCodeRanges(markdown);
  let codeIndex = 0;
  return markdown.replace(BLOCK_START, (match, indentation: string, marker: string, continuation: string | undefined, offset: number) => {
    // Setext and GFM delimiters need a preceding content line. Escaping a
    // standalone "===" or "|---|" would change an already-safe source file.
    if (continuation) {
      const previousStart = markdown.lastIndexOf('\n', offset - 2) + 1;
      if (!offset || !markdown.slice(previousStart, offset - 1).trim()) return match;
    }
    const position = offset + indentation.length;
    while (codeIndex < code.length && code[codeIndex].to <= position) codeIndex++;
    const range = code[codeIndex];
    if (range && range.from <= position && position < range.to) return match;
    // The punctuation, rather than the number, needs a backslash for CommonMark.
    return indentation + (/^\d{1,9}[.)]$/u.test(marker)
      ? marker.slice(0, -1) + '\\' + marker.at(-1)
      : '\\' + marker);
  });
}
