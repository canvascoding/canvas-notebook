'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authClient } from '@/app/lib/auth-client';
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

export default function SignUpForm() {
  const t = useTranslations('signUp');
  const locale = useLocale();
  const searchParams = useSearchParams();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password !== confirmPassword) {
      toast.error(t('passwordMismatch'));
      return;
    }

    setLoading(true);

    try {
      const { error } = await authClient.signUp.email({
        name,
        email,
        password,
      });

      if (error) {
        toast.error(error.message || t('signUpFailed'));
      } else {
        toast.success(t('signUpSuccessful'));
        window.location.href = resolvePostAuthRedirect(locale, searchParams.get('from'));
      }
    } catch (err) {
      toast.error(t('unexpectedError'));
      console.error('Sign-up error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md border border-border bg-card p-8 shadow-sm">
        <div className="flex items-center justify-center mb-8">
          <Image src="/logo.jpg" alt={t('logoAlt')} width={48} height={48} className="mr-3 border border-border" />
          <h1 className="text-3xl font-bold text-foreground">{t('title')}</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-foreground/90 mb-2">
              {t('name')}
            </label>
            <Input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
              className="placeholder:text-muted-foreground"
              required
              autoFocus
            />
          </div>

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
              minLength={8}
            />
          </div>

          <div>
            <label htmlFor="confirmPassword" className="block text-sm font-medium text-foreground/90 mb-2">
              {t('confirmPassword')}
            </label>
            <Input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder={t('confirmPasswordPlaceholder')}
              className="placeholder:text-muted-foreground"
              required
              minLength={8}
            />
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={loading}
          >
            {loading ? t('creatingAccount') : t('createAccountButton')}
          </Button>
        </form>
      </div>
    </div>
  );
}
