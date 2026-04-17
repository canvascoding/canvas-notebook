'use client';

import { useTransition } from 'react';
import { useParams } from 'next/navigation';
import { usePathname, useRouter } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { useTranslations } from 'next-intl';
import { Languages } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function GeneralSettingsPanel() {
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