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
  const postgresSql = (sql: string) => {
    let parameterIndex = 0;
    return sql.replaceAll('?', () => `$${++parameterIndex}`);
  };
  return {
    get: async (sql, params = []) => (await postgres.query(postgresSql(sql), params)).rows[0],
    run: async (sql, params = []) => {
      const result = await postgres.query(postgresSql(sql), params);
      return { changes: result.affectedRows ?? 0 };
    },
    all: async (sql, params = []) => (await postgres.query(postgresSql(sql), params)).rows,
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

async function insertYjsState(
  postgres: PGlite,
  params: { documentId: string; workspaceId: string; organizationId: string | null; path: string; nowMs: number },
): Promise<void> {
  await postgres.query(`
    INSERT INTO collaboration_yjs_states (
      document_id, workspace_id, organization_id, path, representation,
      lifecycle_generation, schema_version, yjs_state, state_vector,
      document_sequence, persisted_at, checkpoint_sequence, newline_style,
      has_bom, degraded, status
    )
    VALUES ($1, $2, $3, $4, 'plain_text', 1, 1, decode('', 'hex'),
      decode('', 'hex'), 0, $5, 0, 'lf', 0, 0, 'active')
  `, [params.documentId, params.workspaceId, params.organizationId, params.path, params.nowMs]);
}

async function insertExcalidrawState(
  postgres: PGlite,
  params: { documentId: string; workspaceId: string; organizationId: string | null; path: string; nowMs: number },
): Promise<void> {
  await postgres.query(`
    INSERT INTO collaboration_excalidraw_states (
      document_id, workspace_id, organization_id, path, excalidraw_version,
      scene_schema_version, elements_json, shared_app_state_json, assets_json,
      scene_sequence, checkpoint_sequence, canonical_hash, persisted_at, status
    )
    VALUES ($1, $2, $3, $4, '0.18.1', 1, '[]'::jsonb, '{}'::jsonb,
      '[]'::jsonb, 0, 0, $5, $6, 'active')
  `, [params.documentId, params.workspaceId, params.organizationId, params.path, `hash-${params.documentId}`, params.nowMs]);
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
      archiveFileCollaborationPaths,
      assertFileCollaborationWriteAllowed,
      detectFileCollaborationStrategy,
      ensureFileRevisionForCurrentContent,
      expireActiveFileLocks,
      getFileCollaborationState,
      initializeCopiedFileCollaborationPaths,
      moveFileCollaborationPath,
      releaseFileLock,
      restoreFileCollaborationPath,
    } = await import('../app/lib/files/collaboration-policy');
    const { moveExcalidrawScenePaths } = await import('../app/lib/excalidraw-collaboration/repository');
    const { moveWorkspaceFileMetadataOnConnection } = await import('../app/lib/files/workspace-file-metadata');

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
    await insertYjsState(postgres, {
      documentId: markdownState.document!.id,
      workspaceId: workspace.workspaceId,
      organizationId: workspace.organizationId ?? null,
      path: 'notes.md',
      nowMs: 10_001,
    });
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

    const originalLock = await acquireFileLock({
      workspace,
      path: 'notes.md',
      lockedByUserId: 'user-a',
      lockType: 'edit',
      baseRevisionId: secondRevision.id,
      nowMs: 10_005,
    });
    const conflictCopyRevision = await ensureFileRevisionForCurrentContent({
      workspace,
      path: 'notes.local-copy.md',
      contentHash: 'notes-conflict-copy-hash',
      sizeBytes: 20,
      actorUserId: 'user-b',
      actorType: 'user',
      nowMs: 10_006,
    });
    await archiveFileCollaborationPaths({
      workspace,
      paths: [{ path: 'notes.md', trashEntryId: 'trash-original-notes' }],
      nowMs: 10_007,
    });
    await moveFileCollaborationPath({
      workspace,
      oldPath: 'notes.local-copy.md',
      newPath: 'notes.md',
      nowMs: 10_008,
    });
    const replacementState = await getFileCollaborationState({
      workspace,
      path: 'notes.md',
      nowMs: 10_009,
    });
    assert.equal(replacementState.latestRevision?.id, conflictCopyRevision.id);
    assert.equal(replacementState.activeLock, null);

    await restoreFileCollaborationPath({
      workspace,
      path: 'notes.md',
      trashEntryId: 'trash-original-notes',
      nowMs: 10_010,
    });
    const restoredState = await getFileCollaborationState({
      workspace,
      path: 'notes.md',
      nowMs: 10_011,
    });
    assert.equal(restoredState.latestRevision?.id, secondRevision.id);
    assert.equal(restoredState.activeLock, null);
    const restoredYjsState = await postgres.query<{ status: string; lifecycle_generation: number; path: string }>(`
      SELECT status, lifecycle_generation, path
      FROM collaboration_yjs_states
      WHERE document_id = $1
    `, [markdownState.document!.id]);
    assert.equal(restoredYjsState.rows[0]?.status, 'active');
    assert.equal(Number(restoredYjsState.rows[0]?.lifecycle_generation), 3);
    assert.equal(restoredYjsState.rows[0]?.path, 'notes.md');
    const archivedLock = await postgres.query<{ status: string }>(`
      SELECT status FROM file_locks WHERE id = $1
    `, [originalLock.lock.id]);
    assert.equal(archivedLock.rows[0]?.status, 'released');

    const copiedRevision = await ensureFileRevisionForCurrentContent({
      workspace,
      path: 'copied.md',
      contentHash: 'copied-hash',
      sizeBytes: 7,
      actorType: 'system',
      nowMs: 10_012,
    });
    await initializeCopiedFileCollaborationPaths({
      workspace,
      paths: ['copied.md'],
      nowMs: 10_013,
    });
    const copiedState = await getFileCollaborationState({
      workspace,
      path: 'copied.md',
      nowMs: 10_014,
    });
    assert.notEqual(copiedRevision.lineageId, null);
    assert.equal(copiedState.latestRevision, null);

    const folderTextRevision = await ensureFileRevisionForCurrentContent({
      workspace,
      path: 'folder/readme.md',
      contentHash: 'folder-readme-hash',
      sizeBytes: 9,
      actorType: 'system',
      nowMs: 11_000,
    });
    const folderPdfRevision = await ensureFileRevisionForCurrentContent({
      workspace,
      path: 'folder/assets/manual.pdf',
      contentHash: 'folder-manual-hash',
      sizeBytes: 10,
      actorType: 'system',
      nowMs: 11_001,
    });
    const folderTextState = await getFileCollaborationState({
      workspace,
      path: 'folder/readme.md',
      nowMs: 11_001,
    });
    await insertYjsState(postgres, {
      documentId: folderTextState.document!.id,
      workspaceId: workspace.workspaceId,
      organizationId: workspace.organizationId ?? null,
      path: 'folder/readme.md',
      nowMs: 11_001,
    });
    await acquireFileLock({
      workspace,
      path: 'folder/assets/manual.pdf',
      lockedByUserId: 'folder-editor',
      lockType: 'edit',
      baseRevisionId: folderPdfRevision.id,
      nowMs: 11_002,
    });
    await archiveFileCollaborationPaths({
      workspace,
      paths: [{ path: 'folder', trashEntryId: 'trash-folder' }],
      nowMs: 11_003,
    });
    const archivedFolderText = await getFileCollaborationState({
      workspace,
      path: 'folder/readme.md',
      nowMs: 11_004,
    });
    assert.equal(archivedFolderText.latestRevision, null);
    assert.equal(archivedFolderText.document, null);

    await restoreFileCollaborationPath({
      workspace,
      path: 'folder',
      trashEntryId: 'trash-folder',
      nowMs: 11_005,
    });
    const restoredFolderText = await getFileCollaborationState({
      workspace,
      path: 'folder/readme.md',
      nowMs: 11_006,
    });
    const restoredFolderPdf = await getFileCollaborationState({
      workspace,
      path: 'folder/assets/manual.pdf',
      nowMs: 11_006,
    });
    assert.equal(restoredFolderText.latestRevision?.id, folderTextRevision.id);
    assert.equal(restoredFolderText.document?.provider, 'yjs');
    assert.equal(restoredFolderPdf.latestRevision?.id, folderPdfRevision.id);
    assert.equal(restoredFolderPdf.activeLock, null);

    await moveFileCollaborationPath({
      workspace,
      oldPath: 'folder',
      newPath: 'renamed-folder',
      nowMs: 11_007,
    });
    const movedFolderText = await getFileCollaborationState({
      workspace,
      path: 'renamed-folder/readme.md',
      nowMs: 11_008,
    });
    assert.equal(movedFolderText.latestRevision?.id, folderTextRevision.id);
    assert.equal(movedFolderText.document?.provider, 'yjs');
    const movedFolderYjsState = await postgres.query<{ status: string; path: string }>(`
      SELECT status, path
      FROM collaboration_yjs_states
      WHERE document_id = $1
    `, [folderTextState.document!.id]);
    assert.equal(movedFolderYjsState.rows[0]?.status, 'active');
    assert.equal(movedFolderYjsState.rows[0]?.path, 'renamed-folder/readme.md');

    await insertExcalidrawState(postgres, {
      documentId: 'nested-excalidraw',
      workspaceId: workspace.workspaceId,
      organizationId: workspace.organizationId ?? null,
      path: 'drawings/set_1/hi.excalidraw',
      nowMs: 11_009,
    });
    await insertExcalidrawState(postgres, {
      documentId: 'wildcard-sibling-excalidraw',
      workspaceId: workspace.workspaceId,
      organizationId: workspace.organizationId ?? null,
      path: 'drawings/setX1/untouched.excalidraw',
      nowMs: 11_009,
    });
    await moveExcalidrawScenePaths({
      workspaceId: workspace.workspaceId,
      oldPath: 'drawings/set_1',
      newPath: 'drawings/renamed-set',
    });
    const movedExcalidrawStates = await postgres.query<{ document_id: string; path: string }>(`
      SELECT document_id, path
      FROM collaboration_excalidraw_states
      WHERE document_id = ANY($1::text[])
      ORDER BY document_id
    `, [['nested-excalidraw', 'wildcard-sibling-excalidraw']]);
    assert.deepEqual(movedExcalidrawStates.rows, [
      { document_id: 'nested-excalidraw', path: 'drawings/renamed-set/hi.excalidraw' },
      { document_id: 'wildcard-sibling-excalidraw', path: 'drawings/setX1/untouched.excalidraw' },
    ]);

    await postgres.query(`
      INSERT INTO workspace_file_metadata (workspace_id, path, title, created_at, updated_at)
      VALUES
        ($1, 'metadata/set_1/nested.md', 'Nested', 11010, 11010),
        ($1, 'metadata/setX1/untouched.md', 'Untouched', 11010, 11010)
    `, [workspace.workspaceId]);
    await moveWorkspaceFileMetadataOnConnection(connection, {
      workspaceId: workspace.workspaceId,
      oldPath: 'metadata/set_1',
      newPath: 'metadata/renamed-set',
    });
    const movedMetadata = await postgres.query<{ path: string; title: string }>(`
      SELECT path, title
      FROM workspace_file_metadata
      WHERE workspace_id = $1 AND title IN ('Nested', 'Untouched')
      ORDER BY title
    `, [workspace.workspaceId]);
    assert.deepEqual(movedMetadata.rows, [
      { path: 'metadata/renamed-set/nested.md', title: 'Nested' },
      { path: 'metadata/setX1/untouched.md', title: 'Untouched' },
    ]);

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
