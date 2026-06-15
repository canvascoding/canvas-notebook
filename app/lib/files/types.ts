export interface PublicShareState {
  id: string;
  status: string;
  publicUrl: string;
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
}

export interface CurrentFile {
  path: string;
  content: string;
  stats?: FileStats;
}
