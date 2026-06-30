import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { AutomationsClient } from '@/app/apps/automations/components/AutomationsClient';
import { getTranslations } from 'next-intl/server';
import { isOnboardingHintsEnabled } from '@/app/lib/onboarding/status';
import { getServerPreferredTimeZone } from '@/app/lib/server-settings';

type AutomationenDetailPageProps = {
  params: Promise<{ jobId: string }>;
};

export default async function AutomationenDetailPage({ params }: AutomationenDetailPageProps) {
  const t = await getTranslations('automationen');
  const { jobId } = await params;
  await requirePageSession();
  const initialTimeZone = await getServerPreferredTimeZone();

  return (
    <SuitePageLayout title={t('title')} hintEnabled={isOnboardingHintsEnabled()}>
      <AutomationsClient initialJobId={jobId} initialTimeZone={initialTimeZone} />
    </SuitePageLayout>
  );
}
