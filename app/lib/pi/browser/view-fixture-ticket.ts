import 'server-only';

import crypto from 'node:crypto';

const FIXTURE_TICKET_SCHEMA_VERSION = 1;
const FIXTURE_TICKET_TTL_MS = 5 * 60_000;

type BrowserFixtureTicketClaims = {
  schemaVersion: number;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  userId: string;
};

function ticketSecret(): string {
  const secret = process.env.CANVAS_BROWSER_VIEW_TICKET_SECRET?.trim()
    || process.env.CANVAS_COLLABORATION_TICKET_SECRET?.trim()
    || process.env.BETTER_AUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error('Browser fixture tickets require a 32-character Canvas or Better Auth secret.');
  }
  return secret;
}

function signature(payload: string): Buffer {
  return crypto.createHmac('sha256', ticketSecret()).update(`browser-fixture:${payload}`).digest();
}

function isClaims(value: unknown): value is BrowserFixtureTicketClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claims = value as Partial<BrowserFixtureTicketClaims>;
  return claims.schemaVersion === FIXTURE_TICKET_SCHEMA_VERSION
    && typeof claims.issuedAt === 'number'
    && typeof claims.expiresAt === 'number'
    && typeof claims.nonce === 'string'
    && claims.nonce.length >= 16
    && typeof claims.userId === 'string'
    && claims.userId.length > 0;
}

export function issueBrowserFixtureTicket(userId: string, now = Date.now()): string {
  const claims: BrowserFixtureTicketClaims = {
    schemaVersion: FIXTURE_TICKET_SCHEMA_VERSION,
    issuedAt: now,
    expiresAt: now + FIXTURE_TICKET_TTL_MS,
    nonce: crypto.randomUUID(),
    userId,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${signature(payload).toString('base64url')}`;
}

export function verifyBrowserFixtureTicket(token: string, now = Date.now()): BrowserFixtureTicketClaims {
  const [payload, encodedSignature, extra] = token.split('.');
  if (!payload || !encodedSignature || extra) throw new Error('Invalid browser fixture ticket.');

  const expected = signature(payload);
  const actual = Buffer.from(encodedSignature, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('Invalid browser fixture ticket signature.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid browser fixture ticket payload.');
  }
  if (!isClaims(parsed)) throw new Error('Unsupported browser fixture ticket schema.');
  if (parsed.issuedAt > now + 10_000 || parsed.expiresAt <= now) {
    throw new Error('Browser fixture ticket expired.');
  }
  return parsed;
}
