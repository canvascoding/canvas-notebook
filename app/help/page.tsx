import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, HelpCircle } from 'lucide-react';

import { auth } from '@/app/lib/auth';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { LogoutButton } from '@/app/components/LogoutButton';
import HelpPageClient from './HelpPageClient';

export default async function HelpPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect('/login');
  }

  const username = session.user.name || session.user.email;

  return (
    <div className="fixed inset-0 flex min-h-0 flex-col overflow-hidden bg-background text-foreground">
      {/* Header */}
      <header className="z-40 h-16 flex-shrink-0 border-b border-border bg-background/95">
        <div className="mx-auto flex h-full items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className="gap-2 px-2 sm:px-3">
              <Link href="/">
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">Suite</span>
              </Link>
            </Button>
            <Image
              src="/logo.jpg"
              alt="Canvas Notebook logo"
              width={32}
              height={32}
              className="shrink-0 border border-border"
            />
            <h1 className="hidden md:block text-lg md:text-2xl font-bold truncate">HILFE & TUTORIALS</h1>
          </div>

          <div className="flex items-center gap-1.5 md:gap-4">
            <ThemeToggle />
            <div className="hidden lg:flex flex-col items-end shrink-0">
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">User</span>
              <span className="text-xs text-foreground/90">{username}</span>
            </div>
            <LogoutButton />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <HelpPageClient />
    </div>
  );
}
