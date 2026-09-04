'use client';

import { useMemo, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  ExternalLink,
  Loader2,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  ServerCog,
  ShieldCheck,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Progress } from '@/components/ui/progress';
import {
  getSystemUpdatePhaseProgress,
  resolveSystemUpdateReadinessReasonKey,
  resolveSystemUpdateUserPhase,
  SYSTEM_UPDATE_USER_PHASE_ORDER,
  type SystemUpdateUserPhase,
} from '@/app/lib/system-updates/presentation';
import {
  SYSTEM_UPDATE_STAGE_ORDER,
  type SystemUpdateAvailability,
  type SystemUpdateOperationView,
} from '@/app/lib/system-updates/types';
import {
  isTerminalSystemUpdateStatus,
  type SystemUpdateEvent,
  type SystemUpdateStage,
} from '@/cli/src/core/systemUpdateContract';
import { cn } from '@/lib/utils';

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

function eventByStage(events: SystemUpdateEvent[]): Map<SystemUpdateStage, SystemUpdateEvent> {
  const result = new Map<SystemUpdateStage, SystemUpdateEvent>();
  for (const event of events) result.set(event.stage, event);
  return result;
}

function UpdateDetailsDisclosure({ children }: { children: ReactNode }) {
  const t = useTranslations('settings.updates');
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 rounded-md px-1 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span>{t('details.title')}</span>
          <span className="flex items-center gap-2 text-xs">
            {open ? t('details.hide') : t('details.show')}
            <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden="true" />
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function AvailabilityDetails({ availability }: { availability: SystemUpdateAvailability }) {
  const t = useTranslations('settings.updates');

  return (
    <UpdateDetailsDisclosure>
      <div className="rounded-lg border bg-muted/20 p-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">{t('details.mode')}</dt>
            <dd className="mt-1 font-medium">{t(`modes.${availability.mode}`)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">{t('details.channel')}</dt>
            <dd className="mt-1 font-medium">{t(`channels.${availability.channel}`)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">{t('currentVersion')}</dt>
            <dd className="mt-1 font-mono text-xs">{availability.currentVersion || t('unknown')}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">{t('availableVersion')}</dt>
            <dd className="mt-1 font-mono text-xs">{availability.release?.version || '—'}</dd>
          </div>
        </dl>

        {availability.mode === 'manual' && availability.instructions.length > 0 && (
          <div className="mt-4 border-t pt-4">
            <p className="text-sm font-medium">{t('manual.adminInstructions')}</p>
            <ol className="mt-3 space-y-3">
              {availability.instructions.map((instruction, index) => (
                <li key={instruction} className="flex gap-3 text-sm leading-6 text-muted-foreground">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-background text-xs font-semibold text-foreground">
                    {index + 1}
                  </span>
                  <span>{t(`manual.steps.${availability.platform}.${instruction}`)}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </UpdateDetailsDisclosure>
  );
}

export function UpdateAvailabilityCard({
  availability,
  loading,
  onCheckAgain,
  onInstall,
}: {
  availability: SystemUpdateAvailability;
  loading: boolean;
  onCheckAgain: () => void;
  onInstall: () => void;
}) {
  const t = useTranslations('settings.updates');
  const locale = useLocale();
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );
  const manual = availability.mode === 'manual';
  const updateAvailable = availability.updateAvailable === true && Boolean(availability.release);
  const availabilityUnknown = !manual && (
    availability.updateAvailable === null || (availability.updateAvailable === true && !availability.release)
  );
  const readinessReasons = availability.reasons.length > 0
    ? availability.reasons.map(resolveSystemUpdateReadinessReasonKey)
    : ['technicalReviewRequired' as const];

  const title = manual
    ? t('manual.title')
    : availabilityUnknown
      ? t('unavailable.title')
      : updateAvailable
        ? t('ready.title')
        : t('upToDate.title');
  const description = manual
    ? t(`manual.descriptions.${availability.platform}`)
    : availabilityUnknown
      ? t('unavailable.description')
      : updateAvailable
        ? t('ready.description')
        : t('upToDate.description');

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b bg-muted/20">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div className={cn(
              'mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-background',
              !manual && !availabilityUnknown && !updateAvailable && 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-400',
            )}>
              {manual ? <ServerCog className="h-5 w-5 text-primary" aria-hidden="true" />
                : availabilityUnknown ? <CircleAlert className="h-5 w-5 text-amber-600" aria-hidden="true" />
                  : updateAvailable ? <PackageCheck className="h-5 w-5 text-primary" aria-hidden="true" />
                    : <CircleCheck className="h-5 w-5" aria-hidden="true" />}
            </div>
            <div className="min-w-0 space-y-1.5">
              <CardTitle className="text-lg">{title}</CardTitle>
              <CardDescription className="max-w-2xl">{description}</CardDescription>
            </div>
          </div>
          <Button variant="ghost" size="sm" disabled={loading} onClick={onCheckAgain}>
            <RefreshCw className={cn(loading && 'animate-spin')} aria-hidden="true" />
            {t('checkAgain')}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-5 p-5 sm:p-6">
        {manual ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">{t('currentVersion')}</p>
            <p className="text-2xl font-semibold tracking-tight">{availability.currentVersion || t('unknown')}</p>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{t('manual.userDescription')}</p>
          </div>
        ) : availabilityUnknown ? (
          <>
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">{t('currentVersion')}</p>
              <p className="text-2xl font-semibold tracking-tight">{availability.currentVersion || t('unknown')}</p>
            </div>
            <Alert>
              <CircleAlert aria-hidden="true" />
              <AlertTitle>{t('readiness.title')}</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 pl-5">
                  {readinessReasons.map((reason, index) => (
                    <li key={`${reason}-${index}`}>{t(`readiness.reasons.${reason}`)}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          </>
        ) : updateAvailable ? (
          <>
            <div className="flex flex-wrap items-center gap-3" aria-label={t('ready.versionChange')}>
              <span className="rounded-lg border bg-muted/30 px-3 py-2 font-mono text-sm text-muted-foreground">
                {availability.currentVersion || t('unknown')}
              </span>
              <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span className="text-3xl font-semibold tracking-tight">{availability.release?.version}</span>
              <Badge>{t('ready.badge')}</Badge>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
              {availability.release && <span>{dateFormatter.format(new Date(availability.release.publishedAt))}</span>}
              {availability.release?.releaseNotesUrl && (
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

            <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4 text-sm leading-6">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
              <p>{availability.release?.backupRequired ? t('ready.backupRequired') : t('ready.backupIncluded')}</p>
            </div>

            {!availability.ready && (
              <Alert>
                <CircleAlert aria-hidden="true" />
                <AlertTitle>{t('readiness.title')}</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc space-y-1 pl-5">
                    {readinessReasons.map((reason, index) => (
                      <li key={`${reason}-${index}`}>{t(`readiness.reasons.${reason}`)}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col gap-3 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                {availability.ready ? t('ready.actionHint') : t('readiness.actionHint')}
              </p>
              <Button disabled={!availability.ready} onClick={onInstall}>
                {availability.ready ? t('installUpdate') : t('readiness.action')}
              </Button>
            </div>
          </>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">{t('currentVersion')}</p>
            <p className="text-3xl font-semibold tracking-tight">{availability.currentVersion || t('unknown')}</p>
            <p className="text-sm text-muted-foreground">{t('installed')}</p>
          </div>
        )}

        <AvailabilityDetails availability={availability} />
      </CardContent>
    </Card>
  );
}

function UserPhaseTimeline({ currentPhase }: { currentPhase: SystemUpdateUserPhase }) {
  const t = useTranslations('settings.updates');
  const currentIndex = SYSTEM_UPDATE_USER_PHASE_ORDER.indexOf(
    currentPhase as typeof SYSTEM_UPDATE_USER_PHASE_ORDER[number],
  );

  if (currentPhase === 'restoring') return null;

  return (
    <ol className="grid gap-2 sm:grid-cols-5" aria-label={t('operation.phases')}>
      {SYSTEM_UPDATE_USER_PHASE_ORDER.map((phase, index) => {
        const complete = index < currentIndex || currentPhase === 'completed';
        const current = index === currentIndex && currentPhase !== 'completed';
        return (
          <li
            key={phase}
            className={cn(
              'flex min-h-14 items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium',
              current && 'border-primary/50 bg-primary/5 text-foreground',
              complete && 'border-emerald-200 bg-emerald-50/70 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300',
              !current && !complete && 'text-muted-foreground',
            )}
          >
            {complete ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
              : current ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
                : <CircleDashed className="h-4 w-4 shrink-0" aria-hidden="true" />}
            <span>{t(`phases.${phase}.label`)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function OperationTechnicalDetails({
  operation,
  events,
}: {
  operation: SystemUpdateOperationView;
  events: SystemUpdateEvent[];
}) {
  const t = useTranslations('settings.updates');
  const latestEvents = useMemo(() => eventByStage(events), [events]);
  const currentStageIndex = SYSTEM_UPDATE_STAGE_ORDER.indexOf(operation.stage);
  const terminal = isTerminalSystemUpdateStatus(operation.status);

  return (
    <UpdateDetailsDisclosure>
      <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
        <div className="space-y-1">
          {SYSTEM_UPDATE_STAGE_ORDER.map((stage, index) => {
            const event = latestEvents.get(stage);
            const current = stage === operation.stage && !terminal;
            const complete = event?.status === 'succeeded' || event?.status === 'skipped' || (
              operation.status === 'succeeded' && stage === 'completed'
            );
            const failed = event?.status === 'failed' || (
              stage === operation.stage && ['failed', 'rolled_back', 'indeterminate'].includes(operation.status)
            );
            if (!event && index > currentStageIndex + 1 && !terminal) return null;
            return (
              <div key={stage} className="flex min-h-9 items-start gap-3 rounded-md px-2 py-1.5 text-sm">
                {failed ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                  : complete ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                    : current ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
                      : <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />}
                <div className="min-w-0">
                  <p className={cn('font-medium', !event && !current && 'text-muted-foreground')}>
                    {t(`stages.${STAGE_TRANSLATION_KEYS[stage]}`)}
                  </p>
                  {event?.message && <p className="mt-0.5 break-words text-xs leading-5 text-muted-foreground">{event.message}</p>}
                </div>
              </div>
            );
          })}
        </div>

        {(operation.errorCode || operation.error) && (
          <div className="border-t pt-4 text-xs leading-5 text-muted-foreground">
            {operation.errorCode && <p><span className="font-medium text-foreground">{t('details.errorCode')}:</span> {operation.errorCode}</p>}
            {operation.error && <p className="mt-1 break-words"><span className="font-medium text-foreground">{t('details.message')}:</span> {operation.error}</p>}
          </div>
        )}
      </div>
    </UpdateDetailsDisclosure>
  );
}

export function UpdateOperationCard({
  operation,
  events,
  connectionInterrupted,
  onReturnToOverview,
}: {
  operation: SystemUpdateOperationView;
  events: SystemUpdateEvent[];
  connectionInterrupted: boolean;
  onReturnToOverview: () => void;
}) {
  const t = useTranslations('settings.updates');
  const terminal = isTerminalSystemUpdateStatus(operation.status);
  const phase = resolveSystemUpdateUserPhase(operation);
  const progress = getSystemUpdatePhaseProgress(phase);
  const succeeded = operation.status === 'succeeded';
  const rolledBack = operation.status === 'rolled_back' || operation.rolledBack;
  const problem = operation.status === 'failed' || operation.status === 'indeterminate';

  const title = terminal
    ? t(`operation.status.${operation.status}`)
    : t(`phases.${phase}.title`);
  const description = terminal
    ? succeeded
      ? t('operation.succeededDescription', { version: operation.targetVersion })
      : rolledBack
        ? t('operation.rolledBackDescription')
        : t(`operation.problemDescriptions.${operation.status}`)
    : t(`phases.${phase}.description`);

  return (
    <Card className="overflow-hidden">
      <CardHeader className={cn(
        'border-b bg-muted/20',
        succeeded && 'bg-emerald-50/60 dark:bg-emerald-950/20',
      )}>
        <div className="flex items-start gap-3" aria-live="polite" aria-atomic="true">
          <div className={cn(
            'mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-background',
            succeeded && 'border-emerald-200 text-emerald-700 dark:border-emerald-900 dark:text-emerald-400',
            problem && 'border-destructive/30 text-destructive',
          )}>
            {succeeded ? <CircleCheck className="h-5 w-5" aria-hidden="true" />
              : rolledBack ? <RotateCcw className="h-5 w-5" aria-hidden="true" />
                : problem ? <CircleAlert className="h-5 w-5" aria-hidden="true" />
                  : <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />}
          </div>
          <div className="min-w-0 space-y-1.5">
            <CardTitle className="text-lg">{title}</CardTitle>
            <CardDescription className="max-w-2xl">{description}</CardDescription>
            <p className="text-xs font-medium text-muted-foreground">{t('operation.version', { version: operation.targetVersion })}</p>
          </div>
        </div>

        {!terminal && (
          <div className="mt-5 space-y-2">
            <Progress
              value={progress}
              aria-label={t('operation.progress')}
              aria-valuetext={t(`phases.${phase}.label`)}
            />
            <p className="text-right text-xs font-medium text-muted-foreground">{progress}%</p>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-5 p-5 sm:p-6">
        {!terminal && <UserPhaseTimeline currentPhase={phase} />}

        {connectionInterrupted && !terminal && (
          <Alert>
            <Loader2 className="animate-spin" aria-hidden="true" />
            <AlertTitle>{t('reconnecting.title')}</AlertTitle>
            <AlertDescription>{t('reconnecting.description')}</AlertDescription>
          </Alert>
        )}

        {phase === 'restoring' && !terminal && (
          <Alert>
            <RotateCcw aria-hidden="true" />
            <AlertTitle>{t('phases.restoring.title')}</AlertTitle>
            <AlertDescription>{t('phases.restoring.description')}</AlertDescription>
          </Alert>
        )}

        {rolledBack && terminal && (
          <Alert>
            <RotateCcw aria-hidden="true" />
            <AlertTitle>{t('operation.rolledBackTitle')}</AlertTitle>
            <AlertDescription>{t('operation.rolledBackDescription')}</AlertDescription>
          </Alert>
        )}

        {problem && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{t('operation.failedTitle')}</AlertTitle>
            <AlertDescription>{t('operation.nextStep')}</AlertDescription>
          </Alert>
        )}

        {terminal && (
          <div className="flex justify-end">
            <Button variant="outline" onClick={onReturnToOverview}>{t('operation.returnToOverview')}</Button>
          </div>
        )}

        <OperationTechnicalDetails operation={operation} events={events} />
      </CardContent>
    </Card>
  );
}
