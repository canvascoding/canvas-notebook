import { requirePageSession } from '@/app/lib/auth-guards';
import { IntegrationsSettingsClient } from '@/app/components/settings/IntegrationsSettingsClient';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { getTranslations } from 'next-intl/server';
import { isOnboardingEnabled } from '@/app/lib/onboarding/status';

export default async function SettingsPage() {
  const session = await requirePageSession();
  const t = await getTranslations('settings');

  const isAdmin = session?.user?.role === 'admin';
  const userName = session?.user?.name || '';
  const userEmail = session?.user?.email || '';

  return (
    <SuitePageLayout title={t('title')} hintPage="settings" hintEnabled={isOnboardingEnabled()}>
        <IntegrationsSettingsClient isAdmin={isAdmin} userName={userName} userEmail={userEmail} />
    </SuitePageLayout>
  );
}
