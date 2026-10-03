import type { WorkspaceOperationReviewKind } from './workspace-operation-review-contract';

export const WORKSPACE_OPERATION_NOTIFICATION_PREFIX = 'file-operation:';
export const WORKSPACE_OPERATION_ATTENTION_STATUSES = ['pending', 'queued', 'applying', 'blocked', 'stale', 'failed', 'needs_recovery'] as const;
export type WorkspaceOperationAttentionStatus = typeof WORKSPACE_OPERATION_ATTENTION_STATUSES[number];
export type WorkspaceOperationNotificationTarget = {
  kind: 'file_operation';
  workspaceId: string;
  reviewId: string;
  operationKind: WorkspaceOperationReviewKind;
  status: WorkspaceOperationAttentionStatus;
};

export function workspaceOperationReviewHref(target: Pick<WorkspaceOperationNotificationTarget, 'workspaceId' | 'reviewId'>): string {
  return `/notebook?${new URLSearchParams({ workspaceId: target.workspaceId, workspaceOperationReview: target.reviewId })}`;
}

export const WORKSPACE_PATH_OPERATION_NOTIFICATION_PREFIX = 'file-path-operation:';
export const WORKSPACE_PATH_PROBLEM_NOTIFICATION_PREFIX = 'file-path-problem:';
export type WorkspacePathOperationAttentionStatus = 'queued' | 'applying' | 'blocked' | 'stale' | 'failed' | 'needs_recovery';
export type WorkspacePathOperationNotificationTarget = {
  kind: 'file_path_operation';
  workspaceId: string;
  operationKind: 'move' | 'rename' | 'delete';
  status: WorkspacePathOperationAttentionStatus;
} & ({ batchId: string; problemId?: never } | { problemId: string; batchId?: never });

export function workspacePathOperationHref(target: WorkspacePathOperationNotificationTarget): string {
  return `/notebook?${new URLSearchParams({ workspaceId: target.workspaceId,
    ...(target.batchId !== undefined ? { workspacePathBatch: target.batchId } : { workspacePathProblem: target.problemId! }) })}`;
}
