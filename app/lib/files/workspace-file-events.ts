export const WORKSPACE_FILE_OPENED_EVENT = 'canvas:workspace-file-opened';
export const WORKSPACE_PATHS_DELETED_EVENT = 'canvas:workspace-paths-deleted';
export const WORKSPACE_PATH_RENAMED_EVENT = 'canvas:workspace-path-renamed';

export type WorkspaceFileOpenedSource = 'file-browser' | 'chat-reference';

export type WorkspaceFileOpenedDetail = {
  path: string;
  source: WorkspaceFileOpenedSource;
};

export type WorkspacePathsDeletedDetail = {
  workspaceId: string | null;
  paths: string[];
};

export type WorkspacePathRenamedDetail = {
  workspaceId: string | null;
  newPath: string;
  oldPath: string;
};

export function notifyWorkspaceFileOpened(path: string, source: WorkspaceFileOpenedSource) {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(
    new CustomEvent<WorkspaceFileOpenedDetail>(WORKSPACE_FILE_OPENED_EVENT, {
      detail: { path, source },
    })
  );
}

export function notifyWorkspacePathsDeleted(paths: string[], workspaceId: string | null) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<WorkspacePathsDeletedDetail>(
    WORKSPACE_PATHS_DELETED_EVENT,
    { detail: { paths, workspaceId } },
  ));
}

export function notifyWorkspacePathRenamed(oldPath: string, newPath: string, workspaceId: string | null) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<WorkspacePathRenamedDetail>(
    WORKSPACE_PATH_RENAMED_EVENT,
    { detail: { oldPath, newPath, workspaceId } },
  ));
}
