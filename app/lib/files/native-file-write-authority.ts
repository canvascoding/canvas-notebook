import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import { openDb } from '@/app/lib/db';
import { executeLifecycleTransaction } from '@/app/lib/collaboration/lifecycle-transaction';
import { getWorkspaceFileLifecycleLeases } from '@/app/lib/collaboration/file-lifecycle-admission-context';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from '@/app/lib/collaboration/room-admission-contract';
import { readWorkspaceDocumentCatalogue, type WorkspaceDocumentCatalogueEntry } from '@/app/lib/collaboration/workspace-document-catalogue';
import { WorkspaceDocumentCatalogueError } from '@/app/lib/collaboration/workspace-document-catalogue';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';

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

export class NativeFileWritePreflightError extends Error {
  constructor(readonly code: 'NATIVE_FILE_WRITE_BUSY' | 'NATIVE_FILE_WRITE_AUTHORITY_CONFLICT'
    | 'NATIVE_FILE_WRITE_READ_UNCONFIRMED' | 'NATIVE_FILE_WRITE_INVALID_PATH' | 'NATIVE_FILE_WRITE_PERMISSION_DENIED',
  readonly status: 400 | 403 | 409 | 503) {
    super(code === 'NATIVE_FILE_WRITE_BUSY' ? 'A document transition is in progress. Retry after it completes.'
      : code === 'NATIVE_FILE_WRITE_AUTHORITY_CONFLICT' ? 'The native document authority is unavailable. Open the document for recovery.'
        : code === 'NATIVE_FILE_WRITE_READ_UNCONFIRMED' ? 'The document authority check could not be confirmed. Retry the save.'
          : code === 'NATIVE_FILE_WRITE_INVALID_PATH' ? 'A canonical workspace file path is required.'
            : 'Current workspace read and write permissions are required.');
    this.name = 'NativeFileWritePreflightError';
  }
}

/** Deny-only POST preflight before suffix dispatch. This closes its own read
 * phase before the existing writer continues; it grants no publication right. */
export async function assertNoInitializedNativeFileWriteBeforeDispatch(input: {
  workspace: WorkspaceContext; path: string;
}): Promise<void> {
  const workspace = structuredClone(input.workspace), path = input.path;
  if (!isCanonicalAdmissionPath(path)) throw new NativeFileWritePreflightError('NATIVE_FILE_WRITE_INVALID_PATH', 400);
  if (!workspace.permissions.canRead || !workspace.permissions.canWrite
    || workspace.status !== undefined && workspace.status !== 'active') {
    throw new NativeFileWritePreflightError('NATIVE_FILE_WRITE_PERMISSION_DENIED', 403);
  }
  // Existing owned/batch callers are not connected to this POST-only seam.
  // A public ALS lease never grants permission to skip this shared read.
  if (getWorkspaceFileLifecycleLeases()?.has(workspace.workspaceId)) throw new NativeFileWritePreflightError('NATIVE_FILE_WRITE_BUSY', 409);
  try {
    await withWorkspaceMutationLock(workspace.workspaceId, () => executeLifecycleTransaction({
      openConnection: openDb,
      execute: async database => {
        await database.run('SET TRANSACTION READ ONLY');
        await database.run("SET LOCAL statement_timeout='5s'");
        await database.run("SET LOCAL lock_timeout='50ms'");
        const lock = await database.get('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS locked',
          [collaborationAdmissionLockKey(workspace.workspaceId)]) as { locked?: boolean } | undefined;
        if (lock?.locked !== true) throw new NativeFileWritePreflightError('NATIVE_FILE_WRITE_BUSY', 409);
        const reservation = await database.get(`SELECT s.request_id FROM collaboration_admission_scopes s
          JOIN collaboration_admission_requests r ON r.request_id=s.request_id
          WHERE s.workspace_id=$1 AND r.status NOT IN ('committed','cancelled')
            AND (s.path=$2 OR s.kind='subtree' AND (s.path='' OR left($2,length(s.path)+1)=s.path||'/')) LIMIT 1`,
        [workspace.workspaceId,path]);
        if (reservation) throw new NativeFileWritePreflightError('NATIVE_FILE_WRITE_BUSY', 409);
        await assertNoInitializedNativeFileWrite(database, workspace, path);
      },
      // A lost read COMMIT is no authorization to proceed with a file write.
      recoverCommitted: async () => { throw new NativeFileWritePreflightError('NATIVE_FILE_WRITE_READ_UNCONFIRMED', 503); },
    }));
  } catch (error) {
    if (error instanceof WorkspaceDocumentCatalogueError) throw new NativeFileWritePreflightError('NATIVE_FILE_WRITE_AUTHORITY_CONFLICT', 409);
    throw error;
  }
}
