import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';

import type * as Service from '../app/lib/files/workspace-file-operation-service';
import type * as Journal from '../app/lib/files/workspace-operation-journal';
import { captureWorkspaceOperationCopyOrigin } from '../app/lib/files/workspace-operation-copy-origin';

type Input = Service.WorkspaceFileOperationServiceInput;
type LinkInput = { actorUserId: string; actorId: string; actorSessionId?: string;
  source: Input['source']; destination: Input['destination'] };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function harness() {
  const file = path.resolve('app/lib/files/workspace-file-operation-service.ts');
  const source = ts.transpileModule(await fs.readFile(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true },
  }).outputText;
  // Use the production serializer, while making accidental DB access in this
  // adapter-focused unit harness an explicit failure.
  const journalFile = path.resolve('app/lib/files/workspace-operation-journal.ts');
  const journalModule = { exports: {} as typeof Journal };
  const journalLoad = createRequire(journalFile);
  new Function('require', 'module', 'exports', ts.transpileModule(await fs.readFile(journalFile, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText)((name: string) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db') return { openDb: () => assert.fail('Pure service test cannot access a database.') };
    return journalLoad(name);
  }, journalModule, journalModule.exports);
  const serialize = journalModule.exports.serializeWorkspaceOperationRequest;
  const controls = {
    coverageComplete: true, collision: false, status: 'complete',
    throwExecution: false, known: null as Record<string, unknown> | null,
    metrics: [] as Array<Record<string, unknown>>,
    lifecycleBusy: false, lifecycleDepth: 0, mutationDepth: 0,
    copyCalls: 0, metadataCalls: 0, executeCalls: 0, applyCopy: false,
    nativeCopy: false,
    copyBindings: [] as Array<{ mutationOperationId: string; mutationActorUserId: string; mutationActorSessionId?: string }>,
    destinationPath: 'b.md', changedDestinationPath: null as string | null,
    previewCalls: 0, blockedPath: null as string | null,
    lifecycleScopes: [] as Array<{ workspaceId: string; paths: readonly string[] }>,
    guardCalls: 0, getCalls: 0, recoveryCalls: 0,
    onFirstGet: null as (() => Promise<void>) | null,
    applyOnRecovery: false, applyLinks: false,
    requests: [] as Journal.WorkspaceOperationRequest[],
    serializations: [] as ReturnType<typeof serialize>[],
    previewInputs: [] as Array<{ sourceOptions: Input['source']['fileOptions']; destinationOptions: Input['destination']['fileOptions'] }>,
    linkInputs: [] as LinkInput[],
    copyOptions: [] as Array<{ source: Input['source']['fileOptions']; target: Input['destination']['fileOptions'] }>,
  };
  class WorkspacePreviewBlockedError extends Error {}
  class WorkspacePreviewStaleError extends Error {}
  const service = { exports: {} as typeof Service };
  const load = createRequire(file);
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === 'server-only') return {};
    if (name === './workspace-file-lifecycle-guard') return {
      withWorkspaceFileLifecycleGuards: async (scopes: typeof controls.lifecycleScopes, run: () => Promise<unknown>) => {
        controls.guardCalls += 1;
        assert.equal(controls.mutationDepth, 0, 'admission precedes local mutation locks');
        controls.lifecycleScopes = scopes;
        if (controls.lifecycleBusy) throw Object.assign(new Error('busy'), { status: 409, code: 'COLLABORATION_FILE_LIFECYCLE_BUSY' });
        if (controls.blockedPath && scopes.some(scope => scope.paths.includes(controls.blockedPath!))) {
          throw Object.assign(new Error('busy selected path'), { status: 409, code: 'COLLABORATION_FILE_LIFECYCLE_BUSY' });
        }
        controls.lifecycleDepth += 1;
        try { return await run(); } finally { controls.lifecycleDepth -= 1; }
      },
    };
    if (name === '@/app/lib/filesystem/workspace-files') return {
      withWorkspaceCopyMutationLocks: async (_source: unknown, _destination: unknown, run: () => Promise<unknown>) => {
        controls.mutationDepth += 1;
        try { return await run(); } finally { controls.mutationDepth -= 1; }
      },
      readFile: async () => Buffer.from(''), copyFileBetweenWorkspaces: async (_source: string, _directory: string,
        _overwrite: boolean, _rename: boolean, options: { source: Input['source']['fileOptions'];
          target: Input['destination']['fileOptions'] & typeof controls.copyBindings[number] }) => {
        assert.equal(controls.lifecycleDepth, 1);
        controls.copyCalls += 1;
        controls.copyBindings.push(options.target);
        controls.copyOptions.push(options);
        return { copied: controls.destinationPath, skipped: false, collaborationInitialized: controls.nativeCopy };
      },
    };
    if (name === '@/app/lib/markdown/workspace-file-operation-preview') return {
      WorkspacePreviewBlockedError, WorkspacePreviewStaleError,
      assertFreshWorkspaceFileOperationPlan: (plan: { planId: string; readiness: string }, id: string) => {
        if (plan.planId !== id) throw new WorkspacePreviewStaleError();
        if (plan.readiness !== 'ready') throw new WorkspacePreviewBlockedError();
      },
      buildWorkspaceFileOperationPreview: async (input: typeof controls.previewInputs[number]) => {
        controls.previewInputs.push(input);
        controls.previewCalls += 1;
        const destinationPath = controls.previewCalls > 1 && controls.changedDestinationPath
          ? controls.changedDestinationPath : controls.destinationPath;
        return { planId: 'plan-one', kind: 'move',
        pathMappings: [{ sourcePath: 'a.md', destinationPath }], linkEdits: [],
        coverage: { complete: controls.coverageComplete,
          omittedSources: controls.coverageComplete ? [] : [{ path: 'big.md', reason: 'source-too-large' }],
          unresolvedLinks: [] },
        collisions: controls.collision ? [{ path: 'b.md', workspaceId: 'workspace-one' }] : [],
        readiness: controls.coverageComplete && !controls.collision ? 'ready' : 'blocked',
      }; },
    };
    if (name === '@/app/lib/markdown/workspace-link-write-groups') return {
      groupWorkspaceLinkWrites: () => [],
    };
    if (name === '@/app/lib/markdown/workspace-link-write-executor') return {
      preflightWorkspaceLinkWrites: async (input: LinkInput) => { controls.linkInputs.push(input); },
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
      }; links: { preflight: (stage: unknown) => Promise<unknown> } } }) => ({
        execute: async (input: { operationId: string; request: Journal.WorkspaceOperationRequest }) => {
          controls.executeCalls += 1;
          if (controls.throwExecution) throw new Error('executor failed');
          controls.requests.push(input.request);
          controls.serializations.push(serialize(input.request));
          if (controls.applyCopy) for (const selection of input.request.selections) {
            await options.adapters.path.applySelection({ identity: { operationId: input.operationId } }, selection);
          }
          if (controls.applyLinks) await options.adapters.links.preflight({ identity: { operationId: input.operationId }, preview: {} });
          return { status: controls.status };
        },
        recover: async (input: { operationId: string }) => {
          controls.recoveryCalls += 1;
          const request = JSON.parse(String(controls.known!.requestJson)) as Journal.WorkspaceOperationRequest;
          controls.requests.push(request);
          controls.serializations.push(serialize(request));
          if (controls.applyOnRecovery) for (const selection of request.selections) {
            await options.adapters.path.applySelection({ identity: { operationId: input.operationId } }, selection);
          }
          if (controls.applyLinks) await options.adapters.links.preflight({ identity: { operationId: input.operationId }, preview: {} });
          return { status: controls.status };
        },
      }),
    };
    if (name === './workspace-operation-journal') return { serializeWorkspaceOperationRequest: serialize, WorkspaceOperationJournal: class {
      async get() {
        controls.getCalls += 1;
        if (controls.getCalls === 1) await controls.onFirstGet?.();
        return controls.known ? { steps: [], ...controls.known } : null;
      }
    } };
    if (name === './workspace-operation-path-probe') return {
      probeWorkspacePathOperation: async () => undefined,
      probeWorkspacePathSelectionOperation: async () => undefined,
    };
    if (name === './workspace-operation-staging') return { WorkspaceOperationStaging: class { async readKind() { return null; } } };
    if (name === './rename-service') return { renameWorkspacePath: async () => ({}) };
    if (name === './workspace-operation-backup') return { captureWorkspaceOperationBackup: async () => ({ backupId: 'backup' }) };
    return load(name);
  }, service, service.exports);
  const workspace: Input['source']['workspace'] = { workspaceId: 'workspace-one', workspaceType: 'personal',
    organizationId: null, customerId: null, projectId: null, ownerUserId: 'user-one',
    rootPath: '/unused-service-workspace', rootRelativePath: 'users/user-one/workspace',
    legacy: false, status: 'active', actor: { userId: 'user-one', role: 'owner' }, permissions: {
      canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
      canManageWorkspace: true, canRunAgent: true,
    } };
  const scope: Input['source'] = { workspace, fileOptions: { workspace } };
  const input = (kind: 'move' | 'copy' = 'move', extra: Partial<Input> = {}): Input => ({
    kind, source: scope, destination: scope,
    selections: [{ sourcePath: 'a.md', destinationPath: 'b.md' }],
    actorUserId: 'user-one', actorId: 'user-one', actorDisplayName: 'User',
    ...extra,
  });
  const run = service.exports.executeWorkspaceFileOperationService;
  const execute = (kind: 'move' | 'copy' = 'move', extra: Partial<Input> = {}) => run(input(kind, extra));
  const knownCopy = (extra: Partial<Input> = {}) => {
    const current = input('copy', extra);
    const request: Journal.WorkspaceOperationRequest = { kind: 'copy', selections: current.selections,
      origin: captureWorkspaceOperationCopyOrigin({ actor: { type: current.actorType ?? 'user',
        userId: current.actorUserId, actorId: current.actorId, sessionId: current.actorSessionId ?? null },
      sourceWorkspace: current.source.workspace, destinationWorkspace: current.destination.workspace }) };
    return { actor: { id: current.actorUserId, type: current.actorType ?? 'user' }, planId: 'plan-one',
      sourceWorkspaceId: current.source.workspace.workspaceId, destinationWorkspaceId: current.destination.workspace.workspaceId,
      ...serialize(request) };
  };
  return { controls, execute, input, run, scope, serialize, knownCopy };
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

