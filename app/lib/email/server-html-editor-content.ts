import 'server-only';

import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

import { sanitizeEmailEditorHtmlWithSanitizer } from '@/app/lib/email/html-editor-content';

type DOMPurifyWindow = Parameters<typeof createDOMPurify>[0];

const serverPurifierWindow = new JSDOM('').window as unknown as DOMPurifyWindow;
const serverEmailPurifier = createDOMPurify(serverPurifierWindow);

export function sanitizeServerEmailEditorHtml(value: string): string {
  return sanitizeEmailEditorHtmlWithSanitizer(value, serverEmailPurifier);
}
