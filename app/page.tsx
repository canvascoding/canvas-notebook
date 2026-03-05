import Image from 'next/image';
import Link from 'next/link';
import { headers } from 'next/headers';

import { auth } from '@/app/lib/auth';
import SuiteAppSelector from '@/components/suite/SuiteAppSelector';
import { Button } from '@/components/ui/button';
import { LogoutButton } from './components/LogoutButton';
import { ThemeToggle } from './components/ThemeToggle';

export default async function Home() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  const username = session?.user.name || session?.user.email;

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground">
      <header className="h-16 border-b border-border bg-background/95">
        <div className="mx-auto flex h-full max-w-7xl items-center justify-between px-4 md:px-6">
          <div className="flex items-center gap-3">
            <Image src="/logo.jpg" alt="Canvas Studios logo" width={32} height={32} className="border border-border" />
            <div className="flex flex-col">
              <span className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">Canvas Studios</span>
              <span className="text-sm font-semibold">Software Suite</span>
            </div>
          </div>

          <div className="flex items-center gap-2 md:gap-3">
            <ThemeToggle />
            {session ? (
              <>
                <div className="hidden md:flex flex-col items-end">
                  <span className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">User</span>
                  <span className="text-xs">{username}</span>
                </div>
                <LogoutButton />
              </>
            ) : (
              <Button asChild size="sm" className="px-3">
                <Link href="/login">Login</Link>
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <SuiteAppSelector isAuthenticated={Boolean(session)} />
      </main>
    </div>
  );
}
