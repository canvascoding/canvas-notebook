'use client';

import { Bell, CheckCircle2, Clock3, MessageSquare } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Link } from '@/i18n/navigation';
import { buildChatSessionHref } from '@/app/lib/chat/chat-navigation-intent';
import type { NotificationSummary } from '@/app/components/notifications/notification-summary';

type HomeAttentionPanelProps = {
  summary: NotificationSummary | null;
  isLoading: boolean;
};

function formatDate(value: string | null, locale: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(date);
}

export function HomeAttentionPanel({ summary, isLoading }: HomeAttentionPanelProps) {
  const t = useTranslations('home.focus.attention');
  const locale = useLocale();
  const sessionItems = summary?.sessions.items.slice(0, 3) ?? [];
  const todoItems = summary?.todos.items.filter((todo) => todo.isDue || !todo.seenAt).slice(0, 3) ?? [];
  const attentionCount = (summary?.sessions.unreadCount ?? 0) + todoItems.length;

  return (
    <aside className="hidden xl:sticky xl:top-6 xl:block xl:self-start" aria-label={t('title')}>
      <div className="border border-border bg-card shadow-sm">
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3.5">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Bell className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold tracking-tight">{t('title')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isLoading ? t('loading') : t('summary', { count: attentionCount })}
              </p>
            </div>
          </div>
          {attentionCount > 0 ? (
            <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
              {attentionCount > 99 ? '99+' : attentionCount}
            </span>
          ) : null}
        </div>

        <div className="divide-y divide-border">
          <section className="px-2 py-3" aria-labelledby="home-attention-sessions">
            <div className="flex items-center justify-between gap-3 px-2 pb-1.5">
              <h3 id="home-attention-sessions" className="text-[10px] font-bold tracking-[0.16em] text-muted-foreground uppercase">
                {t('sessions.title')}
              </h3>
              <span className="text-xs text-muted-foreground">{summary?.sessions.unreadCount ?? 0}</span>
            </div>
            {sessionItems.length === 0 ? (
              <p className="px-2 py-2 text-sm text-muted-foreground">{t('sessions.empty')}</p>
            ) : sessionItems.map((session) => (
              <Link
                key={session.sessionId}
                href={buildChatSessionHref('/notebook', session.sessionId, session.workspaceId)}
                className="flex items-start gap-2.5 px-2 py-2 transition-colors hover:bg-accent"
              >
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{session.title}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {formatDate(session.lastMessageAt, locale) ?? t('sessions.newResponse')}
                  </span>
                </span>
              </Link>
            ))}
          </section>

          <section className="px-2 py-3" aria-labelledby="home-attention-todos">
            <div className="flex items-center justify-between gap-3 px-2 pb-1.5">
              <h3 id="home-attention-todos" className="text-[10px] font-bold tracking-[0.16em] text-muted-foreground uppercase">
                {t('todos.title')}
              </h3>
              <span className="text-xs text-muted-foreground">{summary?.todos.dueCount ?? 0}</span>
            </div>
            {todoItems.length === 0 ? (
              <p className="px-2 py-2 text-sm text-muted-foreground">{t('todos.empty')}</p>
            ) : todoItems.map((todo) => (
              <Link
                key={todo.id}
                href={`/todos?todo=${encodeURIComponent(todo.id)}${todo.workspaceId ? `&workspaceId=${encodeURIComponent(todo.workspaceId)}` : ''}`}
                className="flex items-start gap-2.5 px-2 py-2 transition-colors hover:bg-accent"
              >
                {todo.isDue ? <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{todo.title}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {todo.isDue ? (formatDate(todo.dueAt, locale) ?? t('todos.due')) : t('todos.unread')}
                  </span>
                </span>
              </Link>
            ))}
          </section>
        </div>

      </div>
    </aside>
  );
}
