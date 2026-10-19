import assert from 'node:assert/strict';
import { Y } from '../app/lib/collaboration/server-runtime';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { inspectOriginalPhysicalLinks, workspaceSourceAuthorityStageProof,
  type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import type { WorkspaceMixedReadLinkSnapshotV3, PhysicalReadLinkInventory } from '../app/lib/markdown/workspace-link-contract-v3';
import { compileWorkspaceMixedImportCopyBatchV4, compileWorkspaceMixedReadBatchV3,
  compileWorkspaceNativeMixedBatch } from '../app/lib/markdown/workspace-native-mixed-batch-compiler';
import { createWorkspaceOperationManagedCopyPlanV5, decodeWorkspaceOperationManagedCopyPlanV5,
  assertWorkspaceOperationManagedCopyPlanV5Current, WorkspaceOperationManagedCopyPlanV5Error } from '../app/lib/files/workspace-operation-managed-copy-plan-v5';
import { createWorkspaceOperationManagedCopyPlanV4 } from '../app/lib/files/workspace-operation-managed-copy-plan-v4';

/** Pure facts only, not SQL/FD/auth evidence. Exported for the separate Stage6
 * codec's pure test, without executing any test at import time. */
export function rawCopyPlanningFixture() {
  const workspaces: WorkspaceContext[] = ['raw-source', 'raw-destination'].map(workspaceId => ({ workspaceId,
    workspaceType: 'personal', ownerUserId: 'raw-owner', rootPath: `/data/users/${workspaceId}/files`,
    rootRelativePath: `users/${workspaceId}/files`, organizationId: null, customerId: null, projectId: null, legacy: false,
    permissions: { canRead: true, canWrite: workspaceId === 'raw-destination', canDelete: false,
      canRunAgent: false, canCreatePublicLinks: false, canManageWorkspace: false } }));
  const files = [
    ['a.md', '\uFEFF---\r\naliases: [Alpha Alias]\r\n---\r\n# Alpha\r\n\r\n[Self](a.md) and [[Beta Alias|B]]\r\n'],
    ['b.md', '---\naliases: [Beta Alias]\n---\n# Beta\n\n[Self](b.md) and [[Alpha Alias]]\n'],
    ['unselected.md', '# Untouched\n\n[[Alpha Alias]]\n'],
  ].map(([path, text], index) => inspectOriginalPhysicalLinks({ workspaceId: workspaces[0].workspaceId,
    organizationId: null, path, bytes: Buffer.from(text), authority: { kind: 'unregistered', catalogueProof: proof([]) },
    filesystemIdentity: `1:${100 + index}:${Buffer.byteLength(text)}:100:100` }));
  const observations = workspaces.map((workspace, index) => {
    const sources: WorkspaceSourceAuthorityStage['sources'] = index === 0 ? files.map(inventory => ({ kind: 'physical', inventory })) : [];
    const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId: workspace.workspaceId,
      organizationId: null, catalogueProof: proof([]), namespace: sources.map(source => {
        assert.equal(source.kind, 'physical'); const inventory = source.inventory as typeof files[number];
        return { workspaceId: workspace.workspaceId, path: inventory.path, kind: 'file', documentId: null, lifecycleGeneration: null,
          identity: inventory.physical.filesystemIdentity, filesystemIdentity: inventory.physical.filesystemIdentity };
      }), sources, scope: { kind: 'visible-workspace', excludedPaths: [] }, coverage: { complete: true, gaps: [] },
      readiness: sources.length ? 'requires-import-and-rebinding' : 'native-coordinator-required', executionReady: false };
    return { stage: { ...body, stageProof: workspaceSourceAuthorityStageProof(body) }, nativeBindings: [], privateNativeStates: [],
      privateCatalogue: [], sceneBindings: [], privateSceneSnapshots: [], privateSceneCatalogue: [] };
  });
  const input = { sourceScope: { workspace: workspaces[0], fileOptions: {} }, destinationScope: { workspace: workspaces[1], fileOptions: {} },
    selections: [{ sourcePath: 'a.md', destinationPath: 'alpha.md' }, { sourcePath: 'b.md', destinationPath: 'beta.md' }],
    sourceObservation: observations[0], destinationObservation: observations[1] };
  return { input, workspaces, files, observations, plan: createWorkspaceOperationManagedCopyPlanV5(input) };
}
function rawCopyPlanningSnapshot(workspaceId: string, states: PersistedCollaborationState[], physicalSources: PhysicalReadLinkInventory[]): WorkspaceMixedReadLinkSnapshotV3 {
  const documents = states.map(inspectPersistedDocumentLinks);
  const namespace = [...documents.map(({ document }) => ({ workspaceId, path: document.path, kind: 'file' as const,
    identity: `registry:${document.documentId}:1`, documentId: document.documentId, lifecycleGeneration: 1, filesystemIdentity: null })),
  ...physicalSources.map(item => ({ workspaceId, path: item.path, kind: 'file' as const, identity: item.physical.filesystemIdentity,
    documentId: null, lifecycleGeneration: null, filesystemIdentity: item.physical.filesystemIdentity }))];
  const body = { contractVersion: 3 as const, workspaceId, namespace, documents, physicalSources, coverage: { complete: true, gaps: [] } };
  return { ...body, snapshotProof: proof(body) };
}

