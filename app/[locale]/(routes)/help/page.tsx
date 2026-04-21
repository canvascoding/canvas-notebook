import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { getTranslations } from 'next-intl/server';
import HelpPageClient from './HelpPageClient';

export default async function HelpPage() {
  await requirePageSession();
  const t = await getTranslations('help');

  return (
    <SuitePageLayout title={t('title')}>
      <HelpPageClient />
    </SuitePageLayout>
  );
}
