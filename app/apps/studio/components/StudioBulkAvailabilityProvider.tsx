'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { authClient } from '@/app/lib/auth-client';
import { LiveEventSource } from '@/app/lib/live-events/client';
import type { StudioBulkAvailability } from '@/app/lib/studio-bulk-availability';

type BulkAvailabilityContext = StudioBulkAvailability & {
  ready: boolean;
  error: boolean;
  applyAvailability: (state: StudioBulkAvailability) => void;
};

export const StudioBulkAvailabilityContext = createContext<BulkAvailabilityContext>({
  studioBulkEnabled: false,
  updatedAt: null,
  ready: false,
  error: false,
  applyAvailability: () => {},
});

export function StudioBulkAvailabilityProvider({ children }: { children: ReactNode }) {
  const { data: session } = authClient.useSession();
  const userId = session?.user.id ?? null;
  const [snapshot, setSnapshot] = useState({
    userId: null as string | null,
    studioBulkEnabled: false,
    updatedAt: null as string | null,
    latestUpdatedAt: null as string | null,
    ready: false,
    error: false,
  });
  const applyAvailability = useCallback((state: StudioBulkAvailability) => {
    setSnapshot(previous => {
      const latestUpdatedAt = previous.userId === userId ? previous.latestUpdatedAt : null;
      // Missing preferences revoke availability without a revision. Retain the
      // watermark so a delayed enable from before that revocation stays hidden.
      if (latestUpdatedAt && (state.updatedAt
        ? Date.parse(state.updatedAt) < Date.parse(latestUpdatedAt)
          || (!previous.updatedAt && state.studioBulkEnabled
            && Date.parse(state.updatedAt) === Date.parse(latestUpdatedAt))
        : state.studioBulkEnabled)) return previous;
      return { userId, studioBulkEnabled: state.studioBulkEnabled === true,
        updatedAt: state.updatedAt, latestUpdatedAt: state.updatedAt ?? latestUpdatedAt,
        ready: true, error: false };
    });
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    let disposed = false;
    const markUnavailable = () => {
      if (!disposed) setSnapshot(previous => ({
        ...previous, userId,
        studioBulkEnabled: previous.userId === userId && previous.studioBulkEnabled,
        updatedAt: previous.userId === userId ? previous.updatedAt : null,
        latestUpdatedAt: previous.userId === userId ? previous.latestUpdatedAt : null,
        ready: false, error: true,
      }));
    };
    const source = new LiveEventSource('/api/studio/bulk/availability?stream=1');
    source.onmessage = event => {
      if (disposed) return;
      try {
        const state = JSON.parse(event.data) as StudioBulkAvailability;
        if (typeof state.studioBulkEnabled !== 'boolean'
          || (state.updatedAt !== null && (typeof state.updatedAt !== 'string'
            || !Number.isFinite(Date.parse(state.updatedAt))))) {
          throw new Error('Invalid Studio bulk availability');
        }
        applyAvailability(state);
      } catch {
        markUnavailable();
      }
    };
    source.onerror = markUnavailable;
    return () => { disposed = true; source.close(); };
  }, [applyAvailability, userId]);

  const ready = Boolean(userId && snapshot.userId === userId && snapshot.ready);
  return <StudioBulkAvailabilityContext.Provider value={{
    studioBulkEnabled: ready && snapshot.studioBulkEnabled,
    updatedAt: snapshot.userId === userId ? snapshot.updatedAt : null,
    ready,
    error: Boolean(userId && snapshot.userId === userId && snapshot.error),
    applyAvailability,
  }}>
    {children}
  </StudioBulkAvailabilityContext.Provider>;
}

export function useStudioBulkAvailability() {
  return useContext(StudioBulkAvailabilityContext);
}
