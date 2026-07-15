'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, Loader2, RotateCcw, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { workspaceHeaders } from '@/app/lib/files/client';
import { Button } from '@/components/ui/button';

type OperationStatus =
  | 'preparing'
  | 'ready'
  | 'applying'
  | 'applied_to_ydoc'
  | 'persisted_yjs'
  | 'checkpointed_file'
  | 'partially_applied'
  | 'needs_review'
  | 'semantic_conflict'
  | 'cancel_requested'
  | 'cancelled'
  | 'expired'
  | 'superseded'
  | 'failed'
  | 'rejected'
  | 'reverted';

type AgentOperation = {
  operationId: string;
  operationStatus: OperationStatus;
  status: 'applied_to_ydoc' | 'partially_applied' | 'needs_review' | 'semantic_conflict';
  durability: 'pending' | 'applied_to_ydoc' | 'persisted_yjs' | 'checkpointed_file' | 'needs_review';
  actorId: string;
  initiatedByDisplayName?: string;
  initiatedByCurrentUser?: boolean;
  appliedTargetIds: string[];
  conflicts: Array<{ targetId: string; groupId: string; code: string }>;
  reviewTargets?: Array<{
    targetId: string;
    groupId: string;
    proposedReplacement: string;
    currentText: string | null;
  }>;
};

const REVIEW_STATUSES = new Set<OperationStatus>(['needs_review', 'partially_applied', 'semantic_conflict']);
const CANCELLABLE_STATUSES = new Set<OperationStatus>(['preparing', 'ready', 'applying', 'cancel_requested']);
const REVERTIBLE_STATUSES = new Set<OperationStatus>(['checkpointed_file', 'partially_applied', 'semantic_conflict']);

export function CollaborationAgentOperations({ documentId }: { documentId: string }) {
  const t = useTranslations('notebook.collaboration');
  const [operations, setOperations] = useState<AgentOperation[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const actionKeys = useRef(new Map<string, string>());

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(
        `/api/files/collaboration/operations?documentId=${encodeURIComponent(documentId)}`,
        { headers: workspaceHeaders(), cache: 'no-store', signal },
      );
      if (!response.ok || signal?.aborted) return;
      const payload = await response.json() as { operations?: AgentOperation[] };
      if (!signal?.aborted) setOperations((payload.operations || []).slice(0, 5));
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      throw error;
    }
  }, [documentId]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let timeout: number | undefined;
    const poll = async () => {
      await load(controller.signal);
      if (!disposed) timeout = window.setTimeout(() => void poll(), 5_000);
    };
    void poll();
    return () => {
      disposed = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      controller.abort();
    };
  }, [load]);

  const visible = useMemo(() => operations.filter((operation, index) => (
    REVIEW_STATUSES.has(operation.operationStatus)
    || CANCELLABLE_STATUSES.has(operation.operationStatus)
    || (index === 0 && REVERTIBLE_STATUSES.has(operation.operationStatus))
  )), [operations]);

  const act = useCallback(async (operation: AgentOperation, action: 'accept' | 'reject' | 'cancel' | 'revert') => {
    const key = `${operation.operationId}:${action}`;
    const idempotencyKey = actionKeys.current.get(key) || crypto.randomUUID();
    actionKeys.current.set(key, idempotencyKey);
    setBusyAction(key);
    try {
      const response = await fetch(`/api/files/collaboration/operations/${encodeURIComponent(operation.operationId)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
        body: JSON.stringify({ idempotencyKey }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || t('agentActionFailed'));
      toast.success(t(`agentAction_${action}`));
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('agentActionFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [load, t]);

  if (visible.length === 0) return null;

  return (
    <section className="border-b border-violet-500/25 bg-violet-500/[0.06] px-3 py-2" aria-label={t('agentOperations')} aria-live="polite">
      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
        <Bot className="h-3.5 w-3.5 text-violet-500" aria-hidden="true" />
        {t('agentOperations')}
      </div>
      <div className="mt-1.5 space-y-1.5">
        {visible.map((operation) => {
          const isBusy = busyAction?.startsWith(`${operation.operationId}:`) || false;
          const canAccept = operation.operationStatus === 'needs_review' || operation.operationStatus === 'partially_applied';
          const canReject = operation.operationStatus === 'needs_review' || operation.operationStatus === 'semantic_conflict';
          return (
            <div key={operation.operationId} className="rounded border border-border bg-background/80 px-2.5 py-2 text-xs shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-medium">{t(`agentStatus_${operation.operationStatus}`)}</span>
                  <span className="ml-2 text-muted-foreground">
                    {operation.initiatedByCurrentUser !== false
                      ? t('agentAttribution', { agent: operation.actorId })
                      : t('agentAttributionOther', {
                          agent: operation.actorId,
                          user: operation.initiatedByDisplayName || '',
                        })}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {canAccept ? (
                    <Button size="sm" className="h-7 gap-1 px-2 text-xs" disabled={isBusy} onClick={() => void act(operation, 'accept')}>
                      {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      {t('agentAccept')}
                    </Button>
                  ) : null}
                  {canReject ? (
                    <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" disabled={isBusy} onClick={() => void act(operation, 'reject')}>
                      <X className="h-3 w-3" />
                      {t('agentReject')}
                    </Button>
                  ) : null}
                  {CANCELLABLE_STATUSES.has(operation.operationStatus) ? (
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={isBusy} onClick={() => void act(operation, 'cancel')}>
                      {t('agentCancel')}
                    </Button>
                  ) : null}
                  {REVERTIBLE_STATUSES.has(operation.operationStatus) && operation.appliedTargetIds.length > 0 ? (
                    <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" disabled={isBusy} onClick={() => void act(operation, 'revert')}>
                      <RotateCcw className="h-3 w-3" />
                      {t('agentRevert')}
                    </Button>
                  ) : null}
                </div>
              </div>
              {operation.reviewTargets?.length ? (
                <details className="mt-1.5 text-muted-foreground">
                  <summary className="cursor-pointer select-none font-medium text-foreground">{t('agentCompare')}</summary>
                  <div className="mt-1 grid gap-1.5 lg:grid-cols-2">
                    {operation.reviewTargets.map((target) => (
                      <div key={target.targetId} className="rounded bg-muted/60 p-2">
                        <div className="mb-1 text-[10px] uppercase tracking-wide">{target.groupId}</div>
                        <div className="grid gap-1 sm:grid-cols-2">
                          <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-background p-1.5">{target.currentText ?? t('agentTargetUnavailable')}</pre>
                          <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-violet-500/10 p-1.5">{target.proposedReplacement}</pre>
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
