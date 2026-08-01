import 'server-only';

import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import {
  COLLABORATION_SCHEMA_VERSION,
  type CollaborationTicketClaims,
} from '@/app/lib/collaboration/types';

export const MOBILE_COLLABORATION_WEBSOCKET_PROTOCOL = 'canvas-collaboration-mobile-v1' as const;
const MOBILE_COLLABORATION_TICKET_TTL_MS = 30_000;
const MAX_TICKETS_PER_USER = 5;

export type MobileCollaborationTicketIdentity = {
  claims: CollaborationTicketClaims;
  user: {
    id: string;
    name: string;
    email: string | null;
    role: string | null;
  };
};

type StoredMobileCollaborationTicket = MobileCollaborationTicketIdentity & {
  expiresAt: number;
};

type MobileCollaborationTicketStore = Map<string, StoredMobileCollaborationTicket>;

const globalTicketStore = globalThis as typeof globalThis & {
  __canvasMobileCollaborationTickets?: MobileCollaborationTicketStore;
};

function ticketStore(): MobileCollaborationTicketStore {
  globalTicketStore.__canvasMobileCollaborationTickets ??= new Map();
  return globalTicketStore.__canvasMobileCollaborationTickets;
}

function removeExpiredTickets(now = Date.now()): void {
  for (const [ticket, record] of ticketStore()) {
    if (record.expiresAt <= now) ticketStore().delete(ticket);
  }
}

export function issueMobileCollaborationTicket(input: {
  claims: Omit<CollaborationTicketClaims, 'schemaVersion' | 'issuedAt' | 'expiresAt'>;
  user: MobileCollaborationTicketIdentity['user'];
}, now = Date.now()): {
  token: string;
  claims: CollaborationTicketClaims;
  expiresAt: string;
} {
  removeExpiredTickets(now);
  const existingForUser = [...ticketStore().entries()]
    .filter(([, record]) => record.claims.userId === input.claims.userId)
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  for (
    const [ticket] of existingForUser.slice(
      0,
      Math.max(0, existingForUser.length - MAX_TICKETS_PER_USER + 1),
    )
  ) {
    ticketStore().delete(ticket);
  }

  const expiresAt = now + MOBILE_COLLABORATION_TICKET_TTL_MS;
  const claims: CollaborationTicketClaims = {
    ...input.claims,
    schemaVersion: COLLABORATION_SCHEMA_VERSION,
    issuedAt: now,
    expiresAt,
  };
  const token = randomBytes(32).toString('base64url');
  ticketStore().set(token, { claims, user: input.user, expiresAt });
  return { token, claims, expiresAt: new Date(expiresAt).toISOString() };
}

export function consumeMobileCollaborationTicket(
  token: string,
  now = Date.now(),
): MobileCollaborationTicketIdentity | null {
  removeExpiredTickets(now);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
  const record = ticketStore().get(token);
  ticketStore().delete(token);
  if (!record || record.expiresAt <= now) return null;
  return { claims: record.claims, user: record.user };
}

export function hasMobileCollaborationProtocol(headers: IncomingHttpHeaders): boolean {
  const raw = headers['sec-websocket-protocol'];
  const value = Array.isArray(raw) ? raw.join(',') : raw || '';
  return value
    .split(',')
    .map((protocol) => protocol.trim())
    .includes(MOBILE_COLLABORATION_WEBSOCKET_PROTOCOL);
}
