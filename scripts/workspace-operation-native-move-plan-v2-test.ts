import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as Y from 'yjs';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { inspectPersistedNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import { createWorkspaceOperationNativeMoveBatchPlan, createWorkspaceOperationNativeMoveBatchPlanV1,
  createWorkspaceOperationNativeMoveBatchPlanV2, computeWorkspaceOperationNativeMoveBatchPlanId,
  computeWorkspaceOperationNativeMoveBatchPlanIntegrityProof, decodeWorkspaceOperationNativeMoveBatchPlan,
  assertWorkspaceOperationNativeMoveBatchPlanCurrent, captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness,
  WorkspaceOperationNativeMovePlanError, type WorkspaceOperationNativeMoveBatchPlan,
  type WorkspaceOperationNativeMoveBatchPlanV2 } from '../app/lib/files/workspace-operation-native-move-plan';
import { inspectNativeDocumentLinks, nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof, type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../app/lib/markdown/workspace-source-authority-stage';

// Actual Yjs, native inventory and compiler; the complete catalogue rows and
// physical namespace are declared pure fixtures, never SQL/ACL/FD authority.
type Mutable<T> = T extends Uint8Array ? Uint8Array : T extends readonly unknown[] ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
type FullObservation = Mutable<WorkspaceLinkSourceAuthorityObservation> & { privateCatalogue: WorkspaceDocumentCatalogueEntry[] };
type Input = Parameters<typeof createWorkspaceOperationNativeMoveBatchPlan>[0];
const clone = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const errorCode = (code: WorkspaceOperationNativeMovePlanError['code']) => (error: unknown) =>
  error instanceof WorkspaceOperationNativeMovePlanError && error.status === 409 && error.code === code;
const invalid = errorCode('NATIVE_MOVE_PLAN_INVALID'), changed = errorCode('NATIVE_MOVE_PLAN_CHANGED');
const scope: WorkspaceOperationBatchScope = { workspace: { workspaceId: 'move-v2-fixture', rootPath: '/fixture/move-v2',
  rootRelativePath: 'users/fixture/move-v2', workspaceType: 'personal', organizationId: null, ownerUserId: 'fixture-user',
  legacy: false, status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
    canManageWorkspace: true, canCreatePublicLinks: false } }, fileOptions: {} };
const jobScope = captureWorkspaceOperationJobScope(scope.workspace);

function state(filePath: string, text: string, representation: PersistedCollaborationState['representation']): PersistedCollaborationState {
  const doc = representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
  try { return { documentId: `document:${filePath}`, workspaceId: jobScope.workspaceId, organizationId: null, path: filePath,
    representation, lifecycleGeneration: 1, schemaVersion: 1, documentSequence: text ? 7 : 0, persistedAt: 100,
    checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null, newlineStyle: 'lf', hasBom: false,
    degraded: false, status: 'active', yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) }; }
  finally { doc.destroy(); }
}
function catalogue(binding: WorkspaceNativeSourceBinding): WorkspaceDocumentCatalogueEntry {
  const expected = binding.expected;
  return { id: expected.documentId, lineage_id: expected.lineageId, path: expected.path, workspace_id: expected.workspaceId,
    organization_id: expected.organizationId, status: 'active', state_version: expected.registryStateVersion,
    yjs_state_lifecycle: 'initialized', has_persisted_state: true, has_state_history: true,
    lifecycle_generation: expected.lifecycleGeneration, authority: 'initialized', state_status: 'active',
    state_path: expected.path, state_workspace_id: expected.workspaceId, state_organization_id: expected.organizationId };
}
function binding(value: PersistedCollaborationState, registryVersion = 6): Mutable<WorkspaceNativeSourceBinding> {
  const inventory = inspectPersistedNativeCollaborationSnapshot(value, inspectNativeDocumentLinks), lineageId = `lineage:${value.documentId}`;
  return { expected: { documentId: value.documentId, lineageId, workspaceId: value.workspaceId, organizationId: value.organizationId,
    path: value.path, representation: value.representation, schemaVersion: value.schemaVersion, lifecycleGeneration: value.lifecycleGeneration,
    registryStateVersion: registryVersion, documentSequence: value.documentSequence, persistedAt: value.persistedAt,
    binaryHash: hash(value.yjsState), vectorHash: hash(value.stateVector), stateProof: inventory.version.stateProof },
  registry: { documentId: value.documentId, lineageId, workspaceId: value.workspaceId, workspaceType: 'personal', organizationId: null,
    customerId: null, projectId: null, path: value.path, provider: 'yjs', stateLifecycle: 'initialized', stateVersion: registryVersion, status: 'active' },
  lineage: { lineageId, workspaceId: value.workspaceId, workspaceType: 'personal', organizationId: null, customerId: null,
    projectId: null, path: value.path, status: 'active', archivedAt: null, trashEntryId: null },
  byteProfile: { newlineStyle: value.newlineStyle, hasBom: value.hasBom }, inventoryProof: proof(inventory) };
}
function refresh(value: FullObservation): void {
  value.stage.catalogueProof = proof(value.privateCatalogue); value.stage.stageProof = workspaceSourceAuthorityStageProof(value.stage);
}
function fixture(representation: PersistedCollaborationState['representation'] = 'plain_text', empty = false): FullObservation {
  const states = empty ? [state('target.md', '', representation)] : [state('incoming.md', '[Target](target.md)', representation),
    state('keep.md', 'Unchanged peer', representation), state('target.md', '[Keep](keep.md)\n\nOriginal', representation)];
  const nativeBindings = states.map(value => binding(value, empty ? 0 : 6));
  const asset: WorkspaceDocumentCatalogueEntry = { id: 'asset-report', lineage_id: 'asset-report-lineage', path: 'assets/report.pdf',
    workspace_id: jobScope.workspaceId, organization_id: null, status: 'active', state_version: 0, yjs_state_lifecycle: 'never_initialized',
    has_persisted_state: false, has_state_history: false, lifecycle_generation: null, authority: 'pristine', state_status: null,
    state_path: null, state_workspace_id: null, state_organization_id: null };
  const namespace: WorkspaceSourceAuthorityStage['namespace'] = states.map(value => ({ workspaceId: value.workspaceId,
    path: value.path, kind: 'file', identity: `registry:${value.documentId}:1`, filesystemIdentity: null,
    documentId: value.documentId, lifecycleGeneration: 1 }));
  namespace.push({ workspaceId: jobScope.workspaceId, path: 'assets', kind: 'directory', identity: '1:30:4096:100:100',
    filesystemIdentity: '1:30:4096:100:100', documentId: null, lifecycleGeneration: null },
  { workspaceId: jobScope.workspaceId, path: asset.path, kind: 'file', identity: '1:31:3:100:100',
    filesystemIdentity: '1:31:3:100:100', documentId: null, lifecycleGeneration: null },
  { workspaceId: jobScope.workspaceId, path: 'folder', kind: 'directory', identity: '1:32:4096:100:100',
    filesystemIdentity: '1:32:4096:100:100', documentId: null, lifecycleGeneration: null });
  namespace.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId: jobScope.workspaceId,
    organizationId: null, catalogueProof: '', namespace, sources: states.map(value => ({ kind: 'native',
      inventory: inspectPersistedNativeCollaborationSnapshot(value, inspectNativeDocumentLinks) })),
    scope: { kind: 'visible-workspace', excludedPaths: [] }, coverage: { complete: true, gaps: [] },
    readiness: 'native-coordinator-required', executionReady: false };
  const result: FullObservation = { stage: { ...body, stageProof: '' }, nativeBindings, privateNativeStates: states,
    privateCatalogue: [...nativeBindings.map(catalogue), asset].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))) };
  refresh(result); return result;
}
function input(observation: WorkspaceLinkSourceAuthorityObservation, kind: 'move' | 'rename' = 'move'): Input {
  return { scope, actions: [{ reviewId: 'move-v2-original-action', kind,
    selections: [{ sourcePath: 'target.md', destinationPath: 'folder/renamed.md' }] }], observation };
}
function noWitness(value: FullObservation): WorkspaceLinkSourceAuthorityObservation {
  return { stage: value.stage, nativeBindings: value.nativeBindings, privateNativeStates: value.privateNativeStates };
}
function current(plan: WorkspaceOperationNativeMoveBatchPlan, observation: WorkspaceLinkSourceAuthorityObservation) {
  return assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan, observation, jobScope);
}
function projected(value: FullObservation): FullObservation {
  const result = clone(value);
  result.nativeBindings.forEach((item, index) => {
    item.expected.registryStateVersion = 7; item.registry.stateVersion = 7;
    result.privateCatalogue.find(row => row.id === item.expected.documentId)!.state_version = 7;
    result.stage.namespace.find(entry => entry.documentId === item.expected.documentId)!.filesystemIdentity = `2:${200 + index}:123:200:201`;
  });
  result.stage.namespace.filter(entry => entry.kind === 'directory').forEach(entry => {
    const inode = entry.path === 'assets' ? '30' : '32'; entry.identity = entry.filesystemIdentity = `1:${inode}:8192:500:501`;
  });
  result.privateNativeStates.forEach(item => {
    item.checkpointSequence = 7; item.checkpointedAt = 200; item.canonicalHash = 'a'.repeat(64); item.serializedHash = 'b'.repeat(64);
  });
  refresh(result); return result;
}
function resign(plan: Mutable<WorkspaceOperationNativeMoveBatchPlanV2>): Mutable<WorkspaceOperationNativeMoveBatchPlanV2> {
  const { integrityProof: _old, ...body } = plan;
  plan.integrityProof = computeWorkspaceOperationNativeMoveBatchPlanIntegrityProof(body); return plan;
}
function replaceNative(value: FullObservation, index: number, replacement: PersistedCollaborationState): void {
  const old = value.nativeBindings[index], next = binding(replacement, old.expected.registryStateVersion);
  value.nativeBindings[index] = next; value.privateNativeStates[index] = clone(replacement);
  const source = value.stage.sources.findIndex(item => item.kind === 'native' && item.inventory.document.documentId === old.expected.documentId);
  value.stage.sources[source] = { kind: 'native', inventory: inspectPersistedNativeCollaborationSnapshot(replacement, inspectNativeDocumentLinks) };
  const entry = value.stage.namespace.find(item => item.documentId === old.expected.documentId)!;
  entry.documentId = replacement.documentId; entry.path = replacement.path; entry.lifecycleGeneration = replacement.lifecycleGeneration;
  entry.identity = `registry:${replacement.documentId}:${replacement.lifecycleGeneration}`;
  value.privateCatalogue[value.privateCatalogue.findIndex(item => item.id === old.expected.documentId)] = catalogue(next); refresh(value);
}

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
  test(`${representation}: projection/checkpoint drift retains semantic identity and original compiler while raw integrity changes`, () => {
    const original = fixture(representation), next = projected(original), before = clone(original), after = clone(next);
    for (const kind of ['move', 'rename'] as const) {
      const first = createWorkspaceOperationNativeMoveBatchPlanV2(input(original, kind));
      const second = createWorkspaceOperationNativeMoveBatchPlanV2(input(next, kind));
      assert.equal(first.version, 3); assert.equal(first.planIdentityVersion, 2); assert.equal(first.sourceEvidence.evidenceVersion, 2);
      assert.equal(first.planId, second.planId); assert.notEqual(first.integrityProof, second.integrityProof);
      assert.notEqual(first.sourceEvidence.evidenceProof, second.sourceEvidence.evidenceProof);
      const replay = current(first, next); assert.equal(replay.planId, first.compilerPlanProof);
      assert.equal(replay.finalGraphProof, first.finalGraphProof); assert.equal(replay.executionReady, false);
      assert.deepEqual(decodeWorkspaceOperationNativeMoveBatchPlan(JSON.parse(JSON.stringify(first))), first);
      const witness = captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(first, next, jobScope);
      assert.deepEqual(witness, second.sourceEvidence); assert(Object.isFrozen(witness));
      assert(Object.isFrozen(witness.nativeBindings)); assert(Object.isFrozen(witness.stage.namespace));
      assert.equal(witness.nativeBindings[0].expected.registryStateVersion, 7);
      assert.equal(witness.semanticProof, first.sourceEvidence.semanticProof);
    }
    assert.deepEqual(original, before); assert.deepEqual(next, after);
    assert.deepEqual(original.privateNativeStates.map(item => [item.yjsState, item.stateVector]),
      next.privateNativeStates.map(item => [item.yjsState, item.stateVector]));
  });

  test(`${representation}: real peer content, links, identity, generation and byte profile changes invalidate the preview`, () => {
    const original = fixture(representation), plan = createWorkspaceOperationNativeMoveBatchPlanV2(input(original));
    for (const transform of [
      (value: PersistedCollaborationState) => state(value.path, 'Changed peer content', representation),
      (value: PersistedCollaborationState) => state(value.path, '[Changed](target.md#section)', representation),
      (value: PersistedCollaborationState) => ({ ...value, documentId: 'replacement-document' }),
      (value: PersistedCollaborationState) => ({ ...value, lifecycleGeneration: 2 }),
      (value: PersistedCollaborationState) => ({ ...value, newlineStyle: 'crlf' as const }),
      (value: PersistedCollaborationState) => ({ ...value, hasBom: true }),
    ]) {
      const next = clone(original); replaceNative(next, 0, transform(next.privateNativeStates[0]));
      assert.notEqual(createWorkspaceOperationNativeMoveBatchPlanV2(input(next)).planId, plan.planId);
      assert.throws(() => current(plan, next), changed);
      assert.throws(() => captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan, next, jobScope), changed);
    }
  });

  test(`${representation}: a sequence-zero empty native document still requires a complete V2 witness`, () => {
    const original = fixture(representation, true), plan = createWorkspaceOperationNativeMoveBatchPlanV2(input(original));
    assert.equal(plan.sourceEvidence.nativeBindings[0].expected.documentSequence, 0);
    assert.equal(current(plan, original).planId, plan.compilerPlanProof);
    assert.deepEqual(captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan, original, jobScope), plan.sourceEvidence);
  });
}

