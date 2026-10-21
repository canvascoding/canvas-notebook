import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import type { WorkspaceOperationBatchAction, WorkspaceOperationLegacyBatchPlan as WorkspaceOperationBatchPlan, WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { WorkspaceOperationBatchError, type WorkspaceOperationBatchRecord, type WorkspaceOperationBatchStore } from '../app/lib/files/workspace-operation-batch-store';
import { buildWorkspacePathOperationPlan, submitDirectWorkspacePathOperation, type WorkspacePathOperationInput } from '../app/lib/files/workspace-path-operation-service';
import { createWorkspaceOperationNativeDeleteBatchPlanV4 } from '../app/lib/files/workspace-operation-native-delete-plan';
import { workspaceOperationMixedSourceEvidenceV5Fixture } from './workspace-operation-mixed-source-evidence-v5-test';

const planId = 'a'.repeat(64);
type StoreCreateInput = Omit<Parameters<WorkspaceOperationBatchStore['createDirect']>[0], 'plan'> & { plan: WorkspaceOperationBatchPlan };
type Dependencies = NonNullable<Parameters<typeof submitDirectWorkspacePathOperation>[1]>;

function workspaceScope(): WorkspaceOperationBatchScope {
  const workspace: WorkspaceOperationBatchScope['workspace'] = { workspaceId: 'workspace',
    rootPath: '/isolated/workspace', workspaceType: 'personal', status: 'active', organizationId: null,
    ownerUserId: 'initiator', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
      canManageWorkspace: true, canCreatePublicLinks: false } };
  return { workspace, fileOptions: { workspace } };
}

function request(overrides: Partial<WorkspacePathOperationInput> = {}): WorkspacePathOperationInput {
  return { scope: workspaceScope(), kind: 'move', selections: [{ sourcePath: 'source.md', destinationPath: 'target.md' }],
    idempotencyKey: 'stable-tool-call', actorUserId: 'initiator', actorId: 'agent-runtime',
    actorDisplayName: 'Agent author', actorType: 'agent', actorSessionId: 'agent-session', ...overrides };
}

function snapshot(scope: WorkspaceOperationBatchScope, actions: WorkspaceOperationBatchAction[]): WorkspaceOperationBatchPlan {
  return { version: 1, workspaceId: scope.workspace.workspaceId, planId, readiness: 'ready', actions,
    pathSteps: actions.flatMap((action) => action.selections.map((selection) => ({ reviewId: action.reviewId,
      kind: action.kind, ...selection }))), pathMappings: [], deletedPaths: [], linkEdits: [], originalDocuments: [],
    previewContents: [], expectedPathState: [], issues: [],
    coverage: { complete: true, omittedSources: [], unresolvedLinks: [] },
    linkAssessment: { version: 1, complete: true, blockers: [], warnings: [] }, linkPlan: {} as never };
}

