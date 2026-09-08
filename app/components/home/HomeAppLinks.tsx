'use client';

import Image from 'next/image';
import { AlertTriangle, ArrowRight, Clock3, Inbox, ListTodo, MailOpen, Sparkles, Workflow } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';

import { Link } from '@/i18n/navigation';
import type { HomeWidgetAutomation, HomeWidgetEmail, HomeWidgetStudio, HomeWidgetTodo } from '@/app/lib/home/workspace-widget-data';
import type { HomeWidgetState } from './useHomeWorkspaceWidgets';
import { useHomeWorkspaceWidgets } from './useHomeWorkspaceWidgets';
import styles from './home-workspace-widgets.module.css';

type WidgetCardProps = {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: typeof Inbox;
  summary: ReactNode;
  details: ReactNode;
  footer: string;
};

function WidgetCard({ id, title, description, href, icon: Icon, summary, details, footer }: WidgetCardProps) {
  const t = useTranslations('home.workspaceWidgets');
  return (
    <article data-testid={`workspace-widget-${id}`} className={`${styles.card} group min-h-64 overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-[border-color,box-shadow] hover:border-foreground/25 hover:shadow-md focus-within:border-foreground/25 md:min-h-0`}>
      <header className="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground"><Icon className="h-4 w-4" aria-hidden="true" /></span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{title}</h3>
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        <Link href={href} aria-label={t('openApp', { app: title })} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ArrowRight className="h-4 w-4" /></Link>
      </header>
      <div className={`${styles.widgetBody} flex-1`}>
        <div data-testid={`workspace-widget-${id}-summary`} className={styles.summary}>{summary}</div>
        <div data-testid={`workspace-widget-${id}-quick-selection`} className={`${styles.details} bg-card`}>
          <p className="px-5 pt-4 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t('quickSelection')}</p>
          <div className={styles.detailContent}>{details}</div>
        </div>
      </div>
      <Link href={href} className="flex min-h-11 items-center justify-between border-t border-border/70 px-5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"><span>{footer}</span><ArrowRight className="h-3.5 w-3.5" /></Link>
    </article>
  );
}

function LoadingSummary() {
  return <div className="flex h-full flex-col justify-center gap-3 p-5" aria-hidden="true"><div className="h-7 w-20 animate-pulse rounded bg-muted" /><div className="h-3 w-3/4 animate-pulse rounded bg-muted" /><div className="h-3 w-1/2 animate-pulse rounded bg-muted" /></div>;
}

