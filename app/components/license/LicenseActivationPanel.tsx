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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { scrubLicenseKeyFromBrowserUrl } from '@/app/lib/license/browser-url';
import { codeFromLicenseError } from '@/app/lib/license/error-codes';
import type { TeamSeatHealth } from '@/app/lib/license/team-seat-health-types';
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
      }
    : {
        title: 'Community license',
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
    licensed: Boolean(status?.licensed),
    onActivated: async () => {
      await loadStatus();
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
      await loadStatus();
      toast.success('License activated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'License activation failed');
    } finally {
      setActivating(false);
    }
  }

  const isLicensed = Boolean(status?.licensed);
  const isManaged = status?.plan === 'managed';
  const statusCode = status?.code || codeFromLicenseError(status?.error as Parameters<typeof codeFromLicenseError>[0]);
  const planLabel = status?.plan === 'unregistered' ? copy.unregistered : status?.plan || copy.unregistered;

  return (
    <div className="space-y-3 sm:space-y-4">
      <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
        <CardHeader className="px-4 sm:px-6">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1.5">
              <CardTitle className="flex min-w-0 items-center gap-2 text-base sm:text-lg">
                {isLicensed ? <CheckCircle2 className="h-5 w-5 shrink-0" /> : <ShieldAlert className="h-5 w-5 shrink-0" />}
                {copy.title}
              </CardTitle>
              <CardDescription className="leading-5">
                {isLicensed
                  ? copy.verified
                  : copy.unverified}
              </CardDescription>
            </div>
            <Badge className="w-fit max-w-full truncate" variant={isLicensed ? 'default' : 'secondary'}>
              {loading ? copy.loading : planLabel}
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
          <div className="border border-border bg-muted/30 px-3 py-3 text-sm sm:px-4">
            <div className="space-y-3 sm:flex sm:items-start sm:gap-3 sm:space-y-0">
              <Info className="mt-0.5 hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" />
              <div className="min-w-0 space-y-3 leading-6">
                <div>
                  <p className="flex items-start gap-2 font-medium">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground sm:hidden" />
                    <span>{copy.activationTitle}</span>
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {copy.activationDescription}
                  </p>
                </div>
                <div>
                  <p className="font-medium">{copy.termsTitle}</p>
                  <p className="mt-1 text-muted-foreground">
                    {copy.termsDescription}
                  </p>
                  <p className="mt-2 text-muted-foreground">
                    {isManaged ? copy.managedDescription : copy.renewalDescription}
                  </p>
                  <a
                    href="https://github.com/canvascoding/canvas-notebook?tab=License-1-ov-file"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex max-w-full items-center gap-1.5 text-xs font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    <span className="min-w-0 truncate">{copy.viewLicense}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-2 text-sm">
            <div className="grid gap-1.5 border border-border px-3 py-2.5 sm:flex sm:items-center sm:justify-between sm:gap-3">
              <span className="text-muted-foreground">{copy.instanceId}</span>
              <span className="min-w-0 break-all font-mono text-xs sm:text-right">{status?.instanceId || '...'}</span>
            </div>
            {status?.expiresAt && (
              <div className="grid gap-1.5 border border-border px-3 py-2.5 sm:flex sm:items-center sm:justify-between sm:gap-3">
                <span className="text-muted-foreground">{copy.expires}</span>
                <span className="min-w-0 break-words sm:text-right">{new Date(status.expiresAt).toLocaleString()}</span>
              </div>
            )}
          </div>

          {!isLicensed && (
            <>
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

              {pendingActivation ? (
                <Alert>
                  <Loader2 className="animate-spin" />
                  <AlertTitle>{copy.activationPendingTitle}</AlertTitle>
                  <AlertDescription>
                    {copy.activationPendingDescription}
                  </AlertDescription>
                </Alert>
              ) : null}

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

              <div className="space-y-2">
                <Label htmlFor="license-key">{copy.activationKey}</Label>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input id="license-key" value={key} onChange={(event) => setKey(event.target.value)} />
                  <Button onClick={activateLicense} disabled={activating || !key.trim()} className="h-10 w-full gap-2 sm:h-9 sm:w-auto">
                    {activating ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                    {copy.activate}
                  </Button>
                </div>
              </div>

              {status?.error && (
                <div className="space-y-1 break-words text-sm text-destructive">
                  <p>{licenseErrorMessage(status.error)}</p>
                  {statusCode && <p className="break-all font-mono text-xs text-muted-foreground">{statusCode}</p>}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
      {canViewTeamSeatHealth ? (
        <TeamSeatHealthPanel
          health={status ? status.teamSeatHealth ?? null : undefined}
          onReload={loadStatus}
        />
      ) : null}
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
    </div>
  );
}
