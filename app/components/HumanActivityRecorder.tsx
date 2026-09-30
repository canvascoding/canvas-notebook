'use client';

import { useEffect } from 'react';

import { shouldReportHumanActivity } from '@/app/lib/instance/human-activity-policy';

export function HumanActivityRecorder() {
  useEffect(() => {
    let lastAttemptAt = Number.NEGATIVE_INFINITY;
    const report = (event: Event) => {
      const now = Date.now();
      if (!shouldReportHumanActivity({
        visible: document.visibilityState === 'visible',
        trusted: event.isTrusted,
        repeating: event instanceof KeyboardEvent && event.repeat,
        now,
        lastAttemptAt,
      })) return;
      lastAttemptAt = now;
      void fetch('/api/instance/human-activity', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
      }).catch(() => undefined);
    };
    document.addEventListener('pointerdown', report, { passive: true });
    document.addEventListener('keydown', report, { passive: true });
    document.addEventListener('touchstart', report, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', report);
      document.removeEventListener('keydown', report);
      document.removeEventListener('touchstart', report);
    };
  }, []);
  return null;
}
