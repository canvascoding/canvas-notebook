import type { WorkspaceOperationReviewKind } from './workspace-operation-review-contract';

export const WORKSPACE_OPERATION_NOTIFICATION_PREFIX = 'file-operation:';
export const WORKSPACE_OPERATION_ATTENTION_STATUSES = ['pending', 'queued', 'applying', 'blocked', 'stale', 'failed', 'needs_recovery'] as const;
export type WorkspaceOperationAttentionStatus = typeof WORKSPACE_OPERATION_ATTENTION_STATUSES[number];

export function isWorkspaceOperationNotificationDismissible(status: WorkspaceOperationAttentionStatus): boolean {
  return status === 'blocked' || status === 'stale' || status === 'failed' || status === 'needs_recovery';
}

export type WorkspaceOperationNotificationTarget = {
  kind: 'file_operation';
  workspaceId: string;
  reviewId: string;
  batchId?: string;
  operationKind: WorkspaceOperationReviewKind;
  status: WorkspaceOperationAttentionStatus;
};

export function workspaceOperationReviewHref(target: Pick<WorkspaceOperationNotificationTarget, 'workspaceId' | 'reviewId'>): string {
  return `/notebook?${new URLSearchParams({ workspaceId: target.workspaceId, workspaceOperationReview: target.reviewId })}`;
}

export const WORKSPACE_PATH_OPERATION_NOTIFICATION_PREFIX = 'file-path-operation:';
export const WORKSPACE_PATH_PROBLEM_NOTIFICATION_PREFIX = 'file-path-problem:';
export const WORKSPACE_PATH_PREPARATION_NOTIFICATION_PREFIX = 'file-path-preparation:';
export type WorkspacePathOperationAttentionStatus = 'pending' | 'queued' | 'applying' | 'blocked' | 'stale' | 'failed' | 'needs_recovery';
export type WorkspacePathOperationNotificationTarget = {
  kind: 'file_path_operation';
  workspaceId: string;
  operationKind: 'move' | 'rename' | 'delete';
  status: WorkspacePathOperationAttentionStatus;
} & ({ batchId: string; problemId?: never; preparationRequestId?: never }
  | { problemId: string; batchId?: never; preparationRequestId?: never }
  | { preparationRequestId: string; batchId?: never; problemId?: never });

export function workspacePathOperationHref(target: WorkspacePathOperationNotificationTarget): string {
  return `/notebook?${new URLSearchParams({ workspaceId: target.workspaceId,
    ...(target.preparationRequestId !== undefined ? { workspacePathPreparation: target.preparationRequestId }
      : target.batchId !== undefined ? { workspacePathBatch: target.batchId } : { workspacePathProblem: target.problemId! }) })}`;
}
