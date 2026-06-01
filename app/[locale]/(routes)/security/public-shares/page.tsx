import { getTranslations } from 'next-intl/server';

import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { PublicSharesClient } from './PublicSharesClient';

export default async function PublicSharesPage() {
  await requirePageSession();
  const t = await getTranslations('security.publicShares');

  return (
    <SuitePageLayout title={t('title')}>
      <PublicSharesClient />
    </SuitePageLayout>
  );
}
