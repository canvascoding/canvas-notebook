'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Bell, Check, CheckCircle2, Circle, Clock3, MessageSquare, ListTodo } from 'lucide-react';

import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import type { DefaultTodoCategoryKey } from '@/app/lib/todos/default-categories';

type NotificationSummary = {
  unreadCount: number;
  sessions: {
    unreadCount: number;
    items: Array<{
      sessionId: string;
      title: string;
      agentId: string;
      lastMessageAt: string | null;
    }>;
  };
  todos: {
    unreadCount: number;
    dueCount: number;
    items: Array<{
      id: string;
      title: string;
      priority: 'low' | 'normal' | 'high';
      dueAt: string | null;
      seenAt: string | null;
      categoryName: string | null;
      categoryKey: DefaultTodoCategoryKey | null;
      isDue: boolean;
    }>;
  };
};

type ApiResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

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

async function readSummary(): Promise<NotificationSummary> {
  const response = await fetch('/api/notifications/summary', {
    credentials: 'include',
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => null) as ApiResponse<NotificationSummary> | null;
  if (!response.ok || !payload?.success || !payload.data) {
    throw new Error(payload?.error || 'Failed to load notifications.');
  }
  return payload.data;
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
      setSummary(await readSummary());
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
                    onClick={() => setOpen(false)}
                  >
                    <Link href={`/notebook?chat=open&session=${encodeURIComponent(session.sessionId)}`}>
                      <MessageSquare className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{session.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {formatDate(session.lastMessageAt, locale) ?? t('sessions.newResponse')}
                        </span>
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
                      href={`/todos?todo=${encodeURIComponent(todo.id)}`}
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
