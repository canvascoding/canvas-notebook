'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useParams, useSearchParams } from 'next/navigation';
import { usePathname, useRouter } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';

import { PiProviderSetupCard } from '@/app/components/settings/PiProviderSetupCard';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { CheckCircle2, KeyRound, Languages, Loader2, Mail, RefreshCw, ShieldAlert } from 'lucide-react';

type Step = 'language' | 'license' | 'provider' | 'done';

const STEPS: Step[] = ['language', 'license', 'provider', 'done'];
const ONBOARDING_LICENSE_KEY_STORAGE_KEY = 'canvas.onboarding.licenseKey';

type LicenseStatus = {
  licensed?: boolean;
  plan?: string;
  source?: string;
  instanceId?: string;
  expiresAt?: string | null;
  error?: string;
  code?: string;
};

type LicenseErrorMessageKey =
  | 'licenseErrorPublicKeyUnavailable'
  | 'licenseErrorControlPlaneUnreachable'
  | 'licenseErrorUntrustedPublicKey'
  | 'licenseErrorExpired'
  | 'licenseErrorRequired';

function licenseErrorMessage(t: (key: LicenseErrorMessageKey) => string, error?: string) {
  switch (error) {
    case 'missing_public_key':
    case 'public_key_unavailable':
      return t('licenseErrorPublicKeyUnavailable');
    case 'control_plane_unreachable':
      return t('licenseErrorControlPlaneUnreachable');
    case 'untrusted_public_key':
      return t('licenseErrorUntrustedPublicKey');
    case 'license_expired':
      return t('licenseErrorExpired');
    default:
      return error || t('licenseErrorRequired');
  }
}

async function fetchLicenseStatusPayload() {
  const response = await fetch('/api/license/status', { cache: 'no-store' });
  const payload = await response.json().catch(() => ({})) as LicenseStatus;
  return { response, payload };
}

