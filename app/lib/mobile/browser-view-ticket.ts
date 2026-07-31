import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const MOBILE_BROWSER_WEBSOCKET_PROTOCOL = 'canvas-browser-v1' as const;
const MOBILE_BROWSER_TICKET_PREFIX = 'canvas-browser-ticket.';
const MOBILE_BROWSER_TICKET_TTL_MS = 30_000;
const MAX_TICKETS_PER_USER = 5;

export type MobileBrowserViewTicketIdentity = {
  userId: string;
  authSessionId: string;
  agentId: string;
  agentSessionId: string;
  workspaceId: string;
  workspaceType: string;
  organizationId: string | null;
};

type StoredMobileBrowserViewTicket = MobileBrowserViewTicketIdentity & {
  expiresAt: number;
};

type MobileBrowserViewTicketStore = Map<string, StoredMobileBrowserViewTicket>;

const globalTicketStore = globalThis as typeof globalThis & {
  __canvasMobileBrowserViewTickets?: MobileBrowserViewTicketStore;
};

function ticketStore(): MobileBrowserViewTicketStore {
  globalTicketStore.__canvasMobileBrowserViewTickets ??= new Map();
  return globalTicketStore.__canvasMobileBrowserViewTickets;
}

function removeExpiredTickets(now = Date.now()): void {
  for (const [ticket, record] of ticketStore()) {
    if (record.expiresAt <= now) ticketStore().delete(ticket);
  }
}

function requestedProtocols(headers: IncomingHttpHeaders): string[] {
  const value = headers['sec-websocket-protocol'];
  const header = Array.isArray(value) ? value.join(',') : value || '';
  return header.split(',').map((protocol) => protocol.trim()).filter(Boolean);
}

export function mobileBrowserViewTicketFromHeaders(headers: IncomingHttpHeaders): string | null {
  const protocols = requestedProtocols(headers);
  if (!protocols.includes(MOBILE_BROWSER_WEBSOCKET_PROTOCOL)) return null;
  const ticketProtocol = protocols.find((protocol) => protocol.startsWith(MOBILE_BROWSER_TICKET_PREFIX));
  const ticket = ticketProtocol?.slice(MOBILE_BROWSER_TICKET_PREFIX.length) || '';
  return /^[A-Za-z0-9_-]{43}$/u.test(ticket) ? ticket : null;
}

export function issueMobileBrowserViewTicket(
  identity: MobileBrowserViewTicketIdentity,
  now = Date.now(),
): {
  ticketProtocol: string;
  expiresAt: string;
} {
  removeExpiredTickets(now);
  const existingForUser = [...ticketStore().entries()]
    .filter(([, record]) => record.userId === identity.userId)
    .sort((left, right) => left[1].expiresAt - right[1].expiresAt);
  for (const [ticket] of existingForUser.slice(0, Math.max(0, existingForUser.length - MAX_TICKETS_PER_USER + 1))) {
    ticketStore().delete(ticket);
  }

  const ticket = randomBytes(32).toString('base64url');
  const expiresAt = now + MOBILE_BROWSER_TICKET_TTL_MS;
  ticketStore().set(ticket, { ...identity, expiresAt });
  return {
    ticketProtocol: `${MOBILE_BROWSER_TICKET_PREFIX}${ticket}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function hasPendingMobileBrowserViewTicket(
  headers: IncomingHttpHeaders,
  now = Date.now(),
): boolean {
  removeExpiredTickets(now);
  const ticket = mobileBrowserViewTicketFromHeaders(headers);
  return Boolean(ticket && ticketStore().has(ticket));
}

export function consumeMobileBrowserViewTicket(
  headers: IncomingHttpHeaders,
  now = Date.now(),
): MobileBrowserViewTicketIdentity | null {
  removeExpiredTickets(now);
  const ticket = mobileBrowserViewTicketFromHeaders(headers);
  if (!ticket) return null;
  const record = ticketStore().get(ticket);
  ticketStore().delete(ticket);
  if (!record || record.expiresAt <= now) return null;
  const { expiresAt: _expiresAt, ...identity } = record;
  return identity;
}
