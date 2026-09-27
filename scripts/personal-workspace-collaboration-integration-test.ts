import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { SqlConnection } from '../app/lib/db';

if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) {
  console.log('personal-workspace-collaboration-integration-test: skipped (Postgres test profile is not enabled)');
  process.exit(0);
}

const databaseUrl = new URL(process.env.DATABASE_URL);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname));
assert.match(databaseUrl.pathname, /^\/canvas_editor_test_[0-9a-f]{32}$/u,
  'This test requires a disposable collaboration database, never the shared local stack database.');

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-personal-collaboration-'));
  const originalDataRoot = process.env.DATA;
  const originalCanvasDataRoot = process.env.CANVAS_DATA_ROOT;
  process.env.DATA = path.join(tempRoot, 'data');
  process.env.CANVAS_DATA_ROOT = process.env.DATA;

  const suffix = randomUUID();
  const workspace: WorkspaceContext = {
    workspaceId: `personal-collaboration-workspace-${suffix}`,
    workspaceType: 'personal',
    ownerUserId: `personal-collaboration-user-${suffix}`,
    rootPath: path.join(tempRoot, 'workspace'),
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
  const filePath = 'personal-source.md';
  const initialContent = '# Personal source\n\n<div>Preserve exactly</div>\n';
  let documentId: string | null = null;
  let openDatabase: (() => Promise<SqlConnection>) | null = null;
  let closeConnections: (() => Promise<void>) | null = null;

  try {
    const [
      { materializeCollaborationCheckpoint },
      { loadCollaborationState, persistCollaborationYDoc },
      { createCollaborationSessionGrant },
      { openDb, closeDatabaseConnections },
      {
        assertFileCollaborationWriteAllowed,
        ensureFileRevisionForCurrentContent,
        FileCollaborationPolicyError,
        getFileCollaborationState,
      },
      { readFile, writeFile },
      { sha256Buffer },
    ] = await Promise.all([
      import('../app/lib/collaboration/checkpoint'),
      import('../app/lib/collaboration/persistence'),
      import('../app/lib/collaboration/session-service'),
      import('../app/lib/db'),
      import('../app/lib/files/collaboration-policy'),
      import('../app/lib/filesystem/workspace-files'),
      import('../app/lib/files/revision-guard'),
    ]);
    openDatabase = openDb;
    closeConnections = closeDatabaseConnections;

    await fs.mkdir(workspace.rootPath, { recursive: true });
    await writeFile(filePath, initialContent, { workspace });
    const initialBuffer = Buffer.from(initialContent);
    const initialRevision = await ensureFileRevisionForCurrentContent({
      workspace,
      path: filePath,
      contentHash: sha256Buffer(initialBuffer),
      sizeBytes: initialBuffer.length,
      actorUserId: workspace.ownerUserId,
      actorType: 'user',
    });
    const projection = await getFileCollaborationState({
      workspace,
      path: filePath,
      ensureDocument: false,
    });
    assert.equal(projection.crdtCapable, true);
    assert.equal(projection.requiresRevisionCheck, false);
    assert.equal(projection.document?.provider, 'yjs');
    documentId = projection.document?.id ?? null;
    assert(documentId);

    const grant = await createCollaborationSessionGrant({
      workspace,
      fileOptions: { workspace },
      request: { path: filePath, provider: 'yjs', representation: 'auto' },
    });
    assert.equal(grant.documentId, documentId);
    assert.equal(grant.representation, 'plain_text');
    assert.equal(grant.permission, 'write');

    const state = await loadCollaborationState(documentId);
    assert(state);
    assert.equal(state.workspaceId, workspace.workspaceId);
    assert.equal(state.organizationId, null);
    const Y = await import('yjs');
    const document = new Y.Doc({ gc: true });
    try {
      Y.applyUpdate(document, state.yjsState);
      document.getText('content').insert(initialContent.length, '\nPersonal Yjs update.');
      const persisted = await persistCollaborationYDoc(
        documentId,
        state.lifecycleGeneration,
        document,
      );
      const canonicalContent = document.getText('content').toString();
      const checkpoint = await materializeCollaborationCheckpoint({
        state: persisted,
        workspace,
        actorUserId: workspace.ownerUserId,
        actorType: 'user',
        sourceSessionId: `personal-session-${suffix}`,
      });
      assert.equal((await readFile(filePath, { workspace })).toString('utf8'), canonicalContent);
      assert.equal(checkpoint.content, canonicalContent);
    } finally {
      document.destroy();
    }

    const checkpointProjection = await getFileCollaborationState({
      workspace,
      path: filePath,
      ensureDocument: false,
    });
    assert.equal(checkpointProjection.document?.id, documentId);
    assert.notEqual(checkpointProjection.document?.snapshotRevisionId, initialRevision.id);
    await assert.rejects(
      () => assertFileCollaborationWriteAllowed({
        workspace,
        path: filePath,
        actorUserId: workspace.ownerUserId,
        baseRevisionId: checkpointProjection.latestRevision?.id,
      }),
      (error) => error instanceof FileCollaborationPolicyError
        && error.code === 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED',
    );
  } catch (error) {
    console.error('Personal collaboration integration failed before cleanup:', error);
    throw error;
  } finally {
    try {
      if (documentId && openDatabase) {
        const database = await openDatabase();
        try {
          await database.run('DELETE FROM collaboration_yjs_state_backups WHERE document_id = $1', [documentId]);
          await database.run('DELETE FROM collaboration_yjs_states WHERE document_id = $1', [documentId]);
        } finally {
          await database.close();
        }
      }
    } finally {
      try { await closeConnections?.(); }
      finally {
        if (originalDataRoot === undefined) delete process.env.DATA;
        else process.env.DATA = originalDataRoot;
        if (originalCanvasDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
        else process.env.CANVAS_DATA_ROOT = originalCanvasDataRoot;
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    }
  }
}

void main().then(
  () => console.log('personal-workspace-collaboration-integration-test: ok'),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
