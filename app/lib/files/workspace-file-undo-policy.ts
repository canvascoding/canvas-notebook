/** File-action Undo is unavailable until its native restore path is accepted.
 * This release policy applies to every file type and every deployment. It does
 * not control text-editor history or independent document-version restores. */
export const WORKSPACE_FILE_UNDO_ENABLED = false;

export class WorkspaceFileUndoDisabledError extends Error {
  readonly code = 'FILE_OPERATION_UNDO_DISABLED';
  readonly status = 409;

  constructor() {
    super('File action Undo is currently disabled.');
    this.name = 'WorkspaceFileUndoDisabledError';
  }
}

export function assertWorkspaceFileUndoEnabled(): void {
  if (!WORKSPACE_FILE_UNDO_ENABLED) throw new WorkspaceFileUndoDisabledError();
}
