import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as Y from 'yjs';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import type { WorkspaceOperationBatchScope, WorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import { createWorkspaceOperationNativeCopyPlan, createWorkspaceOperationNativeCopyPlanV1, createWorkspaceOperationNativeCopyPlanV2,
  computeWorkspaceOperationNativeCopyPlanId, computeWorkspaceOperationNativeCopyPlanIntegrityProof,
  decodeWorkspaceOperationNativeCopyPlan, assertWorkspaceOperationNativeCopyPlanCurrent,
  withNativeCopyPlanValidation, WorkspaceOperationNativeCopyPlanError,
  type WorkspaceOperationNativeCopyPlan, type WorkspaceOperationNativeCopyPlanV2 } from '../app/lib/files/workspace-operation-native-copy-plan';
import { workspaceOperationNativeCopyPublicPreview } from '../app/lib/files/workspace-operation-native-copy-public';
import { prepareNativeCopyStage, decodeNativeCopyStage, assertNativeCopyStageManifestDigest, NativeCopyStageDataError,
  type WorkspaceOperationNativeCopyStageInput, type NativeCopyStageManifest } from '../app/lib/files/workspace-operation-native-copy-stage';
import { nativeCopyMetadataCompositeDigest, nativeCopyMetadataWitness } from '../app/lib/files/workspace-operation-native-copy-metadata';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../app/lib/markdown/workspace-source-authority-stage';
import { nativeCopyMetadataFixture } from './helpers/native-copy-metadata-codec-fixture';

// Actual Yjs/C1/compiler/Stage codecs. Catalogue and FD originals below are
// declared stored-format data, not genuine SQL/ACL/FD capabilities or evidence
// of COMMIT, projection publication or an actual owner recovery.
type Mutable<T> = T extends Uint8Array ? Uint8Array : T extends readonly (infer Item)[] ? Mutable<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
type FullObservation = Mutable<WorkspaceLinkSourceAuthorityObservation> & { privateCatalogue: WorkspaceDocumentCatalogueEntry[] };
type Input = Parameters<typeof createWorkspaceOperationNativeCopyPlanV2>[0];
type Fixture = Omit<Input, 'sourceObservation' | 'destinationObservation'> & {
  sourceObservation: FullObservation; destinationObservation: FullObservation;
  original: ReturnType<typeof nativeCopyMetadataFixture>;
};
type MutablePlan = Mutable<WorkspaceOperationNativeCopyPlanV2>;
const clone = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const code = (expected: WorkspaceOperationNativeCopyPlanError['code']) => (error: unknown) =>
  error instanceof WorkspaceOperationNativeCopyPlanError && error.code === expected && error.status === 409;
const invalid = code('NATIVE_COPY_PLAN_INVALID');
const changed = code('NATIVE_COPY_PLAN_CHANGED');
const tooLarge = code('NATIVE_COPY_PLAN_TOO_LARGE');
const invalidStage = (error: unknown) => error instanceof NativeCopyStageDataError && error.code === 'STAGE_CONFLICT';
const corruptStage = (error: unknown) => error instanceof NativeCopyStageDataError && error.code === 'CORRUPT_STAGE';

function scope(value: WorkspaceOperationJobScope): WorkspaceOperationBatchScope {
  return { workspace: { ...value, rootRelativePath: value.rootRelativePath ?? undefined, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
      canManageWorkspace: true, canCreatePublicLinks: false } }, fileOptions: {} };
}
function catalogueRow(binding: WorkspaceNativeSourceBinding): WorkspaceDocumentCatalogueEntry {
  const expected = binding.expected;
  return { id: expected.documentId, lineage_id: expected.lineageId, path: expected.path,
    workspace_id: expected.workspaceId, organization_id: expected.organizationId, status: 'active',
    state_version: expected.registryStateVersion, yjs_state_lifecycle: 'initialized', has_persisted_state: true,
    has_state_history: true, lifecycle_generation: expected.lifecycleGeneration, authority: 'initialized',
    state_status: 'active', state_path: expected.path, state_workspace_id: expected.workspaceId,
    state_organization_id: expected.organizationId };
}
function refresh(observation: FullObservation): void {
  observation.stage.catalogueProof = proof(observation.privateCatalogue);
  observation.stage.stageProof = workspaceSourceAuthorityStageProof(observation.stage);
}
function fixture(representation: PersistedCollaborationState['representation'] = 'plain_text'): Fixture {
  const original = nativeCopyMetadataFixture(representation);
  const observe = (evidence: typeof original.plan.sourceEvidence): FullObservation => {
    const nativeBindings = clone(evidence.nativeBindings);
    for (const binding of nativeBindings) { binding.expected.registryStateVersion = 6; binding.registry.stateVersion = 6; }
    const workspaceId = evidence.workspaceScope.workspaceId;
    const asset: WorkspaceDocumentCatalogueEntry = { id: `${workspaceId}-asset`, lineage_id: `${workspaceId}-asset-lineage`,
      path: 'assets/report.pdf', workspace_id: workspaceId, organization_id: evidence.workspaceScope.organizationId,
      status: 'active', state_version: 0, yjs_state_lifecycle: 'never_initialized', has_persisted_state: false,
      has_state_history: false, lifecycle_generation: null, authority: 'pristine', state_status: null,
      state_path: null, state_workspace_id: null, state_organization_id: null };
    const result: FullObservation = { stage: clone(evidence.stage), nativeBindings,
      privateNativeStates: clone(original.nativeRecords.filter(record => record.state.workspaceId === workspaceId).map(record => record.state)),
      privateCatalogue: [...nativeBindings.map(catalogueRow), asset].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))) };
    result.stage.namespace.push({ workspaceId, path: 'assets', kind: 'directory', identity: '1:30:4096:100:100',
      filesystemIdentity: '1:30:4096:100:100', documentId: null, lifecycleGeneration: null },
    { workspaceId, path: asset.path, kind: 'file', identity: '1:31:3:100:100', filesystemIdentity: '1:31:3:100:100',
      documentId: null, lifecycleGeneration: null });
    refresh(result); return result;
  };
  return { original, sourceScope: scope(original.plan.sourceScope), destinationScope: scope(original.plan.destinationScope),
    selections: clone(original.plan.selections), sourceObservation: observe(original.plan.sourceEvidence),
    destinationObservation: observe(original.plan.destinationEvidence) };
}
function input(value: Fixture): Input {
  return { sourceScope: value.sourceScope, destinationScope: value.destinationScope, selections: value.selections,
    sourceObservation: value.sourceObservation, destinationObservation: value.destinationObservation };
}
function build(value: Fixture): WorkspaceOperationNativeCopyPlanV2 { return createWorkspaceOperationNativeCopyPlanV2(input(value)); }
function current(plan: WorkspaceOperationNativeCopyPlan, value: Fixture, witness = true) {
  const observation = (value: FullObservation): WorkspaceLinkSourceAuthorityObservation => witness ? value
    : { stage: value.stage, nativeBindings: value.nativeBindings, privateNativeStates: value.privateNativeStates };
  return assertWorkspaceOperationNativeCopyPlanCurrent(plan, {
    sourceScope: captureWorkspaceOperationJobScope(value.sourceScope.workspace),
    destinationScope: captureWorkspaceOperationJobScope(value.destinationScope.workspace),
    sourceObservation: observation(value.sourceObservation), destinationObservation: observation(value.destinationObservation) });
}
function projected(original: FullObservation): FullObservation {
  const result = clone(original);
  for (const binding of result.nativeBindings) {
    binding.expected.registryStateVersion = 7; binding.registry.stateVersion = 7;
    result.privateCatalogue.find(row => row.id === binding.expected.documentId)!.state_version = 7;
  }
  result.stage.namespace.forEach((entry, index) => {
    if (entry.documentId !== null) entry.filesystemIdentity = `2:${200 + index}:180:400:401`;
    if (entry.path === 'assets') entry.identity = entry.filesystemIdentity = '1:30:8192:500:501';
  });
  for (const state of result.privateNativeStates) {
    state.checkpointSequence = 7; state.checkpointedAt = 200;
    state.canonicalHash = 'a'.repeat(64); state.serializedHash = 'b'.repeat(64);
  }
  refresh(result); return result;
}
function resign(plan: MutablePlan, semantic = false): MutablePlan {
  if (semantic) plan.planId = computeWorkspaceOperationNativeCopyPlanId(plan);
  const { integrityProof: _old, ...body } = plan;
  plan.integrityProof = computeWorkspaceOperationNativeCopyPlanIntegrityProof(body); return plan;
}
function replaceNative(observation: FullObservation, index: number, state: PersistedCollaborationState): void {
  const old = observation.nativeBindings[index], previousId = old.expected.documentId;
  const inventory = inspectPersistedDocumentLinks(state), lineageId = state.documentId === previousId
    ? old.expected.lineageId : `lineage:${state.documentId}`;
  const binding: Mutable<WorkspaceNativeSourceBinding> = { ...clone(old), expected: { ...clone(old.expected),
    documentId: state.documentId, lineageId, path: state.path, representation: state.representation,
    lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion, documentSequence: state.documentSequence,
    persistedAt: state.persistedAt, binaryHash: hash(state.yjsState), vectorHash: hash(state.stateVector), stateProof: inventory.version.stateProof },
    registry: { ...clone(old.registry), documentId: state.documentId, lineageId, path: state.path },
    lineage: { ...clone(old.lineage), lineageId, path: state.path },
    byteProfile: { newlineStyle: state.newlineStyle, hasBom: state.hasBom }, inventoryProof: proof(inventory) };
  observation.nativeBindings[index] = binding; observation.privateNativeStates[index] = clone(state);
  const source = observation.stage.sources.findIndex(value => value.kind === 'native' && value.inventory.document.documentId === previousId);
  assert(source >= 0); observation.stage.sources[source] = { kind: 'native', inventory };
  const entry = observation.stage.namespace.find(value => value.documentId === previousId); assert(entry);
  entry.documentId = state.documentId; entry.path = state.path; entry.lifecycleGeneration = state.lifecycleGeneration;
  entry.identity = `registry:${state.documentId}:${state.lifecycleGeneration}`;
  const row = observation.privateCatalogue.findIndex(value => value.id === previousId); assert(row >= 0);
  observation.privateCatalogue[row] = catalogueRow(binding); refresh(observation);
}
function assertChanged(plan: WorkspaceOperationNativeCopyPlanV2, value: Fixture): void {
  const fresh = build(value); assert.notEqual(fresh.planId, plan.planId);
  assert.throws(() => current(plan, value), changed);
}

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
  test(`${representation}: projection-only changes retain V2 identity, change raw integrity and replay the original compiler with full witnesses`, () => {
    const original = fixture(representation), next = clone(original);
    next.sourceObservation = projected(next.sourceObservation); next.destinationObservation = projected(next.destinationObservation);
    const before = clone(original), after = clone(next), first = build(original), second = build(next);
    assert.equal(first.version, 2); assert.equal(first.sourceEvidence.evidenceVersion, 2); assert.equal(first.destinationEvidence.evidenceVersion, 2);
    assert.equal(first.planId, second.planId); assert.notEqual(first.integrityProof, second.integrityProof);
    assert.notEqual(first.sourceEvidence.evidenceProof, second.sourceEvidence.evidenceProof);
    assert.notEqual(first.destinationEvidence.evidenceProof, second.destinationEvidence.evidenceProof);
    const { integrityProof, ...body } = first;
    assert.equal(integrityProof, computeWorkspaceOperationNativeCopyPlanIntegrityProof(body));
    const replay = current(first, next);
    assert.equal(replay.planId, first.compilerPlanProof); assert.equal(replay.finalGraphProof, first.finalGraphProof);
    assert.equal(replay.executionReady, false); assert.deepEqual(replay.cloneRequirements, first.cloneRequirements);
    assert.deepEqual(decodeWorkspaceOperationNativeCopyPlan(JSON.parse(JSON.stringify(first))), first);
    assert.deepEqual(original, before); assert.deepEqual(next, after);
    assert.deepEqual(original.sourceObservation.privateNativeStates.map(state => [state.yjsState, state.stateVector]),
      next.sourceObservation.privateNativeStates.map(state => [state.yjsState, state.stateVector]));
  });

  test(`${representation}: same-workspace V2 preserves one complete shared observation across projection changes`, () => {
    const original = fixture(representation); original.destinationScope = original.sourceScope;
    original.destinationObservation = original.sourceObservation;
    original.selections = original.selections.map(selection => ({ ...selection, destinationPath: `copy-${selection.sourcePath}` }));
    const first = build(original), next = clone(original); next.sourceObservation = projected(next.sourceObservation);
    next.destinationObservation = next.sourceObservation;
    assert.equal(build(next).planId, first.planId); assert.equal(current(first, next).planId, first.compilerPlanProof);
    const mismatched = clone(next); mismatched.destinationObservation = clone(original.sourceObservation);
    assert.throws(() => build(mismatched), invalid);
  });

  test(`${representation}: actual native content/link changes in source or independent destination invalidate the V2 preview`, () => {
    const original = fixture(representation), plan = build(original);
    for (const side of ['sourceObservation', 'destinationObservation'] as const) {
      const next = clone(original), observation = next[side], state = observation.privateNativeStates[0];
      const text = side === 'sourceObservation' ? '[Keep](keep.md#Changed)\n\nChanged native source' : '# Changed destination\n\nPeer edit';
      const doc = representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
      try { replaceNative(observation, 0, { ...state, documentSequence: 8, persistedAt: 101,
        yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) }); }
      finally { doc.destroy(); }
      assertChanged(plan, next);
    }
  });
}

