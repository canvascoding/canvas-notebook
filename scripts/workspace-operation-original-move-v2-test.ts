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
import { createWorkspaceOperationOriginalMovePreparation as createP0,
  decodeWorkspaceOperationOriginalMovePreparation as decodeP0,
  readWorkspaceOperationOriginalMovePreparationOnConnection as readP0,
  insertWorkspaceOperationOriginalMovePreparationOnConnection as insertP0 } from '../app/lib/files/workspace-operation-original-move-preparation';
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

// P0 regression extension. Actual Yjs/compiled witnesses/bundles below remain
// pure data. The explicitly declared DB spies exercise emitted SQL/decoding,
// not PostgreSQL locking, authority, atomicity, COMMIT or resource disposal.
for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
  test(`${representation}: P0 binds the actual checkpoint witness, native bundle and Original actor as detached immutable data`, () => {
    for (const present of [false, true]) {
      const value = fixture(representation, present), before = clone(value);
      const input = { currentWitness: clone(value.currentWitness), nativeBundleData: clone(value.nativeBundle) };
      const prepared = createP0(value.context, input), decoded = decodeP0(prepared.preparationText, value.context, value.nativeBundle);
      assert.deepEqual(decoded, prepared); assert.equal(hash(prepared.preparationText), prepared.preparationDigest);
      assert.deepEqual(prepared.preparation.actor, actor); assert.equal(prepared.preparation.actor.actorSessionId, 'original-session');
      assert.equal(prepared.preparation.requestHash, value.context.requestHash); assert.equal(prepared.preparation.planId, value.plan.planId);
      assert.deepEqual(prepared.preparation.jobScope, jobScope);
      assert.equal(value.plan.sourceEvidence.nativeBindings[0].expected.registryStateVersion, 6);
      assert.equal(prepared.preparation.currentWitness.nativeBindings[0].expected.registryStateVersion, 7);
      assert.equal(prepared.preparation.currentWitness.semanticProof, value.plan.sourceEvidence.semanticProof);
      assert.notEqual(prepared.preparation.currentWitness.evidenceProof, value.plan.sourceEvidence.evidenceProof);
      assert.deepEqual(prepared.preparation.nativeBundle, { ...codec.getWorkspaceOperationOriginalMoveNativeIds(value.context),
        changesBundleProof: value.nativeBundle.changesBundleProof });
      assert.equal(prepared.request.requestId, prepared.preparation.requestId);
      assert.equal(prepared.request.actionPayloadText, prepared.preparation.actionPayloadText);
      assert.equal(prepared.nativeBundleData?.privateText, value.nativeBundle.privateText);
      assert.equal(Object.hasOwn(prepared.preparation.nativeBundle!, 'privateText'), false, 'P0 references rather than duplicates bundle bytes.');
      assert(Object.isFrozen(prepared) && Object.isFrozen(prepared.preparation) && Object.isFrozen(prepared.preparation.actor));
      assert(Object.isFrozen(prepared.preparation.currentWitness.nativeBindings[0].expected));
      assert(Object.isFrozen(prepared.nativeBundleData) && Object.isFrozen(prepared.request.expectedDocuments));
      assert.notEqual(prepared.preparation.currentWitness, input.currentWitness); assert.notEqual(prepared.nativeBundleData, input.nativeBundleData);
      input.currentWitness.nativeBindings[0].expected.registryStateVersion = 999; input.nativeBundleData.privateText = 'caller changed its own copy';
      assert.equal(prepared.preparation.currentWitness.nativeBindings[0].expected.registryStateVersion, 7);
      assert.equal(prepared.nativeBundleData?.privateText, value.nativeBundle.privateText); assert.deepEqual(value, before);
    }
  });
}

