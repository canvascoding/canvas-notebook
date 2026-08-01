'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale } from 'next-intl';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Circle,
  Clipboard,
  ExternalLink,
  Link2,
  Loader2,
  RefreshCw,
  Server,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type ClaimIdle = {
  state: 'idle' | 'canceled';
  claimId: string | null;
};

type ClaimPending = {
  state: 'authorization_pending';
  claimId: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  retryAfterSeconds: number;
  lastErrorCode: string | null;
};

type ClaimConnected = {
  state: 'connected';
  claimId: string | null;
  organizationId: string | null;
  token: {
    configured: boolean;
    expiresAt: string | null;
    expired: boolean;
  };
};

type ClaimReconnectRequired = {
  state: 'reconnect_required';
  claimId: null;
  reason: 'expired' | 'revoked' | 'invalid' | 'lost' | 'rotation_failed';
  detectedAt: string;
  coreUnaffected: true;
  teamAccessPolicy: 'signed_certificate_until_expiry';
};

type ClaimStatus = ClaimIdle | ClaimPending | ClaimConnected | ClaimReconnectRequired;

type TeamPreflight = {
  connected: true;
  accountVerified: boolean;
  ready: boolean;
  nextAction: 'resolve_blockers' | 'manage_seats' | 'start_checkout';
  hostingMode: 'community';
  runtime: {
    notebookVersion: string;
    minimumNotebookVersion: string | null;
    versionSupported: boolean;
    databaseEngine: 'postgres' | 'sqlite' | 'other';
    teamReady: boolean;
  };
  team: {
    active: boolean;
    billingStatus: string | null;
    licensedQuantity: number;
    nonBillable: boolean;
  };
  blockers: Array<{ code: string; message: string }>;
  managementUrl: string | null;
};

type ApiFailure = {
  success?: false;
  error?: string;
  code?: string;
  retryable?: boolean;
  retryAfterSeconds?: number | null;
};