test('historical V1 stays raw-hashed, has no integrity field and refuses registry drift', () => {
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    const value = fixture(representation), before = clone(value), legacy = createWorkspaceOperationNativeCopyPlanV1(input(value));
    assert.equal(legacy.version, 1); assert.equal(legacy.sourceEvidence.evidenceVersion, 1); assert.equal(legacy.destinationEvidence.evidenceVersion, 1);
    const { planId, ...body } = legacy; assert.equal(planId, proof(body));
    assert.equal(computeWorkspaceOperationNativeCopyPlanId(body), planId);
    assert.equal(Object.hasOwn(legacy, 'integrityProof'), false);
    assert.equal(JSON.stringify(decodeWorkspaceOperationNativeCopyPlan(JSON.parse(JSON.stringify(legacy)))), JSON.stringify(legacy));
    const next = clone(value); next.sourceObservation = projected(next.sourceObservation);
    assert.notEqual(createWorkspaceOperationNativeCopyPlanV1(input(next)).planId, planId);
    assert.throws(() => current(legacy, next), changed); assert.deepEqual(value, before);
  }
});

test('default creator selects explicit V2 for both complete witnesses and explicit V1 only when both witnesses are absent', () => {
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    const value = fixture(representation), supplied = input(value), before = clone(supplied);
    const current = createWorkspaceOperationNativeCopyPlan(supplied);
    assert.equal(current.version, 2); assert.deepEqual(current, createWorkspaceOperationNativeCopyPlanV2(supplied));
    assert.deepEqual(supplied, before);
    const historical = clone(supplied);
    delete historical.sourceObservation.privateCatalogue; delete historical.destinationObservation.privateCatalogue;
    const historicalBefore = clone(historical), legacy = createWorkspaceOperationNativeCopyPlan(historical);
    assert.equal(legacy.version, 1); assert.deepEqual(legacy, createWorkspaceOperationNativeCopyPlanV1(historical));
    assert.deepEqual(historical, historicalBefore);
  }
});

