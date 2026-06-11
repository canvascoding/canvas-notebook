import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { AutomationsClient } from '@/app/apps/automations/components/AutomationsClient';
import { getTranslations } from 'next-intl/server';
import { isOnboardingHintsEnabled } from '@/app/lib/onboarding/status';

export default async function AutomationenPage() {
  const t = await getTranslations('automationen');
  await requirePageSession();

  return (
    <SuitePageLayout title={t('title')} hintEnabled={isOnboardingHintsEnabled()}>
        <AutomationsClient />
    </SuitePageLayout>
  );
}
