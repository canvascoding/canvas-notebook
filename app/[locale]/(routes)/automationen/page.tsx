import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { AutomationsClient } from '@/app/apps/automationen/components/AutomationsClient';
import { getTranslations } from 'next-intl/server';

export default async function AutomationenPage() {
  const t = await getTranslations('automationen');
  const tCommon = await getTranslations('common');
  const session = await requirePageSession();

  const username = session?.user?.name || session?.user?.email || tCommon('user');

  return (
    <SuitePageLayout title={t('title')} username={username}>
        <AutomationsClient />
    </SuitePageLayout>
  );
}