test('default creator rejects partial, own-undefined and malformed catalogues instead of falling back to V1', () => {
  const value = fixture();
  for (const side of ['sourceObservation', 'destinationObservation'] as const) {
    const other = side === 'sourceObservation' ? 'destinationObservation' : 'sourceObservation';
    const partial = clone(input(value)); delete partial[side].privateCatalogue;
    assert.throws(() => createWorkspaceOperationNativeCopyPlan(partial), invalid);
    for (const witness of [undefined, null, 0, [], {}, [{ ...value[side].privateCatalogue[0], state_version: -1 }]]) {
      for (const otherPresent of [false, true]) {
        const malformed = clone(input(value));
        if (!otherPresent) delete malformed[other].privateCatalogue;
        Object.defineProperty(malformed[side], 'privateCatalogue', { enumerable: true, value: witness });
        assert.throws(() => createWorkspaceOperationNativeCopyPlan(malformed), invalid);
      }
    }
  }
  const bothUndefined = clone(input(value));
  for (const side of ['sourceObservation', 'destinationObservation'] as const) {
    Object.defineProperty(bothUndefined[side], 'privateCatalogue', { enumerable: true, value: undefined });
  }
  assert.throws(() => createWorkspaceOperationNativeCopyPlan(bothUndefined), invalid);
});

