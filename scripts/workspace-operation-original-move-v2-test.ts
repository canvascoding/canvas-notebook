import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as Y from 'yjs';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { inspectPersistedNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import { captureNativeFileOperationBundle, type NativeFileOperationBundle } from '../app/lib/markdown/native-file-operation-handoff';
import { inspectNativeDocumentLinks, nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { prepareNativeLinkMutations } from '../app/lib/markdown/workspace-native-link-mutations';
import { workspaceSourceAuthorityStageProof, type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../app/lib/markdown/workspace-source-authority-stage';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import { createWorkspaceOperationNativeMoveBatchPlanV1, createWorkspaceOperationNativeMoveBatchPlanV2,
  captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness, decodeWorkspaceOperationNativeMoveBatchPlan,
  type WorkspaceOperationNativeMoveBatchPlan } from '../app/lib/files/workspace-operation-native-move-plan';
import { stageWorkspaceOperationOriginalMoveJob, WorkspaceOperationJobLifecycleError,
  type WorkspaceOperationNativeMoveJobOwner } from '../app/lib/files/workspace-operation-job-lifecycle-owner';
import * as codec from '../app/lib/files/workspace-operation-original-move';
import { preparedWorkspacePathMoveProof, type PreparedPathMoveIdentity,
  type PreparedWorkspacePathMoveOriginal } from '../app/lib/filesystem/prepared-workspace-path-move-contract';
import type { WorkspaceOperationOriginalMoveIntent, WorkspaceOperationOriginalMovePathReceipt,
  WorkspaceOperationOriginalMoveReceipt } from '../app/lib/files/workspace-operation-original-move-repository';

// Actual Yjs, inventories, compiler and prepared native link updates. Physical
// originals, journal rows and completion digests are DECLARED mechanical DTOs:
// this proves no filesystem work, SQL CAS, principal, owner, COMMIT or recovery.
type Mutable<T> = T extends Uint8Array ? Uint8Array : T extends readonly unknown[] ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
type FullObservation = Mutable<WorkspaceLinkSourceAuthorityObservation> & { privateCatalogue: WorkspaceDocumentCatalogueEntry[] };
type Representation = PersistedCollaborationState['representation'];
type Intent = codec.WorkspaceOperationOriginalMoveIntentData;
type Row = Record<string, unknown>;
const clone = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const json = codec.serializeWorkspaceOperationOriginalMoveData;
const scope: WorkspaceOperationBatchScope = { workspace: { workspaceId: 'original-move-v2', workspaceType: 'personal',
  organizationId: null, ownerUserId: 'owner', rootPath: '/fixture/original-move-v2', rootRelativePath: 'users/owner/original-move-v2',
  legacy: false, status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
    canManageWorkspace: true, canCreatePublicLinks: false } }, fileOptions: {} };
const jobScope = captureWorkspaceOperationJobScope(scope.workspace);
const selections = [{ sourcePath: 'a.md', destinationPath: 'b.md' }];
const actor: codec.WorkspaceOperationOriginalMoveActor = { userId: 'owner', actorId: 'actor', actorType: 'user', actorSessionId: 'original-session' };
const identity = (kind: 'file' | 'directory', inode = kind === 'file' ? '2' : '1'): PreparedPathMoveIdentity => ({
  device: '1', inode, mode: kind === 'file' ? 0o100644 : 0o040755, uid: 1000, gid: 1000,
  linkCount: kind === 'file' ? '1' : '2', size: '3', birthtimeNs: '10', mtimeNs: '100000000', ctimeNs: '100000000' });
function state(filePath: string, representation: Representation): PersistedCollaborationState {
  const text = filePath === 'a.md' ? '[Self](a.md)\n\n[Peer](peer.md)' : filePath === 'incoming.md' ? '[Target](a.md)' : 'Unchanged peer';
  const doc = representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
  try { return { documentId: `doc:${filePath}`, workspaceId: jobScope.workspaceId, organizationId: null, path: filePath,
    representation, lifecycleGeneration: 1, schemaVersion: 1, documentSequence: 7, persistedAt: 100,
    checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null, newlineStyle: 'lf', hasBom: false,
    degraded: false, status: 'active', yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) }; }
  finally { doc.destroy(); }
}
function catalogue(binding: WorkspaceNativeSourceBinding): WorkspaceDocumentCatalogueEntry {
  const value = binding.expected;
  return { id: value.documentId, lineage_id: value.lineageId, path: value.path, workspace_id: value.workspaceId,
    organization_id: value.organizationId, status: 'active', state_version: value.registryStateVersion,
    yjs_state_lifecycle: 'initialized', has_persisted_state: true, has_state_history: true, lifecycle_generation: value.lifecycleGeneration,
    authority: 'initialized', state_status: 'active', state_path: value.path, state_workspace_id: value.workspaceId,
    state_organization_id: value.organizationId };
}
function observation(representation: Representation): FullObservation {
  const states = ['a.md', 'incoming.md', 'peer.md'].map(filePath => state(filePath, representation));
  const inventories = states.map(value => inspectPersistedNativeCollaborationSnapshot(value, inspectNativeDocumentLinks));
  const nativeBindings: WorkspaceNativeSourceBinding[] = states.map((value, index) => ({
    expected: { documentId: value.documentId, lineageId: `lineage:${value.documentId}`, workspaceId: value.workspaceId, organizationId: null,
      path: value.path, representation, schemaVersion: 1, lifecycleGeneration: 1, registryStateVersion: 6,
      documentSequence: 7, persistedAt: 100, binaryHash: hash(value.yjsState), vectorHash: hash(value.stateVector), stateProof: inventories[index].version.stateProof },
    registry: { documentId: value.documentId, lineageId: `lineage:${value.documentId}`, workspaceId: value.workspaceId, workspaceType: 'personal',
      organizationId: null, customerId: null, projectId: null, path: value.path, provider: 'yjs', stateLifecycle: 'initialized', stateVersion: 6, status: 'active' },
    lineage: { lineageId: `lineage:${value.documentId}`, workspaceId: value.workspaceId, workspaceType: 'personal', organizationId: null,
      customerId: null, projectId: null, path: value.path, status: 'active', archivedAt: null, trashEntryId: null },
    byteProfile: { newlineStyle: 'lf', hasBom: false }, inventoryProof: proof(inventories[index]) }));
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId: jobScope.workspaceId, organizationId: null,
    catalogueProof: '', namespace: states.map(value => ({ workspaceId: value.workspaceId, path: value.path, kind: 'file',
      identity: `registry:${value.documentId}:1`, filesystemIdentity: null, documentId: value.documentId, lifecycleGeneration: 1 })),
    sources: inventories.map(inventory => ({ kind: 'native', inventory })), scope: { kind: 'visible-workspace', excludedPaths: [] },
    coverage: { complete: true, gaps: [] }, readiness: 'native-coordinator-required', executionReady: false };
  const result: FullObservation = { stage: { ...body, stageProof: '' }, nativeBindings, privateNativeStates: states,
    privateCatalogue: nativeBindings.map(catalogue) };
  refresh(result); return result;
}
function refresh(value: FullObservation): void {
  value.stage.catalogueProof = proof(value.privateCatalogue); value.stage.stageProof = workspaceSourceAuthorityStageProof(value.stage);
}
function checkpoint(original: FullObservation, present: boolean): FullObservation {
  const value = clone(original);
  for (const binding of value.nativeBindings) {
    binding.expected.registryStateVersion = 7; binding.registry.stateVersion = 7;
    value.privateCatalogue.find(row => row.id === binding.expected.documentId)!.state_version = 7;
  }
  value.privateNativeStates.forEach(item => {
    item.checkpointSequence = 7; item.checkpointedAt = 200; item.canonicalHash = 'a'.repeat(64); item.serializedHash = 'b'.repeat(64);
  });
  if (present) value.stage.namespace.find(entry => entry.path === 'a.md')!.filesystemIdentity = '1:2:3:100:100';
  refresh(value); return value;
}
function physical(present: boolean): PreparedWorkspacePathMoveOriginal {
  return { version: 1, workspace: { workspaceId: jobScope.workspaceId, workspaceType: 'personal', organizationId: null, rootPath: jobScope.rootPath },
    sourcePath: 'a.md', destinationPath: 'b.md', budget: { maxDepth: 32, maxEntries: 10_000, maxHashBytes: 4 * 1024 ** 3 }, caseOnlyAlias: false,
    filesystem: { root: { resolvedPath: jobScope.rootPath, identity: identity('directory') },
      sourceParents: { directories: [], missingPrefix: null }, destinationParents: { directories: [], missingPrefix: null } },
    source: present ? { kind: 'regular_file', identity: identity('file'), sha256: hash('declared projection bytes') } : { kind: 'projection_absent' } };
}
function context(plan: WorkspaceOperationNativeMoveBatchPlan): codec.WorkspaceOperationOriginalMoveContext {
  return { batchId: 'original-move-v2-batch-0001', requestHash: hash('original-request'), actor, plan };
}
function nativeBundle(selected: codec.WorkspaceOperationOriginalMoveContext, observed: WorkspaceLinkSourceAuthorityObservation,
  sourceEvidence = selected.plan.sourceEvidence): codec.WorkspaceOperationOriginalMoveNativeBundleData {
  const plan = selected.plan, paths = plan.nativePathPlan.pathMappings.filter(mapping => mapping.source.documentId !== null);
  const recipes = plan.nativePathPlan.mutations;
  const ids = [...new Set([...paths.map(mapping => mapping.source.documentId!), ...recipes.map(recipe => recipe.source.documentId)])].sort();
  const native: NativeFileOperationBundle = { version: 1, ...codec.getWorkspaceOperationOriginalMoveNativeIds(selected), action: 'move',
    reviewDigest: plan.planId, actor: { actorUserId: actor.userId, actorId: actor.actorId, actorType: actor.actorType, actorSessionId: actor.actorSessionId },
    mutations: ids.map(documentId => {
      const binding = sourceEvidence.nativeBindings.find(item => item.expected.documentId === documentId)!.expected;
      const value = observed.privateNativeStates.find(item => item.documentId === documentId)!;
      const source = sourceEvidence.stage.sources.find(item => item.inventory.document.documentId === documentId)!.inventory.document;
      const mapping = paths.find(item => item.source.documentId === documentId), selectedRecipes = recipes.filter(item => item.source.documentId === documentId);
      const mutationId = codec.getWorkspaceOperationOriginalMoveNativeIds(selected, documentId).mutationId!;
      return { mutationId, kind: mapping ? 'move' : 'link', source, lineageId: binding.lineageId,
        registryStateVersion: binding.registryStateVersion, before: { documentSequence: binding.documentSequence, persistedAt: binding.persistedAt,
          stateProof: binding.stateProof, stateVector: Buffer.from(value.stateVector).toString('base64'), binaryHash: binding.binaryHash },
        destinationPath: mapping?.destinationPath ?? null, trashEntryId: null,
        prepared: selectedRecipes.length ? prepareNativeLinkMutations({ state: value, recipes: selectedRecipes, operationId: mutationId }) : null };
    }) };
  const captured = captureNativeFileOperationBundle(native);
  return { privateText: captured.privateText, changesBundleProof: captured.changesBundleProof, actionPayloadText: captured.actionPayloadText };
}
function fixture(representation: Representation = 'plain_text', present = true) {
  const original = observation(representation), current = checkpoint(original, present);
  const plan = createWorkspaceOperationNativeMoveBatchPlanV2({ scope, actions: [{ kind: 'move', reviewId: 'original_move_v2', selections }], observation: original });
  const selected = context(plan), currentWitness = captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan, current, jobScope);
  const bundle = nativeBundle(selected, current, currentWitness), prepared = physical(present);
  const intent = codec.createWorkspaceOperationOriginalMoveIntent({ physical: [prepared], nativeBundle: bundle, namespaceState: null, currentWitness }, selected);
  assert.equal(intent.version, 2);
  return { original, current, plan, context: selected, currentWitness, nativeBundle: bundle, prepared, intent };
}
type Fixture = ReturnType<typeof fixture>;
function intentRow(value: Intent): WorkspaceOperationOriginalMoveIntent {
  const intentText = json(value);
  return { batchId: value.batchId, planId: value.planId, workspaceId: value.jobScope.workspaceId, requestHash: value.requestHash,
    intentText, intentDigest: hash(intentText), createdAt: 100 };
}
function rejects(value: unknown, selected: codec.WorkspaceOperationOriginalMoveContext,
  expected: 'ORIGINAL_MOVE_INVALID' | 'ORIGINAL_MOVE_CHANGED' | 'ORIGINAL_MOVE_TOO_LARGE' = 'ORIGINAL_MOVE_CHANGED'): void {
  const code = (error: unknown) => error instanceof codec.WorkspaceOperationOriginalMoveCodecError && error.code === expected;
  assert.throws(() => codec.captureWorkspaceOperationOriginalMoveIntent(value, selected), code);
  const intentText = json(value), header = { batchId: selected.batchId, planId: selected.plan.planId, workspaceId: selected.plan.workspaceId,
    requestHash: selected.requestHash, intentText, intentDigest: hash(intentText), createdAt: 100 };
  assert.throws(() => codec.parseWorkspaceOperationOriginalMoveIntent(header, selected), code);
}
function withBundle(value: Fixture, mutate: (bundle: Row) => void): Mutable<Intent> {
  const intent = clone(value.intent), raw = JSON.parse(intent.nativeBundle!.privateText) as Row;
  mutate(raw); const privateText = JSON.stringify(raw), changesBundleProof = hash(privateText);
  const payload = JSON.parse(intent.nativeBundle!.actionPayloadText) as Row;
  Object.assign(payload, { operationId: raw.operationId, requestId: raw.requestId, actor: raw.actor, reviewDigest: raw.reviewDigest, changesBundleProof });
  intent.nativeBundle = { privateText, changesBundleProof, actionPayloadText: JSON.stringify(payload) }; return intent;
}
function declaredPathRows(intent: Intent): WorkspaceOperationOriginalMovePathReceipt[] {
  return intent.steps.map(step => {
    const source = clone(step.physical.source);
    const value: codec.WorkspaceOperationOriginalMovePathReceiptData = { version: 1, batchId: intent.batchId, intentDigest: hash(json(intent)),
      stepKey: step.stepKey, originalProof: step.originalProof, physical: { version: 1, original: step.physical, createdParents: [],
        observation: source.kind === 'projection_absent' ? { kind: 'projection_absent' } : { kind: 'moved', method: 'rename-no-replace', source } }, parentReceipts: [] };
    const receiptText = json(value); return { batchId: intent.batchId, intentDigest: value.intentDigest, stepKey: step.stepKey,
      receiptText, receiptDigest: hash(receiptText), createdAt: 101 };
  });
}
function declaredCompletion(intent: Intent, paths: WorkspaceOperationOriginalMovePathReceipt[]): WorkspaceOperationOriginalMoveReceipt {
  const bundle = codec.readWorkspaceOperationOriginalMoveNativeBundle(intent)!;
  const value: codec.WorkspaceOperationOriginalMoveCompletionData = { version: 1, batchId: intent.batchId, intentDigest: hash(json(intent)),
    planId: intent.planId, compilerPlanProof: intent.compilerPlanProof, finalGraphProof: intent.finalGraphProof, parentReceipts: [],
    pathReceipts: paths.map(row => ({ stepKey: row.stepKey, receiptDigest: row.receiptDigest })), native: { operationId: bundle.operationId,
      requestId: bundle.requestId, changesBundleProof: intent.nativeBundle!.changesBundleProof,
      receipts: bundle.mutations.map(mutation => ({ mutationId: mutation.mutationId, receiptDigest: hash(`declared:${mutation.mutationId}`) })),
      sideEffectReceiptDigest: hash('declared-native-effects') }, namespaceEffects: null };
  const receiptText = json(value); return { batchId: intent.batchId, intentDigest: value.intentDigest, receiptText, receiptDigest: hash(receiptText), createdAt: 102 };
}

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
  test(`${representation}: Intent2 stores the actual checkpoint witness and bundle CAS while preserving the original preview`, () => {
    for (const present of [false, true]) {
      const value = fixture(representation, present), before = clone(value), decoded = codec.parseWorkspaceOperationOriginalMoveIntent(intentRow(value.intent), value.context);
      assert.equal(value.plan.sourceEvidence.nativeBindings[0].expected.registryStateVersion, 6);
      assert.equal(decoded.version, 2); assert(decoded.version === 2);
      assert.equal(decoded.currentWitness.nativeBindings[0].expected.registryStateVersion, 7);
      assert.equal(decoded.currentWitness.semanticProof, value.plan.sourceEvidence.semanticProof);
      assert.notEqual(decoded.currentWitness.evidenceProof, value.plan.sourceEvidence.evidenceProof);
      assert.equal(decoded.steps[0].physical.source.kind, present ? 'regular_file' : 'projection_absent');
      const bundle = codec.readWorkspaceOperationOriginalMoveNativeBundle(decoded)!;
      assert.deepEqual(bundle.mutations.map(item => item.registryStateVersion), [7, 7]);
      assert.deepEqual(bundle.mutations.map(item => item.before.documentSequence), [7, 7]);
      assert.equal(decoded.planId, value.plan.planId); assert.equal(decoded.nativeBundle!.changesBundleProof, value.nativeBundle.changesBundleProof);
      const paths = declaredPathRows(decoded); codec.decodeWorkspaceOperationOriginalMovePathReceipt(paths[0], decoded, []);
      codec.decodeWorkspaceOperationOriginalMoveCompletion(declaredCompletion(decoded, paths), decoded, [], paths);
      assert.equal(json(decoded), intentRow(value.intent).intentText); assert(Object.isFrozen(decoded.currentWitness.nativeBindings[0].expected));
      assert.deepEqual(value, before);
    }
  });

  test(`${representation}: stale witness, registry CAS and native before clocks reject after every outer digest is renewed`, () => {
    const value = fixture(representation);
    rejects({ ...clone(value.intent), currentWitness: value.plan.sourceEvidence }, value.context);
    for (const mutate of [
      (mutation: Row) => { mutation.registryStateVersion = 6; },
      (mutation: Row) => { mutation.registryStateVersion = 8; },
      (mutation: Row) => { (mutation.before as Row).documentSequence = 8; },
      (mutation: Row) => { (mutation.before as Row).persistedAt = 101; },
      (mutation: Row) => { (mutation.before as Row).stateProof = `yjs-snapshot-sha256-v1:${hash('foreign')}`; },
      (mutation: Row) => { (mutation.before as Row).binaryHash = hash('foreign'); },
      (mutation: Row) => { (mutation.before as Row).stateVector = Buffer.from([0]).toString('base64'); },
      (mutation: Row) => { mutation.lineageId = 'foreign-lineage'; },
    ]) rejects(withBundle(value, raw => mutate((raw.mutations as Row[])[0])), value.context);
  });
}

