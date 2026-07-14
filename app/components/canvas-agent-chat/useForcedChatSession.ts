'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export function useForcedChatSession(routeSessionId: string | null) {
  const [forcedSessionId, setForcedSessionId] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(0);
  const routeConfirmedForcedSessionRef = useRef(false);

  const forceSession = useCallback((sessionId: string) => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return;

    routeConfirmedForcedSessionRef.current = false;
    setForcedSessionId(normalizedSessionId);
    setRequestId((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!forcedSessionId) {
      routeConfirmedForcedSessionRef.current = false;
      return;
    }

    if (routeSessionId === forcedSessionId) {
      routeConfirmedForcedSessionRef.current = true;
      return;
    }

    if (routeConfirmedForcedSessionRef.current) {
      routeConfirmedForcedSessionRef.current = false;
      setForcedSessionId(null);
    }
  }, [forcedSessionId, routeSessionId]);

  return {
    forceSession,
    forcedSessionId,
    requestId,
  };
}
