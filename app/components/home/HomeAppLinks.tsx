'use client';

import { Inbox, ListTodo, Network, NotebookPen, Sparkles, Workflow } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link } from '@/i18n/navigation';

const HOME_APPS = [
  { id: 'notebook', href: '/notebook', icon: NotebookPen },
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
      <div className="grid gap-px border border-border bg-border min-[390px]:grid-cols-2 sm:grid-cols-3">
        {HOME_APPS.map(({ id, href, icon: Icon }) => (
          <Link
            key={id}
            href={href}
            className="group flex min-h-20 items-center gap-3 bg-card px-3 py-3 transition-colors hover:bg-accent"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{t(`apps.${id}.title`)}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">{t(`apps.${id}.description`)}</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
