import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { AutomationsClient } from '@/app/apps/automationen/components/AutomationsClient';
import { getTranslations } from 'next-intl/server';

export default async function AutomationenPage() {
  const t = await getTranslations('automationen');
  await requirePageSession();

  return (
    <SuitePageLayout title={t('title')}>
        <AutomationsClient />
    </SuitePageLayout>
  );
}