test('selection copy binds its durable operation and actual actor session without reinitializing native clones', async () => {
  const h = await harness(); h.controls.applyCopy = true; h.controls.nativeCopy = true;
  const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await h.execute('copy', { operationId, actorSessionId: 'actual-session', destination: { workspace: h.scope.workspace,
    fileOptions: { ...h.scope.fileOptions, mutationActorUserId: 'wrong-user', mutationOperationId: 'wrong-operation' } } });
  assert.equal(h.controls.metadataCalls, 0);
  assert.equal(h.controls.copyBindings[0].mutationOperationId, operationId);
  assert.equal(h.controls.copyBindings[0].mutationActorUserId, 'user-one');
  assert.equal(h.controls.copyBindings[0].mutationActorSessionId, 'actual-session');
});

test('collision-renamed copy guards the selected target while the original target has an independent owner', async () => {
  const h = await harness();
  h.controls.applyCopy = true;
  h.controls.destinationPath = 'b (1).md';
  h.controls.blockedPath = 'b.md';
  const result = await h.execute('copy', { renameOnCollision: true });
  assert.equal(result.execution.status, 'complete');
  assert.deepEqual(h.controls.lifecycleScopes, [
    { workspaceId: 'workspace-one', paths: ['a.md'] },
    { workspaceId: 'workspace-one', paths: ['b (1).md'] },
  ]);
  assert.equal(h.controls.copyCalls, 1);
  assert.equal(h.controls.metadataCalls, 1);
  assert.equal(h.controls.lifecycleDepth, 0);
});

