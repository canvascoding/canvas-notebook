'use client';

import { useEffect } from 'react';

import { shouldReportHumanActivity } from '@/app/lib/instance/human-activity-policy';
import { useAuthenticatedRequestScope } from '@/app/components/auth/AuthenticatedSessionBoundary';
import { reportSessionExpiry } from '@/app/lib/auth/session-expiry';
import { isOpenedDocumentAuthCurrent } from '@/app/lib/collaboration/opened-document-registry';

export function HumanActivityRecorder() {
  const { active, scope } = useAuthenticatedRequestScope();
  useEffect(() => {
    if (!active || !scope) return;
    const controller = new AbortController();
    let lastAttemptAt = Number.NEGATIVE_INFINITY;
    const report = (event: Event) => {
      if (controller.signal.aborted || !isOpenedDocumentAuthCurrent(scope)) return;
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
        signal: controller.signal,
      }).then(async response => {
        if (!controller.signal.aborted && response.status === 401) reportSessionExpiry(scope);
        await response.arrayBuffer();
      }).catch(() => undefined);
    };
    document.addEventListener('pointerdown', report, { passive: true });
    document.addEventListener('keydown', report, { passive: true });
    document.addEventListener('touchstart', report, { passive: true });
    return () => {
      controller.abort();
      document.removeEventListener('pointerdown', report);
      document.removeEventListener('keydown', report);
      document.removeEventListener('touchstart', report);
    };
  }, [active, scope]);
  return null;
}
