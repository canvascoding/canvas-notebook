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

export interface CurrentFile {
  path: string;
  content: string;
  stats?: FileStats;
}
