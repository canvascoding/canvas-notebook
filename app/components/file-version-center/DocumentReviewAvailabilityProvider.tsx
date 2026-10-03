'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { authClient } from '@/app/lib/auth-client';
import type { DocumentReviewAvailability } from '@/app/lib/document-review-availability';
import { LiveEventSource } from '@/app/lib/live-events/client';
import { closeVersionCenter } from '@/app/store/file-version-center-store';
import { closeWorkspaceOperationReview } from '@/app/store/workspace-operation-review-store';

type ReviewAvailabilityContext = DocumentReviewAvailability & {
  ready: boolean;
  applyAvailability: (state: DocumentReviewAvailability) => void;
};

export const DocumentReviewAvailabilityContext = createContext<ReviewAvailabilityContext>({
  documentReviewEnabled: false,
  updatedAt: null,
  ready: false,
  applyAvailability: () => {},
});

export function DocumentReviewAvailabilityProvider({ children }: { children: ReactNode }) {
  const { data: session } = authClient.useSession();
  const userId = session?.user.id ?? null;
  const [snapshot, setSnapshot] = useState({ userId: null as string | null,
    documentReviewEnabled: false, updatedAt: null as string | null, ready: false });
  const applyAvailability = useCallback((state: DocumentReviewAvailability) => {
    setSnapshot(previous => {
      if (previous.userId === userId && previous.updatedAt && state.updatedAt
        && Date.parse(state.updatedAt) < Date.parse(previous.updatedAt)) return previous;
      return { userId, documentReviewEnabled: state.documentReviewEnabled === true,
        updatedAt: state.updatedAt, ready: true };
    });
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    let disposed = false;
    const source = new LiveEventSource('/api/document-review/availability?stream=1');
    source.onmessage = event => {
      if (disposed) return;
      try {
        const state = JSON.parse(event.data) as DocumentReviewAvailability;
        if (typeof state.documentReviewEnabled !== 'boolean'
          || (state.updatedAt !== null && typeof state.updatedAt !== 'string')) {
          throw new Error('Invalid document review availability');
        }
        applyAvailability(state);
      } catch {
        setSnapshot({ userId, documentReviewEnabled: false, updatedAt: null, ready: false });
      }
    };
    source.onerror = () => {
      if (!disposed) setSnapshot(previous => ({ ...previous, userId, ready: false }));
    };
    return () => { disposed = true; source.close(); };
  }, [applyAvailability, userId]);

  const ready = Boolean(userId && snapshot.userId === userId && snapshot.ready);
  useEffect(() => {
    if (!ready) return;
    if (!snapshot.documentReviewEnabled) {
      closeVersionCenter({ syncLocation: false });
      closeWorkspaceOperationReview();
    }
    window.dispatchEvent(new CustomEvent('notification_summary_updated'));
  }, [ready, snapshot.documentReviewEnabled, snapshot.updatedAt]);
  return <DocumentReviewAvailabilityContext.Provider value={{ documentReviewEnabled: ready && snapshot.documentReviewEnabled,
    updatedAt: ready ? snapshot.updatedAt : null, ready, applyAvailability }}>
    {children}
  </DocumentReviewAvailabilityContext.Provider>;
}

export function useDocumentReviewAvailability() {
  return useContext(DocumentReviewAvailabilityContext);
}
