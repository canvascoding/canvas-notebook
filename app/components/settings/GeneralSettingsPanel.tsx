'use client';

import { useTransition } from 'react';
import { useParams } from 'next/navigation';
import { usePathname, useRouter } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { useTranslations } from 'next-intl';
import { Languages, User, Mail, KeyRound, Info } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const LOGIN_ENV_KEYS = [
  { key: 'BOOTSTRAP_ADMIN_EMAIL', translationKey: 'loginInfo.emailKey' },
  { key: 'BOOTSTRAP_ADMIN_PASSWORD', translationKey: 'loginInfo.passwordKey' },
  { key: 'BOOTSTRAP_ADMIN_NAME', translationKey: 'loginInfo.nameKey' },
] as const;

export function GeneralSettingsPanel({ userName = '', userEmail = '' }: { userName?: string; userEmail?: string }) {
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
              <p className="text-xs text-muted-foreground leading-relaxed">{t('general.loginInfoSelfHostedNote')}</p>
            </div>
          </div>
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
        </CardContent>
      </Card>

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