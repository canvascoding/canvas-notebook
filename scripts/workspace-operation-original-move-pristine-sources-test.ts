import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { PreparedPathMoveIdentity, PreparedWorkspacePathMoveOriginal, PreparedWorkspacePathMoveReceipt }
  from '../app/lib/filesystem/prepared-workspace-path-move-contract';
import { createWorkspaceOperationNativeMoveBatchPlanV2, createWorkspaceOperationNativeMoveBatchPlanV3,
  createWorkspaceOperationNativeMoveBatchPlanV4, assertWorkspaceOperationNativeMoveBatchPlanCurrent }
  from '../app/lib/files/workspace-operation-native-move-plan';
import { workspaceOperationSourceNativeEvidence } from '../app/lib/files/workspace-operation-mixed-source-evidence';
import { createWorkspaceOperationOriginalMoveIntent, serializeWorkspaceOperationOriginalMoveData,
  workspaceOperationOriginalMoveNamespaceEffects, type WorkspaceOperationOriginalMoveContext }
  from '../app/lib/files/workspace-operation-original-move';
import { decodeWorkspaceOperationOriginalMoveNamespaceStage, decodeWorkspaceOperationOriginalMoveNamespaceReceipt,
  getWorkspaceOperationOriginalMovePristineRegistryFacts, type WorkspaceOperationOriginalMoveNamespaceStageV2,
  type WorkspaceOperationOriginalMovePristineRegistryRow }
  from '../app/lib/files/workspace-operation-original-move-namespace-effects';
import { assertOriginalMoveFinalSourceGraph, deriveOriginalMoveSourceNamespaceFacts }
  from '../app/lib/files/workspace-operation-original-move-sources';
import { nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof } from '../app/lib/markdown/workspace-physical-link-inventory';
import { workspacePathImportPreparationFixture } from './workspace-path-import-preparation-plan-test';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const json = serializeWorkspaceOperationOriginalMoveData;
type FinalInput = Parameters<typeof assertOriginalMoveFinalSourceGraph>[0];
function physicalIdentity(kind: 'file' | 'directory', fingerprint: string): PreparedPathMoveIdentity {
  const [device, inode, size] = fingerprint.split(':');
  return { device, inode, size, mode: kind === 'file' ? 0o100644 : 0o040755, uid: 1000, gid: 1000,
    linkCount: kind === 'file' ? '1' : '2', birthtimeNs: '10', mtimeNs: '100000000', ctimeNs: '100000000' };
}

/** Actual planner, Yjs, evidence, immutable intent and namespace codecs with
 * DECLARED catalogue/FS/receipt facts. No SQL/FD/lease or owner authority is
 * supplied, and this module never runs tests on import. */