test('Intent2 requires its exact witness field and refuses wrong semantic scope or malformed raw witness integrity', () => {
  const value = fixture(), missing = clone(value.intent) as Row; delete missing.currentWitness;
  rejects(missing, value.context, 'ORIGINAL_MOVE_INVALID');
  rejects({ ...clone(value.intent), version: 1 }, value.context, 'ORIGINAL_MOVE_INVALID');
  for (const witness of [null, {}, { ...clone(value.currentWitness), evidenceProof: hash('foreign') },
    { ...clone(value.currentWitness), workspaceScope: { ...jobScope, rootPath: '/foreign' } }]) {
    rejects({ ...clone(value.intent), currentWitness: witness }, value.context);
  }
  const foreign = observation('plain_text'); foreign.privateNativeStates[0].hasBom = true;
  foreign.nativeBindings[0].byteProfile.hasBom = true;
  const foreignPlan = createWorkspaceOperationNativeMoveBatchPlanV2({ scope, actions: [{ kind: 'move', reviewId: 'original_move_v2', selections }], observation: foreign });
  rejects({ ...clone(value.intent), currentWitness: foreignPlan.sourceEvidence }, value.context);
});

test('physical source kind, absence, original scope and prepared proof stay bound to the B1 witness and selected paths', () => {
  const value = fixture();
  for (const transform of [
    (original: Mutable<PreparedWorkspacePathMoveOriginal>) => { original.source = { kind: 'projection_absent' }; },
    (original: Mutable<PreparedWorkspacePathMoveOriginal>) => { original.source = { kind: 'directory', entries: [
      { relativePath: '', kind: 'directory', identity: identity('directory', '2') }] }; },
    (original: Mutable<PreparedWorkspacePathMoveOriginal>) => { original.destinationPath = 'other.md'; },
    (original: Mutable<PreparedWorkspacePathMoveOriginal>) => {
      original.workspace.rootPath = '/foreign'; original.filesystem.root.resolvedPath = '/foreign';
    },
  ]) {
    const intent = clone(value.intent); transform(intent.steps[0].physical);
    intent.steps[0].originalProof = preparedWorkspacePathMoveProof(intent.steps[0].physical);
    rejects(intent, value.context);
  }
  const brokenProof = clone(value.intent); brokenProof.steps[0].originalProof = hash('foreign'); rejects(brokenProof, value.context);
});