test('default creator uses the explicit V2 arm only with an own complete witness; explicit V2 never falls back', () => {
  const original = fixture(), supplied = input(original), before = clone(supplied);
  assert.deepEqual(createWorkspaceOperationNativeMoveBatchPlan(supplied), createWorkspaceOperationNativeMoveBatchPlanV2(supplied));
  const legacy = createWorkspaceOperationNativeMoveBatchPlan(input(noWitness(original)));
  assert.equal(Object.hasOwn(legacy, 'planIdentityVersion'), false); assert.equal(Object.hasOwn(legacy, 'integrityProof'), false);
  assert.equal(legacy.sourceEvidence.evidenceVersion, 1);
  assert.deepEqual(legacy, createWorkspaceOperationNativeMoveBatchPlanV1(input(noWitness(original))));
  assert.throws(() => createWorkspaceOperationNativeMoveBatchPlanV2(input(noWitness(original))), invalid);
  for (const witness of [undefined, null, [], {}, original.privateCatalogue.slice(0, 1),
    original.privateCatalogue.map((row, index) => index === 0 ? { ...row, state_version: 99 } : row)]) {
    const malformed = { ...clone(original), privateCatalogue: witness } as unknown as WorkspaceLinkSourceAuthorityObservation;
    assert.throws(() => createWorkspaceOperationNativeMoveBatchPlan(input(malformed)), invalid);
  }
  assert.deepEqual(supplied, before);
});

