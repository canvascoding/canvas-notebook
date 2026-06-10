import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { TerminalPanel } from '@/app/components/terminal/Terminal';
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
  const t = await getTranslations('terminal');

  return (
    <SuitePageLayout title={t('title')} mainClassName="flex-1 min-h-0 overflow-hidden" hintEnabled={isOnboardingHintsEnabled()}>
        <TerminalPanel standalone className="h-full" />
    </SuitePageLayout>
  );
}
