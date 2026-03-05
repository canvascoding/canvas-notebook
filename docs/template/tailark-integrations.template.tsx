import * as React from 'react';
import Link from 'next/link';
import { ChevronRight, Clapperboard, FileText, ImageIcon, NotebookPen, Sparkles, Workflow } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

// Template reference only. Productive implementation lives in components/suite/SuiteAppSelector.tsx.
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
    title: 'Image Generation',
    description: 'Bilder erzeugen und direkt im Workspace speichern.',
    status: 'planned',
    icon: ImageIcon,
  },
  {
    title: 'VEO Studio',
    description: 'Video-Generierung mit Workspace-basierter Ausgabe.',
    status: 'planned',
    icon: Clapperboard,
  },
  {
    title: 'Content Studio',
    description: 'Copywriting und Summaries für produktive Workflows.',
    status: 'planned',
    icon: FileText,
  },
  {
    title: 'Workflow Automations',
    description: 'Standardabläufe über mehrere Apps orchestrieren.',
    status: 'planned',
    icon: Workflow,
  },
  {
    title: 'Creative Remix',
    description: 'Assets aus dem Workspace direkt kombinieren und remixen.',
    status: 'planned',
    icon: Sparkles,
  },
];

export default function TailarkIntegrationsTemplate() {
  return (
    <section>
      <div className="py-12 md:py-16">
        <div className="mx-auto max-w-6xl px-4 md:px-6">
          <div className="max-w-2xl space-y-4">
            <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">Canvas Software Suite</p>
            <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">Wähle eine App und arbeite im gleichen Workspace weiter.</h2>
            <p className="text-muted-foreground">
              Alle Apps greifen auf denselben Workspace zu. Diese Vorlage basiert auf dem Tailark Integrations-Template und
              wurde auf die Canvas UI/CI Richtlinie angepasst.
            </p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {suiteApps.map((app) => (
              <Card key={app.title} className="border border-border bg-card p-6 shadow-sm">
                <div className="flex flex-col gap-6">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex size-10 items-center justify-center border border-border bg-muted text-foreground">
                      <app.icon className="h-5 w-5" />
                    </div>
                    <span
                      className={`px-2 py-1 text-[10px] font-bold tracking-widest uppercase ${
                        app.status === 'ready'
                          ? 'border border-primary/40 bg-primary/10 text-foreground'
                          : 'border border-border bg-muted text-muted-foreground'
                      }`}
                    >
                      {app.status === 'ready' ? 'Live' : 'Planned'}
                    </span>
                  </div>

                  <div className="space-y-2">
                    <h3 className="text-base font-semibold">{app.title}</h3>
                    <p className="text-sm text-muted-foreground">{app.description}</p>
                  </div>

                  <div className="border-t border-dashed border-border pt-4">
                    {app.href ? (
                      <Button asChild variant="secondary" size="sm" className="gap-1 pr-2 shadow-none">
                        <Link href={app.href}>
                          App öffnen
                          <ChevronRight className="size-3.5 opacity-60" />
                        </Link>
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" disabled>
                        Bald verfügbar
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
