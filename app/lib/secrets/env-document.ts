/** Literal ENV grammar: no interpolation, command evaluation or shell expansion. */
export type EnvToken = { raw: string; key?: string; value?: string; prefix?: string; suffix?: string };
export const isEnvKey = (key: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
export function formatEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:-]*$/.test(value) ? value : JSON.stringify(value);
}

export function parseEnvDocument(content: string): EnvToken[] {
  const tokens: EnvToken[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  while (cursor < content.length) {
    const start = cursor;
    const lineEnd = content.indexOf('\n', cursor);
    const end = lineEnd < 0 ? content.length : lineEnd + 1;
    const line = content.slice(cursor, end);
    if (!line.trim() || line.trimStart().startsWith('#')) {
      tokens.push({ raw: line }); cursor = end; continue;
    }
    const match = /^(\s*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*)/.exec(line);
    if (!match) throw new Error(`Invalid ENV assignment at line ${content.slice(0, start).split('\n').length}.`);
    const key = match[2];
    if (seen.has(key)) throw new Error(`Duplicate ENV key: ${key}.`);
    seen.add(key);
    cursor += match[0].length;
    let value = '';
    const quote = content[cursor];
    if (quote === '"' || quote === "'") {
      cursor += 1;
      let closed = false;
      while (cursor < content.length) {
        const char = content[cursor++];
        if (char === quote) { closed = true; break; }
        if (char === '\\' && quote === '"') {
          if (cursor >= content.length) throw new Error(`Unterminated escape for ${key}.`);
          const next = content[cursor++];
          const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\', '$': '$' };
          if (next === 'u' && /^[a-fA-F0-9]{4}$/.test(content.slice(cursor, cursor + 4))) {
            value += String.fromCharCode(parseInt(content.slice(cursor, cursor + 4), 16)); cursor += 4;
          } else value += escapes[next] ?? `\\${next}`;
        } else value += char;
      }
      if (!closed) throw new Error(`Unterminated quoted ENV value for ${key}.`);
      const tailEnd = content.indexOf('\n', cursor);
      const recordEnd = tailEnd < 0 ? content.length : tailEnd + 1;
      const suffix = content.slice(cursor, recordEnd);
      if (!/^[ \t\r]*(?:#.*)?(?:\n)?$/.test(suffix)) throw new Error(`Unexpected text after quoted ENV value for ${key}.`);
      tokens.push({ raw: content.slice(start, recordEnd), key, value, prefix: match[0], suffix });
      cursor = recordEnd;
    } else {
      const remaining = content.slice(cursor, end).replace(/\r?\n$/, '');
      const hash = remaining.startsWith('#') && /=[ \t]+$/u.test(match[0]) ? 0 : remaining.search(/[ \t]+#/u);
      value = (hash < 0 ? remaining : remaining.slice(0, hash)).trimEnd();
      const suffix = remaining.slice(value.length) + (line.endsWith('\n') ? '\n' : '');
      tokens.push({ raw: content.slice(start, end), key, value, prefix: match[0], suffix });
      cursor = end;
    }
  }
  return tokens;
}

/** Old stores treated the whole unquoted line and quoted escapes literally. Import without reinterpretation. */
export function parseLegacyEnvDocument(content: string): EnvToken[] {
  const seen = new Set<string>();
  return content.match(/[^\n]*\n|[^\n]+$/gu)?.map(raw => {
    if (!raw.trim() || raw.trimStart().startsWith('#')) return { raw };
    const match = /^([ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*)([^\r\n]*)\r?\n?$/u.exec(raw);
    if (!match) throw new Error('Invalid legacy ENV assignment.');
    const key = match[2];
    if (seen.has(key)) throw new Error(`Duplicate ENV key: ${key}.`);
    seen.add(key);
    let value = match[3].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return { raw, key, value, prefix: match[1], suffix: raw.endsWith('\n') ? '\n' : '' };
  }) ?? [];
}

/** Retains comments, ordering and untouched assignment formatting. */
export function updateEnvDocument(tokens: EnvToken[], changes: ReadonlyMap<string, string | null>): string {
  const remaining = new Map(changes);
  let result = '';
  for (const token of tokens) {
    if (!token.key || !remaining.has(token.key)) { result += token.raw; continue; }
    const value = remaining.get(token.key)!;
    remaining.delete(token.key);
    if (value !== null) result += `${token.prefix}${formatEnvValue(value)}${token.suffix}`;
    else if (token.suffix?.trim().startsWith('#')) result += `${token.suffix.trimEnd()}\n`;
  }
  for (const [key, value] of remaining) {
    if (!isEnvKey(key)) throw new Error(`Invalid ENV key: ${key}.`);
    if (value !== null) {
      if (result && !result.endsWith('\n')) result += '\n';
      result += `${key}=${formatEnvValue(value)}\n`;
    }
  }
  return result;
}
