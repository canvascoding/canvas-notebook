'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  Bell,
  Check,
  Circle,
  CircleAlert,
  FolderKanban,
  ImageIcon,
  ListTodo,
  Mail,
  MessageSquare,
  Workflow,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import { buildChatSessionHref } from '@/app/lib/chat/chat-navigation-intent';
import { notificationHref, updateNotification, type NotificationMutation } from './notification-actions';
import { dispatchOpenChatSession } from '@/app/lib/chat/open-chat-session-event';
import {
  readNotificationSummary,
  type NotificationItem,
  type NotificationSummary,
} from './notification-summary';

function formatBadgeCount(count: number) {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

function formatDate(value: string, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(date);
}

function notificationIcon(item: NotificationItem) {
  if (item.target.kind === 'chat') return MessageSquare;
  if (item.target.kind === 'todo') return ListTodo;
  if (item.target.kind === 'email') return Mail;
  if (item.target.kind === 'studio') return ImageIcon;
  return Workflow;
}

function isDismissible(item: NotificationItem) {
  return item.target.kind === 'studio' || item.target.kind === 'automation';
}

export function NotificationBell() {
  const t = useTranslations('notifications');
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

  const mutateInbox = useCallback(async (payload: NotificationMutation) => {
    await updateNotification(payload);
  }, []);

  const markAllRead = useCallback(async () => {
    setIsMutating(true);
    try {
      await mutateInbox({ action: 'mark_all_read' });
    } finally {
      setIsMutating(false);
      await refresh();
    }
  }, [mutateInbox, refresh]);

  const markItemRead = useCallback(async (item: NotificationItem) => {
    if (!item.unread) return;
    setIsMutating(true);
    try {
      await mutateInbox({
        action: 'mark_item_read',
        itemId: item.id,
        workspaceId: item.workspaceId,
      });
    } finally {
      setIsMutating(false);
      await refresh();
    }
  }, [mutateInbox, refresh]);

  const dismissItem = useCallback(async (item: NotificationItem) => {
    setIsMutating(true);
    try {
      await mutateInbox({
        action: 'dismiss_item',
        itemId: item.id,
        workspaceId: item.workspaceId,
      });
    } finally {
      setIsMutating(false);
      await refresh();
    }
  }, [mutateInbox, refresh]);

  const setTodoReadState = useCallback(async (item: NotificationItem, read: boolean) => {
    setIsMutating(true);
    try {
      await mutateInbox({
        action: 'set_item_read_state',
        itemId: item.id,
        workspaceId: item.workspaceId,
        read,
      });
    } finally {
      setIsMutating(false);
      await refresh();
    }
  }, [mutateInbox, refresh]);

  const openItem = useCallback(async (item: NotificationItem) => {
    setOpen(false);
    try {
      await markItemRead(item);
    } catch {
      // A session can disappear after the Inbox was loaded. The refresh above clears
      // the stale entry; navigation still gives the user a route to the related area.
    }

    if (item.target.kind !== 'chat') {
      window.location.assign(notificationHref(item));
      return;
    }

    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const nextHref = buildChatSessionHref(currentHref, item.target.sessionId, item.workspaceId);
    if (nextHref !== currentHref) {
      window.history.pushState(
        { sessionId: item.target.sessionId, workspaceId: item.workspaceId, chat: 'open' },
        '',
        nextHref,
      );
    }
    if (dispatchOpenChatSession(item.target.sessionId, 'notification', item.workspaceId)) return;
    window.location.assign(notificationHref(item));
  }, [markItemRead]);

  const notificationItems = summary?.sections.notifications ?? summary?.items.filter((item) => item.target.kind !== 'todo') ?? [];
  const todoItems = summary?.sections.todoAttention ?? summary?.sections.todos ?? summary?.items.filter((item) => item.target.kind === 'todo') ?? [];
  const emailItems = summary?.sections.emailAttention ?? summary?.items.filter((item) => item.target.kind === 'email') ?? [];

  const renderItem = (item: NotificationItem) => {
    const Icon = notificationIcon(item);
    const isTodo = item.target.kind === 'todo';
    return (
      <div key={`${item.workspaceId}:${item.id}`} className="group flex items-start gap-2 rounded-md px-2 py-2 hover:bg-accent">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          onClick={() => void openItem(item)}
        >
          <span className={cn(
            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm',
            item.priority === 'high' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
          )}>
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              {item.unread ? <Circle className="h-2 w-2 shrink-0 fill-primary text-primary" aria-label={t('unread')} /> : null}
              <span className="truncate text-sm font-medium">{item.title}</span>
              {item.priority === 'high' ? <CircleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label={t('highPriority')} /> : null}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {item.detail || t(`types.${item.target.kind}`)}
            </span>
            <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              <FolderKanban className="h-3 w-3 shrink-0" />
              <span className="truncate">{item.workspaceName || t('workspaceFallback')}</span>
              <span aria-hidden="true">·</span>
              <span>{formatDate(item.occurredAt, locale) || t('recent')}</span>
            </span>
          </span>
        </button>
        {isTodo && item.todoStatus === 'open' ? (
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            onClick={() => void setTodoReadState(item, item.unread)}
            disabled={isMutating}
            aria-label={item.unread ? t('markRead') : t('markUnread')}
          >
            {item.unread ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
          </Button>
        ) : null}
        {isDismissible(item) ? (
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => void dismissItem(item)}
            disabled={isMutating}
            aria-label={t('dismiss')}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
    );
  };

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
              {isLoading ? t('loading') : t('summary', { count: unreadCount })}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void markAllRead()}
            disabled={isMutating || unreadCount === 0}
          >
            <Check className="h-4 w-4" />
            {t('markAllRead')}
          </Button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-2">
          {!summary || (notificationItems.length === 0 && todoItems.length === 0 && emailItems.length === 0) ? (
            <div className="flex min-h-36 flex-col items-center justify-center px-4 text-center">
              <Check className="h-7 w-7 text-muted-foreground" />
              <p className="mt-2 text-sm font-medium">{t('empty.title')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('empty.description')}</p>
            </div>
          ) : (
            <div className="space-y-4">
              {notificationItems.length > 0 ? (
                <section aria-labelledby="notification-center-notifications">
                  <h3 id="notification-center-notifications" className="px-2 pb-1 text-xs font-semibold text-muted-foreground">{t('sections.notifications')}</h3>
                  <div className="space-y-1">{notificationItems.map(renderItem)}</div>
                </section>
              ) : null}
              {todoItems.length > 0 ? (
                <section aria-labelledby="notification-center-todos">
                  <h3 id="notification-center-todos" className="px-2 pb-1 text-xs font-semibold text-muted-foreground">{t('sections.todos')}</h3>
                  <div className="space-y-1">{todoItems.map(renderItem)}</div>
                  <Link href="/todos" className="mt-1 block px-2 py-1 text-xs font-medium text-primary hover:underline">{t('openTodos')}</Link>
                </section>
              ) : null}
              {emailItems.length > 0 ? (
                <section aria-labelledby="notification-center-email-review">
                  <h3 id="notification-center-email-review" className="px-2 pb-1 text-xs font-semibold text-muted-foreground">{t('sections.emailReview')}</h3>
                  <div className="space-y-1">{emailItems.map(renderItem)}</div>
                  <Link href="/emails" className="mt-1 block px-2 py-1 text-xs font-medium text-primary hover:underline">{t('openEmails')}</Link>
                </section>
              ) : null}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
