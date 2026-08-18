'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Circle, Clock3, Inbox, ListTodo, type LucideIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Link } from '@/i18n/navigation';
import type { NotificationItem, NotificationSummary } from '@/app/components/notifications/notification-summary';

type EmailAccount = {
  id: string;
  emailAddress: string;
  isPrimary?: boolean;
};

type EmailFolder = {
  path: string;
  role?: string;
};

type EmailMessage = {
  id: string;
  folder?: string;
  from?: string;
  subject?: string;
  date?: string;
  isRead?: boolean;
};

type ApiResponse<T> = {
  success: boolean;
  data?: T;
};

type TodoNotificationItem = NotificationItem & {
  type: 'todo.attention';
  target: { kind: 'todo'; todoId: string };
};

function isTodoNotification(item: NotificationItem): item is TodoNotificationItem {
  return item.type === 'todo.attention' && item.target.kind === 'todo';
}

function formatDate(value: string | null | undefined, locale: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(date);
}

function emailHref(message: EmailMessage, accountId: string) {
  const params = new URLSearchParams({ accountId, messageId: message.id });
  if (message.folder) params.set('folder', message.folder);
  return `/emails?${params.toString()}`;
}

function HomeCard({
  children,
  footer,
  title,
  icon: Icon,
}: {
  children: ReactNode;
  footer: ReactNode;
  title: string;
  icon: LucideIcon;
}) {
  return (
    <section className="border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-primary">
          <Icon className="h-4 w-4" />
        </span>
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      </div>
      <div className="divide-y divide-border px-2">{children}</div>
      <div className="border-t border-border">{footer}</div>
    </section>
  );
}

function HomeEmailFocusCard() {
  const t = useTranslations('home.focus.email');
  const locale = useLocale();
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [account, setAccount] = useState<EmailAccount | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'unavailable'>('loading');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const accountsResponse = await fetch('/api/email/accounts', { credentials: 'include', cache: 'no-store' });
      const accountsPayload = await accountsResponse.json() as ApiResponse<{ accounts?: EmailAccount[] }>;
      const accounts = accountsPayload.data?.accounts ?? [];
      const activeAccount = accounts.find((candidate) => candidate.isPrimary) ?? accounts[0] ?? null;
      if (!accountsResponse.ok || !accountsPayload.success || !activeAccount) {
        setAccount(null);
        setMessages([]);
        setState('empty');
        return;
      }

      const foldersResponse = await fetch(`/api/email/folders?accountId=${encodeURIComponent(activeAccount.id)}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const foldersPayload = await foldersResponse.json() as ApiResponse<{ folders?: EmailFolder[] }>;
      const inboxFolder = foldersPayload.data?.folders?.find((folder) => folder.role === 'inbox')?.path;
      const messagesResponse = await fetch('/api/email/messages/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          accountId: activeAccount.id,
          folder: inboxFolder,
          filter: 'unread',
          limit: 3,
        }),
      });
      const messagesPayload = await messagesResponse.json() as ApiResponse<{ messages?: EmailMessage[] }>;
      if (!foldersResponse.ok || !foldersPayload.success || !messagesResponse.ok || !messagesPayload.success) {
        setAccount(null);
        setMessages([]);
        setState('unavailable');
        return;
      }

      setAccount(activeAccount);
      setMessages((messagesPayload.data?.messages ?? []).filter((message) => message.isRead === false).slice(0, 3));
      setState('ready');
    } catch {
      setAccount(null);
      setMessages([]);
      setState('unavailable');
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void load();
    }, 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 60_000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [load]);

  return (
    <HomeCard
      icon={Inbox}
      title={t('title')}
      footer={<Link href="/emails" className="flex items-center justify-between px-4 py-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">{t('openAll')}<span aria-hidden="true">→</span></Link>}
    >
      {state === 'loading' ? (
        <p className="px-2 py-5 text-sm text-muted-foreground">{t('loading')}</p>
      ) : state === 'empty' ? (
        <p className="px-2 py-5 text-sm text-muted-foreground">{t('empty')}</p>
      ) : state === 'unavailable' ? (
        <p className="px-2 py-5 text-sm text-muted-foreground">{t('unavailable')}</p>
      ) : messages.length === 0 ? (
        <p className="px-2 py-5 text-sm text-muted-foreground">{t('allRead')}</p>
      ) : messages.map((message) => (
        <Link key={message.id} href={emailHref(message, account!.id)} className="flex min-w-0 items-start gap-2.5 px-2 py-2.5 transition-colors hover:bg-accent">
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-label={t('unread')} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{message.from || t('unknownSender')}</span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">{message.subject || t('noSubject')}</span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatDate(message.date, locale)}</span>
        </Link>
      ))}
    </HomeCard>
  );
}

function HomeTodoFocusCard({ summary }: { summary: NotificationSummary | null }) {
  const t = useTranslations('home.focus.todos');
  const locale = useLocale();
  const items = summary?.items.filter(isTodoNotification).slice(0, 3) ?? [];

  return (
    <HomeCard
      icon={ListTodo}
      title={t('title')}
      footer={<Link href="/todos" className="flex items-center justify-between px-4 py-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">{t('openAll')}<span aria-hidden="true">→</span></Link>}
    >
      {!summary ? (
        <p className="px-2 py-5 text-sm text-muted-foreground">{t('loading')}</p>
      ) : items.length === 0 ? (
        <p className="px-2 py-5 text-sm text-muted-foreground">{t('empty')}</p>
      ) : items.map((todo) => (
        <Link
          key={todo.id}
          href={`/todos?todo=${encodeURIComponent(todo.target.todoId)}${todo.workspaceId ? `&workspaceId=${encodeURIComponent(todo.workspaceId)}` : ''}`}
          className="flex min-w-0 items-start gap-2.5 px-2 py-2.5 transition-colors hover:bg-accent"
        >
          <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{todo.title}</span>
            <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              {todo.priority === 'high' ? <Clock3 className="h-3 w-3 text-destructive" /> : null}
              {todo.detail ?? (todo.priority === 'high' ? (formatDate(todo.occurredAt, locale) ?? t('due')) : t('unread'))}
            </span>
          </span>
        </Link>
      ))}
    </HomeCard>
  );
}

export function HomeFocusCards({ summary }: { summary: NotificationSummary | null }) {
  const t = useTranslations('home.focus');

  return (
    <section aria-labelledby="home-focus-heading">
      <h2 id="home-focus-heading" className="mb-3 text-xs font-bold tracking-[0.18em] text-muted-foreground uppercase">
        {t('title')}
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        <HomeEmailFocusCard />
        <HomeTodoFocusCard summary={summary} />
      </div>
    </section>
  );
}
