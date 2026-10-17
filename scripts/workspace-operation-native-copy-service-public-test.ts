import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import ts from 'typescript';
import * as Y from 'yjs';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { inspectPersistedNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { NativeNamespaceEntry } from '../app/lib/markdown/workspace-link-contract-v2';
import { inspectNativeDocumentLinks, nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof, type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../app/lib/markdown/workspace-source-authority-stage';
import { createWorkspaceOperationNativeCopyPlan, assertWorkspaceOperationNativeCopyPlanCurrent,
  type WorkspaceOperationNativeCopyPlan } from '../app/lib/files/workspace-operation-native-copy-plan';
import { workspaceOperationNativeCopyPublicPreview } from '../app/lib/files/workspace-operation-native-copy-public';
import { createWorkspaceFileOperationPlan } from '../app/lib/markdown/workspace-file-operation-planner';
import type * as Service from '../app/lib/files/workspace-file-operation-service';
import type * as Journal from '../app/lib/files/workspace-operation-journal';
import type { NativeCopyExecutionInput, NativeCopyExecutionResult } from '../app/lib/files/workspace-operation-native-copy-owner';

// Real C1/Yjs/pure projection and real Service export bodies. Catalogue/FS
// identities below are declared fixtures, never actual ownership. Auth, owner,
// journal and filesystem boundaries are named stubs; no PG/FS service is used.
type Input = Service.WorkspaceFileOperationServiceInput;
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function workspace(suffix = 'source'): WorkspaceContext {
  return { workspaceId: `copy-public-${suffix}`, rootPath: `/private/fixture-secret/${suffix}`,
    rootRelativePath: `users/private-user/${suffix}`, workspaceType: 'personal', organizationId: null,
    ownerUserId: 'copy-user', customerId: null, projectId: null, legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
      canManageWorkspace: true, canCreatePublicLinks: false } };
}
function state(space: WorkspaceContext, file: string, text: string,
  representation: PersistedCollaborationState['representation'] = 'plain_text'): PersistedCollaborationState {
  const doc = representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
  try { return { documentId: `private-native-document:${space.workspaceId}:${file}`, workspaceId: space.workspaceId,
    organizationId: null, path: file, representation, lifecycleGeneration: 1, schemaVersion: 1, documentSequence: 4,
    persistedAt: 100, checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null,
    newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active',
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) }; }
  finally { doc.destroy(); }
}
function observation(space: WorkspaceContext, states: PersistedCollaborationState[], extras: NativeNamespaceEntry[] = []): WorkspaceLinkSourceAuthorityObservation {
  const inventories = states.map(value => inspectPersistedNativeCollaborationSnapshot(value, inspectNativeDocumentLinks));
  const nativeBindings: WorkspaceNativeSourceBinding[] = states.map((value, index) => {
    const lineageId = `private-native-lineage:${value.documentId}`;
    return { expected: { documentId: value.documentId, lineageId, workspaceId: space.workspaceId, organizationId: null,
      path: value.path, representation: value.representation, schemaVersion: 1, lifecycleGeneration: 1, registryStateVersion: 4,
      documentSequence: 4, persistedAt: 100, stateProof: inventories[index].version.stateProof,
      binaryHash: sha(value.yjsState), vectorHash: sha(value.stateVector) },
    registry: { documentId: value.documentId, lineageId, workspaceId: space.workspaceId, workspaceType: 'personal', organizationId: null,
      customerId: null, projectId: null, path: value.path, provider: 'yjs', stateLifecycle: 'initialized', stateVersion: 4, status: 'active' },
    lineage: { lineageId, workspaceId: space.workspaceId, workspaceType: 'personal', organizationId: null,
      customerId: null, projectId: null, path: value.path, status: 'active', archivedAt: null, trashEntryId: null },
    byteProfile: { newlineStyle: 'lf', hasBom: false }, inventoryProof: proof(inventories[index]) };
  });
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId: space.workspaceId,
    organizationId: null, catalogueProof: proof(nativeBindings.map(binding => binding.registry)),
    namespace: [...states.map(value => ({ workspaceId: space.workspaceId, path: value.path, kind: 'file' as const,
      identity: `registry:${value.documentId}:1`, filesystemIdentity: null, documentId: value.documentId, lifecycleGeneration: 1 })), ...extras],
    sources: inventories.map(inventory => ({ kind: 'native', inventory })), scope: { kind: 'visible-workspace', excludedPaths: [] },
    coverage: { complete: true, gaps: [] }, readiness: 'native-coordinator-required', executionReady: false };
  return { stage: { ...body, stageProof: workspaceSourceAuthorityStageProof(body) }, nativeBindings, privateNativeStates: states };
}
function nativePlan(representation: PersistedCollaborationState['representation'] = 'plain_text', warnings = false) {
  const source = workspace(), destination = warnings ? workspace('destination') : source;
  const original = observation(source, [state(source, 'note.md', '[Target](target.md#Heading)', representation),
    state(source, 'target.md', '# Heading', representation), ...(warnings ? [state(source, 'unrelated.md', '[Missing](missing-source.md)', representation)] : [])]);
  const target = destination === source ? original : observation(destination,
    [state(destination, 'unrelated.md', '[Missing](missing-destination.md)', representation)]);
  const selections = warnings ? [{ sourcePath: 'note.md', destinationPath: 'copied-note.md' },
    { sourcePath: 'target.md', destinationPath: 'copied-target.md' }]
    : [{ sourcePath: 'note.md', destinationPath: 'copied/note.md' }];
  return createWorkspaceOperationNativeCopyPlan({ sourceScope: { workspace: source, fileOptions: {} },
    destinationScope: { workspace: destination, fileOptions: {} }, selections,
    sourceObservation: original, destinationObservation: target });
}
function assetPlan() {
  const space = workspace(), observed = observation(space, [], [{ workspaceId: space.workspaceId, path: 'asset.pdf', kind: 'file',
    identity: '1:100:6:100:100', filesystemIdentity: '1:100:6:100:100', documentId: null, lifecycleGeneration: null }]);
  return createWorkspaceOperationNativeCopyPlan({ sourceScope: { workspace: space, fileOptions: {} },
    destinationScope: { workspace: space, fileOptions: {} }, selections: [{ sourcePath: 'asset.pdf', destinationPath: 'copied.pdf' }],
    sourceObservation: observed, destinationObservation: observed });
}
function assertPublic(plan: WorkspaceOperationNativeCopyPlan) {
  const before = structuredClone(plan), visible = workspaceOperationNativeCopyPublicPreview(plan), text = JSON.stringify(visible);
  assert.deepEqual(plan, before); assert.equal(visible.version, 4); assert.equal(visible.kind, 'native-copy');
  assert.equal(visible.readiness, 'ready'); assert.deepEqual(Object.keys(visible).sort(),
    ['coverage', 'destinationWorkspaceId', 'issues', 'kind', 'linkAssessment', 'linkEdits', 'pathMappings', 'planId', 'readiness', 'sourceWorkspaceId', 'version']);
  assert.equal(plan.executionReady, false);
  for (const field of ['executionReady', 'sourceEvidence', 'destinationEvidence', 'sourceScope', 'destinationScope', 'origin',
    'nativePathPlan', 'cloneRequirements', 'documentId', 'lineageId', 'startAnchor', 'endAnchor', 'reference', 'stateProof',
    'rootPath', 'rootRelativePath', 'yjsState', 'stateVector', 'previewContents', 'originalDocuments', 'targetRange']) {
    assert.equal(text.includes(`"${field}"`), false, field);
  }
  for (const original of [plan.sourceEvidence, plan.destinationEvidence]) {
    assert.equal(text.includes(original.workspaceScope.rootPath), false);
    for (const binding of original.nativeBindings) {
      assert.equal(text.includes(binding.expected.documentId), false); assert.equal(text.includes(binding.expected.lineageId), false);
      assert.equal(text.includes(binding.expected.stateProof), false);
    }
  }
  for (const mapping of visible.pathMappings) {
    assert.match(mapping.sourceIdentity, /^native-copy-preview:[a-f0-9]{64}$/u);
    assert.notEqual(mapping.sourceIdentity, plan.nativePathPlan.pathMappings.find(entry => entry.source.path === mapping.sourcePath)!.source.identity);
  }
  for (const edit of visible.linkEdits) assert.deepEqual(Object.keys(edit).sort(),
    ['nextTargetLiteral', 'previousTargetLiteral', 'sourcePathAfter', 'sourcePathBefore']);
  assert.deepEqual(workspaceOperationNativeCopyPublicPreview(plan), visible);
  return visible;
}

