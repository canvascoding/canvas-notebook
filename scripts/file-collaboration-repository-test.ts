import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import type { SqlConnection } from '../app/lib/db';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import {
  appendFileRevision,
  ensureActiveFileLineage,
  ensureCollaborationDocument,
  expireFileLocksForPath,
  getActiveCollaborationDocument,
  getActiveFileLock,
  getLatestFileRevisionForLineage,
  insertFileLock,
  lockFileCollaborationPaths,
  refreshFileLock,
  updateCollaborationDocumentCheckpoint,
  updateFileLockStatus,
  withFileCollaborationTransaction,
} from '../app/lib/files/collaboration-repository';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

function connectionFor(postgres: PGlite): SqlConnection {
  return {
    get: async (sql, params = []) => (await postgres.query(sql, params)).rows[0],
    run: async (sql, params = []) => {
      const result = await postgres.query(sql, params);
      return { changes: result.affectedRows ?? 0 };
    },
    all: async (sql, params = []) => (await postgres.query(sql, params)).rows,
    close: () => undefined,
  };
}

const workspace = {
  workspaceId: 'repository-workspace',
  workspaceType: 'organization',
  organizationId: 'repository-organization',
  customerId: null,
  projectId: null,
} as WorkspaceContext;

async function main(): Promise<void> {
  const postgres = new PGlite();
  try {
    await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const connection = connectionFor(postgres);

    const first = await withFileCollaborationTransaction(async (transaction) => {
      await lockFileCollaborationPaths(transaction, workspace.workspaceId, ['notes.md']);
      const lineage = await ensureActiveFileLineage(transaction, {
        id: 'lineage-1',
        workspace,
        path: 'notes.md',
        nowMs: 100,
      });
      const revision = await appendFileRevision(transaction, {
        id: 'revision-1',
        lineageId: lineage.id,
        workspace,
        path: 'notes.md',
        contentHash: 'hash-1',
        sizeBytes: 4,
        createdByActorType: 'user',
        createdByUserId: 'user-1',
        nowMs: 100,
      });
      const document = await ensureCollaborationDocument(transaction, {
        id: 'document-1',
        lineageId: lineage.id,
        workspace,
        path: 'notes.md',
        provider: 'yjs',
        snapshotRevisionId: revision.id,
        nowMs: 100,
      });
      const lock = await insertFileLock(transaction, {
        id: 'lock-1',
        lineageId: lineage.id,
        organizationId: workspace.organizationId ?? null,
        customerId: null,
        projectId: null,
        workspaceId: workspace.workspaceId,
        workspaceType: workspace.workspaceType,
        path: 'notes.md',
        revisionId: revision.id,
        lockedByUserId: 'user-1',
        lockedBySessionId: 'session-1',
        lockType: 'edit',
        expiresAt: 1_000,
        nowMs: 100,
      });
      return { lineage, revision, document, lock };
    }, async () => connection);

    assert.equal(first.revision.revisionNumber, 1);
    assert.equal(first.document.lineageId, first.lineage.id);
    assert.equal(first.lock.lineageId, first.lineage.id);

    await withFileCollaborationTransaction(async (transaction) => {
      await lockFileCollaborationPaths(transaction, workspace.workspaceId, ['notes.md']);
      const lineage = await ensureActiveFileLineage(transaction, {
        id: 'unused-conflicting-id',
        workspace,
        path: 'notes.md',
        nowMs: 200,
      });
      assert.equal(lineage.id, first.lineage.id);

      const revision = await appendFileRevision(transaction, {
        id: 'revision-2',
        lineageId: lineage.id,
        workspace,
        path: 'notes.md',
        contentHash: 'hash-2',
        sizeBytes: 5,
        createdByActorType: 'agent',
        sourceSessionId: 'agent-session',
        baseRevisionId: first.revision.id,
        nowMs: 200,
      });
      assert.equal(revision.revisionNumber, 2);
      assert.equal((await getLatestFileRevisionForLineage(transaction, lineage.id))?.id, revision.id);

      const refreshed = await refreshFileLock(transaction, first.lock.id, 2_000, 200);
      assert.equal(refreshed?.expiresAt, 2_000);
      assert.equal((await getActiveFileLock(transaction, workspace.workspaceId, 'notes.md', 200))?.id, first.lock.id);

      const checkpoint = await updateCollaborationDocumentCheckpoint(transaction, first.document.id, revision.id, 200);
      assert.equal(checkpoint?.snapshotRevisionId, revision.id);
      assert.equal(checkpoint?.stateVersion, 1);
      assert.equal((await getActiveCollaborationDocument(transaction, workspace.workspaceId, 'notes.md', 'yjs'))?.id, first.document.id);
    }, async () => connection);

    await assert.rejects(
      withFileCollaborationTransaction(async (transaction) => {
        await ensureActiveFileLineage(transaction, {
          id: 'rollback-lineage',
          workspace,
          path: 'rollback.md',
          nowMs: 300,
        });
        throw new Error('rollback sentinel');
      }, async () => connection),
      /rollback sentinel/u,
    );
    const rolledBack = await postgres.query<{ count: number }>(`
      SELECT COUNT(*)::int AS count
      FROM file_collaboration_lineages
      WHERE id = 'rollback-lineage'
    `);
    assert.equal(rolledBack.rows[0]?.count, 0);

    await withFileCollaborationTransaction(async (transaction) => {
      await expireFileLocksForPath(transaction, workspace.workspaceId, 'notes.md', 2_001);
      assert.equal(await getActiveFileLock(transaction, workspace.workspaceId, 'notes.md', 2_001), null);
      const released = await updateFileLockStatus(transaction, first.lock.id, 'released', 2_002);
      assert.equal(released, null, 'an expired lock must not be released a second time');
    }, async () => connection);
  } finally {
    await postgres.close();
  }

  console.log('file-collaboration-repository-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
