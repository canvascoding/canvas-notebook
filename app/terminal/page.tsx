import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { TerminalPanel } from '@/app/components/terminal/Terminal';
import { auth } from '@/app/lib/auth';

export const metadata: Metadata = {
  title: 'Terminal | Canvas Studios Suite',
  description: 'Fullscreen terminal app for the Canvas Studios workspace.',
};

export default async function TerminalPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect('/login');
  }

  return (
    <div className="fixed inset-0 flex min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <TerminalPanel standalone className="h-full" />
    </div>
  );
}
