const DETAILS_OPEN_LINE = /^<details(?:\s+open(?:=(?:"open"|'open'|open))?)?>[ \t]*$/u;

/** Match our portable Details format, balancing nested containers outside fences. */
export function parseDetailsBlock(source: string) {
  const header = /^<details(?:\s+(open)(?:=(?:"open"|'open'|open))?)?>[ \t]*\r?\n<summary>([^\r\n]*)<\/summary>[ \t]*\r?\n/u.exec(source);
  if (!header) return null;
  let depth = 1;
  let fence: { character: string; length: number } | null = null;
  for (let offset = header[0].length; offset < source.length;) {
    const newline = source.indexOf('\n', offset);
    const end = newline < 0 ? source.length : newline + 1;
    const line = source.slice(offset, newline < 0 ? end : newline).replace(/\r$/u, '');
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      fence = { character: marker[1][0], length: marker[1].length };
    } else if (DETAILS_OPEN_LINE.test(line)) {
      depth++;
    } else if (line === '</details>') {
      depth--;
      if (depth === 0) return { raw: source.slice(0, end), open: Boolean(header[1]),
        summary: header[2].trim(), body: source.slice(header[0].length, offset).trim() };
    }
    offset = end;
  }
  return null;
}
