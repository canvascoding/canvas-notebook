'use client';

import { useState } from 'react';
import { Bell, Check, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from '@/components/ui/sheet';
import type { NotificationItem, NotificationSummary } from '@/app/components/notifications/notification-summary';
import { homeNotificationItems, updateNotification } from '@/app/components/notifications/notification-actions';
import { HomeNotificationRowsSkeleton } from './HomeSkeletons';
import { HomeNotificationItem } from './HomeNotificationItem';

export function HomeAttentionPanel({ summary, isLoading }: { summary: NotificationSummary | null; isLoading: boolean }) {
  const t = useTranslations('home.start');
  const tn = useTranslations('notifications');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const items = homeNotificationItems(summary);
  const countLabel = isLoading ? tn('loading') : !summary ? t('notificationsFailed') : t('attentionCount', { count: items.length });

  const act = async (item: NotificationItem, dismiss = false) => {
    setPending(`${item.workspaceId}:${item.id}`);
    setError(false);
    try {
      await updateNotification({ action: dismiss ? 'dismiss_item' : 'mark_item_read', itemId: item.id, workspaceId: item.workspaceId });
    } catch {
      setError(true);
    } finally {
      setPending(null);
    }
  };

  const content = (all: boolean) => {
    if (isLoading) return <HomeNotificationRowsSkeleton />;
    if (!summary) return <div className="p-5"><Button variant="outline" size="sm" onClick={() => window.dispatchEvent(new CustomEvent('notification_summary_updated'))}>{t('retry')}</Button></div>;
    if (!items.length) return <div className="flex items-start gap-2 px-4 py-5"><Check className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><p className="text-sm text-muted-foreground">{t('noAttention')}</p></div>;
    return <ul className="px-2">{(all ? items : items.slice(0, 3)).map(item => (
      <HomeNotificationItem key={`${item.workspaceId}:${item.id}`} item={item} showActions={all} pending={pending !== null} onRead={() => void act(item)} onDismiss={() => void act(item, true)} />
    ))}</ul>;
  };

  return (
    <Sheet>
      <aside className="min-w-0 self-start rounded-xl border border-border bg-card" aria-labelledby="home-attention-heading">
        <div className="flex h-18 items-center gap-3 px-4">
          <Bell className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h2 id="home-attention-heading" className="text-sm font-semibold">{t('notifications')}</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={countLabel}>{countLabel}</p>
          </div>
          <SheetTrigger asChild><Button variant="ghost" size="icon" className="shrink-0 lg:hidden" aria-label={t('showNotifications')}><ChevronRight className="h-4 w-4" /></Button></SheetTrigger>
        </div>
        <div className="hidden lg:block">
          <div id="home-attention-items" className="h-84 border-t border-border" aria-busy={isLoading}>{content(false)}</div>
          <div className="border-t border-border p-2">
            <SheetTrigger asChild><Button variant="ghost" size="sm" className="h-9 w-full justify-between text-xs">{t('allNotifications')}<ChevronRight className="h-3.5 w-3.5" /></Button></SheetTrigger>
          </div>
        </div>
      </aside>
      <SheetContent className="w-full gap-0 sm:max-w-lg motion-reduce:animate-none motion-reduce:transition-none">
        <SheetHeader className="shrink-0 border-b border-border pr-12">
          <SheetTitle>{t('notifications')}</SheetTitle>
          <SheetDescription>{countLabel}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-busy={isLoading}>
          {content(true)}
        </div>
        {error ? <p role="alert" className="shrink-0 border-t border-border p-4 text-xs text-destructive">{t('notificationActionFailed')}</p> : null}
      </SheetContent>
    </Sheet>
  );
}
