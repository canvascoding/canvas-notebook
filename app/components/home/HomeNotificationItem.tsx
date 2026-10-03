'use client';

import { BrainCircuit, Check, CircleAlert, FileClock, ImageIcon, KeyRound, ListTodo, Loader2, Mail, MessageSquare, PlugZap, Workflow, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import type { NotificationItem } from '@/app/components/notifications/notification-summary';
import {
  notificationHref,
  emailReviewTargetFromNotification,
  openFileChangeReviewNotification,
  openWorkspaceOperationNotificationTarget,
  openWorkspacePathOperationNotificationTarget,
  shouldMarkNotificationReadOnOpen,
} from '@/app/components/notifications/notification-actions';
import { openEmailReview } from '@/app/store/email-review-store';
import { EmailReviewNotificationActions } from '@/app/components/email-review/EmailReviewNotificationActions';
import { openMemoryReview } from '@/app/store/memory-review-store';
import { openTodoDetail } from '@/app/store/todo-detail-store';
import { isUnmodifiedPrimaryClick } from '@/app/lib/todos/navigation';
import { useDocumentReviewAvailability } from '@/app/components/file-version-center/DocumentReviewAvailabilityProvider';

const ICONS = {
  chat: MessageSquare,
  todo: ListTodo,
  email: Mail,
  studio: ImageIcon,
  automation: Workflow,
  memory: BrainCircuit,
  mcp: PlugZap,
  license: KeyRound,
  file_change: FileClock,
  file_operation: FileClock,
  file_path_operation: FileClock,
};

export function HomeNotificationItem({
  item,
  showActions,
  pending,
  onRead,
  onDismiss,
  onOpenFileChange,
  onMemoryDecision,
  memoryDecision,
  memoryTargets,
  onMemoryOpen,
}: {
  item: NotificationItem;
  showActions: boolean;
  pending: boolean;
  onRead: () => void;
  onDismiss: () => void;
  onOpenFileChange?: () => void;
  onMemoryDecision?: (decision: 'approve' | 'reject') => void;
  memoryDecision?: 'approve' | 'reject' | null;
  memoryTargets?: import('@/app/lib/memory/contract').MemoryReviewTarget[];
  onMemoryOpen?: () => void;
}) {
  const t = useTranslations('notifications');
  const reviewAvailability = useDocumentReviewAvailability();
  const reviewCenterEnabled = reviewAvailability.ready && reviewAvailability.documentReviewEnabled;
  const Icon = ICONS[item.target.kind];
  const dismissible = item.target.kind === 'studio' || item.target.kind === 'automation';
  const title = item.target.kind === 'file_change'
    ? t(`fileChanges.${item.fileChangeReason ?? 'needs_review'}.title`)
    : item.target.kind === 'file_operation'
      ? t(`fileOperations.${item.target.status}.title`, { action: t(`fileOperations.kind_${item.target.operationKind}`) })
    : item.target.kind === 'file_path_operation'
      ? t(`filePathOperations.${item.target.status}.title`, { action: t(`filePathOperations.kind_${item.target.operationKind}`) })
    : item.title;
  const typeLabel = item.target.kind === 'file_change'
    ? `${t(`fileChanges.${item.fileChangeReason ?? 'needs_review'}.detail`)}${item.workspaceName ? ` · ${item.workspaceName}` : ''}`
    : item.target.kind === 'file_operation'
      ? `${t(`fileOperations.${item.target.status}.detail`)}${item.workspaceName ? ` · ${item.workspaceName}` : ''}`
    : item.target.kind === 'file_path_operation'
      ? `${t(`filePathOperations.${item.target.status}.detail`)}${item.workspaceName ? ` · ${item.workspaceName}` : ''}`
    : `${t(`types.${item.target.kind}`)}${item.workspaceName ? ` · ${item.workspaceName}` : ''}`;
  const emailTarget = emailReviewTargetFromNotification(item);
  const isMemory = item.target.kind === 'memory';
  return (
    <li className="border-b border-border/60 last:border-0">
      <Link href={notificationHref(item)} data-testid={emailTarget ? `home-email-open-${emailTarget.draftId}` : undefined} onClick={(event) => {
        if (item.target.kind === 'todo') {
          if (!isUnmodifiedPrimaryClick(event)) return;
          event.preventDefault();
          openTodoDetail(item.target.todoId);
          return;
        }
        if (emailTarget) { event.preventDefault(); void openEmailReview(emailTarget); return; }
        if (item.target.kind === 'memory') {
          event.preventDefault();
          onMemoryOpen?.();
          if (item.unread) onRead();
          void openMemoryReview(item.target, memoryTargets);
          return;
        }
        if (item.target.kind === 'file_change') {
          event.preventDefault();
          onOpenFileChange?.();
          void openFileChangeReviewNotification(item, { reviewCenterEnabled }).then((opened) => {
            if (!opened) toast.error(t('fileChanges.openFailed'));
          });
          return;
        }
        if (item.target.kind === 'file_operation') {
          event.preventDefault();
          onOpenFileChange?.();
          if (item.workspaceId !== item.target.workspaceId) { toast.error(t('fileOperations.openFailed')); return; }
          void openWorkspaceOperationNotificationTarget(item.target, { reviewCenterEnabled }).then((opened) => {
            if (!opened) toast.error(t('fileOperations.openFailed'));
          });
          return;
        }
        if (item.target.kind === 'file_path_operation') {
          if (!isUnmodifiedPrimaryClick(event)) return;
          event.preventDefault();
          onOpenFileChange?.();
          if (item.workspaceId !== item.target.workspaceId) { toast.error(t('filePathOperations.openFailed')); return; }
          void openWorkspacePathOperationNotificationTarget(item.target).then((opened) => {
            if (!opened) toast.error(t('filePathOperations.openFailed'));
          });
          return;
        }
        if (item.unread && shouldMarkNotificationReadOnOpen(item)) onRead();
      }} className="flex min-h-[111px] items-start gap-2.5 rounded-lg px-2 py-5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${item.priority === 'high' ? 'text-destructive' : 'text-muted-foreground'}`} />
        <span className="min-w-0 flex-1">
          <span className={`${showActions ? '' : 'line-clamp-2'} text-sm font-medium`}>{title}</span>
          <span className="mt-1 block truncate text-xs text-muted-foreground">{typeLabel}</span>
          {showActions && item.detail && item.target.kind !== 'file_change' && item.target.kind !== 'file_path_operation' ? <span className="mt-2 block text-sm text-muted-foreground">{item.detail}</span> : null}
        </span>
        {item.priority === 'high' ? <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-label={t('highPriority')} /> : null}
      </Link>
      {emailTarget && <div className="flex justify-end px-2 pb-3"><EmailReviewNotificationActions item={item} surface="home" /></div>}
      {showActions && ((item.unread && item.target.kind !== 'todo') || dismissible || isMemory) ? <div className="flex flex-wrap justify-end gap-1 px-2 pb-3">
        {isMemory ? <>
          <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" disabled={Boolean(memoryDecision)} onClick={() => onMemoryDecision?.('reject')} aria-label={t('memoryReject')} title={t('memoryReject')}>{memoryDecision === 'reject' ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}{t('memoryReject')}</Button>
          <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" disabled={Boolean(memoryDecision)} onClick={() => onMemoryDecision?.('approve')} aria-label={t('memoryApprove')} title={t('memoryApprove')}>{memoryDecision === 'approve' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}{t('memoryApprove')}</Button>
        </> : null}
        {item.unread && item.target.kind !== 'todo' ? <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" disabled={pending} onClick={onRead}><Check className="h-3 w-3" />{t('markRead')}</Button> : null}
        {dismissible ? <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" disabled={pending} onClick={onDismiss}><X className="h-3 w-3" />{t('dismiss')}</Button> : null}
      </div> : null}
    </li>
  );
}
