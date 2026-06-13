const HTML_DOCUMENT_PATTERN = /^(?:<!doctype\s+html\b|<html[\s>]|<head[\s>]|<body[\s>])/iu;
const HTML_FRAGMENT_OPEN_PATTERN = /<(?:article|center|div|h[1-6]|main|p|section|style|table|tbody|td|th|thead|tr)[\s>]/iu;
const HTML_FRAGMENT_CLOSE_PATTERN = /<\/(?:article|center|div|h[1-6]|main|p|section|style|table|tbody|td|th|thead|tr)>/iu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function stripOuterCodeFence(value: string): { htmlHint: boolean; value: string } {
  const trimmed = value.trim();
  const opening = /^(`{2,}|~{3,})([A-Za-z0-9_-]+)?[^\S\r\n]*(?:\r?\n|$)/u.exec(trimmed);
  if (!opening) return { htmlHint: false, value: trimmed };

  const fence = opening[1];
  const language = (opening[2] || '').toLowerCase();
  const htmlHint = language === 'html' || language === 'htm' || language === 'xhtml';
  const closing = new RegExp(`\\r?\\n${escapeRegExp(fence)}\\s*$`, 'u');
  const inner = trimmed.slice(opening[0].length).replace(closing, '').trim();

  if (!htmlHint && !containsHtmlMarkup(inner)) {
    return { htmlHint: false, value: trimmed };
  }

  return { htmlHint, value: inner };
}

function containsHtmlMarkup(value: string): boolean {
  const normalized = value.trim();
  return HTML_DOCUMENT_PATTERN.test(normalized)
    || (HTML_FRAGMENT_OPEN_PATTERN.test(normalized) && HTML_FRAGMENT_CLOSE_PATTERN.test(normalized));
}

export function normalizeEmailHtmlContent(value: string | null | undefined): string {
  let normalized = String(value ?? '').replace(/^\uFEFF/u, '').trim();

  for (let index = 0; index < 3; index += 1) {
    const unwrapped = stripOuterCodeFence(normalized);
    if (unwrapped.value === normalized) break;
    normalized = unwrapped.value;
  }

  return normalized;
}

export function isLikelyHtmlEmailContent(value: string | null | undefined): boolean {
  const raw = String(value ?? '').replace(/^\uFEFF/u, '').trim();
  if (!raw) return false;

  let normalized = raw;
  let hadHtmlFence = false;
  for (let index = 0; index < 3; index += 1) {
    const unwrapped = stripOuterCodeFence(normalized);
    hadHtmlFence = hadHtmlFence || unwrapped.htmlHint;
    if (unwrapped.value === normalized) break;
    normalized = unwrapped.value;
  }

  return (hadHtmlFence && containsHtmlMarkup(normalized)) || containsHtmlMarkup(normalized);
}
