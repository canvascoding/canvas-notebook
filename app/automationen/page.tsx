import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { AutomationsClient } from '@/app/apps/automationen/components/AutomationsClient';

export default async function AutomationenPage() {
  const session = await requirePageSession();

  const username = session.user.name || session.user.email;

  return (
    <SuitePageLayout title="Automationen" username={username}>
        <AutomationsClient />
    </SuitePageLayout>
  );
}
