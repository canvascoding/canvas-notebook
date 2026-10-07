'use client';

import Image from 'next/image';
import { AlertTriangle, ArrowRight, Clock3, Inbox, ListTodo, MailOpen, Puzzle, Sparkles, Workflow } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useRef, useState, type ReactNode } from 'react';

import { Link } from '@/i18n/navigation';
import { buildTodoPopupHref, isUnmodifiedPrimaryClick } from '@/app/lib/todos/navigation';
import { openTodoDetail } from '@/app/store/todo-detail-store';
import { authClient } from '@/app/lib/auth-client';
import type { EmailClassificationFeedItem, EmailFeedView } from '@/app/lib/email/classification/feed-types';
import type { HomeWidgetAutomation, HomeWidgetEmail, HomeWidgetStudio, HomeWidgetTodo } from '@/app/lib/home/workspace-widget-data';
import type { HomeWidgetState } from './useHomeWorkspaceWidgets';
import { useHomeWorkspaceWidgets } from './useHomeWorkspaceWidgets';
import { useHomeEmailFocus, type HomeEmailFocusState } from './useHomeEmailFocus';
import styles from './home-workspace-widgets.module.css';

type WidgetCardProps = {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: typeof Inbox;
  preview: ReactNode;
  footer: string;
  freezeEnabled: boolean;
  freezeIdentity?: string;
};

export function WidgetCard({ id, title, description, href, icon: Icon, preview, footer, freezeEnabled, freezeIdentity = id }: WidgetCardProps) {
  const t = useTranslations('home.workspaceWidgets');
  const [freeze, setFreeze] = useState<{ identity: string; enabled: boolean; content: { footer: string; href: string; preview: ReactNode } | null }>({ identity: freezeIdentity, enabled: freezeEnabled, content: null });
  // Reset before commit: re-enabling a failed source must never revive an old frozen ReactNode.
  const invalidated = freeze.identity !== freezeIdentity || freeze.enabled !== freezeEnabled;
  if (invalidated) setFreeze({ identity: freezeIdentity, enabled: freezeEnabled, content: null });
  const pointerWithinRef = useRef(false);
  const focusWithinRef = useRef(false);
  const displayedContent = !invalidated && freezeEnabled && freeze.content ? freeze.content : { footer, href, preview };
  const freezeContent = () => {
    if (freezeEnabled) setFreeze(current => current.identity === freezeIdentity && current.enabled && current.content ? current
      : { identity: freezeIdentity, enabled: true, content: { footer, href, preview } });
  };
  const releaseContent = () => {
    if (!pointerWithinRef.current && !focusWithinRef.current) setFreeze(current => ({ ...current, content: null }));
  };

  return (
    <article
      data-testid={`workspace-widget-${id}`}
      className={`${styles.card} min-h-64 overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-[border-color,box-shadow] hover:border-foreground/25 hover:shadow-md focus-within:border-foreground/25 md:min-h-0`}
      onPointerEnter={() => {
        pointerWithinRef.current = true;
        freezeContent();
      }}
      onPointerLeave={() => {
        pointerWithinRef.current = false;
        releaseContent();
      }}
      onFocusCapture={() => {
        focusWithinRef.current = true;
        freezeContent();
      }}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        focusWithinRef.current = false;
        releaseContent();
      }}
    >
      <header className="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground"><Icon className="h-4 w-4" aria-hidden="true" /></span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{title}</h3>
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        <Link href={displayedContent.href} aria-label={t('openApp', { app: title })} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ArrowRight className="h-4 w-4" /></Link>
      </header>
      <div className={`${styles.widgetBody} flex-1`}>
        <div data-testid={`workspace-widget-${id}-preview`} className={styles.preview}>
          {displayedContent.preview}
        </div>
      </div>
      <Link href={displayedContent.href} className="flex min-h-11 items-center justify-between border-t border-border/70 px-5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"><span>{displayedContent.footer}</span><ArrowRight className="h-3.5 w-3.5" /></Link>
    </article>
  );
}

/** Remount every card's private freeze state when the authenticated actor or workspace changes. */
export function HomeWidgetGrid({ identity, children }: { identity: string; children: ReactNode }) {
  return <div key={identity} className="grid flex-1 gap-4 md:min-h-0 md:grid-cols-2 md:grid-rows-[repeat(2,minmax(21rem,1fr))]">{children}</div>;
}

