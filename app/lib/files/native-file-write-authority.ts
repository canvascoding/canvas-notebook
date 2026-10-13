import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import { readWorkspaceDocumentCatalogue, type WorkspaceDocumentCatalogueEntry } from '@/app/lib/collaboration/workspace-document-catalogue';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export class NativeWholeFileWriteBlockedError extends Error {
  readonly code = 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED';
  readonly status = 409;

  constructor(readonly path: string, readonly authority: WorkspaceDocumentCatalogueEntry['authority']) {
    super('Apply changes through the native collaboration service instead of replacing this document projection.');
    this.name = 'NativeWholeFileWriteBlockedError';
  }
}

/**
 * The caller owns the workspace/path mutation fences and the transaction.
 * Capability, extension and actor type never change an initialized document's
 * authority. This check grants no projector or lifecycle exception and must be
 * repeated under the final publication fence by direct filesystem writers.
 */
export async function assertNoInitializedNativeFileWrite(
  connection: SqlConnection,
  workspace: WorkspaceContext,
  path: string,
): Promise<WorkspaceDocumentCatalogueEntry | null> {
  if (!workspace.permissions.canWrite) {
    throw Object.assign(new Error('Current workspace write permission is required.'), { status: 403 });
  }
  if (!path || path === '.') throw new Error('A canonical workspace file path is required.');
  const documents = await readWorkspaceDocumentCatalogue(connection, workspace, { paths: [path] });
  for (const document of documents) {
    // A registry-only directory must not be replaced by a physical file either.
    if (document.path !== path || document.authority !== 'pristine') {
      throw new NativeWholeFileWriteBlockedError(path, document.authority);
    }
  }
  return documents[0] ?? null;
}
