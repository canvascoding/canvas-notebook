import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { WorkspaceContext } from '../workspaces/types';
import { readWorkspaceLinkSourceAuthorityOnConnection } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationBatchScope } from './workspace-operation-batch-contract';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';
import { withWorkspaceOperationNativeDeleteReadContext } from './workspace-operation-native-delete-status';
import { assertWorkspaceOperationNativeDeleteUndoGraphCurrent } from './workspace-operation-native-delete-undo-graph';
import { observeOriginalNativeRestoreTargetOnConnection } from './workspace-operation-original-delete-native';
import { verifyTrashRow } from './workspace-operation-original-delete';

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function conflict(code: string): never { throw Object.assign(new Error(code), { code, status: 409 }); }

async function assertVacant(workspace: WorkspaceContext, relativePath: string, projectionAbsent: boolean): Promise<void> {
  if (!isCanonicalAdmissionPath(relativePath)) conflict('BATCH_UNDO_PATH_CHANGED');
  const root = await fs.realpath(workspace.rootPath), initial = await fs.lstat(root);
  if (!initial.isDirectory() || initial.isSymbolicLink()) conflict('BATCH_UNDO_PATH_CHANGED');
  let parent = root, missing = false;
  const segments = relativePath.split('/');
  for (const [index, segment] of segments.entries()) {
    const candidate = path.join(parent, segment);
    try {
      const stat = await fs.lstat(candidate);
      if (!(await fs.readdir(parent)).includes(segment) || stat.isSymbolicLink()) conflict('BATCH_UNDO_PATH_CHANGED');
      if (index === segments.length - 1) conflict('BATCH_UNDO_DESTINATION_OCCUPIED');
      if (!stat.isDirectory()) conflict('BATCH_UNDO_DESTINATION_OCCUPIED');
      parent = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!projectionAbsent && index !== segments.length - 1) conflict('BATCH_UNDO_PATH_CHANGED');
      missing = true; break;
    }
  }
  const final = await fs.lstat(root);
  if (!missing || !final.isDirectory() || final.dev !== initial.dev || final.ino !== initial.ino
    || await fs.realpath(workspace.rootPath) !== root) conflict('BATCH_UNDO_PATH_CHANGED');
}

/** Advisory availability only. Original execution repeats these facts under its
 * genuine claim, current write policy, exclusive owner and locked native CAS. */
export async function assertWorkspaceOperationNativeDeleteUndoAvailable(input: {
  batchId: string; scope: WorkspaceOperationBatchScope;
}): Promise<boolean> {
  return withWorkspaceMutationLock(input.scope.workspace.workspaceId, async () => {
    const available = await withWorkspaceOperationNativeDeleteReadContext(input, async ({ database, schema, workspace, status }) => {
      const { observation, plan, batch } = status, auth = batch.authorization;
      if (!workspace.permissions.canWrite || !workspace.permissions.canDelete || auth.mode !== 'direct'
        || workspace.actor?.userId !== auth.actorUserId) conflict('BATCH_ACCESS_DENIED');
      if (observation.apply !== 'complete' || observation.undo !== 'pristine' || !observation.original
        || !observation.deleted || !observation.deleteIntent || !observation.original.native || !observation.deleted.native) {
        conflict('BATCH_UNDO_NOT_COMPLETE');
      }
      const locked = await database.get('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS locked',
        [collaborationAdmissionLockKey(workspace.workspaceId)]) as { locked?: unknown } | undefined;
      if (locked?.locked !== true) conflict('BATCH_UNDO_PATH_CHANGED');
      const original = observation.original, deleted = observation.deleted;
      const row = await database.get(`SELECT * FROM ${quote(schema)}.workspace_trash_entries WHERE id=$1`,
        [deleted.trashEntryId]) as Record<string, unknown> | undefined;
      verifyTrashRow(original, observation.deleteIntent.intentDigest, row);
      const now = Date.now();
      if (original.physical.expiresAtMs <= now) conflict('BATCH_UNDO_PATH_CHANGED');
      await observeOriginalNativeRestoreTargetOnConnection(database, { schema, workspace, expected: original.native!,
        archived: deleted.native!, trashEntryId: deleted.trashEntryId, restoredAt: Math.max(now, original.physical.deletedAtMs) });
      const current = await readWorkspaceLinkSourceAuthorityOnConnection(database, workspace);
      assertWorkspaceOperationNativeDeleteUndoGraphCurrent(plan, current, 'before-restore');
      await assertVacant(workspace, plan.nativeTarget.path, original.physical.source.kind === 'projection_absent');
      return true;
    });
    return available ?? false;
  });
}
