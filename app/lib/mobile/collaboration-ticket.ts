import 'server-only';

import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { isCanonicalAdmissionPath } from '@/app/lib/collaboration/room-admission-contract';
import { disposeAuthenticatedNativeSessionTransport,
  type AuthenticatedNativeSessionTransport } from '@/app/lib/collaboration/authenticated-native-session-transport';

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
  /** Server-private ownership; never included in the HTTP response. */
  authenticatedTransport?: AuthenticatedNativeSessionTransport;
};

type StoredMobileCollaborationTicket = MobileCollaborationTicketIdentity & {
  expiresAt: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
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
    if (record.expiresAt <= now) discardTicket(ticket, record);
  }
}

function discardTicket(ticket: string, record: StoredMobileCollaborationTicket): void {
  if (ticketStore().get(ticket) !== record) return;
  ticketStore().delete(ticket);
  if (record.expiryTimer) clearTimeout(record.expiryTimer);
  if (record.authenticatedTransport) {
    // Disposal invalidates and clears credentials synchronously, then settles
    // in-flight work. No authentication data is included in cleanup logging.
    void disposeAuthenticatedNativeSessionTransport(record.authenticatedTransport)
      .catch(() => { console.error('[Collaboration] Mobile ticket cleanup failed.'); });
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
    const record = ticketStore().get(ticket);
    if (record) discardTicket(ticket, record);
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

/** Only the committed Session publisher may transfer its private transport.
 * Validate/copy all public fields and prepare the token before taking ownership.
 * Its rollback callback removes this exact record if publication later fails. */
export function issueAuthenticatedMobileCollaborationTicket(input: {
  claims: Omit<CollaborationTicketClaims, 'schemaVersion' | 'issuedAt' | 'expiresAt'>;
  user: MobileCollaborationTicketIdentity['user'];
  takeTransport: (rollbackAdoption: () => void | Promise<void>) => AuthenticatedNativeSessionTransport;
}): { token: string; claims: CollaborationTicketClaims; expiresAt: string } {
  const claimKeys = ['userId','sessionId','workspaceId','organizationId','documentId','path','provider',
    'representation','permission','lifecycleGeneration'];
  const plainData = (value: unknown, keys: readonly string[]) => !!value && typeof value === 'object'
    && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && Object.prototype.hasOwnProperty.call(descriptor, 'value');
    });
  const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
    && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
  if (!plainData(input, ['claims','user','takeTransport']) || !plainData(input.claims, claimKeys)
    || !plainData(input.user, ['id','name','email','role']) || typeof input.takeTransport !== 'function'
    || !['userId','sessionId','workspaceId','documentId'].every(key => validId(Reflect.get(input.claims,key)))
    || input.claims.organizationId !== null && !validId(input.claims.organizationId)
    || input.claims.provider !== 'yjs' || !['plain_text','tiptap_xml','tiptap_blocks'].includes(input.claims.representation)
    || !['read','write'].includes(input.claims.permission) || !isCanonicalAdmissionPath(input.claims.path)
    || !/\.(?:md|markdown|txt)$/iu.test(input.claims.path) || !Number.isSafeInteger(input.claims.lifecycleGeneration)
    || input.claims.lifecycleGeneration < 1 || input.user.id !== input.claims.userId
    || typeof input.user.name !== 'string' || input.user.name.length > 2048
    || input.user.email !== null && (typeof input.user.email !== 'string' || input.user.email.length > 2048)
    || input.user.role !== null && (typeof input.user.role !== 'string' || input.user.role.length > 256)) {
    throw new Error('Invalid authenticated mobile collaboration ticket.');
  }
  const now = Date.now();
  removeExpiredTickets(now);
  const expiresAt = now + MOBILE_COLLABORATION_TICKET_TTL_MS;
  const claims = Object.freeze({ ...input.claims, schemaVersion: COLLABORATION_SCHEMA_VERSION,
    issuedAt: now, expiresAt });
  const user = Object.freeze({ ...input.user });
  const token = randomBytes(32).toString('base64url');
  const record: StoredMobileCollaborationTicket = { claims, user, expiresAt };
  let cancelled = false;
  const transport = input.takeTransport(() => { cancelled = true; discardTicket(token,record); });
  record.authenticatedTransport = transport;
  try {
    if (cancelled) throw new Error('Mobile collaboration ticket transfer was cancelled.');
    ticketStore().set(token, record);
    record.expiryTimer = setTimeout(() => { discardTicket(token,record); }, MOBILE_COLLABORATION_TICKET_TTL_MS);
    record.expiryTimer.unref?.();
    const existing = [...ticketStore().entries()].filter(([, candidate]) => candidate.claims.userId === claims.userId);
    // Map insertion order makes eviction deterministic even within one clock tick.
    for (const [oldToken, oldRecord] of existing.slice(0, Math.max(0, existing.length - MAX_TICKETS_PER_USER))) {
      discardTicket(oldToken,oldRecord);
    }
  } catch (error) {
    if (ticketStore().get(token) === record) discardTicket(token,record);
    else void disposeAuthenticatedNativeSessionTransport(transport)
      .catch(() => { console.error('[Collaboration] Mobile ticket cleanup failed.'); });
    throw error;
  }
  return { token, claims, expiresAt: new Date(expiresAt).toISOString() };
}

/** Host shutdown owns only tickets still held by the store, never consumed peers. */
export function disposeMobileCollaborationTickets(): void {
  for (const [token,record] of ticketStore()) discardTicket(token,record);
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
  if (record.expiryTimer) clearTimeout(record.expiryTimer);
  return { claims: record.claims, user: record.user,
    ...(record.authenticatedTransport ? { authenticatedTransport: record.authenticatedTransport } : {}) };
}

export function hasMobileCollaborationProtocol(headers: IncomingHttpHeaders): boolean {
  const raw = headers['sec-websocket-protocol'];
  const value = Array.isArray(raw) ? raw.join(',') : raw || '';
  return value
    .split(',')
    .map((protocol) => protocol.trim())
    .includes(MOBILE_COLLABORATION_WEBSOCKET_PROTOCOL);
}