test('default creator never executes accessor or Proxy traps while selecting or validating an observation version', () => {
  const value = fixture(); let accesses = 0;
  const trap = (): never => { accesses++; throw new Error('Default selection must not execute caller code.'); };
  const proxied = <T extends object>(value: T): T => new Proxy<T>(value, { get: trap, ownKeys: trap,
    getPrototypeOf: trap, getOwnPropertyDescriptor: trap, has: trap });
  assert.throws(() => createWorkspaceOperationNativeCopyPlan(proxied(input(value))), invalid);
  const revokedInput = Proxy.revocable(input(value), {}); revokedInput.revoke();
  assert.throws(() => createWorkspaceOperationNativeCopyPlan(revokedInput.proxy), invalid);
  for (const side of ['sourceObservation', 'destinationObservation'] as const) {
    const candidate = input(value);
    assert.throws(() => createWorkspaceOperationNativeCopyPlan({ ...candidate, [side]: proxied(candidate[side]) }), invalid);
    const revoked = Proxy.revocable(candidate[side], {}); revoked.revoke();
    assert.throws(() => createWorkspaceOperationNativeCopyPlan({ ...candidate, [side]: revoked.proxy }), invalid);
    const accessor = input(value); Object.defineProperty(accessor, side, { enumerable: true, get: trap });
    assert.throws(() => createWorkspaceOperationNativeCopyPlan(accessor), invalid);
    const witnessAccessor = clone(input(value));
    Object.defineProperty(witnessAccessor[side], 'privateCatalogue', { enumerable: true, get: trap });
    assert.throws(() => createWorkspaceOperationNativeCopyPlan(witnessAccessor), invalid);
    const witnessProxy = clone(input(value));
    witnessProxy[side].privateCatalogue = proxied(value[side].privateCatalogue);
    assert.throws(() => createWorkspaceOperationNativeCopyPlan(witnessProxy), invalid);
    const rowProxy = clone(input(value));
    rowProxy[side].privateCatalogue![0] = proxied(rowProxy[side].privateCatalogue![0]);
    assert.throws(() => createWorkspaceOperationNativeCopyPlan(rowProxy), invalid);
  }
  assert.equal(accesses, 0);
});

test('V2 Current without witnesses accepts only original raw stage/bindings and real original native records', () => {
  const value = fixture(), plan = build(value); assert.equal(current(plan, value, false).planId, plan.compilerPlanProof);
  const projectedSource = clone(value); projectedSource.sourceObservation = projected(projectedSource.sourceObservation);
  assert.throws(() => current(plan, projectedSource, false), changed);
  const projectedDestination = clone(value); projectedDestination.destinationObservation = projected(projectedDestination.destinationObservation);
  assert.throws(() => current(plan, projectedDestination, false), changed);
  const bytes = clone(value); bytes.sourceObservation.privateNativeStates[0].yjsState[0] ^= 1;
  assert.throws(() => current(plan, bytes, false), invalid);
});

test('both complete witnesses are mandatory for new V2 plans and present malformed witnesses never select legacy replay', () => {
  const value = fixture(), plan = build(value);
  for (const side of ['sourceObservation', 'destinationObservation'] as const) for (const witness of [undefined, null, 0, []]) {
    const bad = clone(input(value)), original = bad[side];
    const observation = { stage: original.stage, nativeBindings: original.nativeBindings, privateNativeStates: original.privateNativeStates,
      privateCatalogue: witness };
    assert.throws(() => createWorkspaceOperationNativeCopyPlanV2({ ...bad, [side]: observation } as unknown as Input), invalid);
    assert.throws(() => current(plan, { ...value, [side]: observation } as unknown as Fixture), invalid);
  }
  for (const side of ['sourceObservation', 'destinationObservation'] as const) {
    const bad = clone(input(value)); delete bad[side].privateCatalogue;
    assert.throws(() => createWorkspaceOperationNativeCopyPlanV2(bad), invalid);
  }
});

