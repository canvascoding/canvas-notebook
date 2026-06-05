'use client';

import { Suspense, useState } from 'react';
import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import { Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { LanguageSwitcher } from '@/app/components/language-switcher';
import { authClient } from '@/app/lib/auth-client';
import { routing } from '@/i18n/routing';

function buildLocalePath(locale: string, pathname: string) {
  if (locale === routing.defaultLocale) {
    return pathname;
  }

  return pathname === '/' ? `/${locale}` : `/${locale}${pathname}`;
}

type SetupResponse = {
  success?: boolean;
  error?: string;
  code?: string;
  field?: 'name' | 'email' | 'password';
};

function SetupForm() {
  const t = useTranslations('setup');
  const locale = useLocale();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const passwordToggleLabel = showPassword ? t('hidePassword') : t('showPassword');

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (password !== confirmPassword) {
      toast.error(t('passwordMismatch'));
      return;
    }

    setLoading(true);

    try {
      const response = await fetch('/api/setup/owner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      const payload = await response.json().catch(() => ({})) as SetupResponse;

      if (!response.ok) {
        if (response.status === 409) {
          toast.error(t('alreadyConfigured'));
          window.location.href = buildLocalePath(locale, '/login');
          return;
        }

        toast.error(payload.error || t('setupFailed'));
        return;
      }

      const { error } = await authClient.signIn.email({ email, password });
      if (error) {
        toast.error(error.message || t('loginAfterSetupFailed'));
        window.location.href = buildLocalePath(locale, '/login');
        return;
      }

      toast.success(t('setupSuccessful'));
      window.dispatchEvent(new CustomEvent('ws-auth-success'));
      window.location.href = buildLocalePath(locale, '/onboarding');
    } catch (error) {
      toast.error(t('unexpectedError'));
      console.error('Initial setup error:', error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>
      <div className="w-full max-w-md border border-border bg-card p-8 shadow-sm">
        <div className="mb-8 flex items-center justify-center">
          <Image
            src="/logo-login.webp"
            alt={t('logoAlt')}
            width={40}
            height={40}
            sizes="40px"
            unoptimized
            className="mr-3 h-10 w-10 border border-border"
          />
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('eyebrow')}</p>
            <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5" suppressHydrationWarning>
          <div>
            <label htmlFor="setup-name" className="mb-2 block text-sm font-medium text-foreground/90">
              {t('name')}
            </label>
            <Input
              id="setup-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('namePlaceholder')}
              className="placeholder:text-muted-foreground"
              required
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="setup-email" className="mb-2 block text-sm font-medium text-foreground/90">
              {t('email')}
            </label>
            <Input
              id="setup-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t('emailPlaceholder')}
              className="placeholder:text-muted-foreground"
              required
            />
          </div>

          <div>
            <label htmlFor="setup-password" className="mb-2 block text-sm font-medium text-foreground/90">
              {t('password')}
            </label>
            <div className="relative">
              <Input
                id="setup-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t('passwordPlaceholder')}
                className="pr-11 placeholder:text-muted-foreground"
                required
                minLength={8}
                maxLength={128}
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
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{passwordToggleLabel}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>

          <div>
            <label htmlFor="setup-confirm-password" className="mb-2 block text-sm font-medium text-foreground/90">
              {t('confirmPassword')}
            </label>
            <Input
              id="setup-confirm-password"
              type={showPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder={t('confirmPasswordPlaceholder')}
              className="placeholder:text-muted-foreground"
              required
              minLength={8}
              maxLength={128}
            />
          </div>

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? t('creatingAccount') : t('createAccountButton')}
          </Button>
        </form>
      </div>
    </div>
  );
}

export default function SetupClient() {
  return (
    <Suspense>
      <SetupForm />
    </Suspense>
  );
}
