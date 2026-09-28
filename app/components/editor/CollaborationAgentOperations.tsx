'use client';

import { useCallback, useEffect, useRef } from 'react';

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
  const reviewOperations = operations.filter((operation) => REVIEW_STATUSES.has(operation.operationStatus)
    && (operation.proposalLifecycle === undefined || operation.proposalLifecycle === 'open'));
  return {
    reviewCount: reviewOperations.length,
    conflictCount: reviewOperations.filter((operation) => CONFLICT_STATUSES.has(operation.operationStatus)).length,
    activeCount: operations.filter((operation) => ACTIVE_STATUSES.has(operation.operationStatus)).length,
    // Only the sole review may be selected automatically; multiple reviews require an explicit choice.
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
    ...(input.summary.reviewCount === 1 && input.summary.latestReviewOperationId ? {
      selectedEntry: { kind: 'agent_operation' as const, id: input.summary.latestReviewOperationId },
    } : {}),
    initialView: input.summary.reviewCount > 0 ? 'reviews' : 'history',
    source: 'editor',
  };
}

interface CollaborationAgentOperationsProps {
  documentId: string;
  workspaceId: string | null;
  onOperationsChange?: (operations: AgentOperation[]) => void;
}

/**
 * Headless editor observer for agent-authored document changes. The visible entry
 * lives in the combined versions-and-changes control.
 */
export function CollaborationAgentOperations({
  documentId,
  onOperationsChange,
}: CollaborationAgentOperationsProps) {
  const loadSequence = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++loadSequence.current;
    const nextOperations = await loadCollaborationAgentOperations({
      documentId,
      headers: workspaceHeaders(),
      signal,
    });
    if (nextOperations === null || sequence !== loadSequence.current) return;

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

  return null;
}
