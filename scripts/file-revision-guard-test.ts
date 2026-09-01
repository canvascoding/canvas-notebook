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
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-file-revision-guard-'));
  const dataRoot = path.join(tempRoot, 'data');
  process.env.DATA = dataRoot;

  try {
    const personalRoot = path.join(dataRoot, 'workspaces', 'personal', 'user-1', 'files');
    const teamRoot = path.join(dataRoot, 'workspaces', 'team', 'org-1', 'files');
    await fs.mkdir(personalRoot, { recursive: true });
    await fs.mkdir(teamRoot, { recursive: true });

    const personalWorkspace = workspaceContext({
      rootPath: personalRoot,
      workspaceId: 'ws-personal',
      workspaceType: 'personal',
      organizationId: 'org-1',
    });
    const teamWorkspace = workspaceContext({
      rootPath: teamRoot,
      workspaceId: 'ws-team',
      workspaceType: 'team',
      organizationId: 'org-1',
    });

    const {
      WorkspaceFileRevisionError,
      assertWorkspaceFileRevisionAllowed,
      getWorkspaceFileRevision,
      workspaceRequiresRevisionCheck,
    } = await import('../app/lib/files/revision-guard');
    const { writeFile } = await import('../app/lib/filesystem/workspace-files');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const {
      deleteAgentPath,
      editAgentFile,
      writeAgentBinaryFile,
      writeAgentTextFile,
    } = await import('../app/lib/pi/agent-file-operations');

    await writeFile('notes.md', 'personal v1\n', { workspace: personalWorkspace });
    await assert.doesNotReject(() => assertWorkspaceFileRevisionAllowed({
      path: 'notes.md',
      options: { workspace: personalWorkspace },
      requireExpectedRevision: workspaceRequiresRevisionCheck(personalWorkspace),
    }));
    await assert.rejects(() => assertWorkspaceFileRevisionAllowed({
      path: 'notes.md',
      expectedSha256: '0'.repeat(64),
      options: { workspace: personalWorkspace },
      requireExpectedRevision: workspaceRequiresRevisionCheck(personalWorkspace),
    }), (error) => error instanceof WorkspaceFileRevisionError && error.code === 'FILE_REVISION_CONFLICT');

    await fs.chmod(path.join(personalRoot, 'notes.md'), 0o640);
    await writeFile('notes.md', 'personal v2\n', { workspace: personalWorkspace });
    assert.equal(await fs.readFile(path.join(personalRoot, 'notes.md'), 'utf8'), 'personal v2\n');
    assert.equal((await fs.stat(path.join(personalRoot, 'notes.md'))).mode & 0o777, 0o640);

    await writeFile('team.md', 'team v1\n', { workspace: teamWorkspace });
    const teamRevision = await getWorkspaceFileRevision('team.md', { workspace: teamWorkspace });
    assert.ok(teamRevision?.sha256);

    await assert.rejects(
      () => assertWorkspaceFileRevisionAllowed({
        path: 'team.md',
        options: { workspace: teamWorkspace },
        requireExpectedRevision: workspaceRequiresRevisionCheck(teamWorkspace),
      }),
      (error) => error instanceof WorkspaceFileRevisionError && error.code === 'FILE_REVISION_REQUIRED' && error.status === 428,
    );

    await assert.rejects(
      () => assertWorkspaceFileRevisionAllowed({
        path: 'team.md',
        expectedSha256: '0'.repeat(64),
        options: { workspace: teamWorkspace },
        requireExpectedRevision: workspaceRequiresRevisionCheck(teamWorkspace),
      }),
      (error) => error instanceof WorkspaceFileRevisionError && error.code === 'FILE_REVISION_CONFLICT' && error.status === 409,
    );

    await assert.doesNotReject(() => assertWorkspaceFileRevisionAllowed({
      path: 'team.md',
      expectedSha256: teamRevision.sha256,
      options: { workspace: teamWorkspace },
      requireExpectedRevision: workspaceRequiresRevisionCheck(teamWorkspace),
    }));

    const agentContext = {
      userId: 'user-1',
      sessionId: 'session-1',
      agentId: 'canvas-agent',
      workspaceId: teamWorkspace.workspaceId,
      workspaceType: teamWorkspace.workspaceType,
      workspaceName: teamWorkspace.displayName ?? null,
      organizationId: teamWorkspace.organizationId ?? null,
      customerId: null,
      projectId: null,
      workspaceRoot: teamWorkspace.rootPath,
      workspaceRootRelativePath: teamWorkspace.rootRelativePath ?? null,
      canWrite: true,
      canDelete: true,
      canShare: true,
      legacy: false,
    };

    await runWithAgentExecutionContext(agentContext, async () => {
      const created = await writeAgentTextFile({
        path: 'agent-created.md',
        content: 'agent v1\n',
      });
      assert.equal(created.changed, true);

      await assert.rejects(
        () => writeAgentTextFile({
          path: 'agent-created.md',
          content: 'agent v2\n',
        }),
        /existing shared workspace files require expectedSha256/i,
      );

      const updated = await writeAgentTextFile({
        path: 'agent-created.md',
        content: 'agent v2\n',
        expectedSha256: `sha256:${created.afterSha256.toUpperCase()}`,
      });
      assert.equal(updated.changed, true);

      const edited = await editAgentFile({
        path: 'agent-created.md',
        oldText: 'agent v2\n',
        newText: 'agent v3\n',
        expectedSha256: updated.afterSha256,
      });
      assert.equal(edited.changed, true);
    });

    await writeFile('concurrent.md', 'before\n', { workspace: teamWorkspace });
    const concurrentRevision = await getWorkspaceFileRevision('concurrent.md', { workspace: teamWorkspace });
    assert.ok(concurrentRevision?.sha256);

    let releaseMcpWrite!: () => void;
    const mcpWriteCanFinish = new Promise<void>((resolve) => { releaseMcpWrite = resolve; });
    let mcpWriteReady!: () => void;
    const mcpWriteReadySignal = new Promise<void>((resolve) => { mcpWriteReady = resolve; });
    const mcpWrite = writeFile('concurrent.md', 'mcp write\n', { workspace: teamWorkspace }, async () => {
      mcpWriteReady();
      await mcpWriteCanFinish;
    });
    await mcpWriteReadySignal;

    const agentWrite = runWithAgentExecutionContext(agentContext, () => writeAgentTextFile({
      path: 'concurrent.md',
      content: 'agent write\n',
      expectedSha256: concurrentRevision.sha256,
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseMcpWrite();
    await mcpWrite;
    await assert.rejects(
      () => agentWrite,
      (error) => error instanceof WorkspaceFileRevisionError
        && error.code === 'FILE_REVISION_CONFLICT'
        && error.currentSha256 !== concurrentRevision.sha256,
    );
    assert.equal(await fs.readFile(path.join(teamRoot, 'concurrent.md'), 'utf8'), 'mcp write\n');

    await writeFile('concurrent-binary.md', 'before binary write\n', { workspace: teamWorkspace });
    const concurrentBinaryRevision = await getWorkspaceFileRevision('concurrent-binary.md', { workspace: teamWorkspace });
    assert.ok(concurrentBinaryRevision?.sha256);

    let releaseMcpBinaryWrite!: () => void;
    const mcpBinaryWriteCanFinish = new Promise<void>((resolve) => { releaseMcpBinaryWrite = resolve; });
    let mcpBinaryWriteReady!: () => void;
    const mcpBinaryWriteReadySignal = new Promise<void>((resolve) => { mcpBinaryWriteReady = resolve; });
    const mcpBinaryWrite = writeFile('concurrent-binary.md', 'mcp binary write wins\n', { workspace: teamWorkspace }, async () => {
      mcpBinaryWriteReady();
      await mcpBinaryWriteCanFinish;
    });
    await mcpBinaryWriteReadySignal;

    const agentBinaryWrite = runWithAgentExecutionContext(agentContext, () => writeAgentBinaryFile({
      path: 'concurrent-binary.md',
      content: Buffer.from('agent binary write\n'),
      expectedSha256: concurrentBinaryRevision.sha256,
      overwrite: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseMcpBinaryWrite();
    await mcpBinaryWrite;
    await assert.rejects(
      () => agentBinaryWrite,
      (error) => error instanceof WorkspaceFileRevisionError
        && error.code === 'FILE_REVISION_CONFLICT'
        && error.currentSha256 !== concurrentBinaryRevision.sha256,
    );
    assert.equal(await fs.readFile(path.join(teamRoot, 'concurrent-binary.md'), 'utf8'), 'mcp binary write wins\n');

    await writeFile('concurrent-delete.md', 'before delete\n', { workspace: teamWorkspace });
    const concurrentDeleteRevision = await getWorkspaceFileRevision('concurrent-delete.md', { workspace: teamWorkspace });
    assert.ok(concurrentDeleteRevision?.sha256);

    let releaseMcpDeleteWrite!: () => void;
    const mcpDeleteWriteCanFinish = new Promise<void>((resolve) => { releaseMcpDeleteWrite = resolve; });
    let mcpDeleteWriteReady!: () => void;
    const mcpDeleteWriteReadySignal = new Promise<void>((resolve) => { mcpDeleteWriteReady = resolve; });
    const mcpDeleteWrite = writeFile('concurrent-delete.md', 'mcp write wins\n', { workspace: teamWorkspace }, async () => {
      mcpDeleteWriteReady();
      await mcpDeleteWriteCanFinish;
    });
    await mcpDeleteWriteReadySignal;

    const agentDelete = runWithAgentExecutionContext(agentContext, () => deleteAgentPath({
      path: 'concurrent-delete.md',
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseMcpDeleteWrite();
    await mcpDeleteWrite;
    await assert.rejects(
      () => agentDelete,
      (error) => error instanceof WorkspaceFileRevisionError
        && error.code === 'FILE_REVISION_CONFLICT'
        && error.currentSha256 !== concurrentDeleteRevision.sha256,
    );
    assert.equal(await fs.readFile(path.join(teamRoot, 'concurrent-delete.md'), 'utf8'), 'mcp write wins\n');

    await fs.mkdir(path.join(teamRoot, 'concurrent-directory'));
    await writeFile('concurrent-directory/note.md', 'before directory delete\n', { workspace: teamWorkspace });
    let releaseMcpDirectoryWrite!: () => void;
    const mcpDirectoryWriteCanFinish = new Promise<void>((resolve) => { releaseMcpDirectoryWrite = resolve; });
    let mcpDirectoryWriteReady!: () => void;
    const mcpDirectoryWriteReadySignal = new Promise<void>((resolve) => { mcpDirectoryWriteReady = resolve; });
    const mcpDirectoryWrite = writeFile('concurrent-directory/note.md', 'mcp directory write wins\n', { workspace: teamWorkspace }, async () => {
      mcpDirectoryWriteReady();
      await mcpDirectoryWriteCanFinish;
    });
    await mcpDirectoryWriteReadySignal;

    const agentDirectoryDelete = runWithAgentExecutionContext(agentContext, () => deleteAgentPath({
      path: 'concurrent-directory',
      recursive: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseMcpDirectoryWrite();
    await mcpDirectoryWrite;
    await assert.rejects(
      () => agentDirectoryDelete,
      (error) => error instanceof WorkspaceFileRevisionError
        && error.code === 'FILE_REVISION_CONFLICT',
    );
    assert.equal(
      await fs.readFile(path.join(teamRoot, 'concurrent-directory', 'note.md'), 'utf8'),
      'mcp directory write wins\n',
    );

    console.log('file-revision-guard-test: ok');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
