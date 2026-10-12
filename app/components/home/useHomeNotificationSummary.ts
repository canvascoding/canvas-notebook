'use client';

import { useEffect, useState } from 'react';

import { useAuthenticatedRequestScope } from '@/app/components/auth/AuthenticatedSessionBoundary';
import { readNotificationSummary, type NotificationSummary } from '@/app/components/notifications/notification-summary';
import { isOpenedDocumentAuthCurrent, type OpenedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';

export function useHomeNotificationSummary() {
  const { active, scope } = useAuthenticatedRequestScope();
  const [state, setState] = useState<{
    scope: OpenedDocumentAuthScope;
    summary: NotificationSummary | null;
    loading: boolean;
  } | null>(null);

  useEffect(() => {
    if (!active || !scope) return;
    let stopped = false;
    let generation = 0;
    let request: AbortController | null = null;
    let updateTimer: number | null = null;

    async function refresh() {
      if (stopped || !isOpenedDocumentAuthCurrent(scope)) return;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const currentGeneration = ++generation;
      const current = () => !stopped && !controller.signal.aborted
        && currentGeneration === generation && isOpenedDocumentAuthCurrent(scope);
      setState(previous => ({ scope: scope!, summary: previous?.scope === scope ? previous.summary : null, loading: true }));
      try {
        const summary = await readNotificationSummary({ authScope: scope, signal: controller.signal });
        if (current()) setState({ scope: scope!, summary, loading: false });
      } catch {
        if (current()) setState(previous => ({
          scope: scope!, summary: previous?.scope === scope ? previous.summary : null, loading: false,
        }));
      }
    }

    const initialTimer = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 30_000);
    const scheduleRefresh = () => {
      if (stopped || !isOpenedDocumentAuthCurrent(scope)) return;
      if (updateTimer !== null) window.clearTimeout(updateTimer);
      updateTimer = window.setTimeout(() => {
        updateTimer = null;
        void refresh();
      }, 100);
    };
    const events = ['session_updated', 'todo_updated', 'notification_summary_updated'];
    for (const event of events) window.addEventListener(event, scheduleRefresh);
    return () => {
      stopped = true;
      generation += 1;
      request?.abort();
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
      if (updateTimer !== null) window.clearTimeout(updateTimer);
      for (const event of events) window.removeEventListener(event, scheduleRefresh);
    };
  }, [active, scope]);

  return {
    active,
    summary: active && state?.scope === scope ? state.summary : null,
    isLoadingSummary: active && (state?.scope !== scope || state.loading),
  };
}