test('legacy raw identities and exact persisted keys stay unchanged, including historical EvidenceV2', () => {
  const original = fixture(), next = projected(original), legacy = createWorkspaceOperationNativeMoveBatchPlanV1(input(original));
  const { planId, ...body } = legacy; assert.equal(planId, proof(body));
  assert.equal(computeWorkspaceOperationNativeMoveBatchPlanId(body), planId);
  assert.throws(() => current(legacy, next), changed);
  const modern = createWorkspaceOperationNativeMoveBatchPlanV2(input(original));
  const { planIdentityVersion: _version, integrityProof: _integrity, planId: _id, ...historicalBody } = modern;
  const historical = decodeWorkspaceOperationNativeMoveBatchPlan({ ...historicalBody, planId: proof(historicalBody) });
  assert.equal(historical.sourceEvidence.evidenceVersion, 2); assert.equal(Object.hasOwn(historical, 'planIdentityVersion'), false);
  assert.equal(computeWorkspaceOperationNativeMoveBatchPlanId(historical), historical.planId);
  assert.equal(current(historical, next).planId, historical.compilerPlanProof);
  assert.deepEqual(JSON.parse(JSON.stringify(decodeWorkspaceOperationNativeMoveBatchPlan(historical))), historical);
  assert.throws(() => captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(historical as WorkspaceOperationNativeMoveBatchPlanV2,
    original, jobScope), invalid);
});