function getCopy(locale: string) {
  const de = locale.startsWith('de');
  return de
    ? {
        title: 'Control Plane & Team',
        description:
          'Verbinde diese Community-Instanz freiwillig mit deinem Canvas Account. Das Hosting, deine Daten und die Administration bleiben auf deinem eigenen Server.',
        selfHosted: 'Self-hosted bleibt self-hosted',
        selfHostedDetail:
          'Die Verbindung überträgt weder Workspaces noch Secrets. Sie bestätigt nur, welcher verifizierte Account diese Instanz verwaltet und künftig Team-Abrechnung autorisieren darf.',
        licenseRequired: 'Aktiviere zuerst die kostenlose Community-Lizenz. Canvas Core bleibt auch ohne Aktivierung nutzbar.',
        managedInstance: 'Diese Instanz wird bereits durch die Canvas Control Plane verwaltet.',
        connection: 'Verbindung',
        account: 'Account',
        team: 'Team',
        optional: 'Optional',
        connected: 'Verbunden',
        reconnectRequired: 'Erneute Verbindung erforderlich',
        waiting: 'Wartet auf Bestätigung',
        notConnected: 'Nicht verbunden',
        unavailable: 'Nicht verfügbar',
        connect: 'Mit Control Plane verbinden',
        reconnect: 'Sicher erneut verbinden',
        connecting: 'Verbindung wird vorbereitet',
        claimCode: 'Bestätigungscode',
        copyCode: 'Code kopieren',
        copied: 'Code kopiert',
        openAccount: 'Account erstellen oder anmelden',
        waitingDetail:
          'Öffne die Control Plane, melde dich an oder erstelle einen Account und bestätige dort exakt diese Instanz.',
        expires: 'Code gültig bis',
        cancel: 'Abbrechen',
        verified: 'Der Control-Plane-Account und die Eigentümer-Organisation wurden verifiziert.',
        reconnectDetail:
          'Das lokale Instanz-Token ist abgelaufen, wurde widerrufen oder konnte nicht sicher fortgeführt werden. Canvas Core bleibt nutzbar. Für Team-Synchronisierung muss derselbe Control-Plane-Owner die Instanz erneut bestätigen.',
        graceDetail:
          'Bestehender Team-Zugriff folgt bis zur Wiederherstellung weiterhin ausschließlich dem lokal geprüften, signierten Lizenzzertifikat und dessen Ablauf.',
        tokenExpiry: 'Serververbindung gültig bis',
        permanent: 'ohne gemeldetes Ablaufdatum',
        rotate: 'Verbindungsschlüssel rotieren',
        rotating: 'Verbindungsschlüssel wird rotiert',
        rotated: 'Verbindungsschlüssel wurde sicher rotiert',
        preflight: 'Team-Upgrade prüfen',
        checking: 'Team-Bereitschaft wird geprüft',
        preflightHint:
          'Diese Prüfung kauft nichts. Sie prüft Account, Notebook-Version, Datenbank und Team-Runtime getrennt vom Verbindungsprozess.',
        ready: 'Bereit für Team',
        alreadyTeam: 'Team ist aktiv',
        blockers: 'Vor dem Team-Upgrade noch erforderlich',
        openCheckout: 'Team-Upgrade in Control Plane fortsetzen',
        manageTeam: 'Team in Control Plane verwalten',
        checkoutHint:
          'Der kostenpflichtige Schritt findet ausschließlich in der Control Plane statt. Zahlungsdaten oder Stripe-IDs werden nie an dieses Browserfenster ausgegeben.',
        refresh: 'Status aktualisieren',
        statusError: 'Der Verbindungsstatus konnte nicht geladen werden.',
        startError: 'Die Verbindung konnte nicht gestartet werden.',
        pollError: 'Die Bestätigung konnte noch nicht geprüft werden.',
        preflightError: 'Der Team-Preflight ist fehlgeschlagen.',
        licensePlan: 'Community-Lizenz',
      }
    : {
        title: 'Control Plane & Team',
        description:
          'Optionally connect this Community instance to your Canvas account. Hosting, data and administration remain on your own server.',
        selfHosted: 'Self-hosted stays self-hosted',
        selfHostedDetail:
          'The connection transfers neither workspaces nor secrets. It only confirms which verified account manages this instance and may authorize future Team billing.',
        licenseRequired: 'Activate the free Community license first. Canvas Core remains available without activation.',
        managedInstance: 'This instance is already managed through Canvas Control Plane.',
        connection: 'Connection',
        account: 'Account',
        team: 'Team',
        optional: 'Optional',
        connected: 'Connected',
        reconnectRequired: 'Reconnection required',
        waiting: 'Waiting for confirmation',
        notConnected: 'Not connected',
        unavailable: 'Unavailable',
        connect: 'Connect to Control Plane',
        reconnect: 'Reconnect securely',
        connecting: 'Preparing connection',
        claimCode: 'Confirmation code',
        copyCode: 'Copy code',
        copied: 'Code copied',
        openAccount: 'Create account or sign in',
        waitingDetail:
          'Open Control Plane, sign in or create an account, then confirm this exact instance there.',
        expires: 'Code valid until',
        cancel: 'Cancel',
        verified: 'The Control Plane account and owner organization have been verified.',
        reconnectDetail:
          'The local instance token expired, was revoked or could not be continued safely. Canvas Core remains available. The same Control Plane owner must confirm this instance again for Team synchronization.',
        graceDetail:
          'Until recovery, existing Team access continues to follow only the locally verified signed license certificate and its expiry.',
        tokenExpiry: 'Server connection valid until',
        permanent: 'no expiry reported',
        rotate: 'Rotate connection key',
        rotating: 'Rotating connection key',
        rotated: 'Connection key rotated securely',
        preflight: 'Check Team upgrade',
        checking: 'Checking Team readiness',
        preflightHint:
          'This check purchases nothing. It verifies account, Notebook version, database and Team runtime separately from the connection flow.',
        ready: 'Ready for Team',
        alreadyTeam: 'Team is active',
        blockers: 'Required before the Team upgrade',
        openCheckout: 'Continue Team upgrade in Control Plane',
        manageTeam: 'Manage Team in Control Plane',
        checkoutHint:
          'The paid step happens only in Control Plane. Payment data and Stripe IDs are never returned to this browser window.',
        refresh: 'Refresh status',
        statusError: 'The connection status could not be loaded.',
        startError: 'The connection could not be started.',
        pollError: 'The confirmation could not be checked yet.',
        preflightError: 'The Team preflight failed.',
        licensePlan: 'Community license',
      };
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json().catch(() => ({})) as ApiFailure & T;
  if (!response.ok || payload.success === false) {
    const error = new Error(payload.error || 'Request failed') as Error & {
      code?: string;
      retryable?: boolean;
      retryAfterSeconds?: number | null;
    };
    error.code = payload.code;
    error.retryable = payload.retryable;
    error.retryAfterSeconds = payload.retryAfterSeconds;
    throw error;
  }
  return payload;
}

