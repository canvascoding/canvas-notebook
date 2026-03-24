import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { getTranslations } from 'next-intl/server';
import HelpPageClient from './HelpPageClient';

export default async function HelpPage() {
  const session = await requirePageSession();
  const t = await getTranslations('help');
  const tCommon = await getTranslations('common');

  const username = session?.user?.name || session?.user?.email || tCommon('user');

  return (
    <SuitePageLayout title={t('title')} username={username} showLogo>
      <HelpPageClient />
    </SuitePageLayout>
  );
}
