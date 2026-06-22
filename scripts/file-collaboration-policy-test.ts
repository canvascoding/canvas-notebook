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
  process.env.DATA = dataRoot;

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
      assertFileCollaborationWriteAllowed,
      detectFileCollaborationStrategy,
      ensureFileRevisionForCurrentContent,
      expireActiveFileLocks,
      getFileCollaborationState,
      releaseFileLock,
    } = await import('../app/lib/files/collaboration-policy');
    const { writeFile } = await import('../app/lib/filesystem/workspace-files');
    const { sha256Buffer } = await import('../app/lib/files/revision-guard');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { writeAgentTextFile } = await import('../app/lib/pi/agent-file-operations');

    assert.equal(detectFileCollaborationStrategy('notes.md'), 'crdt_text');
    assert.equal(detectFileCollaborationStrategy('notes.txt'), 'crdt_text');
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

    assert.doesNotThrow(() => assertFileCollaborationWriteAllowed({
      workspace,
      path: 'notes.md',
      actorUserId: 'user-a',
      baseRevisionId: initialRevision.id,
      nowMs: 10_002,
    }));

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
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
