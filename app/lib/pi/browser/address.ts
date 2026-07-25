export function normalizeBrowserAddressInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === 'about:blank') return trimmed;
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return `https://${trimmed}`;
}