test('P0 required-null regression rejects a native plan and preserves the actual compiler-derived physical-only null arm', () => {
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    const value = fixture(representation);
    // This assertion is expected RED on private P0-v1, GREEN only once its
    // existing strict bundle decoder is invoked for null as well (P0-v2).
    assert.throws(() => createP0(value.context, { currentWitness: value.currentWitness, nativeBundleData: null }),
      (error: unknown) => error instanceof codec.WorkspaceOperationOriginalMoveCodecError && error.code === 'ORIGINAL_MOVE_CHANGED');
  }
  // Same genuine compiler pattern as existing native-move-plan/original-move
  // tests: a declared PDF namespace root with no native mappings/link effects.
  // This is NOT proof that a physical file was observed on a filesystem.
  const observed = observation('plain_text');
  observed.stage.namespace.push({ workspaceId: jobScope.workspaceId, path: 'a.pdf', kind: 'file',
    identity: '1:100:3:100:100', filesystemIdentity: '1:100:3:100:100', documentId: null, lifecycleGeneration: null });
  refresh(observed);
  const plan = createWorkspaceOperationNativeMoveBatchPlanV2({ scope, actions: [{ kind: 'move', reviewId: 'physical_p0',
    selections: [{ sourcePath: 'a.pdf', destinationPath: 'b.pdf' }] }], observation: observed });
  assert.equal(plan.nativePathPlan.mutations.length, 0); assert(plan.nativePathPlan.pathMappings.every(mapping => mapping.source.documentId === null));
  const selected = context(plan), witness = captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan, observed, jobScope);
  const prepared = createP0(selected, { currentWitness: witness, nativeBundleData: null });
  assert.equal(prepared.preparation.nativeBundle, null); assert.equal(prepared.nativeBundleData, null);
  assert.deepEqual(decodeP0(prepared.preparationText, selected, null), prepared);
  assert.deepEqual(JSON.parse(prepared.preparation.actionPayloadText), { version: 1, batchId: selected.batchId, planId: plan.planId, requestHash: selected.requestHash });
});

