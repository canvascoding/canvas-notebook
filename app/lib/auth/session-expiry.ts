'use client';

import { authClient } from '@/app/lib/auth-client';
import {
  invalidateOpenedDocumentAuth,
  isOpenedDocumentAuthCurrent,
  openedDocumentAuthScope,
  subscribeOpenedDocumentAuthInvalidation,
  type OpenedDocumentAuthScope,
} from '@/app/lib/collaboration/opened-document-registry';
import { routing } from '@/i18n/routing';

export type SessionExpirySnapshot = Readonly<{
  scope: OpenedDocumentAuthScope | null;
  sessionExpired: boolean;
}>;

let expiredSession: Pick<OpenedDocumentAuthScope, 'userId' | 'sessionId'> | null = null;
let lastValidatedSession: Pick<OpenedDocumentAuthScope, 'userId' | 'sessionId'> | null = null;
let redirectRequested = false;
let snapshot: SessionExpirySnapshot = { scope: null, sessionExpired: false };
const listeners = new Set<() => void>();
const serverSnapshot: SessionExpirySnapshot = { scope: null, sessionExpired: false };
const authSession = authClient.$store.atoms.session;

function validatedSessionIdentity(value: ReturnType<typeof authSession.get>) {
  const scope = openedDocumentAuthScope();
  return !value.isPending && !value.error && scope
    && value.data?.user.id === scope.userId && value.data.session.id === scope.sessionId
    ? { userId: scope.userId, sessionId: scope.sessionId }
    : null;
}

export class SessionExpiredError extends Error {
  readonly status = 401;
  readonly code = 'SESSION_EXPIRED';
  constructor() { super('Your session has expired.'); this.name = 'SessionExpiredError'; }
}

export class StaleSessionResponseError extends Error {
  readonly code = 'SESSION_RESPONSE_SUPERSEDED';
  constructor() { super('This response belongs to an earlier session.'); this.name = 'StaleSessionResponseError'; }
}

/** The expiry latch survives invalidation of the same identity and pending/null auth observations. */
export function getSessionExpirySnapshot(): SessionExpirySnapshot {
  const scope = openedDocumentAuthScope();
  const validated = validatedSessionIdentity(authSession.get());
  if (validated) lastValidatedSession = validated;
  const sessionExpired = expiredSession !== null;
  if (snapshot.scope !== scope || snapshot.sessionExpired !== sessionExpired) {
    snapshot = { scope, sessionExpired };
  }
  return snapshot;
}

export function getServerSessionExpirySnapshot(): SessionExpirySnapshot { return serverSnapshot; }

export function subscribeSessionExpiry(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function publishSessionExpiry() {
  getSessionExpirySnapshot();
  for (const listener of listeners) listener();
}

subscribeOpenedDocumentAuthInvalidation(publishSessionExpiry);

export function isPublicSessionRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  const locale = routing.locales.find(value => pathname === `/${value}` || pathname.startsWith(`/${value}/`));
  const path = locale ? pathname.slice(locale.length + 1) || '/' : pathname;
  return ['/login', '/sign-in', '/sign-up', '/setup'].some(value => path === value || path.startsWith(`${value}/`))
    || path === '/invite/team' || path === '/oauth/consent';
}

function localizedLoginPath(): string {
  const pathname = window.location.pathname;
  const locale = routing.locales.find(value => pathname === `/${value}` || pathname.startsWith(`/${value}/`))
    ?? routing.locales.find(value => typeof document !== 'undefined' && document.documentElement.lang === value)
    ?? routing.defaultLocale;
  return `/${locale}/login`;
}

export function redirectExpiredSession(): void {
  if (!expiredSession || redirectRequested || typeof window === 'undefined' || isPublicSessionRoute(window.location.pathname)) return;
  redirectRequested = true;
  try { window.location.replace(localizedLoginPath()); } catch { /* Private UI remains hidden if navigation is unavailable. */ }
}

function observeAuthSessionExpiry(value: ReturnType<typeof authSession.get>): void {
  // A queued observation must never expire or reset a newer session atom value.
  if (value !== authSession.get()) return;
  const validated = validatedSessionIdentity(value);
  if (validated) {
    lastValidatedSession = validated;
    if (expiredSession && (validated.userId !== expiredSession.userId || validated.sessionId !== expiredSession.sessionId)) {
      expiredSession = null;
      redirectRequested = false;
    }
  } else if (!value.isPending && value.data === null && lastValidatedSession
    && (!value.error || value.error.status === 401) && !expiredSession) {
    // A settled get-session result is authoritative absence, even when it beat the next application request.
    // The existing auth observer already invalidated the registry and its private cache chain.
    expiredSession = lastValidatedSession;
    publishSessionExpiry();
    redirectExpiredSession();
    return;
  }
  publishSessionExpiry();
}

authSession.listen(observeAuthSessionExpiry);
observeAuthSessionExpiry(authSession.get());

/** Only a definitive 401 for the exact still-current request scope may expire private UI. */
export function reportSessionExpiry(requestScope: OpenedDocumentAuthScope | null): boolean {
  if (!isOpenedDocumentAuthCurrent(requestScope) || getSessionExpirySnapshot().sessionExpired) return false;
  expiredSession = { userId: requestScope!.userId, sessionId: requestScope!.sessionId };
  publishSessionExpiry();
  // This existing signal invalidates document receipts, persisted chat and QueryClient caches,
  // and requests BetterAuth's normal session refetch. Do not create a parallel auth cache.
  try { authClient.$store.notify('$sessionSignal'); } catch { /* The synchronous local fence still applies. */ }
  if (openedDocumentAuthScope() === requestScope) invalidateOpenedDocumentAuth();
  redirectExpiredSession();
  return true;
}

/** Check before a request and again after every awaited response/body boundary. */
export function assertSessionRequestCurrent(scope: OpenedDocumentAuthScope | null, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (scope !== openedDocumentAuthScope()) throw new StaleSessionResponseError();
  if (getSessionExpirySnapshot().sessionExpired) throw new SessionExpiredError();
}

export function assertSessionResponseCurrent(
  response: Pick<Response, 'status'>,
  scope: OpenedDocumentAuthScope | null,
  signal?: AbortSignal,
): void {
  assertSessionRequestCurrent(scope, signal);
  if (response.status === 401 && reportSessionExpiry(scope)) throw new SessionExpiredError();
}
