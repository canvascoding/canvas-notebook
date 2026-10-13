import 'server-only';

import { promises as fs } from 'node:fs';
import type { SqlConnection } from '@/app/lib/db';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { assertWorkspacePathHasNoAliases, resolveWorkspacePath } from '@/app/lib/workspaces/path-guard';

type PendingCreate = {
  actor_user_id: string; actor_id: string; idempotency_key: string;
  path: string; file_dev: string; file_ino: string;
};

async function ownsFile(workspace: WorkspaceContext, path: string, receipt: PendingCreate): Promise<boolean> {
  try {
    await assertWorkspacePathHasNoAliases(workspace, path, { readOnly: true });
    const identity = await fs.stat(resolveWorkspacePath(workspace, path).absolutePath, { bigint: true });
    return identity.isFile() && String(identity.dev) === receipt.file_dev && String(identity.ino) === receipt.file_ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Rename the recovery locator; the original request fingerprint remains immutable. */
export async function movePendingExcalidrawCreatePaths(transaction: SqlConnection, input: {
  workspace: WorkspaceContext; oldPath: string; newPath: string; nowMs: number;
}): Promise<void> {
  const receipts = await transaction.all(`SELECT actor_user_id,actor_id,idempotency_key,path,file_dev,file_ino
    FROM collaboration_excalidraw_creates WHERE workspace_id=$1 AND status='preparing' AND document_id IS NULL
      AND file_dev IS NOT NULL AND file_ino IS NOT NULL
      AND (path=$2 OR left(path,char_length($2)+1)=$2||'/')
    ORDER BY actor_user_id,actor_id,idempotency_key FOR UPDATE`,
  [input.workspace.workspaceId, input.oldPath]) as PendingCreate[];
  for (const receipt of receipts) {
    const currentPath = input.newPath + receipt.path.slice(input.oldPath.length);
    // Normal rename runs after the physical move; projection compensation runs
    // before the physical rollback. Both require the same published inode.
    if (!await ownsFile(input.workspace, currentPath, receipt)
      && !await ownsFile(input.workspace, receipt.path, receipt)) continue;
    if (!currentPath.toLowerCase().endsWith('.excalidraw')) {
      throw Object.assign(new Error('Excalidraw documents must retain their .excalidraw extension.'),
        { code: 'EXCALIDRAW_EXTENSION_REQUIRED', status: 409 });
    }
    await transaction.run(`UPDATE collaboration_excalidraw_creates SET path=$1,updated_at=$2
      WHERE workspace_id=$3 AND actor_user_id=$4 AND actor_id=$5 AND idempotency_key=$6
        AND path=$7 AND status='preparing' AND document_id IS NULL AND file_dev=$8 AND file_ino=$9`,
    [currentPath, input.nowMs, input.workspace.workspaceId, receipt.actor_user_id, receipt.actor_id,
      receipt.idempotency_key, receipt.path, receipt.file_dev, receipt.file_ino]);
  }
}
