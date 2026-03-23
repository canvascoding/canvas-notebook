import Image from 'next/image';
import { Link } from '@/i18n/navigation';
import { Github, Heart } from 'lucide-react';

import { buildAgentConfigReadiness } from '@/app/lib/agents/storage';
import { requirePageSession } from '@/app/lib/auth-guards';
import SuiteAppSelector from '@/components/suite/SuiteAppSelector';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LogoutButton } from '@/app/components/LogoutButton';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { NotebookNavButton } from '@/app/components/NotebookNavButton';

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
  const session = await requirePageSession();

  const username = session?.user?.name || session?.user?.email || 'User';
  const setupCardState = await loadAgentSetupCardState();

  return (
    <div className="h-[100dvh] overflow-hidden bg-background text-foreground">
      <div className="flex h-full flex-col">
        <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
          <div className="mx-auto flex min-h-16 max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
            <div className="min-w-0 flex items-center gap-3">
            <Image src="/logo.jpg" alt="Canvas Notebook logo" width={32} height={32} className="border border-border" />
              <div className="min-w-0 flex flex-col">
              <span className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">Canvas Notebook</span>
                <span className="truncate text-sm font-semibold">Software Suite</span>
              </div>
            </div>

            <div className="ml-auto flex items-center gap-2 md:gap-3">
              <div className="hidden min-[480px]:flex flex-col items-end">
                <span className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">User</span>
                <span className="max-w-[140px] truncate text-xs">{username}</span>
              </div>
              <NotebookNavButton />
              <ThemeToggle />
              <LogoutButton />
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto pb-10 md:pb-12">
          <div className="mx-auto grid w-full max-w-6xl gap-4 px-4 pt-4 md:px-6 md:pt-8 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0">
              <SuiteAppSelector isAuthenticated />
            </div>

            <div className="space-y-4">
              <Card className="h-fit border border-border bg-card">
                <CardHeader className="px-4 pb-3 sm:px-6">
                  <CardTitle className="text-base">Agent Setup</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 px-4 text-sm sm:px-6">
                  <div className="space-y-2">
                    <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">Provider Status</p>
                    <p className={setupCardState.providerReady ? 'break-words text-primary' : 'break-words text-destructive'}>
                      {setupCardState.providerReady ? 'Ready' : 'Not ready'} ({setupCardState.providerLabel})
                    </p>
                    <p className="break-all text-xs text-muted-foreground">
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
                    <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
                      <Link href="/settings?tab=agent-settings">Agent Settings</Link>
                    </Button>
                    <Button asChild variant="secondary" size="sm" className="w-full sm:w-auto">
                      <Link href="/settings?tab=agent-settings&panel=doctor">Open Doctor</Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card className="h-fit border border-border bg-card">
                <CardHeader className="px-4 pb-3 sm:px-6">
                  <CardTitle className="text-base">Hilfe & Tutorials</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 px-4 text-sm sm:px-6">
                  <div className="space-y-2">
                    <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">Dokumentation</p>
                    <p className="text-muted-foreground">
                      Tutorials, Anleitungen und Hilfe zur Einrichtung der Canvas Software Suite.
                    </p>
                  </div>

                  <div className="flex flex-col gap-2 border-t border-border pt-3">
                    <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
                      <Link href="/help">Hilfe öffnen</Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </main>

        <footer className="border-t border-border bg-background/95">
          <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-3 text-[11px] md:flex-row md:items-center md:justify-between md:px-6">
            <a
              href="https://agency.canvas.holdings"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <span>Made with</span>
              <Heart className="h-3 w-3 fill-current text-red-500" />
              <span>by Canvas Coding</span>
            </a>
            <a
              href="https://github.com/canvascoding/canvas-notebook"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 break-all text-muted-foreground transition-colors hover:text-foreground md:justify-end"
            >
              <Github className="h-3.5 w-3.5 shrink-0" />
              <span>canvascoding/canvas-notebook</span>
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}
