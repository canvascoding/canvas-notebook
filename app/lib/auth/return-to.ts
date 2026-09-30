/** Accept only local app paths, including their query string. */
export function safeAppReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
    || /[\\\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value, 'https://canvas.invalid');
    if (url.origin !== 'https://canvas.invalid') return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

export function localizedAppReturnTo(value: unknown, locale: string): string {
  const path = safeAppReturnTo(value) || '/';
  if (/^\/(de|en)(?:\/|\?|#|$)/u.test(path)) return path;
  return `/${locale}${path}`;
}
