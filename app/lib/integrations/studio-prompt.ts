/** Empty text is valid here; callers own the mode/reference requirements. */
export function normalizeStudioPrompt(value: unknown, maximumLength = Infinity): string | null {
  if (typeof value !== 'string') return null;
  const lineNormalized = value.replace(/\r\n?/gu, '\n');
  // Check before trim: vertical tabs and form feeds at the edges are invalid too.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(lineNormalized)) return null;
  const normalized = lineNormalized.trim();
  return normalized.length <= maximumLength ? normalized : null;
}
