'use client';

import { useState } from 'react';
import { Bell, Check, ChevronDown, CircleAlert, ImageIcon, ListTodo, Mail, MessageSquare, Workflow, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import type { NotificationItem, NotificationSummary } from '@/app/components/notifications/notification-summary';
import { homeNotificationItems, notificationHref, updateNotification } from '@/app/components/notifications/notification-actions';

const ICONS = { chat: MessageSquare, todo: ListTodo, email: Mail, studio: ImageIcon, automation: Workflow };

export function HomeAttentionPanel({ summary, isLoading }: { summary: NotificationSummary | null; isLoading: boolean }) {
  const t = useTranslations('home.start');
  const tn = useTranslations('notifications');
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const items = homeNotificationItems(summary);
  const visible = expanded ? items : items.slice(0, 3);

  const act = async (item: NotificationItem, dismiss = false) => {
    setPending(item.id);
    setError(false);
    try {
      await updateNotification({ action: dismiss ? 'dismiss_item' : 'mark_item_read', itemId: item.id, workspaceId: item.workspaceId });
    } catch {
      setError(true);
    } finally {
      setPending(null);
    }
  };

  return (
    <aside className="min-w-0 rounded-xl border border-border bg-card lg:sticky lg:top-0 lg:col-start-2 lg:row-span-3 lg:row-start-1" aria-labelledby="home-attention-heading">
      <div className="flex items-center gap-3 px-4 py-4">
        <Bell className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 id="home-attention-heading" className="text-sm font-semibold">{t('notifications')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{isLoading ? tn('loading') : !summary ? t('notificationsFailed') : t('attentionCount', { count: items.length })}</p>
        </div>
        <button type="button" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent lg:hidden" aria-label={expanded ? t('showLess') : t('showNotifications')} aria-expanded={expanded} aria-controls="home-attention-items" onClick={() => setExpanded((value) => !value)}>
          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>
      <div id="home-attention-items" className={`${expanded ? 'block' : 'hidden lg:block'} border-t border-border`}>
        {!isLoading && !summary ? <div className="px-4 py-4"><Button variant="outline" size="sm" onClick={() => window.dispatchEvent(new CustomEvent('notification_summary_updated'))}>{t('retry')}</Button></div>
          : isLoading ? <p className="px-4 py-5 text-sm text-muted-foreground" role="status">{tn('loading')}</p>
          : items.length === 0 ? <div className="flex items-start gap-2 px-4 py-5"><Check className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><p className="text-sm text-muted-foreground">{t('noAttention')}</p></div>
          : <ul className="divide-y divide-border/60 px-2">
            {visible.map((item) => {
              const Icon = ICONS[item.target.kind];
              const dismissible = item.target.kind === 'studio' || item.target.kind === 'automation';
              return <li key={`${item.workspaceId}:${item.id}`} className="py-2">
                <Link href={notificationHref(item)} onClick={() => { if (item.unread) void act(item); }} className="flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-accent">
                  <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${item.priority === 'high' ? 'text-destructive' : 'text-muted-foreground'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-sm font-medium">{item.title}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{item.detail || tn(`types.${item.target.kind}`)}</span>
                    {item.workspaceName ? <span className="mt-1 block truncate text-xs text-muted-foreground">{item.workspaceName}</span> : null}
                  </span>
                  {item.priority === 'high' ? <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-label={tn('highPriority')} /> : null}
                </Link>
                {item.unread || dismissible ? <div className="flex flex-wrap justify-end gap-1 px-1">
                  {item.unread ? <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" disabled={pending !== null} onClick={() => void act(item)}><Check className="h-3 w-3" />{tn('markRead')}</Button> : null}
                  {dismissible ? <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" disabled={pending !== null} onClick={() => void act(item, true)}><X className="h-3 w-3" />{tn('dismiss')}</Button> : null}
                </div> : null}
              </li>;
            })}
          </ul>}
        {error ? <p role="alert" className="px-4 pb-3 text-xs text-destructive">{t('notificationActionFailed')}</p> : null}
        {items.length > 3 ? <div className="border-t border-border p-2"><Button variant="ghost" size="sm" className="w-full text-xs" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? t('showLess') : t('moreNotifications', { count: items.length - 3 })}<ChevronDown className={`h-3.5 w-3.5 ${expanded ? 'rotate-180' : ''}`} /></Button></div> : null}
      </div>
    </aside>
  );
}
