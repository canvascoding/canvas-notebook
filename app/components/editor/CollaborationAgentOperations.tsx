'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  loadCollaborationAgentOperations,
  type CollaborationAgentOperation as AgentOperation,
  type CollaborationAgentOperationStatus as OperationStatus,
} from '@/app/lib/collaboration/agent-operations-client';
import {
  FILE_VERSION_CENTER_CONTRACT_VERSION,
  type FileVersionCenterRequestV1,
} from '@/app/lib/file-version-center/contracts/v1';
import { workspaceHeaders } from '@/app/lib/files/client';
import { openVersionCenter } from '@/app/store/file-version-center-store';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const REVIEW_STATUSES = new Set<OperationStatus>(['needs_review', 'partially_applied', 'semantic_conflict']);
const CONFLICT_STATUSES = new Set<OperationStatus>(['partially_applied', 'semantic_conflict']);
const ACTIVE_STATUSES = new Set<OperationStatus>([
  'preparing',
  'ready',
  'applying',
  'applied_to_ydoc',
  'cancel_requested',
]);

export type EditorAgentOperationSummary = {
  reviewCount: number;
  conflictCount: number;
  activeCount: number;
  latestReviewOperationId: string | null;
};

export function summarizeEditorAgentOperations(operations: AgentOperation[]): EditorAgentOperationSummary {
  const reviewOperations = operations.filter((operation) => REVIEW_STATUSES.has(operation.operationStatus));
  return {
    reviewCount: reviewOperations.length,
    conflictCount: reviewOperations.filter((operation) => CONFLICT_STATUSES.has(operation.operationStatus)).length,
    activeCount: operations.filter((operation) => ACTIVE_STATUSES.has(operation.operationStatus)).length,
    // The collaboration endpoint is ordered by updated_at DESC, so this is the newest open review.
    latestReviewOperationId: reviewOperations[0]?.operationId ?? null,
  };
}

export function buildEditorAgentVersionCenterRequest(input: {
  documentId: string;
  workspaceId: string;
  summary: EditorAgentOperationSummary;
}): FileVersionCenterRequestV1 {
  return {
    contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
    target: { kind: 'document', workspaceId: input.workspaceId, documentId: input.documentId },
    ...(input.summary.latestReviewOperationId ? {
      selectedEntry: { kind: 'agent_operation' as const, id: input.summary.latestReviewOperationId },
    } : {}),
    initialView: input.summary.latestReviewOperationId ? 'reviews' : 'history',
    source: 'editor',
  };
}

interface CollaborationAgentOperationsProps {
  documentId: string;
  workspaceId: string | null;
  onOperationsChange?: (operations: AgentOperation[]) => void;
}

/**
 * Editor status entry for agent-authored document changes. Mutating review actions
 * intentionally live only in the global version center.
 */
export function CollaborationAgentOperations({
  documentId,
  workspaceId,
  onOperationsChange,
}: CollaborationAgentOperationsProps) {
  const t = useTranslations('notebook.collaboration');
  const [operations, setOperations] = useState<AgentOperation[]>([]);
  const loadSequence = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++loadSequence.current;
    const nextOperations = await loadCollaborationAgentOperations({
      documentId,
      headers: workspaceHeaders(),
      signal,
    });
    if (nextOperations === null || sequence !== loadSequence.current) return;

    setOperations(nextOperations);
    onOperationsChange?.(nextOperations);
  }, [documentId, onOperationsChange]);

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

  const summary = useMemo(() => summarizeEditorAgentOperations(operations), [operations]);
  const attentionCount = summary.reviewCount + summary.activeCount;
  if (operations.length === 0 || !workspaceId) return null;

  const openReviewCenter = () => {
    openVersionCenter(buildEditorAgentVersionCenterRequest({ documentId, workspaceId, summary }));
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        'relative h-6 gap-1.5 px-1.5 text-xs text-muted-foreground 2xl:w-auto 2xl:px-2',
        summary.reviewCount > 0 && 'text-violet-700 dark:text-violet-300',
        summary.conflictCount > 0 && 'text-amber-700 dark:text-amber-300',
      )}
      aria-label={summary.conflictCount > 0
        ? t('agentOperationsConflictLabel', { count: summary.conflictCount })
        : summary.reviewCount > 0
          ? t('agentOperationsReviewLabel', { count: summary.reviewCount })
          : t('agentOperations')}
      onClick={openReviewCenter}
    >
      {summary.conflictCount > 0
        ? <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
        : <Bot className="h-3.5 w-3.5" aria-hidden="true" />}
      <span className="hidden 2xl:inline">{t('agentActivityShort')}</span>
      {attentionCount > 0 ? (
        <span
          className={cn(
            'flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white',
            summary.conflictCount > 0 ? 'bg-amber-600' : 'bg-violet-600',
          )}
          aria-hidden="true"
        >
          {attentionCount}
        </span>
      ) : null}
    </Button>
  );
}
