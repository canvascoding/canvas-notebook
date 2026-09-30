import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';

import type * as Service from '../app/lib/files/workspace-file-operation-service';

async function harness() {
  const file = path.resolve('app/lib/files/workspace-file-operation-service.ts');
  const source = ts.transpileModule(await fs.readFile(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true },
  }).outputText;
  const controls = {
    coverageComplete: true, collision: false, status: 'complete',
    throwExecution: false, known: null as Record<string, unknown> | null,
    metrics: [] as Array<Record<string, unknown>>,
  };
  class WorkspacePreviewBlockedError extends Error {}
  class WorkspacePreviewStaleError extends Error {}
  const service = { exports: {} as typeof Service };
  const load = createRequire(file);
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/filesystem/workspace-files') return {
      withWorkspaceCopyMutationLocks: (_source: unknown, _destination: unknown, run: () => Promise<unknown>) => run(),
      readFile: async () => Buffer.from(''), copyFileBetweenWorkspaces: async () => ({}),
    };
    if (name === '@/app/lib/markdown/workspace-file-operation-preview') return {
      WorkspacePreviewBlockedError, WorkspacePreviewStaleError,
      assertFreshWorkspaceFileOperationPlan: (plan: { planId: string; readiness: string }, id: string) => {
        if (plan.planId !== id) throw new WorkspacePreviewStaleError();
        if (plan.readiness !== 'ready') throw new WorkspacePreviewBlockedError();
      },
      buildWorkspaceFileOperationPreview: async () => ({ planId: 'plan-one', kind: 'move',
        pathMappings: [{ sourcePath: 'a.md', destinationPath: 'b.md' }], linkEdits: [],
        coverage: { complete: controls.coverageComplete,
          omittedSources: controls.coverageComplete ? [] : [{ path: 'big.md', reason: 'source-too-large' }],
          unresolvedLinks: [] },
        collisions: controls.collision ? [{ path: 'b.md', workspaceId: 'workspace-one' }] : [],
        readiness: controls.coverageComplete && !controls.collision ? 'ready' : 'blocked',
      }),
    };
    if (name === '@/app/lib/markdown/workspace-link-write-groups') return {
      groupWorkspaceLinkWrites: () => [],
    };
    if (name === '@/app/lib/markdown/workspace-link-write-executor') return {
      preflightWorkspaceLinkWrites: async () => undefined,
      probeWorkspaceLinkWriteGroup: async () => undefined,
      applyWorkspaceLinkWriteGroup: async () => undefined,
    };
    if (name === './collaboration-policy') return { initializeCopiedFileCollaborationPaths: async () => undefined };
    if (name === './workspace-operation-observability') return {
      observeWorkspaceOperation: (input: Record<string, unknown>) => { controls.metrics.push(input); },
    };
    if (name === './workspace-file-operation-executor') return {
      createWorkspaceFileOperationExecutor: () => ({
        execute: async () => {
          if (controls.throwExecution) throw new Error('executor failed');
          return { status: controls.status };
        },
        recover: async () => ({ status: controls.status }),
      }),
    };
    if (name === './workspace-operation-journal') return { WorkspaceOperationJournal: class {
      async get() { return controls.known; }
    } };
    if (name === './workspace-operation-path-probe') return {
      probeWorkspacePathOperation: async () => undefined,
      probeWorkspacePathSelectionOperation: async () => undefined,
    };
    if (name === './workspace-operation-staging') return { WorkspaceOperationStaging: class {} };
    if (name === './rename-service') return { renameWorkspacePath: async () => ({}) };
    if (name === './workspace-operation-backup') return { captureWorkspaceOperationBackup: async () => ({ backupId: 'backup' }) };
    return load(name);
  }, service, service.exports);
  const workspace = { workspaceId: 'workspace-one', status: 'active', permissions: {
    canRead: true, canWrite: true, canDelete: true,
  } };
  const scope = { workspace, fileOptions: { workspace } } as Parameters<typeof service.exports.executeWorkspaceFileOperationService>[0]['source'];
  const execute = () => service.exports.executeWorkspaceFileOperationService({
    kind: 'move', source: scope, destination: scope,
    selections: [{ sourcePath: 'a.md', destinationPath: 'b.md' }],
    actorUserId: 'user-one', actorId: 'user-one', actorDisplayName: 'User',
  });
  return { controls, execute };
}

test('direct operation reports incomplete link coverage before blocking', async () => {
  const h = await harness(); h.controls.coverageComplete = false;
  await assert.rejects(h.execute(), { name: 'Error' });
  assert.deepEqual(h.controls.metrics, [{ scope: 'executor', kind: 'move', phase: 'preview',
    outcome: 'incomplete_link_plan', omittedSourceCount: 1, unresolvedLinkCount: 0 }]);
});

test('direct operation reports conflict and recovery outcomes without path labels', async () => {
  const h = await harness(); h.controls.collision = true;
  await assert.rejects(h.execute());
  assert.deepEqual(h.controls.metrics, [{ scope: 'executor', kind: 'move', phase: 'preview', outcome: 'conflict' }]);

  const recovered = await harness(); recovered.controls.status = 'needs_recovery';
  const result = await recovered.execute();
  assert.equal(result.execution.status, 'needs_recovery');
  assert.deepEqual(recovered.controls.metrics, [{ scope: 'executor', kind: 'move', phase: 'apply', outcome: 'needs_recovery' }]);
});

test('direct operation records unexpected executor failure without swallowing it', async () => {
  const h = await harness(); h.controls.throwExecution = true;
  await assert.rejects(h.execute(), /executor failed/u);
  assert.deepEqual(h.controls.metrics, [{ scope: 'executor', kind: 'move', phase: 'apply', outcome: 'failed' }]);
});