function readStoredOnboardingLicenseKey() {
  if (typeof window === 'undefined') return '';
  try {
    return window.sessionStorage.getItem(ONBOARDING_LICENSE_KEY_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function storeOnboardingLicenseKey(key: string) {
  if (typeof window === 'undefined') return;
  try {
    if (key.trim()) {
      window.sessionStorage.setItem(ONBOARDING_LICENSE_KEY_STORAGE_KEY, key);
    } else {
      window.sessionStorage.removeItem(ONBOARDING_LICENSE_KEY_STORAGE_KEY);
    }
  } catch {
    // Onboarding still works if browser storage is unavailable.
  }
}

function clearStoredOnboardingLicenseKey() {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(ONBOARDING_LICENSE_KEY_STORAGE_KEY);
  } catch {
    // Onboarding still works if browser storage is unavailable.
  }
}

function getLicenseRegistrationActivationPath(fallback: string) {
  if (typeof window === 'undefined') return fallback;
  const url = new URL(window.location.href);
  url.searchParams.delete('key');
  return `${url.pathname}${url.search}` || fallback;
}

export default function OnboardingWizard({
  defaultEmail,
  initialLicenseKey,
}: {
  defaultEmail: string;
  initialLicenseKey: string;
}) {
  const t = useTranslations('onboarding');
  const [step, setStep] = useState<Step>('language');
  const [completeLoading, setCompleteLoading] = useState(false);

  async function handleDone() {
    setCompleteLoading(true);
    try {
      const response = await fetch('/api/onboarding/complete', {
        method: 'POST',
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error || t('completionError'));
        return;
      }

      const statusResponse = await fetch('/api/license/status', { cache: 'no-store' });
      const status = await statusResponse.json().catch(() => ({ licensed: false })) as { licensed?: boolean };
      window.location.href = status.licensed ? '/' : '/settings?tab=license';
    } catch {
      toast.error(t('unexpectedError'));
    } finally {
      setCompleteLoading(false);
    }
  }

  return (
    <div
      data-testid="onboarding-scroll-root"
      className="fixed inset-0 overflow-y-auto overscroll-contain bg-background text-foreground"
    >
      <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 py-4 sm:px-6">
        <div className="mb-4 flex justify-end gap-2">
          <ThemeToggle />
        </div>

        <div className="flex flex-1 items-start justify-center py-4">
          <div className={`w-full ${step === 'provider' ? 'max-w-5xl' : 'max-w-lg'}`}>
            <div className="rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
              <div className="mb-2 flex items-center justify-center">
                <Image
                  src="/logo.jpg"
                  alt={t('logoAlt')}
                  width={48}
                  height={48}
                  className="mr-3 border border-border"
                />
                <h1 className="text-3xl font-bold">Canvas Notebook</h1>
              </div>

              <div className="mb-8 flex justify-center gap-2">
                {STEPS.map((currentStep, index) => (
                  <div key={currentStep} className="flex items-center gap-2">
                    <div
                      className={`h-2 w-2 rounded-full transition-colors ${
                        step === currentStep ? 'bg-foreground' : 'bg-muted-foreground/30'
                      }`}
                    />
                    {index < STEPS.length - 1 && <div className="h-px w-6 bg-border" />}
                  </div>
                ))}
              </div>

              {step === 'language' && (
                <LanguageStep
                  onContinue={() => setStep('license')}
                />
              )}

              {step === 'license' && (
                <LicenseStep
                  defaultEmail={defaultEmail}
                  initialLicenseKey={initialLicenseKey}
                  onContinue={() => setStep('provider')}
                />
              )}

              {step === 'provider' && (
                <div className="space-y-6">
                  <div>
                    <h2 className="mb-1 text-xl font-semibold">{t('welcome')}</h2>
                    <p className="text-sm text-muted-foreground">
                      {t('description')}
                    </p>
                  </div>

                  <PiProviderSetupCard
                    title={t('providerTitle')}
                    description={t('providerDescription')}
                    saveButtonLabel={t('saveProvider')}
                    saveSuccessMessage={t('saveSuccessMessage')}
                    onSaved={() => {
                      toast.success(t('providerSaved'));
                      setStep('done');
                    }}
                  />

                  <div className="flex justify-end">
                    <Button variant="outline" onClick={() => setStep('done')}>
                      {t('skipSetup')}
                    </Button>
                  </div>
                </div>
              )}

              {step === 'done' && (
                <div className="text-center">
                  <div className="mb-4 text-4xl">✓</div>
                  <h2 className="mb-2 text-xl font-semibold">{t('setupComplete')}</h2>
                  <p className="mb-8 text-sm text-muted-foreground">
                    {t('setupCompleteDescription')}
                  </p>
                  <Button onClick={handleDone} className="w-full" disabled={completeLoading}>
                    {completeLoading ? t('completing') : t('toApp')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LicenseStep({
  defaultEmail,
  initialLicenseKey,
  onContinue,
}: {
  defaultEmail: string;
  initialLicenseKey: string;
  onContinue: () => void;
}) {
  const t = useTranslations('onboarding');
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [email, setEmail] = useState(defaultEmail);
  const [key, setKey] = useState(() => initialLicenseKey || readStoredOnboardingLicenseKey());
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [activating, setActivating] = useState(false);

  const fetchLicenseStatus = useCallback(async () => {
    try {
      const { response, payload } = await fetchLicenseStatusPayload();
      setStatus(payload);
      if (!response.ok) toast.error(t('licenseStatusError'));
      return payload;
    } catch {
      toast.error(t('licenseStatusError'));
      return null;
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadStatus = useCallback(async () => {
    setRefreshing(true);
    try {
      return await fetchLicenseStatus();
    } finally {
      setRefreshing(false);
    }
  }, [fetchLicenseStatus]);

  useEffect(() => {
    let mounted = true;

    fetchLicenseStatusPayload()
      .then(({ response, payload }) => {
        if (!mounted) return;
        setStatus(payload);
        if (!response.ok) toast.error(t('licenseStatusError'));
      })
      .catch(() => {
        if (mounted) toast.error(t('licenseStatusError'));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [t]);

  useEffect(() => {
    storeOnboardingLicenseKey(key);
  }, [key]);

  async function requestLicense() {
    setRegistering(true);
    try {
      const response = await fetch('/api/license/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, activationPath: getLicenseRegistrationActivationPath('/onboarding'), marketingOptIn }),
      });
      const payload = await response.json().catch(() => ({})) as { success?: boolean; error?: string; code?: string };
      if (!response.ok || !payload.success) {
        throw new Error(payload.code ? `${payload.error || t('licenseRequestFailed')} (${payload.code})` : payload.error || t('licenseRequestFailed'));
      }
      toast.success(t('licenseEmailSent'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('licenseRequestFailed'));
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
      const payload = await response.json().catch(() => ({})) as LicenseStatus & { success?: boolean; error?: string; code?: string };
      if (!response.ok || !payload.success) {
        throw new Error(payload.code ? `${payload.error || t('licenseActivationFailed')} (${payload.code})` : payload.error || t('licenseActivationFailed'));
      }
      setStatus(payload);
      clearStoredOnboardingLicenseKey();
      toast.success(t('licenseActivated'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('licenseActivationFailed'));
    } finally {
      setActivating(false);
    }
  }

  const licensed = Boolean(status?.licensed);
  const managed = status?.plan === 'managed';

  return (
    <div className="space-y-6">
      <div className="text-center">
        {licensed ? (
          <CheckCircle2 className="mx-auto mb-4 h-12 w-12 text-primary" />
        ) : (
          <ShieldAlert className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
        )}
        <h2 className="mb-1 text-xl font-semibold">
          {licensed && managed ? t('licenseManagedTitle') : t('licenseTitle')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {licensed && managed ? t('licenseManagedDescription') : t('licenseDescription')}
        </p>
      </div>

      <div className="border border-border bg-muted/30 p-4 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">{t('licenseStatus')}</span>
          <Badge variant={licensed ? 'default' : 'secondary'}>{loading ? t('licenseChecking') : status?.plan || t('licenseUnregistered')}</Badge>
        </div>
        {status?.instanceId && (
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{t('licenseInstanceId')}</span>
            <span className="truncate font-mono text-xs">{status.instanceId}</span>
          </div>
        )}
        {status?.expiresAt && (
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{t('licenseExpires')}</span>
            <span>{new Date(status.expiresAt).toLocaleString()}</span>
          </div>
        )}
        {!licensed && status?.error && (
          <div className="mt-3 border border-destructive/30 bg-destructive/10 p-3 text-destructive">
            <p>{licenseErrorMessage(t, status.error)}</p>
            {status.code && <p className="mt-1 font-mono text-xs text-muted-foreground">{status.code}</p>}
          </div>
        )}
      </div>

      {licensed ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => void loadStatus()} disabled={refreshing} className="gap-2">
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t('licenseCheckAgain')}
          </Button>
          <Button onClick={onContinue}>{t('licenseContinue')}</Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="onboarding-license-email">{t('licenseEmail')}</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id="onboarding-license-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
              <Button onClick={requestLicense} disabled={registering || !email.trim()} className="gap-2">
                {registering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                {t('licenseSendKey')}
              </Button>
            </div>
          </div>

          <div className="flex items-start gap-3 border border-border bg-muted/20 p-3">
            <Switch
              id="onboarding-license-marketing-opt-in"
              checked={marketingOptIn}
              onCheckedChange={setMarketingOptIn}
              aria-describedby="onboarding-license-marketing-opt-in-description"
              className="mt-0.5"
            />
            <div className="space-y-1">
              <Label htmlFor="onboarding-license-marketing-opt-in" className="cursor-pointer font-medium">
                {t('licenseMarketingOptInLabel')}
              </Label>
              <p id="onboarding-license-marketing-opt-in-description" className="text-sm leading-5 text-muted-foreground">
                {t('licenseMarketingOptInDescription')}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="onboarding-license-key">{t('licenseActivationKey')}</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id="onboarding-license-key" value={key} onChange={(event) => setKey(event.target.value)} />
              <Button onClick={activateLicense} disabled={activating || !key.trim()} className="gap-2">
                {activating ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                {t('licenseActivate')}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
            <Button variant="outline" onClick={() => void loadStatus()} disabled={refreshing} className="gap-2">
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t('licenseCheckAgain')}
            </Button>
            <Button onClick={onContinue} disabled={!licensed}>
              {t('licenseContinue')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function LanguageStep({ onContinue }: { onContinue: () => void }) {
  const t = useTranslations('onboarding');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = useParams();
  const currentLocale = (params.locale as string) || routing.defaultLocale;

  function handleSelectLocale(locale: string) {
    startTransition(() => {
      const query = searchParams.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { locale });
    });
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <Languages className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
        <h2 className="mb-1 text-xl font-semibold">{t('languageTitle')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('languageDescription')}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {routing.locales.map((locale) => (
          <button
            key={locale}
            type="button"
            onClick={() => handleSelectLocale(locale)}
            disabled={isPending}
            className={`flex flex-col items-center gap-2 rounded-lg border-2 p-6 transition-colors ${
              locale === currentLocale
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-border bg-card hover:border-muted-foreground/40 hover:bg-muted/50'
            }`}
          >
            <span className="text-3xl">{locale === 'de' ? '🇩🇪' : '🇬🇧'}</span>
            <span className="text-lg font-semibold">
              {locale === 'de' ? 'Deutsch' : 'English'}
            </span>
            {locale === currentLocale && (
              <span className="text-xs font-medium text-primary">{t('languageActive')}</span>
            )}
          </button>
        ))}
      </div>

      <div className="flex justify-center">
        <Button onClick={onContinue} className="min-w-[200px]">
          {t('languageContinue')}
        </Button>
      </div>
    </div>
  );
}
