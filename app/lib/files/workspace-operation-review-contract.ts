import type { WorkspaceFileOperationPreview } from '@/app/lib/markdown/workspace-file-operation-planner';
import type { WorkspaceLinkCoverageV1 } from '@/app/lib/markdown/workspace-link-contract-v1';

export type WorkspaceOperationReviewKind = 'rename' | 'move' | 'copy' | 'delete';
export type WorkspaceOperationReviewStatus =
  | 'pending' | 'queued' | 'applying' | 'applied' | 'rejected' | 'stale' | 'failed' | 'needs_recovery' | 'blocked';

export type WorkspaceOperationDeletePreview = {
  kind: 'delete';
  planId: string;
  readiness: 'ready' | 'blocked';
  deletedPaths: Array<{ path: string; kind: 'file' | 'directory'; identity: string }>;
  potentialBrokenLinks: Array<{ sourcePath: string; targetPath: string; targetLiteral: string }>;
  coverage: WorkspaceLinkCoverageV1;
  issues: Array<{ code: string; path: string; detail: string }>;
};

export type WorkspaceOperationReviewPreview =
  | Omit<WorkspaceFileOperationPreview, 'previewContents'>
  | WorkspaceOperationDeletePreview;

export type WorkspaceOperationReviewPublic = {
  reviewId: string;
  planId: string;
  kind: WorkspaceOperationReviewKind;
  selections: Array<{ sourcePath: string; destinationPath?: string }>;
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  status: WorkspaceOperationReviewStatus;
  actor: { type: 'agent' | 'user'; id: string };
  reasonCodes: string[];
  preview: WorkspaceOperationReviewPreview;
  createdAt: number;
  updatedAt: number;
  operationId: string | null;
  errorCode: string | null;
  trashEntryIds: string[];
  batchId?: string | null;
  previousReviewId?: string | null;
  successorReviewId?: string | null;
};

export type WorkspaceOperationReviewSubmission =
  | { mode: 'direct' }
  | { mode: 'needs_review'; reviewId: string; planId: string; status: 'pending'; workspaceId: string }
  | { mode: 'blocked'; reviewId: string; planId: string; workspaceId: string;
      status: 'blocked' | 'stale' | 'failed' | 'needs_recovery' | 'applied' | 'rejected' | 'applying' | 'queued';
      code: string; message: string };
