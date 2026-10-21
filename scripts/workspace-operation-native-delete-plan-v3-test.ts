import assert from 'node:assert/strict';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { inspectOriginalPhysicalLinks, workspaceSourceAuthorityStageProof } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation } from '../app/lib/markdown/workspace-source-authority-stage';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import { createWorkspaceOperationNativeDeleteBatchPlan, createWorkspaceOperationNativeDeleteBatchPlanLegacy,
  createWorkspaceOperationNativeDeleteBatchPlanV2, createWorkspaceOperationNativeDeleteBatchPlanV3,
  decodeWorkspaceOperationNativeDeleteBatchPlan, computeWorkspaceOperationNativeDeleteBatchPlanId,
  computeWorkspaceOperationNativeDeleteBatchPlanIntegrityProof, assertWorkspaceOperationNativeDeleteBatchPlanCurrent,
  captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness, getWorkspaceOperationNativeDeleteLinkRecipes,
  WorkspaceOperationNativeDeletePlanError } from '../app/lib/files/workspace-operation-native-delete-plan';
import { WorkspaceOperationNativeSourceEvidenceError } from '../app/lib/files/workspace-operation-native-source-evidence';
import { nativeCopyMetadataFixture } from './helpers/native-copy-metadata-codec-fixture';

// Actual Yjs, native/physical parsers, mixed planner and compiler. Catalogue and
// namespace inputs are declared data; this proves no DB/FS/ACL/owner/COMMIT.
type Mutable<T> = T extends Uint8Array ? Uint8Array : T extends readonly unknown[] ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
function deleteV3Fixture(representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks' = 'plain_text', rawText = '# Raw\n') {
  const original = nativeCopyMetadataFixture(representation), evidence = original.plan.sourceEvidence;
  const nativeBindings = structuredClone(evidence.nativeBindings).map(binding => ({ ...binding,
    expected: { ...binding.expected, registryStateVersion: 6 }, registry: { ...binding.registry, stateVersion: 6 } }));
  const privateCatalogue: WorkspaceDocumentCatalogueEntry[] = nativeBindings.map(binding => ({ id: binding.expected.documentId,
    lineage_id: binding.expected.lineageId, path: binding.expected.path, workspace_id: binding.expected.workspaceId,
    organization_id: binding.expected.organizationId, status: 'active', state_version: binding.expected.registryStateVersion,
    yjs_state_lifecycle: 'initialized', has_persisted_state: true, has_state_history: true,
    lifecycle_generation: binding.expected.lifecycleGeneration, authority: 'initialized', state_status: 'active',
    state_path: binding.expected.path, state_workspace_id: binding.expected.workspaceId, state_organization_id: binding.expected.organizationId }));
  const observation: Mutable<WorkspaceLinkSourceAuthorityObservation> & { privateCatalogue: WorkspaceDocumentCatalogueEntry[] } = {
    stage: structuredClone(evidence.stage), nativeBindings,
    privateNativeStates: structuredClone(original.nativeRecords.filter(record => record.state.workspaceId === evidence.workspaceScope.workspaceId).map(record => record.state)),
    privateCatalogue };
  const bytes = Buffer.from(rawText), filesystemIdentity = `1:41:${bytes.length}:100:100`;
  observation.stage.namespace.push({ workspaceId: evidence.workspaceScope.workspaceId, path: 'raw.md', kind: 'file',
    identity: filesystemIdentity, filesystemIdentity, documentId: null, lifecycleGeneration: null });
  observation.stage.sources.push({ kind: 'physical', inventory: inspectOriginalPhysicalLinks({ workspaceId: evidence.workspaceScope.workspaceId,
    organizationId: evidence.workspaceScope.organizationId, path: 'raw.md', authority: { kind: 'unregistered', catalogueProof: '0'.repeat(64) }, bytes, filesystemIdentity }) });
  refreshDeleteV3Fixture(observation);
  const scope: WorkspaceOperationBatchScope = { workspace: { ...evidence.workspaceScope,
    rootRelativePath: evidence.workspaceScope.rootRelativePath ?? undefined, legacy: false, status: 'active', permissions: {
    canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: false } }, fileOptions: {} };
  const input = { scope, actions: [{ reviewId: 'delete-v3-fixture', kind: 'delete' as const,
    selections: [{ sourcePath: 'note.md' }] }], observation };
  return { input, jobScope: captureWorkspaceOperationJobScope(scope.workspace) };
}

