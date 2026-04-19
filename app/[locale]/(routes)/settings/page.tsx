import { requirePageSession } from '@/app/lib/auth-guards';
import { IntegrationsSettingsClient } from '@/app/components/settings/IntegrationsSettingsClient';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { SettingsHintProvider } from '@/app/components/onboarding/SettingsHintProvider';
import { getTranslations } from 'next-intl/server';

export default async function SettingsPage() {
  const session = await requirePageSession();
  const t = await getTranslations('settings');

  const username = session?.user?.name || session?.user?.email || 'User';
  const isAdmin = session?.user?.role === 'admin';

  return (
    <SuitePageLayout title={t('title')} username={username} hintPage="settings">
        <SettingsHintProvider>
          <IntegrationsSettingsClient isAdmin={isAdmin} />
        </SettingsHintProvider>
    </SuitePageLayout>
  );
}