test('actor, operation, bundle and compiler substitutions reject even with recomputed bundle, payload and intent digests', () => {
  const value = fixture();
  for (const patch of [{ actor: { ...actor, userId: 'other' } }, { jobScope: { ...jobScope, ownerUserId: 'other' } },
    { requestHash: hash('other') }, { compilerPlanProof: hash('other-compiler') }, { finalGraphProof: hash('other-graph') }]) {
    rejects({ ...clone(value.intent), ...patch }, value.context);
  }
  for (const mutate of [
    (raw: Row) => { raw.actor = { ...(raw.actor as Row), actorUserId: 'other' }; },
    (raw: Row) => { raw.operationId = 'foreign-operation'; },
    (raw: Row) => { raw.reviewDigest = hash('foreign-plan'); },
    (raw: Row) => { (raw.mutations as Row[])[0].mutationId = 'foreign-mutation'; },
  ]) rejects(withBundle(value, mutate), value.context);
  rejects(withBundle(value, raw => { raw.mutations = (raw.mutations as Row[]).slice(0, 1); }), value.context, 'ORIGINAL_MOVE_TOO_LARGE');
});

test('legacy Intent1 remains exact and accepts the historical outer-V3/EvidenceV2 raw-hash arm without a witness field', () => {
  const observed = observation('plain_text'), modern = createWorkspaceOperationNativeMoveBatchPlanV2({ scope,
    actions: [{ kind: 'move', reviewId: 'original_move_v2', selections }], observation: observed });
  const { planIdentityVersion: _version, integrityProof: _integrity, planId: _id, ...historicalBody } = modern;
  const historical = decodeWorkspaceOperationNativeMoveBatchPlan({ ...historicalBody, planId: proof(historicalBody) });
  const legacy = createWorkspaceOperationNativeMoveBatchPlanV1({ scope, actions: [{ kind: 'move', reviewId: 'original_move_v2', selections }], observation: observed });
  for (const plan of [legacy, historical]) {
    const selected = context(plan), bundle = nativeBundle(selected, observed);
    const intent = codec.createWorkspaceOperationOriginalMoveIntent({ physical: [physical(false)], nativeBundle: bundle, namespaceState: null }, selected);
    assert.equal(intent.version, 1); assert.equal(Object.hasOwn(intent, 'currentWitness'), false);
    assert.equal(json(codec.parseWorkspaceOperationOriginalMoveIntent(intentRow(intent), selected)), json(intent));
    assert.equal(codec.readWorkspaceOperationOriginalMoveNativeBundle(intent)!.mutations[0].registryStateVersion, 6);
    rejects({ ...clone(intent), currentWitness: modern.sourceEvidence }, selected, 'ORIGINAL_MOVE_INVALID');
  }
});

test('a genuine-capture CurrentWitness remains data and cannot be used as a Move mutation owner', async () => {
  const value = fixture();
  await assert.rejects(stageWorkspaceOperationOriginalMoveJob(value.currentWitness as unknown as WorkspaceOperationNativeMoveJobOwner,
    { preparedSteps: [] }), (error: unknown) => error instanceof WorkspaceOperationJobLifecycleError && error.code === 'JOB_LIFECYCLE_REQUIRED');
  assert.throws(() => codec.readWorkspaceOperationOriginalMoveNativeBundle(value.currentWitness as unknown as Intent),
    (error: unknown) => error instanceof codec.WorkspaceOperationOriginalMoveCodecError && error.code === 'ORIGINAL_MOVE_INVALID');
});
