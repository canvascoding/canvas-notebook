import DOMPurify from 'dompurify';

import { htmlToPlainText, plainTextToEmailHtml } from '@/app/lib/email/html-conversion';
import { isLikelyHtmlEmailContent, normalizeEmailHtmlContent } from '@/app/lib/email/html-content';

const EMAIL_EDITOR_ALLOWED_TAGS = [
  'a',
  'blockquote',
  'br',
  'em',
  'i',
  'img',
  'li',
  'ol',
  'p',
  's',
  'strong',
  'b',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
];
const EMAIL_EDITOR_ALLOWED_ATTRS = [
  'align',
  'border',
  'cellpadding',
  'cellspacing',
  'colspan',
  'href',
  'height',
  'rel',
  'rowspan',
  'scope',
  'src',
  'target',
  'title',
  'width',
];
const EMAIL_EDITOR_ALLOWED_HREF_REGEXP = /^(?:https?:|mailto:)/iu;
const EMAIL_EDITOR_ALLOWED_IMG_SRC_REGEXP = /^(?:cid:[^\s"'<>]+|https?:\/\/)/iu;

export type EmailEditorBodyValues = {
  body: string;
  bodyHtml: string;
};

type EmailDomPurify = {
  sanitize: (value: string, config: Record<string, unknown>) => string;
};

type EmailDomPurifyFactory = ((window: Window) => EmailDomPurify) & Partial<EmailDomPurify>;

export function sanitizeEmailEditorHtml(value: string): string {
  const normalized = normalizeEmailHtmlContent(value);
  if (!normalized) return '';

  const sanitized = getEmailDomPurify().sanitize(normalizeEmailTableCellAlignment(normalized), {
    ALLOWED_ATTR: EMAIL_EDITOR_ALLOWED_ATTRS,
    ALLOWED_TAGS: EMAIL_EDITOR_ALLOWED_TAGS,
  });

  return sanitizeEmailEditorImages(sanitizeEmailEditorLinks(sanitized)).trim();
}

export function emailEditorHtmlToText(html: string): string {
  return htmlToPlainText(html);
}

export function composeEmailEditorBodyValues(value: string, fallbackText = ''): EmailEditorBodyValues {
  const normalized = normalizeEmailHtmlContent(value);
  if (isLikelyHtmlEmailContent(normalized)) {
    const bodyHtml = sanitizeEmailEditorHtml(normalized);
    return {
      body: fallbackText.trim() || emailEditorHtmlToText(bodyHtml),
      bodyHtml,
    };
  }

  const body = fallbackText.trim() || value.trim();
  return {
    body,
    bodyHtml: plainTextToEmailHtml(body),
  };
}

export function composeEmailEditorBodyValuesFromAiResult(body: string, bodyHtml: string): EmailEditorBodyValues {
  if (bodyHtml.trim()) {
    return composeEmailEditorBodyValues(bodyHtml, body);
  }
  return composeEmailEditorBodyValues(body);
}

function normalizeEmailTableCellAlignment(value: string): string {
  return value.replace(/<(td|th)(\s[^>]*)?>/giu, (match, tag: string, rawAttrs = '') => {
    const styleMatch = rawAttrs.match(/\sstyle\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/iu);
    if (!styleMatch) return match;

    const styleValue = styleMatch[2] ?? styleMatch[3] ?? styleMatch[4] ?? '';
    const align = styleValue.match(/(?:^|;)\s*text-align\s*:\s*(left|center|right)\b/iu)?.[1]?.toLowerCase();
    const attrsWithoutStyle = rawAttrs.replace(styleMatch[0], '');
    if (!align) return `<${tag}${attrsWithoutStyle}>`;

    const attrsWithoutAlign = attrsWithoutStyle.replace(
      /\salign\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/iu,
      '',
    );

    return `<${tag}${attrsWithoutAlign} align="${align}">`;
  });
}

function sanitizeEmailEditorLinks(value: string): string {
  return value.replace(/<a\b([^>]*)>/giu, (match, rawAttrs: string) => {
    const hrefMatch = rawAttrs.match(/\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/iu);
    if (!hrefMatch) return match;

    const hrefValue = (hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4] ?? '').trim();
    if (EMAIL_EDITOR_ALLOWED_HREF_REGEXP.test(hrefValue)) return match;

    return `<a${rawAttrs.replace(hrefMatch[0], '')}>`;
  });
}

function sanitizeEmailEditorImages(value: string): string {
  return value.replace(/<img\b([^>]*)>/giu, (match, rawAttrs: string) => {
    const srcMatch = rawAttrs.match(/\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/iu);
    if (!srcMatch) return '';

    const srcValue = (srcMatch[2] ?? srcMatch[3] ?? srcMatch[4] ?? '').trim();
    if (EMAIL_EDITOR_ALLOWED_IMG_SRC_REGEXP.test(srcValue)) return match;

    return '';
  });
}

function getEmailDomPurify(): EmailDomPurify {
  const purifier = DOMPurify as unknown as EmailDomPurifyFactory;
  if (typeof window !== 'undefined' && typeof purifier === 'function') return purifier(window);
  if (typeof purifier.sanitize === 'function') return purifier as EmailDomPurify;
  throw new Error('DOMPurify requires a DOM window.');
}
