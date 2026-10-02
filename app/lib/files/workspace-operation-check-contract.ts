import type { WorkspaceOperationBatchPublic } from './workspace-operation-batch-public';

export type WorkspaceOperationCheckStatus = 'queued' | 'checking' | 'ready' | 'blocked' | 'failed';
export type WorkspaceOperationCheckPublic = {
  checkId: string; workspaceId: string; reviewIds: string[]; status: WorkspaceOperationCheckStatus;
  batchId: string | null; errorCode: string | null; createdAt: number; updatedAt: number;
};
export type WorkspaceOperationCheckResponse = { check: WorkspaceOperationCheckPublic; batch?: WorkspaceOperationBatchPublic };
