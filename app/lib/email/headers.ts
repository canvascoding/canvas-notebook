import 'server-only';

export type EmailCustomHeaders = Record<string, string>;

const ALLOWED_CUSTOM_HEADERS = new Set([
  'x-canvas-todo-id',
  'x-canvas-reply-token',
]);

function sanitizeHeaderValue(value: string): string {
  return value
    .replace(/[\r\n]+/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .trim()
    .slice(0, 500);
}

function normalizeHeaderName(value: string): string | null {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9-]{1,64}$/u.test(normalized)) return null;
  if (!ALLOWED_CUSTOM_HEADERS.has(normalized.toLowerCase())) return null;
  return normalized;
}

export function normalizeEmailCustomHeaders(value: unknown): EmailCustomHeaders {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const headers: EmailCustomHeaders = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number') continue;
    const name = normalizeHeaderName(rawName);
    if (!name) continue;
    const headerValue = sanitizeHeaderValue(String(rawValue));
    if (!headerValue) continue;
    headers[name] = headerValue;
  }
  return headers;
}

export function emailCustomHeaderEntries(value: unknown): Array<{ name: string; value: string }> {
  return Object.entries(normalizeEmailCustomHeaders(value)).map(([name, headerValue]) => ({
    name,
    value: headerValue,
  }));
}
