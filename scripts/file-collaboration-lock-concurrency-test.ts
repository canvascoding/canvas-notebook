import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { openDb } from '../app/lib/db';
import {
  acquireFileLock,
  ensureFileRevisionForCurrentContent,
  FileCollaborationPolicyError,
} from '../app/lib/files/collaboration-policy';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) {
  console.log('file-collaboration-lock-concurrency-test: skipped (Postgres test profile is not enabled)');
  process.exit(0);
}

async function main(): Promise<void> {
  const suffix = randomUUID();
  const workspace: WorkspaceContext = {
    workspaceId: `lock-concurrency-workspace-${suffix}`,
    workspaceType: 'organization',
    organizationId: null,
    rootPath: `/tmp/lock-concurrency-${suffix}`,
    permissions: {
      canRead: true,
      canWrite: true,
      canDelete: true,
      canCreatePublicLinks: true,
      canManageWorkspace: true,
      canRunAgent: true,
    },
    legacy: false,
  };
  const filePath = `asset-${suffix}.pdf`;
  const revision = await ensureFileRevisionForCurrentContent({
    workspace,
    path: filePath,
    contentHash: `hash-${suffix}`,
    sizeBytes: 42,
    actorType: 'system',
  });

  try {
    const results = await Promise.allSettled([
      acquireFileLock({
        workspace,
        path: filePath,
        lockedByUserId: `user-a-${suffix}`,
        lockedBySessionId: `session-a-${suffix}`,
        baseRevisionId: revision.id,
      }),
      acquireFileLock({
        workspace,
        path: filePath,
        lockedByUserId: `user-b-${suffix}`,
        lockedBySessionId: `session-b-${suffix}`,
        baseRevisionId: revision.id,
      }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert(rejected);
    assert(
      rejected.reason instanceof FileCollaborationPolicyError
        && rejected.reason.code === 'FILE_LOCKED',
    );

    const database = await openDb();
    try {
      const active = await database.get(
        `SELECT COUNT(*)::int AS count
         FROM file_locks
         WHERE workspace_id = $1 AND path = $2 AND status = 'active'`,
        [workspace.workspaceId, filePath],
      ) as { count: number };
      assert.equal(Number(active.count), 1);
    } finally {
      await database.close();
    }
  } finally {
    const database = await openDb();
    try {
      await database.run('DELETE FROM file_locks WHERE workspace_id = $1', [workspace.workspaceId]);
      await database.run('DELETE FROM collaboration_documents WHERE workspace_id = $1', [workspace.workspaceId]);
      await database.run('DELETE FROM file_revisions WHERE workspace_id = $1', [workspace.workspaceId]);
      await database.run('DELETE FROM file_collaboration_lineages WHERE workspace_id = $1', [workspace.workspaceId]);
    } finally {
      await database.close();
    }
  }

  console.log('file collaboration lock concurrency tests passed');
}

void main();