test('historical Current without a witness permits only exact raw replay; strict CurrentWitness never permits it', () => {
  const original = fixture(), plan = createWorkspaceOperationNativeMoveBatchPlanV2(input(original));
  assert.equal(current(plan, noWitness(original)).planId, plan.compilerPlanProof);
  assert.throws(() => current(plan, noWitness(projected(original))), changed);
  assert.throws(() => captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan, noWitness(original), jobScope), invalid);
});

test('new arm discriminator, full raw integrity, source evidence version and exact keys cannot be substituted', () => {
  const original = fixture(), plan = createWorkspaceOperationNativeMoveBatchPlanV2(input(original));
  const legacy = createWorkspaceOperationNativeMoveBatchPlanV1(input(original));
  const probes: unknown[] = [{ ...plan, planIdentityVersion: 1 }, { ...plan, planIdentityVersion: 3 },
    { ...plan, version: 4 }, { ...plan, integrityProof: 'a'.repeat(64) }, { ...plan, unexpected: true },
    { ...legacy, integrityProof: plan.integrityProof }, { ...legacy, planIdentityVersion: 2 }];
  for (const key of ['planIdentityVersion', 'integrityProof']) {
    const missing = { ...plan } as Record<string, unknown>; delete missing[key]; probes.push(missing);
  }
  const wrongEvidence = clone(plan) as Mutable<WorkspaceOperationNativeMoveBatchPlan>;
  wrongEvidence.sourceEvidence = clone(legacy.sourceEvidence);
  probes.push(resign(wrongEvidence as Mutable<WorkspaceOperationNativeMoveBatchPlanV2>));
  for (const probe of probes) assert.throws(() => decodeWorkspaceOperationNativeMoveBatchPlan(probe), invalid);
});

