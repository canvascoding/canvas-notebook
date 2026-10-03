'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { CheckCircle2, ExternalLink, Info, KeyRound, Loader2, Mail, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { SettingsAccordionCard } from '@/app/components/settings/SettingsAccordionCard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { scrubLicenseKeyFromBrowserUrl } from '@/app/lib/license/browser-url';
import { codeFromLicenseError } from '@/app/lib/license/error-codes';
import type { TeamSeatHealth } from '@/app/lib/license/team-seat-health-types';
import { isTeamLicenseApplicable, licenseHostingVariant } from '@/app/lib/license/ui-policy';
import {
  CommunityTeamConnectionPanel,
  type TeamSeatRolloutStatus,
} from './CommunityTeamConnectionPanel';
import { TeamSeatHealthPanel } from './TeamSeatHealthPanel';
import {
  useLicenseEmailActivation,
  type PublicLicenseEmailActivation,
} from './useLicenseEmailActivation';

type LicenseStatus = {
  licensed: boolean;
  plan: string;
  instanceId: string;
  runtimeDeploymentMode?: string;
  hostingMode?: string | null;
  deploymentMode?: string | null;
  edition?: string | null;
  capabilities?: Record<string, boolean>;
  features?: Record<string, boolean>;
  expiresAt: string | null;
  error?: string;
  code?: string;
  teamSeatHealth?: TeamSeatHealth | null;
  teamSeatRollout?: TeamSeatRolloutStatus;
  success?: boolean;
};

function licenseErrorMessage(error?: string) {
  switch (error) {
    case 'missing_public_key':
    case 'public_key_unavailable':
      return 'License verification is unavailable. Configure the license public key or check the Control Plane connection.';
    case 'control_plane_unreachable':
      return 'Could not reach the license server. Check the Control Plane URL or network connection.';
    case 'untrusted_public_key':
      return 'The license server returned an untrusted public key. Check CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS.';
    case 'license_expired':
      return 'License expired. Please renew or activate a new license.';
    case 'license_status_unavailable':
      return 'The license status could not be loaded safely. Please retry before using Team features.';
    default:
      return error;
  }
}

function errorWithCode(message: string, code?: string) {
  return code ? `${message} (${code})` : message;
}

function getLicenseRegistrationActivationPath(fallback: string) {
  if (typeof window === 'undefined') return fallback;
  const url = new URL(window.location.href);
  url.searchParams.delete('key');
  return `${url.pathname}${url.search}` || fallback;
}

