import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { AutomationsClient } from '@/app/apps/automationen/components/AutomationsClient';
import { getTranslations } from 'next-intl/server';
import { isOnboardingEnabled } from '@/app/lib/onboarding/status';

export default async function AutomationenPage() {
  const t = await getTranslations('automationen');
  await requirePageSession();

  return (
    <SuitePageLayout title={t('title')} hintEnabled={isOnboardingEnabled()}>
        <AutomationsClient />
    </SuitePageLayout>
  );
}
