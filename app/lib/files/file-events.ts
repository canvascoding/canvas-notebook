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
  /** Filesystem identity and change times sampled for this event. */
  fileVersion?: string;
  mutation?: WorkspacePathRenameMutation;
}

/** A workspace-scoped hint to re-read identities, never a file mutation or grant. */
export type WorkspaceFileInvalidation = Readonly<{ workspaceId: string }>;

export function isWorkspaceFileInvalidation(value: unknown): value is WorkspaceFileInvalidation {
  try {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).length !== 1) return false;
    const workspaceId = Object.getOwnPropertyDescriptor(value, 'workspaceId');
    return workspaceId?.enumerable === true && Object.hasOwn(workspaceId, 'value')
      && typeof workspaceId.value === 'string' && workspaceId.value.length > 0 && workspaceId.value.length <= 128
      && !/[^a-zA-Z0-9_-]/u.test(workspaceId.value);
  } catch { return false; }
}