function getActivationCopy(locale: string) {
  const isGerman = locale.startsWith('de');
  return isGerman
    ? {
        title: 'Community-Lizenz',
        licenseTitle: 'Lizenz',
        managedTitle: 'Managed-Lizenz',
        verified: 'Die freiwillige Community-Lizenz ist für diese Instanz aktiv.',
        unverified: 'Die Aktivierung ist freiwillig. Canvas Notebook kann lokal auch ohne Community-Lizenz genutzt werden.',
        loading: 'Lade',
        unregistered: 'Community Solo · nicht registriert',
        activationTitle: 'Optionale Community-Aktivierung',
        activationDescription:
          'Wenn du dich dafür entscheidest, registriert die Aktivierung diese selbst gehostete Instanz bei Canvas und speichert ein signiertes Lizenzzertifikat lokal. Deine Instance ID und E-Mail werden zur Ausstellung verwendet; Workspace-Dateien, Prompts, API-Keys und lokale Daten werden nicht übertragen. Team-Funktionen benötigen weiterhin eine passende Team-Lizenz.',
        termsTitle: 'Lizenzbedingungen',
        termsDescription:
          'Canvas Notebook wird unter der Sustainable Use License 1.0 bereitgestellt. Sie erlaubt selbst gehostete interne geschäftliche Nutzung, private Nutzung und nicht-kommerzielle Nutzung. Nicht erlaubt ist, Canvas Notebook, modifizierte Versionen oder daraus abgeleitete gehostete Dienste Dritten als Managed Service oder konkurrierenden Dienst anzubieten.',
        renewalDescription:
          'Community-Lizenzen sind standardmäßig ein Jahr gültig und erneuern sich aktuell nicht automatisch. Wenn die Lizenz abläuft, kannst du hier einen neuen kostenlosen Key anfordern. Die lokalen Core-Funktionen bleiben auch ohne aktive Community-Lizenz verfügbar.',
        managedDescription:
          'Bei Nutzung über den offiziellen Canvas Notebook Vertriebskanal wird die Managed-Lizenz automatisch von Canvas ausgestellt und für diese Instanz aktiviert. Ein separater Aktivierungs-Key ist dafür nicht erforderlich.',
        viewLicense: 'Vollständige Lizenz anzeigen',
        instanceId: 'Instance ID',
        expires: 'Läuft ab',
        email: 'E-Mail',
        marketingOptInLabel: 'Newsletter erhalten',
        marketingOptInDescription:
          'Optional: Erhalte Produktneuigkeiten, Release-Hinweise und wichtige Canvas Notebook Updates per E-Mail. Du kannst dich jederzeit wieder abmelden.',
        sendKey: 'Key senden',
        emailSent: 'Aktivierungs-E-Mail gesendet',
        activationPendingTitle: 'Bestätigung ausstehend',
        activationPendingDescription:
          'Öffne die E-Mail auf einem beliebigen Gerät und bestätige dort die Aktivierung. Diese Notebook-Instanz übernimmt das signierte Zertifikat danach automatisch; die E-Mail muss nicht auf dem Server geöffnet werden.',
        activationCompleted: 'Lizenz automatisch aktiviert',
        activationKey: 'Aktivierungs-Key',
        activate: 'Aktivieren',
        statusUnavailableTitle: 'Lizenzstatus nicht verfügbar',
        statusUnavailableDescription: 'Die Lizenz konnte nicht sicher geladen werden. Team-Funktionen bleiben deaktiviert, bis der Status erneut geladen werden kann. Canvas Core bleibt lokal nutzbar.',
        retryStatus: 'Status erneut laden',
        details: 'Lizenzdetails und Bedingungen',
        openActivation: 'Freiwillig aktivieren',
        useKey: 'Vorhandenen Schlüssel verwenden',
        replaceLicense: 'Lizenz ersetzen oder erneuern',
        connection: 'Team-Verbindung verwalten',
        active: 'Aktiv',
        inactive: 'Nicht aktiviert',
        managedShort: 'Die Lizenz wird über Canvas verwaltet.',
      }
    : {
        title: 'Community license',
        licenseTitle: 'License',
        managedTitle: 'Managed license',
        verified: 'The optional Community license is active for this instance.',
        unverified: 'Activation is optional. Canvas Notebook can be used locally without a Community license.',
        loading: 'Loading',
        unregistered: 'Community Solo · unregistered',
        activationTitle: 'Optional Community activation',
        activationDescription:
          'If you choose to activate, this self-hosted instance is registered with Canvas and a signed license certificate is stored locally. Your Instance ID and email are used to issue it; workspace files, prompts, API keys, and local data are not sent. Team features still require an eligible Team license.',
        termsTitle: 'License terms',
        termsDescription:
          'Canvas Notebook is provided under the Sustainable Use License 1.0. It allows self-hosted internal business use, personal use, and non-commercial use. It does not allow offering Canvas Notebook, modified versions, or derived hosted services to third parties as a managed or competing service.',
        renewalDescription:
          'Community licenses are valid for one year by default and do not renew automatically yet. If the license expires, you can request a new free key here. Local core features remain available without an active Community license.',
        managedDescription:
          'When Canvas Notebook is provided through the official Canvas Notebook distribution channel, the managed license is issued by Canvas and activated for this instance automatically. No separate activation key is required.',
        viewLicense: 'View full license',
        instanceId: 'Instance ID',
        expires: 'Expires',
        email: 'Email',
        marketingOptInLabel: 'Receive newsletter',
        marketingOptInDescription:
          'Optional: receive product news, release notes, and important Canvas Notebook updates by email. You can unsubscribe at any time.',
        sendKey: 'Send key',
        emailSent: 'Activation email sent',
        activationPendingTitle: 'Waiting for confirmation',
        activationPendingDescription:
          'Open the email on any device and approve the activation there. This Notebook instance will retrieve the signed certificate automatically; the email does not need to be opened on the server.',
        activationCompleted: 'License activated automatically',
        activationKey: 'Activation key',
        activate: 'Activate',
        statusUnavailableTitle: 'License status unavailable',
        statusUnavailableDescription: 'The license could not be loaded safely. Team features remain disabled until the status can be loaded again. Canvas Core remains available locally.',
        retryStatus: 'Retry status',
        details: 'License details and terms',
        openActivation: 'Activate optionally',
        useKey: 'Use an existing key',
        replaceLicense: 'Replace or renew license',
        connection: 'Manage Team connection',
        active: 'Active',
        inactive: 'Not activated',
        managedShort: 'The license is managed through Canvas.',
      };
}

