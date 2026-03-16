import Image from 'next/image';
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { auth } from '@/app/lib/auth';
import { buildAgentConfigReadiness } from '@/app/lib/agents/storage';
import SuiteAppSelector from '@/components/suite/SuiteAppSelector';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LogoutButton } from './components/LogoutButton';
import { ThemeToggle } from './components/ThemeToggle';
import { NotebookNavButton } from './components/NotebookNavButton';

type AgentSetupCardState = {
  providerLabel: string;
  providerReady: boolean;
  providerIssues: string[];
  doctorStatus: 'ready' | 'needs-attention' | 'unknown';
  model: string;
};

async function loadAgentSetupCardState(): Promise<AgentSetupCardState> {
  try {
    const readiness = await buildAgentConfigReadiness();
    
    // PI-first readiness
    const pi = readiness.pi;

    return {
      providerLabel: pi?.activeProvider || readiness.activeProviderId,
      providerReady: pi?.ready || readiness.activeProviderReady,
      providerIssues: pi?.issues || [],
      doctorStatus: (pi?.ready || readiness.activeProviderReady) ? 'ready' : 'needs-attention',
      model: pi?.model || 'unknown',
    };
  } catch {
    return {
      providerLabel: 'unknown',
      providerReady: false,
      providerIssues: ['Agent runtime config currently unavailable.'],
      doctorStatus: 'unknown',
      model: 'unknown',
    };
  }
}

export default async function Home() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect('/login');
  }

  const username = session.user.name || session.user.email;
  const setupCardState = await loadAgentSetupCardState();

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
            <NotebookNavButton />
            <ThemeToggle />
            <div className="hidden md:flex flex-col items-end">
              <span className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">User</span>
              <span className="text-xs">{username}</span>
            </div>
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-6xl gap-4 px-4 pt-6 md:px-6 md:pt-8 lg:grid-cols-[1fr_320px]">
          <div>
            <SuiteAppSelector isAuthenticated />
          </div>

          <div className="space-y-4">
            <Card className="h-fit border border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Agent Setup</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="space-y-2">
                  <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">Provider Status</p>
                  <p className={setupCardState.providerReady ? 'text-primary' : 'text-destructive'}>
                    {setupCardState.providerReady ? 'Ready' : 'Not ready'} ({setupCardState.providerLabel})
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Model: {setupCardState.model}
                  </p>
                  {setupCardState.providerIssues.length > 0 && (
                    <p className="text-xs text-muted-foreground">{setupCardState.providerIssues[0]}</p>
                  )}
                </div>

                <div className="space-y-2 border-t border-border pt-3">
                  <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">Doctor Status</p>
                  <p>
                    {setupCardState.doctorStatus === 'ready'
                      ? 'Ready'
                      : setupCardState.doctorStatus === 'needs-attention'
                        ? 'Needs attention'
                        : 'Unknown'}
                  </p>
                </div>

                <div className="flex flex-col gap-2 border-t border-border pt-3">
                  <Button asChild variant="outline" size="sm">
                    <Link href="/settings?tab=agent-settings">Agent Settings</Link>
                  </Button>
                  <Button asChild variant="secondary" size="sm">
                    <Link href="/settings?tab=agent-settings&panel=doctor">Open Doctor</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card className="h-fit border border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Hilfe & Tutorials</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="space-y-2">
                  <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">Dokumentation</p>
                  <p className="text-muted-foreground">
                    Tutorials, Anleitungen und Hilfe zur Einrichtung der Canvas Software Suite.
                  </p>
                </div>

                <div className="flex flex-col gap-2 border-t border-border pt-3">
                  <Button asChild variant="outline" size="sm">
                    <Link href="/help">Hilfe öffnen</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
