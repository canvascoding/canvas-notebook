import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { AutomationsClient } from '@/app/apps/automations/components/AutomationsClient';
import { getTranslations } from 'next-intl/server';
import { isOnboardingHintsEnabled } from '@/app/lib/onboarding/status';
import { getServerPreferredTimeZone } from '@/app/lib/server-settings';

type AutomationenDetailPageProps = {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<{ edit?: string }>;
};

export default async function AutomationenDetailPage({ params, searchParams }: AutomationenDetailPageProps) {
  const t = await getTranslations('automationen');
  const { jobId } = await params;
  const initialEdit = (await searchParams).edit === '1';
  await requirePageSession();
  const initialTimeZone = await getServerPreferredTimeZone();

  return (
    <SuitePageLayout title={t('title')} hintEnabled={isOnboardingHintsEnabled()}>
      <AutomationsClient key={`${jobId}:${initialEdit}`} initialJobId={jobId} initialEdit={initialEdit} initialTimeZone={initialTimeZone} />
    </SuitePageLayout>
  );
}
