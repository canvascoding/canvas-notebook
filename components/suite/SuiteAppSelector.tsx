import * as React from 'react';
import { Link } from '@/i18n/navigation';
import { getTranslations } from 'next-intl/server';
import { BarChart3, ChevronRight, Clapperboard, Globe, ImageIcon, NotebookPen, Terminal, Workflow, Wrench } from 'lucide-react';

import { HomeChatPrompt } from '@/app/components/home/HomeChatPrompt';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

type SuiteApp = {
  id: 'notebook' | 'usage' | 'imageGeneration' | 'veo' | 'nanoBanana' | 'automations' | 'skills' | 'terminal';
  status: 'ready' | 'planned';
  href?: string;
  icon: React.ComponentType<{ className?: string }>;
};

type LocalizedSuiteApp = SuiteApp & {
  title: string;
  description: string;
};

type IntegrationCardLabels = {
  live: string;
  planned: string;
  openApp: string;
  loginRequired: string;
  comingSoon: string;
};

const suiteApps: SuiteApp[] = [
  {
    id: 'notebook',
    status: 'ready',
    href: '/notebook',
    icon: NotebookPen,
  },
  {
    id: 'usage',
    status: 'ready',
    href: '/usage',
    icon: BarChart3,
  },
  {
    id: 'imageGeneration',
    status: 'ready',
    href: '/image-generation',
    icon: ImageIcon,
  },
  {
    id: 'veo',
    status: 'ready',
    href: '/veo',
    icon: Clapperboard,
  },
  {
    id: 'nanoBanana',
    status: 'ready',
    href: '/nano-banana-localizer',
    icon: Globe,
  },
  {
    id: 'automations',
    status: 'ready',
    href: '/automationen',
    icon: Workflow,
  },
  {
    id: 'skills',
    status: 'ready',
    href: '/skills',
    icon: Wrench,
  },
  {
    id: 'terminal',
    status: 'ready',
    href: '/terminal',
    icon: Terminal,
  },
];

interface IntegrationsSectionProps {
  isAuthenticated: boolean;
}

export default async function SuiteAppSelector({ isAuthenticated }: IntegrationsSectionProps) {
  const t = await getTranslations('home');
  const localizedApps: LocalizedSuiteApp[] = suiteApps.map((app) => ({
    ...app,
    title: t(`apps.${app.id}.title`),
    description: t(`apps.${app.id}.description`),
  }));
  const labels: IntegrationCardLabels = {
    live: t('status.live'),
    planned: t('status.planned'),
    openApp: t('cta.openApp'),
    loginRequired: t('cta.loginRequired'),
    comingSoon: t('cta.comingSoon'),
  };

  return (
    <section>
      <div className="py-6 md:py-16">
        <div className="mx-auto max-w-6xl">
          <div className="max-w-2xl space-y-3 md:space-y-4">
            <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">{t('hero.eyebrow')}</p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl md:text-4xl">{t('hero.title')}</h2>
            <p className="max-w-xl text-sm text-muted-foreground sm:text-base">{t('hero.description')}</p>
          </div>

          <div className="mt-6 max-w-2xl md:mt-8">
            <HomeChatPrompt />
          </div>

          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {localizedApps.map((app) => (
              <IntegrationCard key={app.id} app={app} isAuthenticated={isAuthenticated} labels={labels} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function IntegrationCard({
  app,
  isAuthenticated,
  labels,
}: {
  app: LocalizedSuiteApp;
  isAuthenticated: boolean;
  labels: IntegrationCardLabels;
}) {
  const Icon = app.icon;
  const isReady = app.status === 'ready';
  const canOpen = isReady && isAuthenticated && app.href;

  const cardContent = (
    <Card className="h-full cursor-pointer border border-border bg-card p-4 shadow-sm transition-colors hover:bg-accent/50 sm:p-6">
      <div className="flex h-full flex-col gap-5 sm:gap-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex size-10 items-center justify-center border border-border bg-muted text-foreground">
            <Icon className="h-5 w-5" />
          </div>
          <span
            className={`px-2 py-1 text-[10px] font-bold tracking-widest uppercase ${
              isReady
                ? 'border border-primary/40 bg-primary/10 text-foreground'
                : 'border border-border bg-muted text-muted-foreground'
            }`}
          >
            {isReady ? labels.live : labels.planned}
          </span>
        </div>

        <div className="flex-1 space-y-2">
          <h3 className="text-base font-semibold">{app.title}</h3>
          <p className="text-sm text-muted-foreground">{app.description}</p>
        </div>

        <div className="border-t border-dashed border-border pt-4">
          {canOpen ? (
            <Button variant="secondary" size="sm" className="w-full justify-between gap-1 pr-2 shadow-none pointer-events-none sm:w-auto sm:justify-center">
              {labels.openApp}
              <ChevronRight className="size-3.5 opacity-60" />
            </Button>
          ) : isReady ? (
            <Button variant="outline" size="sm" className="w-full justify-between gap-1 pr-2 pointer-events-none sm:w-auto sm:justify-center">
              {labels.loginRequired}
              <ChevronRight className="size-3.5 opacity-60" />
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="w-full sm:w-auto" disabled>
              {labels.comingSoon}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );

  if (canOpen) {
    return (
      <Link href={app.href!} className="block h-full">
        {cardContent}
      </Link>
    );
  }

  return cardContent;
}
