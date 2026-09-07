'use client';

import { Inbox, ListTodo, Sparkles, Workflow } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link } from '@/i18n/navigation';

const HOME_APPS = [
  { id: 'emails', href: '/emails', icon: Inbox },
  { id: 'todos', href: '/todos', icon: ListTodo },
  { id: 'studio', href: '/studio', icon: Sparkles },
  { id: 'automations', href: '/automations', icon: Workflow },
] as const;

export function HomeAppLinks() {
  const t = useTranslations('home');

  return (
    <section aria-labelledby="home-workspaces-heading">
      <h2 id="home-workspaces-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">
        {t('sections.workspace')}
      </h2>
      <p className="mt-2 mb-8 max-w-xl text-sm text-muted-foreground">{t('pages.workspaceDescription')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {HOME_APPS.map(({ id, href, icon: Icon }) => (
          <Link
            key={id}
            href={href}
            className="group flex min-h-36 items-start gap-4 rounded-xl border border-border bg-card/50 p-5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="mt-0.5 text-muted-foreground">
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{t(`apps.${id}.title`)}</span>
              <span className="mt-2 block text-sm leading-relaxed text-muted-foreground">{t(`apps.${id}.description`)}</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
