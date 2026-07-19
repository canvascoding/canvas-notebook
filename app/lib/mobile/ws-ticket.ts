import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import type { ChatRequestContext } from '@/app/lib/chat/types';

export const MOBILE_CHAT_WEBSOCKET_PROTOCOL = 'canvas-chat-v1' as const;
const MOBILE_CHAT_TICKET_PREFIX = 'canvas-ticket.';
const MOBILE_CHAT_TICKET_TTL_MS = 30_000;
const MAX_TICKETS_PER_USER = 5;

export type MobileChatTicketIdentity = {
  userId: string;
  userEmail: string;
  userName: string;
  userRole: string | null;
  workspace: NonNullable<ChatRequestContext['workspace']>;
};

type StoredMobileChatTicket = MobileChatTicketIdentity & {
  expiresAt: number;
};

type MobileChatTicketStore = Map<string, StoredMobileChatTicket>;

const globalTicketStore = globalThis as typeof globalThis & {
  __canvasMobileChatTickets?: MobileChatTicketStore;
};

function ticketStore(): MobileChatTicketStore {
  globalTicketStore.__canvasMobileChatTickets ??= new Map();
  return globalTicketStore.__canvasMobileChatTickets;
}

function removeExpiredTickets(now = Date.now()): void {
  for (const [ticket, record] of ticketStore()) {
    if (record.expiresAt <= now) ticketStore().delete(ticket);
  }
}

function protocolHeader(headers: IncomingHttpHeaders): string {
  const value = headers['sec-websocket-protocol'];
  return Array.isArray(value) ? value.join(',') : value || '';
}

function requestedProtocols(headers: IncomingHttpHeaders): string[] {
  return protocolHeader(headers).split(',').map((value) => value.trim()).filter(Boolean);
}

export function mobileChatTicketFromHeaders(headers: IncomingHttpHeaders): string | null {
  const protocols = requestedProtocols(headers);
  if (!protocols.includes(MOBILE_CHAT_WEBSOCKET_PROTOCOL)) return null;
  const ticketProtocol = protocols
    .find((value) => value.startsWith(MOBILE_CHAT_TICKET_PREFIX));
  const ticket = ticketProtocol?.slice(MOBILE_CHAT_TICKET_PREFIX.length) || '';
  return /^[A-Za-z0-9_-]{43}$/u.test(ticket) ? ticket : null;
}

export function issueMobileChatTicket(identity: MobileChatTicketIdentity): {
  ticket: string;
  ticketProtocol: string;
  expiresAt: string;
} {
  const now = Date.now();
  removeExpiredTickets(now);

  const existingForUser = [...ticketStore().entries()]
    .filter(([, record]) => record.userId === identity.userId)
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  for (const [ticket] of existingForUser.slice(0, Math.max(0, existingForUser.length - MAX_TICKETS_PER_USER + 1))) {
    ticketStore().delete(ticket);
  }

  const ticket = randomBytes(32).toString('base64url');
  const expiresAt = now + MOBILE_CHAT_TICKET_TTL_MS;
  ticketStore().set(ticket, { ...identity, expiresAt });
  return {
    ticket,
    ticketProtocol: `${MOBILE_CHAT_TICKET_PREFIX}${ticket}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function hasPendingMobileChatTicket(headers: IncomingHttpHeaders): boolean {
  removeExpiredTickets();
  const ticket = mobileChatTicketFromHeaders(headers);
  return Boolean(ticket && ticketStore().has(ticket));
}

export function consumeMobileChatTicket(headers: IncomingHttpHeaders): MobileChatTicketIdentity | null {
  removeExpiredTickets();
  const ticket = mobileChatTicketFromHeaders(headers);
  if (!ticket) return null;
  const record = ticketStore().get(ticket);
  ticketStore().delete(ticket);
  if (!record || record.expiresAt <= Date.now()) return null;
  const { expiresAt: _expiresAt, ...identity } = record;
  return identity;
}
