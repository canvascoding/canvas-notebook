import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

import { Lexer, type Token, type Tokens } from 'marked';

const DEFAULT_CHAT_TITLE = 'Canvas Chat';
const DEFAULT_CHAT_BODY = 'Your agent has finished a response.';
const MAX_NOTIFICATION_TITLE_LENGTH = 72;
const MAX_NOTIFICATION_BODY_LENGTH = 220;
export const STUDIO_PUSH_PREVIEW_TTL_SECONDS = 60 * 60;
const STUDIO_PUSH_PREVIEW_SCHEMA_VERSION = 1;

type StudioPushPreviewClaims = {
  schemaVersion: typeof STUDIO_PUSH_PREVIEW_SCHEMA_VERSION;
  outputId: string;
  issuedAt: number;
  expiresAt: number;
};

export type MobilePushNotificationPreview = {
  title: string;
  body: string;
  imageUrl?: string;
};

function pushPreviewSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim()
    || (process.env.NODE_ENV !== 'production' ? 'canvas-notebook-local-dev-secret-change-me' : '');
  if (secret.length < 32) {
    throw new Error('Studio notification previews require a 32-character Better Auth secret.');
  }
  return secret;
}

function studioPreviewSignature(payload: string): Buffer {
  return createHmac('sha256', pushPreviewSecret())
    .update(`studio-push-preview:${payload}`)
    .digest();
}

function isStudioPushPreviewClaims(value: unknown): value is StudioPushPreviewClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claims = value as Partial<StudioPushPreviewClaims>;
  return claims.schemaVersion === STUDIO_PUSH_PREVIEW_SCHEMA_VERSION
    && typeof claims.outputId === 'string'
    && Boolean(claims.outputId.trim())
    && claims.outputId.length <= 180
    && typeof claims.issuedAt === 'number'
    && Number.isSafeInteger(claims.issuedAt)
    && typeof claims.expiresAt === 'number'
    && Number.isSafeInteger(claims.expiresAt);
}

function configuredPushPreviewOrigin(baseUrl?: string): string | null {
  const candidate = baseUrl?.trim()
    || process.env.BETTER_AUTH_BASE_URL?.trim()
    || process.env.BASE_URL?.trim()
    || process.env.APP_BASE_URL?.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && parsed.protocol === 'http:')) {
      return null;
    }
    if (parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function issueStudioPushPreviewTicket(
  outputId: string,
  now = Date.now(),
): { token: string; claims: StudioPushPreviewClaims } {
  const normalizedOutputId = outputId.trim();
  if (!normalizedOutputId || normalizedOutputId.length > 180 || /[\u0000-\u001f\u007f]/u.test(normalizedOutputId)) {
    throw new Error('Studio notification preview output ID is invalid.');
  }
  const claims: StudioPushPreviewClaims = {
    schemaVersion: STUDIO_PUSH_PREVIEW_SCHEMA_VERSION,
    outputId: normalizedOutputId,
    issuedAt: now,
    expiresAt: now + STUDIO_PUSH_PREVIEW_TTL_SECONDS * 1_000,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return {
    token: `${payload}.${studioPreviewSignature(payload).toString('base64url')}`,
    claims,
  };
}

export function verifyStudioPushPreviewTicket(
  token: string,
  now = Date.now(),
): StudioPushPreviewClaims {
  const [payload, encodedSignature, extra] = token.split('.');
  if (!payload || !encodedSignature || extra) throw new Error('Invalid Studio notification preview ticket.');
  const expected = studioPreviewSignature(payload);
  let actual: Buffer;
  try {
    actual = Buffer.from(encodedSignature, 'base64url');
  } catch {
    throw new Error('Invalid Studio notification preview ticket.');
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('Invalid Studio notification preview ticket signature.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid Studio notification preview ticket payload.');
  }
  if (!isStudioPushPreviewClaims(parsed)) {
    throw new Error('Unsupported Studio notification preview ticket.');
  }
  if (parsed.issuedAt > now + 10_000 || parsed.expiresAt <= now) {
    throw new Error('Studio notification preview ticket expired.');
  }
  return parsed;
}

export function createStudioPushPreviewUrl(input: {
  outputId: string;
  baseUrl?: string;
  now?: number;
}): string | null {
  const origin = configuredPushPreviewOrigin(input.baseUrl);
  if (!origin) return null;
  try {
    const { token } = issueStudioPushPreviewTicket(input.outputId, input.now);
    return `${origin}/api/mobile/v1/push-previews/studio/${encodeURIComponent(token)}`;
  } catch {
    return null;
  }
}

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

export function createAutomationRunNotificationPreview(input: {
  jobName: string;
  status: 'success' | 'failed';
}): MobilePushNotificationPreview {
  const jobName = markdownToNotificationText(input.jobName);
  return {
    title: truncatePreviewText(jobName || 'Scheduled automation', MAX_NOTIFICATION_TITLE_LENGTH),
    body: input.status === 'success'
      ? 'Scheduled automation completed successfully.'
      : 'Scheduled automation failed. Open the run for details.',
  };
}
