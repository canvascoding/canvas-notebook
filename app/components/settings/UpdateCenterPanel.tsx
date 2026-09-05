'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CircleAlert, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  type SystemUpdateAvailability,
  type SystemUpdateOperationSnapshot,
  type SystemUpdateOperationView,
  type SystemUpdateStatusAccess,
} from '@/app/lib/system-updates/types';
import { isTerminalSystemUpdateStatus, type SystemUpdateEvent } from '@/cli/src/core/systemUpdateContract';
import { UpdateAvailabilityCard, UpdateOperationCard } from './UpdateCenterSections';
import { SystemUpdateObservation } from '@/app/lib/system-updates/observation';

const ACTIVE_OPERATION_STORAGE_KEY = 'canvas.system-update.operation-id';
const STATUS_ACCESS_STORAGE_KEY = 'canvas.system-update.status-access';
const POLL_INTERVAL_MS = 2_000;

type ApiError = { error?: { code?: string; message?: string } };

async function readApiJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as (T & ApiError) | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Request failed with HTTP ${response.status}.`);
  }
  if (!payload) throw new Error('The server returned an empty response.');
  return payload;
}

async function consumeStatusStream(
  response: Response,
  operationId: string,
  onOperation: (operation: SystemUpdateOperationView) => void,
  onEvent: (event: SystemUpdateEvent) => void,
): Promise<void> {
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('Downtime-safe update status is unavailable.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/gu, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      const eventName = frame.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
      const data = frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
      if (!data) continue;
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (parsed.operationId !== operationId) continue;
      if (eventName === 'operation' && typeof parsed.status === 'string' && typeof parsed.stage === 'string') {
        onOperation(parsed as unknown as SystemUpdateOperationView);
      } else if (eventName === 'update' && typeof parsed.eventId === 'string' && typeof parsed.sequence === 'number') {
        onEvent(parsed as unknown as SystemUpdateEvent);
      }
    }
  }
}

export function UpdateCenterPanel() {
  const t = useTranslations('settings.updates');
  const [availability, setAvailability] = useState<SystemUpdateAvailability | null>(null);
  const [operation, setOperation] = useState<SystemUpdateOperationView | null>(null);
  const [events, setEvents] = useState<SystemUpdateEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionInterrupted, setConnectionInterrupted] = useState(false);
  const [statusAccess, setStatusAccess] = useState<SystemUpdateStatusAccess | null>(null);
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
  const observationRef = useRef<SystemUpdateObservation | null>(null);
  const reloadScheduledRef = useRef(false);
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadAvailability = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/system-updates?channel=stable', { cache: 'no-store' });
      const payload = await readApiJson<{ success: true; data: SystemUpdateAvailability }>(response);
      setAvailability(payload.data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.availability'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const acceptOperation = useCallback((next: SystemUpdateOperationView) => {
    const observation = observationRef.current;
    if (!observation?.acceptOperation(next)) return;
    setOperation(observation.operation);
    setConnectionInterrupted(false);
    setError(null);
    if (isTerminalSystemUpdateStatus(next.status)) {
      setActiveOperationId(null);
      setStatusAccess(null);
      try {
        window.localStorage.removeItem(ACTIVE_OPERATION_STORAGE_KEY);
        window.sessionStorage.removeItem(STATUS_ACCESS_STORAGE_KEY);
      } catch { /* Completion does not depend on storage availability. */ }
      if (next.status === 'succeeded' && !reloadScheduledRef.current) {
        reloadScheduledRef.current = true;
        reloadTimerRef.current = setTimeout(() => window.location.reload(), 1_500);
      } else {
        void loadAvailability();
      }
    }
  }, [loadAvailability]);

  const acceptEvents = useCallback((operationId: string, incoming: SystemUpdateEvent[]) => {
    const observation = observationRef.current;
    if (!observation || observation.operationId !== operationId) return;
    observation.acceptEvents(incoming);
    setEvents(observation.events);
  }, []);

  const loadOperation = useCallback(async (operationId: string, signal: AbortSignal) => {
    try {
      const response = await fetch(
        `/api/admin/system-updates/${encodeURIComponent(operationId)}/events?after=${observationRef.current?.cursor || 0}`,
        { cache: 'no-store', signal },
      );
      const payload = await readApiJson<{ success: true } & SystemUpdateOperationSnapshot>(response);
      if (signal.aborted || observationRef.current?.operationId !== operationId) return;
      acceptEvents(operationId, payload.events);
      acceptOperation(payload.operation);
      setConnectionInterrupted(false);
    } catch {
      if (!signal.aborted && observationRef.current?.operationId === operationId) setConnectionInterrupted(true);
    }
  }, [acceptEvents, acceptOperation]);

  const requestStatusAccess = useCallback(async (operationId: string, signal: AbortSignal) => {
    try {
      const response = await fetch(`/api/admin/system-updates/${encodeURIComponent(operationId)}/status-access`, {
        method: 'POST',
        cache: 'no-store',
        signal,
      });
      const payload = await readApiJson<{ success: true; access: SystemUpdateStatusAccess | null }>(response);
      if (signal.aborted || observationRef.current?.operationId !== operationId) return;
      setStatusAccess(payload.access);
      if (payload.access) {
        window.sessionStorage.setItem(STATUS_ACCESS_STORAGE_KEY, JSON.stringify({ operationId, ...payload.access }));
      }
    } catch {
      // The normal application API polling remains the fallback without Caddy.
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAvailability();
      try {
        const storedOperationId = window.localStorage.getItem(ACTIVE_OPERATION_STORAGE_KEY);
        if (storedOperationId) {
          observationRef.current = new SystemUpdateObservation(storedOperationId);
          setActiveOperationId(storedOperationId);
          const storedAccess = window.sessionStorage.getItem(STATUS_ACCESS_STORAGE_KEY);
          if (storedAccess) {
            const parsed = JSON.parse(storedAccess) as SystemUpdateStatusAccess & { operationId?: string };
            if (parsed.operationId === storedOperationId && parsed.path === `/__canvas-host/operations/${storedOperationId}/events` && Date.parse(parsed.expiresAt) > Date.now()) setStatusAccess(parsed);
          }
        }
      } catch {
        // The update remains observable for this page even without browser storage.
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    };
  }, [loadAvailability]);

  useEffect(() => {
    if (!activeOperationId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let request: AbortController | null = null;
    const poll = async () => {
      request = new AbortController();
      const timeout = setTimeout(() => request?.abort(), 15_000);
      await loadOperation(activeOperationId, request.signal);
      clearTimeout(timeout);
      if (!disposed) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void poll(), 0);
    return () => { disposed = true; clearTimeout(timer); request?.abort(); };
  }, [loadOperation, activeOperationId]);

  useEffect(() => {
    if (!activeOperationId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      await requestStatusAccess(activeOperationId, controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 60_000);
    };
    const delay = statusAccess ? Math.max(0, Date.parse(statusAccess.expiresAt) - Date.now() - 60_000) : 0;
    timer = setTimeout(() => void refresh(), delay);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [activeOperationId, statusAccess, requestStatusAccess]);

  const streamOperationId = activeOperationId;
  useEffect(() => {
    if (!streamOperationId || !statusAccess || Date.parse(statusAccess.expiresAt) <= Date.now()) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const connect = async () => {
      await fetch(`${statusAccess.path}?after=${observationRef.current?.cursor || 0}`, {
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${statusAccess.ticket}` },
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      }).then((response) => consumeStatusStream(
        response,
        streamOperationId,
        (nextOperation) => { if (!controller.signal.aborted) acceptOperation(nextOperation); },
        (event) => {
          if (controller.signal.aborted) return;
          acceptEvents(streamOperationId, [event]);
          setConnectionInterrupted(false);
        },
      )).catch(() => {
        // The authenticated application polling continues as the no-Caddy fallback.
      });
      if (!controller.signal.aborted && Date.parse(statusAccess.expiresAt) > Date.now()) timer = setTimeout(() => void connect(), POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void connect(), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [statusAccess, streamOperationId, acceptOperation, acceptEvents]);

  const startUpdate = async () => {
    if (!availability?.release) return;
    setStarting(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/system-updates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'stable', expectedReleaseId: availability.release.releaseId }),
      });
      const payload = await readApiJson<{ success: true; operation: SystemUpdateOperationView }>(response);
      observationRef.current = new SystemUpdateObservation(payload.operation.operationId);
      reloadScheduledRef.current = false;
      setEvents([]);
      setStatusAccess(null);
      setActiveOperationId(payload.operation.operationId);
      acceptOperation(payload.operation);
      setConfirmOpen(false);
      try {
        window.localStorage.setItem(ACTIVE_OPERATION_STORAGE_KEY, payload.operation.operationId);
      } catch {
        // Polling still works while this page remains open.
      }
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : t('errors.start'));
      setConfirmOpen(false);
    } finally {
      setStarting(false);
    }
  };

  const returnToOverview = () => {
    observationRef.current = null;
    setActiveOperationId(null);
    setOperation(null);
    setEvents([]);
    setConnectionInterrupted(false);
    setStatusAccess(null);
    try {
      window.localStorage.removeItem(ACTIVE_OPERATION_STORAGE_KEY);
      window.sessionStorage.removeItem(STATUS_ACCESS_STORAGE_KEY);
    } catch {
      // The overview can still be restored without browser storage.
    }
    void loadAvailability();
  };

  if (loading && !availability && !activeOperationId && !operation) {
    return (
      <Card>
        <CardContent className="flex min-h-48 items-center justify-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('loading')}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {error && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{t('errors.title')}</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void loadAvailability()}>
              <RefreshCw aria-hidden="true" /> {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {activeOperationId && !operation ? (
        <Alert>
          <Loader2 className="animate-spin" aria-hidden="true" />
          <AlertTitle>{t('reconnecting.title')}</AlertTitle>
          <AlertDescription>{t('reconnecting.description')}</AlertDescription>
        </Alert>
      ) : operation ? (
        <UpdateOperationCard
          operation={operation}
          events={events}
          connectionInterrupted={connectionInterrupted}
          onReturnToOverview={returnToOverview}
        />
      ) : availability ? (
        <UpdateAvailabilityCard
          availability={availability}
          loading={loading}
          onCheckAgain={() => void loadAvailability()}
          onInstall={() => setConfirmOpen(true)}
        />
      ) : null}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirm.title', { version: availability?.release?.version || '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('confirm.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4 rounded-lg border bg-muted/30 p-4 text-sm leading-6">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('confirm.versionChange')}</p>
              <div className="mt-2 flex flex-wrap items-center gap-3 font-medium">
                <span className="font-mono text-muted-foreground">{availability?.currentVersion || t('unknown')}</span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <span className="text-lg">{availability?.release?.version || ''}</span>
              </div>
            </div>
            <div className="flex items-start gap-3 border-t pt-4 text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
              <p>{availability?.release?.backupRequired ? t('confirm.backupRequired') : t('confirm.backup')}</p>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={starting}>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={starting} onClick={(event) => { event.preventDefault(); void startUpdate(); }}>
              {starting && <Loader2 className="animate-spin" aria-hidden="true" />}
              {starting ? t('starting') : t('confirm.action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
