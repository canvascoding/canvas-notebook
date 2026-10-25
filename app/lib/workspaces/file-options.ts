import type { WorkspaceContext } from './types';

/** Storage parameters only; importing this helper must not initialize Auth. */
export function workspaceFileOptions(workspace: WorkspaceContext) {
  return { workspace };
}
