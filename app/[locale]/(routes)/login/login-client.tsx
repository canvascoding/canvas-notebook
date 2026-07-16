'use client';

import { Suspense, useState } from 'react';
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
import { Eye, EyeOff } from 'lucide-react';

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
  const passwordToggleLabel = showPassword ? t('hidePassword') : t('showPassword');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const { error } = await authClient.signIn.email({
        email,
        password,
      });

      if (error) {
        toast.error(error.message || t('loginFailed'));
      } else {
        toast.success(t('loginSuccessful'));
        window.dispatchEvent(new CustomEvent('ws-auth-success'));
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>
      <div className="w-full max-w-md border border-border bg-card p-8 shadow-sm">
        <div className="mb-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <PublicBrandLogo
            alt={t('logoAlt')}
            width={144}
            height={40}
            sizes="(min-width: 640px) 144px, 128px"
            fallbackSrc="/logo-login.webp"
            className="h-10 max-w-36 shrink-0 object-contain"
            fallbackClassName="w-10 border border-border object-cover"
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

export default function LoginClient() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