test('P0 rejects substituted Original, scope, request, reference and witness facts despite recomputed outer SHA and canonical text', () => {
  const value = fixture(), prepared = createP0(value.context, { currentWitness: value.currentWitness, nativeBundleData: value.nativeBundle });
  for (const patch of [
    { actor: { ...actor, userId: 'other-user' } }, { actor: { ...actor, actorId: 'other-actor' } },
    { actor: { ...actor, actorType: 'agent' } }, { actor: { ...actor, actorSessionId: 'renewed-session-is-not-original' } },
    { jobScope: { ...jobScope, rootPath: '/other-root' } }, { requestHash: hash('other-request') },
    { planId: hash('other-plan') }, { workspaceId: 'other-workspace' }, { requestDigest: hash('other-request-digest') },
    { requestId: '11111111-1111-4111-8111-111111111111' },
    { nativeBundle: { ...prepared.preparation.nativeBundle!, changesBundleProof: hash('other-bundle') } },
    { actionPayloadText: json({ unrelated: 'payload' }) }, { extra: true },
  ]) {
    const text = json({ ...clone(prepared.preparation), ...patch });
    assert.notEqual(hash(text), prepared.preparationDigest);
    assert.throws(() => decodeP0(text, value.context, value.nativeBundle), (error: unknown) => error instanceof Error
      && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ORIGINAL_MOVE_PREPARATION_CHANGED');
  }
  for (const selected of [{ ...value.context, requestHash: hash('other-request') },
    { ...value.context, actor: { ...actor, actorSessionId: 'other-original-session' } }]) {
    assert.throws(() => createP0(selected, { currentWitness: value.currentWitness, nativeBundleData: value.nativeBundle }),
      (error: unknown) => error instanceof codec.WorkspaceOperationOriginalMoveCodecError && error.code === 'ORIGINAL_MOVE_CHANGED');
  }
  const foreign = observation('plain_text'); foreign.privateNativeStates[0].hasBom = true; foreign.nativeBindings[0].byteProfile.hasBom = true;
  const foreignPlan = createWorkspaceOperationNativeMoveBatchPlanV2({ scope, actions: [{ kind: 'move', reviewId: 'original_move_v2', selections }], observation: foreign });
  assert.throws(() => createP0(value.context, { currentWitness: foreignPlan.sourceEvidence, nativeBundleData: value.nativeBundle }),
    (error: unknown) => error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'NATIVE_SOURCE_EVIDENCE_CHANGED');
  const malformedWitness = { ...clone(value.currentWitness), evidenceProof: hash('renewed-but-invalid-evidence') };
  assert.throws(() => createP0(value.context, { currentWitness: malformedWitness, nativeBundleData: value.nativeBundle }),
    (error: unknown) => error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'NATIVE_SOURCE_EVIDENCE_INVALID');
  const altered = withBundle(value, raw => { raw.actor = { ...(raw.actor as Row), actorSessionId: 'wrong-original-session' }; }).nativeBundle!;
  assert.equal(hash(altered.privateText), altered.changesBundleProof);
  assert.throws(() => createP0(value.context, { currentWitness: value.currentWitness, nativeBundleData: altered }),
    (error: unknown) => error instanceof codec.WorkspaceOperationOriginalMoveCodecError && error.code === 'ORIGINAL_MOVE_CHANGED');
  for (const text of [` ${prepared.preparationText}`, `${prepared.preparationText}\n`,
    JSON.stringify(Object.fromEntries(Object.entries(prepared.preparation).reverse()))]) {
    assert.notEqual(text, prepared.preparationText);
    assert.throws(() => decodeP0(text, value.context, value.nativeBundle), (error: unknown) => error instanceof Error
      && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ORIGINAL_MOVE_PREPARATION_CHANGED');
  }
});

test('P0 capture rejects getters, proxies, sparse/cyclic data, bad Unicode and budgets without invoking getters or issuing SQL', async () => {
  const value = fixture(), prepared = createP0(value.context, { currentWitness: value.currentWitness, nativeBundleData: value.nativeBundle });
  let getters = 0, traps = 0, statements = 0;
  const inputGetter = Object.defineProperty({ nativeBundleData: value.nativeBundle }, 'currentWitness', { enumerable: true, get: () => { getters++; return value.currentWitness; } });
  const nestedGetter = clone(value.currentWitness); Object.defineProperty(nestedGetter, 'stage', { enumerable: true, get: () => { getters++; return value.currentWitness.stage; } });
  const proxy = new Proxy({ currentWitness: value.currentWitness, nativeBundleData: value.nativeBundle }, {
    get: () => { traps++; throw new Error('Proxy get must never execute.'); }, ownKeys: () => { traps++; throw new Error('Proxy keys must never execute.'); },
    getPrototypeOf: () => { traps++; throw new Error('Proxy prototype must never execute.'); }, getOwnPropertyDescriptor: () => { traps++; throw new Error('Proxy descriptor must never execute.'); },
  });
  const cyclic: Row = {}; cyclic.self = cyclic;
  const sparse = new Array(3); sparse[0] = null;
  const hostile = [inputGetter, proxy, { currentWitness: nestedGetter, nativeBundleData: value.nativeBundle },
    { currentWitness: cyclic, nativeBundleData: value.nativeBundle },
    { currentWitness: { broken: '\ud800' }, nativeBundleData: value.nativeBundle }];
  for (const input of hostile) assert.throws(() => createP0(value.context, input as Parameters<typeof createP0>[1]),
    (error: unknown) => error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ORIGINAL_MOVE_PREPARATION_INVALID');
  for (const currentWitness of [sparse, new Array(100_001), { payload: '🧠'.repeat(2 * 1024 ** 2 + 1) }]) {
    assert.throws(() => createP0(value.context, { currentWitness, nativeBundleData: value.nativeBundle } as unknown as Parameters<typeof createP0>[1]),
      (error: unknown) => error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ORIGINAL_MOVE_PREPARATION_TOO_LARGE'
        && Object.getOwnPropertyDescriptor(error, 'status')?.value === 413);
  }
  assert.throws(() => decodeP0(`${prepared.preparationText}\ud800`, value.context, value.nativeBundle),
    (error: unknown) => error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ORIGINAL_MOVE_PREPARATION_INVALID');
  // DECLARED BORROWED-DB SPY. It has no PG backend or authority. Any method call
  // is a failure: invalid public data must be rejected before borrowed IO.
  const noSql = { get: async () => { statements++; assert.fail('Invalid P0 must not query.'); },
    all: async () => { statements++; assert.fail('Invalid P0 must not query.'); },
    run: async () => { statements++; assert.fail('Invalid P0 must not execute SQL.'); },
    close: async () => { statements++; assert.fail('P0 cannot close the caller connection.'); } };
  const preparedGetter = Object.defineProperty({ ...prepared }, 'preparationText', { enumerable: true, get: () => { getters++; return prepared.preparationText; } });
  await assert.rejects(insertP0(noSql, { schema: 'p0_mechanical', context: value.context, prepared: preparedGetter }),
    (error: unknown) => error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ORIGINAL_MOVE_PREPARATION_INVALID');
  const changed = { ...prepared, preparationDigest: hash('forged-outer-sha') };
  await assert.rejects(insertP0(noSql, { schema: 'p0_mechanical', context: value.context, prepared: changed }),
    (error: unknown) => error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ORIGINAL_MOVE_PREPARATION_CHANGED');
  assert.equal(getters, 0); assert.equal(traps, 0); assert.equal(statements, 0);
});

test('DECLARED borrowed-read spy checks bounded qualified SQL, immutable bundle reference and exact saved bytes; no PG/auth claim', async () => {
  const value = fixture(), prepared = createP0(value.context, { currentWitness: value.currentWitness, nativeBundleData: value.nativeBundle });
  const p = prepared.preparation, row = { batchId: p.batchId, planId: p.planId, workspaceId: p.workspaceId, requestHash: p.requestHash,
    requestId: p.requestId, requestDigest: p.requestDigest, preparationText: prepared.preparationText, preparationDigest: prepared.preparationDigest, createdAt: '100' };
  const native = { operationId: p.nativeBundle!.operationId, requestId: p.nativeBundle!.requestId,
    changesBundleProof: value.nativeBundle.changesBundleProof, privateText: value.nativeBundle.privateText };
  const calls: Array<{ sql: string; params: unknown[] }> = []; let preparationRow: unknown = row, nativeRow: unknown = native;
  const declaredReadSpy = { get: async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params }); assert.match(sql, /^SELECT /u);
    if (sql.includes('workspace_file_operation_move_preparations')) {
      assert(sql.includes('"p0""mechanical".workspace_file_operation_move_preparations'));
      assert.match(sql, /CASE WHEN octet_length\(preparation_text\) BETWEEN 1 AND 16777216 THEN preparation_text ELSE NULL/u);
      assert.deepEqual(params, [value.context.batchId]); return preparationRow;
    }
    assert(sql.includes('"p0""mechanical".collaboration_native_file_operation_intents'));
    assert.match(sql, /CASE WHEN octet_length\(intent_text\) BETWEEN 1 AND 8388608 THEN intent_text ELSE NULL/u);
    assert.deepEqual(params, [p.nativeBundle!.operationId]); return nativeRow;
  }, all: async () => { assert.fail('Read spy must not use another read shape.'); },
  run: async () => { assert.fail('Historical P0 read must not execute SQL writes.'); }, close: async () => { assert.fail('Caller connection is borrowed.'); } };
  const actual = await readP0(declaredReadSpy, { schema: 'p0"mechanical', context: value.context });
  assert.deepEqual(actual, { ...prepared, createdAt: 100 }); assert.equal(calls.length, 2);
  assert(calls.every(call => call.sql.endsWith(' FOR SHARE NOWAIT')));
  calls.length = 0; assert.deepEqual(await readP0(declaredReadSpy, { schema: 'p0"mechanical', context: value.context, readOnly: true }), actual);
  assert.equal(calls.length, 2); assert(calls.every(call => !call.sql.includes('FOR SHARE')));
  preparationRow = undefined; calls.length = 0; assert.equal(await readP0(declaredReadSpy, { schema: 'p0"mechanical', context: value.context }), null);
  assert.equal(calls.length, 1); preparationRow = row;
  for (const wrong of [undefined, { ...native, requestId: '11111111-1111-4111-8111-111111111111' },
    { ...native, changesBundleProof: hash('wrong-reference') }, { ...native, privateText: null }]) {
    nativeRow = wrong;
    await assert.rejects(readP0(declaredReadSpy, { schema: 'p0"mechanical', context: value.context }),
      (error: unknown) => error instanceof Error && ['ORIGINAL_MOVE_PREPARATION_INVALID', 'ORIGINAL_MOVE_PREPARATION_CHANGED']
        .includes(Object.getOwnPropertyDescriptor(error, 'code')?.value as string));
  }
  // Renew every supplied SHA/reference: the actual strict bundle decoder still
  // rejects the wrong saved Original actor rather than trusting those digests.
  const changed = withBundle(value, raw => { raw.actor = { ...(raw.actor as Row), actorUserId: 'foreign' }; }).nativeBundle!;
  const text = json({ ...clone(p), nativeBundle: { ...p.nativeBundle!, changesBundleProof: changed.changesBundleProof }, actionPayloadText: changed.actionPayloadText });
  preparationRow = { ...row, preparationText: text, preparationDigest: hash(text) };
  nativeRow = { ...native, changesBundleProof: changed.changesBundleProof, privateText: changed.privateText };
  await assert.rejects(readP0(declaredReadSpy, { schema: 'p0"mechanical', context: value.context }),
    (error: unknown) => error instanceof codec.WorkspaceOperationOriginalMoveCodecError && error.code === 'ORIGINAL_MOVE_CHANGED');
});

test('DECLARED borrowed-insert spy distinguishes created/existing/conflict and retains caller transaction ownership; no PG/COMMIT claim', async () => {
  const value = fixture(), prepared = createP0(value.context, { currentWitness: value.currentWitness, nativeBundleData: value.nativeBundle });
  const p = prepared.preparation, row = { batchId: p.batchId, planId: p.planId, workspaceId: p.workspaceId, requestHash: p.requestHash,
    requestId: p.requestId, requestDigest: p.requestDigest, preparationText: prepared.preparationText, preparationDigest: prepared.preparationDigest, createdAt: '100' };
  const alternativeObservation = checkpoint(value.original, false), alternativeWitness = captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(value.plan, alternativeObservation, jobScope);
  const alternativeBundle = nativeBundle(value.context, alternativeObservation, alternativeWitness);
  const alternative = createP0(value.context, { currentWitness: alternativeWitness, nativeBundleData: alternativeBundle });
  const a = alternative.preparation, alternativeRow = { batchId: a.batchId, planId: a.planId, workspaceId: a.workspaceId, requestHash: a.requestHash,
    requestId: a.requestId, requestDigest: a.requestDigest, preparationText: alternative.preparationText, preparationDigest: alternative.preparationDigest, createdAt: '100' };
  assert.notEqual(alternative.preparationText, prepared.preparationText);
  for (const mode of ['created', 'existing', 'conflict', 'missing-parent'] as const) {
    const calls: string[] = [];
    const declaredInsertSpy = { get: async (sql: string, params: unknown[] = []) => {
      calls.push(sql); assert(sql.includes('"p0_mechanical".'));
      if (sql.includes('workspace_file_operation_batches')) {
        assert.match(sql, /FOR UPDATE NOWAIT$/u); assert.deepEqual(params, [p.batchId]);
        return mode === 'missing-parent' ? undefined : { batch_id: p.batchId };
      }
      if (sql.startsWith('INSERT ')) {
        assert(sql.includes('ON CONFLICT(batch_id) DO NOTHING RETURNING'));
        assert.deepEqual(params, [p.batchId, p.planId, p.workspaceId, p.requestHash, p.requestId, p.requestDigest, prepared.preparationText, prepared.preparationDigest]);
        return mode === 'created' ? row : undefined;
      }
      assert(sql.startsWith('SELECT ') && sql.endsWith(' FOR SHARE NOWAIT'));
      return mode === 'conflict' ? alternativeRow : row;
    }, all: async () => { assert.fail('Insert spy must not use an undeclared query shape.'); },
    run: async () => { assert.fail('Insert uses exactly its declared borrowed get queries.'); }, close: async () => { assert.fail('Caller owns close/COMMIT.'); } };
    const result = await insertP0(declaredInsertSpy, { schema: 'p0_mechanical', context: value.context, prepared });
    assert.equal(result.kind, mode === 'missing-parent' ? 'conflict' : mode);
    if (result.kind === 'created' || result.kind === 'existing') assert.deepEqual(result.row, { ...prepared, createdAt: 100 });
    assert.equal(calls.length, mode === 'missing-parent' ? 1 : 3);
    assert(calls.every(sql => !/\b(?:BEGIN|COMMIT|ROLLBACK)\b/u.test(sql)));
    assert(calls.every(sql => !sql.includes('collaboration_native_file_operation_intents') && !sql.includes('collaboration_admission_')));
  }
});
