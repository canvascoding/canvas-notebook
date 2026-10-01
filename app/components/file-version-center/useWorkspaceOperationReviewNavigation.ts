'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { openWorkspaceOperationNotificationTarget } from '@/app/components/notifications/notification-actions';
import type { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';

/** Consume a review link after workspace hydration; the detail API checks access again. */
export function useWorkspaceOperationReviewNavigation(authScope: ReturnType<typeof openedDocumentAuthScope>): void {
  const t = useTranslations('notifications');
  const consumedTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!authScope) return;
    let disposed = false;
    let opening = false;
    const open = async () => {
      const url = new URL(window.location.href);
      const reviewId = url.searchParams.get('workspaceOperationReview');
      const workspaceId = url.searchParams.get('workspaceId');
      if (!reviewId || !workspaceId || opening) return;
      const targetKey = `${workspaceId}\0${reviewId}`;
      if (consumedTarget.current === targetKey) {
        url.searchParams.delete('workspaceOperationReview');
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
        return;
      }
      consumedTarget.current = targetKey;
      opening = true;
      // Hydration can change other query parameters or rerun this effect.
      // Consume this one-shot link before awaiting it, so a completed action
      // cannot reopen the original proposal over its successor's result.
      url.searchParams.delete('workspaceOperationReview');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      const opened = await openWorkspaceOperationNotificationTarget({ reviewId, workspaceId });
      opening = false;
      if (!opened) {
        if (consumedTarget.current === targetKey) consumedTarget.current = null;
        const current = new URL(window.location.href);
        if (current.searchParams.get('workspaceId') === workspaceId && !current.searchParams.has('workspaceOperationReview')) {
          current.searchParams.set('workspaceOperationReview', reviewId);
          window.history.replaceState(null, '', `${current.pathname}${current.search}${current.hash}`);
        }
        if (!disposed) toast.error(t('fileOperations.openFailed'));
      }
    };
    const fromHistory = () => { consumedTarget.current = null; void open(); };
    void open();
    window.addEventListener('popstate', fromHistory);
    return () => { disposed = true; window.removeEventListener('popstate', fromHistory); };
  }, [authScope, t]);
}
