import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { AutomationsClient } from '@/app/apps/automationen/components/AutomationsClient';
import { getTranslations } from 'next-intl/server';
import { isOnboardingEnabled } from '@/app/lib/onboarding/status';

type AutomationenDetailPageProps = {
  params: Promise<{ jobId: string }>;
};

export default async function AutomationenDetailPage({ params }: AutomationenDetailPageProps) {
  const t = await getTranslations('automationen');
  const { jobId } = await params;
  await requirePageSession();

  return (
    <SuitePageLayout title={t('title')} hintEnabled={isOnboardingEnabled()}>
      <AutomationsClient initialJobId={jobId} />
    </SuitePageLayout>
  );
}
