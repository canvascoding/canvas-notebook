import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { auth } from '@/app/lib/auth';
import { LogoutButton } from '@/app/components/LogoutButton';
import { NotebookNavButton } from '@/app/components/NotebookNavButton';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { Button } from '@/components/ui/button';
import { AutomationsClient } from '@/app/apps/automationen/components/AutomationsClient';

export default async function AutomationenPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect('/login');
  }

  const username = session.user.name || session.user.email;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="h-16 border-b border-border bg-background/95">
        <div className="mx-auto flex h-full max-w-7xl items-center justify-between px-4 md:px-6">
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className="gap-2">
              <Link href="/">
                <ArrowLeft className="h-4 w-4" />
                Suite
              </Link>
            </Button>
            <span className="text-sm font-semibold">Automationen</span>
          </div>
          <div className="flex items-center gap-2">
            <NotebookNavButton />
            <div className="hidden md:flex flex-col items-end">
              <span className="text-xs font-bold tracking-widest text-muted-foreground uppercase">User</span>
              <span className="text-xs">{username}</span>
            </div>
            <ThemeToggle />
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <AutomationsClient />
      </main>
    </div>
  );
}
