'use client';

import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { authClient } from '@/app/lib/auth-client';
import {
  getServerSessionExpirySnapshot,
  getSessionExpirySnapshot,
  isPublicSessionRoute,
  redirectExpiredSession,
  subscribeSessionExpiry,
} from '@/app/lib/auth/session-expiry';

export function useAuthenticatedRequestScope() {
  const session = authClient.useSession();
  const state = useSyncExternalStore(subscribeSessionExpiry, getSessionExpirySnapshot, getServerSessionExpirySnapshot);
  const scope = state.scope;
  const active = !session.isPending && !state.sessionExpired && scope !== null
    && session.data?.user.id === scope.userId && session.data.session.id === scope.sessionId;
  return { scope, active, sessionExpired: state.sessionExpired };
}

/** Hide the entire private provider tree while a current-session expiry redirects. Public auth/invitation pages stay usable. */
export function AuthenticatedSessionBoundary({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { sessionExpired } = useAuthenticatedRequestScope();
  useEffect(() => {
    if (sessionExpired && !isPublicSessionRoute(pathname)) redirectExpiredSession();
  }, [pathname, sessionExpired]);
  return sessionExpired && !isPublicSessionRoute(pathname) ? null : children;
}