test('V1/V2 plan and Evidence discriminants cannot be mixed or silently upgraded', () => {
  const value = fixture(), one = createWorkspaceOperationNativeCopyPlanV1(input(value)), two = build(value);
  const probes: unknown[] = [{ ...one, version: 2 }, { ...one, integrityProof: two.integrityProof },
    { ...two, version: 1 }, { ...two, sourceEvidence: one.sourceEvidence }, { ...two, destinationEvidence: one.destinationEvidence }];
  const mixed = clone(two); mixed.sourceEvidence = clone(one.sourceEvidence) as unknown as MutablePlan['sourceEvidence']; resign(mixed);
  probes.push(mixed);
  const extra = { ...clone(two), extra: true }; probes.push(extra);
  const missing = { ...two } as Record<string, unknown>; delete missing.integrityProof; probes.push(missing);
  for (const plan of probes) assert.throws(() => decodeWorkspaceOperationNativeCopyPlan(plan), invalid);
});

test('raw integrity binds opaque compiler fields and IDs even when the semantic preview ID is unchanged', () => {
  const plan = build(fixture());
  for (const field of ['compilerPlanProof', 'finalGraphProof'] as const) {
    const forged = clone(plan); forged[field] = 'f'.repeat(64);
    assert.equal(computeWorkspaceOperationNativeCopyPlanId(forged), plan.planId);
    assert.throws(() => decodeWorkspaceOperationNativeCopyPlan(forged), invalid);
    assert.notEqual(resign(forged).integrityProof, plan.integrityProof);
  }
  const wrongId = clone(plan); wrongId.planId = 'f'.repeat(64); resign(wrongId);
  assert.throws(() => decodeWorkspaceOperationNativeCopyPlan(wrongId), invalid);
  const invalidDigest = { ...plan, integrityProof: 'invalid' };
  assert.throws(() => decodeWorkspaceOperationNativeCopyPlan(invalidDigest), invalid);
});

test('rehashing opaque compiler/content claims still cannot replace actual Current replay', () => {
  const value = fixture(), plan = build(value);
  for (const field of ['compilerPlanProof', 'finalGraphProof', 'sourceContentBasisProof'] as const) {
    const forged = clone(plan);
    if (field === 'sourceContentBasisProof') forged.cloneRequirements[0].sourceContentBasisProof = 'f'.repeat(64);
    else forged[field] = 'f'.repeat(64);
    resign(forged); assert.equal(forged.planId, plan.planId);
    const historical = decodeWorkspaceOperationNativeCopyPlan(forged);
    assert.equal(historical.executionReady, false); assert.throws(() => current(historical, value), changed);
  }
});

test('rehashed path mappings, clone membership and scopes are still independently rederived', () => {
  const value = fixture(), plan = build(value);
  const mutations: Array<(value: MutablePlan) => void> = [
    value => { value.nativePathPlan.pathMappings[0].destinationPath = 'forged.md'; },
    value => { value.cloneRequirements[0].entityKey = 'f'.repeat(64); },
    value => { value.cloneRequirements[0].sourceEntityKey = 'f'.repeat(64); },
    value => { value.cloneRequirements[0].linkBindings[0].originEvidenceLinkId = 'forged-link'; },
    value => { value.sourceScope.rootPath = '/different/root'; },
  ];
  for (const mutate of mutations) {
    const forged = clone(plan); mutate(forged);
    const { planId: _old, ...body } = forged.nativePathPlan; forged.nativePathPlan.planId = proof(body);
    resign(forged, true); assert.throws(() => decodeWorkspaceOperationNativeCopyPlan(forged), invalid);
  }
});

test('self-consistent foreign catalogue semantics are historical claims until compared to a genuine fresh witness', () => {
  const value = fixture(), plan = build(value), alternate = clone(value);
  alternate.sourceObservation.privateCatalogue.find(row => row.authority === 'pristine')!.lineage_id = 'foreign-asset-lineage';
  refresh(alternate.sourceObservation); const other = build(alternate);
  assert.notEqual(other.planId, plan.planId);
  const forged = clone(plan); forged.sourceEvidence.semanticCatalogueProof = other.sourceEvidence.semanticCatalogueProof;
  forged.sourceEvidence.semanticProof = other.sourceEvidence.semanticProof;
  const { evidenceProof: _old, ...evidenceBody } = forged.sourceEvidence; forged.sourceEvidence.evidenceProof = proof(evidenceBody);
  resign(forged, true);
  assert.deepEqual(forged.sourceEvidence.stage, plan.sourceEvidence.stage);
  const historical = decodeWorkspaceOperationNativeCopyPlan(forged);
  assert.throws(() => current(historical, value), changed);
});

