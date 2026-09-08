import type { FileNode } from './types';

export interface WorkspaceUploadCommit {
  targetPath: string;
  node?: FileNode;
  fileVersion?: string;
}

export interface UploadDirectoryResult {
  completed: Array<{ sourcePath: string; committed: WorkspaceUploadCommit }>;
  failed: Array<{ sourcePath: string; error: string }>;
}
