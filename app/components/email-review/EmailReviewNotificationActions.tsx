'use client';

import { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { NotificationItem } from '@/app/components/notifications/notification-summary';
import { emailReviewTargetFromNotification } from '@/app/components/notifications/notification-actions';
import { openEmailReview, rejectEmailReviewTarget, useEmailReviewStore } from '@/app/store/email-review-store';

export function EmailReviewNotificationActions({ item, surface, compact = false, onOpen }: {
  item: NotificationItem; surface: 'home' | 'notification'; compact?: boolean; onOpen?: () => void;
}) {
  const t = useTranslations('emailReview');
  const target = emailReviewTargetFromNotification(item);
  const [rejecting, setRejecting] = useState(false);
  const busy = useEmailReviewStore((state) => state.busy || state.loading);
  if (!target) return null;
  const reject = async () => {
    if (busy || rejecting) return;
    setRejecting(true);
    try { await rejectEmailReviewTarget(target); toast.success(t('rejected')); }
    catch (error) { toast.error(error instanceof Error ? error.message : t('rejectFailed')); }
    finally { setRejecting(false); }
  };
  return <span className="flex shrink-0 items-center gap-1">
    {!compact && <Button variant="ghost" size="sm" className="text-xs" disabled={busy} onClick={() => { onOpen?.(); void openEmailReview(target); }}>{t('review')}</Button>}
    <Button data-testid={`${surface}-email-reject-${target.draftId}`} variant="ghost" size={compact ? 'icon-xs' : 'sm'} className="text-xs text-muted-foreground" disabled={busy || rejecting} title={t('reject')} aria-label={t('reject')} onClick={(event) => { event.stopPropagation(); void reject(); }}>{rejecting ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}{!compact && t('reject')}</Button>
  </span>;
}
