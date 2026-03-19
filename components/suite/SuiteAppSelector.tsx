import * as React from 'react';
import Link from 'next/link';
import { BarChart3, ChevronRight, Clapperboard, Globe, ImageIcon, NotebookPen, Terminal, Workflow, Wrench } from 'lucide-react';

import { HomeChatPrompt } from '@/app/components/home/HomeChatPrompt';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

type SuiteApp = {
  title: string;
  description: string;
  status: 'ready' | 'planned';
  href?: string;
  icon: React.ComponentType<{ className?: string }>;
};

const suiteApps: SuiteApp[] = [
  {
    title: 'Canvas Notebook',
    description: 'Dateien, Chat, Editor und Terminal im Workspace verwalten.',
    status: 'ready',
    href: '/notebook',
    icon: NotebookPen,
  },
  {
    title: 'Usage Analytics',
    description: 'Token- und Kostenverbrauch nach Zeitraum, Modell, Session und Nutzer auswerten.',
    status: 'ready',
    href: '/usage',
    icon: BarChart3,
  },
  {
    title: 'Image Generation',
    description: 'Bilder erzeugen und direkt im Workspace speichern.',
    status: 'ready',
    href: '/image-generation',
    icon: ImageIcon,
  },
  {
    title: 'VEO Studio',
    description: 'Video-Generierung mit Workspace-basierter Ausgabe.',
    status: 'ready',
    href: '/veo',
    icon: Clapperboard,
  },
  {
    title: 'Nano Banana Localizer',
    description: 'Bestehende Ads pro Zielmarkt sprachlich lokalisieren.',
    status: 'ready',
    href: '/nano-banana-localizer',
    icon: Globe,
  },
  {
    title: 'Automationen',
    description: 'Wiederkehrende Agent-Aufträge für den gemeinsamen Workspace planen.',
    status: 'ready',
    href: '/automationen',
    icon: Workflow,
  },
  {
    title: 'Skill Gallery',
    description: 'Skills erstellen, verwalten und im Chat nutzen.',
    status: 'ready',
    href: '/skills',
    icon: Wrench,
  },
  {
    title: 'Terminal',
    description: 'Workspace Terminal für echte Nerds. Keine GUI, nur pure Kommandozeilen-Magie.',
    status: 'ready',
    href: '/terminal',
    icon: Terminal,
  },
];

interface IntegrationsSectionProps {
  isAuthenticated: boolean;
}

export default function SuiteAppSelector({ isAuthenticated }: IntegrationsSectionProps) {
  return (
    <section>
      <div className="py-6 md:py-16">
        <div className="mx-auto max-w-6xl">
          <div className="max-w-2xl space-y-3 md:space-y-4">
            <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">Canvas Software Suite</p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl md:text-4xl">Wähle eine App und arbeite im gleichen Workspace weiter.</h2>
            <p className="max-w-xl text-sm text-muted-foreground sm:text-base">
              Alle Apps greifen auf denselben Workspace zu. Neue Bilder, Videos und Inhalte sind dadurch sofort für weitere Schritte
              verfügbar.
            </p>
          </div>

          <div className="mt-6 max-w-2xl md:mt-8">
            <HomeChatPrompt />
          </div>

          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {suiteApps.map((app) => (
              <IntegrationCard key={app.title} app={app} isAuthenticated={isAuthenticated} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function IntegrationCard({ app, isAuthenticated }: { app: SuiteApp; isAuthenticated: boolean }) {
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
            {isReady ? 'Live' : 'Planned'}
          </span>
        </div>

        <div className="flex-1 space-y-2">
          <h3 className="text-base font-semibold">{app.title}</h3>
          <p className="text-sm text-muted-foreground">{app.description}</p>
        </div>

        <div className="border-t border-dashed border-border pt-4">
          {canOpen ? (
            <Button variant="secondary" size="sm" className="w-full justify-between gap-1 pr-2 shadow-none pointer-events-none sm:w-auto sm:justify-center">
              App öffnen
              <ChevronRight className="size-3.5 opacity-60" />
            </Button>
          ) : isReady ? (
            <Button variant="outline" size="sm" className="w-full justify-between gap-1 pr-2 pointer-events-none sm:w-auto sm:justify-center">
              Login erforderlich
              <ChevronRight className="size-3.5 opacity-60" />
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="w-full sm:w-auto" disabled>
              Bald verfügbar
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
