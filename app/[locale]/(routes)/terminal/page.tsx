import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';

import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { TerminalPageContent } from '@/app/components/terminal/TerminalPageContent';
import { readTerminalAvailability } from '@/app/lib/terminal-policy';
import { redirect } from '@/i18n/navigation';
import { requirePageSession } from '@/app/lib/auth-guards';
import { isOnboardingHintsEnabled } from '@/app/lib/onboarding/status';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('terminal');

  return {
    title: t('metadataTitle'),
    description: t('metadataDescription'),
  };
}

export default async function TerminalPage() {
  await requirePageSession();
  if (!readTerminalAvailability().terminalEnabled) {
    redirect({ href: '/notebook', locale: await getLocale() });
  }
  const t = await getTranslations('terminal');

  return (
    <SuitePageLayout title={t('title')} mainClassName="flex-1 min-h-0 overflow-hidden" hintEnabled={isOnboardingHintsEnabled()}>
        <TerminalPageContent />
    </SuitePageLayout>
  );
}