test('a collision target that changes during guard acquisition aborts before filesystem or metadata work', async () => {
  const h = await harness();
  h.controls.applyCopy = true;
  h.controls.destinationPath = 'b (1).md';
  h.controls.changedDestinationPath = 'b (2).md';
  await assert.rejects(h.execute('copy', { renameOnCollision: true }),
    (error: unknown) => error instanceof Error && error.constructor.name === 'WorkspacePreviewStaleError');
  assert.equal(h.controls.executeCalls, 0);
  assert.equal(h.controls.copyCalls, 0);
  assert.equal(h.controls.metadataCalls, 0);
  assert.equal(h.controls.lifecycleDepth, 0);
});

test('copy recovery keeps the verified stored target without choosing another collision name', async () => {
  const h = await harness();
  h.controls.destinationPath = 'b (2).md';
  h.controls.known = { actor: { id: 'user-one' }, planId: 'plan-one',
    sourceWorkspaceId: 'workspace-one', destinationWorkspaceId: 'workspace-one',
    requestJson: JSON.stringify({ kind: 'copy', selections: [{ sourcePath: 'a.md', destinationPath: 'b (1).md' }] }),
  };
  const result = await h.execute('copy', { operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    expectedPlanId: 'plan-one', renameOnCollision: true,
    selections: [{ sourcePath: 'a.md', destinationPath: 'a.md' }],
  });
  assert.equal(result.alreadyKnown, true);
  assert.deepEqual(result.copied, ['b (1).md']);
  assert.deepEqual(h.controls.lifecycleScopes, [
    { workspaceId: 'workspace-one', paths: ['a.md'] },
    { workspaceId: 'workspace-one', paths: ['b (1).md'] },
  ]);
  assert.equal(h.controls.previewCalls, 0);
  assert.equal(h.controls.copyCalls, 0);
});

