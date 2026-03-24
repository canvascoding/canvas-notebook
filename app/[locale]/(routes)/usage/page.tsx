import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { UsageAnalyticsClient } from '@/app/components/usage/UsageAnalyticsClient';
import { requirePageSession } from '@/app/lib/auth-guards';
import { getTranslations } from 'next-intl/server';

export default async function UsagePage() {
  const session = await requirePageSession();
  const t = await getTranslations('usage');
  const tCommon = await getTranslations('common');

  const username = session?.user?.name || session?.user?.email || tCommon('user');

  return (
    <SuitePageLayout title={t('title')} username={username}>
        <UsageAnalyticsClient isAdmin={session?.user?.role === 'admin'} />
    </SuitePageLayout>
  );
}