export function workspaceOperationOriginalMovePristineSourcesFixture(identityVersion: 2 | 3 | 4 = 2) {
  const sourcePath = 'z-folder/plain.txt', destinationPath = 'a-folder/plain.txt';
  const base = workspacePathImportPreparationFixture({ native: [['outside.md', '# Unchanged native note\n']], raw: [],
    extra: [{ path: sourcePath, kind: 'file' }] });
  const bytes = Buffer.from('\uFEFFUploaded original TXT\r\n');
  const leaf = base.observation.stage.namespace.find(item => item.path === sourcePath)!;
  const fingerprint = `1:401:${bytes.length}:100:100`;
  leaf.identity = fingerprint; leaf.filesystemIdentity = fingerprint;
  const catalogue: WorkspaceDocumentCatalogueEntry = { id: 'pristine-txt-document', lineage_id: 'pristine-txt-lineage',
    path: sourcePath, workspace_id: base.scope.workspaceId, organization_id: null, status: 'active', state_version: 0,
    yjs_state_lifecycle: 'never_initialized', has_persisted_state: false, has_state_history: false,
    lifecycle_generation: null, authority: 'pristine', state_status: null, state_path: null,
    state_workspace_id: null, state_organization_id: null };
  base.observation.privateCatalogue.push(catalogue);
  base.observation.privateCatalogue.sort((a, b) => a.path.localeCompare(b.path));
  base.observation.stage.catalogueProof = proof(base.observation.privateCatalogue);
  base.observation.stage.stageProof = workspaceSourceAuthorityStageProof(base.observation.stage);
  const workspace: WorkspaceContext = { ...base.scope, workspaceType: 'personal', ownerUserId: base.scope.ownerUserId!,
    rootRelativePath: base.scope.rootRelativePath!, status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true,
      canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: false } };
  const request = { scope: { workspace, fileOptions: {} }, observation: base.observation,
    actions: [{ kind: 'move' as const, reviewId: 'direct_move', selections: [{ sourcePath: 'z-folder', destinationPath: 'a-folder' }] }] };
  const plan = identityVersion === 2 ? createWorkspaceOperationNativeMoveBatchPlanV2(request)
    : identityVersion === 3 ? createWorkspaceOperationNativeMoveBatchPlanV3(request) : createWorkspaceOperationNativeMoveBatchPlanV4(request);
  const context: WorkspaceOperationOriginalMoveContext = { batchId: `pristine-source-fixture-${identityVersion}`,
    requestHash: sha('declared-pristine-request'), actor: { userId: base.scope.ownerUserId!, actorId: 'fixture-actor',
      actorType: 'user', actorSessionId: null }, plan };
  const native = workspaceOperationSourceNativeEvidence(plan.sourceEvidence);
  assert(native.evidenceVersion === 2 || native.evidenceVersion === 4);
  const registry: WorkspaceOperationOriginalMovePristineRegistryRow = { id: catalogue.id, organization_id: null, customer_id: null,
    project_id: null, workspace_id: workspace.workspaceId, workspace_type: 'personal', path: sourcePath,
    lineage_id: catalogue.lineage_id!, provider: 'yjs', state_version: 0, yjs_state_lifecycle: 'never_initialized',
    snapshot_revision_id: 'original-upload-revision', status: 'active', created_at: 10, updated_at: 10 };
  const lineage = { id: registry.lineage_id, organization_id: null, customer_id: null, project_id: null,
    workspace_id: workspace.workspaceId, workspace_type: 'personal', path: sourcePath, status: 'active',
    created_at: 10, archived_at: null, trash_entry_id: null };
  const effects = workspaceOperationOriginalMoveNamespaceEffects(context);
  const beforeRows = { metadata: [], userStates: [], guests: [], publicShares: [], locks: [] };
  const stage: WorkspaceOperationOriginalMoveNamespaceStageV2 = { version: 2, batchId: context.batchId, planId: plan.planId,
    workspaceId: workspace.workspaceId, organizationId: null, requestHash: context.requestHash, actor: context.actor,
    schema: 'declared_fixture', effectsProof: proof(effects), beforeRows, lineages: [lineage],
    catalogueBinding: { catalogueProof: native.stage.catalogueProof!, semanticCatalogueProof: native.semanticCatalogueProof,
      evidenceProof: plan.sourceEvidence.evidenceProof }, pristineRegistry: [{ catalogue, registry }] };
  const stageText = json(stage), namespaceState = { stageText, stageDigest: sha(stageText) };
  const folder = base.observation.stage.namespace.find(item => item.path === 'z-folder')!;
  const original: PreparedWorkspacePathMoveOriginal = { version: 1,
    workspace: { workspaceId: workspace.workspaceId, workspaceType: 'personal', organizationId: null, rootPath: workspace.rootPath },
    sourcePath: 'z-folder', destinationPath: 'a-folder', budget: { maxDepth: 32, maxEntries: 10_000, maxHashBytes: 4 * 1024 ** 3 },
    caseOnlyAlias: false, filesystem: { root: { resolvedPath: workspace.rootPath,
      identity: physicalIdentity('directory', '1:1:4096:100:100') }, sourceParents: { directories: [], missingPrefix: null },
      destinationParents: { directories: [], missingPrefix: null } }, source: { kind: 'directory', entries: [
      { relativePath: '', kind: 'directory', identity: physicalIdentity('directory', folder.filesystemIdentity!) },
      { relativePath: 'plain.txt', kind: 'regular_file', identity: physicalIdentity('file', fingerprint), sha256: sha(bytes) },
    ] } };
  const physicalReceipt: PreparedWorkspacePathMoveReceipt = { version: 1, original, createdParents: [],
    observation: { kind: 'moved', method: 'rename-no-replace', source: original.source as Extract<typeof original.source, { kind: 'directory' }> } };
  const intent = createWorkspaceOperationOriginalMoveIntent({ physical: [original], nativeBundle: null, namespaceState,
    currentWitness: plan.sourceEvidence }, context);
  const receiptText = json({ version: 2, batchId: context.batchId, planId: plan.planId, workspaceId: workspace.workspaceId,
    effectsProof: stage.effectsProof, stageDigest: namespaceState.stageDigest, appliedAt: 100,
    afterRowsProof: proof({ rows: beforeRows, lineages: [{ ...lineage, path: destinationPath }],
      pristineRegistry: [{ catalogue: { ...catalogue, path: destinationPath }, registry: { ...registry, path: destinationPath } }] }),
    rowCounts: { metadata: 0, userStates: 0, guests: 0, publicShares: 0, locks: 0, lineages: 1, pristineRegistry: 1 } });
  const namespaceReceipt = { effectsProof: stage.effectsProof, receiptDigest: sha(receiptText), receiptText };
  const final = structuredClone(base.observation);
  for (const entry of final.stage.namespace) if (entry.path === 'z-folder' || entry.path.startsWith('z-folder/'))
    entry.path = entry.path.replace(/^z-folder/u, 'a-folder');
  final.stage.namespace.sort((a, b) => a.path.localeCompare(b.path));
  final.privateCatalogue.find(item => item.id === catalogue.id)!.path = destinationPath;
  final.privateCatalogue.sort((a, b) => a.path.localeCompare(b.path));
  final.stage.catalogueProof = proof(final.privateCatalogue); final.stage.stageProof = workspaceSourceAuthorityStageProof(final.stage);
  const finalInput: FinalInput = { context, intent,
    compiled: assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan, base.observation, base.scope),
    facts: deriveOriginalMoveSourceNamespaceFacts(context, [original], [physicalReceipt], []), observation: final,
    nativeReceipts: [], namespaceReceipt, catalogueOriginalOrder: base.observation.privateCatalogue.map(item => item.id) };
  return { context, intent, stage, namespaceState, namespaceReceipt, finalInput, original, physicalReceipt,
    originalCatalogue: base.observation.privateCatalogue, originalObservation: base.observation, sourcePath, destinationPath };
}

