import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import HelpPageClient from './HelpPageClient';

export default async function HelpPage() {
  const session = await requirePageSession();

  const username = session?.user?.name || session?.user?.email || 'User';

  return (
    <SuitePageLayout title="Hilfe & Tutorials" username={username} showLogo>
      <HelpPageClient />
    </SuitePageLayout>
  );
}
