import 'server-only';

import crypto from 'node:crypto';

import {
  COLLABORATION_SCHEMA_VERSION,
  COLLABORATION_TICKET_TTL_MS,
  type CollaborationTicketClaims,
} from './types';

function ticketSecret(): string {
  const secret = process.env.CANVAS_COLLABORATION_TICKET_SECRET?.trim()
    || process.env.BETTER_AUTH_SECRET?.trim()
    || process.env.AUTH_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error('Collaboration tickets require CANVAS_COLLABORATION_TICKET_SECRET or a 32-character Better Auth secret.');
  }
  return secret;
}

function signature(payload: string): Buffer {
  return crypto.createHmac('sha256', ticketSecret()).update(payload).digest();
}

function isClaims(value: unknown): value is CollaborationTicketClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claims = value as Partial<CollaborationTicketClaims>;
  return claims.schemaVersion === COLLABORATION_SCHEMA_VERSION
    && typeof claims.issuedAt === 'number'
    && typeof claims.expiresAt === 'number'
    && typeof claims.userId === 'string'
    && typeof claims.sessionId === 'string'
    && typeof claims.workspaceId === 'string'
    && (claims.organizationId === null || typeof claims.organizationId === 'string')
    && typeof claims.documentId === 'string'
    && typeof claims.path === 'string'
    && (claims.representation === 'plain_text' || claims.representation === 'tiptap_xml')
    && (claims.permission === 'read' || claims.permission === 'write')
    && typeof claims.lifecycleGeneration === 'number';
}

export function issueCollaborationTicket(
  input: Omit<CollaborationTicketClaims, 'schemaVersion' | 'issuedAt' | 'expiresAt'>,
  now = Date.now(),
): { token: string; claims: CollaborationTicketClaims } {
  const claims: CollaborationTicketClaims = {
    ...input,
    schemaVersion: COLLABORATION_SCHEMA_VERSION,
    issuedAt: now,
    expiresAt: now + COLLABORATION_TICKET_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return {
    token: `${payload}.${signature(payload).toString('base64url')}`,
    claims,
  };
}

export function verifyCollaborationTicket(token: string, now = Date.now()): CollaborationTicketClaims {
  const [payload, encodedSignature, extra] = token.split('.');
  if (!payload || !encodedSignature || extra) throw new Error('Invalid collaboration ticket.');
  const expected = signature(payload);
  let actual: Buffer;
  try {
    actual = Buffer.from(encodedSignature, 'base64url');
  } catch {
    throw new Error('Invalid collaboration ticket.');
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('Invalid collaboration ticket signature.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid collaboration ticket payload.');
  }
  if (!isClaims(parsed)) throw new Error('Unsupported collaboration ticket schema.');
  if (parsed.issuedAt > now + 10_000 || parsed.expiresAt <= now) {
    throw new Error('Collaboration ticket expired.');
  }
  return parsed;
}
