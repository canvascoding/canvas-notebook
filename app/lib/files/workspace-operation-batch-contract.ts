import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';
import type { WorkspaceFileOperationPreview } from '@/app/lib/markdown/workspace-file-operation-planner';
import type { WorkspaceFileLinkEditV1, WorkspaceFilePathMappingV1, WorkspaceLinkCoverageV1,
  WorkspaceFileOperationLinkAssessmentV1 } from '@/app/lib/markdown/workspace-link-contract-v1';

export type WorkspaceOperationBatchScope = { workspace: WorkspaceContext; fileOptions: WorkspaceFileOperationOptions };
/** Direct authorization is an actual mutation request, never an accepted review. */
export type WorkspaceOperationDirectAuthorization = {
  mode: 'direct';
  actorUserId: string;
  actorId: string;
  actorDisplayName: string;
  actorType: 'user' | 'agent';
  actorSessionId?: string;
  requestHash: string;
};
export type WorkspaceOperationBatchAuthorization = { mode: 'review' } | WorkspaceOperationDirectAuthorization;
export type WorkspaceOperationBatchAction = {
  /** Stable action identity. Direct jobs have no associated review row. */
  reviewId: string;
  kind: 'move' | 'rename' | 'delete';
  /** Only delete may ignore paths absent from its initial snapshot. */
  ignoreMissing?: boolean;
  selections: Array<{ sourcePath: string; destinationPath?: string }>;
};
export type WorkspaceOperationBatchIssue = { code: string; path: string; detail: string; reviewId?: string };
export type WorkspaceOperationBatchPlan = {
  version: 1;
  workspaceId: string;
  planId: string;
  readiness: 'ready' | 'blocked';
  actions: WorkspaceOperationBatchAction[];
  pathMappings: Array<WorkspaceFilePathMappingV1 & { sourceKind: 'file' | 'directory' }>;
  deletedPaths: Array<{ path: string; kind: 'file' | 'directory'; identity: string }>;
  pathSteps: Array<{ reviewId: string; kind: 'move' | 'rename' | 'delete'; sourcePath: string; destinationPath?: string }>;
  linkEdits: Array<WorkspaceFileLinkEditV1 & { changeKind: 'rewrite' | 'unlink'; snippet: { before: string; after: string } }>;
  originalDocuments: Array<{ workspaceId: string; path: string; content: string }>;
  /** Private candidate evidence for safe Undo, including aliases in deleted Markdown. */
  deletedDocuments?: Array<{ workspaceId: string; path: string; content: string }>;
  previewContents: Array<{ workspaceId: string; path: string; content: string }>;
  expectedPathState: WorkspaceFileOperationPreview['expectedPathState'];
  coverage: WorkspaceLinkCoverageV1;
  linkAssessment: WorkspaceFileOperationLinkAssessmentV1;
  issues: WorkspaceOperationBatchIssue[];
  /** Internal exact span plan consumed by the fenced plain-file/Yjs writer. */
  linkPlan: WorkspaceFileOperationPreview;
};
export type WorkspaceOperationBatchProgress = {
  completedActions: number;
  totalActions: number;
  phase: 'preparing' | 'paths' | 'links' | 'complete' | 'recovery';
};
export type WorkspaceOperationBatchExecutionResult = {
  status: 'applied' | 'needs_review' | 'needs_recovery' | 'failed';
  trashEntryIds: string[];
  completedActions: number;
  totalActions: number;
  errorCode: string | null;
  stepResults?: Array<{ key: string; phase: 'path' | 'link'; state: 'intent' | 'applied';
    reviewId?: string; path: string; destinationPath?: string; sourceIdentity?: string;
    mutationId?: string; trashEntryId?: string }>;
};