function ListPreview({ countLabel, children }: { countLabel: string; children: ReactNode }) {
  const t = useTranslations('home.workspaceWidgets');
  return (
    <div className="grid h-full min-h-0 grid-rows-[2.25rem_minmax(0,1fr)]">
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/50 px-5">
        <p className="shrink-0 text-[0.66rem] font-semibold uppercase tracking-[0.15em] text-muted-foreground">{t('quickSelection')}</p>
        <p className="truncate text-[0.7rem] font-medium text-muted-foreground">{countLabel}</p>
      </div>
      <div className="min-h-0 overflow-hidden px-3">{children}</div>
    </div>
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

function studioHref(workspaceId: string, generation?: HomeWidgetStudio | null): string {
  if (!generation) return `/studio?workspaceId=${encodeURIComponent(workspaceId)}`;
  return `/studio?${new URLSearchParams({
    workspaceId,
    generation: generation.id,
    ...(generation.output ? { output: generation.output.id } : {}),
  })}`;
}

function isSafeApplicationMediaUrl(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\');
}

function SafeStudioImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !isSafeApplicationMediaUrl(src)) {
    return <div className="flex h-full items-center justify-center"><Sparkles className="h-8 w-8 text-muted-foreground" /></div>;
  }
  return <Image src={src} alt="" fill unoptimized sizes="(min-width: 768px) 50vw, 100vw" className="object-cover" onError={() => setFailed(true)} />;
}

function stateSummary<T>({ state, ready, onRetry }: { state: HomeWidgetState<T>; ready: (data: T) => ReactNode; onRetry: () => void }) {
  if (state.status === 'idle' || state.status === 'loading') return <LoadingSummary />;
  if (state.status === 'error') return <Unavailable onRetry={onRetry} />;
  return ready(state.data);
}