function refreshDeleteV3Fixture(observation: WorkspaceLinkSourceAuthorityObservation & { privateCatalogue: WorkspaceDocumentCatalogueEntry[] }): void {
  observation.stage.catalogueProof = proof(observation.privateCatalogue);
  observation.stage.sources = observation.stage.sources.map(source => source.kind === 'native' ? source : ({ kind: 'physical',
    inventory: inspectOriginalPhysicalLinks({ workspaceId: source.inventory.workspaceId, organizationId: source.inventory.organizationId,
      path: source.inventory.path, bytes: source.inventory.originalBytes, filesystemIdentity: source.inventory.physical.filesystemIdentity,
      authority: { ...source.inventory.authority, catalogueProof: observation.stage.catalogueProof! } }) }));
  observation.stage.readiness = observation.stage.sources.some(source => source.kind === 'physical') ? 'requires-import-and-rebinding' : 'native-coordinator-required';
  observation.stage.stageProof = workspaceSourceAuthorityStageProof(observation.stage);
}

export function workspaceOperationNativeDeletePlanV3Test(): void {
  let passed = 0;
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    const fixture = deleteV3Fixture(representation), before = structuredClone(fixture);
    const plan = createWorkspaceOperationNativeDeleteBatchPlanV3(fixture.input);
    assert.equal(plan.version, 2); assert.equal(plan.planIdentityVersion, 3);
    assert.equal(plan.sourceEvidence.evidenceVersion, 3); assert.equal(plan.nativeGraphPlan.contractVersion, 3);
    assert(plan.sourceEvidence.namespace.some(entry => entry.path === 'raw.md'));
    assert(!plan.sourceEvidence.nativeComponent.stage.namespace.some(entry => entry.path === 'raw.md'));
    const raw = plan.nativeGraphPlan.finalNamespace.find(entry => entry.path === 'raw.md')!;
    assert(raw.physicalReadSource); assert.equal(raw.binding.kind, 'existing');
    if (raw.binding.kind === 'existing') {
      assert.equal(raw.binding.namespaceEvidence.documentId, null); assert.equal(raw.binding.documentEvidenceKey, null);
    }
    assert.deepEqual(decodeWorkspaceOperationNativeDeleteBatchPlan(JSON.parse(JSON.stringify(plan))), plan);
    assert.equal(computeWorkspaceOperationNativeDeleteBatchPlanId(plan), plan.planId);
    assert.equal(computeWorkspaceOperationNativeDeleteBatchPlanIntegrityProof(plan), plan.integrityProof);
    assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan, fixture.input.observation, fixture.jobScope);
    const witness = captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness(plan, fixture.input.observation, fixture.jobScope);
    assert.deepEqual(witness, plan.sourceEvidence); assert(Object.isFrozen(witness));
    assert(getWorkspaceOperationNativeDeleteLinkRecipes(plan).every(recipe => recipe.source.path !== 'raw.md'));
    assert.deepEqual(fixture, before);
  }
  passed++;

  // Raw surviving links, including a native unlink in the same batch, stay in
  // the full compiled graph. A real raw incoming unlink remains import-only.
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    const fixture = deleteV3Fixture(representation, '[Self](raw.md)\n');
    fixture.input.actions[0].selections[0].sourcePath = 'keep.md';
    const plan = createWorkspaceOperationNativeDeleteBatchPlanV3(fixture.input);
    assert.equal(getWorkspaceOperationNativeDeleteLinkRecipes(plan).length, 1);
    assert.equal(plan.nativeGraphPlan.finalEdges.filter(edge => edge.physicalReadSource).length, 1);
    assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan, fixture.input.observation, fixture.jobScope);
  }
  passed++;

  // Actual fresh catalogue/projection clocks can advance without changing the
  // semantic ID. Derived raw IDs are replayed from the original full snapshot.
  {
    const fixture = deleteV3Fixture('plain_text', '[Self](raw.md)\n'), first = createWorkspaceOperationNativeDeleteBatchPlanV3(fixture.input);
    const next = structuredClone(fixture);
    for (const binding of next.input.observation.nativeBindings) {
      binding.expected.registryStateVersion++; binding.registry.stateVersion++;
      next.input.observation.privateCatalogue.find(row => row.id === binding.expected.documentId)!.state_version = binding.expected.registryStateVersion;
      next.input.observation.stage.namespace.find(entry => entry.documentId === binding.expected.documentId)!.filesystemIdentity = '8:80:123:300:301';
    }
    refreshDeleteV3Fixture(next.input.observation);
    const second = createWorkspaceOperationNativeDeleteBatchPlanV3(next.input);
    assert.equal(first.planId, second.planId); assert.notEqual(first.integrityProof, second.integrityProof);
    assert.notEqual(first.sourceEvidence.physicalSources[0].physicalSourceProof, second.sourceEvidence.physicalSources[0].physicalSourceProof);
    assert.deepEqual(captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness(first, next.input.observation, next.jobScope), second.sourceEvidence);
    assertWorkspaceOperationNativeDeleteBatchPlanCurrent(first, next.input.observation, next.jobScope);
  }
  passed++;

  for (const rawText of ['Raw', '[Incoming](note.md)', '---\naliases: [Keep]\n---\n[[Keep]]']) {
    const fixture = deleteV3Fixture('plain_text', rawText);
    if (rawText === 'Raw') fixture.input.actions[0].selections[0].sourcePath = 'raw.md';
    else if (rawText.includes('aliases')) fixture.input.actions[0].selections[0].sourcePath = 'keep.md';
    assert.throws(() => createWorkspaceOperationNativeDeleteBatchPlanV3(fixture.input), error =>
      error instanceof WorkspaceOperationNativeDeletePlanError && error.code === 'NATIVE_DELETE_PLAN_UNSUPPORTED');
  }
  passed++;

  // Changed raw bytes/identity, missing full catalogue or workspace scope cannot
  // turn a decoded historical DTO into a current execution witness.
  for (const change of ['inode', 'content', 'missing-catalogue', 'scope'] as const) {
    const fixture = deleteV3Fixture(), plan = createWorkspaceOperationNativeDeleteBatchPlanV3(fixture.input);
    const next = structuredClone(fixture);
    if (change === 'missing-catalogue') Reflect.deleteProperty(next.input.observation, 'privateCatalogue');
    else if (change === 'scope') Reflect.set(next.jobScope, 'rootPath', '/different');
    else {
      const source = next.input.observation.stage.sources.find(item => item.kind === 'physical')!; assert(source.kind === 'physical');
      if (change === 'content') source.inventory.originalBytes[0] ^= 1;
      else {
        source.inventory.physical.filesystemIdentity = source.inventory.physical.filesystemIdentity.replace('1:41:', '1:99:');
        const entry = next.input.observation.stage.namespace.find(item => item.path === 'raw.md')!;
        entry.identity = entry.filesystemIdentity = source.inventory.physical.filesystemIdentity;
      }
      refreshDeleteV3Fixture(next.input.observation);
    }
    assert.throws(() => captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness(plan, next.input.observation, next.jobScope));
    assert.throws(() => assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan, next.input.observation, next.jobScope));
  }
  passed++;

  // Strict full-graph historical validation and current replay are different:
  // removing physical facts is invalid immediately; opaque byte hashes require
  // actual native bytes and are rejected by complete current compiler equality.
  for (const change of ['drop-raw', 'opaque-before-proof', 'opaque-content-proof', 'contract-mix'] as const) {
    const fixture = deleteV3Fixture(), plan = createWorkspaceOperationNativeDeleteBatchPlanV3(fixture.input);
    const forged = structuredClone(plan) as Mutable<typeof plan>;
    if (change === 'drop-raw') forged.nativeGraphPlan.finalNamespace = forged.nativeGraphPlan.finalNamespace.filter(entry => entry.path !== 'raw.md');
    if (change === 'opaque-before-proof') forged.nativeGraphPlan.steps[0].beforeGraphProof = 'f'.repeat(64);
    if (change === 'opaque-content-proof') forged.nativeGraphPlan.finalNamespace.find(entry => entry.path === 'keep.md')!.contentBasisProof = 'f'.repeat(64);
    if (change === 'contract-mix') Reflect.set(forged.nativeGraphPlan, 'contractVersion', 2);
    if (change === 'opaque-content-proof') {
      forged.nativeGraphPlan.finalGraphProof = proof({ namespace: forged.nativeGraphPlan.finalNamespace, edges: forged.nativeGraphPlan.finalEdges });
      forged.nativeGraphPlan.steps[0].afterGraphProof = forged.nativeGraphPlan.finalGraphProof;
    }
    const { planId: _graphId, ...graphBody } = forged.nativeGraphPlan; forged.nativeGraphPlan.planId = proof(graphBody);
    forged.integrityProof = computeWorkspaceOperationNativeDeleteBatchPlanIntegrityProof(forged);
    if (change.startsWith('opaque-')) {
      const decoded = decodeWorkspaceOperationNativeDeleteBatchPlan(forged);
      assert.throws(() => assertWorkspaceOperationNativeDeleteBatchPlanCurrent(decoded, fixture.input.observation, fixture.jobScope), error =>
        error instanceof WorkspaceOperationNativeDeletePlanError && error.code === 'NATIVE_DELETE_PLAN_CHANGED');
    } else assert.throws(() => decodeWorkspaceOperationNativeDeleteBatchPlan(forged), WorkspaceOperationNativeDeletePlanError);
  }
  passed++;

  // No hostile getter or proxy trap may execute at the new factory/decoder.
  {
    const fixture = deleteV3Fixture(), plan = createWorkspaceOperationNativeDeleteBatchPlanV3(fixture.input);
    let callbacks = 0;
    const input = { ...fixture.input };
    Object.defineProperty(input, 'observation', { enumerable: true, get() { callbacks++; return fixture.input.observation; } });
    assert.throws(() => createWorkspaceOperationNativeDeleteBatchPlanV3(input));
    const hostile = { ...plan };
    Object.defineProperty(hostile, 'sourceEvidence', { enumerable: true, get() { callbacks++; return plan.sourceEvidence; } });
    assert.throws(() => decodeWorkspaceOperationNativeDeleteBatchPlan(hostile));
    const proxy = new Proxy(plan, { getOwnPropertyDescriptor() { callbacks++; throw new Error('trap'); },
      ownKeys() { callbacks++; throw new Error('trap'); }, getPrototypeOf() { callbacks++; throw new Error('trap'); } });
    assert.throws(() => decodeWorkspaceOperationNativeDeleteBatchPlan(proxy));
    assert.equal(callbacks, 0);
  }
  passed++;

  // Existing auto/Legacy/V2 selection, shapes and hash formulas stay exact.
  {
    const fixture = deleteV3Fixture(), nativeInput = structuredClone(fixture.input);
    nativeInput.observation.stage.sources = nativeInput.observation.stage.sources.filter(source => source.kind === 'native');
    nativeInput.observation.stage.namespace = nativeInput.observation.stage.namespace.filter(entry => entry.path !== 'raw.md');
    refreshDeleteV3Fixture(nativeInput.observation);
    const old = createWorkspaceOperationNativeDeleteBatchPlanLegacy(nativeInput), v2 = createWorkspaceOperationNativeDeleteBatchPlanV2(nativeInput);
    assert.deepEqual(createWorkspaceOperationNativeDeleteBatchPlan(nativeInput), v2);
    const { planId: _oldId, ...oldBody } = old; assert.equal(old.planId, proof(oldBody));
    const { integrityProof: _proof, ...v2Body } = v2; assert.equal(v2.integrityProof, proof({ integrityVersion: 2, plan: v2Body }));
    assert.equal(v2.planId, proof({ version: v2.version, kind: v2.kind, planIdentityVersion: 2,
      workspaceId: v2.workspaceId, readiness: v2.readiness, actions: v2.actions, sourceSemanticProof: v2.sourceEvidence.semanticProof }));
    const before = [JSON.stringify(old), JSON.stringify(v2)]; createWorkspaceOperationNativeDeleteBatchPlanV3(fixture.input);
    assert.deepEqual([JSON.stringify(createWorkspaceOperationNativeDeleteBatchPlanLegacy(nativeInput)), JSON.stringify(createWorkspaceOperationNativeDeleteBatchPlanV2(nativeInput))], before);
    assert.throws(() => createWorkspaceOperationNativeDeleteBatchPlan(fixture.input), WorkspaceOperationNativeSourceEvidenceError);
  }
  passed++;
  // Public hash/Current parity: every wire arm keeps its exact bytes and
  // detached decode result; invalid plans fail before touching an observation.
  {
    const fixture = deleteV3Fixture(), nativeInput = structuredClone(fixture.input);
    nativeInput.observation.stage.sources = nativeInput.observation.stage.sources.filter(source => source.kind === 'native');
    nativeInput.observation.stage.namespace = nativeInput.observation.stage.namespace.filter(entry => entry.path !== 'raw.md');
    refreshDeleteV3Fixture(nativeInput.observation);
    const cases = [
      { plan: createWorkspaceOperationNativeDeleteBatchPlanLegacy(nativeInput), observation: nativeInput.observation },
      { plan: createWorkspaceOperationNativeDeleteBatchPlanV2(nativeInput), observation: nativeInput.observation },
      { plan: createWorkspaceOperationNativeDeleteBatchPlanV3(fixture.input), observation: fixture.input.observation },
    ];
    for (const { plan, observation } of cases) {
      const before = JSON.stringify(plan), beforeObservation = structuredClone(observation);
      const wire = JSON.parse(before) as typeof plan, decoded = decodeWorkspaceOperationNativeDeleteBatchPlan(wire);
      assert.equal(JSON.stringify(decoded), before); assert.notEqual(decoded, wire);
      assert.notEqual(decoded.sourceEvidence, wire.sourceEvidence);
      assert.equal(computeWorkspaceOperationNativeDeleteBatchPlanId(wire), plan.planId);
      assert.equal(computeWorkspaceOperationNativeDeleteBatchPlanId(decoded), plan.planId);
      if (plan.planIdentityVersion === 2 || plan.planIdentityVersion === 3) {
        assert.equal(computeWorkspaceOperationNativeDeleteBatchPlanIntegrityProof(plan), plan.integrityProof);
        assert.deepEqual(captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness(plan, observation, fixture.jobScope), plan.sourceEvidence);
      }
      assertWorkspaceOperationNativeDeleteBatchPlanCurrent(decoded, observation, fixture.jobScope);
      assert(Reflect.set(wire.nativeTarget, 'path', 'changed-after-decode.md'));
      assert.equal(JSON.stringify(decoded), before); assert.equal(JSON.stringify(plan), before);
      let callbacks = 0;
      const accessor = { ...plan };
      Object.defineProperty(accessor, 'sourceEvidence', { enumerable: true, get() { callbacks++; return plan.sourceEvidence; } });
      const proxy = new Proxy(plan, { get() { callbacks++; throw new Error('unexpected read'); },
        getOwnPropertyDescriptor() { callbacks++; throw new Error('unexpected descriptor'); },
        ownKeys() { callbacks++; throw new Error('unexpected keys'); },
        getPrototypeOf() { callbacks++; throw new Error('unexpected prototype'); } });
      for (const hostile of [accessor, proxy]) {
        assert.throws(() => computeWorkspaceOperationNativeDeleteBatchPlanId(hostile), error =>
          error instanceof WorkspaceOperationNativeDeletePlanError && error.code === 'NATIVE_DELETE_PLAN_INVALID');
        assert.throws(() => computeWorkspaceOperationNativeDeleteBatchPlanIntegrityProof(hostile as never), error =>
          error instanceof WorkspaceOperationNativeDeletePlanError && error.code === 'NATIVE_DELETE_PLAN_INVALID');
      }
      const hostileObservation = new Proxy(observation, { get() { callbacks++; throw new Error('unexpected observation'); },
        getOwnPropertyDescriptor() { callbacks++; throw new Error('unexpected observation descriptor'); },
        ownKeys() { callbacks++; throw new Error('unexpected observation keys'); },
        getPrototypeOf() { callbacks++; throw new Error('unexpected observation prototype'); } });
      const invalid = { ...structuredClone(plan), planId: '0'.repeat(64) };
      assert.throws(() => assertWorkspaceOperationNativeDeleteBatchPlanCurrent(invalid, hostileObservation, fixture.jobScope), error =>
        error instanceof WorkspaceOperationNativeDeletePlanError && error.code === 'NATIVE_DELETE_PLAN_INVALID');
      assert.throws(() => captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness(invalid as never, hostileObservation, fixture.jobScope), error =>
        error instanceof WorkspaceOperationNativeDeletePlanError && error.code === 'NATIVE_DELETE_PLAN_INVALID');
      assert.equal(callbacks, 0); assert.deepEqual(observation, beforeObservation);
    }
  }
  passed++;
  assert.equal(passed, 9);
  console.log(JSON.stringify({ suite: 'native-delete-plan-v3', passed, pureFactsOnly: true }));
}

workspaceOperationNativeDeletePlanV3Test();
