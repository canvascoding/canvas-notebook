import 'server-only';

import { withFileCollaborationTransaction } from '@/app/lib/files/collaboration-repository/transaction';
import { assertWorkspaceFileLifecycleSqlAvailable, WorkspaceFileLifecycleBusyError } from '@/app/lib/files/workspace-file-lifecycle-guard';

/** Existing Scene HTTP, MCP and agent adapters preserve this domain error. */
export class ExcalidrawLifecycleUnavailableError extends Error {
  readonly code = 'EXCALIDRAW_FILE_LIFECYCLE_BUSY';
  readonly status = 409;
  constructor(cause: WorkspaceFileLifecycleBusyError) {
    super('A workspace file action is still running. Retry after it has completed or recovered.', { cause });
    this.name = 'ExcalidrawLifecycleUnavailableError';
  }
}

/** Public Scene entry points call this under their workspace mutation lock,
 * before bootstrap, create-journal or portable-file publication. A durable
 * reservation survives release of that kernel lock after an interrupted action.
 * This helper grants no exemption to an internal Copy phase. */
export async function assertExcalidrawLifecycleAvailable(workspaceId: string, path: string,
  options: Parameters<typeof assertWorkspaceFileLifecycleSqlAvailable>[3] = {}): Promise<void> {
  try {
    await withFileCollaborationTransaction(
      transaction => assertWorkspaceFileLifecycleSqlAvailable(transaction, workspaceId, [path], options),
      undefined,
      { strictCleanup: options.admissionLock === 'wait' },
    );
  } catch (error) {
    if (error instanceof WorkspaceFileLifecycleBusyError) throw new ExcalidrawLifecycleUnavailableError(error);
    throw error;
  }
}
