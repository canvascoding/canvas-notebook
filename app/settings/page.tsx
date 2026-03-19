import { requirePageSession } from '@/app/lib/auth-guards';
import { IntegrationsSettingsClient } from '@/app/components/settings/IntegrationsSettingsClient';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';

export default async function SettingsPage() {
  const session = await requirePageSession();

  const username = session.user.name || session.user.email;

  return (
    <SuitePageLayout title="Settings" username={username}>
        <IntegrationsSettingsClient />
    </SuitePageLayout>
  );
}
