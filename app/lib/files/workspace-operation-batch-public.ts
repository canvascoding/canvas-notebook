import type { WorkspaceOperationBatchPlan, WorkspaceOperationBatchProgress } from './workspace-operation-batch-contract';
import type { WorkspaceOperationBatchStatus } from './workspace-operation-batch-store';

export type WorkspaceOperationBatchExecutionPublic = {
  mode: 'apply' | 'undo';
  receiptStatus: 'available' | 'not_started' | 'unavailable';
  finalization: 'pending' | 'complete';
  steps: Array<{ key: string; phase: 'path' | 'link'; kind: 'move' | 'rename' | 'delete' | 'restore' | 'link_update';
    path: string; destinationPath?: string; reviewId?: string; state: 'pending' | 'applied' | 'needs_check';
    /** Receipt-derived document location; absent when a path intent leaves its location uncertain. */
    openPath?: string }>;
};

export type WorkspaceOperationBatchPublic = {
  batchId: string; planId: string; workspaceId: string; reviewIds: string[];
  status: WorkspaceOperationBatchStatus;
  preview: Omit<WorkspaceOperationBatchPlan, 'originalDocuments' | 'deletedDocuments' | 'previewContents' | 'linkPlan'> & {
    changedReviews: Array<{ reviewId: string; previousPlanId: string; currentPlanId: string; detail: string }>;
  };
  completedActions: number; totalActions: number; phase: WorkspaceOperationBatchProgress['phase'];
  errorCode: string | null; trashEntryIds: string[];
  createdAt: number; updatedAt: number; undoAvailable: boolean;
  /** Available on authorized settled reads; processing polls remain lightweight. */
  execution?: WorkspaceOperationBatchExecutionPublic;
};
