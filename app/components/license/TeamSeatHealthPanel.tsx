'use client';

import { useMemo, useState } from 'react';
import { useLocale } from 'next-intl';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Link2Off,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';

import type { TeamSeatHealth } from '@/app/lib/license/team-seat-health-types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

type RecoveryAction = 'sync_snapshot' | 'refresh_license';

function copyFor(locale: string) {
  const german = locale.toLowerCase().startsWith('de');
  return german
    ? {
        title: 'Team-Lizenzzustand',
        description: 'Lokaler Abgleich zwischen aktiven Mitgliedern, Abrechnung und signiertem Zugriff.',
        ownerOnly: 'Diese Betriebs- und Billing-Ansicht ist ausschließlich für den Organisations-Owner sichtbar.',
        unavailable: 'Der lokale Team-Lizenzzustand konnte nicht geladen werden.',
        reload: 'Neu laden',
        licenseDetails: 'Lizenzidentität',
        licenseClass: 'Lizenzklasse',
        environment: 'Umgebung',
        seatLimit: 'Seat-Limit',
        expires: 'Läuft ab',
        classLabels: {
          commercial: 'Kommerziell',
          manual: 'Manual Grant',
          test: 'Testlizenz',
          unlicensed: 'Nicht lizenziert',
        },
        environmentLabels: {
          development: 'Development',
          test: 'Test',
          staging: 'Staging',
          production: 'Production',
        },
        testLicense: 'TESTLIZENZ',
        manualGrant: 'MANUAL GRANT',
        nonBillable: 'NICHT ABRECHENBAR',
        commercialLicense: 'Kommerzielle Lizenz',
        testLicenseNotice:
          'Diese environment-gebundene Testlizenz erzeugt keine Abrechnung und ist kein produktives Stripe-Abo.',
        manualGrantNotice:
          'Diese Lizenz wurde manuell gewährt, ist nicht abrechenbar und wird nicht als Stripe-Abonnement dargestellt.',
        commercialLicenseNotice:
          'Kommerzielle Seats werden mit dem bestätigten Billing-Stand abgeglichen.',
        health: {
          healthy: 'Synchron',
          stale: 'Synchronisierung überfällig',
          attention: 'Aktion erforderlich',
          never: 'Noch nicht synchronisiert',
        },
        seats: {
          observed: 'Aktiv',
          observedDetail: 'lokal aktiv und gemeldet',
          billed: 'Abgerechnet',
          billedDetail: 'vom Billing-Provider bestätigt',
          licensed: 'Lizenziert',
          licensedDetail: 'durch das Zertifikat freigegeben',
          approved: 'Freigegeben',
        },
        connection: 'Control-Plane-Verbindung',
        connectionStates: {
          idle: 'Nicht verbunden',
          canceled: 'Verbindung abgebrochen',
          authorization_pending: 'Bestätigung ausstehend',
          connected: 'Verbunden',
          reconnect_required: 'Neu verbinden',
        },
        lastSync: 'Letzter erfolgreicher Abgleich',
        nextSync: 'Nächster geplanter Abgleich',
        pending: 'Offene Operationen',
        failed: 'Fehlgeschlagene Operationen',
        reconciliation: 'Reconciliation',
        support: 'Support erforderlich',
        yes: 'Ja',
        localCap: 'Sicheres lokales Limit',
        grace: 'Offline-Grace',
        graceUntil: 'Zugriff bleibt lokal signiert bis',
        refreshPhase: 'Zertifikats-Refresh',
        noGrace: 'Keine Grace aktiv',
        syncNow: 'Memberships jetzt abgleichen',
        refreshLicense: 'Lizenzzertifikat aktualisieren',
        reconnect: 'Verbindung reparieren',
        safety: 'Diese Recovery-Aktionen kaufen keine Seats und bestätigen keine Kosten.',
        queuedSync: 'Membership-Abgleich wurde eingeplant.',
        queuedRefresh: 'Lizenz-Refresh wurde eingeplant.',
        actionFailed: 'Recovery-Aktion konnte nicht eingeplant werden.',
        unknown: 'Nicht verfügbar',
      }
    : {
        title: 'Team license health',
        description: 'Local reconciliation of active members, billing, and signed access.',
        ownerOnly: 'This operations and billing view is visible only to the organization owner.',
        unavailable: 'The local Team license health could not be loaded.',
        reload: 'Reload',
        licenseDetails: 'License identity',
        licenseClass: 'License class',
        environment: 'Environment',
        seatLimit: 'Seat limit',
        expires: 'Expires',
        classLabels: {
          commercial: 'Commercial',
          manual: 'Manual grant',
          test: 'Test license',
          unlicensed: 'Unlicensed',
        },
        environmentLabels: {
          development: 'Development',
          test: 'Test',
          staging: 'Staging',
          production: 'Production',
        },
        testLicense: 'TEST LICENSE',
        manualGrant: 'MANUAL GRANT',
        nonBillable: 'NON-BILLABLE',
        commercialLicense: 'Commercial license',
        testLicenseNotice:
          'This environment-bound test license never creates billing and is not a production Stripe subscription.',
        manualGrantNotice:
          'This license was granted manually, is non-billable, and is not represented as a Stripe subscription.',
        commercialLicenseNotice:
          'Commercial Seats are reconciled with the confirmed billing state.',
        health: {
          healthy: 'In sync',
          stale: 'Sync overdue',
          attention: 'Action required',
          never: 'Not synchronized yet',
        },
        seats: {
          observed: 'Active',
          observedDetail: 'locally active and reported',
          billed: 'Billed',
          billedDetail: 'confirmed by the billing provider',
          licensed: 'Licensed',
          licensedDetail: 'allowed by the signed certificate',
          approved: 'Approved',
        },
        connection: 'Control Plane connection',
        connectionStates: {
          idle: 'Not connected',
          canceled: 'Connection canceled',
          authorization_pending: 'Confirmation pending',
          connected: 'Connected',
          reconnect_required: 'Reconnect required',
        },
        lastSync: 'Last successful sync',
        nextSync: 'Next scheduled sync',
        pending: 'Pending operations',
        failed: 'Failed operations',
        reconciliation: 'Reconciliation',
        support: 'Support required',
        yes: 'Yes',
        localCap: 'Safe local limit',
        grace: 'Offline grace',
        graceUntil: 'Locally signed access remains valid until',
        refreshPhase: 'Certificate refresh',
        noGrace: 'No grace period active',
        syncNow: 'Sync memberships now',
        refreshLicense: 'Refresh license certificate',
        reconnect: 'Repair connection',
        safety: 'These recovery actions never purchase Seats or confirm costs.',
        queuedSync: 'Membership sync was scheduled.',
        queuedRefresh: 'License refresh was scheduled.',
        actionFailed: 'The recovery action could not be scheduled.',
        unknown: 'Unavailable',
      };
}

