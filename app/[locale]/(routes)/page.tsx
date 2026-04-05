import Image from 'next/image';
import { Link } from '@/i18n/navigation';
import { Heart } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import packageJson from '../../../package.json';

import { buildAgentConfigReadiness } from '@/app/lib/agents/storage';
import { requirePageSession } from '@/app/lib/auth-guards';
import SuiteAppSelector from '@/components/suite/SuiteAppSelector';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LogoutButton } from '@/app/components/LogoutButton';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { NotebookNavButton } from '@/app/components/NotebookNavButton';
import { LanguageSwitcher } from '@/app/components/language-switcher';

type AgentSetupCardState = {
  providerLabel: string;
  providerReady: boolean;
  providerIssues: string[];
  doctorStatus: 'ready' | 'needs-attention' | 'unknown';
  model: string;
};

const repositoryUrl = 'https://github.com/canvascoding/canvas-notebook';
const releaseVersion = packageJson.version;
const releaseTag = `v${releaseVersion}`;
const releaseTagUrl = `${repositoryUrl}/releases/tag/${releaseTag}`;

async function loadAgentSetupCardState(runtimeUnavailableMessage: string): Promise<AgentSetupCardState> {
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
      providerIssues: [runtimeUnavailableMessage],
      doctorStatus: 'unknown',
      model: 'unknown',
    };
  }
}

export default async function Home() {
  const tHome = await getTranslations('home');
  const tCommon = await getTranslations('common');
  const session = await requirePageSession();

  const username = session?.user?.name || session?.user?.email || tCommon('user');
  const setupCardState = await loadAgentSetupCardState(tHome('agentSetup.runtimeUnavailable'));

  return (
    <div className="h-[100dvh] overflow-hidden bg-background text-foreground">
      <div className="flex h-full flex-col">
        <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
          <div className="mx-auto flex min-h-16 max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
            <div className="min-w-0 flex items-center gap-3">
            <Image src="/logo.jpg" alt={tHome('header.logoAlt')} width={32} height={32} className="border border-border" />
              <div className="min-w-0 flex flex-col">
              <span className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">{tHome('header.productName')}</span>
                <span className="truncate text-sm font-semibold">{tHome('header.productLabel')}</span>
              </div>
            </div>

            <div className="ml-auto flex items-center gap-2 md:gap-3">
              <div className="hidden min-[480px]:flex flex-col items-end">
                <span className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">{tCommon('user')}</span>
                <span className="max-w-[140px] truncate text-xs">{username}</span>
              </div>
              <NotebookNavButton />
              <LanguageSwitcher />
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
                  <CardTitle className="text-base">{tHome('agentSetup.title')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 px-4 text-sm sm:px-6">
                  <div className="space-y-2">
                    <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">{tHome('agentSetup.providerStatus')}</p>
                    <p className={setupCardState.providerReady ? 'break-words text-primary' : 'break-words text-destructive'}>
                      {setupCardState.providerReady ? tHome('agentSetup.ready') : tHome('agentSetup.notReady')} ({setupCardState.providerLabel})
                    </p>
                    <p className="break-all text-xs text-muted-foreground">
                      {tHome('agentSetup.model')}: {setupCardState.model}
                    </p>
                    {setupCardState.providerIssues.length > 0 && (
                      <p className="text-xs text-muted-foreground">{setupCardState.providerIssues[0]}</p>
                    )}
                  </div>

                  <div className="space-y-2 border-t border-border pt-3">
                    <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">{tHome('agentSetup.doctorStatus')}</p>
                    <p>
                      {setupCardState.doctorStatus === 'ready'
                        ? tHome('agentSetup.ready')
                        : setupCardState.doctorStatus === 'needs-attention'
                          ? tHome('agentSetup.needsAttention')
                          : tHome('agentSetup.unknown')}
                    </p>
                  </div>

                  <div className="flex flex-col gap-2 border-t border-border pt-3">
                    <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
                      <Link href="/settings?tab=agent-settings">{tHome('cta.openAgentSettings')}</Link>
                    </Button>
                    <Button asChild variant="secondary" size="sm" className="w-full sm:w-auto">
                      <Link href="/settings?tab=agent-settings&panel=doctor">{tHome('cta.openDoctor')}</Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card className="h-fit border border-border bg-card">
                <CardHeader className="px-4 pb-3 sm:px-6">
                  <CardTitle className="text-base">{tHome('help.title')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 px-4 text-sm sm:px-6">
                  <div className="space-y-2">
                    <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">{tHome('help.documentationLabel')}</p>
                    <p className="text-muted-foreground">
                      {tHome('help.description')}
                    </p>
                  </div>

                  <div className="flex flex-col gap-2 border-t border-border pt-3">
                    <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
                      <Link href="/help">{tHome('cta.openHelp')}</Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </main>

        <footer className="border-t border-border bg-background/95">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-2 px-4 py-3 text-[10px] md:px-6 md:text-[11px]">
            <a
              href="https://agency.canvas.holdings"
              target="_blank"
              rel="noopener noreferrer"
              className="flex shrink-0 items-center gap-1 text-muted-foreground transition-colors hover:text-foreground sm:gap-1.5"
            >
              <span className="hidden sm:inline">{tHome('footer.madeWith')}</span>
              <span className="sm:hidden">by</span>
              <Heart className="h-3 w-3 fill-current text-red-500" />
              <span className="hidden sm:inline">{tHome('footer.byCanvasCoding')}</span>
              <span className="sm:hidden">Canvas Coding</span>
            </a>
            <div className="flex min-w-0 items-center justify-end gap-2 whitespace-nowrap">
              <a
                href={repositoryUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 items-center gap-1 text-muted-foreground transition-colors hover:text-foreground sm:gap-1.5"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="h-3.5 w-3.5 shrink-0 fill-current"
                >
                  <path d="M12 1.25a10.75 10.75 0 0 0-3.4 20.95c.54.1.74-.23.74-.52v-1.84c-3 .65-3.63-1.28-3.63-1.28-.49-1.24-1.2-1.57-1.2-1.57-.98-.67.08-.66.08-.66 1.08.08 1.65 1.1 1.65 1.1.96 1.64 2.52 1.16 3.13.89.1-.7.38-1.16.68-1.43-2.4-.27-4.92-1.2-4.92-5.33 0-1.18.42-2.15 1.1-2.9-.1-.27-.48-1.37.11-2.84 0 0 .9-.29 2.95 1.1a10.25 10.25 0 0 1 5.38 0c2.04-1.39 2.95-1.1 2.95-1.1.59 1.47.22 2.57.11 2.84.68.75 1.1 1.72 1.1 2.9 0 4.14-2.53 5.05-4.94 5.32.39.34.73 1 .73 2.02v2.99c0 .29.2.63.74.52A10.75 10.75 0 0 0 12 1.25Z" />
                </svg>
                <span className="hidden sm:inline">canvascoding/canvas-notebook</span>
              </a>
              <a
                href={releaseTagUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              >
                {tHome('footer.version', { version: releaseVersion })}
              </a>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
