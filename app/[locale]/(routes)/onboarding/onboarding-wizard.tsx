'use client';

import { useState } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { usePathname, useRouter } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { useTransition } from 'react';

import { PiProviderSetupCard } from '@/app/components/settings/PiProviderSetupCard';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Languages } from 'lucide-react';

type Step = 'language' | 'provider' | 'done';

const STEPS: Step[] = ['language', 'provider', 'done'];

export default function OnboardingWizard() {
  const t = useTranslations('onboarding');
  const [step, setStep] = useState<Step>('language');
  const [completeLoading, setCompleteLoading] = useState(false);

  async function handleDone() {
    setCompleteLoading(true);
    try {
      const response = await fetch('/api/onboarding/complete', {
        method: 'POST',
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error || t('completionError'));
        return;
      }

      window.location.href = '/';
    } catch {
      toast.error(t('unexpectedError'));
    } finally {
      setCompleteLoading(false);
    }
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
          <div className={`w-full ${step === 'provider' ? 'max-w-5xl' : 'max-w-lg'}`}>
            <div className="rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
              <div className="mb-2 flex items-center justify-center">
                <Image
                  src="/logo.jpg"
                  alt={t('logoAlt')}
                  width={48}
                  height={48}
                  className="mr-3 border border-border"
                />
                <h1 className="text-3xl font-bold">Canvas Notebook</h1>
              </div>

              <div className="mb-8 flex justify-center gap-2">
                {STEPS.map((currentStep, index) => (
                  <div key={currentStep} className="flex items-center gap-2">
                    <div
                      className={`h-2 w-2 rounded-full transition-colors ${
                        step === currentStep ? 'bg-foreground' : 'bg-muted-foreground/30'
                      }`}
                    />
                    {index < STEPS.length - 1 && <div className="h-px w-6 bg-border" />}
                  </div>
                ))}
              </div>

              {step === 'language' && (
                <LanguageStep
                  onContinue={() => setStep('provider')}
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

                  <PiProviderSetupCard
                    title={t('providerTitle')}
                    description={t('providerDescription')}
                    saveButtonLabel={t('saveProvider')}
                    saveSuccessMessage={t('saveSuccessMessage')}
                    onSaved={() => {
                      toast.success(t('providerSaved'));
                      setStep('done');
                    }}
                  />

                  <div className="flex justify-end">
                    <Button variant="outline" onClick={() => setStep('done')}>
                      {t('skipSetup')}
                    </Button>
                  </div>
                </div>
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

function LanguageStep({ onContinue }: { onContinue: () => void }) {
  const t = useTranslations('onboarding');
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
            onClick={() => handleSelectLocale(locale)}
            disabled={isPending}
            className={`flex flex-col items-center gap-2 rounded-lg border-2 p-6 transition-colors ${
              locale === currentLocale
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-border bg-card hover:border-muted-foreground/40 hover:bg-muted/50'
            }`}
          >
            <span className="text-3xl">{locale === 'de' ? '🇩🇪' : '🇬🇧'}</span>
            <span className="text-lg font-semibold">
              {locale === 'de' ? 'Deutsch' : 'English'}
            </span>
            {locale === currentLocale && (
              <span className="text-xs font-medium text-primary">{t('languageActive')}</span>
            )}
          </button>
        ))}
      </div>

      <div className="flex justify-center">
        <Button onClick={onContinue} className="min-w-[200px]">
          {t('languageContinue')}
        </Button>
      </div>
    </div>
  );
}