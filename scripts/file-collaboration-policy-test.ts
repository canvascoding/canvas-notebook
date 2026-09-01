import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WorkspaceContext } from '../app/lib/workspaces/types';

function workspaceContext(params: {
  rootPath: string;
  workspaceId: string;
  workspaceType: WorkspaceContext['workspaceType'];
  organizationId?: string | null;
}): WorkspaceContext {
  return {
    workspaceId: params.workspaceId,
    workspaceType: params.workspaceType,
    rootPath: params.rootPath,
    rootRelativePath: path.relative(path.dirname(params.rootPath), params.rootPath),
    displayName: params.workspaceType,
    status: 'active',
    organizationId: params.organizationId ?? null,
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

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-file-collab-'));
  const dataRoot = path.join(tempRoot, 'data');
  const originalDatabaseProvider = process.env.CANVAS_DATABASE_PROVIDER;
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

  try {
    const teamRoot = path.join(dataRoot, 'workspaces', 'team', 'org-collab', 'files');
    await fs.mkdir(teamRoot, { recursive: true });

    const workspace = workspaceContext({
      rootPath: teamRoot,
      workspaceId: 'ws-collab',
      workspaceType: 'team',
      organizationId: 'org-collab',
    });

    const {
      FileCollaborationPolicyError,
      acquireFileLock,
      archiveFileCollaborationPaths,
      assertFileCollaborationWriteAllowed,
      detectFileCollaborationStrategy,
      ensureFileRevisionForCurrentContent,
      expireActiveFileLocks,
      getFileCollaborationState,
      moveFileCollaborationPath,
      releaseFileLock,
      restoreFileCollaborationPath,
    } = await import('../app/lib/files/collaboration-policy');
    const { writeFile } = await import('../app/lib/filesystem/workspace-files');
    const { sha256Buffer } = await import('../app/lib/files/revision-guard');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { writeAgentTextFile } = await import('../app/lib/pi/agent-file-operations');

    process.env.CANVAS_DATABASE_PROVIDER = 'postgres';

    assert.equal(detectFileCollaborationStrategy('notes.md'), 'crdt_text');
    assert.equal(detectFileCollaborationStrategy('notes.txt'), 'crdt_text');
    assert.equal(detectFileCollaborationStrategy('board.excalidraw'), 'excalidraw_scene');
    assert.equal(detectFileCollaborationStrategy('data.json'), 'revision_check');
    assert.equal(detectFileCollaborationStrategy('brief.pdf'), 'exclusive_lock');
    assert.equal(detectFileCollaborationStrategy('slides.pptx'), 'exclusive_lock');

    await writeFile('notes.md', '# V1\n', { workspace });
    const notesBuffer = Buffer.from('# V1\n');
    const initialRevision = ensureFileRevisionForCurrentContent({
      workspace,
      path: 'notes.md',
      contentHash: sha256Buffer(notesBuffer),
      sizeBytes: notesBuffer.length,
      actorUserId: 'user-a',
      actorType: 'user',
      nowMs: 10_000,
    });

    const markdownState = getFileCollaborationState({
      workspace,
      path: 'notes.md',
      ensureDocument: true,
      nowMs: 10_001,
    });
    assert.equal(markdownState.strategy, 'crdt_text');
    assert.equal(markdownState.crdtCapable, true);
    assert.equal(markdownState.requiresRevisionCheck, true);
    assert.equal(markdownState.document?.provider, 'yjs');
    assert.equal(markdownState.document?.snapshotRevisionId, initialRevision.id);

    const personalRoot = path.join(dataRoot, 'users', 'user-personal', 'files');
    await fs.mkdir(personalRoot, { recursive: true });
    const personalWorkspace: WorkspaceContext = {
      ...workspaceContext({
        rootPath: personalRoot,
        workspaceId: 'ws-personal',
        workspaceType: 'personal',
      }),
      ownerUserId: 'user-personal',
    };
    await writeFile('personal.md', '# Personal\n', { workspace: personalWorkspace });
    const personalBuffer = Buffer.from('# Personal\n');
    process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
    const personalRevision = ensureFileRevisionForCurrentContent({
      workspace: personalWorkspace,
      path: 'personal.md',
      contentHash: sha256Buffer(personalBuffer),
      sizeBytes: personalBuffer.length,
      actorUserId: 'user-personal',
      actorType: 'user',
      nowMs: 10_001,
    });
    const personalBeforePostgres = getFileCollaborationState({
      workspace: personalWorkspace,
      path: 'personal.md',
      ensureDocument: false,
      nowMs: 10_002,
    });
    assert.equal(personalBeforePostgres.crdtCapable, false);
    assert.equal(personalBeforePostgres.document, null);

    process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
    const migratedPersonalRevision = ensureFileRevisionForCurrentContent({
      workspace: personalWorkspace,
      path: 'personal.md',
      contentHash: sha256Buffer(personalBuffer),
      sizeBytes: personalBuffer.length,
      actorUserId: 'user-personal',
      actorType: 'user',
      nowMs: 10_003,
    });
    assert.equal(migratedPersonalRevision.id, personalRevision.id);
    const personalPostgresState = getFileCollaborationState({
      workspace: personalWorkspace,
      path: 'personal.md',
      ensureDocument: false,
      nowMs: 10_004,
    });
    assert.equal(personalPostgresState.crdtCapable, true);
    assert.equal(personalPostgresState.requiresRevisionCheck, false);
    assert.equal(personalPostgresState.lockRequired, false);
    assert.equal(personalPostgresState.document?.provider, 'yjs');
    assert.equal(personalPostgresState.document?.snapshotRevisionId, personalRevision.id);
    assert.throws(
      () => assertFileCollaborationWriteAllowed({
        workspace: personalWorkspace,
        path: 'personal.md',
        actorUserId: 'user-personal',
        baseRevisionId: personalRevision.id,
        nowMs: 10_005,
      }),
      (error) => error instanceof FileCollaborationPolicyError
        && error.code === 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED',
    );

    const personalDrawingState = getFileCollaborationState({
      workspace: personalWorkspace,
      path: 'personal.excalidraw',
      ensureDocument: true,
      nowMs: 10_006,
    });
    assert.equal(personalDrawingState.sceneCapable, false);
    assert.equal(personalDrawingState.document, null);

    const drawingContent = '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}';
    await writeFile('board.excalidraw', drawingContent, { workspace });
    const drawingBuffer = Buffer.from(drawingContent);
    const drawingRevision = ensureFileRevisionForCurrentContent({
      workspace,
      path: 'board.excalidraw',
      contentHash: sha256Buffer(drawingBuffer),
      sizeBytes: drawingBuffer.length,
      actorUserId: 'user-a',
      actorType: 'user',
      nowMs: 10_001,
    });
    const drawingState = getFileCollaborationState({
      workspace,
      path: 'board.excalidraw',
      ensureDocument: true,
      nowMs: 10_002,
    });
    assert.equal(drawingState.sceneCapable, true);
    assert.equal(drawingState.crdtCapable, false);
    assert.equal(drawingState.document?.provider, 'excalidraw');
    assert.equal(drawingState.document?.snapshotRevisionId, drawingRevision.id);
    assert.throws(
      () => assertFileCollaborationWriteAllowed({
        workspace,
        path: 'board.excalidraw',
        actorUserId: 'user-a',
        baseRevisionId: drawingRevision.id,
        nowMs: 10_003,
      }),
      (error) => error instanceof FileCollaborationPolicyError
        && error.code === 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED',
    );

    assert.throws(
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

    const secondBuffer = Buffer.from('# V2\n');
    const secondRevision = ensureFileRevisionForCurrentContent({
      workspace,
      path: 'notes.md',
      contentHash: sha256Buffer(secondBuffer),
      sizeBytes: secondBuffer.length,
      actorUserId: 'user-a',
      actorType: 'user',
      baseRevisionId: initialRevision.id,
      nowMs: 10_003,
    });
    assert.notEqual(secondRevision.id, initialRevision.id);

    assert.throws(
      () => assertFileCollaborationWriteAllowed({
        workspace,
        path: 'notes.md',
        actorUserId: 'user-b',
        baseRevisionId: initialRevision.id,
        nowMs: 10_004,
      }),
      (error) => error instanceof FileCollaborationPolicyError && error.code === 'FILE_REVISION_ID_CONFLICT',
    );

    // Regression: a conflict copy can replace a deleted original at the same
    // path without inheriting that file's revision stream or active lock.
    const originalLock = acquireFileLock({
      workspace,
      path: 'notes.md',
      lockedByUserId: 'user-a',
      lockType: 'edit',
      ttlMs: 60_000,
      baseRevisionId: secondRevision.id,
      nowMs: 10_005,
    });
    assert.equal(originalLock.lock.status, 'active');

    const conflictCopyBuffer = Buffer.from('# Local conflict copy\n');
    const conflictCopyRevision = ensureFileRevisionForCurrentContent({
      workspace,
      path: 'notes.local-copy.md',
      contentHash: sha256Buffer(conflictCopyBuffer),
      sizeBytes: conflictCopyBuffer.length,
      actorUserId: 'user-b',
      actorType: 'user',
      nowMs: 10_006,
    });
    assert.notEqual(conflictCopyRevision.lineageId, secondRevision.lineageId);

    archiveFileCollaborationPaths({
      workspace,
      paths: [{ path: 'notes.md', trashEntryId: 'trash-original-notes' }],
      nowMs: 10_007,
    });
    moveFileCollaborationPath({
      workspace,
      oldPath: 'notes.local-copy.md',
      newPath: 'notes.md',
      nowMs: 10_008,
    });

    const replacedState = getFileCollaborationState({
      workspace,
      path: 'notes.md',
      nowMs: 10_009,
    });
    assert.equal(replacedState.latestRevision?.id, conflictCopyRevision.id);
    assert.equal(replacedState.activeLock, null);
    assert.throws(
      () => assertFileCollaborationWriteAllowed({
        workspace,
        path: 'notes.md',
        actorUserId: 'user-b',
        baseRevisionId: conflictCopyRevision.id,
        nowMs: 10_010,
      }),
      (error) => error instanceof FileCollaborationPolicyError
        && error.code === 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED',
    );

    const continuedCopyBuffer = Buffer.from('# Local conflict copy, continued\n');
    const continuedCopyRevision = ensureFileRevisionForCurrentContent({
      workspace,
      path: 'notes.md',
      contentHash: sha256Buffer(continuedCopyBuffer),
      sizeBytes: continuedCopyBuffer.length,
      actorUserId: 'user-b',
      actorType: 'user',
      baseRevisionId: conflictCopyRevision.id,
      nowMs: 10_011,
    });
    assert.equal(continuedCopyRevision.baseRevisionId, conflictCopyRevision.id);
    assert.equal(continuedCopyRevision.lineageId, conflictCopyRevision.lineageId);

    archiveFileCollaborationPaths({
      workspace,
      paths: [{ path: 'notes.md', trashEntryId: 'trash-conflict-copy-notes' }],
      nowMs: 10_012,
    });
    restoreFileCollaborationPath({
      workspace,
      path: 'notes.md',
      trashEntryId: 'trash-original-notes',
      nowMs: 10_013,
    });
    const restoredState = getFileCollaborationState({
      workspace,
      path: 'notes.md',
      nowMs: 10_014,
    });
    assert.equal(restoredState.latestRevision?.id, secondRevision.id);
    assert.equal(restoredState.activeLock, null);

    await writeFile('brief.pdf', Buffer.from('%PDF-locked\n'), { workspace });
    const pdfBuffer = Buffer.from('%PDF-locked\n');
    const pdfRevision = ensureFileRevisionForCurrentContent({
      workspace,
      path: 'brief.pdf',
      contentHash: sha256Buffer(pdfBuffer),
      sizeBytes: pdfBuffer.length,
      actorType: 'system',
      nowMs: 20_000,
    });
    assert.throws(
      () => assertFileCollaborationWriteAllowed({
        workspace,
        path: 'brief.pdf',
        actorUserId: 'user-a',
        baseRevisionId: pdfRevision.id,
        nowMs: 20_000,
      }),
      (error) => error instanceof FileCollaborationPolicyError && error.code === 'FILE_LOCK_REQUIRED',
    );
    const firstLock = acquireFileLock({
      workspace,
      path: 'brief.pdf',
      lockedByUserId: 'user-a',
      lockType: 'edit',
      ttlMs: 60_000,
      baseRevisionId: pdfRevision.id,
      nowMs: 20_001,
    });
    assert.equal(firstLock.lock.lockedByUserId, 'user-a');
    assert.equal(firstLock.state.activeLock?.id, firstLock.lock.id);
    assert.doesNotThrow(() => assertFileCollaborationWriteAllowed({
      workspace,
      path: 'brief.pdf',
      actorUserId: 'user-a',
      baseRevisionId: pdfRevision.id,
      nowMs: 20_002,
    }));
    assert.throws(
      () => releaseFileLock({
        workspace,
        lockId: firstLock.lock.id,
        actorUserId: 'user-b',
        nowMs: 20_003,
      }),
      (error) => error instanceof FileCollaborationPolicyError
        && error.code === 'FILE_LOCK_PERMISSION_DENIED'
        && error.status === 403,
    );

    assert.throws(
      () => assertFileCollaborationWriteAllowed({
        workspace,
        path: 'brief.pdf',
        actorUserId: 'user-b',
        baseRevisionId: pdfRevision.id,
        nowMs: 20_004,
      }),
      (error) => error instanceof FileCollaborationPolicyError && error.code === 'FILE_LOCKED',
    );

    expireActiveFileLocks({ workspace, path: 'brief.pdf', nowMs: 90_002 });
    assert.throws(
      () => assertFileCollaborationWriteAllowed({
        workspace,
        path: 'brief.pdf',
        actorUserId: 'user-b',
        baseRevisionId: pdfRevision.id,
        nowMs: 90_003,
      }),
      (error) => error instanceof FileCollaborationPolicyError && error.code === 'FILE_LOCK_REQUIRED',
    );
    acquireFileLock({
      workspace,
      path: 'brief.pdf',
      lockedByUserId: 'user-b',
      lockType: 'edit',
      ttlMs: 60_000,
      baseRevisionId: pdfRevision.id,
      nowMs: 90_004,
    });
    assert.doesNotThrow(() => assertFileCollaborationWriteAllowed({
      workspace,
      path: 'brief.pdf',
      actorUserId: 'user-b',
      baseRevisionId: pdfRevision.id,
      nowMs: 90_005,
    }));

    process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
    const personalSqliteState = getFileCollaborationState({
      workspace: personalWorkspace,
      path: 'personal.md',
      ensureDocument: true,
      nowMs: 90_006,
    });
    assert.equal(personalSqliteState.crdtCapable, false);
    assert.equal(personalSqliteState.document, null);

    const agentNow = Date.now();
    await writeFile('agent.md', 'agent v1\n', { workspace });
    const agentBuffer = Buffer.from('agent v1\n');
    const agentRevision = ensureFileRevisionForCurrentContent({
      workspace,
      path: 'agent.md',
      contentHash: sha256Buffer(agentBuffer),
      sizeBytes: agentBuffer.length,
      actorType: 'system',
      nowMs: agentNow,
    });
    acquireFileLock({
      workspace,
      path: 'agent.md',
      lockedByUserId: 'human-editor',
      lockType: 'edit',
      ttlMs: 60_000,
      baseRevisionId: agentRevision.id,
      nowMs: agentNow + 1,
    });

    const agentContext = {
      userId: 'agent-owner',
      sessionId: 'agent-session',
      agentId: 'canvas-agent',
      workspaceId: workspace.workspaceId,
      workspaceType: workspace.workspaceType,
      workspaceName: workspace.displayName ?? null,
      organizationId: workspace.organizationId ?? null,
      customerId: null,
      projectId: null,
      workspaceRoot: workspace.rootPath,
      workspaceRootRelativePath: workspace.rootRelativePath ?? null,
      canWrite: true,
      canDelete: true,
      canShare: true,
      legacy: false,
    };

    await runWithAgentExecutionContext(agentContext, async () => {
      await assert.rejects(
        () => writeAgentTextFile({
          path: 'agent.md',
          content: 'agent v2\n',
          expectedSha256: sha256Buffer(agentBuffer),
        }),
        /locked by another active editor/i,
      );
    });

    console.log('file-collaboration-policy-test: ok');
  } finally {
    if (originalDatabaseProvider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = originalDatabaseProvider;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
