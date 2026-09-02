'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { routing } from '@/i18n/routing';
import { buildLocalePath } from '@/app/lib/locale-path';
import { scrubLicenseKeyFromBrowserUrl } from '@/app/lib/license/browser-url';
import {
  useLicenseEmailActivation,
  type PublicLicenseEmailActivation,
} from '@/app/components/license/useLicenseEmailActivation';

import CanvasAgentChat from '@/app/components/canvas-agent-chat/CanvasAgentChat';
import { AiProviderCredentialsPanel } from '@/app/components/settings/AiProviderCredentialsPanel';
import { AiProvidersModelsPanel } from '@/app/components/settings/AiProvidersModelsPanel';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { PublicBrandLogo } from '@/app/components/branding/PublicBrandLogo';
import { ProfileAppearanceEditor } from '@/app/components/user-profile/ProfileAppearanceEditor';
import type { ResolvedUserProfile } from '@/app/lib/user-profile/types';
import { DEFAULT_USER_TIME_ZONE, getSupportedTimeZones, normalizeTimeZone } from '@/app/lib/time-zones';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { CheckCircle2, Clock3, Compass, FolderKanban, KeyRound, Languages, Loader2, Mail, RefreshCw, ServerCog, ShieldAlert, Sparkles, Users, Workflow, type LucideIcon } from 'lucide-react';

type Step = 'server' | 'language' | 'license' | 'provider' | 'workspace' | 'review' | 'profile' | 'tour' | 'done';
type OnboardingMode = 'instance' | 'user';
type OnboardingRuntimePhase = 'idle' | 'streaming' | 'running_tool' | 'aborting';

const INSTANCE_STEPS: Step[] = ['server', 'license', 'provider', 'workspace', 'review'];
const USER_STEPS: Step[] = ['language', 'workspace', 'profile', 'tour', 'done'];
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

function getBrowserPathLocale(fallback: string) {
  if (typeof window === 'undefined') return fallback;
  const match = window.location.pathname.match(/^\/(de|en)(?:\/|$)/u);
  return match?.[1] || routing.defaultLocale;
}

function subscribeToBrowserLocation() {
  return () => undefined;
}

type OnboardingClientLogLevel = 'error' | 'info' | 'warn';

function responseBodySnippet(body: string): string {
  return body.replace(/\s+/gu, ' ').trim().slice(0, 500);
}

async function logOnboardingClientEvent(
  event: string,
  details: Record<string, unknown> = {},
  level: OnboardingClientLogLevel = 'info',
): Promise<void> {
  if (typeof window === 'undefined') return;
  const body = JSON.stringify({
    event,
    level,
    pathname: window.location.pathname,
    locale: document.documentElement.lang || navigator.language || null,
    details,
  });

  try {
    await fetch('/api/onboarding/log', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: body.length < 60_000,
    });
  } catch (error) {
    console.warn('[Onboarding] Failed to send client log', error);
  }
}

async function saveOnboardingPreferences(locale: string): Promise<void> {
  console.log('[Onboarding] Saving personal language preference', { locale });
  await logOnboardingClientEvent('preferences.save.started', { locale, scope: 'user' });

  let response: Response;
  try {
    response = await fetch('/api/user-preferences', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed';
    await logOnboardingClientEvent('preferences.save.network-error', { locale, scope: 'user', message }, 'error');
    throw new Error(`locale-network:${message}`);
  }

  const requestId = response.headers.get('X-Request-Id');
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const bodySnippet = responseBodySnippet(body);
    console.error('[Onboarding] Locale save failed', { status: response.status, requestId, bodySnippet });
    await logOnboardingClientEvent('preferences.locale.failed', { status: response.status, requestId, bodySnippet, scope: 'user' }, 'error');
    throw new Error(`locale-status:${response.status}${requestId ? `:${requestId}` : ''}`);
  }

  await logOnboardingClientEvent('preferences.save.succeeded', { localeStatus: response.status, requestId, scope: 'user' });
}