export function workspaceOperationRawCopyPlanningTest(): void {
  let groups = 0;
  const fixture = rawCopyPlanningFixture(), { plan, input } = fixture;
  const before = structuredClone({ input, files: fixture.files });
  assert.equal(plan.version, 5); assert.equal(plan.readiness, 'requires-provider-publication'); assert.equal(plan.executionReady, false);
  assert.equal(plan.sourceEvidence.evidenceVersion, 4); assert.equal(plan.rawImportRequirements.length, 2);
  assert.equal(plan.cloneRequirements.length, 0); assert.equal(plan.compilation.contractVersion, 4);
  assert.equal(plan.rawImportRequirements[0].preparation.hasBom, true);
  assert.equal(plan.rawImportRequirements[0].preparation.newlineStyle, 'crlf');
  assert.deepEqual({ input, files: fixture.files }, before); groups++;

  const imports = plan.compilation.finalNamespace.filter(entity => entity.binding.kind === 'unbound-import');
  assert.equal(imports.length, 2); assert(imports.every(entity => !Object.hasOwn(entity, 'documentId') && entity.contentBasisProof === null));
  const intents = plan.compilation.steps[0].physicalLinkIntents;
  assert.equal(intents.length, 4); assert.equal(plan.compilation.steps[0].linkIntents.length, 0);
  assert(intents.every(intent => !Object.hasOwn(intent, 'reference') && !Object.hasOwn(intent, 'sourceVersion') && !Object.hasOwn(intent, 'nextValue')));
  for (const requirement of plan.rawImportRequirements) {
    assert.equal(requirement.linkBindings.length, 2);
    const links = plan.compilation.finalEdges.filter(edge => edge.sourceEntityKey === requirement.entityKey);
    assert.equal(links.length, 2); assert(links.every(edge => edge.resolution.status === 'resolved'
      && imports.some(entity => entity.entityKey === edge.resolution.targetEntityKey)));
  }
  assert(plan.compilation.finalNamespace.some(entity => entity.path === 'unselected.md' && entity.binding.kind === 'existing')); groups++;

  // Actual pure native Yjs state mixed with physical imports. This is not a
  // principal/registry fixture and makes no authorization or durability claim.
  const doc = createPlainTextYDoc('[Raw](a.md)');
  const state: PersistedCollaborationState = { documentId: 'native-source', workspaceId: 'raw-source', organizationId: null,
    path: 'native.md', lifecycleGeneration: 1, representation: 'plain_text', schemaVersion: 1,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: 0, persistedAt: 1,
    checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null, newlineStyle: 'lf', hasBom: false,
    degraded: false, status: 'active' }; doc.destroy();
  const raw = fixture.files.map(({ originalBytes: _private, ...facts }) => facts);
  const source = rawCopyPlanningSnapshot('raw-source', [state], raw), destination = rawCopyPlanningSnapshot('raw-destination', [], []);
  const requests = [{ kind: 'copy' as const, sourceWorkspaceId: 'raw-source', destinationWorkspaceId: 'raw-destination',
    selections: [...input.selections, { sourcePath: 'native.md', destinationPath: 'native-copy.md' }] }];
  const mixed = compileWorkspaceMixedImportCopyBatchV4({ snapshots: [source, destination], states: [state], requests });
  assert.equal(mixed.readiness, 'requires-import-rebinding', JSON.stringify(mixed.issues));
  assert.equal(mixed.cloneRequirements.length, 1); assert.equal(mixed.rawImportRequirements.length, 2);
  assert.equal(mixed.steps[0].linkIntents.length, 1); assert.equal(mixed.steps[0].physicalLinkIntents.length, 4); groups++;

  const sameWorkspace = compileWorkspaceMixedImportCopyBatchV4({ snapshots: [source], states: [state],
    requests: [{ ...requests[0], destinationWorkspaceId: 'raw-source' }] });
  assert.equal(sameWorkspace.readiness, 'blocked');
  assert(sameWorkspace.issues.some(issue => issue.code === 'physical-source-import-required' || issue.code === 'resolution-changed'));
  const incomplete = compileWorkspaceMixedImportCopyBatchV4({ snapshots: [source, destination], states: [state],
    requests: [{ ...requests[0], selections: [{ sourcePath: 'a.md', destinationPath: 'only-a.md' }] }] });
  assert.equal(incomplete.readiness, 'blocked'); assert(incomplete.issues.some(issue => issue.code === 'uncopied-cross-workspace-target')); groups++;

  const legacy = compileWorkspaceMixedReadBatchV3({ snapshots: [source, destination], states: [state], requests });
  assert.equal(legacy.contractVersion, 3); assert.equal(legacy.readiness, 'blocked');
  assert(legacy.issues.some(issue => issue.code === 'physical-source-import-required'));
  assert.equal(Object.hasOwn(legacy, 'rawImportRequirements'), false);
  const { physicalSources: _raw, snapshotProof: _oldProof, ...nativeBody } = rawCopyPlanningSnapshot('native-only', [], []);
  assert.equal(nativeBody.coverage.complete, true); assert.deepEqual(nativeBody.coverage.gaps, []);
  const nativeSnapshot = { ...nativeBody, contractVersion: 2 as const, coverage: { complete: true, gaps: [] } };
  const old = compileWorkspaceNativeMixedBatch({ snapshots: [{ ...nativeSnapshot, snapshotProof: proof(nativeSnapshot) }], states: [],
    requests: [{ kind: 'copy', sourceWorkspaceId: 'native-only', destinationWorkspaceId: 'native-only', selections: [{ sourcePath: 'missing.md', destinationPath: 'other.md' }] }] });
  assert.equal(old.contractVersion, 2); assert.equal(Object.hasOwn(old, 'rawImportRequirements'), false);
  assert.throws(() => createWorkspaceOperationManagedCopyPlanV4(input)); groups++;

  assert.deepEqual(decodeWorkspaceOperationManagedCopyPlanV5(plan), plan); assert(Object.isFrozen(plan.rawImportRequirements[0].preparation));
  for (const change of [
    (value: Record<string, unknown>) => { value.version = 4; },
    (value: Record<string, unknown>) => { value.extra = true; },
    (value: Record<string, unknown>) => { (value.rawImportRequirements as Array<Record<string, unknown>>)[0].sourcePath = 'unselected.md'; },
  ]) { const damaged = structuredClone(plan) as unknown as Record<string, unknown>; change(damaged);
    assert.throws(() => decodeWorkspaceOperationManagedCopyPlanV5(damaged), WorkspaceOperationManagedCopyPlanV5Error); }
  let traps = 0;
  const hostile = structuredClone(plan); Object.defineProperty(hostile, 'compilation', { enumerable: true, get() { traps++; return plan.compilation; } });
  assert.throws(() => decodeWorkspaceOperationManagedCopyPlanV5(hostile), WorkspaceOperationManagedCopyPlanV5Error);
  const proxy = new Proxy(plan, { ownKeys() { traps++; return []; }, get() { traps++; return undefined; } });
  assert.throws(() => decodeWorkspaceOperationManagedCopyPlanV5(proxy), WorkspaceOperationManagedCopyPlanV5Error); assert.equal(traps, 0); groups++;

  assert.equal(assertWorkspaceOperationManagedCopyPlanV5Current(plan, input).planId, plan.compilerPlanProof);
  const changed = structuredClone(input), oldInventory = changed.sourceObservation.stage.sources[2].inventory as typeof fixture.files[number];
  const changedBytes = Buffer.from('# Changed unrelated raw\n');
  const changedInventory = inspectOriginalPhysicalLinks({ workspaceId: 'raw-source', organizationId: null, path: 'unselected.md',
    bytes: changedBytes, authority: oldInventory.authority, filesystemIdentity: `1:102:${changedBytes.length}:101:101` });
  changed.sourceObservation.stage.sources[2] = { kind: 'physical', inventory: changedInventory };
  const entry = changed.sourceObservation.stage.namespace[2]; entry.identity = changedInventory.physical.filesystemIdentity; entry.filesystemIdentity = entry.identity;
  changed.sourceObservation.stage.stageProof = workspaceSourceAuthorityStageProof(changed.sourceObservation.stage);
  assert.throws(() => assertWorkspaceOperationManagedCopyPlanV5Current(plan, changed), error => error instanceof WorkspaceOperationManagedCopyPlanV5Error
    && error.code === 'MANAGED_COPY_PLAN_CHANGED'); groups++;

  const tooLarge = { ...plan, extra: 'x'.repeat(16 * 1024 * 1024) };
  assert.throws(() => decodeWorkspaceOperationManagedCopyPlanV5(tooLarge), error => error instanceof WorkspaceOperationManagedCopyPlanV5Error
    && error.code === 'MANAGED_COPY_PLAN_TOO_LARGE');
  const wrongOperation = compileWorkspaceMixedImportCopyBatchV4({ snapshots: [source], states: [state],
    requests: [{ kind: 'delete', sourceWorkspaceId: 'raw-source', destinationWorkspaceId: 'raw-source', selections: [{ sourcePath: 'a.md' }] }] });
  assert.equal(wrongOperation.readiness, 'blocked'); assert(wrongOperation.issues.some(issue => issue.code === 'import-copy-only')); groups++;
  assert.equal(groups, 8);
  console.log(JSON.stringify({ suite: 'workspace-operation-raw-copy-planning', groups, pureOnly: true, executionAdmission: false }));
}