test('IDs, lineage, generation, byte profile and complete source/destination scopes remain semantic identity', () => {
  const value = fixture(), plan = build(value);
  for (const side of ['sourceObservation', 'destinationObservation'] as const) {
    for (const change of [{ documentId: `${side}-replacement-D2` }, { lifecycleGeneration: 2 },
      { newlineStyle: 'crlf' as const }, { hasBom: true }]) {
      const next = clone(value); replaceNative(next[side], 0, { ...next[side].privateNativeStates[0], ...change });
      assertChanged(plan, next);
    }
    const next = clone(value), binding = next[side].nativeBindings[0];
    binding.expected.lineageId = binding.registry.lineageId = binding.lineage.lineageId = `${side}-different-lineage`;
    next[side].privateCatalogue.find(row => row.id === binding.expected.documentId)!.lineage_id = binding.expected.lineageId;
    refresh(next[side]); assertChanged(plan, next);
  }
  for (const side of ['sourceScope', 'destinationScope'] as const) for (const changes of [
    { rootPath: '/different/root' }, { ownerUserId: 'different-owner' }, { rootRelativePath: 'users/different' },
  ]) {
    const next = clone(value); Object.assign(next[side].workspace, changes); assertChanged(plan, next);
  }
});

test('catalogue membership, real assets, directory inodes and namespace paths still invalidate the preview', () => {
  const value = fixture(), plan = build(value);
  for (const side of ['sourceObservation', 'destinationObservation'] as const) {
    const mutations: Array<(value: FullObservation) => void> = [
      value => { value.privateCatalogue.find(row => row.authority === 'initialized')!.has_state_history = false; },
      value => { const asset = value.privateCatalogue.find(row => row.authority === 'pristine')!;
        value.privateCatalogue.push({ ...asset, id: 'new-asset', path: 'new-asset.bin' }); },
      value => { value.stage.namespace.find(entry => entry.path === 'assets')!.identity = '1:999:4096:100:100';
        value.stage.namespace.find(entry => entry.path === 'assets')!.filesystemIdentity = '1:999:4096:100:100'; },
      value => { const asset = value.stage.namespace.find(entry => entry.path === 'assets/report.pdf')!;
        asset.identity = asset.filesystemIdentity = '1:31:4:100:100'; },
      value => { value.stage.namespace.find(entry => entry.path === 'assets/report.pdf')!.path = 'assets/Report.pdf'; },
      value => { value.stage.namespace = value.stage.namespace.filter(entry => entry.path !== 'assets/report.pdf'); },
    ];
    for (const mutate of mutations) { const next = clone(value); mutate(next[side]); refresh(next[side]); assertChanged(plan, next); }
  }
  const occupied = clone(value), source = occupied.sourceObservation.privateNativeStates[0];
  const destination = occupied.destinationObservation;
  const copiedState = { ...clone(source), documentId: 'occupied-native', workspaceId: occupied.destinationScope.workspace.workspaceId };
  const existing = destination.privateNativeStates[0];
  replaceNative(destination, 0, { ...copiedState, organizationId: existing.organizationId });
  assert.throws(() => build(occupied), code('NATIVE_COPY_PLAN_UNSUPPORTED'));
});

test('deletion-only native changes cannot reuse the preview even with the same vector and sequence', () => {
  const value = fixture(), plan = build(value), state = value.sourceObservation.privateNativeStates[0], doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state.yjsState); doc.getText('content').delete(0, 1);
    const update = { ...state, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
    assert.deepEqual(update.stateVector, state.stateVector); assert.notEqual(hash(update.yjsState), hash(state.yjsState));
    const stale = clone(value); stale.sourceObservation.privateNativeStates[0] = update;
    assert.throws(() => build(stale), invalid);
    const coherent = clone(value); replaceNative(coherent.sourceObservation, 0, update); assertChanged(plan, coherent);
  } finally { doc.destroy(); }
});

test('selection order, full original inputs and private native bytes are captured without caller aliases', () => {
  const value = fixture(), sourceBytes = clone(value.sourceObservation.privateNativeStates), plan = build(value), serialized = JSON.stringify(plan);
  const reversed = clone(value); reversed.selections = [...reversed.selections].reverse();
  assert.notEqual(build(reversed).planId, plan.planId);
  const shared = clone(value); shared.sourceScope.workspace.permissions.canWrite = false;
  shared.sourceScope.workspace.permissions.canDelete = false;
  const dataOnly = build(shared); assert.equal(dataOnly.executionReady, false);
  value.sourceObservation.privateCatalogue[0].id = 'later'; value.sourceObservation.privateNativeStates[0].yjsState.fill(0);
  value.sourceObservation.stage.namespace[0].path = 'later.md'; value.sourceScope.workspace.rootPath = '/later/root';
  value.selections = [{ sourcePath: 'later.md', destinationPath: 'elsewhere.md' }];
  assert.equal(JSON.stringify(plan), serialized); assert(Object.isFrozen(plan)); assert(Object.isFrozen(plan.sourceEvidence.nativeBindings[0].expected));
  assert.notEqual(hash(sourceBytes[0].yjsState), hash(value.sourceObservation.privateNativeStates[0].yjsState));
  assert.equal(JSON.stringify(plan).includes('yjsState'), false); assert.equal(JSON.stringify(plan).includes('privateCatalogue'), false);
});

