'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  ServerCog,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  SYSTEM_UPDATE_STAGE_ORDER,
  type SystemUpdateAvailability,
  type SystemUpdateOperationSnapshot,
  type SystemUpdateOperationView,
} from '@/app/lib/system-updates/types';
import type { SystemUpdateEvent, SystemUpdateStage } from '@/cli/src/core/systemUpdateContract';
import { cn } from '@/lib/utils';

const ACTIVE_OPERATION_STORAGE_KEY = 'canvas.system-update.operation-id';
const POLL_INTERVAL_MS = 2_000;
const TERMINAL_STATUSES = new Set(['succeeded', 'rolled_back', 'failed', 'indeterminate']);

const STAGE_TRANSLATION_KEYS: Record<SystemUpdateStage, string> = {
  request_validation: 'requestValidation',
  operation_lock: 'operationLock',
  release_verification: 'releaseVerification',
  host_cli_capabilities: 'hostCliCapabilities',
  config_preflight: 'configPreflight',
  database_preflight: 'databasePreflight',
  backup: 'backup',
  image_pull: 'imagePull',
  container_recreate: 'containerRecreate',
  health_verification: 'healthVerification',
  version_verification: 'versionVerification',
  rollback: 'rollback',
  completed: 'completed',
};

type ApiError = { error?: { code?: string; message?: string } };

