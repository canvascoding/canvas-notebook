import * as React from 'react';
import Link from 'next/link';
import { BarChart3, ChevronRight, Clapperboard, Globe, HelpCircle, ImageIcon, NotebookPen, Terminal, Workflow, Wrench } from 'lucide-react';

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
    title: 'Terminal',
    description: 'Fullscreen Terminal mit denselben Quick Actions wie im Notebook.',
    status: 'ready',
    href: '/terminal',
    icon: Terminal,
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
    title: 'Hilfe & Tutorials',
    description: 'Tutorials, Anleitungen und Hilfe zur Einrichtung.',
    status: 'ready',
    href: '/help',
    icon: HelpCircle,
  },
];

interface IntegrationsSectionProps {
  isAuthenticated: boolean;
}

export default function SuiteAppSelector({ isAuthenticated }: IntegrationsSectionProps) {
  return (
    <section>
      <div className="py-12 md:py-16">
        <div className="mx-auto max-w-6xl px-4 md:px-6">
          <div className="max-w-2xl space-y-4">
            <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">Canvas Software Suite</p>
            <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">Wähle eine App und arbeite im gleichen Workspace weiter.</h2>
            <p className="text-muted-foreground">
              Alle Apps greifen auf denselben Workspace zu. Neue Bilder, Videos und Inhalte sind dadurch sofort für weitere Schritte
              verfügbar.
            </p>
          </div>

          <div className="mt-8 max-w-2xl">
            <HomeChatPrompt />
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
    <Card className="border border-border bg-card p-6 shadow-sm transition-colors hover:bg-accent/50 cursor-pointer h-full">
      <div className="flex flex-col gap-6 h-full">
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

        <div className="space-y-2 flex-1">
          <h3 className="text-base font-semibold">{app.title}</h3>
          <p className="text-sm text-muted-foreground">{app.description}</p>
        </div>

        <div className="border-t border-dashed border-border pt-4">
          {canOpen ? (
            <Button variant="secondary" size="sm" className="gap-1 pr-2 shadow-none pointer-events-none">
              App öffnen
              <ChevronRight className="size-3.5 opacity-60" />
            </Button>
          ) : isReady ? (
            <Button variant="outline" size="sm" className="gap-1 pr-2 pointer-events-none">
              Login erforderlich
              <ChevronRight className="size-3.5 opacity-60" />
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>
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
