import type { WorkspaceOperationBatchPlan, WorkspaceOperationBatchProgress } from './workspace-operation-batch-contract';
import type { WorkspaceOperationBatchStatus } from './workspace-operation-batch-store';

export type WorkspaceOperationBatchPublic = {
  batchId: string; planId: string; workspaceId: string; reviewIds: string[];
  status: WorkspaceOperationBatchStatus;
  preview: Omit<WorkspaceOperationBatchPlan, 'originalDocuments' | 'deletedDocuments' | 'previewContents' | 'linkPlan'> & {
    changedReviews: Array<{ reviewId: string; previousPlanId: string; currentPlanId: string; detail: string }>;
  };
  completedActions: number; totalActions: number; phase: WorkspaceOperationBatchProgress['phase'];
  errorCode: string | null; trashEntryIds: string[];
  createdAt: number; updatedAt: number; undoAvailable: boolean;
};
