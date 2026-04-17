'use client';

import { Suspense, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authClient } from '@/app/lib/auth-client';
import { LanguageSwitcher } from '@/app/components/language-switcher';
import { toast } from 'sonner';
import Image from 'next/image';
import { routing } from '@/i18n/routing';

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

function LoginForm() {
  const t = useTranslations('login');
  const locale = useLocale();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

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
        window.location.href = resolvePostAuthRedirect(locale, searchParams.get('from'));
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
        <div className="flex items-center justify-center mb-8">
          <Image src="/logo.jpg" alt={t('logoAlt')} width={48} height={48} className="mr-3 border border-border" />
          <h1 className="text-3xl font-bold text-foreground">{t('title')}</h1>
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
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('passwordPlaceholder')}
              className="placeholder:text-muted-foreground"
              required
            />
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