'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { CheckCircle2, ExternalLink, Info, KeyRound, Loader2, Mail, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { codeFromLicenseError } from '@/app/lib/license/error-codes';

type LicenseStatus = {
  licensed: boolean;
  plan: string;
  instanceId: string;
  expiresAt: string | null;
  error?: string;
  code?: string;
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
        title: 'Lizenz',
        verified: 'Diese Canvas Notebook Instanz ist verifiziert.',
        unverified: 'Verifiziere diese selbst gehostete Instanz, bevor du die App nutzt.',
        loading: 'Lade',
        unregistered: 'nicht registriert',
        activationTitle: 'Was bei der Aktivierung passiert',
        activationDescription:
          'Die Aktivierung verifiziert diese selbst gehostete Instanz bei Canvas und speichert ein signiertes Lizenzzertifikat lokal. Deine Instance ID und E-Mail werden zur Ausstellung der Lizenz verwendet; Workspace-Dateien, Prompts, API-Keys und lokale Daten werden dabei nicht übertragen.',
        termsTitle: 'Lizenzbedingungen',
        termsDescription:
          'Canvas Notebook wird unter der Sustainable Use License 1.0 bereitgestellt. Sie erlaubt selbst gehostete interne geschäftliche Nutzung, private Nutzung und nicht-kommerzielle Nutzung. Nicht erlaubt ist, Canvas Notebook, modifizierte Versionen oder daraus abgeleitete gehostete Dienste Dritten als Managed Service oder konkurrierenden Dienst anzubieten.',
        renewalDescription:
          'Community-Lizenzen sind standardmäßig ein Jahr gültig und erneuern sich aktuell nicht automatisch. Wenn die Lizenz abläuft, fordere hier einen neuen kostenlosen Key an und aktiviere ihn.',
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
        activationKey: 'Aktivierungs-Key',
        activate: 'Aktivieren',
      }
    : {
        title: 'License',
        verified: 'This Canvas Notebook instance is verified.',
        unverified: 'Verify this self-hosted instance before using the app.',
        loading: 'Loading',
        unregistered: 'unregistered',
        activationTitle: 'What activation does',
        activationDescription:
          'Activation verifies this self-hosted instance with Canvas and stores a signed license certificate locally. Your Instance ID and email are used to issue the license; your workspace files, prompts, API keys, and local data are not sent as part of activation.',
        termsTitle: 'License terms',
        termsDescription:
          'Canvas Notebook is provided under the Sustainable Use License 1.0. It allows self-hosted internal business use, personal use, and non-commercial use. It does not allow offering Canvas Notebook, modified versions, or derived hosted services to third parties as a managed or competing service.',
        renewalDescription:
          'Community licenses are valid for one year by default and do not renew automatically yet. When the license expires, request a new free key here and activate it.',
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
        activationKey: 'Activation key',
        activate: 'Activate',
      };
}

export function LicenseActivationPanel({ defaultEmail }: { defaultEmail: string }) {
  const searchParams = useSearchParams();
  const locale = useLocale();
  const copy = getActivationCopy(locale);
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [email, setEmail] = useState(defaultEmail);
  const [key, setKey] = useState(searchParams.get('key') || '');
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [activating, setActivating] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetch('/api/license/status', { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload) => {
        if (mounted) setStatus(payload);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function requestLicense() {
    setRegistering(true);
    try {
      const response = await fetch('/api/license/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, activationPath: getLicenseRegistrationActivationPath('/settings?tab=license'), marketingOptIn }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(errorWithCode(payload.error || 'License request failed', payload.code));
      }
      toast.success(`License email sent to ${email}`);
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
      toast.success('License activated');
      window.location.href = '/';
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'License activation failed');
    } finally {
      setActivating(false);
    }
  }

  const isLicensed = Boolean(status?.licensed);
  const isManaged = status?.plan === 'managed';
  const statusCode = status?.code || codeFromLicenseError(status?.error as Parameters<typeof codeFromLicenseError>[0]);

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
              {loading ? copy.loading : status?.plan || copy.unregistered}
            </Badge>
          </div>
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
    </div>
  );
}