function Unavailable({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('home.workspaceWidgets');
  return <div className="flex h-full flex-col items-start justify-center gap-3 p-5"><div className="flex items-center gap-2 text-sm font-medium"><AlertTriangle className="h-4 w-4 text-destructive" />{t('unavailable')}</div><button type="button" onClick={onRetry} className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">{t('retry')}</button></div>;
}

function relativeTime(format: ReturnType<typeof useFormatter>, value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : format.relativeTime(date, new Date());
}

function plainPreviewText(value: string | null): string {
  return (value || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[*_~`>#|]+/gu, ' ')
    .replace(/^\s*[-+]\s+/gmu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isSafeApplicationMediaUrl(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\');
}

function SafeStudioImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !isSafeApplicationMediaUrl(src)) {
    return <div className="flex h-full items-center justify-center"><Sparkles className="h-8 w-8 text-muted-foreground" /></div>;
  }
  return <Image src={src} alt="" fill unoptimized sizes="(min-width: 768px) 50vw, 100vw" className="object-cover transition-transform duration-300 group-hover:scale-[1.02]" onError={() => setFailed(true)} />;
}

function stateSummary<T>({ state, ready, onRetry }: { state: HomeWidgetState<T>; ready: (data: T) => ReactNode; onRetry: () => void }) {
  if (state.status === 'idle' || state.status === 'loading') return <LoadingSummary />;
  if (state.status === 'error') return <Unavailable onRetry={onRetry} />;
  return ready(state.data);
}

function EmailWidget({ state, onRetry }: { state: HomeWidgetState<HomeWidgetEmail[]>; onRetry: () => void }) {
  const t = useTranslations('home.workspaceWidgets.email');
  const format = useFormatter();
  const messages = state.data;
  const messageHref = (message: HomeWidgetEmail) => `/emails?${new URLSearchParams({ accountId: message.accountId, messageId: message.id, ...(message.folder ? { folder: message.folder } : {}) })}`;
  return <WidgetCard id="email" title={t('title')} description={t('description')} href="/emails" icon={Inbox} footer={t('openAll')}
    summary={stateSummary({ state, onRetry, ready: data => <div className="flex h-full flex-col justify-between p-5"><div><p className="text-4xl font-semibold tracking-tight">{data.length}</p><p className="mt-1 text-sm text-muted-foreground">{t('count', { count: data.length })}</p></div>{data[0] ? <div><p className="truncate text-sm font-medium">{data[0].subject || t('noSubject')}</p><p className="mt-1 truncate text-xs text-muted-foreground">{data[0].from || t('unknownSender')} · {relativeTime(format, data[0].date)}</p></div> : <p className="text-sm text-muted-foreground">{t('empty')}</p>}</div> })}
    details={<div className="divide-y divide-border/60 px-3 py-2">{messages.length ? messages.map(message => <Link key={`${message.accountId}:${message.id}`} href={messageHref(message)} className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><MailOpen className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{message.subject || t('noSubject')}</span><span className="block truncate text-xs text-muted-foreground">{message.from || t('unknownSender')} · {message.accountLabel}</span></span></Link>) : <p className="px-2 py-5 text-sm text-muted-foreground">{t('empty')}</p>}</div>}
  />;
}

function TodoWidget({ state, workspaceId, onRetry }: { state: HomeWidgetState<HomeWidgetTodo[]>; workspaceId: string; onRetry: () => void }) {
  const t = useTranslations('home.workspaceWidgets.todos');
  const format = useFormatter();
  const todos = state.data;
  return <WidgetCard id="todos" title={t('title')} description={t('description')} href={`/todos?workspaceId=${encodeURIComponent(workspaceId)}`} icon={ListTodo} footer={t('openAll')}
    summary={stateSummary({ state, onRetry, ready: data => <div className="flex h-full flex-col justify-between p-5"><div><p className="text-4xl font-semibold tracking-tight">{data.length}</p><p className="mt-1 text-sm text-muted-foreground">{t('count', { count: data.length })}</p></div>{data[0] ? <div><p className="truncate text-sm font-medium">{data[0].title}</p><p className={`mt-1 text-xs ${data[0].priority === 'high' ? 'text-destructive' : 'text-muted-foreground'}`}>{data[0].priority === 'high' ? t('highPriority') : data[0].dueAt ? t('due', { time: relativeTime(format, data[0].dueAt) }) : t('open')}</p></div> : <p className="text-sm text-muted-foreground">{t('empty')}</p>}</div> })}
    details={<div className="divide-y divide-border/60 px-3 py-2">{todos.length ? todos.map(todo => <Link key={todo.id} href={`/todos?todo=${encodeURIComponent(todo.id)}&workspaceId=${encodeURIComponent(workspaceId)}`} className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className={`h-2.5 w-2.5 shrink-0 rounded-full border ${todo.priority === 'high' ? 'border-destructive bg-destructive/15' : 'border-muted-foreground/50'}`} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{todo.title}</span><span className="block truncate text-xs text-muted-foreground">{todo.dueAt ? t('due', { time: relativeTime(format, todo.dueAt) }) : t('open')}</span></span></Link>) : <p className="px-2 py-5 text-sm text-muted-foreground">{t('empty')}</p>}</div>}
  />;
}

function AutomationWidget({ state, onRetry }: { state: HomeWidgetState<HomeWidgetAutomation | null>; onRetry: () => void }) {
  const t = useTranslations('home.workspaceWidgets.automation');
  const format = useFormatter();
  const automation = state.data;
  const runLabel = automation?.lastRunStatus ? t(`status.${automation.lastRunStatus}`) : t('notRun');
  const resultPreview = plainPreviewText(automation?.resultText || null);
  return <WidgetCard id="automation" title={t('title')} description={t('description')} href="/automations" icon={Workflow} footer={t('openAll')}
    summary={stateSummary({ state, onRetry, ready: data => data ? <div className="flex h-full flex-col justify-between p-5"><div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${data.lastRunStatus === 'failed' ? 'bg-destructive' : data.lastRunStatus === 'running' || data.lastRunStatus === 'pending' ? 'bg-primary animate-pulse' : 'bg-muted-foreground/60'}`} /><span className="text-xs font-medium text-muted-foreground">{runLabel}</span></div><div><p className="truncate text-lg font-semibold">{data.name}</p><p className="mt-1 text-xs text-muted-foreground">{data.lastRunAt ? t('lastRun', { time: relativeTime(format, data.lastRunAt) }) : t('notRun')}</p></div></div> : <div className="flex h-full items-end p-5"><p className="text-sm text-muted-foreground">{t('empty')}</p></div> })}
    details={<div className="flex h-full min-h-0 flex-col justify-between gap-3 px-5 py-4">{automation ? <><div className="min-h-0"><p className="truncate text-sm font-semibold">{automation.name}</p><p className="mt-2 line-clamp-3 break-words text-sm leading-relaxed text-muted-foreground">{resultPreview || t('noResult')}</p></div><div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"><Clock3 className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{automation.nextRunAt ? t('nextRun', { time: relativeTime(format, automation.nextRunAt) }) : t('noNextRun')}</span></div></> : <p className="text-sm text-muted-foreground">{t('empty')}</p>}</div>}
  />;
}

function StudioWidget({ state, workspaceId, onRetry }: { state: HomeWidgetState<HomeWidgetStudio | null>; workspaceId: string; onRetry: () => void }) {
  const t = useTranslations('home.workspaceWidgets.studio');
  const format = useFormatter();
  const generation = state.data;
  const href = generation ? `/studio?${new URLSearchParams({ workspaceId, generation: generation.id })}` : `/studio?workspaceId=${encodeURIComponent(workspaceId)}`;
  return <WidgetCard id="studio" title={t('title')} description={t('description')} href={href} icon={Sparkles} footer={generation ? t('openGeneration') : t('openStudio')}
    summary={stateSummary({ state, onRetry, ready: data => data ? <div className="relative h-full min-h-40 overflow-hidden bg-muted">{data.output ? <SafeStudioImage key={data.output.mediaUrl} src={data.output.mediaUrl} /> : <div className="flex h-full items-center justify-center"><Sparkles className="h-8 w-8 text-muted-foreground" /></div>}<div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background/95 to-transparent px-5 pb-4 pt-12"><p className="line-clamp-2 break-words text-sm font-medium">{data.prompt || t('untitled')}</p></div></div> : <div className="flex h-full items-end p-5"><p className="text-sm text-muted-foreground">{t('empty')}</p></div> })}
    details={<div className="flex h-full min-h-0 flex-col justify-between gap-3 px-5 py-4">{generation ? <><div className="min-h-0"><p className="line-clamp-4 break-words text-sm font-medium leading-relaxed">{generation.prompt || t('untitled')}</p><p className="mt-2 truncate text-xs text-muted-foreground">{t('created', { time: relativeTime(format, generation.createdAt) })}</p></div><Link href={href} className="inline-flex shrink-0 items-center gap-2 text-sm font-medium text-primary hover:underline"><Sparkles className="h-4 w-4" />{t('useAgain')}</Link></> : <p className="text-sm text-muted-foreground">{t('empty')}</p>}</div>}
  />;
}

export function HomeAppLinks({ active, workspaceId }: { active: boolean; workspaceId?: string }) {
  const t = useTranslations('home');
  const widgets = useHomeWorkspaceWidgets(workspaceId, active);

  return (
    <section aria-labelledby="home-workspaces-heading" className="flex h-full min-h-0 flex-col">
      <div className="mb-5 shrink-0">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('workspaceWidgets.eyebrow')}</p>
        <h2 id="home-workspaces-heading" className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{t('sections.workspace')}</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('pages.workspaceDescription')}</p>
      </div>
      {workspaceId ? <div className="grid flex-1 gap-4 md:min-h-0 md:grid-cols-2 md:grid-rows-[repeat(2,minmax(15rem,1fr))]">
        <EmailWidget state={widgets.emails} onRetry={() => widgets.retry('emails')} />
        <TodoWidget state={widgets.todos} workspaceId={workspaceId} onRetry={() => widgets.retry('todos')} />
        <StudioWidget state={widgets.studio} workspaceId={workspaceId} onRetry={() => widgets.retry('studio')} />
        <AutomationWidget state={widgets.automation} onRetry={() => widgets.retry('automation')} />
      </div> : <div className="grid flex-1 gap-4 md:grid-cols-2 lg:grid-rows-2">{Array.from({ length: 4 }, (_, index) => <div key={index} className="min-h-64 animate-pulse rounded-xl border border-border bg-muted/40" />)}</div>}
    </section>
  );
}
