'use client';

import { Suspense, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { authClient } from '@/app/lib/auth-client';
import { LanguageSwitcher } from '@/app/components/language-switcher';
import { PublicBrandLogo } from '@/app/components/branding/PublicBrandLogo';
import { toast } from 'sonner';
import { routing } from '@/i18n/routing';
import { Eye, EyeOff, LoaderCircle, ShieldCheck } from 'lucide-react';

function buildLocalePath(locale: string, pathname: string) {
  if (locale === routing.defaultLocale) {
    return pathname;
  }

  return pathname === '/' ? `/${locale}` : `/${locale}${pathname}`;
}

function resolvePostAuthRedirect(locale: string, from: string | null) {
  if (!from || !from.startsWith('/') || from.startsWith('//')) {
    return buildLocalePath(locale, '/');
  }

  const hasLocalePrefix = routing.locales.some(
    (candidate) => from === `/${candidate}` || from.startsWith(`/${candidate}/`)
  );

  if (hasLocalePrefix || locale === routing.defaultLocale) {
    return from;
  }

  return buildLocalePath(locale, from);
}

function readOAuthRedirect(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  return record.redirect === true && typeof record.url === 'string' && record.url
    ? record.url
    : null;
}

async function resolvePreferredLocale(fallbackLocale: string): Promise<string> {
  try {
    const response = await fetch('/api/user-preferences', { credentials: 'include', cache: 'no-store' });
    const payload = await response.json().catch(() => ({})) as { data?: { locale?: unknown } };
    const locale = payload.data?.locale;
    return typeof locale === 'string' && routing.locales.includes(locale as 'de' | 'en') ? locale : fallbackLocale;
  } catch {
    return fallbackLocale;
  }
}

function LoginForm() {
  const t = useTranslations('login');
  const locale = useLocale();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resuming, setResuming] = useState(false);
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const passwordToggleLabel = showPassword ? t('hidePassword') : t('showPassword');
  const isOAuthContinuation = searchParams.has('sig')
    && searchParams.getAll('ba_param').length > 0;

  useEffect(() => {
    if (!session || isOAuthContinuation || resuming) return;

    let cancelled = false;

    void resolvePreferredLocale(locale).then((preferredLocale) => {
      if (!cancelled) {
        setResuming(true);
        // Let the server make the final decision about onboarding and the
        // destination. Replacing the page keeps an old login screen from
        // briefly reappearing when a mobile browser resumes from background.
        window.location.replace(resolvePostAuthRedirect(preferredLocale, searchParams.get('from')));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isOAuthContinuation, locale, resuming, searchParams, session]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const { data, error } = await authClient.signIn.email({
        email,
        password,
      });

      if (error) {
        toast.error(error.message || t('loginFailed'));
      } else {
        toast.success(t('loginSuccessful'));
        window.dispatchEvent(new CustomEvent('ws-auth-success'));
        if (isOAuthContinuation) {
          const oauthRedirect = readOAuthRedirect(data);
          if (!oauthRedirect) {
            toast.error(t('oauthContinuationFailed'));
            return;
          }
          window.location.assign(oauthRedirect);
          return;
        }
        const preferredLocale = await resolvePreferredLocale(locale);
        window.location.assign(resolvePostAuthRedirect(preferredLocale, searchParams.get('from')));
      }
    } catch (err) {
      toast.error(t('unexpectedError'));
      console.error('Login error:', err);
    } finally {
      setLoading(false);
    }
  };

  if (!isOAuthContinuation && (sessionPending || session || resuming)) {
    return <SessionRestoreScreen isRedirecting={Boolean(session || resuming)} />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="absolute right-4 top-4">
        <LanguageSwitcher preserveSearch={isOAuthContinuation} />
      </div>
      <div className="w-full max-w-md border border-border bg-card p-8 shadow-sm">
        <div className="mb-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <PublicBrandLogo
            alt={t('logoAlt')}
            width={144}
            height={40}
            sizes="(min-width: 640px) 144px, 128px"
            className="h-10 max-w-36 shrink-0 object-contain"
            fallbackClassName="w-10 object-contain"
            brandClassName="w-auto"
          />
          <h1 className="text-center text-3xl font-bold text-foreground">{t('title')}</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6" suppressHydrationWarning>
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-foreground/90 mb-2">
              {t('email')}
            </label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('emailPlaceholder')}
              className="placeholder:text-muted-foreground"
              required
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-foreground/90 mb-2">
              {t('password')}
            </label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('passwordPlaceholder')}
                className="pr-11 placeholder:text-muted-foreground"
                required
              />
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      aria-label={passwordToggleLabel}
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword((visible) => !visible)}
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{passwordToggleLabel}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={loading}
          >
            {loading ? t('loggingIn') : t('loginButton')}
          </Button>
        </form>
      </div>
    </div>
  );
}

function SessionRestoreScreen({ isRedirecting }: { isRedirecting: boolean }) {
  const t = useTranslations('login');

  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-background px-5 py-8 text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,color-mix(in_oklab,var(--primary)_10%,transparent),transparent_48%)]" />
      <section
        aria-live="polite"
        className="relative w-full max-w-sm rounded-2xl border border-border/80 bg-card/90 p-7 text-center shadow-lg backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95"
      >
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          {isRedirecting
            ? <ShieldCheck className="size-6" aria-hidden="true" />
            : <LoaderCircle className="size-6 animate-spin" aria-hidden="true" />}
        </div>
        <p className="mt-5 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Canvas Notebook</p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{t(isRedirecting ? 'sessionRestoredTitle' : 'sessionCheckingTitle')}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t(isRedirecting ? 'sessionRestoredDescription' : 'sessionCheckingDescription')}
        </p>
        <div className="mx-auto mt-6 h-1 w-24 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div className="h-full w-1/2 rounded-full bg-primary motion-safe:animate-[session-progress_1.15s_ease-in-out_infinite]" />
        </div>
      </section>
    </main>
  );
}

export default function LoginClient() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