test('new copy serializes the original PI agent identity and both complete scopes', async () => {
  const h = await harness();
  await h.execute('copy', { actorType: 'agent', actorId: 'pi-agent-original', actorSessionId: 'session-original' });
  const request = h.controls.requests[0];
  assert.deepEqual(request.origin?.actor, { type: 'agent', userId: 'user-one',
    actorId: 'pi-agent-original', sessionId: 'session-original' });
  assert.deepEqual(request.origin?.sourceScope, request.origin?.destinationScope);
  assert.equal(request.origin?.sourceScope.rootPath, '/unused-service-workspace');
  assert.equal(request.origin?.sourceScope.ownerUserId, 'user-one');
  assert.equal(request.origin?.sourceScope.legacy, false);
  assert.deepEqual(h.controls.serializations[0], h.serialize(request));
  assert(Object.isFrozen(request.origin) && Object.isFrozen(request.origin.actor)
    && Object.isFrozen(request.origin.sourceScope));
});

test('copy captures workspace, options, selections and actor before the first asynchronous journal read', async () => {
  const h = await harness(); h.controls.applyCopy = true; h.controls.applyLinks = true;
  const entered = deferred(), release = deferred();
  h.controls.onFirstGet = async () => { entered.resolve(); await release.promise; };
  const source = structuredClone(h.scope), destination = structuredClone(h.scope);
  const originalSource = structuredClone(source), originalDestination = structuredClone(destination);
  const input = h.input('copy', { source, destination, actorType: 'agent', actorId: 'pi-original',
    actorSessionId: 'original-session' });
  const promise = h.run(input);
  await entered.promise;
  input.actorUserId = 'different-user'; input.actorId = 'different-agent'; input.actorType = 'user';
  input.actorSessionId = 'different-session'; input.source = structuredClone(h.scope);
  input.destination = structuredClone(h.scope);
  source.workspace.rootPath = '/different-root'; source.workspace.permissions.canRead = false;
  source.workspace.actor!.userId = 'different-workspace-actor';
  destination.workspace.ownerUserId = 'different-owner'; destination.workspace.permissions.canWrite = false;
  source.fileOptions.workspace = { ...source.workspace, workspaceId: 'different-options-workspace' };
  destination.fileOptions.mutationActorUserId = 'different-option-user';
  destination.fileOptions.mutationActorSessionId = 'different-option-session';
  (input.selections as Array<{ sourcePath: string; destinationPath: string }>)[0].sourcePath = 'changed.md';
  (input.selections as Array<{ sourcePath: string; destinationPath: string }>).push({ sourcePath: 'extra.md', destinationPath: 'extra-copy.md' });
  release.resolve();
  await promise;
  assert.deepEqual(h.controls.requests[0].selections, [{ sourcePath: 'a.md', destinationPath: 'b.md' }]);
  assert.deepEqual(h.controls.requests[0].origin?.actor, { type: 'agent', userId: 'user-one',
    actorId: 'pi-original', sessionId: 'original-session' });
  assert.deepEqual(h.controls.previewInputs[0].sourceOptions.workspace, originalSource.workspace);
  assert.deepEqual(h.controls.previewInputs[0].destinationOptions.workspace, originalDestination.workspace);
  assert.deepEqual(h.controls.copyOptions[0].source.workspace, originalSource.workspace);
  assert.deepEqual(h.controls.copyOptions[0].target.workspace, originalDestination.workspace);
  assert.equal(h.controls.copyBindings[0].mutationActorUserId, 'user-one');
  assert.equal(h.controls.copyBindings[0].mutationActorSessionId, 'original-session');
  assert.equal(h.controls.linkInputs[0].actorId, 'pi-original');
  assert.equal(h.controls.linkInputs[0].actorSessionId, 'original-session');
  assert.deepEqual(h.controls.lifecycleScopes, [{ workspaceId: 'workspace-one', paths: ['a.md'] },
    { workspaceId: 'workspace-one', paths: ['b.md'] }]);
});

