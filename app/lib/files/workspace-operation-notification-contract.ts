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
