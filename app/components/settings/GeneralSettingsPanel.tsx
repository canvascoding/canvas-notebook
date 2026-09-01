'use client';

import { FormEvent, useMemo, useState, useTransition } from 'react';
import { useParams } from 'next/navigation';
import { usePathname } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { buildLocalePath } from '@/app/lib/locale-path';
import { useTranslations } from 'next-intl';
import { Clock3, KeyRound, Languages, Mail, User } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getSupportedTimeZones, normalizeTimeZone } from '@/app/lib/time-zones';
import type { ResolvedUserProfile } from '@/app/lib/user-profile/types';
import { ProfileAppearanceEditor } from '@/app/components/user-profile/ProfileAppearanceEditor';
import { SettingsAccordionCard } from './SettingsAccordionCard';

async function saveUserPreferences(payload: { locale?: string }): Promise<void> {
  const response = await fetch('/api/user-preferences', {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Failed to save user preferences (${response.status}).`);
  }
}

async function saveServerPreferredTimeZone(timeZone: string): Promise<void> {
  const response = await fetch('/api/server-settings', {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeZone }),
  });

  if (!response.ok) {
    throw new Error(`Failed to save server time zone (${response.status}).`);
  }
}

async function updateLoginEmail(payload: { newEmail: string; currentPassword: string }): Promise<void> {
  const response = await fetch('/api/account/email', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as { success?: boolean; error?: string };

  if (!response.ok || !body.success) {
    throw new Error(body.error || `Failed to update login email (${response.status}).`);
  }
}

async function updatePassword(payload: { currentPassword: string; newPassword: string }): Promise<void> {
  const response = await fetch('/api/auth/change-password', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, revokeOtherSessions: true }),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };

  if (!response.ok) {
    throw new Error(body.message || `Failed to update password (${response.status}).`);
  }
}

export function GeneralSettingsPanel({
  userName = '',
  userEmail = '',
  initialUserProfile,
  isAdmin = false,
  initialTimeZone,
}: {
  userName?: string;
  userEmail?: string;
  initialUserProfile: ResolvedUserProfile;
  isAdmin?: boolean;
  initialTimeZone?: string;
}) {
  const t = useTranslations('settings');
  const [isPending, startTransition] = useTransition();
  const [isSavingLocale, setIsSavingLocale] = useState(false);
  const pathname = usePathname();
  const params = useParams();
  const currentLocale = (params.locale as string) || routing.defaultLocale;
  const [timeZone, setTimeZone] = useState(() => normalizeTimeZone(initialTimeZone));
  const timeZoneOptions = useMemo(() => getSupportedTimeZones(timeZone), [timeZone]);
  const [loginEmail, setLoginEmail] = useState(userEmail);
  const [emailPassword, setEmailPassword] = useState('');
  const [isSavingEmail, setIsSavingEmail] = useState(false);
  const [emailChangeComplete, setEmailChangeComplete] = useState(false);
  const [isLoginInfoOpen, setIsLoginInfoOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [isPasswordOpen, setIsPasswordOpen] = useState(false);

  async function handleSelectLocale(locale: string) {
    if (locale === currentLocale || isSavingLocale) return;
    setIsSavingLocale(true);
    try {
      await saveUserPreferences({ locale });
      window.location.assign(buildLocalePath(locale, pathname));
    } catch (error) {
      console.warn('[Settings] Failed to save preferred locale:', error);
      toast.error(t('general.languageSaveFailed'));
      setIsSavingLocale(false);
    }
  }

  function handleSelectTimeZone(nextTimeZone: string) {
    const normalizedTimeZone = normalizeTimeZone(nextTimeZone);
    setTimeZone(normalizedTimeZone);
    startTransition(() => {
      void saveServerPreferredTimeZone(normalizedTimeZone).catch((error) => {
        console.warn('[Settings] Failed to save server time zone:', error);
        toast.error(t('general.timeZoneSaveFailed'));
      });
    });
  }

  async function handleEmailSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSavingEmail || emailChangeComplete) return;

    const nextEmail = loginEmail.trim().toLowerCase();
    if (!nextEmail || !emailPassword) {
      toast.error(t('general.account.emailValidation'));
      return;
    }

    setIsSavingEmail(true);
    try {
      await updateLoginEmail({ newEmail: nextEmail, currentPassword: emailPassword });
      setEmailChangeComplete(true);
      setEmailPassword('');
      toast.success(t('general.account.emailUpdated'));
      window.setTimeout(() => {
        window.location.assign(buildLocalePath(currentLocale, '/login'));
      }, 900);
    } catch (error) {
      console.warn('[Settings] Failed to update login email:', error);
      toast.error(error instanceof Error ? error.message : t('general.account.emailUpdateFailed'));
      setIsSavingEmail(false);
    }
  }

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSavingPassword) return;

    if (!currentPassword || newPassword.length < 8) {
      toast.error(t('general.account.passwordValidation'));
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error(t('general.account.passwordMismatch'));
      return;
    }

    setIsSavingPassword(true);
    try {
      await updatePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success(t('general.account.passwordUpdated'));
    } catch (error) {
      console.warn('[Settings] Failed to update password:', error);
      toast.error(error instanceof Error ? error.message : t('general.account.passwordUpdateFailed'));
    } finally {
      setIsSavingPassword(false);
    }
  }

  return (
    <div className="space-y-4">
      <SettingsAccordionCard
        title={t('general.loginInfoTitle')}
        description={t('general.loginInfoDescription')}
        icon={User}
        isOpen={isLoginInfoOpen}
        onOpenChange={setIsLoginInfoOpen}
        summaryItems={userEmail ? [userEmail] : []}
        contentClassName="space-y-4"
      >
          {(userName || userEmail) && (
            <div className="space-y-2">
              {userEmail && (
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground">{t('general.loginInfoEmail')}:</span>
                  <span className="font-medium">{userEmail}</span>
                </div>
              )}
              {userName && userName !== userEmail && (
                <div className="flex items-center gap-2 text-sm">
                  <User className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground">{t('general.loginInfoName')}:</span>
                  <span className="font-medium">{userName}</span>
                </div>
              )}
            </div>
          )}
          <form onSubmit={handleEmailSubmit} className="grid gap-3 rounded-lg border border-border bg-muted/25 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="settings-login-email">{t('general.account.newEmail')}</Label>
              <Input
                id="settings-login-email"
                type="email"
                autoComplete="email"
                value={loginEmail}
                onChange={(event) => setLoginEmail(event.target.value)}
                disabled={isSavingEmail || emailChangeComplete}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-email-current-password">{t('general.account.currentPassword')}</Label>
              <Input
                id="settings-email-current-password"
                type="password"
                autoComplete="current-password"
                value={emailPassword}
                onChange={(event) => setEmailPassword(event.target.value)}
                disabled={isSavingEmail || emailChangeComplete}
                required
              />
            </div>
            <Button type="submit" disabled={isSavingEmail || emailChangeComplete}>
              {emailChangeComplete ? t('general.account.emailRedirecting') : isSavingEmail ? t('general.account.saving') : t('general.account.saveEmail')}
            </Button>
            <p className="text-xs leading-5 text-muted-foreground sm:col-span-3">
              {emailChangeComplete ? t('general.account.emailUpdateComplete') : t('general.account.emailHint')}
            </p>
          </form>
      </SettingsAccordionCard>

      <SettingsAccordionCard
        title={t('general.account.passwordTitle')}
        description={t('general.account.passwordDescription')}
        icon={KeyRound}
        isOpen={isPasswordOpen}
        onOpenChange={setIsPasswordOpen}
      >
          <form onSubmit={handlePasswordSubmit} className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="settings-current-password">{t('general.account.currentPassword')}</Label>
              <Input
                id="settings-current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                disabled={isSavingPassword}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-new-password">{t('general.account.newPassword')}</Label>
              <Input
                id="settings-new-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={isSavingPassword}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-confirm-password">{t('general.account.confirmPassword')}</Label>
              <Input
                id="settings-confirm-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={isSavingPassword}
                required
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2">
              <p className="text-xs leading-5 text-muted-foreground">{t('general.account.passwordHint')}</p>
              <Button type="submit" disabled={isSavingPassword}>
                {isSavingPassword ? t('general.account.saving') : t('general.account.savePassword')}
              </Button>
            </div>
          </form>
      </SettingsAccordionCard>

      <ProfileAppearanceEditor initialProfile={initialUserProfile} />

      <Card>
        <CardHeader className="px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <Languages className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t('general.language')}</CardTitle>
          </div>
          <CardDescription>{t('general.languageDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
          <div className="grid grid-cols-2 gap-4">
            {routing.locales.map((locale) => (
              <button
                key={locale}
                type="button"
                onClick={() => void handleSelectLocale(locale)}
                disabled={isPending || isSavingLocale}
                className={`flex flex-col items-center gap-2 rounded-lg border-2 p-4 transition-colors ${
                  locale === currentLocale
                    ? 'border-primary bg-primary/5 text-primary'
                    : 'border-border bg-card hover:border-muted-foreground/40 hover:bg-muted/50'
                }`}
              >
                <span className="text-2xl">{locale === 'de' ? '🇩🇪' : '🇬🇧'}</span>
                <span className="font-semibold">
                  {locale === 'de' ? 'Deutsch' : 'English'}
                </span>
                {locale === currentLocale && (
                  <span className="text-xs font-medium text-primary">{t('general.languageActive')}</span>
                )}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <Clock3 className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t('general.timeZone')}</CardTitle>
          </div>
          <CardDescription>{t('general.timeZoneDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-4 sm:px-6 sm:pb-6">
          <label className="flex max-w-md flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">{t('general.timeZone')}</span>
            <select
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={timeZone}
              onChange={(event) => handleSelectTimeZone(event.target.value)}
              disabled={isPending || !isAdmin}
            >
              {timeZoneOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <p className="text-xs text-muted-foreground">{t('general.timeZoneDefault')}</p>
          {!isAdmin && (
            <p className="text-xs text-muted-foreground">{t('general.timeZoneAdminOnly')}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
