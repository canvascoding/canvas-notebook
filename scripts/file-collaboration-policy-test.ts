import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';

import type { SqlConnection } from '../app/lib/db';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import { setFileCollaborationConnectionFactoryForTests } from '../app/lib/files/collaboration-repository';
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

function workspaceContext(workspaceType: WorkspaceContext['workspaceType']): WorkspaceContext {
  return {
    workspaceId: `policy-${workspaceType}-workspace`,
    workspaceType,
    rootPath: `/tmp/policy-${workspaceType}-workspace`,
    organizationId: workspaceType === 'personal' ? null : 'policy-organization',
    ownerUserId: workspaceType === 'personal' ? 'personal-owner' : null,
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
}

async function main(): Promise<void> {
  const postgres = new PGlite();
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-file-policy-postgres-'));
  const originalData = process.env.DATA;
  const originalProvider = process.env.CANVAS_DATABASE_PROVIDER;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
  process.env.DATABASE_URL = 'postgresql://file-policy-test.invalid/canvas';

  try {
    await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const connection = connectionFor(postgres);
    setFileCollaborationConnectionFactoryForTests(async () => connection);

    const {
      FileCollaborationPolicyError,
      acquireFileLock,
      assertFileCollaborationWriteAllowed,
      detectFileCollaborationStrategy,
      ensureFileRevisionForCurrentContent,
      expireActiveFileLocks,
      getFileCollaborationState,
      releaseFileLock,
    } = await import('../app/lib/files/collaboration-policy');

    assert.equal(detectFileCollaborationStrategy('notes.md'), 'crdt_text');
    assert.equal(detectFileCollaborationStrategy('board.excalidraw'), 'excalidraw_scene');
    assert.equal(detectFileCollaborationStrategy('data.json'), 'revision_check');
    assert.equal(detectFileCollaborationStrategy('brief.pdf'), 'exclusive_lock');

    const workspace = workspaceContext('organization');
    const initialRevision = await ensureFileRevisionForCurrentContent({
      workspace,
      path: 'notes.md',
      contentHash: 'notes-hash-1',
      sizeBytes: 10,
      actorUserId: 'user-a',
      actorType: 'user',
      nowMs: 10_000,
    });
    const markdownState = await getFileCollaborationState({
      workspace,
      path: 'notes.md',
      ensureDocument: true,
      nowMs: 10_001,
    });
    assert.equal(markdownState.strategy, 'crdt_text');
    assert.equal(markdownState.crdtCapable, true);
    assert.equal(markdownState.document?.provider, 'yjs');
    assert.equal(markdownState.document?.snapshotRevisionId, initialRevision.id);
    await assert.rejects(
      () => assertFileCollaborationWriteAllowed({
        workspace,
        path: 'notes.md',
        actorUserId: 'user-a',
        baseRevisionId: initialRevision.id,
        nowMs: 10_002,
      }),
      (error) => error instanceof FileCollaborationPolicyError
        && error.code === 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED',
    );

    const secondRevision = await ensureFileRevisionForCurrentContent({
      workspace,
      path: 'notes.md',
      contentHash: 'notes-hash-2',
      sizeBytes: 11,
      actorUserId: 'user-a',
      actorType: 'user',
      baseRevisionId: initialRevision.id,
      nowMs: 10_003,
    });
    assert.notEqual(secondRevision.id, initialRevision.id);
    await assert.rejects(
      () => assertFileCollaborationWriteAllowed({
        workspace,
        path: 'notes.md',
        actorUserId: 'user-b',
        baseRevisionId: initialRevision.id,
        nowMs: 10_004,
      }),
      (error) => error instanceof FileCollaborationPolicyError
        && error.code === 'FILE_REVISION_ID_CONFLICT',
    );

    const pdfRevision = await ensureFileRevisionForCurrentContent({
      workspace,
      path: 'brief.pdf',
      contentHash: 'pdf-hash-1',
      sizeBytes: 12,
      actorType: 'system',
      nowMs: 20_000,
    });
    await assert.rejects(
      () => assertFileCollaborationWriteAllowed({
        workspace,
        path: 'brief.pdf',
        actorUserId: 'user-a',
        baseRevisionId: pdfRevision.id,
        nowMs: 20_000,
      }),
      (error) => error instanceof FileCollaborationPolicyError && error.code === 'FILE_LOCK_REQUIRED',
    );
    const firstLock = await acquireFileLock({
      workspace,
      path: 'brief.pdf',
      lockedByUserId: 'user-a',
      lockedBySessionId: 'session-a',
      lockType: 'edit',
      ttlMs: 60_000,
      baseRevisionId: pdfRevision.id,
      nowMs: 20_001,
    });
    assert.equal(firstLock.state.activeLock?.id, firstLock.lock.id);
    await assert.doesNotReject(() => assertFileCollaborationWriteAllowed({
      workspace,
      path: 'brief.pdf',
      actorUserId: 'user-a',
      actorSessionId: 'session-a',
      baseRevisionId: pdfRevision.id,
      nowMs: 20_002,
    }));
    await assert.rejects(
      () => acquireFileLock({
        workspace,
        path: 'brief.pdf',
        lockedByUserId: 'user-b',
        lockType: 'edit',
        baseRevisionId: pdfRevision.id,
        nowMs: 20_003,
      }),
      (error) => error instanceof FileCollaborationPolicyError && error.code === 'FILE_LOCKED',
    );
    await assert.rejects(
      () => releaseFileLock({
        workspace,
        lockId: firstLock.lock.id,
        actorUserId: 'user-b',
        nowMs: 20_004,
      }),
      (error) => error instanceof FileCollaborationPolicyError
        && error.code === 'FILE_LOCK_PERMISSION_DENIED',
    );

    await expireActiveFileLocks({ workspace, path: 'brief.pdf', nowMs: 90_002 });
    const replacementLock = await acquireFileLock({
      workspace,
      path: 'brief.pdf',
      lockedByUserId: 'user-b',
      lockType: 'upload',
      baseRevisionId: pdfRevision.id,
      nowMs: 90_003,
    });
    assert.equal(replacementLock.lock.lockedByUserId, 'user-b');
    assert.equal(replacementLock.lock.lockType, 'upload');
    const released = await releaseFileLock({
      workspace,
      lockId: replacementLock.lock.id,
      actorUserId: 'workspace-manager',
      force: true,
      nowMs: 90_004,
    });
    assert.equal(released.status, 'force_released');

    const personalWorkspace = workspaceContext('personal');
    const personalRevision = await ensureFileRevisionForCurrentContent({
      workspace: personalWorkspace,
      path: 'personal.md',
      contentHash: 'personal-hash-1',
      sizeBytes: 13,
      actorUserId: 'personal-owner',
      actorType: 'user',
      nowMs: 100_000,
    });
    const personalState = await getFileCollaborationState({
      workspace: personalWorkspace,
      path: 'personal.md',
      ensureDocument: true,
      nowMs: 100_001,
    });
    assert.equal(personalState.crdtCapable, true);
    assert.equal(personalState.requiresRevisionCheck, false);
    assert.equal(personalState.document?.snapshotRevisionId, personalRevision.id);

    await assert.rejects(
      fs.access(path.join(dataRoot, 'sqlite.db')),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
  } finally {
    setFileCollaborationConnectionFactoryForTests(null);
    await postgres.close();
    await fs.rm(dataRoot, { recursive: true, force: true });
    if (originalData === undefined) delete process.env.DATA;
    else process.env.DATA = originalData;
    if (originalProvider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = originalProvider;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }

  console.log('file-collaboration-policy-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
