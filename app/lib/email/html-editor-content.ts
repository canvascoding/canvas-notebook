import DOMPurify from 'dompurify';

import { htmlToPlainText, plainTextToEmailHtml } from '@/app/lib/email/html-conversion';
import { isLikelyHtmlEmailContent, normalizeEmailHtmlContent } from '@/app/lib/email/html-content';

const EMAIL_EDITOR_ALLOWED_TAGS = ['a', 'blockquote', 'br', 'em', 'i', 'li', 'ol', 'p', 's', 'strong', 'b', 'ul'];
const EMAIL_EDITOR_ALLOWED_ATTRS = ['href', 'rel', 'target'];
const EMAIL_EDITOR_ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):)/iu;

export type EmailEditorBodyValues = {
  body: string;
  bodyHtml: string;
};

export function sanitizeEmailEditorHtml(value: string): string {
  const normalized = normalizeEmailHtmlContent(value);
  if (!normalized) return '';

  return DOMPurify.sanitize(normalized, {
    ALLOWED_ATTR: EMAIL_EDITOR_ALLOWED_ATTRS,
    ALLOWED_TAGS: EMAIL_EDITOR_ALLOWED_TAGS,
    ALLOWED_URI_REGEXP: EMAIL_EDITOR_ALLOWED_URI_REGEXP,
  }).trim();
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