test('asset-only C1 ready state projects safe compatible display fields', () => {
  const plan = assetPlan(), visible = assertPublic(plan);
  assert.equal(plan.readiness, 'ready'); assert.equal(visible.coverage.complete, true);
  assert.deepEqual(visible.linkEdits, []); assert.equal(visible.pathMappings[0].sourceKind, 'file');
});
for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) test(`${representation}: clone rebinding is supported without leaking native recipes`, () => {
  const plan = nativePlan(representation), visible = assertPublic(plan);
  assert.equal(plan.readiness, 'requires-clone-rebinding'); assert.equal(visible.linkEdits.length, 1);
  assert.deepEqual(visible.linkEdits[0], { sourcePathBefore: 'note.md', sourcePathAfter: 'copied/note.md',
    previousTargetLiteral: 'target.md#Heading', nextTargetLiteral: '../target.md#Heading' });
});
for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) test(`${representation}: cross-workspace equal-spelling recipes do not claim an actual link edit`, () => {
  const source = workspace(), destination = workspace('destination');
  const observed = observation(source, [state(source, 'note.md', '[Target](target.md#Heading)', representation),
    state(source, 'target.md', '# Heading', representation)]);
  const target = observation(destination, []);
  const plan = createWorkspaceOperationNativeCopyPlan({ sourceScope: { workspace: source, fileOptions: {} },
    destinationScope: { workspace: destination, fileOptions: {} }, sourceObservation: observed,
    destinationObservation: target, selections: [{ sourcePath: 'note.md', destinationPath: 'note.md' },
      { sourcePath: 'target.md', destinationPath: 'target.md' }] });
  const compiled = assertWorkspaceOperationNativeCopyPlanCurrent(plan, { sourceScope: plan.sourceScope,
    destinationScope: plan.destinationScope, sourceObservation: observed, destinationObservation: target });
  assert.equal(compiled.steps[0].linkIntents.length, 0);
  assert.equal(plan.nativePathPlan.mutations.length, 1);
  const recipe = plan.nativePathPlan.mutations[0];
  const previous = recipe.reference.kind === 'link-mark' ? recipe.reference.expected.href : recipe.reference.expected;
  assert.equal(previous, recipe.nextValue);
  const visible = assertPublic(plan); assert.equal(visible.linkEdits.length, 0);
});
test('original unrelated unresolved links in both independent workspaces remain explicit warnings', () => {
  const plan = nativePlan('plain_text', true), visible = assertPublic(plan);
  assert.equal(visible.coverage.complete, false); assert.equal(visible.coverage.unresolvedLinks.length, 2);
  assert.equal(visible.linkAssessment?.complete, true); assert.deepEqual(visible.linkAssessment?.blockers, []);
  assert.deepEqual(visible.linkAssessment?.warnings.map(warning => [warning.workspaceId, warning.targetLiteral, warning.status, warning.reason]),
    [[plan.sourceScope.workspaceId, 'missing-source.md', 'missing', 'unaffected-existing-link'],
      [plan.destinationScope.workspaceId, 'missing-destination.md', 'missing', 'unaffected-existing-link']]);
});
test('public projection invokes the actual strict C1 decoder before exposing any data', () => {
  const plan = nativePlan();
  assert.throws(() => workspaceOperationNativeCopyPublicPreview({ ...plan, planId: '0'.repeat(64) }));
  let reads = 0;
  const getter = { ...plan }; Object.defineProperty(getter, 'sourceScope', { enumerable: true, get() { reads++; return plan.sourceScope; } });
  assert.throws(() => workspaceOperationNativeCopyPublicPreview(getter)); assert.equal(reads, 0);
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
async function nativeCopyServicePublicHarness() {
  const file = path.resolve('app/lib/files/workspace-file-operation-service.ts'), load = createRequire(file);
  const compile = (value: string) => ts.transpileModule(value, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const journalFile = path.resolve('app/lib/files/workspace-operation-journal.ts'), journalLoad = createRequire(journalFile);
  const journal = { exports: {} as typeof Journal };
  new Function('require', 'module', 'exports', compile(await fs.readFile(journalFile, 'utf8')))((name: string) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db') return { openDb: () => assert.fail('No real DB checkout in this pure harness.') };
    return journalLoad(name);
  }, journal, journal.exports);
  const space = workspace(), plan = nativePlan(), legacy = createWorkspaceFileOperationPlan({ kind: 'copy',
    sourceWorkspaceId: space.workspaceId, destinationWorkspaceId: space.workspaceId,
    selections: [{ sourcePath: 'note.md', destinationPath: 'copied/note.md' }],
    snapshots: [{ workspaceId: space.workspaceId, entries: [{ identity: 'legacy-declared-identity', kind: 'file', path: 'note.md', markdownContent: 'Original' }] }] });
  const scope = { workspace: space, fileOptions: { workspace: space } }, operationId = 'native-copy-service-operation';
  const input: Input = { kind: 'copy', operationId, expectedPlanId: plan.planId, source: scope, destination: scope,
    selections: [{ sourcePath: 'note.md', destinationPath: 'copied/note.md' }], actorUserId: 'copy-user', actorId: 'copy-user',
    actorDisplayName: 'Copy User', actorType: 'user', actorSessionId: 'original-session', destinationDirectory: 'copied',
    request: new NextRequest('https://notebook.example/api/files/copy', { method: 'POST', headers: { cookie: 'auth=original-session' } }) };
  const execution: NativeCopyExecutionResult['execution'] = { operationId, planId: plan.planId, status: 'complete',
    completedSteps: ['copy-completion'], pendingSteps: [], errorCode: null };
  const controls = { enabled: true, stageKind: null as 'native-copy' | 'legacy' | null, header: null as Journal.WorkspaceOperationWithSteps | null,
    stageError: null as Error | null, ownerError: null as Error | null, firstGet: null as (() => Promise<void>) | null,
    getCalls: 0, stageCalls: 0, legacyGuards: 0, legacyLocks: 0, legacyPreviews: 0, legacyExecutes: 0, legacyRecovers: 0,
    ownerCalls: [] as NativeCopyExecutionInput[], ownerPlan: plan as WorkspaceOperationNativeCopyPlan | null, metrics: [] as unknown[] };
  const serviceModule = { exports: {} as typeof Service };
  const denied = (label: string) => () => assert.fail(`Unexpected real-service boundary: ${label}`);
  class Blocked extends Error {} class Stale extends Error {}
  new Function('require', 'module', 'exports', compile(await fs.readFile(file, 'utf8')))((name: string) => {
    if (name === 'server-only') return {};
    if (name === '../collaboration/native-text-session-activation') return { authenticatedNativeTextSessionEnabled: () => controls.enabled };
    if (name === './workspace-operation-native-copy-public') return { workspaceOperationNativeCopyPublicPreview };
    if (name === './workspace-operation-native-copy-owner') return { executeWorkspaceNativeCopyOperation: async (captured: NativeCopyExecutionInput) => {
      controls.ownerCalls.push(captured); if (controls.ownerError) throw controls.ownerError;
      return { execution, plan: controls.ownerPlan, copied: ['copied/note.md'], alreadyKnown: controls.header !== null || controls.stageKind === 'native-copy',
        privateFutureOwnerData: 'never-expose-this' };
    } };
    if (name === './workspace-operation-journal') return { serializeWorkspaceOperationRequest: journal.exports.serializeWorkspaceOperationRequest,
      WorkspaceOperationJournal: class { async get() { if (++controls.getCalls === 1) await controls.firstGet?.(); return controls.header; } } };
    if (name === './workspace-operation-staging') return { WorkspaceOperationStaging: class { async readKind() {
      controls.stageCalls++; if (controls.stageError) throw controls.stageError; return controls.stageKind;
    } } };
    if (name === './workspace-file-lifecycle-guard') return { withWorkspaceFileLifecycleGuards: async (_scopes: unknown, run: () => Promise<unknown>) => {
      controls.legacyGuards++; return run();
    } };
    if (name === '@/app/lib/filesystem/workspace-files') return { withWorkspaceCopyMutationLocks: async (_a: unknown, _b: unknown, run: () => Promise<unknown>) => {
      controls.legacyLocks++; return run();
    }, readFile: denied('readFile'), copyFileBetweenWorkspaces: denied('copyFileBetweenWorkspaces') };
    if (name === '@/app/lib/markdown/workspace-file-operation-preview') return { WorkspacePreviewBlockedError: Blocked, WorkspacePreviewStaleError: Stale,
      buildWorkspaceFileOperationPreview: async () => { controls.legacyPreviews++; return legacy; },
      assertFreshWorkspaceFileOperationPlan: (actual: typeof legacy, id: string) => assert.equal(actual.planId, id) };
    if (name === '@/app/lib/markdown/workspace-link-write-groups') return { groupWorkspaceLinkWrites: () => [] };
    if (name === '@/app/lib/markdown/workspace-link-write-executor') return { preflightWorkspaceLinkWrites: denied('preflight links'),
      probeWorkspaceLinkWriteGroup: denied('probe links'), applyWorkspaceLinkWriteGroup: denied('apply links') };
    if (name === './collaboration-policy') return { initializeCopiedFileCollaborationPaths: denied('collaboration metadata') };
    if (name === './workspace-operation-observability') return { observeWorkspaceOperation: (value: unknown) => { controls.metrics.push(value); } };
    if (name === './workspace-file-operation-executor') return { createWorkspaceFileOperationExecutor: () => ({
      execute: async () => { controls.legacyExecutes++; return { ...execution, planId: legacy.planId }; },
      recover: async () => { controls.legacyRecovers++; return { ...execution, planId: legacy.planId }; },
    }) };
    if (name === './workspace-operation-path-probe') return { probeWorkspacePathOperation: denied('probe path'), probeWorkspacePathSelectionOperation: denied('probe selection') };
    if (name === './workspace-operation-backup') return { captureWorkspaceOperationBackup: denied('backup') };
    if (name === './rename-service') return { renameWorkspacePath: denied('rename') };
    return load(name);
  }, serviceModule, serviceModule.exports);
  const legacyHeader = () => {
    input.expectedPlanId = legacy.planId;
    const request: Journal.WorkspaceOperationRequest = { kind: 'copy', selections: input.selections };
    const encoded = journal.exports.serializeWorkspaceOperationRequest(request);
    const header: Journal.WorkspaceOperationWithSteps = { operationId, planId: legacy.planId, requestHash: encoded.requestHash,
      requestJson: encoded.requestJson, actor: { type: 'user', id: 'copy-user' }, sourceWorkspaceId: space.workspaceId,
      destinationWorkspaceId: space.workspaceId, status: 'running', phase: 'path', revision: 1, errorCode: null,
      createdAt: 100, updatedAt: 100, expectedStepCount: 1, steps: [] };
    return header;
  };
  return { input, controls, plan, legacy, legacyHeader, run: () => serviceModule.exports.executeWorkspaceFileOperationService(input) };
}
function assertNativeBoundary(controls: Awaited<ReturnType<typeof nativeCopyServicePublicHarness>>['controls']) {
  assert.equal(controls.ownerCalls.length, 1); assert.equal(controls.legacyGuards, 0); assert.equal(controls.legacyLocks, 0);
  assert.equal(controls.legacyPreviews, 0); assert.equal(controls.legacyExecutes, 0); assert.equal(controls.legacyRecovers, 0);
}

test('new native Copy dispatches the actual captured request to the fixed owner before legacy guards', async () => {
  const h = await nativeCopyServicePublicHarness(), result = await h.run(); assertNativeBoundary(h.controls);
  assert.equal(result.plan?.kind, 'native-copy'); assert.equal(result.rename, null);
  assert.equal(JSON.stringify(result).includes('never-expose-this'), false);
  assert.equal(h.controls.ownerCalls[0].operationId, h.input.operationId);
  assert.equal(h.controls.ownerCalls[0].expectedPlanId, h.plan.planId);
  assert.equal(h.controls.ownerCalls[0].destinationDirectory, 'copied');
});
test('genuine native stage routing before B0 does not reconstruct a legacy plan', async () => {
  const h = await nativeCopyServicePublicHarness(); h.controls.stageKind = 'native-copy';
  await h.run(); assertNativeBoundary(h.controls); assert.equal(h.controls.header, null);
});
test('completed native marker with retired stage routes history without a current source or D2 preview', async () => {
  const h = await nativeCopyServicePublicHarness(), header = h.legacyHeader();
  h.input.expectedPlanId = h.plan.planId; header.planId = h.plan.planId; header.status = 'completed';
  header.steps = [{ operationId: header.operationId, stepKey: 'copy-completion', phase: 'link', status: 'applied',
    beforeFence: 'a'.repeat(64), afterFence: 'b'.repeat(64), backupRef: null, receiptJson: '{}', createdAt: 100, updatedAt: 100 }];
  h.controls.header = header; h.controls.ownerPlan = null;
  const result = await h.run(); assertNativeBoundary(h.controls); assert.equal(result.plan, null); assert.equal(result.alreadyKnown, true);
});
test('legacy V1 stage uses the unchanged guarded executor even while native gate is enabled', async () => {
  const h = await nativeCopyServicePublicHarness(); h.controls.stageKind = 'legacy'; h.input.expectedPlanId = h.legacy.planId;
  const result = await h.run(); assert.equal(h.controls.ownerCalls.length, 0); assert.equal(h.controls.legacyExecutes, 1);
  assert.equal(h.controls.legacyGuards, 1); assert.equal(h.controls.legacyLocks, 1); assert.equal(result.plan, h.legacy);
});
test('completed legacy operation without stage retains its original recovery path', async () => {
  const h = await nativeCopyServicePublicHarness(); h.controls.header = h.legacyHeader(); h.controls.header.status = 'completed';
  const result = await h.run(); assert.equal(h.controls.ownerCalls.length, 0); assert.equal(h.controls.legacyRecovers, 1);
  assert.equal(h.controls.legacyPreviews, 0); assert.equal(result.plan, null);
});
test('corrupt native stage fails closed without either owner or legacy mutation', async () => {
  const h = await nativeCopyServicePublicHarness(), error = Object.assign(new Error('corrupt'), { code: 'CORRUPT_STAGE' });
  h.controls.stageError = error; await assert.rejects(h.run(), actual => actual === error);
  assert.equal(h.controls.ownerCalls.length, 0); assert.equal(h.controls.legacyGuards, 0); assert.equal(h.controls.legacyExecutes, 0);
});
test('gate off blocks an existing native stage instead of invoking the legacy executor', async () => {
  const h = await nativeCopyServicePublicHarness(); h.controls.enabled = false; h.controls.stageKind = 'native-copy';
  await assert.rejects(h.run(), (error: unknown) => error instanceof Error && Reflect.get(error, 'code') === 'NATIVE_COPY_UNAVAILABLE');
  assert.equal(h.controls.ownerCalls.length, 0); assert.equal(h.controls.legacyGuards, 0);
});
test('gate off blocks a native historical marker after stage retirement', async () => {
  const h = await nativeCopyServicePublicHarness(); h.controls.enabled = false; const header = h.legacyHeader();
  header.steps = [{ operationId: header.operationId, stepKey: 'copy-completion', phase: 'link', status: 'applied',
    beforeFence: 'a', afterFence: 'b', backupRef: null, receiptJson: '{}', createdAt: 100, updatedAt: 100 }]; h.controls.header = header;
  await assert.rejects(h.run(), (error: unknown) => error instanceof Error && Reflect.get(error, 'code') === 'NATIVE_COPY_UNAVAILABLE');
  assert.equal(h.controls.legacyRecovers, 0); assert.equal(h.controls.legacyGuards, 0);
});
test('gate off leaves new legacy copies on the existing guarded execution path', async () => {
  const h = await nativeCopyServicePublicHarness(); h.controls.enabled = false; h.input.expectedPlanId = h.legacy.planId;
  await h.run(); assert.equal(h.controls.ownerCalls.length, 0); assert.equal(h.controls.legacyExecutes, 1);
  assert.equal(h.controls.legacyGuards, 1); assert.equal(h.controls.legacyLocks, 1);
});
test('current request headers, selections, origin and destination directory are captured before first routing await', async () => {
  const h = await nativeCopyServicePublicHarness(), entered = deferred(), release = deferred();
  h.controls.firstGet = async () => { entered.resolve(); await release.promise; };
  const originalRequest = h.input.request!, selections = [{ sourcePath: 'note.md', destinationPath: 'copied/note.md' }];
  h.input.selections = selections; const running = h.run(); await entered.promise;
  originalRequest.headers.set('cookie', 'auth=replaced-session'); h.input.actorSessionId = 'replaced-session';
  h.input.destinationDirectory = 'foreign'; selections[0].destinationPath = 'foreign/note.md';
  release.resolve(); await running; assertNativeBoundary(h.controls);
  const captured = h.controls.ownerCalls[0]; assert.notEqual(captured.request, originalRequest);
  assert.equal(captured.request?.headers.get('cookie'), 'auth=original-session');
  assert.equal(captured.origin.actor.sessionId, 'original-session'); assert.equal(captured.destinationDirectory, 'copied');
  assert.deepEqual(captured.selections, [{ sourcePath: 'note.md', destinationPath: 'copied/note.md' }]);
});
test('root destination directory is preserved as an explicit empty string', async () => {
  const h = await nativeCopyServicePublicHarness(); h.input.destinationDirectory = ''; await h.run();
  assert.equal(h.controls.ownerCalls[0].destinationDirectory, '');
});
test('invalid destination directory type fails before the first routing read', async () => {
  const h = await nativeCopyServicePublicHarness(); Object.assign(h.input, { destinationDirectory: {} });
  await assert.rejects(h.run(), (error: unknown) => error instanceof Error && Reflect.get(error, 'status') === 422);
  assert.equal(h.controls.getCalls, 0); assert.equal(h.controls.ownerCalls.length, 0);
});
test('an owner failure propagates and can never fall back to legacy mutation', async () => {
  const h = await nativeCopyServicePublicHarness(), error = Object.assign(new Error('current auth denied'), { status: 403 });
  h.controls.ownerError = error; await assert.rejects(h.run(), actual => actual === error); assertNativeBoundary(h.controls);
});
test('a second genuine NextRequest constructor is normalized locally while plain request data remains rejected', async () => {
  const invalid = await nativeCopyServicePublicHarness();
  Object.assign(invalid.input, { request: { url: 'https://notebook.example/api/files/copy', method: 'POST', headers: new Headers() } });
  await assert.rejects(invalid.run(), (error: unknown) => error instanceof Error && Reflect.get(error, 'status') === 422);
  assert.equal(invalid.controls.getCalls, 0); assert.equal(invalid.controls.ownerCalls.length, 0);

  // Evaluate the actual installed CJS class in a separate module instance.
  // Dependencies and the shared Web Request base remain real; no require cache
  // is cleared, and this is neither a fabricated DTO nor a local subclass.
  const require = createRequire(path.resolve('package.json'));
  const entry = require.resolve('next/dist/server/web/spec-extension/request');
  const duplicate = { exports: {} as { NextRequest: typeof NextRequest } };
  new Function('require', 'module', 'exports', await fs.readFile(entry, 'utf8'))(createRequire(entry), duplicate, duplicate.exports);
  const ForeignNextRequest = duplicate.exports.NextRequest;
  assert.notEqual(ForeignNextRequest, NextRequest);
  const foreign = new ForeignNextRequest('https://notebook.example/api/files/copy', { method: 'POST', headers: {
    cookie: 'auth=original-session', Origin: 'https://notebook.example', 'X-Canvas-Workspace-Id': 'copy-public-source',
  } });
  assert(foreign instanceof Request); assert.equal(foreign instanceof NextRequest, false);
  const h = await nativeCopyServicePublicHarness(); h.input.request = foreign;
  h.controls.firstGet = async () => { foreign.headers.set('cookie', 'auth=replaced-session'); foreign.headers.set('X-Canvas-Workspace-Id', 'foreign'); };
  await h.run(); assertNativeBoundary(h.controls);
  const captured = h.controls.ownerCalls[0].request;
  assert(captured instanceof NextRequest); assert.notEqual(captured, foreign);
  assert.equal(captured.url, 'https://notebook.example/api/files/copy'); assert.equal(captured.method, 'POST');
  assert.equal(captured.headers.get('cookie'), 'auth=original-session');
  assert.equal(captured.headers.get('origin'), 'https://notebook.example');
  assert.equal(captured.headers.get('X-Canvas-Workspace-Id'), 'copy-public-source');
});
