'use client';

import { useState, useTransition } from 'react';
import { useParams } from 'next/navigation';
import { usePathname, useRouter } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { useTranslations } from 'next-intl';
import { ExternalLink, Eye, EyeOff, KeyRound, Info, Languages, LockKeyhole, Mail, User } from 'lucide-react';
import { toast } from 'sonner';

import { authClient } from '@/app/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const CONTROL_PANEL_DASHBOARD_URL = 'https://notebook.canvas.holdings/dashboard';

const LOGIN_ENV_KEYS = [
  { key: 'BOOTSTRAP_ADMIN_EMAIL', translationKey: 'general.loginInfo.emailKey' },
  { key: 'BOOTSTRAP_ADMIN_PASSWORD', translationKey: 'general.loginInfo.passwordKey' },
  { key: 'BOOTSTRAP_ADMIN_NAME', translationKey: 'general.loginInfo.nameKey' },
] as const;

function PasswordChangeCard() {
  const t = useTranslations('settings');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [revokeOtherSessions, setRevokeOtherSessions] = useState(true);
  const [showPasswords, setShowPasswords] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const passwordVisibilityLabel = showPasswords
    ? t('general.passwordChange.hidePasswords')
    : t('general.passwordChange.showPasswords');

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (newPassword !== confirmPassword) {
      toast.error(t('general.passwordChange.passwordMismatch'));
      return;
    }

    if (newPassword.length < 8 || newPassword.length > 128) {
      toast.error(t('general.passwordChange.passwordLength'));
      return;
    }

    setIsSaving(true);
    try {
      const { error } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions,
      });

      if (error) {
        toast.error(error.message || t('general.passwordChange.failed'));
        return;
      }

      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success(t('general.passwordChange.success'));
    } catch (error) {
      console.error('[Settings] Failed to change password:', error);
      toast.error(t('general.passwordChange.unexpectedError'));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="px-4 sm:px-6">
        <div className="flex items-center gap-2">
          <LockKeyhole className="h-5 w-5 text-muted-foreground" />
          <CardTitle>{t('general.passwordChange.title')}</CardTitle>
        </div>
        <CardDescription>{t('general.passwordChange.description')}</CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4 sm:px-6 sm:pb-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="current-password">{t('general.passwordChange.currentPassword')}</Label>
              <Input
                id="current-password"
                type={showPasswords ? 'text' : 'password'}
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">{t('general.passwordChange.newPassword')}</Label>
              <Input
                id="new-password"
                type={showPasswords ? 'text' : 'password'}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-new-password">{t('general.passwordChange.confirmPassword')}</Label>
              <div className="relative">
                <Input
                  id="confirm-new-password"
                  type={showPasswords ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  className="pr-11"
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
                        aria-label={passwordVisibilityLabel}
                        aria-pressed={showPasswords}
                        onClick={() => setShowPasswords((visible) => !visible)}
                      >
                        {showPasswords ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">{passwordVisibilityLabel}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <Switch
                id="revoke-other-sessions"
                checked={revokeOtherSessions}
                onCheckedChange={setRevokeOtherSessions}
                disabled={isSaving}
              />
              <div className="space-y-1">
                <Label htmlFor="revoke-other-sessions" className="cursor-pointer">
                  {t('general.passwordChange.revokeOtherSessions')}
                </Label>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t('general.passwordChange.revokeOtherSessionsDescription')}
                </p>
              </div>
            </div>
            <Button
              type="submit"
              className="w-full sm:w-auto"
              disabled={isSaving || !currentPassword || !newPassword || !confirmPassword}
            >
              {isSaving ? t('general.passwordChange.saving') : t('general.passwordChange.submit')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function GeneralSettingsPanel({
  userName = '',
  userEmail = '',
  isManagedControlPlane = false,
}: {
  userName?: string;
  userEmail?: string;
  isManagedControlPlane?: boolean;
}) {
  const t = useTranslations('settings');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const pathname = usePathname();
  const params = useParams();
  const currentLocale = (params.locale as string) || routing.defaultLocale;

  function handleSelectLocale(locale: string) {
    startTransition(() => {
      router.replace(pathname, { locale });
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <User className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t('general.loginInfoTitle')}</CardTitle>
          </div>
          <CardDescription>{t('general.loginInfoDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
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
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <div className="flex items-start gap-2">
              <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t(isManagedControlPlane ? 'general.loginInfoManagedNote' : 'general.loginInfoSelfHostedNote')}
                </p>
                {isManagedControlPlane && (
                  <Button asChild size="sm" variant="outline" className="h-8">
                    <a href={CONTROL_PANEL_DASHBOARD_URL} target="_blank" rel="noreferrer">
                      {t('general.loginInfoControlPanelLink')}
                      <ExternalLink className="ml-2 h-3.5 w-3.5" />
                    </a>
                  </Button>
                )}
              </div>
            </div>
          </div>
          {!isManagedControlPlane && (
            <div className="space-y-2">
              <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{t('general.loginInfoEnvKeys')}</span>
              <div className="space-y-1.5">
                {LOGIN_ENV_KEYS.map(({ key, translationKey }) => (
                  <div key={key} className="flex items-center gap-2 text-sm">
                    <KeyRound className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">{key}</code>
                    <span className="text-muted-foreground">— {t(translationKey)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <PasswordChangeCard />

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
                onClick={() => handleSelectLocale(locale)}
                disabled={isPending}
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
    </div>
  );
}