function harness() {
  const rows = new Map<string, WorkspaceOperationBatchRecord>();
  const events: string[] = [];
  const builds: Array<{ scope: WorkspaceOperationBatchScope; actions: WorkspaceOperationBatchAction[] }> = [];
  const creates: StoreCreateInput[] = [];
  const paths: string[] = [];
  const typePaths: string[] = [];
  let lockDepth = 0;
  let planError: Error | undefined;
  let guard: (filePath: string) => Promise<string> = async (filePath) => `/isolated/workspace/${filePath}`;
  let isFile: (absolutePath: string) => Promise<boolean> = async () => true;
  const store = {
    get: async (batchId: string) => {
      assert.equal(lockDepth, 1, 'retry lookup stays within the workspace mutation lock');
      events.push('get');
      return rows.get(batchId) ?? null;
    },
    createDirect: async (input: StoreCreateInput) => {
      assert.equal(lockDepth, 1, 'plan persistence stays within the workspace mutation lock');
      events.push('create'); creates.push(input);
      const known = rows.get(input.batchId);
      if (known) {
        const original = known.authorization;
        const incoming = input.authorization;
        if (known.workspaceId !== input.plan.workspaceId || original.mode !== 'direct'
          || original.actorUserId !== incoming.actorUserId || original.actorId !== incoming.actorId
          || original.actorType !== incoming.actorType || original.actorSessionId !== incoming.actorSessionId
          || original.requestHash !== incoming.requestHash) {
          throw new WorkspaceOperationBatchError('BATCH_IDEMPOTENCY_CONFLICT', 409, 'Changed request identity.');
        }
        return known;
      }
      const record: WorkspaceOperationBatchRecord = { batchId: input.batchId, planId: input.plan.planId,
        workspaceId: input.plan.workspaceId, plan: input.plan, authorization: input.authorization,
        reviewIds: [], reviewRefs: [], reviewerUserId: null, reviewerDisplayName: null,
        status: input.plan.readiness === 'ready' ? 'queued' : 'blocked', actionMode: 'apply', completedActions: 0,
        totalActions: input.plan.pathSteps.length + input.plan.previewContents.length, phase: 'preparing',
        errorCode: null, trashEntryIds: [], leaseOwner: null, createdAt: 1, updatedAt: 1 };
      rows.set(input.batchId, record);
      return record;
    },
  } as unknown as WorkspaceOperationBatchStore;
  const dependencies: Dependencies = { store,
    lock: async (workspaceId, work) => {
      assert.equal(workspaceId, 'workspace');
      assert.equal(lockDepth, 0);
      events.push('lock:start'); lockDepth += 1;
      try { return await work(); }
      finally { lockDepth -= 1; events.push('lock:end'); }
    },
    existingPath: async (filePath, options) => {
      assert.equal(lockDepth, 1, 'overwrite guards remain under the same mutation lock');
      assert.equal(options?.workspace?.workspaceId, 'workspace');
      events.push('guard'); paths.push(filePath);
      return guard(filePath);
    },
    pathIsFile: async (absolutePath) => {
      assert.equal(lockDepth, 1, 'overwrite file-type checks remain under the same mutation lock');
      events.push('type'); typePaths.push(absolutePath);
      return isFile(absolutePath);
    },
    buildPlan: async (input) => {
      assert.equal(lockDepth, 1, 'the combined link plan is built under the workspace mutation lock');
      events.push('plan'); builds.push(input);
      if (planError) throw planError;
      return snapshot(input.scope, input.actions);
    },
  };
  return { dependencies, rows, events, builds, creates, paths, typePaths,
    setPlanError(error: Error) { planError = error; },
    setIsFile(next: typeof isFile) { isFile = next; },
    setGuard(next: typeof guard) { guard = next; } };
}

const hasCode = (code: string, status: number) => (error: unknown) => error instanceof WorkspaceOperationBatchError
  && error.code === code && error.status === status;

