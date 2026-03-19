import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { UsageAnalyticsClient } from '@/app/components/usage/UsageAnalyticsClient';
import { requirePageSession } from '@/app/lib/auth-guards';

export default async function UsagePage() {
  const session = await requirePageSession();

  const username = session.user.name || session.user.email;

  return (
    <SuitePageLayout title="Usage" username={username}>
        <UsageAnalyticsClient isAdmin={session.user.role === 'admin'} />
    </SuitePageLayout>
  );
}
