'use client';

import { useEffect, useMemo, useState } from 'react';
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
import { TeamLicenseEmailReview } from './TeamLicenseEmailReview';
import { SettingsAccordionCard } from '@/app/components/settings/SettingsAccordionCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
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
        expires: 'Zertifikat gültig bis',
        termEnds: 'Grant gültig bis',
        accessRestricted: 'Team-Zugriff eingeschränkt',
        accessGrace: 'Team-Zugriff in der Übergangsfrist',
        expiredGrant: 'Der Grant ist abgelaufen.',
        revokedGrant: 'Der Grant wurde entzogen.',
        policyAction: 'Den Grant in der Control Plane prüfen und erneuern oder erneut freigeben. Anschließend synchronisieren.',
        details: 'Synchronisierung und Lizenzdetails',
        notifications: 'Benachrichtigungen',
        notApplicable: 'Nicht anwendbar · nicht abrechenbar',
        confirmedDetail: 'von der Control Plane bestätigt',
        lastAttempt: 'Letzter Versuch',
        membershipRevision: 'Mitgliedschaftsrevision',
        entitlementsVersion: 'Berechtigungsversion',
        history: 'Frühere Community-Aufträge',
        historyNotice: 'Diese Aufträge gehören zum früheren Community-Modus und beeinflussen den aktuellen Managed-Abgleich nicht.',
        managedStates: {
          current: 'Bestätigt synchron',
          adoption_required: 'Adoption erforderlich',
          pending: 'Abgleich ausstehend',
          error: 'Abgleich fehlgeschlagen',
          stale: 'Abgleich veraltet',
          never: 'Noch nicht bestätigt',
        },
        managedActions: {
          current: 'Keine Aktion erforderlich.',
          adoption_required: 'Die Instanz muss in der Control Plane freigegeben werden.',
          pending: 'Der Abgleich wartet auf die Bestätigung der Control Plane.',
          error: 'Der letzte Abgleich ist fehlgeschlagen. Erneut synchronisieren oder die Details prüfen.',
          stale: 'Die letzte Bestätigung ist veraltet. Erneut synchronisieren.',
          never: 'Noch kein erfolgreicher Abgleich mit Bestätigung. Jetzt synchronisieren.',
        },
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
          approved: 'Bestätigt',
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
        notificationSetting: 'Lizenzereignisse im Notification Center anzeigen',
        notificationSettingDetail: 'Benachrichtigt dich als Owner über tatsächlich angewendete Zugangssperren und Wiederherstellungen. E-Mails werden dadurch nicht versendet.',
        emailNotificationSetting: 'E-Mail bei Team-Zugangsänderungen',
        emailNotificationSettingDetail: 'Sendet dem Owner und betroffenen Mitgliedern eine E-Mail nach einer tatsächlichen Sperre oder Wiederherstellung. Der System-E-Mail-Versand muss eingerichtet sein.',
        emailManualReview: 'Lizenz-E-Mails manuell prüfen',
        emailRetryPending: 'Lizenz-E-Mails warten auf Versand',
        notificationSettingUnavailable: 'Die Benachrichtigungseinstellung konnte nicht geladen oder gespeichert werden.',
        queuedSync: 'Membership-Abgleich wurde eingeplant.',
        queuedRefresh: 'Lizenz-Refresh wurde eingeplant.',
        actionFailed: 'Recovery-Aktion konnte nicht eingeplant werden.',
        organizationBlocker: 'Der Team-Abgleich ist blockiert: Community Team unterstützt derzeit genau eine lokale Organisation. Vor einem neuen Abgleich müssen die Organisationen geprüft und auf eine eindeutige Zuordnung gebracht werden. Offene Operationen bleiben erhalten.',
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
        expires: 'Certificate valid until',
        termEnds: 'Grant valid until',
        accessRestricted: 'Team access restricted',
        accessGrace: 'Team access in grace period',
        expiredGrant: 'The grant has expired.',
        revokedGrant: 'The grant was revoked.',
        policyAction: 'Check and renew or reapprove the grant in the Control Plane, then sync again.',
        details: 'Synchronization and license details',
        notifications: 'Notifications',
        notApplicable: 'Not applicable · non-billable',
        confirmedDetail: 'confirmed by the Control Plane',
        lastAttempt: 'Last attempt',
        membershipRevision: 'Membership revision',
        entitlementsVersion: 'Entitlements version',
        history: 'Previous Community operations',
        historyNotice: 'These operations belong to the previous Community mode and do not affect the current managed sync.',
        managedStates: {
          current: 'Confirmed in sync',
          adoption_required: 'Adoption required',
          pending: 'Sync pending',
          error: 'Sync failed',
          stale: 'Sync stale',
          never: 'Not confirmed yet',
        },
        managedActions: {
          current: 'No action required.',
          adoption_required: 'Approve this instance in the Control Plane.',
          pending: 'Sync is waiting for confirmation from the Control Plane.',
          error: 'The last sync failed. Sync again or inspect the details.',
          stale: 'The last confirmation is outdated. Sync again.',
          never: 'No successful sync with confirmation yet. Sync now.',
        },
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
          approved: 'Confirmed',
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
        notificationSetting: 'Show license events in the notification center',
        notificationSettingDetail: 'Notifies you as owner when team access is actually paused or restored. This does not send email.',
        emailNotificationSetting: 'Email for team access changes',
        emailNotificationSettingDetail: 'Emails the owner and affected members after access is actually paused or restored. System email delivery must be configured.',
        emailManualReview: 'License emails requiring manual review',
        emailRetryPending: 'License emails awaiting delivery',
        notificationSettingUnavailable: 'The notification setting could not be loaded or saved.',
        queuedSync: 'Membership sync was scheduled.',
        queuedRefresh: 'License refresh was scheduled.',
        actionFailed: 'The recovery action could not be scheduled.',
        organizationBlocker: 'Team sync is blocked: Community Team currently supports exactly one local organization. Review the organizations and establish a single authoritative mapping before syncing again. Pending operations are retained.',
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [activeAction, setActiveAction] = useState<RecoveryAction | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [licenseNotificationsEnabled, setLicenseNotificationsEnabled] = useState<boolean | null>(null);
  const [licenseEmailNotificationsEnabled, setLicenseEmailNotificationsEnabled] = useState<boolean | null>(null);
  const [savingNotificationSetting, setSavingNotificationSetting] = useState(false);
  const [notificationSettingError, setNotificationSettingError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/user-preferences', { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json() as { success?: boolean; data?: { teamLicenseNotificationsEnabled?: boolean; teamLicenseEmailNotificationsEnabled?: boolean } };
        if (!response.ok || !payload.success) throw new Error('Preference unavailable');
        if (!cancelled) {
          setLicenseNotificationsEnabled(payload.data?.teamLicenseNotificationsEnabled !== false);
          setLicenseEmailNotificationsEnabled(payload.data?.teamLicenseEmailNotificationsEnabled !== false);
        }
      })
      .catch(() => { if (!cancelled) setNotificationSettingError(true); });
    return () => { cancelled = true; };
  }, []);

  async function saveNotificationSetting(enabled: boolean) {
    setSavingNotificationSetting(true);
    setNotificationSettingError(false);
    try {
      const response = await fetch('/api/user-preferences', {
        method: 'PATCH', credentials: 'include', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamLicenseNotificationsEnabled: enabled }),
      });
      const payload = await response.json() as { success?: boolean };
      if (!response.ok || !payload.success) throw new Error('Preference update failed');
      setLicenseNotificationsEnabled(enabled);
      window.dispatchEvent(new CustomEvent('notification_summary_updated'));
    } catch {
      setNotificationSettingError(true);
    } finally {
      setSavingNotificationSetting(false);
    }
  }

  async function saveEmailNotificationSetting(enabled: boolean) {
    setSavingNotificationSetting(true);
    setNotificationSettingError(false);
    try {
      const response = await fetch('/api/user-preferences', {
        method: 'PATCH', credentials: 'include', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamLicenseEmailNotificationsEnabled: enabled }),
      });
      const payload = await response.json() as { success?: boolean };
      if (!response.ok || !payload.success) throw new Error('Preference update failed');
      setLicenseEmailNotificationsEnabled(enabled);
    } catch {
      setNotificationSettingError(true);
    } finally {
      setSavingNotificationSetting(false);
    }
  }

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
      <Card className="border-destructive bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-5 w-5 text-destructive" />
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

  const managed = health.mode === 'managed-team';
  const managedState = health.sync.managedState ?? 'never';
  const managedPolicy = managed ? health.managedAccessPolicy : null;
  const managedGrace = managedPolicy?.state === 'grace';
  const policyRequiresAction = managedPolicy?.state === 'restricted' || managedGrace;
  const managedCurrent = managedState === 'current'
    && (health.sync.state === 'healthy' || policyRequiresAction);
  const statusLabel = managed
    ? managedState === 'current' && !managedCurrent ? copy.health[health.sync.state] : copy.managedStates[managedState]
    : copy.health[health.sync.state];
  const attention = managed
    ? managedState === 'error' || managedState === 'stale' || managedState === 'adoption_required'
      || (!policyRequiresAction && (health.sync.state === 'attention' || health.sync.state === 'stale'))
    : health.sync.state === 'attention' || health.sync.state === 'stale';
  const healthy = managed ? managedCurrent : health.sync.state === 'healthy';
  const connectionLabel = managed
    ? healthy ? copy.connectionStates.connected
      : managedState === 'current' ? copy.health[health.sync.state] : copy.managedStates[managedState]
    : copy.connectionStates[health.claim.state];
  const graceActive = managedGrace || health.grace.licenseState === 'grace' || health.grace.licenseState === 'grace_required';
  const graceExpiry = managedGrace ? managedPolicy?.graceEndsAt ?? null : health.grace.expiresAt;
  const graceRemaining = managedGrace ? null : formatDuration(health.grace.remainingSeconds, locale);
  const licenseClass = health.license.class;
  const licenseLabel = licenseClass ? copy.classLabels[licenseClass] : copy.classLabels.unlicensed;
  const environmentLabel = health.license.environment
    ? copy.environmentLabels[health.license.environment] : copy.unknown;
  const licenseNotice = licenseClass === 'manual' ? copy.manualGrantNotice
    : licenseClass === 'test' ? copy.testLicenseNotice : copy.commercialLicenseNotice;
  const syncDetails = [
    [copy.lastSync, formatDate(health.sync.lastSyncAt, locale, copy.unknown)],
    [copy.nextSync, formatDate(health.sync.nextReportAt, locale, copy.unknown)],
    ...(managed ? [
      [copy.lastAttempt, formatDate(health.sync.lastAttemptAt ?? null, locale, copy.unknown)],
      [copy.membershipRevision, health.sync.membershipRevision ?? '—'],
      [copy.entitlementsVersion, health.sync.entitlementsVersion ?? '—'],
    ] : [
      [copy.pending, health.sync.pendingOperations],
      [copy.failed, health.sync.failedOperations],
    ]),
  ];

  return (
    <Card className="overflow-hidden border-border bg-card py-0">
      <CardHeader className="gap-3 px-4 pt-5 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-5 w-5" />{copy.title}
          </CardTitle>
          <Badge variant={attention ? 'destructive' : 'outline'} className="gap-1.5">
            {healthy ? <CheckCircle2 className="h-4 w-4" />
              : attention ? <AlertTriangle className="h-4 w-4" /> : <Clock3 className="h-4 w-4" />}
            {statusLabel}
          </Badge>
        </div>
        <CardDescription>{copy.description}</CardDescription>
        <p className="text-xs text-muted-foreground">
          {copy.connection}: {connectionLabel}
        </p>
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-5 sm:px-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <SeatMetric label={copy.seats.observed} value={health.sync.observedQuantity} detail={copy.seats.observedDetail} />
          <SeatMetric label={managed || health.license.nonBillable ? copy.seats.approved : copy.seats.billed}
            value={managed || health.license.nonBillable ? health.sync.approvedQuantity : health.sync.billedQuantity}
            detail={managed || health.license.nonBillable ? copy.confirmedDetail : copy.seats.billedDetail} />
          <SeatMetric label={copy.seats.licensed} value={health.sync.licensedQuantity} detail={copy.seats.licensedDetail} emphasis />
        </div>
        {health.sync.blocker === 'TEAM_SEAT_SUBJECT_CONFLICT' ? (
          <p role="alert" className="border border-destructive p-3 text-sm text-destructive">{copy.organizationBlocker}</p>
        ) : null}
        {managed && !(managedState === 'current' && (policyRequiresAction || graceActive)) ? <p role={attention ? 'alert' : 'status'} className={attention ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
          {copy.managedActions[managedState]}
        </p> : null}
        {policyRequiresAction ? <div role="alert" className="space-y-1 border border-destructive p-3 text-sm text-destructive">
          <p className="font-semibold">{managedGrace ? copy.accessGrace : copy.accessRestricted}</p>
          {managedPolicy?.reason ? <p>{managedPolicy.reason === 'grant_expired' ? copy.expiredGrant : copy.revokedGrant}</p> : null}
          {managedGrace ? <p>{copy.graceUntil} {formatDate(graceExpiry, locale, copy.unknown)}</p> : null}
          <p>{copy.policyAction}</p>
        </div> : null}
        {health.sync.lastError ? (
          <p role="alert" className="break-words border-l-2 border-destructive pl-3 text-sm text-destructive">
            {health.sync.lastError.code}
          </p>
        ) : null}
        {graceActive && !managedGrace ? (
          <div className="border border-destructive p-3 text-sm">
            <p className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4" />{copy.grace}</p>
            <p className="mt-1 text-muted-foreground">{copy.graceUntil} {formatDate(graceExpiry, locale, copy.unknown)}
              {graceRemaining ? ` · ${graceRemaining}` : ''}</p>
          </div>
        ) : null}
        {actionMessage ? <p className="text-sm text-muted-foreground" role="status">{actionMessage}</p> : null}
        {actionError ? <p className="text-sm text-destructive" role="alert">{actionError}</p> : null}
        {notificationSettingError ? <p role="alert" className="text-sm text-destructive">{copy.notificationSettingUnavailable}</p> : null}
        {(health.emailDelivery?.manualReview ?? 0) > 0 ? <p role="alert" className="text-sm text-destructive">
          {copy.emailManualReview}: {health.emailDelivery?.manualReview}
        </p> : null}
        <div className="flex flex-wrap gap-2">
          {!managed && health.recovery.reconnectRequired ? (
            <Button asChild variant="outline"><a href="#community-team-connection"><Link2Off />{copy.reconnect}</a></Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => void runRecovery('sync_snapshot')}
            disabled={!health.recovery.canSyncSnapshot || activeAction !== null}>
            {activeAction === 'sync_snapshot' ? <Loader2 className="animate-spin" /> : <RotateCcw />}{copy.syncNow}
          </Button>
          {!managed ? <Button type="button" variant="outline" onClick={() => void runRecovery('refresh_license')}
            disabled={!health.recovery.canRefreshLicense || activeAction !== null}>
            {activeAction === 'refresh_license' ? <Loader2 className="animate-spin" /> : <RefreshCw />}{copy.refreshLicense}
          </Button> : null}
        </div>
        <SettingsAccordionCard title={copy.details} isOpen={detailsOpen} onOpenChange={setDetailsOpen}
          cardClassName="[&_button]:rounded-none [&_span]:rounded-none" summaryItems={[licenseLabel, `${copy.seatLimit}: ${health.license.seatLimit ?? '—'}`]}>
          <section aria-label={copy.connection}>
            <dl className="grid gap-2 text-sm">
              {syncDetails.map(([label, value]) => <div key={label} className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted-foreground">{label}</dt><dd>{value}</dd>
              </div>)}
              {health.sync.lastError ? <div className="border-t border-border pt-2 text-destructive">
                <dt>{copy.actionFailed}</dt><dd>{[health.sync.lastError.code, health.sync.lastError.httpStatus, health.sync.lastError.endpoint].filter(Boolean).join(' · ')}</dd>
              </div> : null}
            </dl>
          </section>
          <section aria-label={copy.licenseDetails} className="space-y-3 border-t border-border pt-3">
            <div className="flex flex-wrap gap-2"><Badge variant="outline">{licenseLabel}</Badge>
              {health.license.nonBillable ? <Badge variant="outline">{copy.nonBillable}</Badge> : null}</div>
            <p className="text-xs text-muted-foreground">{licenseNotice}</p>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              {[
                [copy.environment, environmentLabel],
                [copy.expires, formatDate(health.license.expiresAt, locale, copy.unknown)],
                ...(licenseClass === 'manual' || licenseClass === 'test' ? [[copy.termEnds, formatDate(health.license.termEndsAt ?? null, locale, copy.unknown)]] : []),
                [copy.seats.billed, health.license.nonBillable ? copy.notApplicable : health.sync.billedQuantity ?? copy.unknown],
                [copy.reconciliation, health.sync.reconciliationStatus || health.sync.driftStatus || copy.unknown],
                [copy.localCap, health.sync.reconciliationSeatLimit ?? copy.unknown],
                [copy.support, health.sync.supportRequired ? copy.yes : '—'],
              ].map(([label, value]) => <div key={label}><dt className="text-xs uppercase tracking-wider text-muted-foreground">{label}</dt><dd className="mt-1">{value}</dd></div>)}
            </dl>
            {health.sync.reconciliationReason ? <p className="break-words text-xs text-muted-foreground">{health.sync.reconciliationReason}</p> : null}
            {!managed ? <p className="text-xs text-muted-foreground">{copy.refreshPhase}: {health.grace.refreshPhase || copy.unknown}</p> : null}
          </section>
          <p className="border-t border-border pt-3 text-xs text-muted-foreground">{copy.ownerOnly} {copy.safety}</p>
        </SettingsAccordionCard>
        <SettingsAccordionCard title={copy.notifications} isOpen={notificationsOpen} onOpenChange={setNotificationsOpen}
          cardClassName="[&_button]:rounded-none [&_span]:rounded-none">
          <section className="flex items-start justify-between gap-4">
            <div><label htmlFor="team-license-notifications" className="text-sm font-medium">{copy.notificationSetting}</label>
              <p className="mt-1 text-xs text-muted-foreground">{copy.notificationSettingDetail}</p></div>
            <Switch id="team-license-notifications" checked={licenseNotificationsEnabled ?? true}
              onCheckedChange={(enabled) => void saveNotificationSetting(enabled)} disabled={licenseNotificationsEnabled === null || savingNotificationSetting}
              aria-label={copy.notificationSetting} />
          </section>
          <section className="flex items-start justify-between gap-4 border-t border-border pt-3">
            <div><label htmlFor="team-license-email-notifications" className="text-sm font-medium">{copy.emailNotificationSetting}</label>
              <p className="mt-1 text-xs text-muted-foreground">{copy.emailNotificationSettingDetail}</p></div>
            <Switch id="team-license-email-notifications" checked={licenseEmailNotificationsEnabled ?? true}
              onCheckedChange={(enabled) => void saveEmailNotificationSetting(enabled)} disabled={licenseEmailNotificationsEnabled === null || savingNotificationSetting}
              aria-label={copy.emailNotificationSetting} />
          </section>
          <dl className="grid gap-2 border-t border-border pt-3 text-sm">
            <div className="flex justify-between"><dt>{copy.emailRetryPending}</dt><dd>{health.emailDelivery?.retryPending ?? 0}</dd></div>
            <div className="flex justify-between"><dt>{copy.emailManualReview}</dt><dd>{health.emailDelivery?.manualReview ?? 0}</dd></div>
          </dl>
          <TeamLicenseEmailReview count={health.emailDelivery?.manualReview ?? 0} onReload={onReload} />
        </SettingsAccordionCard>
      </CardContent>
    </Card>
  );
}
