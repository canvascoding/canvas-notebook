import type { Metadata } from 'next';

import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { TerminalPanel } from '@/app/components/terminal/Terminal';
import { requirePageSession } from '@/app/lib/auth-guards';

export const metadata: Metadata = {
  title: 'Terminal | Canvas Notebook',
  description: 'Fullscreen terminal app for the Canvas Notebook workspace.',
};

export default async function TerminalPage() {
  const session = await requirePageSession();

  const username = session.user.name || session.user.email;

  return (
    <SuitePageLayout title="Terminal" username={username} mainClassName="flex-1 min-h-0 overflow-hidden" showLogo>
        <TerminalPanel standalone className="h-full" />
    </SuitePageLayout>
  );
}
