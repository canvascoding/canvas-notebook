import type { WorkspaceOperationBatchProgress } from './workspace-operation-batch-contract';
import type { WorkspaceOperationBatchStatus } from './workspace-operation-batch-store';
import type { WorkspacePathRenameMutation } from './file-events';

export type WorkspacePathOperationPublic = WorkspaceOperationBatchProgress & {
  batchId: string; planId: string; workspaceId: string;
  status: WorkspaceOperationBatchStatus; errorCode: string | null;
  kind: 'move' | 'rename' | 'delete';
  selections: Array<{ sourcePath: string; destinationPath?: string }>;
};

export type WorkspacePathOperationResponse = {
  operation: WorkspacePathOperationPublic;
  mutation?: WorkspacePathRenameMutation;
  deleted?: string[];
  failed?: Array<{ path: string; error: string }>;
  trashEntries?: Array<{ id: string; originalPath: string; itemType: 'file' | 'directory' | 'other';
    sizeBytes: number; expiresAt: string }>;
  linkStatus?: 'complete';
  linkUpdates?: { updatedFiles: string[]; updatedLinks: number; warnings: string[] };
};
