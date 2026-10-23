import type { WorkspaceOperationLegacyBatchPlan, WorkspaceOperationNativeDeleteBatchPlan, WorkspaceOperationBatchProgress } from './workspace-operation-batch-contract';
import type { WorkspaceOperationBatchStatus } from './workspace-operation-batch-store';
import type { WorkspaceOperationNativeMoveBatchPlan } from './workspace-operation-native-move-plan';

export type WorkspaceOperationBatchExecutionPublic = {
  mode: 'apply' | 'undo';
  receiptStatus: 'available' | 'not_started' | 'unavailable';
  finalization: 'pending' | 'complete';
  steps: Array<{ key: string; phase: 'path' | 'link'; kind: 'move' | 'rename' | 'delete' | 'restore' | 'link_update';
    path: string; destinationPath?: string; reviewId?: string; state: 'pending' | 'applied' | 'needs_check';
    /** Receipt-derived document location; absent when a path intent leaves its location uncertain. */
    openPath?: string }>;
};
/** Explicit V2 whitelist: native binary/anchors/graph/identity proofs stay private. */
export type WorkspaceOperationBatchPreviewPublic = Omit<WorkspaceOperationLegacyBatchPlan,
  'originalDocuments' | 'deletedDocuments' | 'previewContents' | 'linkPlan'>
  | Pick<WorkspaceOperationNativeDeleteBatchPlan | WorkspaceOperationNativeMoveBatchPlan, 'version' | 'kind' | 'workspaceId' | 'planId' | 'readiness' | 'actions'
    | 'pathMappings' | 'deletedPaths' | 'pathSteps' | 'linkEdits' | 'expectedPathState' | 'coverage' | 'linkAssessment' | 'issues'>;

export type WorkspaceOperationBatchPublic = {
  batchId: string; planId: string; workspaceId: string; reviewIds: string[];
  status: WorkspaceOperationBatchStatus;
  preview: WorkspaceOperationBatchPreviewPublic & {
    changedReviews: Array<{ reviewId: string; previousPlanId: string; currentPlanId: string; detail: string }>;
  };
  completedActions: number; totalActions: number; phase: WorkspaceOperationBatchProgress['phase'];
  errorCode: string | null; trashEntryIds: string[];
  createdAt: number; updatedAt: number; undoAvailable: boolean;
  /** Available on authorized settled reads; processing polls remain lightweight. */
  execution?: WorkspaceOperationBatchExecutionPublic;
};