/** Pure full-final-graph and strict-codec regression cases only. Root owns
 * genuine PostgreSQL upload/move/recovery and historical completion tests. */
export function workspaceOperationOriginalMovePristineSourcesTest(): void {
  let groups = 0;
  for (const version of [2, 3, 4] as const) {
    const value = workspaceOperationOriginalMovePristineSourcesFixture(version);
    const before = structuredClone(value.finalInput);
    assertOriginalMoveFinalSourceGraph(value.finalInput);
    assert.deepEqual(value.finalInput, before, 'Comparison must not mutate saved or actual facts.');
    assert.equal(value.finalInput.compiled.contractVersion, version === 4 ? 5 : version);
    assert.equal(value.finalInput.observation.stage.sources.some(item => item.kind !== 'native'), false);
    assert.equal(value.finalInput.observation.nativeBindings.some(item => item.expected.documentId === 'pristine-txt-document'), false);
    const facts = getWorkspaceOperationOriginalMovePristineRegistryFacts({ context: value.context, intent: value.intent,
      namespaceReceipt: value.namespaceReceipt });
    assert.equal(facts.length, 1); assert.equal(facts[0].sourcePath, value.sourcePath); assert.equal(facts[0].destinationPath, value.destinationPath);
    assert.deepEqual(facts[0].catalogueAfter, { ...facts[0].catalogueBefore, path: value.destinationPath });
    assert.deepEqual(facts[0].registryAfter, { ...facts[0].registryBefore, path: value.destinationPath });
    assert.deepEqual(facts[0].lineageAfter, { ...facts[0].lineageBefore, path: value.destinationPath });
  }
  groups++;

  for (const version of [2, 3, 4] as const) {
    const value = workspaceOperationOriginalMovePristineSourcesFixture(version);
    for (const namespaceReceipt of [undefined, null]) assert.throws(() => assertOriginalMoveFinalSourceGraph({ ...value.finalInput, namespaceReceipt }),
      { code: 'ORIGINAL_MOVE_FINAL_GRAPH_CHANGED' });
    const foreign = workspaceOperationOriginalMovePristineSourcesFixture(version === 2 ? 3 : 2);
    assert.throws(() => assertOriginalMoveFinalSourceGraph({ ...value.finalInput, namespaceReceipt: foreign.namespaceReceipt }),
      { code: 'ORIGINAL_MOVE_FINAL_GRAPH_CHANGED' });
  }
  groups++;

  {
    const value = workspaceOperationOriginalMovePristineSourcesFixture();
    for (const field of ['receiptDigest', 'effectsProof'] as const) assert.throws(() => assertOriginalMoveFinalSourceGraph({ ...value.finalInput,
      namespaceReceipt: { ...value.namespaceReceipt, [field]: '0'.repeat(64) } }), { code: 'ORIGINAL_MOVE_FINAL_GRAPH_CHANGED' });
    const row = JSON.parse(value.namespaceReceipt.receiptText); row.stageDigest = '0'.repeat(64);
    const receiptText = json(row);
    assert.throws(() => assertOriginalMoveFinalSourceGraph({ ...value.finalInput,
      namespaceReceipt: { ...value.namespaceReceipt, receiptText, receiptDigest: sha(receiptText) } }), { code: 'ORIGINAL_MOVE_FINAL_GRAPH_CHANGED' });
    const oldArm = { ...JSON.parse(value.namespaceReceipt.receiptText), version: 1 }, oldArmText = json(oldArm);
    assert.throws(() => assertOriginalMoveFinalSourceGraph({ ...value.finalInput,
      namespaceReceipt: { ...value.namespaceReceipt, receiptText: oldArmText, receiptDigest: sha(oldArmText) } }),
    { code: 'ORIGINAL_MOVE_FINAL_GRAPH_CHANGED' });
  }
  {
    const value = workspaceOperationOriginalMovePristineSourcesFixture();
    const catalogue = value.finalInput.observation.privateCatalogue as WorkspaceDocumentCatalogueEntry[];
    catalogue.splice(catalogue.findIndex(item => item.id === 'pristine-txt-document'), 1);
    value.finalInput.observation.stage.catalogueProof = proof(value.finalInput.observation.privateCatalogue);
    value.finalInput.observation.stage.stageProof = workspaceSourceAuthorityStageProof(value.finalInput.observation.stage);
    assert.throws(() => assertOriginalMoveFinalSourceGraph(value.finalInput), { code: 'ORIGINAL_MOVE_FINAL_GRAPH_CHANGED' });
  }
  groups++;

  for (const field of ['lineage_id', 'state_version', 'path'] as const) {
    const value = workspaceOperationOriginalMovePristineSourcesFixture();
    const catalogue = value.finalInput.observation.privateCatalogue as WorkspaceDocumentCatalogueEntry[];
    const row = catalogue.find(item => item.id === 'pristine-txt-document')!;
    if (field === 'state_version') row[field] = 1;
    else row[field] = field === 'path' ? value.sourcePath : 'foreign-lineage';
    value.finalInput.observation.stage.catalogueProof = proof(catalogue);
    value.finalInput.observation.stage.stageProof = workspaceSourceAuthorityStageProof(value.finalInput.observation.stage);
    assert.throws(() => assertOriginalMoveFinalSourceGraph(value.finalInput));
  }
  groups++;

  {
    const value = workspaceOperationOriginalMovePristineSourcesFixture();
    const catalogue = value.finalInput.observation.privateCatalogue as WorkspaceDocumentCatalogueEntry[];
    catalogue.find(item => item.id !== 'pristine-txt-document')!.has_state_history = true;
    value.finalInput.observation.stage.catalogueProof = proof(catalogue);
    value.finalInput.observation.stage.stageProof = workspaceSourceAuthorityStageProof(value.finalInput.observation.stage);
    assert.throws(() => assertOriginalMoveFinalSourceGraph(value.finalInput), { code: 'ORIGINAL_MOVE_FINAL_GRAPH_CHANGED' });
  }
  groups++;

  {
    const value = workspaceOperationOriginalMovePristineSourcesFixture(), order = value.finalInput.catalogueOriginalOrder!;
    for (const catalogueOriginalOrder of [undefined, [], [...order].reverse(), [order[0], order[0]], [...order, 'foreign-document']])
      assert.throws(() => assertOriginalMoveFinalSourceGraph({ ...value.finalInput, catalogueOriginalOrder }), { code: 'ORIGINAL_MOVE_FINAL_GRAPH_CHANGED' });
  }
  groups++;

  {
    const value = workspaceOperationOriginalMovePristineSourcesFixture();
    const stage = decodeWorkspaceOperationOriginalMoveNamespaceStage(value.namespaceState.stageText, value.context, value.intent.version === 1
      ? undefined : value.intent.currentWitness);
    assert.equal(stage.version, 2);
    const receipt = decodeWorkspaceOperationOriginalMoveNamespaceReceipt(value.namespaceReceipt.receiptText, value.context,
      value.namespaceState, value.intent.version === 1 ? undefined : value.intent.currentWitness);
    assert.equal(receipt.version, 2);
    assert.throws(() => decodeWorkspaceOperationOriginalMoveNamespaceStage(value.namespaceState.stageText, value.context));
    for (const invalid of [
      { ...value.stage, pristineRegistry: [] },
      { ...value.stage, pristineRegistry: [value.stage.pristineRegistry[0], value.stage.pristineRegistry[0]] },
      { ...value.stage, lineages: [] },
      { ...value.stage, catalogueBinding: { ...value.stage.catalogueBinding, evidenceProof: '0'.repeat(64) } },
      { ...value.stage, pristineRegistry: [{ ...value.stage.pristineRegistry[0], registry: {
        ...value.stage.pristineRegistry[0].registry, yjs_state_lifecycle: 'initialized' } }] },
    ]) assert.throws(() => decodeWorkspaceOperationOriginalMoveNamespaceStage(json(invalid), value.context, value.context.plan.sourceEvidence));
    const foreign = workspaceOperationOriginalMovePristineSourcesFixture(3);
    assert.throws(() => decodeWorkspaceOperationOriginalMoveNamespaceStage(value.namespaceState.stageText, value.context,
      foreign.context.plan.sourceEvidence));
  }
  groups++;

  {
    // A genuinely unregistered physical asset still uses the old Stage1 arm:
    // no catalogue inverse or namespace receipt becomes newly mandatory.
    const value = workspaceOperationOriginalMovePristineSourcesFixture();
    const observation = structuredClone(value.originalObservation);
    observation.privateCatalogue = observation.privateCatalogue.filter(item => item.id !== 'pristine-txt-document');
    observation.stage.catalogueProof = proof(observation.privateCatalogue);
    observation.stage.stageProof = workspaceSourceAuthorityStageProof(observation.stage);
    const workspace: WorkspaceContext = { ...value.context.plan.sourceEvidence.workspaceScope, workspaceType: 'personal',
      ownerUserId: value.context.plan.sourceEvidence.workspaceScope.ownerUserId!,
      rootRelativePath: value.context.plan.sourceEvidence.workspaceScope.rootRelativePath!,
      permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: false } };
    const plan = createWorkspaceOperationNativeMoveBatchPlanV2({ scope: { workspace, fileOptions: {} }, observation,
      actions: [{ kind: 'move', reviewId: 'direct_move', selections: [{ sourcePath: 'z-folder', destinationPath: 'a-folder' }] }] });
    const context = { ...value.context, plan };
    const effects = workspaceOperationOriginalMoveNamespaceEffects(context);
    const stageText = json({ version: 1, batchId: context.batchId, planId: plan.planId, workspaceId: plan.workspaceId,
      organizationId: null, requestHash: context.requestHash, actor: context.actor, schema: 'declared_fixture',
      effectsProof: proof(effects), beforeRows: { metadata: [], userStates: [], guests: [], publicShares: [], locks: [] }, lineages: [] });
    const intent = createWorkspaceOperationOriginalMoveIntent({ physical: [value.original], nativeBundle: null,
      namespaceState: { stageText, stageDigest: sha(stageText) }, currentWitness: plan.sourceEvidence }, context);
    assert.equal(decodeWorkspaceOperationOriginalMoveNamespaceStage(stageText, context).version, 1);
    const final = structuredClone(observation);
    for (const entry of final.stage.namespace) if (entry.path === 'z-folder' || entry.path.startsWith('z-folder/'))
      entry.path = entry.path.replace(/^z-folder/u, 'a-folder');
    final.stage.namespace.sort((a, b) => a.path.localeCompare(b.path));
    final.stage.stageProof = workspaceSourceAuthorityStageProof(final.stage);
    assertOriginalMoveFinalSourceGraph({ context, intent,
      compiled: assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan, observation, plan.sourceEvidence.workspaceScope),
      facts: deriveOriginalMoveSourceNamespaceFacts(context, [value.original], [value.physicalReceipt], []), observation: final,
      nativeReceipts: [] });
  }
  groups++;
  console.log(`Original Move pristine final sources: ${groups} pure families passed (declared observations only).`);
}
