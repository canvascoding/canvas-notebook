export interface PublicShareState {
  id: string;
  workspaceId?: string | null;
  status: string;
  publicUrl: string;
  shortUrl?: string;
  securityMode?: string;
  expiresAt: string | null;
  accessCount: number;
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
  permissions?: string;
  children?: FileNode[];
  publicShare?: PublicShareState;
}

export type BrowserMode = 'tree' | 'list' | 'grid';

export interface FileStats {
  size: number;
  modified: number;
  permissions: string;
  sha256?: string;
}

export type FileCollaborationStrategy = 'crdt_text' | 'revision_check' | 'exclusive_lock';

export interface FileRevisionRecord {
  id: string;
  contentHash: string;
  baseRevisionId: string | null;
  createdAt: number;
  createdByActorType: string;
  createdByUserId: string | null;
}

export interface FileLockState {
  id: string;
  lockedByUserId: string | null;
  lockedBySessionId: string | null;
  lockType: string;
  status: string;
  expiresAt: number;
}

export interface CollaborationDocumentState {
  id: string;
  provider: 'yjs';
  stateVersion: number;
  snapshotRevisionId: string | null;
  status: string;
}

export interface FileCollaborationState {
  path: string;
  strategy: FileCollaborationStrategy;
  crdtCapable: boolean;
  lockRequired: boolean;
  requiresRevisionCheck: boolean;
  latestRevision: FileRevisionRecord | null;
  activeLock: FileLockState | null;
  document: CollaborationDocumentState | null;
}

export interface CurrentFile {
  path: string;
  content: string;
  stats?: FileStats;
  revision?: FileRevisionRecord | null;
  collaboration?: FileCollaborationState | null;
}
