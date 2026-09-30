'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { openWorkspaceOperationNotificationTarget } from '@/app/components/notifications/notification-actions';
import type { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';

/** Consume a review link after workspace hydration; the detail API checks access again. */
export function useWorkspaceOperationReviewNavigation(authScope: ReturnType<typeof openedDocumentAuthScope>): void {
  const t = useTranslations('notifications');
  useEffect(() => {
    if (!authScope) return;
    let disposed = false;
    let opening = false;
    const open = async () => {
      const url = new URL(window.location.href);
      const reviewId = url.searchParams.get('workspaceOperationReview');
      const workspaceId = url.searchParams.get('workspaceId');
      if (!reviewId || !workspaceId || opening) return;
      opening = true;
      const opened = await openWorkspaceOperationNotificationTarget({ reviewId, workspaceId });
      if (disposed) return;
      opening = false;
      if (!opened) { toast.error(t('fileOperations.openFailed')); return; }
      if (window.location.href === url.href) {
        url.searchParams.delete('workspaceOperationReview');
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      }
    };
    void open();
    window.addEventListener('popstate', open);
    return () => { disposed = true; window.removeEventListener('popstate', open); };
  }, [authScope, t]);
}