export function LicenseActivationPanel({
  defaultEmail,
  canViewTeamSeatHealth = false,
}: {
  defaultEmail: string;
  canViewTeamSeatHealth?: boolean;
}) {
  const searchParams = useSearchParams();
  const locale = useLocale();
  const copy = getActivationCopy(locale);
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [email, setEmail] = useState(defaultEmail);
  const [key, setKey] = useState(searchParams.get('key') || '');
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [statusLoadError, setStatusLoadError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [activating, setActivating] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [activationOpen, setActivationOpen] = useState(Boolean(searchParams.get('key')));
  const [keyOpen, setKeyOpen] = useState(Boolean(searchParams.get('key')));
  const [connectionOpen, setConnectionOpen] = useState(false);

  useEffect(() => {
    scrubLicenseKeyFromBrowserUrl();
  }, []);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/license/status', {
        cache: 'no-store',
        credentials: 'include',
      });
      const payload = await response.json().catch(() => ({})) as LicenseStatus;
      if (!response.ok || payload.success === false) {
        throw new Error(payload.error || copy.statusUnavailableDescription);
      }
      setStatus(payload);
      setStatusLoadError(null);
    } catch (error) {
      setStatus(null);
      setStatusLoadError(error instanceof Error ? error.message : copy.statusUnavailableDescription);
    } finally {
      setLoading(false);
    }
  }, [copy.statusUnavailableDescription]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadStatus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadStatus]);

  const { beginPolling, pendingActivation } = useLicenseEmailActivation({
    // Discover server-persisted renewals even while the previous certificate is still valid.
    licensed: !status || licenseHostingVariant(status) !== 'self-hosted',
    onActivated: async () => {
      await loadStatus();
      setActivationOpen(false);
      toast.success(copy.activationCompleted);
    },
    onFailure: (failure) => {
      toast.error(errorWithCode(failure.error || 'License activation failed', failure.code));
    },
  });

  async function requestLicense() {
    setRegistering(true);
    try {
      const response = await fetch('/api/license/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, activationPath: getLicenseRegistrationActivationPath('/settings?tab=license'), marketingOptIn }),
      });
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        error?: string;
        code?: string;
        activation?: PublicLicenseEmailActivation | null;
      };
      if (!response.ok || !payload.success) {
        throw new Error(errorWithCode(payload.error || 'License request failed', payload.code));
      }
      beginPolling(payload.activation || null);
      toast.success(copy.emailSent);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'License request failed');
    } finally {
      setRegistering(false);
    }
  }

  async function activateLicense() {
    setActivating(true);
    try {
      const response = await fetch('/api/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(errorWithCode(payload.error || 'License activation failed', payload.code));
      }
      setStatus(payload);
      setKey('');
      setActivationOpen(false);
      setKeyOpen(false);
      await loadStatus();
      toast.success('License activated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'License activation failed');
    } finally {
      setActivating(false);
    }
  }

  const isLicensed = Boolean(status?.licensed);
  const hostingVariant = licenseHostingVariant(status);
  const isManaged = hostingVariant === 'managed';
  const isSelfHosted = hostingVariant === 'self-hosted';
  const statusCode = status?.code || codeFromLicenseError(status?.error as Parameters<typeof codeFromLicenseError>[0]);
  const planLabel = isManaged
    ? `Managed${status?.edition ? ` ${status.edition === 'team' ? 'Team' : 'Solo'}` : ''}`
    : status?.plan === 'unregistered' ? copy.unregistered
      : status?.plan === 'community' ? `Community ${status.edition === 'team' ? 'Team' : 'Solo'}` : status?.plan || copy.loading;

  return (
    <div className="space-y-3 sm:space-y-4">
      <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
        <CardHeader className="px-4 sm:px-6">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1.5">
              <CardTitle className="flex min-w-0 items-center gap-2 text-base sm:text-lg">
                {isLicensed ? <CheckCircle2 className="h-5 w-5 shrink-0" /> : <ShieldAlert className="h-5 w-5 shrink-0" />}
                {isManaged ? copy.managedTitle : isSelfHosted ? copy.title : copy.licenseTitle}
              </CardTitle>
              <CardDescription className="leading-5">
                {isManaged ? copy.managedShort : !status ? copy.loading : isLicensed
                  ? copy.verified
                  : copy.unverified}
              </CardDescription>
            </div>
            <Badge className="w-fit max-w-full truncate" variant={isLicensed ? 'default' : 'secondary'}>
              {loading ? copy.loading : `${planLabel} · ${isLicensed ? copy.active : copy.inactive}`}
            </Badge>
          </div>

          {statusLoadError ? (
            <Alert variant="destructive">
              <ShieldAlert />
              <AlertTitle>{copy.statusUnavailableTitle}</AlertTitle>
              <AlertDescription>
                <p>{statusLoadError}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => void loadStatus()}>
                  <Loader2 className={loading ? 'animate-spin' : undefined} />
                  {copy.retryStatus}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4 px-4 sm:px-6">
          {status?.expiresAt ? <p className="text-sm text-muted-foreground">
            {copy.expires}: {new Date(status.expiresAt).toLocaleDateString(locale)}
          </p> : null}
          {isSelfHosted && !loading && !statusLoadError && !activationOpen ? <div className="flex flex-wrap gap-2">
            <Button type="button" variant={isLicensed ? 'outline' : 'default'} onClick={() => setActivationOpen(true)}>
              {isLicensed ? copy.replaceLicense : copy.openActivation}
            </Button>
            {!isLicensed ? <Button type="button" variant="ghost" onClick={() => { setActivationOpen(true); setKeyOpen(true); }}>
              {copy.useKey}
            </Button> : null}
          </div> : null}

          {status && !statusLoadError ? <SettingsAccordionCard title={copy.details} isOpen={detailsOpen} onOpenChange={setDetailsOpen}>
            <p className="break-all text-sm"><span className="text-muted-foreground">{copy.instanceId}: </span><span className="font-mono text-xs">{status.instanceId}</span></p>
            {isManaged ? <p className="text-sm text-muted-foreground">{copy.managedDescription}</p> : null}
            {isSelfHosted ? <section className="space-y-2 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">{copy.termsTitle}</p>
              <p>{copy.termsDescription}</p>
              <p>{copy.renewalDescription}</p>
              <a href="https://github.com/canvascoding/canvas-notebook?tab=License-1-ov-file" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 underline underline-offset-4">
                {copy.viewLicense}<ExternalLink className="h-3 w-3" />
              </a>
            </section> : null}
          </SettingsAccordionCard> : null}

          {pendingActivation ? (
            <Alert variant="info">
              <Loader2 className="animate-spin" />
              <AlertTitle>{copy.activationPendingTitle}</AlertTitle>
              <AlertDescription>
                {copy.activationPendingDescription}
              </AlertDescription>
            </Alert>
          ) : null}

          {isSelfHosted && activationOpen && !loading && !statusLoadError && (
            <section className="space-y-4 border-t pt-4" aria-label={copy.activationTitle}>
              <p className="flex items-center gap-2 text-sm font-medium"><Info className="h-4 w-4" />{copy.activationTitle}</p>
              <p className="text-sm leading-5 text-muted-foreground">{copy.activationDescription}</p>
              {!keyOpen ? <>
              <div className="space-y-2">
                <Label htmlFor="license-email">{copy.email}</Label>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input id="license-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
                  <Button onClick={requestLicense} disabled={registering || !email.trim()} className="h-10 w-full gap-2 sm:h-9 sm:w-auto">
                    {registering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                    {copy.sendKey}
                  </Button>
                </div>
              </div>

              <div className="flex items-start gap-3 border border-border bg-muted/20 px-3 py-3">
                <Switch
                  id="license-marketing-opt-in"
                  checked={marketingOptIn}
                  onCheckedChange={setMarketingOptIn}
                  aria-describedby="license-marketing-opt-in-description"
                  className="mt-0.5"
                />
                <div className="space-y-1">
                  <Label htmlFor="license-marketing-opt-in" className="cursor-pointer font-medium">
                    {copy.marketingOptInLabel}
                  </Label>
                  <p id="license-marketing-opt-in-description" className="text-sm leading-5 text-muted-foreground">
                    {copy.marketingOptInDescription}
                  </p>
                </div>
              </div>

              <Button type="button" variant="ghost" onClick={() => setKeyOpen(true)}>{copy.useKey}</Button>
              </> : null}
              {keyOpen ? <div className="space-y-2">
                <Label htmlFor="license-key">{copy.activationKey}</Label>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input id="license-key" value={key} onChange={(event) => setKey(event.target.value)} />
                  <Button onClick={activateLicense} disabled={activating || !key.trim()} className="h-10 w-full gap-2 sm:h-9 sm:w-auto">
                    {activating ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                    {copy.activate}
                  </Button>
                </div>
              <Button type="button" variant="ghost" onClick={() => setKeyOpen(false)}>{copy.sendKey}</Button>
              </div> : null}
              <Button type="button" variant="ghost" onClick={() => setActivationOpen(false)}>{locale.startsWith('de') ? 'Schließen' : 'Close'}</Button>

              {status?.error && (
                <div className="space-y-1 break-words text-sm text-destructive">
                  <p>{licenseErrorMessage(status.error)}</p>
                  {statusCode && <p className="break-all font-mono text-xs text-muted-foreground">{statusCode}</p>}
                </div>
              )}
            </section>
          )}
        </CardContent>
      </Card>
      {canViewTeamSeatHealth && isTeamLicenseApplicable(status) ? (
        <TeamSeatHealthPanel
          health={status ? status.teamSeatHealth ?? null : undefined}
          onReload={loadStatus}
        />
      ) : null}
      {isSelfHosted && !loading && !statusLoadError ? <SettingsAccordionCard title={copy.connection} isOpen={connectionOpen || Boolean(status?.teamSeatHealth?.recovery.reconnectRequired)} onOpenChange={setConnectionOpen}>
        <CommunityTeamConnectionPanel
        licensed={isLicensed}
        licensePlan={status?.plan || 'unregistered'}
        licenseStatusAvailable={
          !statusLoadError
          && status !== null
          && status.error !== 'license_status_unavailable'
        }
        teamSeatRollout={status?.teamSeatRollout}
        />
      </SettingsAccordionCard> : null}
    </div>
  );
}
