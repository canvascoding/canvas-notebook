'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, Bot, Check, FolderKanban, Settings2, Workflow } from 'lucide-react';

import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';

export function GettingStartedCard() {
  const t = useTranslations('onboarding');
  const [dismissing, setDismissing] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  async function dismiss() {
    setDismissing(true);
    try {
      const response = await fetch('/api/onboarding/user', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'complete', tour: 'completed' }),
      });
      if (response.ok) setDismissed(true);
    } finally {
      setDismissing(false);
    }
  }

  if (dismissed) return null;

  const items = [
    { href: '/notebook', icon: FolderKanban, title: t('tourNotebookTitle'), description: t('tourNotebookDescription') },
    { href: '/automations', icon: Workflow, title: t('tourAutomationTitle'), description: t('tourAutomationDescription') },
    { href: '/settings', icon: Settings2, title: t('tourSettingsTitle'), description: t('tourSettingsDescription') },
  ];

  return (
    <section className="overflow-hidden border border-primary/30 bg-primary/[0.035] shadow-sm">
      <div className="border-b border-primary/15 bg-primary/[0.055] px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
            <Bot className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold">{t('tourHomeTitle')}</p>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">{t('tourHomeDescription')}</p>
          </div>
        </div>
      </div>
      <div className="grid divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {items.map(({ href, icon: Icon, title, description }) => (
          <Link key={href} href={href} className="group p-4 transition-colors hover:bg-background/70">
            <Icon className="mb-3 h-4 w-4 text-primary" />
            <p className="text-sm font-semibold">{title}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
            <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary">
              {t('tourExplore')} <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>
        ))}
      </div>
      <div className="flex justify-end border-t border-border bg-background/40 px-4 py-2">
        <Button variant="ghost" size="sm" onClick={() => void dismiss()} disabled={dismissing} className="gap-2 text-xs">
          <Check className="h-3.5 w-3.5" />
          {t('tourFinish')}
        </Button>
      </div>
    </section>
  );
}
