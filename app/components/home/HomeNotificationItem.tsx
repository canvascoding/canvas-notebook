'use client';

import { Check, CircleAlert, ImageIcon, ListTodo, Mail, MessageSquare, Workflow, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import type { NotificationItem } from '@/app/components/notifications/notification-summary';
import { notificationHref } from '@/app/components/notifications/notification-actions';

const ICONS = { chat: MessageSquare, todo: ListTodo, email: Mail, studio: ImageIcon, automation: Workflow };

export function HomeNotificationItem({ item, showActions, pending, onRead, onDismiss }: {
  item: NotificationItem;
  showActions: boolean;
  pending: boolean;
  onRead: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations('notifications');
  const Icon = ICONS[item.target.kind];
  const dismissible = item.target.kind === 'studio' || item.target.kind === 'automation';
  return (
    <li className="border-b border-border/60 last:border-0">
      <Link href={notificationHref(item)} onClick={() => { if (item.unread) onRead(); }} className="flex min-h-[111px] items-start gap-2.5 rounded-lg px-2 py-5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${item.priority === 'high' ? 'text-destructive' : 'text-muted-foreground'}`} />
        <span className="min-w-0 flex-1">
          <span className={`${showActions ? '' : 'line-clamp-2'} text-sm font-medium`}>{item.title}</span>
          <span className="mt-1 block truncate text-xs text-muted-foreground">{t(`types.${item.target.kind}`)}{item.workspaceName ? ` · ${item.workspaceName}` : ''}</span>
          {showActions && item.detail ? <span className="mt-2 block text-sm text-muted-foreground">{item.detail}</span> : null}
        </span>
        {item.priority === 'high' ? <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-label={t('highPriority')} /> : null}
      </Link>
      {showActions && (item.unread || dismissible) ? <div className="flex flex-wrap justify-end gap-1 px-2 pb-3">
        {item.unread ? <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" disabled={pending} onClick={onRead}><Check className="h-3 w-3" />{t('markRead')}</Button> : null}
        {dismissible ? <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" disabled={pending} onClick={onDismiss}><X className="h-3 w-3" />{t('dismiss')}</Button> : null}
      </div> : null}
    </li>
  );
}