function formatDate(value: string | null, locale: string, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatDuration(seconds: number | null, locale: string): string | null {
  if (seconds === null) return null;
  const minutes = Math.max(0, Math.ceil(seconds / 60));
  if (minutes < 60) return new Intl.NumberFormat(locale).format(minutes) + ' min';
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return new Intl.NumberFormat(locale).format(hours) + ' h';
  return new Intl.NumberFormat(locale).format(Math.ceil(hours / 24)) + ' d';
}

function SeatMetric({
  label,
  value,
  detail,
  emphasis = false,
}: {
  label: string;
  value: number | null;
  detail: string;
  emphasis?: boolean;
}) {
  return (
    <div className={[
      'relative overflow-hidden border px-4 py-3',
      emphasis
        ? 'border-primary/35 bg-primary/[0.045]'
        : 'border-border/80 bg-background/60',
    ].join(' ')}>
      <div className="absolute inset-y-0 left-0 w-0.5 bg-current opacity-50" aria-hidden="true" />
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-2 font-mono text-3xl font-semibold tabular-nums">
        {value ?? '—'}
      </p>
      <p className="mt-1 text-xs leading-4 text-muted-foreground">{detail}</p>
    </div>
  );
}

export function TeamSeatHealthPanel({
  health,
  onReload,
}: {
  health: TeamSeatHealth | null | undefined;
  onReload?: () => void | Promise<void>;
}) {
  const locale = useLocale();
  const copy = useMemo(() => copyFor(locale), [locale]);
  const [activeAction, setActiveAction] = useState<RecoveryAction | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function runRecovery(action: RecoveryAction) {
    setActiveAction(action);
    setActionMessage(null);
    setActionError(null);
    try {
      const response = await fetch('/api/license/team/recovery', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        error?: string;
      };
      if (!response.ok || payload.success !== true) {
        throw new Error(payload.error || copy.actionFailed);
      }
      setActionMessage(action === 'sync_snapshot'
        ? copy.queuedSync
        : copy.queuedRefresh);
      await onReload?.();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : copy.actionFailed);
    } finally {
      setActiveAction(null);
    }
  }

  if (health === undefined) {
    return (
      <Card className="overflow-hidden py-0">
        <div className="h-1 bg-muted" />
        <CardHeader className="px-4 pt-5 sm:px-6">
          <Skeleton className="h-6 w-52" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </CardHeader>
        <CardContent className="grid gap-3 px-4 pb-5 sm:grid-cols-3 sm:px-6">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </CardContent>
      </Card>
    );
  }

  if (!health) {
    return (
      <Card className="border-amber-500/25 bg-amber-500/[0.035]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            {copy.title}
          </CardTitle>
          <CardDescription>{copy.unavailable}</CardDescription>
        </CardHeader>
        {onReload ? (
          <CardContent>
            <Button type="button" variant="outline" onClick={() => void onReload()}>
              <RefreshCw />
              {copy.reload}
            </Button>
          </CardContent>
        ) : null}
      </Card>
    );
  }

  const tone = health.sync.state === 'healthy'
    ? {
        line: 'bg-emerald-500',
        badge: 'border-emerald-500/35 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
        icon: <CheckCircle2 className="h-5 w-5" />,
      }
    : health.sync.state === 'attention'
      ? {
          line: 'bg-rose-500',
          badge: 'border-rose-500/35 bg-rose-500/10 text-rose-800 dark:text-rose-200',
          icon: <AlertTriangle className="h-5 w-5" />,
        }
      : {
          line: 'bg-amber-500',
          badge: 'border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-200',
          icon: <Clock3 className="h-5 w-5" />,
        };
  const graceRemaining = formatDuration(health.grace.remainingSeconds, locale);
  const licenseClass = health.license.class;
  const licenseLabel = licenseClass
    ? copy.classLabels[licenseClass]
    : copy.classLabels.unlicensed;
  const environmentLabel = health.license.environment
    ? copy.environmentLabels[health.license.environment]
    : copy.unknown;
  const licenseBanner = licenseClass === 'test'
    ? {
        title: copy.testLicense,
        notice: copy.testLicenseNotice,
        className: 'border-amber-500/40 bg-amber-500/[0.08]',
        badgeClassName: 'border-amber-600/40 bg-amber-500/15 text-amber-900 dark:text-amber-100',
      }
    : licenseClass === 'manual'
      ? {
          title: copy.manualGrant,
          notice: copy.manualGrantNotice,
          className: 'border-sky-500/35 bg-sky-500/[0.07]',
          badgeClassName: 'border-sky-600/35 bg-sky-500/15 text-sky-900 dark:text-sky-100',
        }
      : {
          title: copy.commercialLicense,
          notice: copy.commercialLicenseNotice,
          className: 'border-border/80 bg-background/50',
          badgeClassName: 'border-border bg-muted/50 text-foreground',
        };

  return (
    <Card className="overflow-hidden border-border/80 bg-card py-0">
      <div className={`h-1 ${tone.line}`} />
      <CardHeader className="gap-4 px-4 pb-0 pt-5 sm:px-6 sm:pt-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
              <Activity className="h-5 w-5" />
              {copy.title}
            </CardTitle>
            <CardDescription className="mt-1.5 max-w-3xl leading-5">
              {copy.description}
            </CardDescription>
          </div>
          <Badge variant="outline" className={`w-fit gap-1.5 ${tone.badge}`}>
            {tone.icon}
            {copy.health[health.sync.state]}
          </Badge>
        </div>
        <p className="border-l-2 border-border pl-3 text-xs leading-5 text-muted-foreground">
          {copy.ownerOnly}
        </p>
      </CardHeader>

      <CardContent className="space-y-4 px-4 pb-5 pt-4 sm:px-6 sm:pb-6">
        <section
          className={`border p-4 ${licenseBanner.className}`}
          aria-label={copy.licenseDetails}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={licenseBanner.badgeClassName}>
                  {licenseBanner.title}
                </Badge>
                {health.license.nonBillable ? (
                  <Badge
                    variant="outline"
                    className="border-rose-500/40 bg-rose-500/10 font-bold tracking-wide text-rose-800 dark:text-rose-100"
                  >
                    {copy.nonBillable}
                  </Badge>
                ) : null}
              </div>
              <p className="mt-2 max-w-3xl text-sm leading-5 text-muted-foreground">
                {licenseBanner.notice}
              </p>
            </div>
          </div>
          <dl className="mt-4 grid gap-3 border-t border-current/10 pt-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">{copy.licenseClass}</dt>
              <dd className="mt-1 font-semibold">{licenseLabel}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{copy.environment}</dt>
              <dd className="mt-1 font-mono font-semibold uppercase tracking-wide">
                {environmentLabel}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{copy.seatLimit}</dt>
              <dd className="mt-1 font-mono font-semibold tabular-nums">
                {health.license.seatLimit ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{copy.expires}</dt>
              <dd className="mt-1 font-semibold">
                {formatDate(health.license.expiresAt, locale, copy.unknown)}
              </dd>
            </div>
          </dl>
        </section>

        <div className="grid gap-3 sm:grid-cols-3">
          <SeatMetric
            label={copy.seats.observed}
            value={health.sync.observedQuantity}
            detail={copy.seats.observedDetail}
          />
          <SeatMetric
            label={copy.seats.billed}
            value={health.sync.billedQuantity}
            detail={copy.seats.billedDetail}
          />
          <SeatMetric
            label={copy.seats.licensed}
            value={health.sync.licensedQuantity}
            detail={copy.seats.licensedDetail}
            emphasis
          />
        </div>

        <div className="grid border border-border/80 bg-muted/15 lg:grid-cols-2">
          <div className="space-y-3 border-b border-border/80 p-4 lg:border-b-0 lg:border-r">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {copy.connection}
              </p>
              <Badge variant={health.claim.state === 'connected' ? 'default' : 'outline'}>
                {copy.connectionStates[health.claim.state]}
              </Badge>
            </div>
            <dl className="grid gap-2 text-sm">
              <div className="flex items-start justify-between gap-4">
                <dt className="text-muted-foreground">{copy.lastSync}</dt>
                <dd className="text-right font-medium">
                  {formatDate(health.sync.lastSyncAt, locale, copy.unknown)}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-4">
                <dt className="text-muted-foreground">{copy.nextSync}</dt>
                <dd className="text-right">
                  {formatDate(health.sync.nextReportAt, locale, copy.unknown)}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-4">
                <dt className="text-muted-foreground">{copy.pending}</dt>
                <dd className="font-mono tabular-nums">{health.sync.pendingOperations}</dd>
              </div>
              <div className="flex items-start justify-between gap-4">
                <dt className="text-muted-foreground">{copy.failed}</dt>
                <dd className="font-mono tabular-nums">{health.sync.failedOperations}</dd>
              </div>
            </dl>
          </div>

          <div className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {copy.reconciliation}
              </p>
              <Badge variant="outline">
                {health.sync.reconciliationStatus || health.sync.driftStatus || copy.unknown}
              </Badge>
            </div>
            <dl className="grid gap-2 text-sm">
              <div className="flex items-start justify-between gap-4">
                <dt className="text-muted-foreground">{copy.seats.approved}</dt>
                <dd className="font-mono tabular-nums">{health.sync.approvedQuantity ?? '—'}</dd>
              </div>
              <div className="flex items-start justify-between gap-4">
                <dt className="text-muted-foreground">{copy.localCap}</dt>
                <dd className="font-mono tabular-nums">{health.sync.reconciliationSeatLimit ?? '—'}</dd>
              </div>
              <div className="flex items-start justify-between gap-4">
                <dt className="text-muted-foreground">{copy.support}</dt>
                <dd>{health.sync.supportRequired ? copy.yes : '—'}</dd>
              </div>
              {health.sync.reconciliationReason ? (
                <div className="grid gap-1 border-t border-border/70 pt-2">
                  <dt className="text-muted-foreground">{copy.reconciliation}</dt>
                  <dd className="break-words font-mono text-[11px] leading-4">
                    {health.sync.reconciliationReason}
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>
        </div>

        <div className={[
          'grid gap-3 border p-4 sm:grid-cols-[auto_minmax(0,1fr)]',
          health.grace.licenseState === 'grace' || health.grace.licenseState === 'grace_required'
            ? 'border-amber-500/30 bg-amber-500/[0.045]'
            : 'border-border/80 bg-background/50',
        ].join(' ')}>
          <ShieldCheck className="mt-0.5 h-5 w-5 text-muted-foreground" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold">{copy.grace}</p>
              <Badge variant="outline">{health.grace.licenseState}</Badge>
            </div>
            {health.grace.expiresAt ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {copy.graceUntil}{' '}
                <span className="font-medium text-foreground">
                  {formatDate(health.grace.expiresAt, locale, copy.unknown)}
                </span>
                {graceRemaining ? ` · ${graceRemaining}` : ''}
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">{copy.noGrace}</p>
            )}
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              {copy.refreshPhase}: {health.grace.refreshPhase || copy.unknown}
              {health.grace.nextRefreshAt
                ? ` · ${formatDate(health.grace.nextRefreshAt, locale, copy.unknown)}`
                : ''}
            </p>
          </div>
        </div>

        <div className="grid gap-3 border-t border-border/80 pt-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="min-w-0">
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              {health.recovery.reconnectRequired
                ? <Link2Off className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                : <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />}
              <span>{copy.safety}</span>
            </p>
            {actionMessage ? (
              <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-300" role="status">
                {actionMessage}
              </p>
            ) : null}
            {actionError ? (
              <p className="mt-2 text-sm text-destructive" role="alert">{actionError}</p>
            ) : null}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            {health.recovery.reconnectRequired ? (
              <Button asChild variant="outline">
                <a href="#community-team-connection">
                  <Link2Off />
                  {copy.reconnect}
                </a>
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={() => void runRecovery('sync_snapshot')}
              disabled={!health.recovery.canSyncSnapshot || activeAction !== null}
            >
              {activeAction === 'sync_snapshot'
                ? <Loader2 className="animate-spin" />
                : <RotateCcw />}
              {copy.syncNow}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void runRecovery('refresh_license')}
              disabled={!health.recovery.canRefreshLicense || activeAction !== null}
            >
              {activeAction === 'refresh_license'
                ? <Loader2 className="animate-spin" />
                : <RefreshCw />}
              {copy.refreshLicense}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
