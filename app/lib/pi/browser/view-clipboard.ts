export const MAX_BROWSER_CLIPBOARD_TEXT_BYTES = 48 * 1024;

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertBrowserClipboardText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Browser clipboard text is required.');
  }
  if (utf8Size(value) > MAX_BROWSER_CLIPBOARD_TEXT_BYTES) {
    throw new Error('Browser clipboard text is too large.');
  }
  return value;
}

export function truncateBrowserClipboardText(value: string): string {
  if (utf8Size(value) <= MAX_BROWSER_CLIPBOARD_TEXT_BYTES) return value;

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Size(value.slice(0, middle)) <= MAX_BROWSER_CLIPBOARD_TEXT_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return value.slice(0, low);
}

export function normalizeBrowserClipboardRequestId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Browser clipboard request ID is required.');
  }
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(normalized)) {
    throw new Error('Browser clipboard request ID is invalid.');
  }
  return normalized;
}
