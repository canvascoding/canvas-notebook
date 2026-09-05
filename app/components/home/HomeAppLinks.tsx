'use client';

import { Inbox, ListTodo, Network, Sparkles, Workflow } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link } from '@/i18n/navigation';

const HOME_APPS = [
  { id: 'emails', href: '/emails', icon: Inbox },
  { id: 'todos', href: '/todos', icon: ListTodo },
  { id: 'studio', href: '/studio', icon: Sparkles },
  { id: 'knowledgeGraph', href: '/knowledge-graph', icon: Network },
  { id: 'automations', href: '/automations', icon: Workflow },
] as const;

export function HomeAppLinks() {
  const t = useTranslations('home');

  return (
    <section aria-labelledby="home-workspaces-heading">
      <h2 id="home-workspaces-heading" className="mb-3 text-xs font-bold tracking-[0.18em] text-muted-foreground uppercase">
        {t('sections.workspace')}
      </h2>
      <div className="flex flex-wrap gap-2">
        {HOME_APPS.map(({ id, href, icon: Icon }) => (
          <Link
            key={id}
            href={href}
            className="group flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 py-2 transition-colors hover:bg-accent"
          >
            <span className="text-muted-foreground">
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{t(`apps.${id}.title`)}</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