test('a rehashed opaque compiler or graph claim remains historical data and cannot pass Current or CurrentWitness', () => {
  const original = fixture(), plan = createWorkspaceOperationNativeMoveBatchPlanV2(input(original));
  for (const key of ['compilerPlanProof', 'finalGraphProof'] as const) {
    const forged = clone(plan); forged[key] = hash(`forged-${key}`); resign(forged);
    assert.equal(forged.planId, plan.planId); decodeWorkspaceOperationNativeMoveBatchPlan(forged);
    assert.throws(() => current(forged, original), changed);
    assert.throws(() => captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(forged, original, jobScope), changed);
  }
});

test('asset identity, directory inode, catalogue membership and action changes remain semantic changes', () => {
  const original = fixture(), plan = createWorkspaceOperationNativeMoveBatchPlanV2(input(original));
  for (const mutate of [
    (value: FullObservation) => { const entry = value.stage.namespace.find(item => item.path === 'assets/report.pdf')!;
      entry.identity = entry.filesystemIdentity = '1:99:3:100:100'; },
    (value: FullObservation) => { const entry = value.stage.namespace.find(item => item.path === 'folder')!;
      entry.identity = entry.filesystemIdentity = '1:99:4096:100:100'; },
    (value: FullObservation) => {
      value.privateCatalogue.push({ ...value.privateCatalogue.find(item => item.authority === 'pristine')!,
        id: 'another-asset', lineage_id: 'another-asset-lineage', path: 'assets/second.pdf' });
      value.privateCatalogue.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      value.stage.namespace.push({ workspaceId: jobScope.workspaceId, path: 'assets/second.pdf', kind: 'file',
        identity: '1:40:3:100:100', filesystemIdentity: '1:40:3:100:100', documentId: null, lifecycleGeneration: null });
      value.stage.namespace.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    },
  ]) {
    const next = clone(original); mutate(next); refresh(next);
    assert.notEqual(createWorkspaceOperationNativeMoveBatchPlanV2(input(next)).planId, plan.planId);
    assert.throws(() => current(plan, next), changed);
  }
  const selected = input(original); selected.actions[0].selections[0].destinationPath = 'folder/other.md';
  assert.notEqual(createWorkspaceOperationNativeMoveBatchPlanV2(selected).planId, plan.planId);
  assert.throws(() => assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan, original, { ...jobScope, rootPath: '/other' }));
});

