import assert from 'node:assert/strict';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { inspectOriginalPhysicalLinks, workspaceSourceAuthorityStageProof } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation } from '../app/lib/markdown/workspace-source-authority-stage';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import { createWorkspaceOperationNativeMoveBatchPlan, createWorkspaceOperationNativeMoveBatchPlanV1,
  createWorkspaceOperationNativeMoveBatchPlanV2, createWorkspaceOperationNativeMoveBatchPlanV3,
  decodeWorkspaceOperationNativeMoveBatchPlan, computeWorkspaceOperationNativeMoveBatchPlanId,
  computeWorkspaceOperationNativeMoveBatchPlanIntegrityProof, assertWorkspaceOperationNativeMoveBatchPlanCurrent,
  captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness, getWorkspaceOperationNativeMoveLinkRecipes,
  WorkspaceOperationNativeMovePlanError } from '../app/lib/files/workspace-operation-native-move-plan';
import { decodeWorkspaceOperationNativeOriginalSourceWitness, decodeWorkspaceOperationMixedOriginalSourceWitness } from '../app/lib/files/workspace-operation-native-original-source';
import { WorkspaceOperationNativeSourceEvidenceError } from '../app/lib/files/workspace-operation-native-source-evidence';
import { nativeCopyMetadataFixture } from './helpers/native-copy-metadata-codec-fixture';

// Actual Yjs/native/physical parsers and planners. Declared catalogue/namespace
// data only; no DB, FS, ACL, claim, admission, owner, import or recovery proof.
type Mutable<T> = T extends Uint8Array ? Uint8Array : T extends readonly unknown[] ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
function moveV3Fixture(representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks' = 'plain_text', rawText = '# Unrelated raw\n') {
  const original = nativeCopyMetadataFixture(representation), evidence = original.plan.sourceEvidence;
  const nativeBindings = structuredClone(evidence.nativeBindings).map(binding => ({ ...binding,
    expected: { ...binding.expected, registryStateVersion: 6 }, registry: { ...binding.registry, stateVersion: 6 } }));
  const privateCatalogue: WorkspaceDocumentCatalogueEntry[] = nativeBindings.map(binding => ({ id: binding.expected.documentId,
    lineage_id: binding.expected.lineageId, path: binding.expected.path, workspace_id: binding.expected.workspaceId,
    organization_id: binding.expected.organizationId, status: 'active', state_version: 6, yjs_state_lifecycle: 'initialized',
    has_persisted_state: true, has_state_history: true, lifecycle_generation: binding.expected.lifecycleGeneration,
    authority: 'initialized', state_status: 'active', state_path: binding.expected.path,
    state_workspace_id: binding.expected.workspaceId, state_organization_id: binding.expected.organizationId }));
  const observation: Mutable<WorkspaceLinkSourceAuthorityObservation> & { privateCatalogue: WorkspaceDocumentCatalogueEntry[] } = { stage: structuredClone(evidence.stage), nativeBindings,
    privateNativeStates: structuredClone(original.nativeRecords.filter(record => record.state.workspaceId === evidence.workspaceScope.workspaceId).map(record => record.state)),
    privateCatalogue };
  const bytes = Buffer.from(rawText), filesystemIdentity = `1:41:${bytes.length}:100:100`;
  observation.stage.namespace.push({ workspaceId: evidence.workspaceScope.workspaceId, path: 'raw.md', kind: 'file',
    identity: filesystemIdentity, filesystemIdentity, documentId: null, lifecycleGeneration: null },
  { workspaceId: evidence.workspaceScope.workspaceId, path: 'folder', kind: 'directory', identity: '1:40:4096:100:100',
    filesystemIdentity: '1:40:4096:100:100', documentId: null, lifecycleGeneration: null });
  observation.stage.sources.push({ kind: 'physical', inventory: inspectOriginalPhysicalLinks({ workspaceId: evidence.workspaceScope.workspaceId,
    organizationId: evidence.workspaceScope.organizationId, path: 'raw.md', authority: { kind: 'unregistered', catalogueProof: '0'.repeat(64) }, bytes, filesystemIdentity }) });
  refreshMoveV3Fixture(observation);
  const scope: WorkspaceOperationBatchScope = { workspace: { ...evidence.workspaceScope,
    rootRelativePath: evidence.workspaceScope.rootRelativePath ?? undefined, legacy: false, status: 'active', permissions: {
    canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: false } }, fileOptions: {} };
  const input = { scope, actions: [{ reviewId: 'move-v3-fixture', kind: 'move' as const,
    selections: [{ sourcePath: 'note.md', destinationPath: 'folder/renamed.md' }] }], observation };
  return { input, jobScope: captureWorkspaceOperationJobScope(scope.workspace) };
}

