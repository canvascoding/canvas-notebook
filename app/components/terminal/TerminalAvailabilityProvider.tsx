'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { authClient } from '@/app/lib/auth-client';
import type { TerminalAvailability } from '@/app/lib/terminal-policy';
import { useTerminalStore } from '@/app/store/terminal-store';

type AvailabilityContext = {
  terminalEnabled: boolean;
  ready: boolean;
  applyAvailability: (state: TerminalAvailability) => void;
  markDisabled: () => void;
};

const TerminalContext = createContext<AvailabilityContext>({
  terminalEnabled: false,
  ready: false,
  applyAvailability: () => {},
  markDisabled: () => {},
});

export function TerminalAvailabilityProvider({ children }: { children: ReactNode }) {
  const { data: session } = authClient.useSession();
  const userId = session?.user.id ?? null;
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [snapshot, setSnapshot] = useState({ userId: null as string | null, terminalEnabled: false, ready: false });
  const applyAvailability = useCallback((state: TerminalAvailability) => {
    const terminalEnabled = state.terminalEnabled === true;
    if (!terminalEnabled) useTerminalStore.getState().clearSessions();
    setSnapshot({ userId, terminalEnabled, ready: true });
  }, [userId]);
  const markDisabled = useCallback(() => {
    applyAvailability({ terminalEnabled: false, terminalUpdatedAt: null });
    // A revoked session can arrive just after another admin re-enabled the
    // feature. Reconnect for an authoritative snapshot instead of staying stale.
    setConnectionVersion(version => version + 1);
  }, [applyAvailability]);

  useEffect(() => {
    if (!userId) return;
    let disposed = false;
    const source = new EventSource('/api/terminal/availability?stream=1');
    source.onmessage = event => {
      if (disposed) return;
      try {
        const state = JSON.parse(event.data) as TerminalAvailability;
        if (typeof state.terminalEnabled !== 'boolean') throw new Error('Invalid terminal availability');
        applyAvailability(state);
      } catch {
        setSnapshot({ userId, terminalEnabled: false, ready: false });
      }
    };
    source.onerror = () => {
      if (!disposed) setSnapshot({ userId, terminalEnabled: false, ready: false });
    };
    return () => { disposed = true; source.close(); };
  }, [applyAvailability, userId, connectionVersion]);

  const ready = Boolean(userId && snapshot.userId === userId && snapshot.ready);
  return (
    <TerminalContext.Provider value={{ terminalEnabled: ready && snapshot.terminalEnabled, ready, applyAvailability, markDisabled }}>
      {children}
    </TerminalContext.Provider>
  );
}

export function useTerminalAvailability() {
  return useContext(TerminalContext);
}
