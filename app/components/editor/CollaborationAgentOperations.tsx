'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  CheckCircle2,
  Clock3,
  History,
  Loader2,
  RotateCcw,
  ShieldAlert,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import {
  loadCollaborationAgentOperations,
  type CollaborationAgentOperation as AgentOperation,
  type CollaborationAgentOperationStatus as OperationStatus,
} from '@/app/lib/collaboration/agent-operations-client';
import { workspaceHeaders } from '@/app/lib/files/client';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

const REVIEW_STATUSES = new Set<OperationStatus>(['needs_review', 'partially_applied', 'semantic_conflict']);
const ACTIVE_STATUSES = new Set<OperationStatus>([
  'preparing',
  'ready',
  'applying',
  'applied_to_ydoc',
  'persisted_yjs',
  'cancel_requested',
]);
const CANCELLABLE_STATUSES = new Set<OperationStatus>(['preparing', 'ready', 'applying', 'cancel_requested']);
const REVERTIBLE_STATUSES = new Set<OperationStatus>(['checkpointed_file', 'partially_applied', 'semantic_conflict']);

function operationAttribution(
  operation: AgentOperation,
  t: ReturnType<typeof useTranslations<'notebook.collaboration'>>,
) {
  return operation.initiatedByCurrentUser !== false
    ? t('agentAttribution', { agent: operation.actorId })
    : t('agentAttributionOther', {
        agent: operation.actorId,
        user: operation.initiatedByDisplayName || t('agentUnknownUser'),
      });
}

interface CollaborationAgentOperationsProps {
  documentId: string;
  onOperationsChange?: (operations: AgentOperation[]) => void;
}

export function CollaborationAgentOperations({
  documentId,
  onOperationsChange,
}: CollaborationAgentOperationsProps) {
  const t = useTranslations('notebook.collaboration');
  const [operations, setOperations] = useState<AgentOperation[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const actionKeys = useRef(new Map<string, string>());
  const previousStatuses = useRef(new Map<string, OperationStatus>());
  const hasLoaded = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const nextOperations = await loadCollaborationAgentOperations({
      documentId,
      headers: workspaceHeaders(),
      signal,
    });
    if (nextOperations === null) return;

    if (hasLoaded.current) {
      for (const operation of nextOperations) {
        const previousStatus = previousStatuses.current.get(operation.operationId);
        if (
          previousStatus
          && previousStatus !== 'checkpointed_file'
          && operation.operationStatus === 'checkpointed_file'
          && operation.initiatedByCurrentUser !== false
        ) {
          toast.success(t('agentCheckpointedToast'));
        }
      }
    }

    hasLoaded.current = true;
    previousStatuses.current = new Map(
      nextOperations.map((operation) => [operation.operationId, operation.operationStatus]),
    );
    setOperations(nextOperations);
    onOperationsChange?.(nextOperations);
  }, [documentId, onOperationsChange, t]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let timeout: number | undefined;
    const poll = async () => {
      await load(controller.signal);
      if (!disposed) timeout = window.setTimeout(() => void poll(), open ? 2_000 : 5_000);
    };
    void poll();
    return () => {
      disposed = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      controller.abort();
    };
  }, [load, open]);

  const reviewOperations = useMemo(
    () => operations.filter((operation) => REVIEW_STATUSES.has(operation.operationStatus)),
    [operations],
  );
  const activeOperations = useMemo(
    () => operations.filter((operation) => ACTIVE_STATUSES.has(operation.operationStatus)),
    [operations],
  );
  const historyOperations = useMemo(
    () => operations.filter((operation) => !REVIEW_STATUSES.has(operation.operationStatus) && !ACTIVE_STATUSES.has(operation.operationStatus)),
    [operations],
  );

  const act = useCallback(async (operation: AgentOperation, action: 'accept' | 'reject' | 'cancel' | 'revert') => {
    if (!operation.actionsAllowed) return;
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

  if (operations.length === 0) return null;

  const attentionCount = reviewOperations.length + activeOperations.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'relative h-8 gap-1.5 px-2 text-xs text-muted-foreground',
            reviewOperations.length > 0 && 'text-amber-700 dark:text-amber-300',
          )}
          aria-label={t('agentOperations')}
        >
          <Bot className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">{t('agentActivityShort')}</span>
          {attentionCount > 0 ? (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-violet-600 px-1 text-[10px] font-semibold text-white">
              {attentionCount}
            </span>
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[min(92vw,42rem)] p-0"
        role="region"
        aria-label={t('agentOperations')}
      >
        <div className="border-b px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Bot className="h-4 w-4 text-violet-600" aria-hidden="true" />
            {t('agentOperations')}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('agentOperationsDescription')}</p>
        </div>
        <Tabs defaultValue={reviewOperations.length > 0 ? 'review' : 'activity'} className="gap-0">
          <TabsList className="mx-4 mt-3 grid w-[calc(100%-2rem)] grid-cols-2">
            <TabsTrigger value="review" className="gap-1.5 text-xs">
              <ShieldAlert className="h-3.5 w-3.5" />
              {t('agentReviewTab')}
              {reviewOperations.length > 0 ? ` (${reviewOperations.length})` : ''}
            </TabsTrigger>
            <TabsTrigger value="activity" className="gap-1.5 text-xs">
              <History className="h-3.5 w-3.5" />
              {t('agentActivityTab')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="review" className="m-0">
            <ScrollArea className="h-[min(65vh,30rem)]">
              <div className="space-y-3 p-4">
                {reviewOperations.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
                    <CheckCircle2 className="mx-auto mb-2 h-5 w-5 text-emerald-600" aria-hidden="true" />
                    {t('agentNoReview')}
                  </div>
                ) : reviewOperations.map((operation) => (
                  <ReviewOperationCard
                    key={operation.operationId}
                    operation={operation}
                    busyAction={busyAction}
                    onAction={act}
                    t={t}
                  />
                ))}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="activity" className="m-0">
            <ScrollArea className="h-[min(65vh,30rem)]">
              <div className="space-y-4 p-4">
                {activeOperations.length > 0 ? (
                  <section aria-label={t('agentActiveChanges')}>
                    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('agentActiveChanges')}
                    </h3>
                    <div className="space-y-2">
                      {activeOperations.map((operation) => (
                        <ActivityOperationRow
                          key={operation.operationId}
                          operation={operation}
                          busyAction={busyAction}
                          onAction={act}
                          t={t}
                        />
                      ))}
                    </div>
                  </section>
                ) : null}
                <section aria-label={t('agentHistory')}>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('agentHistory')}
                  </h3>
                  <div className="space-y-2">
                    {historyOperations.length === 0 ? (
                      <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                        {t('agentNoHistory')}
                      </p>
                    ) : historyOperations.map((operation) => (
                      <ActivityOperationRow
                        key={operation.operationId}
                        operation={operation}
                        busyAction={busyAction}
                        onAction={act}
                        t={t}
                      />
                    ))}
                  </div>
                </section>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}