export default function OnboardingWizard({
  defaultEmail,
  initialLicenseKey,
  initialTimeZone,
  mode,
  initialStep,
  initialUserProfile,
  guidedHintsEnabled,
}: {
  defaultEmail: string;
  initialLicenseKey: string;
  initialTimeZone: string;
  mode: OnboardingMode;
  initialStep: Step;
  initialUserProfile: ResolvedUserProfile;
  guidedHintsEnabled: boolean;
}) {
  const t = useTranslations('onboarding');
  const currentLocale = useLocale();
  const [step, setStep] = useState<Step>(initialStep);
  const [completeLoading, setCompleteLoading] = useState(false);
  const [modelTestLoading, setModelTestLoading] = useState(false);
  const [modelTestError, setModelTestError] = useState<string | null>(null);
  const [providerCatalogRefreshKey, setProviderCatalogRefreshKey] = useState(0);
  const [profileSessionId, setProfileSessionId] = useState<string | null>(null);
  const [profileSessionLoading, setProfileSessionLoading] = useState(false);
  const [profileSessionError, setProfileSessionError] = useState<string | null>(null);
  const profileSessionRequestInFlightRef = useRef(false);
  const isInstanceOnboarding = mode === 'instance';
  const steps = isInstanceOnboarding ? INSTANCE_STEPS : USER_STEPS;

  useEffect(() => {
    scrubLicenseKeyFromBrowserUrl();
  }, []);

  const advanceTo = useCallback(async (nextStep: Step) => {
    try {
      let response: Response | null = null;
      if (isInstanceOnboarding && ['server', 'license', 'provider', 'workspace', 'review'].includes(nextStep)) {
        response = await fetch('/api/onboarding/instance-progress', {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ step: nextStep }),
        });
      }
      if (!isInstanceOnboarding && ['language', 'workspace', 'profile', 'tour', 'complete'].includes(nextStep)) {
        response = await fetch('/api/onboarding/user', {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ step: nextStep }),
        });
      }
      if (response && !response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || t('unexpectedError'));
      }
      setStep(nextStep);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('unexpectedError'));
    }
  }, [isInstanceOnboarding, t]);

  const openProfileSession = useCallback(async () => {
    if (profileSessionRequestInFlightRef.current) return;
    profileSessionRequestInFlightRef.current = true;
    setProfileSessionLoading(true);
    setProfileSessionError(null);
    try {
      const response = await fetch('/api/onboarding/profile-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: currentLocale }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        complete?: boolean;
        sessionId?: string;
        error?: string;
      };

      if (!response.ok || !data.success) {
        throw new Error(data.error || t('profileSessionError'));
      }

      if (data.complete) {
        await advanceTo('tour');
        return;
      }

      if (!data.sessionId) {
        throw new Error(t('profileSessionError'));
      }

      setProfileSessionId(data.sessionId);
      await advanceTo('profile');
    } catch (error) {
      const message = error instanceof Error ? error.message : t('profileSessionError');
      setProfileSessionError(message);
      throw error;
    } finally {
      profileSessionRequestInFlightRef.current = false;
      setProfileSessionLoading(false);
    }
  }, [advanceTo, currentLocale, t]);

  useEffect(() => {
    if (step !== 'profile' || profileSessionId) return;
    const timer = window.setTimeout(() => {
      void openProfileSession().catch((error) => {
        toast.error(error instanceof Error ? error.message : t('profileSessionError'));
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [openProfileSession, profileSessionId, step, t]);

  async function handleProviderSaved() {
    setModelTestLoading(true);
    setModelTestError(null);
    try {
      const response = await fetch('/api/onboarding/provider-verify', {
        method: 'POST',
        credentials: 'include',
      });
      const data = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        code?: string;
      };

      if (!response.ok || !data.success) {
        const message = data.error || t('modelTestFailed');
        setModelTestError(data.code ? `${message} (${data.code})` : message);
        toast.error(t('modelTestFailed'));
        return;
      }

      await advanceTo('workspace');
    } catch (error) {
      const message = error instanceof Error ? error.message : t('unexpectedError');
      setModelTestError(message);
      toast.error(message);
    } finally {
      setModelTestLoading(false);
    }
  }

  function handleDone() {
    setCompleteLoading(true);
    try {
      window.location.assign(buildLocalePath(currentLocale, '/'));
    } finally {
      setCompleteLoading(false);
    }
  }

  function beginPersonalOnboarding() {
    window.location.assign(buildLocalePath(currentLocale, '/onboarding'));
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
          <div className={`w-full ${step === 'provider' || step === 'profile' || step === 'workspace' || step === 'language' ? 'max-w-5xl' : 'max-w-lg'}`}>
            <div className="rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
              <div className="mb-3 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <PublicBrandLogo
                  alt={t('logoAlt')}
                  width={160}
                  height={48}
                  sizes="(min-width: 640px) 160px, 128px"
                  className="h-12 max-w-40 shrink-0 object-contain"
                  fallbackClassName="w-12 border border-border object-cover"
                  brandClassName="w-auto"
                />
                <h1 className="text-center text-3xl font-bold">Canvas Notebook</h1>
              </div>

              <div className="mb-8 flex justify-center gap-2">
                {steps.map((currentStep, index) => (
                  <div key={currentStep} className="flex items-center gap-2">
                    <div
                      className={`h-2 w-2 rounded-full transition-colors ${
                        step === currentStep ? 'bg-foreground' : 'bg-muted-foreground/30'
                      }`}
                    />
                    {index < steps.length - 1 && <div className="h-px w-6 bg-border" />}
                  </div>
                ))}
              </div>

              {step === 'server' && (
                <ServerSettingsStep
                  initialTimeZone={initialTimeZone}
                  onContinue={() => advanceTo('license')}
                />
              )}

              {step === 'language' && (
                <LanguageStep
                  initialUserProfile={initialUserProfile}
                  onContinue={() => advanceTo('workspace')}
                />
              )}

              {step === 'license' && (
                <LicenseStep
                  defaultEmail={defaultEmail}
                  initialLicenseKey={initialLicenseKey}
                  onContinue={() => advanceTo('provider')}
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

                  <AiProvidersModelsPanel
                    locale={currentLocale}
                    onCatalogChanged={() => setProviderCatalogRefreshKey((current) => current + 1)}
                  />
                  <AiProviderCredentialsPanel
                    locale={currentLocale}
                    refreshKey={providerCatalogRefreshKey}
                  />

                  {modelTestLoading && (
                    <div className="flex items-center gap-2 border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t('modelTestChecking')}
                    </div>
                  )}

                  {modelTestError && (
                    <div className="border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                      {modelTestError}
                    </div>
                  )}

                  <div className="flex justify-end">
                    <Button type="button" onClick={() => void handleProviderSaved()} disabled={modelTestLoading}>
                      {modelTestLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {t('providerVerifyContinue')}
                    </Button>
                  </div>
                </div>
              )}

              {step === 'workspace' && (
                <WorkspaceReadinessStep
                  mode={mode}
                  onContinue={() => void advanceTo(isInstanceOnboarding ? 'review' : 'profile')}
                />
              )}

              {step === 'review' && isInstanceOnboarding && (
                <InstanceReviewStep onComplete={beginPersonalOnboarding} />
              )}

              {step === 'profile' && profileSessionId && (
                <AgentProfileStep
                  sessionId={profileSessionId}
                  onComplete={() => void advanceTo('tour')}
                />
              )}

              {step === 'profile' && !profileSessionId && (
                <ProfileSessionRecovery
                  loading={profileSessionLoading}
                  error={profileSessionError}
                  onRetry={() => void openProfileSession().catch(() => undefined)}
                  onSkipComplete={() => void advanceTo('tour')}
                />
              )}

              {step === 'tour' && (
                <TourStep
                  guidedHintsEnabled={guidedHintsEnabled}
                  onDone={() => void advanceTo('done')}
                />
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

function ProfileSessionRecovery({
  loading,
  error,
  onRetry,
  onSkipComplete,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSkipComplete: () => void;
}) {
  const t = useTranslations('onboarding');
  const [skipping, setSkipping] = useState(false);

  async function handleSkip() {
    if (skipping) return;
    setSkipping(true);
    try {
      const response = await fetch('/api/onboarding/profile-skip', {
        method: 'POST',
      });
      const data = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        code?: string;
      };
      if (!response.ok || !data.success) {
        throw new Error(data.code ? `${data.error || t('profileSkipError')} (${data.code})` : data.error || t('profileSkipError'));
      }
      toast.success(t('profileSkipped'));
      onSkipComplete();
    } catch (skipError) {
      toast.error(skipError instanceof Error ? skipError.message : t('profileSkipError'));
    } finally {
      setSkipping(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-xl font-semibold">{t('profileTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('profileDescription')}</p>
      </div>

      <div
        className={`border p-5 text-sm ${
          error
            ? 'border-destructive/30 bg-destructive/10 text-destructive'
            : 'border-border bg-muted/20 text-muted-foreground'
        }`}
        role={error ? 'alert' : 'status'}
      >
        <div className="flex items-start gap-3">
          {loading ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" /> : <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />}
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              {error ? t('profileSessionError') : t('profileSessionPreparing')}
            </p>
            <p>{error || t('profileSessionPreparingDescription')}</p>
          </div>
        </div>
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={() => void handleSkip()} disabled={skipping} className="gap-2">
          {skipping && <Loader2 className="h-4 w-4 animate-spin" />}
          {skipping ? t('profileSkipping') : t('profileSkip')}
        </Button>
        <Button onClick={onRetry} disabled={loading || skipping} className="gap-2">
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {error ? t('profileSessionRetry') : t('profileSessionPreparingAction')}
        </Button>
      </div>
    </div>
  );
}

function AgentProfileStep({
  sessionId,
  onComplete,
}: {
  sessionId: string;
  onComplete: () => void;
}) {
  const t = useTranslations('onboarding');
  const [skipping, setSkipping] = useState(false);
  const [profileCompleteDetected, setProfileCompleteDetected] = useState(false);
  const [runtimePhase, setRuntimePhase] = useState<OnboardingRuntimePhase>('idle');
  const completedRef = useRef(false);
  const skipRequestInFlightRef = useRef(false);

  useEffect(() => {
    if (!profileCompleteDetected || runtimePhase !== 'idle' || completedRef.current) {
      return;
    }

    completedRef.current = true;
    toast.success(t('profileCompleteDetected'));
    onComplete();
  }, [onComplete, profileCompleteDetected, runtimePhase, t]);

  useEffect(() => {
    let cancelled = false;

    async function checkStatus() {
      try {
        const response = await fetch('/api/onboarding/status', { cache: 'no-store' });
        const data = (await response.json().catch(() => ({}))) as { profileComplete?: boolean };
        if (!cancelled && data.profileComplete) {
          setProfileCompleteDetected(true);
        }
      } catch {
        // Polling is best-effort; the user can still continue after a successful skip.
      }
    }

    void checkStatus();
    const timer = window.setInterval(() => void checkStatus(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [onComplete, t]);

  async function handleSkip() {
    if (skipRequestInFlightRef.current) {
      return;
    }

    skipRequestInFlightRef.current = true;
    setSkipping(true);
    try {
      const response = await fetch('/api/onboarding/profile-skip', {
        method: 'POST',
      });
      const data = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string; code?: string };
      if (!response.ok || !data.success) {
        throw new Error(data.code ? `${data.error || t('profileSkipError')} (${data.code})` : data.error || t('profileSkipError'));
      }
      toast.success(t('profileSkipped'));
      onComplete();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('profileSkipError'));
    } finally {
      skipRequestInFlightRef.current = false;
      setSkipping(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 text-xl font-semibold">{t('profileTitle')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('profileDescription')}
        </p>
      </div>

      <div className="h-[68vh] min-h-[460px] max-h-[720px] overflow-hidden border border-border bg-background">
        <CanvasAgentChat
          hideNavHeader
          forcedSessionId={sessionId}
          isSurfaceVisible
          requestContext={{ currentPage: 'onboarding' }}
          onRuntimeStatusChange={(status) => setRuntimePhase((status?.phase || 'idle') as OnboardingRuntimePhase)}
        />
      </div>

      <div className="flex justify-end">
        <Button variant="outline" onClick={handleSkip} disabled={skipping} className="gap-2">
          {skipping && <Loader2 className="h-4 w-4 animate-spin" />}
          {skipping ? t('profileSkipping') : t('profileSkip')}
        </Button>
      </div>
    </div>
  );
}

function TourStep({ guidedHintsEnabled, onDone }: { guidedHintsEnabled: boolean; onDone: () => void }) {
  const t = useTranslations('onboarding');
  const [saving, setSaving] = useState<'started' | 'skipped' | null>(null);

  async function finish(tour: 'started' | 'skipped') {
    if (saving) return;
    setSaving(tour);
    try {
      const response = await fetch('/api/onboarding/user', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'complete', tour }),
      });
      if (!response.ok) {
        throw new Error('Could not save tour preference.');
      }
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('unexpectedError'));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <Compass className="mx-auto mb-4 h-12 w-12 text-primary" />
        <h2 className="mb-2 text-xl font-semibold">{guidedHintsEnabled ? t('tourTitle') : t('tourDisabledTitle')}</h2>
        <p className="text-sm text-muted-foreground">
          {guidedHintsEnabled ? t('tourDescription') : t('tourDisabledDescription')}
        </p>
      </div>

      {guidedHintsEnabled && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="border border-border bg-muted/20 p-4">
            <Sparkles className="mb-3 h-5 w-5 text-primary" />
            <h3 className="text-sm font-semibold">{t('tourWorkspaceTitle')}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('tourWorkspaceDescription')}</p>
          </div>
          <div className="border border-border bg-muted/20 p-4">
            <Workflow className="mb-3 h-5 w-5 text-primary" />
            <h3 className="text-sm font-semibold">{t('tourAutomationsTitle')}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('tourAutomationsDescription')}</p>
          </div>
          <div className="border border-border bg-muted/20 p-4">
            <Compass className="mb-3 h-5 w-5 text-primary" />
            <h3 className="text-sm font-semibold">{t('tourSettingsTitle')}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('tourSettingsDescription')}</p>
          </div>
        </div>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {guidedHintsEnabled && (
          <Button variant="outline" onClick={() => void finish('skipped')} disabled={saving !== null}>
            {t('tourSkip')}
          </Button>
        )}
        <Button onClick={() => void finish(guidedHintsEnabled ? 'started' : 'skipped')} disabled={saving !== null} className="gap-2">
          {saving !== null && <Loader2 className="h-4 w-4 animate-spin" />}
          {guidedHintsEnabled ? t('tourStart') : t('tourContinue')}
        </Button>
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

  const { beginPolling, pendingActivation } = useLicenseEmailActivation({
    licensed: Boolean(status?.licensed),
    onActivated: async () => {
      await fetchLicenseStatus();
      toast.success(t('licenseActivatedAutomatically'));
    },
  });

  async function requestLicense() {
    setRegistering(true);
    try {
      const response = await fetch('/api/license/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, activationPath: getLicenseRegistrationActivationPath('/onboarding'), marketingOptIn }),
      });
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        error?: string;
        code?: string;
        activation?: PublicLicenseEmailActivation | null;
      };
      if (!response.ok || !payload.success) {
        throw new Error(payload.code ? `${payload.error || t('licenseRequestFailed')} (${payload.code})` : payload.error || t('licenseRequestFailed'));
      }
      beginPolling(payload.activation || null);
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

  function skipLicenseActivation() {
    clearStoredOnboardingLicenseKey();
    onContinue();
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

          {pendingActivation ? (
            <div className="flex items-start gap-3 border border-border bg-muted/30 p-3 text-sm">
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              <div>
                <p className="font-medium">{t('licenseActivationPendingTitle')}</p>
                <p className="mt-1 leading-5 text-muted-foreground">
                  {t('licenseActivationPendingDescription')}
                </p>
              </div>
            </div>
          ) : null}

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
            <Button variant="secondary" onClick={skipLicenseActivation}>
              {t('licenseSkip')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ServerSettingsStep({
  initialTimeZone,
  onContinue,
}: {
  initialTimeZone: string;
  onContinue: () => Promise<void> | void;
}) {
  const t = useTranslations('onboarding');
  const [timeZone, setTimeZone] = useState(() => normalizeTimeZone(initialTimeZone, DEFAULT_USER_TIME_ZONE));
  const [saving, setSaving] = useState(false);
  const timeZoneOptions = useMemo(() => getSupportedTimeZones(timeZone), [timeZone]);

  async function continueWithServerSettings() {
    setSaving(true);
    try {
      const response = await fetch('/api/server-settings', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeZone: normalizeTimeZone(timeZone) }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || t('serverSettingsSaveFailed'));
      }
      await logOnboardingClientEvent('instance.server-settings.saved', { timeZone: normalizeTimeZone(timeZone) });
      await onContinue();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('serverSettingsSaveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <ServerCog className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
        <h2 className="mb-1 text-xl font-semibold">{t('serverSettingsTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('serverSettingsDescription')}</p>
      </div>

      <div className="rounded-lg border border-border bg-muted/20 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Clock3 className="h-4 w-4 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold">{t('timeZoneTitle')}</h3>
            <p className="text-xs text-muted-foreground">{t('timeZoneDescription')}</p>
          </div>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">{t('timeZoneLabel')}</span>
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            value={timeZone}
            onChange={(event) => setTimeZone(normalizeTimeZone(event.target.value))}
            disabled={saving}
          >
            {timeZoneOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
      </div>

      <div className="flex justify-center">
        <Button onClick={() => void continueWithServerSettings()} className="min-w-[200px]" disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('serverSettingsContinue')}
        </Button>
      </div>
    </div>
  );
}

type WorkspaceReadiness = {
  teamFeaturesEnabled?: boolean;
  databaseProvider?: string;
  defaultWorkspace?: {
    id?: string;
    type?: 'personal' | 'organization' | 'team' | 'project';
    name?: string;
  } | null;
  workspaces?: Array<{
    id?: string;
    type?: 'personal' | 'organization' | 'team' | 'project';
    name?: string;
  }>;
};

function WorkspaceReadinessStep({
  mode,
  onContinue,
}: {
  mode: OnboardingMode;
  onContinue: () => void;
}) {
  const t = useTranslations('onboarding');
  const [state, setState] = useState<WorkspaceReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/workspaces', { credentials: 'include', cache: 'no-store' });
      const payload = await response.json().catch(() => ({})) as WorkspaceReadiness & { error?: string; success?: boolean };
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('workspaceLoadFailed'));
      }
      setState(payload);
    } catch (workspaceError) {
      setError(workspaceError instanceof Error ? workspaceError.message : t('workspaceLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const workspaces = state?.workspaces || [];
  const personal = workspaces.find((workspace) => workspace.type === 'personal') || state?.defaultWorkspace;
  const shared = workspaces.find((workspace) => workspace.type === 'organization' || workspace.type === 'team');
  const isTeamMode = state?.teamFeaturesEnabled === true;
  const instanceCopy = mode === 'instance';

  return (
    <div className="space-y-6">
      <div className="text-center">
        {isTeamMode ? <Users className="mx-auto mb-4 h-12 w-12 text-muted-foreground" /> : <FolderKanban className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />}
        <h2 className="mb-1 text-xl font-semibold">{t(instanceCopy ? 'instanceWorkspaceTitle' : 'personalWorkspaceTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t(instanceCopy ? 'instanceWorkspaceDescription' : 'personalWorkspaceDescription')}</p>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('workspaceChecking')}
        </div>
      )}

      {error && (
        <div className="space-y-3 border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <p>{error}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>{t('workspaceRetry')}</Button>
        </div>
      )}

      {!loading && !error && (
        <div className="grid gap-3 sm:grid-cols-2">
          <WorkspaceStatusCard icon={FolderKanban} title={t('personalWorkspaceCardTitle')} description={t('personalWorkspaceCardDescription')} name={personal?.name} />
          {shared ? (
            <WorkspaceStatusCard icon={Users} title={t('teamWorkspaceCardTitle')} description={t(instanceCopy ? 'teamWorkspaceInstanceDescription' : 'teamWorkspaceUserDescription')} name={shared?.name} />
          ) : null}
        </div>
      )}

      <div className="flex justify-center">
        <Button onClick={onContinue} className="min-w-[200px]" disabled={loading || Boolean(error)}>
          {t(instanceCopy ? 'workspaceContinueReview' : 'workspaceContinue')}
        </Button>
      </div>
    </div>
  );
}

function WorkspaceStatusCard({
  icon: Icon,
  title,
  description,
  name,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  name?: string;
}) {
  return (
    <div className="border border-border bg-muted/20 p-4">
      <Icon className="mb-3 h-5 w-5 text-primary" />
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      {name && <p className="mt-3 text-xs font-medium text-foreground">{name}</p>}
    </div>
  );
}

function InstanceReviewStep({ onComplete }: { onComplete: () => void }) {
  const t = useTranslations('onboarding');
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogSummary, setCatalogSummary] = useState<{
    revision: number;
    provider: string;
    model: string;
    status: string;
    ready: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetch('/api/admin/agent-runtime/catalog', { credentials: 'include', cache: 'no-store' })
        .then(async (response) => {
          const payload = await response.json().catch(() => null) as {
            success?: boolean;
            error?: string;
            data?: {
              catalog?: {
                revision: number;
                defaultSelection: { providerInstallationId: string; modelId: string } | null;
                providers: Array<{
                  installationId: string;
                  name: string;
                  status: string;
                  models: Array<{ id: string; name: string; enabled: boolean }>;
                }>;
              };
            };
          } | null;
          if (!response.ok || !payload?.success || !payload.data?.catalog?.defaultSelection) {
            throw new Error(payload?.error || t('instanceReviewCatalogError'));
          }
          const catalog = payload.data.catalog;
          const provider = catalog.providers.find((entry) => (
            entry.installationId === catalog.defaultSelection?.providerInstallationId
          ));
          const model = provider?.models.find((entry) => entry.id === catalog.defaultSelection?.modelId);
          if (!provider || !model?.enabled) throw new Error(t('instanceReviewCatalogError'));
          if (!cancelled) {
            setCatalogSummary({
              revision: catalog.revision,
              provider: provider.name,
              model: model.name || model.id,
              status: provider.status,
              ready: provider.status === 'ready',
            });
          }
        })
        .catch((catalogError: unknown) => {
          if (!cancelled) {
            setCatalogSummary(null);
            setError(catalogError instanceof Error ? catalogError.message : t('instanceReviewCatalogError'));
          }
        })
        .finally(() => {
          if (!cancelled) setCatalogLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [t]);

  async function completeInstanceSetup() {
    setCompleting(true);
    setError(null);
    try {
      const response = await fetch('/api/onboarding/complete', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || t('instanceCompleteError'));
      onComplete();
    } catch (completionError) {
      const message = completionError instanceof Error ? completionError.message : t('instanceCompleteError');
      setError(message);
    } finally {
      setCompleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <CheckCircle2 className="mx-auto mb-4 h-12 w-12 text-primary" />
        <h2 className="mb-1 text-xl font-semibold">{t('instanceReviewTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('instanceReviewDescription')}</p>
      </div>
      <div className="space-y-3 border border-border bg-muted/20 p-4 text-sm">
        <p className="font-medium">{t('instanceReviewChecklistTitle')}</p>
        <ul className="space-y-2 text-muted-foreground">
          <li>✓ {t('instanceReviewTimeZone')}</li>
          <li>✓ {t('instanceReviewLicense')}</li>
          <li>✓ {t('instanceReviewProvider')}</li>
          <li>✓ {t('instanceReviewWorkspace')}</li>
        </ul>
      </div>
      {catalogLoading && (
        <div className="flex items-center gap-2 border border-border bg-muted/20 p-3 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('instanceReviewCatalogLoading')}
        </div>
      )}
      {catalogSummary && (
        <dl className="grid gap-3 border border-border bg-background p-4 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-muted-foreground">{t('instanceReviewCatalogRevision')}</dt><dd className="font-medium">r{catalogSummary.revision}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('instanceReviewCatalogStatus')}</dt><dd className="font-medium">{catalogSummary.status}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('instanceReviewCatalogProvider')}</dt><dd className="font-medium">{catalogSummary.provider}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('instanceReviewCatalogModel')}</dt><dd className="font-medium">{catalogSummary.model}</dd></div>
        </dl>
      )}
      {error && <div className="border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      <Button onClick={() => void completeInstanceSetup()} className="w-full" disabled={completing || catalogLoading || !catalogSummary?.ready}>
        {completing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t('instanceCompleteAction')}
      </Button>
    </div>
  );
}

function LanguageStep({
  initialUserProfile,
  onContinue,
}: {
  initialUserProfile: ResolvedUserProfile;
  onContinue: () => Promise<void> | void;
}) {
  const t = useTranslations('onboarding');
  const [isSaving, setIsSaving] = useState(false);
  const [isSwitchingLocale, setIsSwitchingLocale] = useState(false);
  const searchParams = useSearchParams();
  const currentLocale = useLocale();
  const selectedLocale = useSyncExternalStore(
    subscribeToBrowserLocation,
    () => getBrowserPathLocale(currentLocale),
    () => currentLocale,
  );
  const isHydrated = useSyncExternalStore(subscribeToBrowserLocation, () => true, () => false);

  async function handleSelectLocale(locale: string) {
    const activeLocale = getBrowserPathLocale(currentLocale);
    if (locale === activeLocale || isSaving || isSwitchingLocale) return;
    setIsSwitchingLocale(true);
    try {
      const response = await fetch('/api/user-preferences', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
      });
      if (!response.ok) {
        throw new Error(`Could not save language (${response.status}).`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('preferencesSaveFailed'));
      setIsSwitchingLocale(false);
      return;
    }
    const query = searchParams.toString();
    const pathname = window.location.pathname.replace(/^\/(?:de|en)(?=\/|$)/u, '') || '/onboarding';
    window.location.assign(`${buildLocalePath(locale, pathname)}${query ? `?${query}` : ''}`);
  }

  async function handleContinue() {
    const activeLocale = getBrowserPathLocale(currentLocale);
    setIsSaving(true);
    await logOnboardingClientEvent('language.continue.clicked', {
      selectedLocale: activeLocale,
      currentLocale: activeLocale,
      scope: 'user',
    });
    try {
      await saveOnboardingPreferences(activeLocale);
      await onContinue();
    } catch (error) {
      console.error('[Onboarding] Failed to save language/time zone preferences:', error);
      await logOnboardingClientEvent('language.continue.failed', {
        selectedLocale,
        message: error instanceof Error ? error.message : String(error),
      }, 'error');
      toast.error(t('preferencesSaveFailed'));
    } finally {
      setIsSaving(false);
    }
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
            onClick={() => void handleSelectLocale(locale)}
            disabled={!isHydrated || isSaving || isSwitchingLocale}
            className={`flex flex-col items-center gap-2 rounded-lg border-2 p-6 transition-colors ${
              locale === selectedLocale
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-border bg-card hover:border-muted-foreground/40 hover:bg-muted/50'
            }`}
          >
            <span className="text-3xl">{locale === 'de' ? '🇩🇪' : '🇬🇧'}</span>
            <span className="text-lg font-semibold">
              {locale === 'de' ? 'Deutsch' : 'English'}
            </span>
            {locale === selectedLocale && (
              <span className="text-xs font-medium text-primary">{t('languageActive')}</span>
            )}
          </button>
        ))}
      </div>

      <ProfileAppearanceEditor initialProfile={initialUserProfile} />

      <div className="flex justify-center">
        <Button onClick={handleContinue} className="min-w-[200px]" disabled={!isHydrated || isSaving || isSwitchingLocale}>
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('languageContinue')}
        </Button>
      </div>
    </div>
  );
}