test('a file-options workspace mismatch is rejected before lifecycle admission or mutation', async () => {
  const h = await harness();
  await assert.rejects(h.execute('copy', { source: { workspace: h.scope.workspace,
    fileOptions: { workspace: { ...h.scope.workspace, rootPath: '/another-root' } } } }),
  { code: 'COPY_ORIGIN_INVALID' });
  assert.equal(h.controls.guardCalls, 0);
  assert.equal(h.controls.getCalls, 0);
  assert.equal(h.controls.copyCalls, 0);
  const changed = { ...h.scope.workspace, rootPath: '/another-root' };
  await assert.rejects(h.execute('copy', { source: { workspace: h.scope.workspace, fileOptions: { workspace: changed } },
    destination: { workspace: h.scope.workspace, fileOptions: { workspace: changed } } }), { code: 'COPY_ORIGIN_CHANGED' });
  assert.equal(h.controls.guardCalls, 0);
  assert.equal(h.controls.getCalls, 0);
});

test('copy recovery preserves the original session for the path callback and uses the current session for links', async () => {
  const h = await harness(); h.controls.applyOnRecovery = true; h.controls.applyLinks = true; h.controls.nativeCopy = true;
  h.controls.known = h.knownCopy({ actorType: 'agent', actorId: 'pi-original', actorSessionId: 'original-session' });
  const originalJson = String(h.controls.known.requestJson), originalHash = h.controls.known.requestHash;
  const result = await h.execute('copy', { operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    expectedPlanId: 'plan-one', actorType: 'agent', actorId: 'pi-original', actorSessionId: 'current-session' });
  assert.equal(result.alreadyKnown, true);
  assert.equal(h.controls.recoveryCalls, 1);
  assert.equal(h.controls.previewCalls, 0);
  assert.equal(h.controls.copyBindings[0].mutationActorSessionId, 'original-session');
  assert.equal(h.controls.copyBindings[0].mutationActorUserId, 'user-one');
  assert.equal(h.controls.linkInputs[0].actorId, 'pi-original');
  assert.equal(h.controls.linkInputs[0].actorSessionId, 'current-session');
  assert.equal(h.controls.requests[0].origin?.actor.sessionId, 'original-session');
  assert.deepEqual(h.controls.serializations[0], { requestJson: originalJson, requestHash: originalHash });
  assert.equal(h.controls.known.requestJson, originalJson);
});

