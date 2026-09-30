import 'server-only';

import { Marked, Renderer, type Tokens } from 'canvas-markdown-parser';

import { escapeEmailHtml, htmlToPlainText } from '@/app/lib/email/html-conversion';
import { sanitizeServerEmailEditorHtml } from '@/app/lib/email/server-html-editor-content';

const renderer = new Renderer();
const defaultLink = renderer.link;

renderer.html = ({ text }: Tokens.HTML | Tokens.Tag) => escapeEmailHtml(text);
renderer.image = ({ text }: Tokens.Image) => escapeEmailHtml(text);
renderer.link = function renderEmailLink(token: Tokens.Link) {
  if (!/^(?:https?:|mailto:)/iu.test(token.href)) return this.parser.parseInline(token.tokens);
  return defaultLink.call(this, token);
};

const parser = new Marked({ breaks: true, gfm: true, renderer });

export function outboxBodyFromMarkdown(markdown: string) {
  const bodyHtml = sanitizeServerEmailEditorHtml(String(parser.parse(markdown.trim())));
  return { body: htmlToPlainText(bodyHtml), bodyHtml };
}
