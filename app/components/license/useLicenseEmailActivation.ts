'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type PublicLicenseEmailActivation = {
  state: 'authorization_pending';
  expiresAt: string;
  pollIntervalSeconds: number;
};

type ActivationFailure = {
  error?: string;
  code?: string;
};

export function useLicenseEmailActivation(options: {
  licensed: boolean;
  onActivated: () => Promise<void> | void;
  onFailure?: (failure: ActivationFailure) => void;
}) {
  const [pendingActivation, setPendingActivation] = useState<PublicLicenseEmailActivation | null>(null);
  const [polling, setPolling] = useState(true);
  const onActivatedRef = useRef(options.onActivated);
  const onFailureRef = useRef(options.onFailure);

  useEffect(() => {
    onActivatedRef.current = options.onActivated;
    onFailureRef.current = options.onFailure;
  }, [options.onActivated, options.onFailure]);

  const beginPolling = useCallback((activation: PublicLicenseEmailActivation | null) => {
    setPendingActivation(activation);
    setPolling(Boolean(activation));
  }, []);

  useEffect(() => {
    if (!polling || options.licensed) return;
    let cancelled = false;
    let timer: number | null = null;

    const poll = async () => {
      let nextPollSeconds = 5;
      try {
        const response = await fetch('/api/license/activation/status', {
          method: 'POST',
          credentials: 'include',
        });
        const payload = await response.json().catch(() => ({})) as {
          success?: boolean;
          error?: string;
          code?: string;
          retryable?: boolean;
          activation?: PublicLicenseEmailActivation | { state: 'idle' | 'activated' };
        };
        if (!response.ok || !payload.success) {
          if (payload.retryable || response.status === 429 || response.status >= 500) {
            nextPollSeconds = 10;
          } else {
            setPolling(false);
            setPendingActivation(null);
            onFailureRef.current?.({ error: payload.error, code: payload.code });
            return;
          }
        } else if (payload.activation?.state === 'authorization_pending') {
          setPendingActivation(payload.activation);
          nextPollSeconds = payload.activation.pollIntervalSeconds;
        } else if (payload.activation?.state === 'activated') {
          setPendingActivation(null);
          setPolling(false);
          await onActivatedRef.current();
          return;
        } else {
          setPendingActivation(null);
          setPolling(false);
          return;
        }
      } catch {
        nextPollSeconds = 10;
      }
      if (!cancelled) {
        timer = window.setTimeout(() => void poll(), Math.max(1, nextPollSeconds) * 1000);
      }
    };

    timer = window.setTimeout(() => void poll(), 0);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [options.licensed, polling]);

  return { beginPolling, pendingActivation };
}