test('equal visible text with a different actual Yjs DeleteSet and durable version is not checkpoint drift', () => {
  const original = fixture(), plan = createWorkspaceOperationNativeMoveBatchPlanV2(input(original)), next = clone(original);
  const value = next.privateNativeStates[1], doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, value.yjsState); const content = doc.getText('content');
    const before = content.toString(); content.insert(content.length, 'temporary'); content.delete(before.length, 'temporary'.length);
    assert.equal(content.toString(), before);
    replaceNative(next, 1, { ...value, documentSequence: 8, persistedAt: 101,
      yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) });
  } finally { doc.destroy(); }
  assert.notEqual(createWorkspaceOperationNativeMoveBatchPlanV2(input(next)).planId, plan.planId);
  assert.throws(() => current(plan, next), changed);
});

test('getters and proxies never run during witness selection, capture or strict current data capture', () => {
  const original = fixture(), plan = createWorkspaceOperationNativeMoveBatchPlanV2(input(original)); let reads = 0;
  const getter = clone(original); Object.defineProperty(getter, 'privateCatalogue', { enumerable: true, get() { reads++; return original.privateCatalogue; } });
  const proxy = new Proxy(original, { getPrototypeOf() { reads++; throw new Error('Proxy trap'); },
    getOwnPropertyDescriptor() { reads++; throw new Error('Proxy trap'); } });
  for (const observation of [getter, proxy]) {
    assert.throws(() => createWorkspaceOperationNativeMoveBatchPlan(input(observation)), invalid);
    assert.throws(() => captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan, observation, jobScope), invalid);
  }
  assert.equal(reads, 0);
});

test('plan and strict CurrentWitness are detached frozen data, without mutating or retaining caller observation objects', () => {
  const original = fixture(), before = clone(original), plan = createWorkspaceOperationNativeMoveBatchPlanV2(input(original));
  const witness = captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan, original, jobScope), saved = clone(witness);
  assert.deepEqual(original, before); assert.notStrictEqual(witness.stage, original.stage);
  assert.notStrictEqual(witness.nativeBindings, original.nativeBindings);
  original.nativeBindings[0].expected.registryStateVersion = 99; original.stage.namespace[0].identity = 'changed';
  original.privateNativeStates[0].yjsState.fill(0); original.privateCatalogue[0].path = 'changed';
  assert.deepEqual(witness, saved); assert.deepEqual(plan.sourceEvidence, saved);
  assert(Object.isFrozen(plan)); assert(Object.isFrozen(plan.actions[0].selections[0]));
  assert(Object.isFrozen(witness.nativeBindings[0].expected));
});