function EmailWidget({ state, onRetry, identity }: { state: HomeWidgetState<HomeWidgetEmail[]>; onRetry: () => void; identity: string }) {
  const t = useTranslations('home.workspaceWidgets.email');
  const messageHref = (message: HomeWidgetEmail) => `/emails?${new URLSearchParams({ accountId: message.accountId, messageId: message.id, ...(message.folder ? { folder: message.folder } : {}) })}`;
  return <WidgetCard id="email" title={t('title')} description={t('description')} href="/emails" icon={Inbox} footer={t('openAll')} freezeEnabled={state.status === 'ready'} freezeIdentity={identity}
    preview={stateSummary({ state, onRetry, ready: data => <ListPreview countLabel={t('count', { count: data.length })}>{data.length ? <div className="divide-y divide-border/60">{data.slice(0, 2).map(message => <Link key={`${message.accountId}:${message.id}`} href={messageHref(message)} className="flex h-11 min-w-0 items-center gap-3 px-2 transition-colors hover:bg-muted/70 focus-visible:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"><MailOpen className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium leading-4">{message.subject || t('noSubject')}</span><span className="mt-0.5 block truncate text-xs leading-4 text-muted-foreground">{message.from || t('unknownSender')} · {message.accountLabel}</span></span></Link>)}</div> : <p className="px-2 py-5 text-sm text-muted-foreground">{t('empty')}</p>}</ListPreview> })}
  />;
}

function homeFocusHref(view: EmailFeedView = 'focus', item?: EmailClassificationFeedItem) {
  return `/emails?${new URLSearchParams({ ...(item ? { messageRef: item.messageRef } : {}), mode: 'focus', scope: 'all', view })}`;
}

export function HomeEmailWidget({ state, onRetry, emailFocus, identity }: {
  state: HomeWidgetState<HomeWidgetEmail[]>; onRetry(): void; emailFocus: HomeEmailFocusState; identity: string;
}) {
  const t = useTranslations('home.workspaceWidgets.email');
  const tf = useTranslations('emailFocus');
  if (emailFocus.mode === 'legacy') return <EmailWidget key={`legacy:${identity}`} state={state} onRetry={onRetry} identity={identity} />;
  const { focus } = emailFocus;
  const feed = emailFocus.mode === 'focus' && focus.feed?.mode === 'focus' ? focus.feed : null;
  const unresolved = emailFocus.error || Boolean(focus.error) || emailFocus.mode === 'unknown' && !emailFocus.loading
    || emailFocus.mode === 'focus' && Boolean(focus.feed && !feed);
  const incomplete = Boolean(feed?.coverage.some(source => source.state !== 'complete' || source.pending || source.failed || source.stale));
  const failed = Boolean(feed?.coverage.some(source => source.state === 'failed'));
  const pauseReason = emailFocus.availability?.reason;
  const paused = Boolean(pauseReason && pauseReason !== 'disabled');
  const groups = feed?.counts.groups;
  const preview = unresolved ? <div data-testid="home-email-focus-status" className="flex h-full flex-col justify-center gap-3 px-5 py-4">
    <p className="text-sm text-muted-foreground">{focus.error ? tf(focus.error.status === 401 || focus.error.status === 403 ? 'feedErrors.access' : focus.error.status === 409 ? 'feedErrors.changed' : 'feedErrors.unavailable') : t('unconfirmed')}</p>
    <button type="button" data-testid="home-email-focus-refresh" className="self-start text-xs font-medium underline underline-offset-4" onClick={() => void emailFocus.refresh()}>{tf('refresh')}</button>
  </div> : !feed ? <LoadingSummary /> : <div className="flex h-full min-h-0 flex-col">
    <div data-testid="home-email-focus-summary" data-focus-count={(groups?.important ?? 0) + (groups?.reply ?? 0)} data-important-count={groups?.important ?? 0} data-reply-count={groups?.reply ?? 0} data-total-count={feed.counts.total} className="space-y-1.5 border-b border-border/50 px-5 py-2">
      <div className="flex items-center justify-between gap-2 text-xs"><p className="font-semibold">{t('focusCount', { count: (groups?.important ?? 0) + (groups?.reply ?? 0) })}</p>
        <span className="flex min-w-0 flex-wrap justify-end gap-x-1 text-right text-[11px] text-muted-foreground"><Link href={homeFocusHref('important')}>{t('importantCount', { count: groups?.important ?? 0 })}</Link><span>·</span><Link href={homeFocusHref('reply')}>{t('replyCount', { count: groups?.reply ?? 0 })}</Link></span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <Link data-testid="home-email-focus-review" href={homeFocusHref('review')} className="underline-offset-4 hover:underline">{tf('views.review')} · {groups?.review ?? 0}</Link>
        <Link data-testid="home-email-focus-pending" href={homeFocusHref('pending')} className="underline-offset-4 hover:underline">{tf('views.pending')} · {groups?.pending ?? 0}</Link>
        <Link href={homeFocusHref('all')} className="underline-offset-4 hover:underline">{tf('views.all')} · {feed.counts.total}</Link>
      </div>
    </div>
    <div className="min-h-0 flex-1 px-3">
      {feed.items.length ? <div className="divide-y divide-border/60">{feed.items.slice(0, 2).map(item => {
        const classification = item.classification;
        const source = `${tf(item.origin.workspaceId ? 'sources.work' : 'sources.personal')} · ${item.origin.workspaceName ? `${item.origin.workspaceName} · ` : ''}${item.origin.emailAddress}`;
        return <Link key={item.selectionKey} data-testid="home-email-focus-row" data-message-ref={item.messageRef} href={homeFocusHref('focus', item)} className="flex min-h-14 min-w-0 items-center gap-2 px-2 py-2 transition-colors hover:bg-muted/70 focus-visible:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <MailOpen className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 space-y-1">
            <span className="block truncate text-sm font-medium leading-4">{item.message.subject || t('noSubject')}</span>
            <span className="block truncate text-[11px] leading-3 text-muted-foreground" title={`${item.message.from || t('unknownSender')} · ${source}`}>{item.message.from || t('unknownSender')} · {source}</span>
            <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] leading-3 text-muted-foreground">
              {classification?.category && <span>{tf(`categories.${classification.category}`)}</span>}
              {(classification?.priority === 'high' || classification?.priority === 'urgent') && <span className="font-medium text-foreground">{tf(`priorities.${classification.priority}`)}</span>}
              {classification?.needsReply === true && classification.replyStatus !== 'answered' && <span>{tf('reasons.needsReply')}</span>}
            </span>
          </span>
        </Link>;
      })}</div> : <p className="px-2 py-3 text-sm text-muted-foreground">{t(incomplete || groups?.review || groups?.pending ? 'emptyPreparing' : 'emptyFocus')}</p>}
    </div>
    {(paused || incomplete || focus.hasUpdates) && <div data-testid="home-email-focus-status" className="flex items-center justify-between gap-2 border-t border-border/40 px-5 py-1.5 text-[10px] leading-snug text-muted-foreground">
      <span>{paused && <span title={tf(`availability.${pauseReason}`)}>{t('preparationPaused')}</span>}{paused && (incomplete || focus.hasUpdates) && ' · '}{(incomplete || focus.hasUpdates) && t(failed ? 'sourceFailed' : incomplete ? 'partial' : 'updatesAvailable')}</span>
      {focus.hasUpdates && <button type="button" data-testid="home-email-focus-refresh" className="shrink-0 font-medium underline underline-offset-4" disabled={focus.loading} onClick={() => void emailFocus.refresh()}>{tf('refresh')}</button>}
    </div>}
  </div>;
  return <WidgetCard key={`focus:${identity}`} id="email" title={t('title')} description={t('focusDescription')} href={homeFocusHref()} icon={Inbox} footer={t('openFocus')}
    freezeEnabled={Boolean(feed) && !unresolved} freezeIdentity={`${identity}:${feed?.snapshot.id ?? 'unconfirmed'}`} preview={preview} />;
}

function TodoWidget({ state, workspaceId, onRetry }: { state: HomeWidgetState<HomeWidgetTodo[]>; workspaceId: string; onRetry: () => void }) {
  const t = useTranslations('home.workspaceWidgets.todos');
  const format = useFormatter();
  return <WidgetCard id="todos" title={t('title')} description={t('description')} href={`/todos?workspaceId=${encodeURIComponent(workspaceId)}`} icon={ListTodo} footer={t('openAll')} freezeEnabled={state.status === 'ready'}
    preview={stateSummary({ state, onRetry, ready: data => <ListPreview countLabel={t('count', { count: data.length })}>{data.length ? <div className="divide-y divide-border/60">{data.slice(0, 2).map(todo => <Link key={todo.id} href={buildTodoPopupHref(todo.id)} onClick={(event) => {
      if (!isUnmodifiedPrimaryClick(event)) return;
      event.preventDefault();
      openTodoDetail(todo.id);
    }} className="flex h-11 min-w-0 items-center gap-3 px-2 transition-colors hover:bg-muted/70 focus-visible:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"><span className={`h-2.5 w-2.5 shrink-0 rounded-full border ${todo.priority === 'high' ? 'border-destructive bg-destructive/15' : 'border-muted-foreground/50'}`} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium leading-4">{todo.title}</span><span className={`mt-0.5 block truncate text-xs leading-4 ${todo.priority === 'high' ? 'text-destructive' : 'text-muted-foreground'}`}>{todo.priority === 'high' ? t('highPriority') : todo.dueAt ? t('due', { time: relativeTime(format, todo.dueAt) }) : t('open')}</span></span></Link>)}</div> : <p className="px-2 py-5 text-sm text-muted-foreground">{t('empty')}</p>}</ListPreview> })}
  />;
}

function AutomationWidget({ state, onRetry }: { state: HomeWidgetState<HomeWidgetAutomation | null>; onRetry: () => void }) {
  const t = useTranslations('home.workspaceWidgets.automation');
  const format = useFormatter();
  const automation = state.data;
  const runLabel = automation?.lastRunStatus ? t(`status.${automation.lastRunStatus}`) : t('notRun');
  const resultPreview = plainPreviewText(automation?.resultText || null);
  return <WidgetCard id="automation" title={t('title')} description={t('description')} href="/automations" icon={Workflow} footer={t('openAll')} freezeEnabled={state.status === 'ready'}
    preview={stateSummary({ state, onRetry, ready: data => data ? <Link href={`/automations/${encodeURIComponent(data.id)}`} className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"><div className="flex h-full min-h-0 flex-col justify-between gap-2 px-5 py-3.5"><div className="flex min-w-0 items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2"><span className={`h-2 w-2 shrink-0 rounded-full ${data.lastRunStatus === 'failed' ? 'bg-destructive' : data.lastRunStatus === 'running' || data.lastRunStatus === 'pending' ? 'bg-primary animate-pulse' : 'bg-muted-foreground/60'}`} /><span className="truncate text-xs font-medium text-muted-foreground">{runLabel}</span></div><span className="shrink-0 text-[0.7rem] text-muted-foreground">{data.lastRunAt ? t('lastRun', { time: relativeTime(format, data.lastRunAt) }) : t('notRun')}</span></div><div className="min-h-0"><p className="truncate text-sm font-semibold">{data.name}</p><p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-muted-foreground">{resultPreview || t('noResult')}</p></div><div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"><Clock3 className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{data.nextRunAt ? t('nextRun', { time: relativeTime(format, data.nextRunAt) }) : t('noNextRun')}</span></div></div></Link> : <div className="flex h-full items-end p-5"><p className="text-sm text-muted-foreground">{t('empty')}</p></div> })}
  />;
}

function StudioWidget({ state, workspaceId, onRetry }: { state: HomeWidgetState<HomeWidgetStudio | null>; workspaceId: string; onRetry: () => void }) {
  const t = useTranslations('home.workspaceWidgets.studio');
  const format = useFormatter();
  const generation = state.data;
  const href = studioHref(workspaceId, generation);
  return <WidgetCard id="studio" title={t('title')} description={t('description')} href={href} icon={Sparkles} footer={generation ? t('openGeneration') : t('openStudio')} freezeEnabled={state.status === 'ready'}
    preview={stateSummary({ state, onRetry, ready: data => data ? <Link href={studioHref(workspaceId, data)} className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"><div className="relative h-full min-h-40 overflow-hidden bg-muted">{data.output ? <SafeStudioImage key={data.output.mediaUrl} src={data.output.mediaUrl} /> : <div className="flex h-full items-center justify-center"><Sparkles className="h-8 w-8 text-muted-foreground" /></div>}<div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background/90 to-transparent px-5 pb-4 pt-10"><p className="line-clamp-2 break-words text-sm font-medium">{data.prompt || t('untitled')}</p><p className="mt-1 truncate text-xs text-muted-foreground">{t('created', { time: relativeTime(format, data.createdAt) })}</p></div></div></Link> : <div className="flex h-full items-end p-5"><p className="text-sm text-muted-foreground">{t('empty')}</p></div> })}
  />;
}

export function HomeAppLinks({ active, workspaceId }: { active: boolean; workspaceId?: string }) {
  const t = useTranslations('home');
  const { data: session, isPending } = authClient.useSession();
  const userId = isPending ? '' : session?.user.id || '';
  const emailFocus = useHomeEmailFocus(userId, active);
  const widgets = useHomeWorkspaceWidgets(workspaceId, active && Boolean(userId), { actorId: userId, emailEnabled: emailFocus.mode === 'legacy' });
  const visibleEmailFocus: HomeEmailFocusState = widgets.accessDenied ? { ...emailFocus, mode: 'unknown', error: true,
    focus: { ...emailFocus.focus, feed: null, items: [], error: { code: 'WORKSPACE_ACCESS_DENIED', status: 403 } },
    refresh: async () => { widgets.retry(); await emailFocus.refresh(); } } : emailFocus;

  return (
    <section aria-labelledby="home-workspaces-heading" className="flex h-full min-h-0 flex-col">
      <div className="mb-5 flex shrink-0 flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('workspaceWidgets.eyebrow')}</p>
          <h2 id="home-workspaces-heading" className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{t('sections.workspace')}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('pages.workspaceDescription')}</p>
        </div>
        <Link href="/plugins" className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Puzzle className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t('apps.plugins.title')}
          <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </Link>
      </div>
      {workspaceId ? <HomeWidgetGrid identity={`${userId}:${workspaceId}`}>
        <HomeEmailWidget state={widgets.emails} onRetry={() => widgets.retry('emails')} emailFocus={visibleEmailFocus} identity={`${userId}:${workspaceId}:${visibleEmailFocus.mode}`} />
        <TodoWidget state={widgets.todos} workspaceId={workspaceId} onRetry={() => widgets.retry('todos')} />
        <StudioWidget state={widgets.studio} workspaceId={workspaceId} onRetry={() => widgets.retry('studio')} />
        <AutomationWidget state={widgets.automation} onRetry={() => widgets.retry('automation')} />
      </HomeWidgetGrid> : <div className="grid flex-1 gap-4 md:grid-cols-2 lg:grid-rows-2">{Array.from({ length: 4 }, (_, index) => <div key={index} className="min-h-64 animate-pulse rounded-xl border border-border bg-muted/40" />)}</div>}
    </section>
  );
}