async function readApiJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as (T & ApiError) | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Request failed with HTTP ${response.status}.`);
  }
  if (!payload) throw new Error('The server returned an empty response.');
  return payload;
}

function isTerminal(operation: SystemUpdateOperationView | null): boolean {
  return Boolean(operation && TERMINAL_STATUSES.has(operation.status));
}

function eventByStage(events: SystemUpdateEvent[]): Map<SystemUpdateStage, SystemUpdateEvent> {
  const result = new Map<SystemUpdateStage, SystemUpdateEvent>();
  for (const event of events) result.set(event.stage, event);
  return result;
}

export function UpdateCenterPanel() {
  const t = useTranslations('settings.updates');
  const locale = useLocale();
  const [availability, setAvailability] = useState<SystemUpdateAvailability | null>(null);
  const [operation, setOperation] = useState<SystemUpdateOperationView | null>(null);
  const [events, setEvents] = useState<SystemUpdateEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionInterrupted, setConnectionInterrupted] = useState(false);
  const eventCursorRef = useRef(0);

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
        setEvents((current) => {
          const byId = new Map(current.map((event) => [event.eventId, event]));
          for (const event of payload.events) byId.set(event.eventId, event);
          return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
        });
        eventCursorRef.current = Math.max(eventCursorRef.current, ...payload.events.map((event) => event.sequence));
      }
      setConnectionInterrupted(false);
      setError(null);
      if (isTerminal(payload.operation)) {
        window.localStorage.removeItem(ACTIVE_OPERATION_STORAGE_KEY);
        void loadAvailability();
      }
    } catch (loadError) {
      if (quiet) {
        setConnectionInterrupted(true);
      } else {
        setError(loadError instanceof Error ? loadError.message : t('errors.operation'));
      }
    }
  }, [loadAvailability, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAvailability();
      try {
        const storedOperationId = window.localStorage.getItem(ACTIVE_OPERATION_STORAGE_KEY);
        if (storedOperationId) void loadOperation(storedOperationId);
      } catch {
        // The update remains observable for this page even without browser storage.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAvailability, loadOperation]);

  useEffect(() => {
    if (!operation || isTerminal(operation)) return;
    const timer = window.setInterval(() => void loadOperation(operation.operationId, true), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadOperation, operation]);

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
      void loadOperation(payload.operation.operationId, true);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : t('errors.start'));
      setConfirmOpen(false);
    } finally {
      setStarting(false);
    }
  };

  const latestEvents = useMemo(() => eventByStage(events), [events]);
  const currentStageIndex = operation ? SYSTEM_UPDATE_STAGE_ORDER.indexOf(operation.stage) : -1;
  const progress = operation?.status === 'succeeded'
    ? 100
    : Math.max(4, Math.round(((currentStageIndex + 1) / SYSTEM_UPDATE_STAGE_ORDER.length) * 100));
  const active = Boolean(operation && !isTerminal(operation));
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }), [locale]);

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

      {connectionInterrupted && active && (
        <Alert>
          <Loader2 className="animate-spin" aria-hidden="true" />
          <AlertTitle>{t('reconnecting.title')}</AlertTitle>
          <AlertDescription>{t('reconnecting.description')}</AlertDescription>
        </Alert>
      )}

      <Card className="overflow-hidden">
        <CardHeader className="border-b bg-muted/30">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-lg">{t('overview.title')}</CardTitle>
                <Badge variant="outline">{t(`modes.${availability?.mode || 'manual'}`)}</Badge>
              </div>
              <CardDescription>{t('overview.description')}</CardDescription>
            </div>
            <Button variant="outline" size="sm" disabled={loading || active} onClick={() => void loadAvailability()}>
              <RefreshCw className={cn(loading && 'animate-spin')} aria-hidden="true" />
              {t('checkAgain')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="grid divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <div className="p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t('currentVersion')}</p>
              <p className="mt-2 font-mono text-2xl font-semibold tracking-tight">{availability?.currentVersion || t('unknown')}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t('installed')}</p>
            </div>
            <div className="p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t('availableVersion')}</p>
              <p className="mt-2 font-mono text-2xl font-semibold tracking-tight">
                {availability?.release?.version || '—'}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                {availability?.release ? dateFormatter.format(new Date(availability.release.publishedAt)) : t('platformManaged')}
                {availability?.release?.releaseNotesUrl && (
                  <a
                    className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
                    href={availability.release.releaseNotesUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('releaseNotes')} <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {availability?.mode === 'manual' && (
        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-muted/50">
                <ServerCog className="h-4 w-4 text-primary" aria-hidden="true" />
              </div>
              <div>
                <CardTitle className="text-base">{t('manual.title')}</CardTitle>
                <CardDescription className="mt-1">{t(`manual.descriptions.${availability.platform}`)}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3">
              {availability.instructions.map((instruction, index) => (
                <li key={instruction} className="flex gap-3 text-sm leading-6">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-muted text-xs font-semibold">{index + 1}</span>
                  <span>{t(`manual.steps.${availability.platform}.${instruction}`)}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}

      {availability?.mode === 'standalone' && !active && !operation && (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="text-base">
                  {availability.updateAvailable ? t('ready.title') : t('upToDate.title')}
                </CardTitle>
                <CardDescription className="mt-1">
                  {availability.updateAvailable ? t('ready.description') : t('upToDate.description')}
                </CardDescription>
              </div>
              {availability.updateAvailable ? (
                <Badge>{t('ready.badge')}</Badge>
              ) : (
                <CircleCheck className="h-6 w-6 text-emerald-600" aria-hidden="true" />
              )}
            </div>
          </CardHeader>
          {availability.updateAvailable && (
            <CardContent className="flex flex-col gap-4 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm text-muted-foreground">
                {availability.release?.backupRequired ? t('ready.backupRequired') : t('ready.backupIncluded')}
              </div>
              <Button disabled={!availability.ready} onClick={() => setConfirmOpen(true)}>
                {t('installUpdate')}
              </Button>
            </CardContent>
          )}
        </Card>
      )}

      {operation && (
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle className="text-base">{t(`operation.status.${operation.status}`)}</CardTitle>
                <CardDescription className="mt-1">
                  {t('operation.version', { version: operation.targetVersion })}
                </CardDescription>
              </div>
              <Badge variant={operation.status === 'failed' ? 'destructive' : 'outline'}>
                {t(`operation.status.${operation.status}`)}
              </Badge>
            </div>
            <Progress className="mt-4" value={progress} aria-label={t('operation.progress')} />
          </CardHeader>
          <CardContent className="space-y-4 border-t pt-5">
            <div className="space-y-1">
              {SYSTEM_UPDATE_STAGE_ORDER.map((stage, index) => {
                const event = latestEvents.get(stage);
                const current = stage === operation.stage && !isTerminal(operation);
                const complete = event?.status === 'succeeded' || event?.status === 'skipped' || operation.status === 'succeeded';
                const failed = event?.status === 'failed' || (stage === operation.stage && ['failed', 'rolled_back', 'indeterminate'].includes(operation.status));
                if (!event && index > currentStageIndex + 1 && !isTerminal(operation)) return null;
                return (
                  <div key={stage} className="flex min-h-9 items-start gap-3 rounded-md px-2 py-1.5 text-sm">
                    {failed ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                      : complete ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                        : current ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
                          : <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />}
                    <div className="min-w-0">
                      <p className={cn('font-medium', !event && !current && 'text-muted-foreground')}>{t(`stages.${STAGE_TRANSLATION_KEYS[stage]}`)}</p>
                      {event?.message && <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{event.message}</p>}
                    </div>
                  </div>
                );
              })}
            </div>

            {operation.error && (
              <Alert variant="destructive">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>{t('operation.failedTitle')}</AlertTitle>
                <AlertDescription>{operation.error}</AlertDescription>
              </Alert>
            )}
            {operation.rolledBack && (
              <Alert>
                <RotateCcw aria-hidden="true" />
                <AlertTitle>{t('operation.rolledBackTitle')}</AlertTitle>
                <AlertDescription>{t('operation.rolledBackDescription')}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirm.title', { version: availability?.release?.version || '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('confirm.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-md border bg-muted/35 p-3 text-sm leading-6 text-muted-foreground">
            {availability?.release?.backupRequired ? t('confirm.backupRequired') : t('confirm.backup')}
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
