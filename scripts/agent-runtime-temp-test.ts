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
      acquireAgentRuntimeTempLease,
      assertAgentRuntimeTempQuota,
      cleanupAgentRuntimeTempDirs,
      ensureAgentRuntimeTempDir,
      getAgentRuntimeTempEnv,
      getAgentRuntimeTempPromptBlock,
      inspectAgentRuntimeTempUsage,
      readAgentRuntimeTempLimits,
      resolveAgentRuntimeTempDir,
      resolveAgentRuntimeTempRoot,
    } = await import('../app/lib/pi/agent-runtime-temp');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const {
      assertAgentPathAllowed,
      copyAgentPaths,
      deleteAgentPaths,
      moveAgentPaths,
      writeAgentBinaryFile,
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
    const writableContext = {
      ...context,
      canWrite: true,
      canDelete: true,
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

      const binaryPath = path.join(runtimeTempDir, 'calc', 'artifact.bin');
      const binary = await writeAgentBinaryFile({
        path: binaryPath,
        content: Buffer.from([0, 1, 2, 255]),
      });
      assert.equal(binary.snapshot, null);
      assert.deepEqual(await fs.readFile(binaryPath), Buffer.from([0, 1, 2, 255]));

      const tempCopyPath = path.join(runtimeTempDir, 'copy', 'scratch-copy.py');
      await copyAgentPaths({ sourcePaths: [tempFile], destinationPath: tempCopyPath });
      assert.equal(await fs.readFile(tempCopyPath, 'utf8'), 'print("temporary v2")\n');

      await deleteAgentPaths({ paths: [tempFile, binaryPath, tempCopyPath] });
    });
    await assert.rejects(fs.stat(tempFile));
    assert.equal((await fs.stat(runtimeTempDir)).mode & 0o777, 0o700);

    assert.deepEqual(
      readAgentRuntimeTempLimits({
        CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES: '32',
        CANVAS_AGENT_RUNTIME_TEMP_MAX_FILES: '2',
      }),
      { maxBytes: 32, maxFiles: 2 },
    );

    const quotaContext = { ...context, sessionId: 'quota-session' };
    const quotaDir = resolveAgentRuntimeTempDir(quotaContext);
    await ensureAgentRuntimeTempDir(quotaContext);
    await fs.writeFile(path.join(quotaDir, 'existing.bin'), Buffer.alloc(4));
    await assertAgentRuntimeTempQuota(quotaDir, { limits: { maxBytes: 4, maxFiles: 1 } });
    await assert.rejects(
      () => assertAgentRuntimeTempQuota(quotaDir, {
        additionalBytes: 1,
        limits: { maxBytes: 4, maxFiles: 1 },
      }),
      /temp quota exceeded.*5 bytes.*4-byte session limit/,
    );
    await assert.rejects(
      () => assertAgentRuntimeTempQuota(quotaDir, {
        additionalFiles: 1,
        limits: { maxBytes: 100, maxFiles: 1 },
      }),
      /temp quota exceeded.*2 files.*1-file session limit/,
    );

    const quotaOutsideFile = path.join(tempRoot, 'quota-outside.bin');
    await fs.writeFile(quotaOutsideFile, Buffer.alloc(128));
    await fs.symlink(quotaOutsideFile, path.join(quotaDir, 'outside-link'));
    const quotaUsage = await inspectAgentRuntimeTempUsage(quotaDir);
    assert.equal(quotaUsage.files, 2);
    assert.equal(
      quotaUsage.bytes,
      4 + Buffer.byteLength(quotaOutsideFile),
      'quota accounting must count a symlink, not its target',
    );

    const previousMaxBytes = process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES;
    process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES = '3';
    const enforcedQuotaContext = { ...context, sessionId: 'enforced-quota-session' };
    const enforcedQuotaPath = path.join(resolveAgentRuntimeTempDir(enforcedQuotaContext), 'too-large.txt');
    try {
      await runWithAgentExecutionContext(enforcedQuotaContext, async () => {
        await assert.rejects(
          () => writeAgentTextFile({ path: enforcedQuotaPath, content: 'four' }),
          /temp quota exceeded/,
        );
      });
    } finally {
      if (previousMaxBytes === undefined) delete process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES;
      else process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES = previousMaxBytes;
    }
    await assert.rejects(fs.stat(enforcedQuotaPath));

    await runWithAgentExecutionContext(context, async () => {
      await assert.rejects(
        () => writeAgentTextFile({
          path: 'workspace-blocked.txt',
          content: 'blocked\n',
        }),
        /writes are disabled/,
      );

      const blockedPromotionSource = path.join(runtimeTempDir, 'blocked-promotion.txt');
      await writeAgentTextFile({ path: blockedPromotionSource, content: 'not delivered\n' });
      await assert.rejects(
        () => copyAgentPaths({
          sourcePaths: [blockedPromotionSource],
          destinationPath: 'blocked-promotion.txt',
        }),
        /writes are disabled/,
      );
    });

    const copyPromotionSource = path.join(runtimeTempDir, 'copy-final.txt');
    const movePromotionSource = path.join(runtimeTempDir, 'move-final.txt');
    await runWithAgentExecutionContext(writableContext, async () => {
      await writeAgentTextFile({ path: copyPromotionSource, content: 'copied final\n' });
      await copyAgentPaths({
        sourcePaths: [copyPromotionSource],
        destinationPath: 'delivered/copied-final.txt',
      });
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'delivered', 'copied-final.txt'), 'utf8'), 'copied final\n');
      assert.equal(await fs.readFile(copyPromotionSource, 'utf8'), 'copied final\n');

      await writeAgentTextFile({ path: movePromotionSource, content: 'moved final\n' });
      await moveAgentPaths({
        sourcePaths: [movePromotionSource],
        destinationPath: 'delivered/moved-final.txt',
      });
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'delivered', 'moved-final.txt'), 'utf8'), 'moved final\n');
      await assert.rejects(fs.stat(movePromotionSource));
    });

    const otherSessionContext = { ...context, sessionId: 'another-session' };
    const otherSessionFile = path.join(resolveAgentRuntimeTempDir(otherSessionContext), 'private.txt');
    await fs.mkdir(path.dirname(otherSessionFile), { recursive: true });
    await fs.writeFile(otherSessionFile, 'other session\n');
    await runWithAgentExecutionContext(context, async () => {
      await assert.rejects(
        () => assertAgentPathAllowed(otherSessionFile),
        /limited to the workspace bound to this chat session/,
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

    const nowMs = Date.now();
    const oldInactiveDir = path.join(resolveAgentRuntimeTempRoot(), 'org-runtime-temp-org', 'user-runtime-temp-user', 'agent-analysis-agent', 'session-old-inactive');
    const oldActiveDir = path.join(resolveAgentRuntimeTempRoot(), 'org-runtime-temp-org', 'user-runtime-temp-user', 'agent-analysis-agent', 'session-old-active');
    const oldLeasedDir = path.join(resolveAgentRuntimeTempRoot(), 'org-runtime-temp-org', 'user-runtime-temp-user', 'agent-analysis-agent', 'session-old-leased');
    const recentInactiveDir = path.join(resolveAgentRuntimeTempRoot(), 'org-runtime-temp-org', 'user-runtime-temp-user', 'agent-analysis-agent', 'session-recent-inactive');
    await fs.mkdir(oldInactiveDir, { recursive: true });
    await fs.mkdir(oldActiveDir, { recursive: true });
    await fs.mkdir(oldLeasedDir, { recursive: true });
    await fs.mkdir(recentInactiveDir, { recursive: true });
    const cleanupOutsideFile = path.join(tempRoot, 'cleanup-outside.txt');
    await fs.writeFile(cleanupOutsideFile, 'must survive cleanup\n');
    await fs.symlink(cleanupOutsideFile, path.join(oldInactiveDir, 'outside-link'));
    const oldDate = new Date(nowMs - 10_000);
    await fs.utimes(oldInactiveDir, oldDate, oldDate);
    await fs.utimes(oldActiveDir, oldDate, oldDate);
    await fs.utimes(oldLeasedDir, oldDate, oldDate);
    const releaseOldLease = acquireAgentRuntimeTempLease(oldLeasedDir);
    const cleanup = await cleanupAgentRuntimeTempDirs({
      nowMs,
      retentionMs: 5_000,
      activeDirs: [runtimeTempDir, oldActiveDir],
      force: true,
    });
    assert.ok(cleanup.deleted.includes(oldInactiveDir));
    await assert.rejects(fs.stat(oldInactiveDir));
    assert.equal(await fs.readFile(cleanupOutsideFile, 'utf8'), 'must survive cleanup\n');
    await fs.stat(oldActiveDir);
    await fs.stat(oldLeasedDir);
    await fs.stat(recentInactiveDir);
    await fs.stat(runtimeTempDir);
    releaseOldLease();
    const cleanupAfterLease = await cleanupAgentRuntimeTempDirs({
      nowMs,
      retentionMs: 5_000,
      activeDirs: [runtimeTempDir, oldActiveDir],
      force: true,
    });
    assert.ok(cleanupAfterLease.deleted.includes(oldLeasedDir));
    await assert.rejects(fs.stat(oldLeasedDir));

    const symlinkIdentity = { ...context, organizationId: 'symlink-parent', sessionId: 'blocked' };
    const symlinkDir = resolveAgentRuntimeTempDir(symlinkIdentity);
    const symlinkOrgDir = path.join(resolveAgentRuntimeTempRoot(), 'org-symlink-parent');
    const symlinkOutsideDir = path.join(tempRoot, 'symlink-outside');
    await fs.mkdir(symlinkOutsideDir, { recursive: true });
    await fs.symlink(symlinkOutsideDir, symlinkOrgDir);
    await assert.rejects(
      () => ensureAgentRuntimeTempDir(symlinkIdentity),
      /must not contain symbolic links/,
    );
    await assert.rejects(fs.stat(symlinkDir));

    console.log('agent-runtime-temp-test: ok');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
