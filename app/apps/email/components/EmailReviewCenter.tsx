'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Layers3, ListChecks, PenLine, RefreshCw, UserRound } from 'lucide-react';
import type { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

import type { EmailOutboxDraft, WorkspaceInboxCase } from './email-client-types';

const ACTIONABLE_OUTBOX_STATUSES = new Set(['prepared', 'awaiting_review', 'editing', 'send_failed']);
const DISCLOSURE_KEY = 'canvas:email:review-center:v1';

type ReviewItem = {
  draft: EmailOutboxDraft;
  inboxCase: WorkspaceInboxCase | null;
  scope: 'personal' | 'workspace';
};

type EmailReviewCenterProps = {
  focusRequestKey?: string;
  onOpenPersonalDraft(draft: EmailOutboxDraft): void;
  onOpenWorkspaceDraft(draft: EmailOutboxDraft): void;
  refreshKey: number;
  t: ReturnType<typeof useTranslations>;
  workspaceId: string | null;
};

function formatReviewDate(value: string) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function reviewItemTitle(item: ReviewItem) {
  return item.inboxCase?.requesterName
    || item.inboxCase?.requesterAddress
    || item.draft.to[0]
    || item.draft.subject;
}

function readDisclosure() {
  try {
    return typeof window !== 'undefined' && window.sessionStorage.getItem(DISCLOSURE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDisclosure(isOpen: boolean) {
  try {
    window.sessionStorage.setItem(DISCLOSURE_KEY, isOpen ? '1' : '0');
  } catch {
    // The disclosure remains usable when browser storage is unavailable.
  }
}

export function EmailReviewCenter({
  focusRequestKey,
  onOpenPersonalDraft,
  onOpenWorkspaceDraft,
  refreshKey,
  t,
  workspaceId,
}: EmailReviewCenterProps) {
  const [personalDrafts, setPersonalDrafts] = useState<EmailOutboxDraft[]>([]);
  const [workspaceDrafts, setWorkspaceDrafts] = useState<EmailOutboxDraft[]>([]);
  const [inboxCases, setInboxCases] = useState<WorkspaceInboxCase[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const appliedFocusRequestRef = useRef<string | undefined>(undefined);
  const regionId = useId();

  useEffect(() => {
    const timeout = window.setTimeout(() => setIsExpanded(readDisclosure()), 0);
    return () => {
      window.clearTimeout(timeout);
      requestControllerRef.current?.abort();
    };
  }, []);

  const load = useCallback(async () => {
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setIsLoading(true);
    setError(null);
    try {
      const requests = [
        fetch('/api/email/outbox', { credentials: 'include', cache: 'no-store', signal: controller.signal }),
      ];
      if (workspaceId) {
        requests.push(
          fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/email/inbox`, { credentials: 'include', cache: 'no-store', signal: controller.signal }),
          fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/email/outbox`, { credentials: 'include', cache: 'no-store', signal: controller.signal }),
        );
      }
      const responses = await Promise.all(requests);
      const payloads = await Promise.all(responses.map((response) => response.json().catch(() => null)));
      if (requestControllerRef.current !== controller) return;
      const [personalResponse, inboxResponse, workspaceResponse] = responses;
      const [personalPayload, inboxPayload, workspacePayload] = payloads;
      if (personalResponse.ok && personalPayload?.success) {
        setPersonalDrafts(Array.isArray(personalPayload.data) ? personalPayload.data : []);
      }
      if (workspaceId && inboxResponse?.ok && inboxPayload?.success) {
        setInboxCases(Array.isArray(inboxPayload.data) ? inboxPayload.data : []);
      } else if (!workspaceId) {
        setInboxCases([]);
      }
      if (workspaceId && workspaceResponse?.ok && workspacePayload?.success) {
        setWorkspaceDrafts(Array.isArray(workspacePayload.data) ? workspacePayload.data : []);
      } else if (!workspaceId) {
        setWorkspaceDrafts([]);
      }
      if (responses.some((response, index) => !response.ok || !payloads[index]?.success)) {
        setError(t('workspaceQueue.loadError'));
      }
    } catch (loadError) {
      if (controller.signal.aborted || requestControllerRef.current !== controller) return;
      setError(loadError instanceof Error ? loadError.message : t('workspaceQueue.loadError'));
    } finally {
      if (requestControllerRef.current === controller) setIsLoading(false);
    }
  }, [t, workspaceId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [load, refreshKey]);

  useEffect(() => {
    if (!focusRequestKey || appliedFocusRequestRef.current === focusRequestKey) return;
    appliedFocusRequestRef.current = focusRequestKey;
    const timeout = window.setTimeout(() => {
      setIsExpanded(true);
      writeDisclosure(true);
      setQueueOpen(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [focusRequestKey]);

  const reviewItems = useMemo(() => {
    const inboxCaseById = new Map(inboxCases.map((item) => [item.id, item]));
    return [
      ...workspaceDrafts.map((draft): ReviewItem => ({
        draft,
        inboxCase: draft.inboxCaseId ? inboxCaseById.get(draft.inboxCaseId) || null : null,
        scope: 'workspace',
      })),
      ...personalDrafts.map((draft): ReviewItem => ({ draft, inboxCase: null, scope: 'personal' })),
    ]
      .filter((item) => ACTIONABLE_OUTBOX_STATUSES.has(item.draft.status || 'prepared'))
      .sort((left, right) => Date.parse(right.draft.updatedAt) - Date.parse(left.draft.updatedAt));
  }, [inboxCases, personalDrafts, workspaceDrafts]);

  const openItem = (item: ReviewItem) => {
    setQueueOpen(false);
    const draft = { ...item.draft, reviewCase: item.inboxCase };
    if (item.scope === 'workspace') onOpenWorkspaceDraft(draft);
    else onOpenPersonalDraft(draft);
  };
  const toggleExpanded = () => {
    setIsExpanded((current) => {
      const next = !current;
      writeDisclosure(next);
      return next;
    });
  };
  const nextItem = reviewItems[0] || null;

  return (
    <section className="shrink-0 overflow-hidden border border-primary/20 bg-card shadow-sm" aria-label={t('workspaceQueue.title')}>
      <div className="flex items-center gap-2 bg-primary/[0.035] px-3 py-2.5 sm:px-4">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={toggleExpanded} aria-controls={regionId} aria-expanded={isExpanded}>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm"><Layers3 className="h-4 w-4" /></div>
          <div className="min-w-0"><p className="text-sm font-semibold">{t('workspaceQueue.reviewTitle')}</p><p className="truncate text-xs text-muted-foreground">{isExpanded ? t('workspaceQueue.reviewSubtitle') : t('workspaceQueue.collapsedHint')}</p></div>
          <ChevronDown className={cn('ml-auto h-4 w-4 shrink-0 transition-transform', !isExpanded && '-rotate-90')} aria-hidden="true" />
        </button>
        <Badge variant={reviewItems.length > 0 ? 'default' : 'secondary'}>{t('workspaceQueue.remaining', { count: reviewItems.length })}</Badge>
        <Button type="button" size="sm" variant="ghost" onClick={() => void load()} disabled={isLoading} aria-label={t('refresh')} title={t('refresh')}><RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} /></Button>
      </div>

      {isExpanded && (
        <div id={regionId} className="border-t border-primary/10" aria-busy={isLoading}>
          {error && <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive sm:px-4">{error}</div>}
          {nextItem ? (
            <div className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-4">
              <button type="button" onClick={() => openItem(nextItem)} className="group min-w-0 rounded-xl border border-primary/20 bg-background px-3 py-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4">
                <div className="flex items-center justify-between gap-3"><span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">{t('workspaceQueue.nextUp')}</span><Badge variant="outline">{t(`workspaceQueue.${nextItem.scope === 'workspace' ? 'workspaceScope' : 'personalScope'}`)}</Badge></div>
                <div className="mt-2 flex min-w-0 items-start gap-3"><div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><UserRound className="h-3.5 w-3.5" /></div><div className="min-w-0"><p className="truncate text-sm font-medium">{reviewItemTitle(nextItem)}</p><p className="mt-0.5 truncate text-sm text-muted-foreground">{nextItem.draft.subject}</p><p className="mt-2 text-xs text-muted-foreground">{formatReviewDate(nextItem.draft.updatedAt)}</p></div></div>
              </button>
              <div className="flex flex-wrap gap-2 sm:flex-col sm:items-stretch"><Button type="button" onClick={() => openItem(nextItem)}><PenLine className="mr-2 h-4 w-4" />{t('workspaceQueue.reviewNext')}</Button><Button type="button" variant="outline" onClick={() => setQueueOpen(true)}><ListChecks className="mr-2 h-4 w-4" />{t('workspaceQueue.openQueue')}</Button></div>
            </div>
          ) : (
            <div className="flex min-h-20 items-center gap-3 px-4 py-4 text-sm text-muted-foreground"><div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted"><Check className="h-4 w-4" /></div><p>{t('workspaceQueue.emptyOutbox')}</p></div>
          )}
        </div>
      )}

      <Dialog open={queueOpen} onOpenChange={setQueueOpen}>
        <DialogContent className="max-h-[90dvh] max-w-3xl overflow-hidden p-0" layout="viewport">
          <DialogHeader className="border-b border-border px-4 py-4 sm:px-6"><DialogTitle>{t('workspaceQueue.fullQueueTitle')}</DialogTitle><DialogDescription>{t('workspaceQueue.fullQueueDescription')}</DialogDescription></DialogHeader>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4 sm:px-6">
            {reviewItems.map((item, index) => (
              <button type="button" key={`${item.scope}:${item.draft.id}`} onClick={() => openItem(item)} className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-3 text-left transition-colors hover:border-primary/45 hover:bg-primary/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">{index + 1}</span>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{reviewItemTitle(item)}</p><p className="mt-0.5 truncate text-xs text-muted-foreground">{item.draft.subject}</p></div>
                <div className="hidden shrink-0 text-right sm:block"><Badge variant="outline">{t(`workspaceQueue.${item.scope === 'workspace' ? 'workspaceScope' : 'personalScope'}`)}</Badge><p className="mt-1 text-[11px] text-muted-foreground">{formatReviewDate(item.draft.updatedAt)}</p></div>
              </button>
            ))}
            {reviewItems.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{t('workspaceQueue.emptyOutbox')}</p>}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
