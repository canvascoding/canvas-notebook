import 'server-only';

import crypto from 'node:crypto';

import type { BrowserInteractionPolicy } from './types';

export const BROWSER_VIEW_TICKET_SCHEMA_VERSION = 1;
export const BROWSER_VIEW_TICKET_TTL_MS = 90_000;

export type BrowserViewTicketClaims = {
  schemaVersion: number;
  issuedAt: number;
  expiresAt: number;
  viewId: string;
  userId: string;
  authSessionId: string;
  agentId: string;
  agentSessionId: string;
  workspaceId: string;
  workspaceType: string;
  organizationId: string | null;
  interactionPolicy?: BrowserInteractionPolicy;
};

function ticketSecret(): string {
  const secret = process.env.CANVAS_BROWSER_VIEW_TICKET_SECRET?.trim()
    || process.env.CANVAS_COLLABORATION_TICKET_SECRET?.trim()
    || process.env.BETTER_AUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error('Browser view tickets require a 32-character Canvas or Better Auth secret.');
  }
  return secret;
}

function signature(payload: string): Buffer {
  return crypto.createHmac('sha256', ticketSecret()).update(payload).digest();
}

function isClaims(value: unknown): value is BrowserViewTicketClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claims = value as Partial<BrowserViewTicketClaims>;
  return claims.schemaVersion === BROWSER_VIEW_TICKET_SCHEMA_VERSION
    && typeof claims.issuedAt === 'number'
    && typeof claims.expiresAt === 'number'
    && typeof claims.viewId === 'string'
    && typeof claims.userId === 'string'
    && typeof claims.authSessionId === 'string'
    && typeof claims.agentId === 'string'
    && typeof claims.agentSessionId === 'string'
    && typeof claims.workspaceId === 'string'
    && typeof claims.workspaceType === 'string'
    && (claims.organizationId === null || typeof claims.organizationId === 'string')
    && (
      claims.interactionPolicy === undefined
      || claims.interactionPolicy === 'exclusive'
      || claims.interactionPolicy === 'cooperative'
    );
}

export function issueBrowserViewTicket(
  input: Omit<BrowserViewTicketClaims, 'schemaVersion' | 'issuedAt' | 'expiresAt'>,
  now = Date.now(),
): { token: string; claims: BrowserViewTicketClaims } {
  const claims: BrowserViewTicketClaims = {
    ...input,
    schemaVersion: BROWSER_VIEW_TICKET_SCHEMA_VERSION,
    issuedAt: now,
    expiresAt: now + BROWSER_VIEW_TICKET_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { token: `${payload}.${signature(payload).toString('base64url')}`, claims };
}

export function verifyBrowserViewTicket(token: string, now = Date.now()): BrowserViewTicketClaims {
  const [payload, encodedSignature, extra] = token.split('.');
  if (!payload || !encodedSignature || extra) throw new Error('Invalid browser view ticket.');
  const expected = signature(payload);
  const actual = Buffer.from(encodedSignature, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('Invalid browser view ticket signature.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid browser view ticket payload.');
  }
  if (!isClaims(parsed)) throw new Error('Unsupported browser view ticket schema.');
  if (parsed.issuedAt > now + 10_000 || parsed.expiresAt <= now) {
    throw new Error('Browser view ticket expired.');
  }
  return parsed;
}