async function main(): Promise<void> {
  for (const overwrite of [false, true]) {
    const stable = harness();
    const input = request({ idempotencyKey: undefined, overwrite });
    const dependencies: Dependencies = { ...stable.dependencies, buildPlan: async (buildInput) => {
      const built = await stable.dependencies.buildPlan!(buildInput);
      return { ...built, planId: createHash('sha256').update(JSON.stringify(buildInput.actions)).digest('hex') };
    } };
    const preview = await dependencies.lock!('workspace', () => buildWorkspacePathOperationPlan({
      scope: input.scope, kind: input.kind, selections: input.selections, overwrite: input.overwrite,
    }, dependencies));
    assert.equal(stable.rows.size, 0, 'preview has no durable mutation request');
    assert.equal(stable.creates.length, 0);
    const previewIds = preview.actions.map((action) => action.reviewId);
    const first = await submitDirectWorkspacePathOperation({ ...input, expectedPlanId: preview.planId }, dependencies);
    const second = await submitDirectWorkspacePathOperation({ ...input, expectedPlanId: preview.planId,
      actorUserId: 'another-user', actorId: 'another-author', actorType: 'user', actorSessionId: undefined,
    }, dependencies);
    assert.notEqual(first.batchId, second.batchId, 'new requests without a key keep separate job identities');
    assert.deepEqual(first.plan.actions.map((action) => action.reviewId), previewIds,
      'preview and apply use the same action identity without an idempotency key');
    assert.deepEqual(second.plan.actions.map((action) => action.reviewId), previewIds,
      'action identity is independent of the requesting actor and random job identity');
    assert.equal(first.planId, preview.planId);
    assert.equal(second.planId, preview.planId);
    assert.equal(stable.rows.size, 2);
    assert.equal(stable.builds.length, 3);
    assert.ok(stable.builds.every((build) => JSON.stringify(build.actions) === JSON.stringify(preview.actions)));
  }

  const retry = harness();
  const originalInput = request({ expectedPlanId: planId });
  const original = await submitDirectWorkspacePathOperation(originalInput, retry.dependencies);
  assert.equal(original.status, 'queued');
  assert.equal(retry.builds.length, 1);
  assert.equal(retry.creates.length, 1);
  assert.deepEqual(retry.builds[0].actions.map(({ kind, selections }) => ({ kind, selections })),
    [{ kind: 'move', selections: originalInput.selections }]);
  assert.match(original.batchId, /^[a-f0-9]{64}$/u);
  assert.equal(original.authorization.mode, 'direct');
  assert.match(original.authorization.mode === 'direct' ? original.authorization.requestHash : '', /^[a-f0-9]{64}$/u);
  assert.deepEqual(original.reviewIds, []);
  original.status = 'applied';
  retry.setPlanError(new Error('SOURCE_ALREADY_MOVED'));
  retry.setGuard(async () => { throw new Error('SOURCE_ALREADY_MOVED'); });
  const eventOffset = retry.events.length;
  assert.equal(await submitDirectWorkspacePathOperation(originalInput, retry.dependencies), original);
  assert.deepEqual(retry.events.slice(eventOffset), ['lock:start', 'get', 'create', 'lock:end'],
    'acknowledged retry returns the original result before filesystem access or planning');
  assert.equal(retry.builds.length, 1);
  assert.equal(retry.rows.size, 1);
  const renamedActor = await submitDirectWorkspacePathOperation({ ...originalInput, actorDisplayName: 'New display name' }, retry.dependencies);
  assert.equal(renamedActor, original, 'display-name changes do not alter immutable actor identity');
  assert.equal(renamedActor.authorization.mode === 'direct' ? renamedActor.authorization.actorDisplayName : '', 'Agent author');

  for (const changed of [
    { selections: [{ sourcePath: 'other-source.md', destinationPath: 'target.md' }] },
    { selections: [{ sourcePath: 'source.md', destinationPath: 'other-target.md' }] },
    { kind: 'rename' as const }, { kind: 'delete' as const }, { overwrite: true },
    { expectedPlanId: 'b'.repeat(64) }, { actorId: 'different-agent' },
    { actorSessionId: 'different-session' }, { actorType: 'user' as const },
  ]) {
    const offset = retry.events.length;
    await assert.rejects(submitDirectWorkspacePathOperation({ ...originalInput, ...changed }, retry.dependencies),
      hasCode('BATCH_IDEMPOTENCY_CONFLICT', 409));
    assert.deepEqual(retry.events.slice(offset), ['lock:start', 'get', 'create', 'lock:end'],
      'same key with changed immutable inputs is a conflict before replanning');
    assert.equal(retry.rows.size, 1);
    assert.equal(retry.builds.length, 1);
    assert.equal(retry.rows.get(original.batchId), original);
  }

  const replacement = harness();
  const replacementInput = request({ overwrite: true, selections: [
    { sourcePath: 'A.md', destinationPath: 'targets/A.md' },
    { sourcePath: 'B.md', destinationPath: 'targets/B.md' },
  ] });
  const replaced = await submitDirectWorkspacePathOperation(replacementInput, replacement.dependencies);
  assert.deepEqual(replacement.paths, ['targets/A.md', 'A.md', 'targets/B.md', 'B.md']);
  assert.deepEqual(replacement.typePaths, ['/isolated/workspace/targets/A.md', '/isolated/workspace/A.md',
    '/isolated/workspace/targets/B.md', '/isolated/workspace/B.md']);
  assert.equal(replacement.builds.length, 1, 'overwrite deletion and move share one link plan');
  assert.equal(replacement.creates.length, 1, 'overwrite persists one durable job');
  assert.deepEqual(replacement.builds[0].actions.map(({ kind, selections }) => ({ kind, selections })), [
    { kind: 'delete', selections: [{ sourcePath: 'targets/A.md' }, { sourcePath: 'targets/B.md' }] },
    { kind: 'move', selections: replacementInput.selections },
  ]);
  assert.equal(replaced.plan.actions.length, 2);
  assert.deepEqual(replacement.events, ['lock:start', 'get', 'guard', 'guard', 'type', 'type',
    'guard', 'guard', 'type', 'type', 'plan', 'create', 'lock:end']);
  const replacementOffset = replacement.events.length;
  replacement.setGuard(async () => { throw new Error('DESTINATION_ALREADY_REPLACED'); });
  assert.equal(await submitDirectWorkspacePathOperation(replacementInput, replacement.dependencies), replaced);
  assert.deepEqual(replacement.events.slice(replacementOffset), ['lock:start', 'get', 'create', 'lock:end'],
    'overwrite retry never deletes its already moved destination');

  const absentDestination = harness();
  absentDestination.setGuard(async () => { throw Object.assign(new Error('Missing target.'), { code: 'ENOENT' }); });
  const absent = await submitDirectWorkspacePathOperation(request({ overwrite: true }), absentDestination.dependencies);
  assert.deepEqual(absent.plan.actions.map(({ kind, selections }) => ({ kind, selections })),
    [{ kind: 'move', selections: request().selections }], 'a missing overwrite destination needs no deletion');
  assert.equal(absentDestination.creates.length, 1);

  const mixedDestination = harness();
  mixedDestination.setGuard(async (filePath) => {
    if (filePath === 'targets/B.md') throw Object.assign(new Error('Missing target.'), { code: 'ENOENT' });
    return `/isolated/workspace/${filePath}`;
  });
  const mixed = await submitDirectWorkspacePathOperation(replacementInput, mixedDestination.dependencies);
  assert.deepEqual(mixed.plan.actions[0].selections, [{ sourcePath: 'targets/A.md' }],
    'overwrite deletes only destinations whose existence was verified');

  for (const directoryPath of ['/isolated/workspace/source.md', '/isolated/workspace/target.md']) {
    const directory = harness();
    directory.setIsFile(async (absolutePath) => absolutePath !== directoryPath);
    await assert.rejects(submitDirectWorkspacePathOperation(request({ overwrite: true }), directory.dependencies),
      hasCode('BATCH_OVERWRITE_REQUIRES_FILES', 409));
    assert.equal(directory.builds.length, 0, 'directory overwrite is denied before building a replacement plan');
    assert.equal(directory.creates.length, 0);
    assert.equal(directory.rows.size, 0, 'directory overwrite cannot queue destructive target deletion');
    assert.ok(directory.typePaths.includes(directoryPath), 'both source and destination file types are fenced');
  }

  for (const code of ['EACCES', 'WORKSPACE_PATH_OUTSIDE_ROOT', 'WORKSPACE_PATH_ALIAS']) {
    const guarded = harness();
    const error = Object.assign(new Error('Unsafe destination guard.'), { code });
    guarded.setGuard(async () => { throw error; });
    await assert.rejects(submitDirectWorkspacePathOperation(request({ overwrite: true }), guarded.dependencies),
      (received: unknown) => received === error);
    assert.equal(guarded.builds.length, 0);
    assert.equal(guarded.creates.length, 0);
    assert.equal(guarded.rows.size, 0, 'a destination guard failure cannot queue any replacement action');
    assert.equal(guarded.events.at(-1), 'lock:end');
  }

  for (const permission of ['canRead', 'canWrite', 'canDelete'] as const) {
    const denied = harness();
    const input = request();
    input.scope.workspace.permissions[permission] = false;
    await assert.rejects(submitDirectWorkspacePathOperation(input, denied.dependencies), hasCode('BATCH_ACCESS_DENIED', 403));
    assert.deepEqual(denied.events, [], `${permission}: deny before locks, guard, planning or persistence`);
    assert.equal(denied.rows.size, 0);
  }
  const inactive = harness();
  const inactiveInput = request();
  inactiveInput.scope.workspace.status = 'disabled';
  await assert.rejects(submitDirectWorkspacePathOperation(inactiveInput, inactive.dependencies), hasCode('BATCH_ACCESS_DENIED', 403));
  assert.deepEqual(inactive.events, []);
  const stale = harness();
  await assert.rejects(submitDirectWorkspacePathOperation(request({ expectedPlanId: 'b'.repeat(64) }), stale.dependencies),
    hasCode('PREVIEW_STALE', 409));
  assert.equal(stale.builds.length, 1);
  assert.equal(stale.creates.length, 0, 'a stale expected plan never queues a job');
  const changedHtml = harness();
  let htmlChecks = 0;
  await assert.rejects(submitDirectWorkspacePathOperation(request({ expectedPlanId: planId }), {
    ...changedHtml.dependencies,
    htmlEvidenceCurrent: async (plan, scope) => {
      htmlChecks += 1;
      assert.equal(plan.planId, planId);
      assert.equal(scope.workspace.workspaceId, 'workspace');
      assert.equal(changedHtml.events.at(-1), 'plan', 'the live evidence check follows the fresh plan under the lock');
      throw new WorkspaceOperationBatchError('PREVIEW_STALE', 409, 'The peer changed the HTML proof.');
    },
  }), hasCode('PREVIEW_STALE', 409));
  assert.equal(htmlChecks, 1);
  assert.equal(changedHtml.creates.length, 0, 'a changed live HTML proof never queues a path mutation');
  // Declared store/lock boundary, real E5/Plan4: this checks routing only,
  // not actual current authorization, Owner execution or a durable receipt.
  const htmlSource = workspaceOperationMixedSourceEvidenceV5Fixture({ native: [['target.md', '# Target\n'],
    ['incoming.md', '[Target](target.md)\n\n<p>Unrelated HTML</p>\n']] });
  const htmlWorkspace: WorkspaceOperationBatchScope['workspace'] = { ...htmlSource.scope,
    rootRelativePath: htmlSource.scope.rootRelativePath ?? undefined, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: false } };
  const htmlScope: WorkspaceOperationBatchScope = { workspace: htmlWorkspace, fileOptions: { workspace: htmlWorkspace } };
  const htmlPlan = createWorkspaceOperationNativeDeleteBatchPlanV4({ scope: htmlScope, actions: [{ reviewId: 'html-submit',
    kind: 'delete', selections: [{ sourcePath: 'target.md' }] }], observation: htmlSource.observation });
  assert.equal(htmlPlan.coverage.complete, false); assert.equal(htmlPlan.linkAssessment.complete, true);
  let htmlNativeCreates = 0, htmlLegacyFences = 0;
  const htmlStore = { get: async () => null, createDirect: async (input: Parameters<WorkspaceOperationBatchStore['createDirect']>[0]) => {
    htmlNativeCreates++;
    const record: WorkspaceOperationBatchRecord = { batchId: input.batchId, planId: input.plan.planId, workspaceId: input.plan.workspaceId,
      plan: input.plan, authorization: input.authorization, reviewIds: [], reviewRefs: [], reviewerUserId: null, reviewerDisplayName: null,
      status: 'queued', actionMode: 'apply', completedActions: 0, totalActions: 2, phase: 'preparing', errorCode: null,
      trashEntryIds: [], leaseOwner: null, createdAt: 1, updatedAt: 1 };
    return record;
  } } as unknown as WorkspaceOperationBatchStore;
  const htmlDependencies: Dependencies = { store: htmlStore, lock: async (_workspaceId, work) => work(), buildPlan: async () => htmlPlan,
    htmlEvidenceCurrent: async () => { htmlLegacyFences++; throw new Error('Native Delete4 must reach its original Owner evidence gate.'); } };
  const htmlInput = request({ scope: htmlScope, kind: 'delete', selections: [{ sourcePath: 'target.md' }], expectedPlanId: htmlPlan.planId });
  const htmlQueued = await submitDirectWorkspacePathOperation(htmlInput, htmlDependencies);
  assert.deepEqual(htmlQueued.plan, htmlPlan); assert.equal(htmlNativeCreates, 1); assert.equal(htmlLegacyFences, 0);
  await assert.rejects(submitDirectWorkspacePathOperation({ ...htmlInput, expectedPlanId: 'f'.repeat(64) }, htmlDependencies),
    hasCode('PREVIEW_STALE', 409));
  assert.equal(htmlNativeCreates, 1, 'an explicit stale Delete4 preview never queues an Original job');
  assert.equal(htmlLegacyFences, 0);
  const scopeCapture = harness();
  const scopeInput = request();
  const captured = await submitDirectWorkspacePathOperation(scopeInput, {
    ...scopeCapture.dependencies,
    lock: async (workspaceId, action) => {
      scopeInput.scope.workspace.rootPath = '/isolated/reused-root';
      scopeInput.scope.workspace.organizationId = 'changed-organization';
      return scopeCapture.dependencies.lock!(workspaceId, action);
    },
  });
  assert.equal(captured.authorization.mode, 'direct');
  if (captured.authorization.mode !== 'direct') throw new Error('The direct job lost its original authorization.');
  assert.deepEqual(captured.authorization.jobScope, { version: 1, workspaceId: 'workspace', workspaceType: 'personal',
    organizationId: null, customerId: null, projectId: null, ownerUserId: 'initiator',
    rootPath: '/isolated/workspace', rootRelativePath: null, legacy: false });
  assert.equal(Object.isFrozen(captured.authorization.jobScope), true);
  const invalid = harness();
  for (const input of [request({ selections: [] }), request({ idempotencyKey: '' }),
    request({ kind: 'delete', overwrite: true, selections: [{ sourcePath: 'source.md' }] })]) {
    await assert.rejects(submitDirectWorkspacePathOperation(input, invalid.dependencies), hasCode('BATCH_INVALID_REQUEST', 422));
    assert.deepEqual(invalid.events, []);
  }
  console.log('direct path service: stable preview/apply identity without key, retry before planning, immutable input/actor conflicts, combined overwrite actions, ENOENT-only fallback, guarded denial and stale-plan persistence fence OK');
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