interface OperationCardProps {
  operation: AgentOperation;
  busyAction: string | null;
  onAction: (operation: AgentOperation, action: 'accept' | 'reject' | 'cancel' | 'revert') => Promise<void>;
  t: ReturnType<typeof useTranslations<'notebook.collaboration'>>;
}

function ReviewOperationCard({ operation, busyAction, onAction, t }: OperationCardProps) {
  const isBusy = busyAction?.startsWith(`${operation.operationId}:`) || false;
  const canAccept = operation.actionsAllowed
    && (operation.operationStatus === 'needs_review' || operation.operationStatus === 'partially_applied');
  const canReject = operation.actionsAllowed
    && (operation.operationStatus === 'needs_review' || operation.operationStatus === 'semantic_conflict');

  return (
    <article className="overflow-hidden rounded-lg border bg-background shadow-sm">
      <div className="border-b bg-muted/30 px-3 py-2.5">
        <p className="text-xs font-semibold">{t(`agentStatus_${operation.operationStatus}`)}</p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{operationAttribution(operation, t)}</p>
      </div>
      <div className="space-y-2 p-3">
        {operation.reviewTargets?.map((target) => (
          <div key={target.targetId} className="overflow-hidden rounded-md border">
            <div className="border-b bg-muted/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {target.groupId}
            </div>
            <div className="grid sm:grid-cols-2">
              <div className="border-b p-2 sm:border-b-0 sm:border-r">
                <p className="mb-1 text-[10px] font-medium text-muted-foreground">{t('agentCurrentVersion')}</p>
                <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
                  {target.currentText ?? t('agentTargetUnavailable')}
                </pre>
              </div>
              <div className="bg-violet-500/[0.06] p-2">
                <p className="mb-1 text-[10px] font-medium text-violet-700 dark:text-violet-300">{t('agentProposedVersion')}</p>
                <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
                  {target.proposedReplacement}
                </pre>
              </div>
            </div>
          </div>
        ))}
        {!operation.actionsAllowed ? (
          <p className="flex items-start gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-[11px] text-muted-foreground">
            <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            {t('agentActionsOwnerOnly')}
          </p>
        ) : null}
        {canAccept || canReject ? (
          <div className="flex justify-end gap-1.5 pt-1">
            {canReject ? (
              <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" disabled={isBusy} onClick={() => void onAction(operation, 'reject')}>
                <X className="h-3 w-3" />
                {t('agentReject')}
              </Button>
            ) : null}
            {canAccept ? (
              <Button size="sm" className="h-7 gap-1 px-2 text-xs" disabled={isBusy} onClick={() => void onAction(operation, 'accept')}>
                {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                {t('agentAccept')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ActivityOperationRow({ operation, busyAction, onAction, t }: OperationCardProps) {
  const isBusy = busyAction?.startsWith(`${operation.operationId}:`) || false;
  const canCancel = operation.actionsAllowed && CANCELLABLE_STATUSES.has(operation.operationStatus);
  const canRevert = operation.actionsAllowed
    && REVERTIBLE_STATUSES.has(operation.operationStatus)
    && operation.appliedTargetIds.length > 0;

  return (
    <article className="flex items-start gap-2 rounded-lg border px-3 py-2.5">
      {ACTIVE_STATUSES.has(operation.operationStatus) ? (
        <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-600" aria-hidden="true" />
      ) : (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{t(`agentStatus_${operation.operationStatus}`)}</p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{operationAttribution(operation, t)}</p>
      </div>
      {canCancel ? (
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={isBusy} onClick={() => void onAction(operation, 'cancel')}>
          {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : t('agentCancel')}
        </Button>
      ) : null}
      {canRevert ? (
        <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" disabled={isBusy} onClick={() => void onAction(operation, 'revert')}>
          {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
          {t('agentRevert')}
        </Button>
      ) : null}
    </article>
  );
}