test('public preview exposes the semantic ID without the private raw integrity/evidence fields', () => {
  const plan = build(fixture()), preview = workspaceOperationNativeCopyPublicPreview(plan), serialized = JSON.stringify(preview);
  assert.equal(preview.planId, plan.planId); assert.equal(preview.kind, 'native-copy'); assert.equal(preview.readiness, 'ready');
  for (const hidden of ['integrityProof', 'sourceEvidence', 'semanticCatalogueProof', 'compilerPlanProof', plan.integrityProof,
    plan.sourceEvidence.evidenceProof, plan.sourceEvidence.nativeBindings[0].expected.binaryHash]) assert.equal(serialized.includes(hidden), false, hidden);
});

test('earlier decoder reuse never caches a mutable raw V2 caller reference or exempts a later integrity change', () => {
  const raw = clone(build(fixture()));
  withNativeCopyPlanValidation(() => {
    const first = decodeWorkspaceOperationNativeCopyPlan(raw); assert.notEqual(first, raw);
    assert.equal(decodeWorkspaceOperationNativeCopyPlan(first), first);
    raw.compilerPlanProof = 'f'.repeat(64);
    assert.throws(() => decodeWorkspaceOperationNativeCopyPlan(raw), invalid);
  });
});

test('own-data getters and top-level, nested, revoked and witness Proxies fail without executing caller code', () => {
  const value = fixture(), plan = build(value); let accesses = 0;
  const trap = (): never => { accesses++; throw new Error('Caller code must not execute.'); };
  const proxied = <T extends object>(value: T): T => new Proxy<T>(value, { get: trap, ownKeys: trap,
    getPrototypeOf: trap, getOwnPropertyDescriptor: trap, has: trap });
  assert.throws(() => createWorkspaceOperationNativeCopyPlanV2(proxied(input(value))), invalid);
  const values = [
    { ...input(value), sourceObservation: proxied(value.sourceObservation) },
    { ...input(value), sourceObservation: { ...value.sourceObservation, privateCatalogue: proxied(value.sourceObservation.privateCatalogue) } },
    { ...input(value), sourceObservation: { ...value.sourceObservation, nativeBindings: proxied(value.sourceObservation.nativeBindings) } },
  ];
  for (const candidate of values) assert.throws(() => createWorkspaceOperationNativeCopyPlanV2(candidate), invalid);
  for (const side of ['sourceScope', 'destinationScope'] as const) {
    const candidate = input(value);
    assert.throws(() => createWorkspaceOperationNativeCopyPlanV2({ ...candidate,
      [side]: { ...candidate[side], workspace: proxied(candidate[side].workspace) } }), invalid);
    const revokedWorkspace = Proxy.revocable(candidate[side].workspace, {}); revokedWorkspace.revoke();
    assert.throws(() => createWorkspaceOperationNativeCopyPlanV2({ ...candidate,
      [side]: { ...candidate[side], workspace: revokedWorkspace.proxy } }), invalid);
  }
  const accessor = input(value); Object.defineProperty(accessor, 'selections', { enumerable: true, get: trap });
  assert.throws(() => createWorkspaceOperationNativeCopyPlanV2(accessor), invalid);
  const witness = clone(value); Object.defineProperty(witness.sourceObservation, 'privateCatalogue', { enumerable: true, get: trap });
  assert.throws(() => build(witness), invalid);
  assert.throws(() => decodeWorkspaceOperationNativeCopyPlan(proxied(plan)), invalid);
  assert.throws(() => computeWorkspaceOperationNativeCopyPlanId(proxied(plan)), invalid);
  assert.throws(() => computeWorkspaceOperationNativeCopyPlanIntegrityProof(proxied(plan)), invalid);
  assert.throws(() => current(proxied(plan), value), invalid);
  assert.throws(() => current(plan, { ...value, destinationObservation: proxied(value.destinationObservation) }), invalid);
  const currentInput = { sourceScope: plan.sourceScope, destinationScope: plan.destinationScope,
    sourceObservation: value.sourceObservation, destinationObservation: value.destinationObservation };
  assert.throws(() => assertWorkspaceOperationNativeCopyPlanCurrent(plan, proxied(currentInput)), invalid);
  for (const side of ['sourceScope', 'destinationScope'] as const) {
    assert.throws(() => assertWorkspaceOperationNativeCopyPlanCurrent(plan, { ...currentInput,
      [side]: proxied(currentInput[side]) }), invalid);
    const revokedScope = Proxy.revocable(currentInput[side], {}); revokedScope.revoke();
    assert.throws(() => assertWorkspaceOperationNativeCopyPlanCurrent(plan, { ...currentInput,
      [side]: revokedScope.proxy }), invalid);
  }
  const nested = { ...plan, sourceEvidence: proxied(plan.sourceEvidence) };
  assert.throws(() => decodeWorkspaceOperationNativeCopyPlan(nested), invalid);
  assert.throws(() => computeWorkspaceOperationNativeCopyPlanIntegrityProof(nested), invalid);
  const revoked = Proxy.revocable(input(value), {}); revoked.revoke();
  assert.throws(() => createWorkspaceOperationNativeCopyPlanV2(revoked.proxy), invalid);
  assert.equal(accesses, 0);
});

