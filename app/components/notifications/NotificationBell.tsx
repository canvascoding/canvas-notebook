'use client';

import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Bell, Check, CheckCircle2, Circle, Clock3, FolderKanban, MessageSquare, ListTodo } from 'lucide-react';

import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { buildChatSessionHref } from '@/app/lib/chat/chat-navigation-intent';
import { dispatchOpenChatSession } from '@/app/lib/chat/open-chat-session-event';
import { patchChatSessions } from '@/app/lib/chat/session-api';
import { readNotificationSummary, type NotificationSummary } from './notification-summary';

function formatBadgeCount(count: number) {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

function formatDate(value: string | null, locale: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(date);
}

export function NotificationBell() {
  const t = useTranslations('notifications');
  const tTodos = useTranslations('todos');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<NotificationSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isMutating, setIsMutating] = useState(false);

  const unreadCount = summary?.unreadCount ?? 0;
  const badgeLabel = useMemo(() => formatBadgeCount(unreadCount), [unreadCount]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      setSummary(await readNotificationSummary());
    } catch {
      setSummary(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => {
      void refresh();
    }, 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    }, 30_000);

    const handleUpdate = () => {
      window.setTimeout(() => void refresh(), 100);
    };
    window.addEventListener('session_updated', handleUpdate);
    window.addEventListener('todo_updated', handleUpdate);
    window.addEventListener('notification_summary_updated', handleUpdate);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
      window.removeEventListener('session_updated', handleUpdate);
      window.removeEventListener('todo_updated', handleUpdate);
      window.removeEventListener('notification_summary_updated', handleUpdate);
    };
  }, [refresh]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      void refresh();
    }
  }, [refresh]);

  const markAllTodosSeen = useCallback(async () => {
    setIsMutating(true);
    try {
      await fetch('/api/notifications/summary', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_all_todos_seen' }),
      });
      window.dispatchEvent(new CustomEvent('todo_updated'));
      await refresh();
    } finally {
      setIsMutating(false);
    }
  }, [refresh]);

  const markTodoSeen = useCallback(async (todoId: string) => {
    setIsMutating(true);
    try {
      await fetch('/api/notifications/summary', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_todo_seen', todoId }),
      });
      window.dispatchEvent(new CustomEvent('todo_updated'));
      await refresh();
    } finally {
      setIsMutating(false);
    }
  }, [refresh]);

  const completeTodo = useCallback(async (todoId: string) => {
    setIsMutating(true);
    try {
      await fetch(`/api/todos/${encodeURIComponent(todoId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done', markSeen: true }),
      });
      window.dispatchEvent(new CustomEvent('todo_updated'));
      await refresh();
    } finally {
      setIsMutating(false);
    }
  }, [refresh]);

  const markSessionRead = useCallback(async (session: NotificationSummary['sessions']['items'][number]) => {
    const data = await patchChatSessions({
      agentId: session.agentId,
      sessionId: session.sessionId,
      markAsRead: true,
    });

    if (!data?.success) {
      // A session can disappear after the notification summary was loaded. Refreshing
      // removes that stale entry while retaining real notifications after a failed request.
      await refresh();
      return;
    }

    setSummary((current) => {
      if (!current) return current;
      const items = current.sessions.items.filter((item) => item.sessionId !== session.sessionId);
      if (items.length === current.sessions.items.length) return current;
      return {
        ...current,
        unreadCount: Math.max(0, current.unreadCount - 1),
        sessions: {
          ...current.sessions,
          unreadCount: Math.max(0, current.sessions.unreadCount - 1),
          items,
        },
      };
    });
  }, [refresh]);

  const openSessionNotification = useCallback(async (
    event: MouseEvent<HTMLAnchorElement>,
    session: NotificationSummary['sessions']['items'][number],
  ) => {
    event.preventDefault();
    setOpen(false);
    setIsMutating(true);

    try {
      await markSessionRead(session);
    } finally {
      setIsMutating(false);
    }

    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const nextHref = buildChatSessionHref(currentHref, session.sessionId, session.workspaceId);
    if (nextHref !== currentHref) {
      window.history.pushState(
        { sessionId: session.sessionId, workspaceId: session.workspaceId, chat: 'open' },
        '',
        nextHref,
      );
    }
    if (dispatchOpenChatSession(session.sessionId, 'notification', session.workspaceId)) return;

    window.location.assign(buildChatSessionHref('/notebook', session.sessionId, session.workspaceId));
  }, [markSessionRead]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="notification-bell"
          className="relative inline-flex h-8 w-8 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={t('open', { count: unreadCount })}
        >
          <Bell className="h-4 w-4" />
          {badgeLabel ? (
            <span className={cn(
              'absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground',
              badgeLabel.length > 2 && 'min-w-6',
            )}>
              {badgeLabel}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[340px] p-0 sm:w-[380px]">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">{t('title')}</p>
            <p className="text-xs text-muted-foreground">
              {isLoading ? t('loading') : t('summary', {
                sessions: summary?.sessions.unreadCount ?? 0,
                todos: summary?.todos.unreadCount ?? 0,
              })}
            </p>
          </div>
          <Button asChild variant="ghost" size="sm" onClick={() => setOpen(false)}>
            <Link href="/todos">
              <ListTodo className="h-4 w-4" />
              {t('todos.open')}
            </Link>
          </Button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-2">
          {!summary || (summary.sessions.items.length === 0 && summary.todos.items.length === 0) ? (
            <div className="flex min-h-36 flex-col items-center justify-center px-4 text-center">
              <Check className="h-7 w-7 text-muted-foreground" />
              <p className="mt-2 text-sm font-medium">{t('empty.title')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('empty.description')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              <section className="space-y-1">
                <div className="flex items-center justify-between px-2">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    {t('sessions.title')}
                  </h3>
                  <span className="text-xs text-muted-foreground">{summary.sessions.unreadCount}</span>
                </div>
                {summary.sessions.items.length === 0 ? (
                  <p className="px-2 py-3 text-sm text-muted-foreground">{t('sessions.empty')}</p>
                ) : summary.sessions.items.map((session) => (
                  <Button
                    key={session.sessionId}
                    asChild
                    variant="ghost"
                    className="h-auto w-full justify-start px-2 py-2 text-left"
                  >
                    <Link
                      href={buildChatSessionHref('/notebook', session.sessionId, session.workspaceId)}
                      onClick={(event) => void openSessionNotification(event, session)}
                    >
                      <MessageSquare className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{session.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {formatDate(session.lastMessageAt, locale) ?? t('sessions.newResponse')}
                        </span>
                        {session.workspaceName ? (
                          <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                            <FolderKanban className="h-3 w-3 shrink-0" />
                            {t('sessions.workspace', { workspace: session.workspaceName })}
                          </span>
                        ) : null}
                      </span>
                    </Link>
                  </Button>
                ))}
              </section>

              <Separator />

              <section className="space-y-1">
                <div className="flex items-center justify-between gap-2 px-2">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    {t('todos.title')}
                  </h3>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={markAllTodosSeen}
                    disabled={isMutating || summary.todos.unreadCount === 0}
                  >
                    <Check className="h-3 w-3" />
                    {t('todos.markAllSeen')}
                  </Button>
                </div>
                {summary.todos.items.length === 0 ? (
                  <p className="px-2 py-3 text-sm text-muted-foreground">{t('todos.empty')}</p>
                ) : summary.todos.items.map((todo) => (
                  <div key={todo.id} className="flex items-start gap-2 rounded-md px-2 py-2 hover:bg-accent">
                    <Circle className={cn('mt-1 h-2.5 w-2.5 shrink-0', todo.seenAt ? 'text-muted-foreground' : 'fill-primary text-primary')} />
                    <Link
                      href={`/todos?todo=${encodeURIComponent(todo.id)}${todo.workspaceId ? `&workspaceId=${encodeURIComponent(todo.workspaceId)}` : ''}`}
                      className="min-w-0 flex-1"
                      onClick={() => setOpen(false)}
                    >
                      <span className="block truncate text-sm font-medium">{todo.title}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {todo.categoryKey ? <span>{tTodos(`defaultCategories.${todo.categoryKey}`)}</span> : todo.categoryName ? <span>{todo.categoryName}</span> : null}
                        {todo.isDue ? (
                          <span className="inline-flex items-center gap-1 text-destructive">
                            <Clock3 className="h-3 w-3" />
                            {formatDate(todo.dueAt, locale) ?? t('todos.due')}
                          </span>
                        ) : null}
                      </span>
                    </Link>
                    {!todo.seenAt ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => void markTodoSeen(todo.id)}
                        disabled={isMutating}
                        aria-label={t('todos.markSeen')}
                      >
                        <Check className="h-3 w-3" />
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => void completeTodo(todo.id)}
                      disabled={isMutating}
                      aria-label={t('todos.complete')}
                    >
                      <CheckCircle2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </section>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
