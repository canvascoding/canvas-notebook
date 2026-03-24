import { requirePageSession } from '@/app/lib/auth-guards';
import { IntegrationsSettingsClient } from '@/app/components/settings/IntegrationsSettingsClient';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { getTranslations } from 'next-intl/server';

export default async function SettingsPage() {
  const session = await requirePageSession();
  const t = await getTranslations('settings');

  const username = session?.user?.name || session?.user?.email || 'User';

  return (
    <SuitePageLayout title={t('title')} username={username}>
        <IntegrationsSettingsClient />
    </SuitePageLayout>
  );
}