test('copy recovery rejects changed actor, type, complete scope, hash or malformed origin before admission', async () => {
  const cases: Array<{ label: string; change: (h: Awaited<ReturnType<typeof harness>>, input: Input) => void }> = [
    { label: 'user', change: (_h, input) => { input.actorUserId = 'other-user'; } },
    { label: 'agent', change: (_h, input) => { input.actorId = 'other-agent'; } },
    { label: 'type', change: (_h, input) => { input.actorType = 'user'; input.actorId = 'user-one'; } },
    { label: 'journal actor type', change: h => { h.controls.known!.actor = { id: 'user-one', type: 'user' }; } },
    { label: 'hash', change: h => { h.controls.known!.requestHash = 'f'.repeat(64); } },
    { label: 'invalid origin', change: h => {
      const request = JSON.parse(String(h.controls.known!.requestJson));
      request.origin.actor.sessionId = 123; h.controls.known!.requestJson = JSON.stringify(request);
    } },
    ...Object.entries({ workspaceType: 'organization', organizationId: 'other-org', customerId: 'other-customer',
      projectId: 'other-project', ownerUserId: 'other-owner', rootPath: '/different-root',
      rootRelativePath: 'other/relative', legacy: true }).map(([key, value]) => ({ label: `scope ${key}`,
      change: (_h: Awaited<ReturnType<typeof harness>>, input: Input) => {
        const workspace = { ...input.source.workspace, [key]: value };
        input.source = { workspace, fileOptions: { workspace } };
        input.destination = { workspace, fileOptions: { workspace } };
      } })),
  ];
  for (const entry of cases) {
    const h = await harness();
    h.controls.known = h.knownCopy({ actorType: 'agent', actorId: 'pi-original', actorSessionId: 'original-session' });
    const input = h.input('copy', { operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expectedPlanId: 'plan-one',
      actorType: 'agent', actorId: 'pi-original', actorSessionId: 'current-session' });
    entry.change(h, input);
    await assert.rejects(h.run(input), (error: unknown) => error instanceof Error
      && (error as Error & { status?: unknown }).status === 409, entry.label);
    assert.equal(h.controls.guardCalls, 0, entry.label);
    assert.equal(h.controls.copyCalls, 0, entry.label);
    assert.equal(h.controls.executeCalls + h.controls.recoveryCalls, 0, entry.label);
    assert.equal(h.controls.metadataCalls, 0, entry.label);
  }
});

test('legacy copy recovery does not invent an origin and retains the current-session fallback', async () => {
  const h = await harness(); h.controls.applyOnRecovery = true; h.controls.applyLinks = true;
  const serialized = h.serialize({ kind: 'copy', selections: [{ sourcePath: 'a.md', destinationPath: 'b.md' }] });
  h.controls.known = { ...serialized, actor: { type: 'user', id: 'user-one' }, planId: 'plan-one',
    sourceWorkspaceId: 'workspace-one', destinationWorkspaceId: 'workspace-one' };
  await h.execute('copy', { operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expectedPlanId: 'plan-one',
    actorSessionId: 'legacy-current-session' });
  assert.equal(Object.hasOwn(h.controls.requests[0], 'origin'), false);
  assert.equal(h.controls.serializations[0].requestJson, serialized.requestJson);
  assert.equal(h.controls.copyBindings[0].mutationActorSessionId, 'legacy-current-session');
  assert.equal(h.controls.linkInputs[0].actorSessionId, 'legacy-current-session');
});
