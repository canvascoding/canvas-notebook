import 'server-only';

import { Lexer, type Token, type Tokens } from 'marked';

const DEFAULT_CHAT_TITLE = 'Canvas Chat';
const DEFAULT_CHAT_BODY = 'Your agent has finished a response.';
const MAX_NOTIFICATION_TITLE_LENGTH = 72;
const MAX_NOTIFICATION_BODY_LENGTH = 220;

export type MobilePushNotificationPreview = {
  title: string;
  body: string;
  imageUrl?: string;
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/gu, (match, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    })
    .replace(/&#x([\da-f]+);/giu, (match, hexadecimal: string) => {
      const codePoint = Number.parseInt(hexadecimal, 16);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    })
    .replace(/&(amp|apos|gt|lt|nbsp|quot);/giu, (match, name: string) => {
      const entities: Record<string, string> = {
        amp: '&',
        apos: "'",
        gt: '>',
        lt: '<',
        nbsp: ' ',
        quot: '"',
      };
      return entities[name.toLowerCase()] ?? match;
    });
}

function plainHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/gu, ''));
}

function renderInline(tokens: Token[]): string {
  return tokens.map(renderInlineToken).join('');
}

function renderInlineToken(token: Token): string {
  switch (token.type) {
    case 'br':
      return ' ';
    case 'codespan':
    case 'escape':
      return decodeHtmlEntities((token as Tokens.Codespan | Tokens.Escape).text);
    case 'html':
      return plainHtml((token as Tokens.HTML | Tokens.Tag).text);
    case 'image': {
      const image = token as Tokens.Image;
      return renderInline(image.tokens).trim() || decodeHtmlEntities(image.text);
    }
    case 'link': {
      const link = token as Tokens.Link;
      return renderInline(link.tokens).trim() || decodeHtmlEntities(link.text);
    }
    case 'del':
    case 'em':
    case 'strong':
      return renderInline((token as Tokens.Del | Tokens.Em | Tokens.Strong).tokens);
    case 'text': {
      const text = token as Tokens.Text;
      return text.tokens?.length ? renderInline(text.tokens) : decodeHtmlEntities(text.text);
    }
    default: {
      const generic = token as Tokens.Generic;
      return generic.tokens?.length ? renderInline(generic.tokens) : plainHtml(generic.raw);
    }
  }
}

function renderBlockToken(token: Token): string {
  switch (token.type) {
    case 'blockquote':
      return renderBlocks((token as Tokens.Blockquote).tokens);
    case 'code':
      return decodeHtmlEntities((token as Tokens.Code).text);
    case 'def':
    case 'hr':
    case 'space':
      return '';
    case 'heading':
    case 'paragraph':
      return renderInline((token as Tokens.Heading | Tokens.Paragraph).tokens);
    case 'html':
      return plainHtml((token as Tokens.HTML | Tokens.Tag).text);
    case 'list':
      return (token as Tokens.List).items
        .map((item) => renderBlocks(item.tokens))
        .filter(Boolean)
        .join(' ');
    case 'table': {
      const table = token as Tokens.Table;
      return [table.header, ...table.rows]
        .flatMap((row) => row.map((cell) => renderInline(cell.tokens)))
        .filter(Boolean)
        .join(' ');
    }
    default:
      return renderInlineToken(token);
  }
}

function renderBlocks(tokens: Token[]): string {
  return tokens.map(renderBlockToken).filter(Boolean).join(' ');
}

function normalizePreviewText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function truncatePreviewText(value: string, maximumLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maximumLength) return value;
  return `${characters.slice(0, Math.max(0, maximumLength - 1)).join('').trimEnd()}…`;
}

export function markdownToNotificationText(markdown: string): string {
  try {
    return normalizePreviewText(renderBlocks(Lexer.lex(markdown, { gfm: true })));
  } catch {
    return normalizePreviewText(plainHtml(markdown));
  }
}

export function extractPersistedAssistantMarkdown(serializedMessage: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedMessage);
  } catch {
    return '';
  }
  if (typeof parsed === 'string') return parsed;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  const content = (parsed as Record<string, unknown>).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return '';
      const record = part as Record<string, unknown>;
      return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function createAgentResponseNotificationPreview(input: {
  sessionTitle: string | null;
  serializedMessage: string;
}): MobilePushNotificationPreview {
  const title = markdownToNotificationText(input.sessionTitle || '');
  const body = markdownToNotificationText(extractPersistedAssistantMarkdown(input.serializedMessage));
  return {
    title: truncatePreviewText(title || DEFAULT_CHAT_TITLE, MAX_NOTIFICATION_TITLE_LENGTH),
    body: truncatePreviewText(body || DEFAULT_CHAT_BODY, MAX_NOTIFICATION_BODY_LENGTH),
  };
}
