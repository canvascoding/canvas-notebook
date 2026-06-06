import { requirePageSession } from '@/app/lib/auth-guards';
import { IntegrationsSettingsClient } from '@/app/components/settings/IntegrationsSettingsClient';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { getTranslations } from 'next-intl/server';
import { isOnboardingEnabled } from '@/app/lib/onboarding/status';
import { isManagedControlPlaneAvailable } from '@/app/lib/agents/storage';
import { isAdminUser } from '@/app/lib/admin-auth';

export default async function SettingsPage() {
  const session = await requirePageSession({ allowUnlicensed: true });
  const t = await getTranslations('settings');

  const isAdmin = isAdminUser(session?.user);
  const currentUserId = session?.user?.id || '';
  const userName = session?.user?.name || '';
  const userEmail = session?.user?.email || '';
  const isManagedControlPlane = isManagedControlPlaneAvailable();

  return (
    <SuitePageLayout title={t('title')} hintPage="settings" hintEnabled={isOnboardingEnabled()}>
        <IntegrationsSettingsClient
          isAdmin={isAdmin}
          currentUserId={currentUserId}
          userName={userName}
          userEmail={userEmail}
          isManagedControlPlane={isManagedControlPlane}
        />
    </SuitePageLayout>
  );
}