function Step({
  label,
  detail,
  complete,
  active,
}: {
  label: string;
  detail: string;
  complete: boolean;
  active: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        className={[
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border',
          complete
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            : active
              ? 'border-foreground/30 bg-foreground/5 text-foreground'
              : 'border-border text-muted-foreground',
        ].join(' ')}
      >
        {complete ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-2.5 w-2.5" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[11px] font-semibold uppercase tracking-[0.14em]">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
    </div>
  );
}

export function CommunityTeamConnectionPanel({
  licensed,
  licensePlan,
}: {
  licensed: boolean;
  licensePlan: string;
}) {
  const locale = useLocale();
  const copy = useMemo(() => getCopy(locale), [locale]);
  const [claim, setClaim] = useState<ClaimStatus | null>(null);
  const [preflight, setPreflight] = useState<TeamPreflight | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [checkingTeam, setCheckingTeam] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isManaged = licensePlan === 'managed';
  const connected = claim?.state === 'connected';
  const pending = claim?.state === 'authorization_pending' ? claim : null;
  const reconnect = claim?.state === 'reconnect_required' ? claim : null;

  const loadStatus = useCallback(async () => {
    setError(null);
    try {
      const payload = await apiRequest<{ success: true; claim: ClaimStatus }>('/api/license/claim/status');
      setClaim(payload.claim);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : copy.statusError);
    } finally {
      setLoading(false);
    }
  }, [copy.statusError]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadStatus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadStatus]);

  const pollClaim = useCallback(async (claimId: string) => {
    setPolling(true);
    try {
      const payload = await apiRequest<{ success: true; claim: ClaimStatus }>(
        '/api/license/claim/poll',
        { method: 'POST', body: JSON.stringify({ claimId }) },
      );
      setError(null);
      setClaim(payload.claim);
      if (payload.claim.state === 'connected') {
        toast.success(copy.connected);
      }
    } catch (requestError) {
      const retryAfterSeconds = requestError instanceof Error
        && 'retryAfterSeconds' in requestError
        && typeof requestError.retryAfterSeconds === 'number'
        ? requestError.retryAfterSeconds
        : 10;
      setError(requestError instanceof Error ? requestError.message : copy.pollError);
      setClaim((current) => (
        current?.state === 'authorization_pending' && current.claimId === claimId
          ? { ...current, retryAfterSeconds }
          : current
      ));
    } finally {
      setPolling(false);
    }
  }, [copy.connected, copy.pollError]);

  useEffect(() => {
    if (!pending || polling) return;
    const delay = Math.max(1, pending.retryAfterSeconds || 1) * 1000;
    const timer = window.setTimeout(() => {
      void pollClaim(pending.claimId);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [pending, pollClaim, polling]);

  async function startClaim() {
    setStarting(true);
    setError(null);
    setPreflight(null);
    try {
      const payload = await apiRequest<{ success: true; claim: ClaimStatus }>(
        '/api/license/claim/start',
        { method: 'POST' },
      );
      setClaim(payload.claim);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : copy.startError);
    } finally {
      setStarting(false);
    }
  }

  async function cancelClaim() {
    if (!pending) return;
    setCanceling(true);
    try {
      const payload = await apiRequest<{ success: true; claim: ClaimStatus }>(
        '/api/license/claim/cancel',
        { method: 'POST', body: JSON.stringify({ claimId: pending.claimId }) },
      );
      setClaim(payload.claim);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : copy.pollError);
    } finally {
      setCanceling(false);
    }
  }

  async function copyClaimCode() {
    if (!pending) return;
    try {
      await navigator.clipboard.writeText(pending.userCode);
      toast.success(copy.copied);
    } catch {
      toast.error(copy.copyCode);
    }
  }

  async function runPreflight() {
    setCheckingTeam(true);
    setError(null);
    try {
      const payload = await apiRequest<{ success: true; preflight: TeamPreflight }>(
        '/api/license/team/preflight',
        { method: 'POST' },
      );
      setPreflight(payload.preflight);
    } catch (requestError) {
      setPreflight(null);
      setError(requestError instanceof Error ? requestError.message : copy.preflightError);
      await loadStatus();
    } finally {
      setCheckingTeam(false);
    }
  }

  async function rotateConnection() {
    setRotating(true);
    setError(null);
    try {
      const payload = await apiRequest<{ success: true; claim: ClaimStatus }>(
        '/api/license/claim/rotate',
        { method: 'POST' },
      );
      setClaim(payload.claim);
      toast.success(copy.rotated);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : copy.pollError);
      await loadStatus();
    } finally {
      setRotating(false);
    }
  }

  const connectionDetail = connected
    ? copy.connected
    : reconnect
      ? copy.reconnectRequired
    : pending
      ? copy.waiting
      : copy.notConnected;
  const accountComplete = connected;
  const teamComplete = preflight?.team.active === true;
  const canConnect = licensed && !isManaged && !pending && !connected;

  return (
    <Card className="overflow-hidden border-border/80 bg-card py-0">
      <div className="h-1 bg-[linear-gradient(90deg,var(--primary)_0_38%,transparent_38%_40%,var(--muted-foreground)_40%_41%,transparent_41%)] opacity-70" />
      <CardHeader className="gap-4 px-4 pb-0 pt-5 sm:px-6 sm:pt-6">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
              <Link2 className="h-5 w-5 shrink-0" />
              {copy.title}
            </CardTitle>
            <CardDescription className="max-w-3xl leading-5">{copy.description}</CardDescription>
          </div>
          <Badge variant={connected || isManaged ? 'default' : 'outline'} className="w-fit">
            {isManaged ? copy.connected : connected ? copy.connected : copy.optional}
          </Badge>
        </div>

        <div className="grid gap-3 border-y border-border/70 bg-muted/20 px-3 py-3 sm:grid-cols-3 sm:px-4">
          <Step label={copy.connection} detail={connectionDetail} complete={connected || isManaged} active={Boolean(pending)} />
          <Step label={copy.account} detail={accountComplete || isManaged ? copy.verified : copy.notConnected} complete={accountComplete || isManaged} active={Boolean(pending)} />
          <Step label={copy.team} detail={teamComplete ? copy.alreadyTeam : preflight?.ready ? copy.ready : copy.optional} complete={teamComplete} active={Boolean(preflight && !teamComplete)} />
        </div>
      </CardHeader>

      <CardContent className="space-y-4 px-4 pb-5 pt-4 sm:px-6 sm:pb-6">
        <div className="flex items-start gap-3 border border-border bg-background/70 p-3 sm:p-4">
          <Server className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{copy.selfHosted}</p>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">{copy.selfHostedDetail}</p>
          </div>
        </div>

        {!licensed && !isManaged ? (
          <p className="border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-300">
            {copy.licenseRequired}
          </p>
        ) : null}

        {isManaged ? (
          <div className="flex items-center gap-2 border border-emerald-500/25 bg-emerald-500/5 px-3 py-3 text-sm text-emerald-800 dark:text-emerald-300">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            {copy.managedInstance}
          </div>
        ) : null}

        {!isManaged && !pending && !connected && !reconnect ? (
          <Button
            type="button"
            onClick={() => void startClaim()}
            disabled={!canConnect || starting || loading}
            className="h-10 w-full sm:w-auto"
          >
            {starting || loading ? <Loader2 className="animate-spin" /> : <Link2 />}
            {starting ? copy.connecting : copy.connect}
          </Button>
        ) : null}

        {reconnect ? (
          <div className="grid gap-4 border border-amber-500/25 bg-amber-500/5 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">{copy.reconnectRequired}</p>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">{copy.reconnectDetail}</p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{copy.graceDetail}</p>
              <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                {reconnect.reason} · {new Date(reconnect.detectedAt).toLocaleString(locale)}
              </p>
            </div>
            <Button type="button" onClick={() => void startClaim()} disabled={starting || !licensed}>
              {starting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {starting ? copy.connecting : copy.reconnect}
            </Button>
          </div>
        ) : null}

        {pending ? (
          <div className="grid gap-4 border border-primary/25 bg-primary/[0.035] p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="min-w-0 space-y-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{copy.claimCode}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="border border-border bg-background px-3 py-2 font-mono text-lg font-semibold tracking-[0.18em]">
                    {pending.userCode}
                  </code>
                  <Button type="button" variant="outline" size="sm" onClick={() => void copyClaimCode()}>
                    <Clipboard />
                    {copy.copyCode}
                  </Button>
                </div>
              </div>
              <p className="text-sm leading-5 text-muted-foreground">{copy.waitingDetail}</p>
              <p className="text-xs text-muted-foreground">
                {copy.expires}: {new Date(pending.expiresAt).toLocaleString(locale)}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Button asChild className="h-10">
                <a href={pending.verificationUrl} target="_blank" rel="noopener noreferrer">
                  {copy.openAccount}
                  <ExternalLink />
                </a>
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void cancelClaim()}
                disabled={canceling}
              >
                {canceling ? <Loader2 className="animate-spin" /> : <X />}
                {copy.cancel}
              </Button>
              {polling ? (
                <span className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {copy.waiting}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {connected && !isManaged ? (
          <>
            <div className="flex items-start gap-3 border border-emerald-500/25 bg-emerald-500/5 p-3 sm:p-4">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">{copy.verified}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {copy.tokenExpiry}:{' '}
                  {claim.token.expiresAt
                    ? new Date(claim.token.expiresAt).toLocaleString(locale)
                    : copy.permanent}
                </p>
              </div>
            </div>

            <div className="grid gap-3 border border-border p-3 sm:p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <div>
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Users className="h-4 w-4" />
                  {copy.preflight}
                </p>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">{copy.preflightHint}</p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button type="button" variant="outline" onClick={() => void rotateConnection()} disabled={rotating || checkingTeam}>
                  {rotating ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                  {rotating ? copy.rotating : copy.rotate}
                </Button>
                <Button type="button" variant="outline" onClick={() => void runPreflight()} disabled={checkingTeam || rotating}>
                  {checkingTeam ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  {checkingTeam ? copy.checking : preflight ? copy.refresh : copy.preflight}
                </Button>
              </div>
            </div>
          </>
        ) : null}

        {preflight ? (
          <div
            className={[
              'space-y-3 border p-3 sm:p-4',
              preflight.ready
                ? 'border-emerald-500/25 bg-emerald-500/5'
                : 'border-amber-500/25 bg-amber-500/5',
            ].join(' ')}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold">
                {preflight.team.active ? copy.alreadyTeam : preflight.ready ? copy.ready : copy.blockers}
              </p>
              <Badge variant={preflight.ready ? 'default' : 'outline'}>
                {preflight.runtime.databaseEngine.toUpperCase()}
              </Badge>
            </div>
            {preflight.blockers.length > 0 ? (
              <ul className="space-y-2">
                {preflight.blockers.map((blocker) => (
                  <li key={`${blocker.code}:${blocker.message}`} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <Circle className="mt-1 h-2.5 w-2.5 shrink-0" />
                    <span>
                      {blocker.message}
                      <span className="ml-1 font-mono text-[10px] opacity-70">({blocker.code})</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {preflight.ready && preflight.managementUrl ? (
              <>
                <p className="text-xs leading-5 text-muted-foreground">{copy.checkoutHint}</p>
                <Button asChild className="h-10 w-full sm:w-auto">
                  <a href={preflight.managementUrl} target="_blank" rel="noopener noreferrer">
                    {preflight.nextAction === 'manage_seats' ? copy.manageTeam : copy.openCheckout}
                    <ArrowRight />
                  </a>
                </Button>
              </>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p aria-live="polite" className="break-words border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
