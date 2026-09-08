/** Shared by the HTTP mutation response and the workspace event stream. */
export type WorkspacePathRenameMutation = {
  type: 'rename';
  operationId: string;
  workspaceId: string;
  oldPath: string;
  newPath: string;
};

export type WorkspaceFileEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' | 'rename';

export interface WorkspaceFileEvent {
  type: WorkspaceFileEventType;
  workspaceId?: string;
  path: string;
  relativePath: string;
  dir: string;
  timestamp: number;
  mutation?: WorkspacePathRenameMutation;
}
