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

function mergeUpdateEvents(current: SystemUpdateEvent[], incoming: SystemUpdateEvent[]): SystemUpdateEvent[] {
  const byId = new Map(current.map((event) => [event.eventId, event]));
  for (const event of incoming) byId.set(event.eventId, event);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
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
  const eventCursorRef = useRef(0);
  const reloadScheduledRef = useRef(false);

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

  const loadOperation = useCallback(async (operationId: string, quiet = false) => {
    try {
      const response = await fetch(
        `/api/admin/system-updates/${encodeURIComponent(operationId)}/events?after=${eventCursorRef.current}`,
        { cache: 'no-store' },
      );
      const payload = await readApiJson<{ success: true } & SystemUpdateOperationSnapshot>(response);
      setOperation(payload.operation);
      if (payload.events.length > 0) {
        setEvents((current) => mergeUpdateEvents(current, payload.events));
        eventCursorRef.current = Math.max(eventCursorRef.current, ...payload.events.map((event) => event.sequence));
      }
      setConnectionInterrupted(false);
      setError(null);
      if (isTerminalSystemUpdateStatus(payload.operation.status)) {
        window.localStorage.removeItem(ACTIVE_OPERATION_STORAGE_KEY);
        void loadAvailability();
      }
    } catch (loadError) {
      if (quiet) {
        setConnectionInterrupted(true);
        void fetch('/api/health', { cache: 'no-store' }).then((health) => {
          if (health.ok) setConnectionInterrupted(false);
        }).catch(() => undefined);
      } else {
        setError(loadError instanceof Error ? loadError.message : t('errors.operation'));
      }
    }
  }, [loadAvailability, t]);

  const requestStatusAccess = useCallback(async (operationId: string) => {
    try {
      const response = await fetch(`/api/admin/system-updates/${encodeURIComponent(operationId)}/status-access`, {
        method: 'POST',
        cache: 'no-store',
      });
      const payload = await readApiJson<{ success: true; access: SystemUpdateStatusAccess | null }>(response);
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
          void loadOperation(storedOperationId);
          const storedAccess = window.sessionStorage.getItem(STATUS_ACCESS_STORAGE_KEY);
          if (storedAccess) {
            const parsed = JSON.parse(storedAccess) as SystemUpdateStatusAccess & { operationId?: string };
            if (parsed.operationId === storedOperationId && Date.parse(parsed.expiresAt) > Date.now()) setStatusAccess(parsed);
            else void requestStatusAccess(storedOperationId);
          } else {
            void requestStatusAccess(storedOperationId);
          }
        }
      } catch {
        // The update remains observable for this page even without browser storage.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAvailability, loadOperation, requestStatusAccess]);

  useEffect(() => {
    if (!operation || isTerminalSystemUpdateStatus(operation.status)) return;
    const timer = window.setInterval(() => void loadOperation(operation.operationId, true), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadOperation, operation]);

  const streamOperationId = operation && !isTerminalSystemUpdateStatus(operation.status) ? operation.operationId : null;
  useEffect(() => {
    if (!streamOperationId || !statusAccess || Date.parse(statusAccess.expiresAt) <= Date.now()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch(`${statusAccess.path}?after=${eventCursorRef.current}`, {
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${statusAccess.ticket}` },
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      }).then((response) => consumeStatusStream(
        response,
        streamOperationId,
        (nextOperation) => {
          setOperation(nextOperation);
          setConnectionInterrupted(false);
          if (isTerminalSystemUpdateStatus(nextOperation.status)) {
            window.localStorage.removeItem(ACTIVE_OPERATION_STORAGE_KEY);
            window.sessionStorage.removeItem(STATUS_ACCESS_STORAGE_KEY);
            if (nextOperation.status === 'succeeded' && !reloadScheduledRef.current) {
              reloadScheduledRef.current = true;
              window.setTimeout(() => window.location.reload(), 1_500);
            }
          }
        },
        (event) => {
          eventCursorRef.current = Math.max(eventCursorRef.current, event.sequence);
          setEvents((current) => mergeUpdateEvents(current, [event]));
          setConnectionInterrupted(false);
        },
      )).catch(() => {
        // The authenticated application polling continues as the no-Caddy fallback.
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [statusAccess, streamOperationId]);

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
      eventCursorRef.current = 0;
      setEvents([]);
      setOperation(payload.operation);
      setConfirmOpen(false);
      try {
        window.localStorage.setItem(ACTIVE_OPERATION_STORAGE_KEY, payload.operation.operationId);
      } catch {
        // Polling still works while this page remains open.
      }
      void requestStatusAccess(payload.operation.operationId);
      void loadOperation(payload.operation.operationId, true);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : t('errors.start'));
      setConfirmOpen(false);
    } finally {
      setStarting(false);
    }
  };

  const returnToOverview = () => {
    setOperation(null);
    setEvents([]);
    setConnectionInterrupted(false);
    setStatusAccess(null);
    eventCursorRef.current = 0;
    try {
      window.localStorage.removeItem(ACTIVE_OPERATION_STORAGE_KEY);
      window.sessionStorage.removeItem(STATUS_ACCESS_STORAGE_KEY);
    } catch {
      // The overview can still be restored without browser storage.
    }
    void loadAvailability();
  };

  if (loading && !availability) {
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

      {operation ? (
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
