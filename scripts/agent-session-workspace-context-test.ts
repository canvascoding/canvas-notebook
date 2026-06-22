import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-session-workspace-'));
  const dataRoot = path.join(tempRoot, 'data');
  process.env.DATA = dataRoot;
  process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';

  try {
    await fs.mkdir(dataRoot, { recursive: true });

    const { db } = await import('../app/lib/db');
    const { user, piSessions, auditEvents } = await import('../app/lib/db/schema');
    const {
      resolveAgentExecutionContextForSession,
      resolveAgentSessionWorkspaceForUser,
      workspaceToPiSessionFields,
    } = await import('../app/lib/pi/session-workspace-context');
    const {
      detectUnsafeBashCommand,
      getAgentWorkspaceRoot,
      resolveAgentPath,
      copyAgentPaths,
      deleteAgentPaths,
      moveAgentPaths,
      writeAgentTextFile,
      assertAgentPathAllowed,
    } = await import('../app/lib/pi/agent-file-operations');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');

    const now = new Date();
    const userId = 'user-agent-workspace';
    await db.insert(user).values({
      id: userId,
      name: 'Agent Workspace Tester',
      email: 'agent-workspace@example.test',
      emailVerified: true,
      image: null,
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    });

    const workspace = await resolveAgentSessionWorkspaceForUser({ userId });
    assert.equal(workspace.workspaceType, 'personal');
    assert.equal(workspace.permissions.canRead, true);
    assert.equal(workspace.permissions.canWrite, true);
    assert.equal(workspace.rootPath, path.join(dataRoot, 'workspaces', 'personal', userId, 'files'));
    await fs.access(workspace.rootPath);

    const sessionId = 'sess-agent-workspace';
    await db.insert(piSessions).values({
      sessionId,
      userId,
      agentId: 'canvas-agent',
      provider: 'test-provider',
      model: 'test-model',
      thinkingLevel: 'off',
      title: 'Workspace-bound session',
      channelId: 'app',
      channelSessionKey: null,
      createdAt: now,
      updatedAt: now,
      ...workspaceToPiSessionFields(workspace),
    });

    const executionContext = await resolveAgentExecutionContextForSession({
      sessionId,
      userId,
      agentId: 'canvas-agent',
    });
    assert.equal(executionContext.agentId, 'canvas-agent');
    assert.equal(executionContext.workspaceId, workspace.workspaceId);
    assert.equal(executionContext.workspaceRoot, workspace.rootPath);

    await runWithAgentExecutionContext(executionContext, async () => {
      assert.equal(getAgentWorkspaceRoot(), workspace.rootPath);
      assert.equal(resolveAgentPath('/data/workspace/legacy-alias.md'), path.join(workspace.rootPath, 'legacy-alias.md'));
      assert.equal(detectUnsafeBashCommand('./run-tests.sh > results.txt'), null);
      assert.equal(detectUnsafeBashCommand('npm run build 2>&1 | tee build.log'), null);
      assert.equal(detectUnsafeBashCommand(`cat ${path.join(workspace.rootPath, 'notes', 'context.md')}`), null);
      assert.match(
        detectUnsafeBashCommand('cat /data/workspaces/personal/other-user/files/secret.md') || '',
        /limited to the workspace bound/,
      );
      assert.match(
        detectUnsafeBashCommand('cat /data/user-uploads/audio/input.ogg') || '',
        /limited to the workspace bound/,
      );

      const result = await writeAgentTextFile({
        path: 'notes/context.md',
        content: '# Session Workspace\n',
      });
      assert.equal(result.resolvedPath, path.join(workspace.rootPath, 'notes', 'context.md'));
      assert.equal(await fs.readFile(result.resolvedPath, 'utf8'), '# Session Workspace\n');
      const writeAuditRows = await db.select().from(auditEvents);
      const writeAudit = writeAuditRows.find((row) => row.action === 'agent_file.write' && row.entityId === 'notes/context.md');
      assert.ok(writeAudit, 'Expected write audit event for notes/context.md');
      assert.equal(writeAudit.source, 'agent_tool');
      assert.equal(writeAudit.userId, userId);
      assert.equal(writeAudit.sessionId, sessionId);
      assert.equal(writeAudit.agentId, 'canvas-agent');
      assert.equal(writeAudit.workspaceId, workspace.workspaceId);
      assert.equal(writeAudit.organizationId, workspace.organizationId);
      assert.equal(writeAudit.inputHash, null);
      assert.equal(writeAudit.outputHash, result.afterSha256);
      assert.equal(writeAudit.artifactRef, `agent-file-snapshot:${result.snapshot?.id}`);
      assert.ok(writeAudit.metadataJson);
      const writeAuditMetadata = JSON.parse(writeAudit.metadataJson || '{}') as {
        resolvedPath?: string;
        workspace?: { workspaceType?: string };
        revision?: { snapshotId?: string; afterSha256?: string };
      };
      assert.equal(writeAuditMetadata.resolvedPath, 'notes/context.md');
      assert.equal(writeAuditMetadata.workspace?.workspaceType, 'personal');
      assert.equal(writeAuditMetadata.revision?.snapshotId, result.snapshot?.id);
      assert.equal(writeAuditMetadata.revision?.afterSha256, result.afterSha256);
      assert.doesNotMatch(writeAudit.metadataJson || '', /Session Workspace/);

      const symlinkWorkspaceRoot = path.join(dataRoot, 'workspaces', 'personal', userId, 'linked-files');
      await fs.symlink(workspace.rootPath, symlinkWorkspaceRoot);
      await runWithAgentExecutionContext({ ...executionContext, workspaceRoot: symlinkWorkspaceRoot }, async () => {
        assert.equal(detectUnsafeBashCommand(`cat ${path.join(workspace.rootPath, 'notes', 'context.md')}`), null);
      });

      const legacyAliasResult = await writeAgentTextFile({
        path: '/data/workspace/legacy-alias.md',
        content: '# Legacy Alias\n',
      });
      assert.equal(legacyAliasResult.resolvedPath, path.join(workspace.rootPath, 'legacy-alias.md'));
      assert.equal(await fs.readFile(path.join(workspace.rootPath, 'legacy-alias.md'), 'utf8'), '# Legacy Alias\n');

      await assert.rejects(
        () => assertAgentPathAllowed(path.join(dataRoot, 'workspaces', 'personal', 'other-user', 'files', 'secret.md')),
        /limited to the workspace bound to this chat session/,
      );

      const userUploadPath = path.join(dataRoot, 'user-uploads', 'audio', 'voice.ogg');
      await fs.mkdir(path.dirname(userUploadPath), { recursive: true });
      await fs.writeFile(userUploadPath, 'audio input');
      await assert.doesNotReject(() => assertAgentPathAllowed(userUploadPath));
      const copiedUpload = await copyAgentPaths({
        sourcePaths: [userUploadPath],
        destinationPath: 'uploads/voice.ogg',
      });
      assert.equal(copiedUpload.destinationResolvedPath, path.join(workspace.rootPath, 'uploads', 'voice.ogg'));
      assert.equal(await fs.readFile(path.join(workspace.rootPath, 'uploads', 'voice.ogg'), 'utf8'), 'audio input');
      const copyAuditRows = await db.select().from(auditEvents);
      const copyAudit = copyAuditRows.find((row) => row.action === 'agent_path.copy_path' && row.entityId === 'uploads/voice.ogg');
      assert.ok(copyAudit, 'Expected copy audit event for uploads/voice.ogg');
      assert.equal(copyAudit.source, 'agent_tool');
      assert.equal(copyAudit.userId, userId);
      assert.equal(copyAudit.sessionId, sessionId);
      assert.equal(copyAudit.agentId, 'canvas-agent');
      assert.equal(copyAudit.workspaceId, workspace.workspaceId);
      assert.ok(copyAudit.metadataJson);
      const copyAuditMetadata = JSON.parse(copyAudit.metadataJson || '{}') as {
        destinationResolvedPath?: string | null;
        workspace?: { workspaceType?: string };
        files?: number;
        entries?: Array<{ destinationResolvedPath?: string }>;
      };
      assert.equal(copyAuditMetadata.destinationResolvedPath, 'uploads/voice.ogg');
      assert.equal(copyAuditMetadata.workspace?.workspaceType, 'personal');
      assert.equal(copyAuditMetadata.files, 1);
      assert.equal(copyAuditMetadata.entries?.[0]?.destinationResolvedPath, 'uploads/voice.ogg');
      assert.doesNotMatch(copyAudit.metadataJson || '', /audio input/);

      await writeAgentTextFile({ path: 'bulk/a.txt', content: 'A\n' });
      await writeAgentTextFile({ path: 'bulk/b.txt', content: 'B\n' });
      const deletedBulk = await deleteAgentPaths({
        paths: ['bulk/a.txt', 'bulk/b.txt'],
      });
      assert.equal(deletedBulk.sourcePath, '2 paths');
      const deleteAuditRows = await db.select().from(auditEvents);
      const deleteAudit = deleteAuditRows.find((row) => row.action === 'agent_path.delete_path' && row.entityId === 'bulk/a.txt, bulk/b.txt');
      assert.ok(deleteAudit, 'Expected bulk delete audit event with concrete path entityId');
      assert.equal(deleteAudit.userId, userId);
      assert.equal(deleteAudit.sessionId, sessionId);
      assert.equal(deleteAudit.agentId, 'canvas-agent');
      assert.notEqual(deleteAudit.entityId, '2 paths');
      await assert.rejects(
        () => moveAgentPaths({
          sourcePaths: [userUploadPath],
          destinationPath: 'uploads/moved-voice.ogg',
        }),
        /writes are limited to the workspace bound/,
      );

      const outsideReadRoot = path.join(tempRoot, 'outside-read');
      await fs.mkdir(outsideReadRoot, { recursive: true });
      await fs.writeFile(path.join(outsideReadRoot, 'private.txt'), 'blocked');
      await assert.rejects(
        () => assertAgentPathAllowed(path.join(outsideReadRoot, 'private.txt')),
        /limited to the workspace bound to this chat session/,
      );

      await assert.rejects(
        () => writeAgentTextFile({
          path: path.join(dataRoot, 'workspaces', 'personal', 'other-user', 'files', 'secret.md'),
          content: 'blocked',
        }),
        /limited to the workspace bound to this chat session/,
      );

      const outsideRoot = path.join(tempRoot, 'outside');
      await fs.mkdir(outsideRoot, { recursive: true });
      await fs.symlink(outsideRoot, path.join(workspace.rootPath, 'evil-link'));
      await assert.rejects(
        () => writeAgentTextFile({
          path: 'evil-link/secret.txt',
          content: 'blocked',
        }),
        /limited to the workspace bound to this chat session/,
      );
    });

    console.log('agent-session-workspace-context-test: ok');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
