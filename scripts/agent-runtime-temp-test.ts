import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-runtime-temp-'));
  const dataRoot = path.join(tempRoot, 'data');
  const workspaceRoot = path.join(tempRoot, 'workspace');
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;

  try {
    await fs.mkdir(workspaceRoot, { recursive: true });

    const {
      getAgentRuntimeTempEnv,
      getAgentRuntimeTempPromptBlock,
      resolveAgentRuntimeTempDir,
    } = await import('../app/lib/pi/agent-runtime-temp');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const {
      assertAgentPathAllowed,
      deleteAgentPaths,
      writeAgentTextFile,
    } = await import('../app/lib/pi/agent-file-operations');

    const context = {
      userId: 'runtime-temp-user',
      sessionId: 'runtime-temp-session',
      agentId: 'analysis-agent',
      workspaceId: 'runtime-temp-workspace',
      workspaceType: 'team' as const,
      workspaceName: 'Runtime Temp Workspace',
      organizationId: 'runtime-temp-org',
      customerId: null,
      projectId: null,
      workspaceRoot,
      workspaceRootRelativePath: null,
      canWrite: false,
      canDelete: false,
      canShare: false,
      legacy: false,
    };

    const runtimeTempDir = resolveAgentRuntimeTempDir(context);
    assert.equal(
      runtimeTempDir,
      path.join(dataRoot, 'temp', 'agent-runtime', 'org-runtime-temp-org', 'user-runtime-temp-user', 'agent-analysis-agent', 'session-runtime-temp-session'),
    );
    assert.equal(getAgentRuntimeTempEnv(runtimeTempDir).TMPDIR, runtimeTempDir);
    assert.match(getAgentRuntimeTempPromptBlock(context), /Temporary runtime directory:/);
    assert.match(getAgentRuntimeTempPromptBlock(context), new RegExp(runtimeTempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const tempFile = path.join(runtimeTempDir, 'calc', 'scratch.py');
    await runWithAgentExecutionContext(context, async () => {
      const written = await writeAgentTextFile({
        path: tempFile,
        content: 'print("temporary")\n',
      });
      assert.equal(written.resolvedPath, tempFile);
      await assertAgentPathAllowed(tempFile);

      const overwritten = await writeAgentTextFile({
        path: tempFile,
        content: 'print("temporary v2")\n',
      });
      assert.equal(overwritten.resolvedPath, tempFile);

      await deleteAgentPaths({ paths: [tempFile] });
    });
    await assert.rejects(fs.stat(tempFile));

    await runWithAgentExecutionContext(context, async () => {
      await assert.rejects(
        () => writeAgentTextFile({
          path: 'workspace-blocked.txt',
          content: 'blocked\n',
        }),
        /writes are disabled/,
      );
    });

    const outsideRoot = path.join(tempRoot, 'outside');
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.mkdir(runtimeTempDir, { recursive: true });
    await fs.symlink(outsideRoot, path.join(runtimeTempDir, 'escape-link'));
    await runWithAgentExecutionContext(context, async () => {
      await assert.rejects(
        () => writeAgentTextFile({
          path: path.join(runtimeTempDir, 'escape-link', 'blocked.txt'),
          content: 'blocked',
        }),
        /runtime temp mutations are limited/,
      );
    });

    console.log('agent-runtime-temp-test: ok');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
