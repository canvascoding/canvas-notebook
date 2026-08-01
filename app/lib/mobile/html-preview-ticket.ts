import 'server-only';

import { randomBytes } from 'node:crypto';

import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export const MOBILE_HTML_PREVIEW_TICKET_TTL_MS = 30 * 60 * 1_000;
const MAX_TICKETS_PER_SESSION = 6;

type MobileHtmlPreviewTicketIdentity = {
  userId: string;
  sessionId: string;
  rootHtmlPath: string;
  workspace: WorkspaceContext;
};

type StoredMobileHtmlPreviewTicket = MobileHtmlPreviewTicketIdentity & {
  expiresAt: number;
};

type MobileHtmlPreviewTicketStore = Map<string, StoredMobileHtmlPreviewTicket>;

const globalTicketStore = globalThis as typeof globalThis & {
  __canvasMobileHtmlPreviewTickets?: MobileHtmlPreviewTicketStore;
};

function ticketStore(): MobileHtmlPreviewTicketStore {
  globalTicketStore.__canvasMobileHtmlPreviewTickets ??= new Map();
  return globalTicketStore.__canvasMobileHtmlPreviewTickets;
}

function removeExpiredTickets(now = Date.now()): void {
  for (const [ticket, record] of ticketStore()) {
    if (record.expiresAt <= now) ticketStore().delete(ticket);
  }
}

export function issueMobileHtmlPreviewTicket(
  identity: MobileHtmlPreviewTicketIdentity,
  now = Date.now(),
): { ticket: string; expiresAt: string } {
  removeExpiredTickets(now);
  const existingForSession = [...ticketStore().entries()]
    .filter(([, record]) => record.sessionId === identity.sessionId)
    .sort((left, right) => left[1].expiresAt - right[1].expiresAt);
  const excessTicketCount = Math.max(0, existingForSession.length - MAX_TICKETS_PER_SESSION + 1);
  for (const [ticket] of existingForSession.slice(0, excessTicketCount)) {
    ticketStore().delete(ticket);
  }

  const ticket = randomBytes(32).toString('base64url');
  const expiresAt = now + MOBILE_HTML_PREVIEW_TICKET_TTL_MS;
  ticketStore().set(ticket, { ...identity, expiresAt });
  return { ticket, expiresAt: new Date(expiresAt).toISOString() };
}

export function resolveMobileHtmlPreviewTicket(
  ticket: string,
  now = Date.now(),
): MobileHtmlPreviewTicketIdentity | null {
  removeExpiredTickets(now);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(ticket)) return null;
  const record = ticketStore().get(ticket);
  if (!record || record.expiresAt <= now) return null;
  const { expiresAt: _expiresAt, ...identity } = record;
  return identity;
}

function encodePathSegments(filePath: string): string {
  return filePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

export function mobileHtmlPreviewPath(ticket: string, filePath: string): string {
  return `/api/mobile/v1/files/html-preview/${encodeURIComponent(ticket)}/${encodePathSegments(filePath)}`;
}
