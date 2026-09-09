/** Offsets use JavaScript UTF-16 indices, like String.length and maxChars. */
export function readTextWindow(text: string, offset: unknown, maxChars: number) {
  if (offset !== undefined && (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)) {
    throw new Error('offset must be a non-negative integer (UTF-16 character index).');
  }
  let start = Math.min((offset as number | undefined) ?? 0, text.length);
  // A caller-supplied offset inside a surrogate pair includes the complete character.
  if (start > 0 && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) start -= 1;
  let end = Math.min(text.length, start + Math.max(0, Math.trunc(maxChars)));
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1;
  return {
    text: text.slice(start, end),
    offset: start,
    nextOffset: end,
    totalChars: text.length,
    eof: end === text.length,
    truncated: start > 0 || end < text.length,
  };
}

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }
