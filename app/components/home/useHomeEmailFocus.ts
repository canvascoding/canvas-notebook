'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEmailFocusFeed } from '@/app/apps/email/components/useEmailFocusFeed';
import type { EmailClassificationAvailability } from '@/app/lib/email/classification/admin-service';

type AvailabilityState = { key: string; availability: EmailClassificationAvailability | null; loading: boolean; error: boolean };
type AvailabilityContext = { key: string; cancelled: boolean; controller: AbortController | null; authorityTimer: number | null; confirmedAt: number;
  refresh(): Promise<EmailClassificationAvailability | null> };

/** Home reuses the authorized Focus contract; only confirmed central off selects legacy SWR. */
export function useHomeEmailFocus(userId: string, active: boolean) {
  const key = JSON.stringify([userId, active]);
  const [state, setState] = useState<AvailabilityState>({ key: '', availability: null, loading: false, error: false });
  const contextRef = useRef<AvailabilityContext | null>(null);
  const current = active && userId && state.key === key ? state : null;
  const mode = current?.availability ? current.availability.enabled ? 'focus' : 'legacy' : 'unknown';
  const focus = useEmailFocusFeed({ userId, enabled: active && mode === 'focus', scope: { kind: 'all' }, mode: 'focus', view: 'focus', search: '', limit: 2 });
  const reloadRef = useRef(focus.reload);
  useEffect(() => { reloadRef.current = focus.reload; }, [focus.reload]);

  useEffect(() => {
    const context: AvailabilityContext = { key, cancelled: false, controller: null, authorityTimer: null, confirmedAt: 0, refresh: async () => null };
    contextRef.current = context;
    if (!active || !userId) return () => { context.cancelled = true; };
    const invalidate = () => {
      if (context.cancelled || contextRef.current !== context) return;
      if (context.authorityTimer !== null) window.clearTimeout(context.authorityTimer);
      context.authorityTimer = null;
      setState({ key, availability: null, loading: false, error: true });
    };
    context.refresh = async () => {
      context.controller?.abort();
      const controller = new AbortController(); context.controller = controller;
      const isCurrent = () => !context.cancelled && contextRef.current === context && context.controller === controller && !controller.signal.aborted;
      const deadline = window.setTimeout(() => { if (isCurrent()) { controller.abort(); invalidate(); } }, 10_000);
      try {
        const response = await fetch('/api/email/classification/availability', { credentials: 'include', cache: 'no-store', signal: controller.signal });
        if (!isCurrent()) return null;
        if (!response.ok) throw new Error('Availability unconfirmed');
        const payload = await response.json();
        if (!isCurrent()) return null;
        if (!response.ok || payload.success !== true || typeof payload.data?.enabled !== 'boolean'
          || !Number.isSafeInteger(payload.data.revision)) throw new Error('Availability unconfirmed');
        const availability = payload.data as EmailClassificationAvailability;
        context.confirmedAt = Date.now();
        if (context.authorityTimer !== null) window.clearTimeout(context.authorityTimer);
        context.authorityTimer = window.setTimeout(invalidate, 60_000);
        setState({ key, availability, loading: false, error: false });
        return availability;
      } catch { if (isCurrent()) invalidate(); return null; }
      finally { window.clearTimeout(deadline); if (context.controller === controller) context.controller = null; }
    };
    const initial = window.setTimeout(() => { setState({ key, availability: null, loading: true, error: false }); void context.refresh(); }, 0);
    const refresh = () => { if (document.visibilityState === 'visible') {
      if (context.confirmedAt && Date.now() - context.confirmedAt >= 60_000) invalidate();
      void context.refresh();
    } };
    const interval = window.setInterval(refresh, 30_000);
    const settingsChanged = () => { invalidate(); void context.refresh(); };
    window.addEventListener('canvas-email-classification-settings-updated', settingsChanged);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => {
      context.cancelled = true; context.controller?.abort(); window.clearTimeout(initial); window.clearInterval(interval);
      if (context.authorityTimer !== null) window.clearTimeout(context.authorityTimer);
      window.removeEventListener('canvas-email-classification-settings-updated', settingsChanged);
      window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh);
    };
  }, [key, userId, active]);

  const refresh = useCallback(async () => {
    const context = contextRef.current;
    if (!active || !userId || !context || context.key !== key) return;
    const wasFocus = mode === 'focus';
    const availability = await context.refresh();
    if (!context.cancelled && contextRef.current === context && availability?.enabled && wasFocus) reloadRef.current();
  }, [active, userId, key, mode]);
  // A changed settings revision invalidates a cursor; discover an off transition promptly.
  useEffect(() => {
    if (focus.error?.status === 409) void contextRef.current?.refresh();
  }, [focus.error]);

  return { mode, focus, availability: current?.availability ?? null, loading: active && Boolean(userId) && (!current || current.loading),
    error: current?.error ?? false, refresh };
}

export type HomeEmailFocusState = ReturnType<typeof useHomeEmailFocus>;
