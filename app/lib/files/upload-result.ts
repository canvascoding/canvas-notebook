import type { FileNode } from './types';

export interface WorkspaceUploadCommit {
  targetPath: string;
  node?: FileNode;
  fileVersion?: string;
}
