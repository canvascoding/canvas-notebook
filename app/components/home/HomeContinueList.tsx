'use client';

import { useState } from 'react';
import { ArrowRight, ChevronDown, FileText, LayoutGrid, MessageSquare, Pin, Search, Star, X } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { notebookFileHref, type QuickAccessView } from '@/app/lib/files/quick-access';
import { getFileTitle } from '@/app/lib/files/metadata';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { buildNotebookChatSessionHref } from '@/app/lib/chat/chat-navigation-intent';
import { selectContinueItems, type ContinueFilter } from '@/app/lib/home/continue-items';
import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { AgentAvatar } from '@/app/components/agents/AgentAvatar';
import { HomeFileRowsSkeleton } from './HomeSkeletons';
import { useHomeContinue } from './useHomeContinue';

export function HomeContinueList({ workspace, workspaceError, revision }: { workspace?: ClientWorkspaceSummary; workspaceError?: string | null; revision: number }) {
  const t = useTranslations('home.continue');
  const tf = useTranslations('home.start');
  const format = useFormatter();
  const [filter, setFilter] = useState<ContinueFilter>('all');
  const [view, setView] = useState<QuickAccessView>('recent');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const result = useHomeContinue(workspace?.id, filter, filter === 'files' ? view : 'recent', query.trim(), revision);
  const items = selectContinueItems(result.files?.files ?? [], result.chats?.chats ?? [], filter, expanded ? 10 : 3);
  const hasMore = (result.files?.total ?? 0) + (result.chats?.chats.length ?? 0) > items.length || result.chats?.hasMore;
  const failed = result.filesFailed || result.chatsFailed;
  const emptyTitle = query.trim() ? (filter === 'files' ? tf('noResults') : t('noResults')) : filter === 'files' && view === 'favorites' ? tf('noFavorites') : t(filter === 'chats' ? 'noChats' : 'empty');
  const allChatsHref = `/notebook?${new URLSearchParams({ workspaceId: workspace?.id ?? '', chat: 'open', history: 'open' })}`;

  return <>
    <div className="relative mb-4">
      <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <Input disabled={!workspace} aria-label={t(`search.${filter}`)} placeholder={t(`search.${filter}`)} value={query} onChange={event => { setQuery(event.target.value); setExpanded(false); }} className="h-10 pl-9 pr-10" maxLength={256} />
      {query && <button type="button" onClick={() => setQuery('')} aria-label={tf('clearSearch')} className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-muted-foreground"><X className="h-4 w-4" /></button>}
    </div>
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
      <div className="flex gap-1" role="group" aria-label={t('filters')}>
        {(['all', 'files', 'chats'] as const).map(option => {
          const FilterIcon = option === 'all' ? LayoutGrid : option === 'files' ? FileText : MessageSquare;
          return <button key={option} type="button" disabled={!workspace} aria-pressed={filter === option} onClick={() => { setFilter(option); setExpanded(false); }} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${filter === option ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-accent'}`}><FilterIcon className="h-3.5 w-3.5" aria-hidden="true" />{t(option)}</button>;
        })}
      </div>
      {filter === 'files' && <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="sr-only">{tf('fileViews')}</span>
        <select aria-label={tf('fileViews')} value={view} onChange={event => { setView(event.target.value as QuickAccessView); setExpanded(false); }} className="max-w-44 rounded-md border border-border bg-background px-2 py-2 text-xs">
          {(['recent', 'favorites', 'frequent', 'all'] as const).map(option => <option key={option} value={option}>{tf(option)}</option>)}
        </select>
      </label>}
    </div>
    <div className="min-h-72 sm:min-h-60" aria-live="polite" aria-busy={!workspaceError && result.loading}>
      {workspaceError ? <div className="py-8 text-center"><p role="alert" className="mb-3 text-sm text-muted-foreground">{tf('workspaceFailed')}</p><Button variant="outline" size="sm" onClick={() => void useWorkspaceStore.getState().hydrateWorkspaces({ force: true })}>{tf('retry')}</Button></div> : result.loading ? <HomeFileRowsSkeleton count={3} /> : <>
        {items.length > 0 ? <ul className="divide-y divide-border/50">
          {items.map(item => {
            const file = item.kind === 'file' ? item.file : null;
            const chat = item.kind === 'chat' ? item.chat : null;
            const title = file ? getFileTitle({ ...file, type: 'file' }) : chat?.title || t('untitledChat');
            const href = file ? notebookFileHref(file.path, workspace!.id) : buildNotebookChatSessionHref(chat!.sessionId, workspace!.id);
            return <li key={item.key} data-kind={item.kind}>
              <Link href={href} className="group flex min-h-16 items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {file ? <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">{getFileIconComponent({ ...file, type: 'file' })}</span> : <AgentAvatar iconId={chat?.agentIconId} className="h-9 w-9 rounded-lg" iconClassName="h-5 w-5" />}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium"><span className="truncate">{title}</span>{file?.pinnedAt != null ? <Pin className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={tf('pinned')} /> : file?.isFavorite ? <Star className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={tf('favorites')} /> : null}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                    <span>{t(file ? 'file' : 'chat')}</span>
                    {item.activityAt > 0 && <><span aria-hidden="true">·</span><time dateTime={new Date(item.activityAt).toISOString()}>{t(file ? 'opened' : 'message', { time: format.relativeTime(new Date(item.activityAt), new Date()) })}</time></>}
                    {chat?.hasUnread && <span className="inline-flex items-center gap-1.5 text-primary"><span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />{t('newReply')}</span>}
                  </span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </Link>
            </li>;
          })}
        </ul> : !failed && <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-4 py-6 text-center"><FileText className="mb-1 h-6 w-6 text-muted-foreground" /><p className="text-sm font-medium">{emptyTitle}</p><p className="max-w-sm text-sm text-muted-foreground">{query.trim() ? t('searchHint') : filter === 'files' && view === 'favorites' ? tf('favoriteHint') : t('emptyHint')}</p></div>}
        {failed && <div role="status" className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 text-sm text-muted-foreground"><span>{t(result.filesFailed && result.chatsFailed ? 'failed' : result.chatsFailed ? 'chatsFailed' : 'filesFailed')}</span><Button variant="ghost" size="sm" onClick={result.retry}>{tf('retry')}</Button></div>}
        {hasMore && !expanded && <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => setExpanded(true)}>{t('showMore')}<ChevronDown className="h-4 w-4" /></Button>}
        {expanded && <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>{tf('showLess')}</Button><div className="flex flex-wrap gap-4 text-sm text-muted-foreground">{filter !== 'chats' && <Link href={`/files?${new URLSearchParams({ workspaceId: workspace!.id })}`} className="hover:underline">{t('allFiles')} →</Link>}{filter !== 'files' && <Link href={allChatsHref} className="hover:underline">{t('allChats')} →</Link>}</div></div>}
      </>}
    </div>
  </>;
}
