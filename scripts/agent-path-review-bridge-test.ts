import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-path-review-'));
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  const workspaceRoot = path.join(dataRoot, 'workspace');
  await fs.mkdir(path.join(workspaceRoot, 'out'), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'copy.md'), '# copy');
  await fs.writeFile(path.join(workspaceRoot, 'move.md'), '# move');
  await fs.writeFile(path.join(workspaceRoot, 'delete.md'), '# delete');

  const calls: Array<{ kind: string; idempotencyKey?: string; selections: Array<{ sourcePath: string; destinationPath?: string }> }> = [];
  let submissionMode: 'needs_review' | 'blocked' = 'needs_review';
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/files/workspace-operation-review-service') {
      return { submitAgentWorkspacePathOperation: async (input: (typeof calls)[number]) => {
        calls.push(input);
        return submissionMode === 'blocked'
          ? { mode: 'blocked', reviewId: `review-${calls.length}`, planId: `plan-${calls.length}`,
              workspaceId: 'agent-review-workspace', status: 'blocked',
              code: 'PREVIEW_UNSUPPORTED_OVERWRITE', message: 'Overwrite requires a complete reviewed executor.' }
          : { mode: 'needs_review', reviewId: `review-${calls.length}`, planId: `plan-${calls.length}`,
              workspaceId: 'agent-review-workspace', status: 'pending' };
      } };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const { copyAgentPaths, moveAgentPaths, deleteAgentPaths } = await import('../app/lib/pi/agent-file-operations');
    const { formatPathOperationResult } = await import('../app/lib/pi/tool-file-formatters');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { resolveAgentRuntimeTempDir } = await import('../app/lib/pi/agent-runtime-temp');
    const context = {
      userId: 'agent-review-user', sessionId: 'agent-review-session', agentId: 'canvas-agent',
      workspaceId: 'agent-review-workspace', workspaceType: 'personal' as const,
      workspaceName: 'Review Test', organizationId: null, customerId: null, projectId: null,
      workspaceRoot, workspaceRootRelativePath: null,
      canWrite: true, canDelete: true, canShare: false, legacy: false,
    };

    await runWithAgentExecutionContext(context, async () => {
      const copy = await copyAgentPaths({
        sourcePaths: ['copy.md'], destinationPath: 'out/copy.md', idempotencyKey: 'copy-tool-call',
      });
      assert.equal(copy.review?.reviewId, 'review-1');
      assert.equal(copy.review?.planId, 'plan-1');
      assert.equal(copy.review?.workspaceId, context.workspaceId);
      assert.equal(copy.changed, false);
      assert.equal(copy.linkStatus, null);
      assert.deepEqual(copy.operationIds, ['review-1']);
      assert.match(formatPathOperationResult(copy), /Review pending: review-1/u);
      assert.match(formatPathOperationResult(copy), /Review plan: plan-1/u);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'copy.md'), 'utf8'), '# copy');
      await assert.rejects(fs.stat(path.join(workspaceRoot, 'out', 'copy.md')), { code: 'ENOENT' });
      assert.equal(calls[0].kind, 'copy');
      assert.equal(calls[0].idempotencyKey, 'copy-tool-call');
      assert.deepEqual(calls[0].selections, [{ sourcePath: 'copy.md', destinationPath: 'out/copy.md' }]);

      const move = await moveAgentPaths({
        sourcePaths: ['move.md'], destinationPath: 'out/move.md', idempotencyKey: 'move-tool-call',
      });
      assert.equal(move.review?.reviewId, 'review-2');
      assert.equal(move.changed, false);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'move.md'), 'utf8'), '# move');
      await assert.rejects(fs.stat(path.join(workspaceRoot, 'out', 'move.md')), { code: 'ENOENT' });
      assert.equal(calls[1].kind, 'move');
      assert.equal(calls[1].idempotencyKey, 'move-tool-call');

      const removal = await deleteAgentPaths({ paths: ['delete.md'], idempotencyKey: 'delete-tool-call' });
      assert.equal(removal.review?.reviewId, 'review-3');
      assert.equal(removal.changed, false);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'delete.md'), 'utf8'), '# delete');
      assert.equal(calls[2].kind, 'delete');
      assert.equal(calls[2].idempotencyKey, 'delete-tool-call');
      assert.deepEqual(calls[2].selections, [{ sourcePath: 'delete.md' }]);

      submissionMode = 'blocked';
      await fs.writeFile(path.join(workspaceRoot, 'out', 'copy.md'), '# previous');
      const blocked = await copyAgentPaths({
        sourcePaths: ['copy.md'], destinationPath: 'out/copy.md', overwrite: true,
      });
      assert.equal(blocked.review?.status, 'blocked');
      assert.equal(blocked.review?.reviewId, 'review-4');
      assert.equal(blocked.review?.planId, 'plan-4');
      assert.equal(blocked.review?.code, 'PREVIEW_UNSUPPORTED_OVERWRITE');
      assert.equal(blocked.changed, false);
      assert.match(formatPathOperationResult(blocked), /cannot be accepted \(PREVIEW_UNSUPPORTED_OVERWRITE\)/u);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'out', 'copy.md'), 'utf8'), '# previous');

      const tempPath = path.join(resolveAgentRuntimeTempDir(context), 'temp.md');
      await fs.mkdir(path.dirname(tempPath), { recursive: true });
      await fs.writeFile(tempPath, '# temp');
      const callCount = calls.length;
      await assert.rejects(() => copyAgentPaths({
        sourcePaths: ['move.md', tempPath], destinationPath: 'out',
      }), { code: 'AGENT_PATH_REVIEW_UNSUPPORTED_SCOPE' });
      assert.equal(calls.length, callCount, 'mixed scope must fail before review submission or writes');
      await assert.rejects(fs.stat(path.join(workspaceRoot, 'out', 'move.md')), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(workspaceRoot, 'out', 'temp.md')), { code: 'ENOENT' });
    });
    console.log('agent-path-review-bridge-test: pending review, no mutation, idempotency, blocked overwrite and mixed scope passed');
  } finally {
    moduleInternals._load = originalLoad;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
