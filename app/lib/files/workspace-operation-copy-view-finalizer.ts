import 'server-only';

import { invalidateWorkspaceFileViews } from '../api/route-helpers';
import type { WorkspaceFileOperationOptions } from '../filesystem/workspace-files';

/** Private notification facts, never document or mutation authority. */
export type NativeCopyViewOutcome = Readonly<{
  kind: 'published'; destinationWorkspaceId: string;
  entries: readonly Readonly<{ path: string; type: 'add' | 'addDir' }>[];
}> | Readonly<{ kind: 'historical'; destinationWorkspaceId: string }>;

/** All Copy service callers share the existing cache and file-event mechanism.
 * A historical receipt refreshes views without inventing another file birth. */
export function finalizeWorkspaceNativeCopyViews(input: {
  fileOptions: WorkspaceFileOperationOptions; outcome: NativeCopyViewOutcome;
}): void {
  if (input.fileOptions.workspace?.workspaceId !== input.outcome.destinationWorkspaceId) {
    throw new Error('Native Copy view destination changed.');
  }
  invalidateWorkspaceFileViews({ fileOptions: input.fileOptions, fullTree: true,
    mutations: input.outcome.kind === 'published' ? input.outcome.entries.map(entry => ({ ...entry })) : [] });
}
