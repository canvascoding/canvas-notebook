import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { TerminalPanel } from '@/app/components/terminal/Terminal';
import { requirePageSession } from '@/app/lib/auth-guards';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('terminal');

  return {
    title: t('metadataTitle'),
    description: t('metadataDescription'),
  };
}

export default async function TerminalPage() {
  const session = await requirePageSession();
  const t = await getTranslations('terminal');

  const username = session?.user?.name || session?.user?.email || 'User';

  return (
    <SuitePageLayout title={t('title')} username={username} mainClassName="flex-1 min-h-0 overflow-hidden" showLogo>
        <TerminalPanel standalone className="h-full" />
    </SuitePageLayout>
  );
}
