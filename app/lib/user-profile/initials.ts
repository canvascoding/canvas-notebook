function firstGrapheme(value: string, locale?: string): string {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(locale, { granularity: 'grapheme' });
    return segmenter.segment(value)[Symbol.iterator]().next().value?.segment ?? '';
  }
  return Array.from(value)[0] ?? '';
}

function identityTokens(value: string): string[] {
  return value
    .trim()
    .split(/[\s\p{Z}._\-–—]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function getUserInitials(input: {
  name?: string | null;
  email?: string | null;
  locale?: string;
}): string {
  const normalizedName = input.name?.trim() ?? '';
  const emailLocalPart = input.email?.split('@')[0]?.trim() ?? '';
  const tokens = identityTokens(normalizedName || emailLocalPart);
  if (tokens.length === 0) return '';

  const selected = tokens.length === 1
    ? [tokens[0]]
    : [tokens[0], tokens[tokens.length - 1]];
  return selected
    .map((token) => firstGrapheme(token, input.locale))
    .join('')
    .toLocaleUpperCase(input.locale);
}