function refreshMoveV3Fixture(observation: WorkspaceLinkSourceAuthorityObservation & { privateCatalogue: WorkspaceDocumentCatalogueEntry[] }): void {
  observation.stage.catalogueProof = proof(observation.privateCatalogue);
  observation.stage.sources = observation.stage.sources.map(source => source.kind === 'native' ? source : ({ kind: 'physical',
    inventory: inspectOriginalPhysicalLinks({ workspaceId: source.inventory.workspaceId, organizationId: source.inventory.organizationId,
      path: source.inventory.path, bytes: source.inventory.originalBytes, filesystemIdentity: source.inventory.physical.filesystemIdentity,
      authority: { ...source.inventory.authority, catalogueProof: observation.stage.catalogueProof! } }) }));
  observation.stage.readiness = observation.stage.sources.some(source => source.kind === 'physical') ? 'requires-import-and-rebinding' : 'native-coordinator-required';
  observation.stage.stageProof = workspaceSourceAuthorityStageProof(observation.stage);
}

export function workspaceOperationNativeMovePlanV3Test(): void {
  let passed = 0;
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    const fixture = moveV3Fixture(representation), before = structuredClone(fixture);
    const plan = createWorkspaceOperationNativeMoveBatchPlanV3(fixture.input);
    assert.equal(plan.version, 3); assert.equal(plan.planIdentityVersion, 3);
    assert.equal(plan.sourceEvidence.evidenceVersion, 3); assert.equal(plan.nativePathPlan.contractVersion, 3);
    assert.equal(plan.sourceEvidence.namespace.some(entry => entry.path === 'raw.md'), true);
    assert.equal(plan.sourceEvidence.nativeComponent.stage.namespace.some(entry => entry.path === 'raw.md'), false);
    assert.deepEqual(decodeWorkspaceOperationNativeMoveBatchPlan(JSON.parse(JSON.stringify(plan))), plan);
    assert.equal(computeWorkspaceOperationNativeMoveBatchPlanId(plan), plan.planId);
    assert.equal(computeWorkspaceOperationNativeMoveBatchPlanIntegrityProof(plan), plan.integrityProof);
    const current = assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan, fixture.input.observation, fixture.jobScope);
    assert.equal(current.contractVersion, 3); assert.equal(current.planId, plan.compilerPlanProof); assert.equal(current.finalGraphProof, plan.finalGraphProof);
    const witness = captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan, fixture.input.observation, fixture.jobScope);
    assert.deepEqual(witness, plan.sourceEvidence); assert(Object.isFrozen(witness));
    assert.deepEqual(decodeWorkspaceOperationMixedOriginalSourceWitness(plan.sourceEvidence, witness), witness);
    assert(getWorkspaceOperationNativeMoveLinkRecipes(plan).every(recipe => recipe.source.path !== 'raw.md'));
    assert.deepEqual(fixture, before);
  }
  passed++;

  // Same semantic original request survives only proven projection/checkpoint clocks.
  {
    const fixture = moveV3Fixture(), first = createWorkspaceOperationNativeMoveBatchPlanV3(fixture.input), next = structuredClone(fixture);
    for (const binding of next.input.observation.nativeBindings) {
      binding.expected.registryStateVersion = 7; binding.registry.stateVersion = 7;
      next.input.observation.privateCatalogue.find(row => row.id === binding.expected.documentId)!.state_version = 7;
      next.input.observation.stage.namespace.find(entry => entry.documentId === binding.expected.documentId)!.filesystemIdentity = '8:80:123:300:301';
    }
    refreshMoveV3Fixture(next.input.observation);
    const second = createWorkspaceOperationNativeMoveBatchPlanV3(next.input);
    assert.equal(first.planId, second.planId); assert.notEqual(first.integrityProof, second.integrityProof);
    assert.notEqual(first.sourceEvidence.physicalSources[0].physicalSourceProof, second.sourceEvidence.physicalSources[0].physicalSourceProof);
    const witness = captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(first, next.input.observation, next.jobScope);
    assert.deepEqual(witness, second.sourceEvidence); assert.equal(witness.semanticProof, first.sourceEvidence.semanticProof);
    assert.equal(assertWorkspaceOperationNativeMoveBatchPlanCurrent(first, next.input.observation, next.jobScope).planId, first.compilerPlanProof);
  }
  passed++;

  // Selected raw and required raw incoming rewrites cannot become native recipes.
  for (const incoming of [false, true]) {
    const fixture = moveV3Fixture('plain_text', incoming ? '[Native](note.md)' : 'Raw');
    if (!incoming) fixture.input.actions[0].selections[0].sourcePath = 'raw.md';
    assert.throws(() => createWorkspaceOperationNativeMoveBatchPlanV3(fixture.input), error =>
      error instanceof WorkspaceOperationNativeMovePlanError && error.code === 'NATIVE_MOVE_PLAN_UNSUPPORTED');
  }
  passed++;

  // Real fileVersion/content changes and missing/malformed full catalogue are terminal.
  for (const change of ['inode', 'content', 'missing-catalogue', 'malformed-catalogue'] as const) {
    const fixture = moveV3Fixture(), plan = createWorkspaceOperationNativeMoveBatchPlanV3(fixture.input);
    const observation = structuredClone(fixture.input.observation);
    if (change === 'missing-catalogue') Reflect.deleteProperty(observation, 'privateCatalogue');
    else if (change === 'malformed-catalogue') Reflect.set(observation, 'privateCatalogue', null);
    else {
      const physical = observation.stage.sources.find(source => source.kind === 'physical')!; assert(physical.kind === 'physical');
      if (change === 'content') physical.inventory.originalBytes[0] ^= 1;
      else {
        physical.inventory.physical.filesystemIdentity = physical.inventory.physical.filesystemIdentity.replace('1:41:', '1:99:');
        const entry = observation.stage.namespace.find(entry => entry.path === 'raw.md')!;
        entry.identity = entry.filesystemIdentity = physical.inventory.physical.filesystemIdentity;
      }
      refreshMoveV3Fixture(observation);
    }
    for (const operation of [() => captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan, observation, fixture.jobScope),
      () => assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan, observation, fixture.jobScope)]) {
      assert.throws(operation, error => error instanceof WorkspaceOperationNativeMovePlanError
        && error.code === (change === 'inode' || change === 'content' ? 'NATIVE_MOVE_PLAN_CHANGED' : 'NATIVE_MOVE_PLAN_INVALID'));
    }
  }
  passed++;

  // Independently rederive historical recipes and bind every compiler assertion.
  {
    const fixture = moveV3Fixture(), original = createWorkspaceOperationNativeMoveBatchPlanV3(fixture.input);
    for (const change of ['integrity', 'mapping', 'compiler'] as const) {
      const forged = structuredClone(original) as Mutable<typeof original>;
      if (change === 'integrity') forged.integrityProof = 'f'.repeat(64);
      if (change === 'mapping') forged.nativePathPlan.pathMappings[0].destinationPath = 'forged.md';
      if (change === 'compiler') forged.compilerPlanProof = 'f'.repeat(64);
      if (change !== 'integrity') forged.integrityProof = computeWorkspaceOperationNativeMoveBatchPlanIntegrityProof(forged);
      if (change === 'compiler') {
        const decoded = decodeWorkspaceOperationNativeMoveBatchPlan(forged);
        assert.throws(() => assertWorkspaceOperationNativeMoveBatchPlanCurrent(decoded, fixture.input.observation, fixture.jobScope), error =>
          error instanceof WorkspaceOperationNativeMovePlanError && error.code === 'NATIVE_MOVE_PLAN_CHANGED');
      } else assert.throws(() => decodeWorkspaceOperationNativeMoveBatchPlan(forged), error =>
        error instanceof WorkspaceOperationNativeMovePlanError && error.code === 'NATIVE_MOVE_PLAN_INVALID');
    }
  }
  passed++;

  // Existing auto/V1/V2 remain old creation. The new witness decoder never
  // reinterprets evidence versions or changes the old V2 decoder behavior.
  {
    const fixture = moveV3Fixture(), mixed = createWorkspaceOperationNativeMoveBatchPlanV3(fixture.input);
    const nativeInput = structuredClone(fixture.input);
    nativeInput.observation.stage.sources = nativeInput.observation.stage.sources.filter(source => source.kind === 'native');
    nativeInput.observation.stage.namespace = nativeInput.observation.stage.namespace.filter(entry => entry.path !== 'raw.md');
    refreshMoveV3Fixture(nativeInput.observation);
    const v1 = createWorkspaceOperationNativeMoveBatchPlanV1(nativeInput), v2 = createWorkspaceOperationNativeMoveBatchPlanV2(nativeInput);
    assert.deepEqual(createWorkspaceOperationNativeMoveBatchPlan(nativeInput), v2);
    assert.equal(Object.hasOwn(v1, 'planIdentityVersion'), false); assert.equal(v2.planIdentityVersion, 2);
    const { planId: _id, ...v1Body } = v1; assert.equal(v1.planId, proof(v1Body));
    const { integrityProof: _integrity, ...v2Body } = v2; assert.equal(v2.integrityProof, proof({ integrityVersion: 2, plan: v2Body }));
    assert.equal(v2.planId, proof({ version: 3, planIdentityVersion: 2, kind: v2.kind, workspaceId: v2.workspaceId,
      readiness: v2.readiness, executionReady: v2.executionReady, actions: v2.actions,
      workspaceScope: v2.sourceEvidence.workspaceScope, sourceSemanticProof: v2.sourceEvidence.semanticProof }));
    assert.deepEqual(decodeWorkspaceOperationMixedOriginalSourceWitness(v2.sourceEvidence, v2.sourceEvidence),
      decodeWorkspaceOperationNativeOriginalSourceWitness(v2.sourceEvidence, v2.sourceEvidence));
    assert.throws(() => decodeWorkspaceOperationMixedOriginalSourceWitness(mixed.sourceEvidence, v2.sourceEvidence), WorkspaceOperationNativeSourceEvidenceError);
    assert.throws(() => decodeWorkspaceOperationMixedOriginalSourceWitness(v2.sourceEvidence, mixed.sourceEvidence), WorkspaceOperationNativeSourceEvidenceError);
    const before = [JSON.stringify(v1), JSON.stringify(v2)]; createWorkspaceOperationNativeMoveBatchPlanV3(fixture.input);
    assert.deepEqual([JSON.stringify(createWorkspaceOperationNativeMoveBatchPlanV1(nativeInput)), JSON.stringify(createWorkspaceOperationNativeMoveBatchPlanV2(nativeInput))], before);
  }
  passed++;
  assert.equal(passed, 6);
  console.log(JSON.stringify({ suite: 'native-move-plan-v3', passed, pureFactsOnly: true }));
}
