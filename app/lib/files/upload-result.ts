import type { FileNode } from './types';

/** Public completion facts and a locator only; private native evidence stays server-side. */
export interface WorkspaceUploadCompletion {
  status: 'completed' | 'projection_pending' | 'recovery_required' | 'unavailable';
  uploadId: string;
  fileId: string;
  targetPath: string;
  code?: 'MARKDOWN_UPLOAD_PROJECTION_PENDING' | 'MARKDOWN_UPLOAD_RECOVERY_REQUIRED' | 'MARKDOWN_UPLOAD_NATIVE_UNAVAILABLE';
}

export interface WorkspaceUploadCommit {
  targetPath: string;
  node?: FileNode;
  fileVersion?: string;
}

export interface UploadDirectoryResult {
  completed: Array<{ sourcePath: string; committed: WorkspaceUploadCommit }>;
  failed: Array<{ sourcePath: string; error: string }>;
}
