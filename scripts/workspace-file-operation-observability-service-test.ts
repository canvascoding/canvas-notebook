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
    lifecycleBusy: false, lifecycleDepth: 0, mutationDepth: 0,
    copyCalls: 0, metadataCalls: 0, applyCopy: false,
    lifecycleScopes: [] as Array<{ workspaceId: string; paths: readonly string[] }>,
  };
  class WorkspacePreviewBlockedError extends Error {}
  class WorkspacePreviewStaleError extends Error {}
  const service = { exports: {} as typeof Service };
  const load = createRequire(file);
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === 'server-only') return {};
    if (name === './workspace-file-lifecycle-guard') return {
      withWorkspaceFileLifecycleGuards: async (scopes: typeof controls.lifecycleScopes, run: () => Promise<unknown>) => {
        assert.equal(controls.mutationDepth, 0, 'admission precedes local mutation locks');
        controls.lifecycleScopes = scopes;
        if (controls.lifecycleBusy) throw Object.assign(new Error('busy'), { status: 409, code: 'COLLABORATION_FILE_LIFECYCLE_BUSY' });
        controls.lifecycleDepth += 1;
        try { return await run(); } finally { controls.lifecycleDepth -= 1; }
      },
    };
    if (name === '@/app/lib/filesystem/workspace-files') return {
      withWorkspaceCopyMutationLocks: async (_source: unknown, _destination: unknown, run: () => Promise<unknown>) => {
        controls.mutationDepth += 1;
        try { return await run(); } finally { controls.mutationDepth -= 1; }
      },
      readFile: async () => Buffer.from(''), copyFileBetweenWorkspaces: async () => {
        assert.equal(controls.lifecycleDepth, 1);
        controls.copyCalls += 1;
        return { copied: 'b.md', skipped: false, collaborationInitialized: false };
      },
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
    if (name === './collaboration-policy') return { initializeCopiedFileCollaborationPaths: async () => {
      assert.equal(controls.lifecycleDepth, 1);
      controls.metadataCalls += 1;
    } };
    if (name === './workspace-operation-observability') return {
      observeWorkspaceOperation: (input: Record<string, unknown>) => { controls.metrics.push(input); },
    };
    if (name === './workspace-file-operation-executor') return {
      createWorkspaceFileOperationExecutor: (options: { adapters: { path: {
        applySelection: (stage: unknown, selection: { sourcePath: string; destinationPath: string }) => Promise<unknown>,
      } } }) => ({
        execute: async () => {
          if (controls.throwExecution) throw new Error('executor failed');
          if (controls.applyCopy) await options.adapters.path.applySelection(undefined, { sourcePath: 'a.md', destinationPath: 'b.md' });
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
  const execute = (kind: 'move' | 'copy' = 'move') => service.exports.executeWorkspaceFileOperationService({
    kind, source: scope, destination: scope,
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

test('selection copy rejects busy admission before filesystem work and retains the guard through metadata', async () => {
  const h = await harness(); h.controls.applyCopy = true; h.controls.lifecycleBusy = true;
  await assert.rejects(h.execute('copy'), { code: 'COLLABORATION_FILE_LIFECYCLE_BUSY' });
  assert.equal(h.controls.copyCalls, 0);
  assert.equal(h.controls.metadataCalls, 0);
  h.controls.lifecycleBusy = false;
  const result = await h.execute('copy');
  assert.equal(result.execution.status, 'complete');
  assert.equal(h.controls.copyCalls, 1);
  assert.equal(h.controls.metadataCalls, 1);
  assert.deepEqual(h.controls.lifecycleScopes, [
    { workspaceId: 'workspace-one', paths: ['a.md'] },
    { workspaceId: 'workspace-one', paths: ['b.md'] },
  ]);
  assert.equal(h.controls.lifecycleDepth, 0);
  assert.equal(h.controls.mutationDepth, 0);
});
