'use client';

import { useEffect } from 'react';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function LicenseGatePrimer({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return;

    let disposed = false;

    const refresh = () => {
      if (disposed) return;
      void fetch('/api/license/status', {
        cache: 'no-store',
        credentials: 'include',
      }).catch(() => {});
    };

    const refreshWhenVisible = () => {
      if (!document.hidden) refresh();
    };

    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    const interval = window.setInterval(refresh, REFRESH_INTERVAL_MS);

    return () => {
      disposed = true;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.clearInterval(interval);
    };
  }, [enabled]);

  return null;
}
