export const WORKSPACE_FILE_OPENED_EVENT = 'canvas:workspace-file-opened';

export type WorkspaceFileOpenedSource = 'file-browser' | 'chat-reference';

export type WorkspaceFileOpenedDetail = {
  path: string;
  source: WorkspaceFileOpenedSource;
};

export function notifyWorkspaceFileOpened(path: string, source: WorkspaceFileOpenedSource) {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(
    new CustomEvent<WorkspaceFileOpenedDetail>(WORKSPACE_FILE_OPENED_EVENT, {
      detail: { path, source },
    })
  );
}
