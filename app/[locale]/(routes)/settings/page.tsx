import { requirePageSession } from '@/app/lib/auth-guards';
import { IntegrationsSettingsClient } from '@/app/components/settings/IntegrationsSettingsClient';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { getTranslations } from 'next-intl/server';
import { isOnboardingHintsEnabled } from '@/app/lib/onboarding/status';
import { isManagedControlPlaneAvailable } from '@/app/lib/agents/storage';
import { isAdminUser } from '@/app/lib/admin-auth';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { getServerPreferredTimeZone } from '@/app/lib/server-settings';
import { SETTINGS_SIDEBAR_COLLAPSED_COOKIE } from '@/app/lib/settings-navigation';
import { isOnboardingLicenseRecoveryRequest } from '@/app/lib/onboarding/flow';
import { resolveUserProfile } from '@/app/lib/user-profile/service';
import { cookies } from 'next/headers';

type SettingsPageProps = {
  searchParams: Promise<{ tab?: string | string[] }>;
};

export default async function SettingsPage({ searchParams }: SettingsPageProps) {
  const params = await searchParams;
  const allowLicenseRecovery = isOnboardingLicenseRecoveryRequest(params);
  const session = await requirePageSession({
    allowIncompleteUserOnboarding: allowLicenseRecovery,
  });
  const t = await getTranslations('settings');
  const cookieStore = await cookies();

  const isAdmin = isAdminUser(session?.user);
  const currentUserId = session?.user?.id || '';
  const userName = session?.user?.name || '';
  const userEmail = session?.user?.email || '';
  const isManagedControlPlane = isManagedControlPlaneAvailable();
  const initialTimeZone = await getServerPreferredTimeZone();
  const initialSettingsSidebarCollapsed = cookieStore.get(SETTINGS_SIDEBAR_COLLAPSED_COOKIE)?.value === 'true';
  const initialUserProfile = await resolveUserProfile({
    userId: currentUserId,
    name: userName,
    email: userEmail,
  });
  let organizationPermission = null;
  if (currentUserId) {
    try {
      organizationPermission = (await readOrganizationPermissionForUser(currentUserId)).permission;
    } catch (error) {
      console.warn('[Settings] Failed to read organization permission for current user:', error);
    }
  }

  return (
    <SuitePageLayout title={t('title')} hintPage="settings" hintEnabled={isOnboardingHintsEnabled()}>
        <IntegrationsSettingsClient
          isAdmin={isAdmin}
          currentUserId={currentUserId}
          userName={userName}
          userEmail={userEmail}
          initialUserProfile={initialUserProfile}
          isManagedControlPlane={isManagedControlPlane}
          initialTimeZone={initialTimeZone}
          initialSettingsSidebarCollapsed={initialSettingsSidebarCollapsed}
          organizationPermission={organizationPermission}
        />
    </SuitePageLayout>
  );
}