test('catalogue and raw-plan budgets remain enforced independently of a valid semantic identity', () => {
  const value = fixture(), excessive = clone(value), row = excessive.sourceObservation.privateCatalogue[0];
  excessive.sourceObservation.privateCatalogue = Array.from({ length: 10_001 }, (_, index) => ({ ...row,
    id: `budget-${index}`, path: `budget/${index}.bin` }));
  refresh(excessive.sourceObservation); assert.throws(() => build(excessive), tooLarge);
  const oversized = { ...build(value), extra: 'x'.repeat(16 * 1024 * 1024 + 1) };
  assert.throws(() => decodeWorkspaceOperationNativeCopyPlan(oversized), tooLarge);
});

function stageInput(value: Fixture, plan: WorkspaceOperationNativeCopyPlanV2): WorkspaceOperationNativeCopyStageInput {
  // New OriginalV2 wire-format fixture, never reinterpret an existing persisted
  // V1 original in place and never claim an actual FD preparation happened.
  const physical = value.original.physical.map(item => ({ selectionIndex: item.selectionIndex,
    original: { ...clone(item.original), version: 2 as const, sourceProjectionPolicy: 'native-derived-leaves-v2' as const } }));
  return { operationId: value.original.identity.operationId, request: value.original.request, plan, physical,
    nativeRecords: [...value.sourceObservation.privateNativeStates, ...value.destinationObservation.privateNativeStates]
      .map(state => ({ lineageId: [...plan.sourceEvidence.nativeBindings, ...plan.destinationEvidence.nativeBindings]
        .find(binding => binding.expected.documentId === state.documentId)!.expected.lineageId, state })) };
}
function metadata(plan: WorkspaceOperationNativeCopyPlanV2) {
  return { version: 1 as const, kind: 'shared-title-copy' as const, planId: plan.planId,
    sourceWorkspaceId: plan.sourceScope.workspaceId, destinationWorkspaceId: plan.destinationScope.workspaceId,
    mappingsProof: proof({ version: 1, kind: 'native-copy-title-mappings', planId: plan.planId,
      mappings: plan.nativePathPlan.pathMappings.map(mapping => ({ sourcePath: mapping.source.path, destinationPath: mapping.destinationPath })) }),
    vacancyScopes: ['keep.md', 'note.md'], exactVacancyPaths: [], sourceRows: [
      { path: 'keep.md', title: null, createdAt: 10, updatedAt: 11 },
      { path: 'note.md', title: 'Shared title', createdAt: 12, updatedAt: 13 }] };
}
function rehashManifest(manifest: Mutable<NativeCopyStageManifest>): void {
  const body = { ...manifest, version: 2 } as Record<string, unknown>;
  delete body.payloadSha256; delete body.coreV2StageDigest; delete body.metadata;
  const core = hash(JSON.stringify(body));
  if (manifest.version === 2) manifest.payloadSha256 = core;
  else { manifest.coreV2StageDigest = core; manifest.payloadSha256 = nativeCopyMetadataCompositeDigest(core, nativeCopyMetadataWitness(manifest.metadata)); }
}

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
  test(`${representation}: Stage2/3 retain new Plan2, Original2 and exact native records through witness-free historical replay`, () => {
    const value = fixture(representation), plan = build(value), base = stageInput(value, plan), before = clone(base);
    for (const version of [2, 3] as const) {
      const prepared = prepareNativeCopyStage(version === 2 ? base : { ...base, metadata: metadata(plan) });
      assert.equal(prepared.manifest.version, version); assertNativeCopyStageManifestDigest(prepared.manifest);
      const stage = decodeNativeCopyStage(prepared.manifest, prepared.recordsBytes, prepared.manifest.identity);
      assert.equal(stage.plan.version, 2); assert.deepEqual(stage.plan, plan); assert.deepEqual(stage.nativeRecords, base.nativeRecords);
      assert(stage.physical.every(item => item.original.version === 2 && item.original.sourceProjectionPolicy === 'native-derived-leaves-v2'));
      assert.equal(current(stage.plan, value, false).planId, plan.compilerPlanProof);
      const repeated = prepareNativeCopyStage(version === 2 ? { ...base, plan: stage.plan }
        : { ...base, plan: stage.plan, metadata: metadata(plan) });
      assert.deepEqual(repeated.manifestBytes, prepared.manifestBytes); assert.deepEqual(repeated.recordsBytes, prepared.recordsBytes);
    }
    assert.deepEqual(base, before); assert(value.original.physical.every(item => item.original.version === 1));
  });
}

test('Stage bridge rejects both Plan/Original version mixtures and rehashed foreign physical originals', () => {
  const value = fixture(), plan = build(value), base = stageInput(value, plan);
  assert.throws(() => prepareNativeCopyStage({ ...base, physical: value.original.physical }), invalidStage);
  assert.throws(() => prepareNativeCopyStage({ ...base, plan: createWorkspaceOperationNativeCopyPlanV1(input(value)) }), invalidStage);
  const prepared = prepareNativeCopyStage({ ...base, metadata: metadata(plan) });
  const tampered = clone(prepared.manifest); tampered.physical[0].original.destinationPath = 'foreign.md';
  rehashManifest(tampered); assertNativeCopyStageManifestDigest(tampered);
  assert.throws(() => decodeNativeCopyStage(tampered, prepared.recordsBytes, prepared.manifest.identity), corruptStage);
});
