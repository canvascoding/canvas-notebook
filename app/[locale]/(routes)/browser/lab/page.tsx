import { notFound } from 'next/navigation';

import { BrowserLabClient } from '@/app/components/browser-lab/BrowserLabClient';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { requirePageSession } from '@/app/lib/auth-guards';
import { isBrowserLabAllowed } from '@/app/lib/pi/browser/view-access';

export const metadata = {
  title: 'Browser Lab · Canvas Notebook',
  robots: { index: false, follow: false },
};

export default async function BrowserLabPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const [session, { locale }] = await Promise.all([
    requirePageSession(),
    params,
  ]);
  if (!session) notFound();
  if (!isBrowserLabAllowed(session.user)) notFound();

  return (
    <SuitePageLayout
      title={locale === 'en' ? 'Browser Lab' : 'Browser-Labor'}
      mainClassName="overflow-hidden"
    >
      <BrowserLabClient locale={locale} />
    </SuitePageLayout>
  );
}
