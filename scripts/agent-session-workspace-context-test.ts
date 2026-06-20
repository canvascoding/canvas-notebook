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
    const { user, piSessions } = await import('../app/lib/db/schema');
    const {
      resolveAgentExecutionContextForSession,
      resolveAgentSessionWorkspaceForUser,
      workspaceToPiSessionFields,
    } = await import('../app/lib/pi/session-workspace-context');
    const {
      detectUnsafeBashCommand,
      getAgentWorkspaceRoot,
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
    assert.equal(executionContext.workspaceId, workspace.workspaceId);
    assert.equal(executionContext.workspaceRoot, workspace.rootPath);

    await runWithAgentExecutionContext(executionContext, async () => {
      assert.equal(getAgentWorkspaceRoot(), workspace.rootPath);
      assert.equal(detectUnsafeBashCommand('./run-tests.sh > results.txt'), null);
      assert.equal(detectUnsafeBashCommand('npm run build 2>&1 | tee build.log'), null);

      const result = await writeAgentTextFile({
        path: 'notes/context.md',
        content: '# Session Workspace\n',
      });
      assert.equal(result.resolvedPath, path.join(workspace.rootPath, 'notes', 'context.md'));
      assert.equal(await fs.readFile(result.resolvedPath, 'utf8'), '# Session Workspace\n');

      await assert.rejects(
        () => assertAgentPathAllowed(path.join(dataRoot, 'workspaces', 'personal', 'other-user', 'files', 'secret.md')),
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
