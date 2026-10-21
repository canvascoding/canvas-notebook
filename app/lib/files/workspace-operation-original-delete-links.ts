import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { authoritativeNativeCollaborationSnapshot, inspectPersistedNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { loadCollaborationStateOnConnection, type PersistedCollaborationState } from '../collaboration/persistence';
import { captureAgentStateSnapshot } from '../collaboration/agent-durability';
import { Y } from '../collaboration/server-runtime';
import { buildWorkspaceNativeLinkGraph } from '../markdown/workspace-native-link-graph';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import { prepareNativeLinkMutations, type PreparedNativeLinkUpdate } from '../markdown/workspace-native-link-mutations';
import { nativeLinkPreparedIntentProof, persistPreparedNativeLinkMutationOnConnection,
  type NativeLinkMutationBinding, type NativeLinkMutationReceipt } from '../markdown/native-link-mutation-persistence';
import type { NativeLinkMutationRecipe, NativeWorkspaceLinkSnapshot } from '../markdown/workspace-link-contract-v2';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-batch-contract';
import { getWorkspaceOperationNativeDeleteLinkRecipes } from './workspace-operation-native-delete-plan';
import { assertOriginalDeleteNativeLinkRecipeIntents } from './workspace-operation-original-delete-link-recipe-intents';
import { captureWorkspaceOperationNativeSourceEvidenceV2,
  type WorkspaceOperationNativeSourceEvidenceV2 } from './workspace-operation-native-source-evidence';
import { decodeWorkspaceOperationNativeOriginalSourceWitness } from './workspace-operation-native-original-source';
import type { OriginalDeleteNativeLinkIntentV4, OriginalDeleteNativeLinkReceiptV4 } from './workspace-operation-original-delete-html-links';
export type { OriginalDeleteNativeLinkIntentV4, OriginalDeleteNativeLinkReceiptV4 } from './workspace-operation-original-delete-html-links';

/** Private immutable journal data, never an actor permission or a SQL capability. */
export type OriginalDeleteNativeLinkIntent = {
  prepared: Omit<PreparedNativeLinkUpdate, 'update'> & { updateBase64: string };
  binding: NativeLinkMutationBinding;
};
export type OriginalDeleteNativeLinkReceipt = Omit<NativeLinkMutationReceipt, 'afterStateSnapshot'> & {
  afterStateSnapshotBase64: string;
  /** V3 original completion only: separate full-update evidence. A snapshot
   * contains clocks/deletions and cannot stand in for a content binary hash. */
  resultEvidenceVersion?: 3;
  afterBinaryHash?: string;
  afterVectorHash?: string;
};
export type AnyOriginalDeleteNativeLinkIntent = OriginalDeleteNativeLinkIntent | OriginalDeleteNativeLinkIntentV4;
export type AnyOriginalDeleteNativeLinkReceipt = OriginalDeleteNativeLinkReceipt | OriginalDeleteNativeLinkReceiptV4;
export type OriginalDeleteNativeLinkContext = {
  batchId: string; workspaceId: string; sourcePath: string; requestHash: string;
  actor: { userId: string; actorId: string; actorType: 'user' | 'agent'; actorSessionId: string | null };
};
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function fail(code = 'ORIGINAL_DELETE_UNPROVEN'): never {
  throw Object.assign(new Error(code), { code, status: 409 });
}
function keys(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== names.length
    || names.some(name => !Object.hasOwn(value, name))) fail();
}
function binary(value: unknown, maximum: number): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4) fail();
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.byteLength || decoded.byteLength > maximum || decoded.toString('base64') !== value) fail();
  return decoded;
}
function operationId(context: OriginalDeleteNativeLinkContext, documentId: string): string {
  return `native-delete-link:${hash(`${context.batchId}\n${documentId}`)}`;
}
function bindingFor(context: OriginalDeleteNativeLinkContext, prepared: PreparedNativeLinkUpdate): NativeLinkMutationBinding {
  return { actorUserId: context.actor.userId, actorId: context.actor.actorId, actorType: context.actor.actorType,
    actorSessionId: context.actor.actorSessionId, requestId: operationId(context, prepared.source.documentId),
    requestHash: context.requestHash, authorizedPreparedProof: nativeLinkPreparedIntentProof(prepared) };
}
export function decodeOriginalDeleteNativeLinkIntents(value: unknown,
  context: OriginalDeleteNativeLinkContext, allowEmpty = false): OriginalDeleteNativeLinkIntent[] {
  if (!Array.isArray(value) || !allowEmpty && !value.length || value.length > 256 || Buffer.byteLength(JSON.stringify(value)) > 900_000) fail();
  const documents = new Set<string>();
  for (const item of value) {
    keys(item, ['prepared', 'binding']);
    const prepared = item.prepared as OriginalDeleteNativeLinkIntent['prepared'];
    keys(prepared, ['contractVersion', 'operationId', 'source', 'before', 'after', 'updateBase64', 'inverseRecipes']);
    keys(prepared.source, ['documentId', 'workspaceId', 'organizationId', 'path', 'lifecycleGeneration', 'representation', 'schemaVersion']);
    keys(prepared.before, ['stateProof', 'stateVector', 'documentSequence']); keys(prepared.after, ['stateProof', 'stateVector']);
    const { source } = prepared;
    if (prepared.contractVersion !== 2 || typeof source.documentId !== 'string' || !source.documentId
      || source.workspaceId !== context.workspaceId || source.path === context.sourcePath || documents.has(source.documentId)
      || prepared.operationId !== operationId(context, source.documentId) || !Array.isArray(prepared.inverseRecipes)
      || !prepared.inverseRecipes.length || !Number.isSafeInteger(prepared.before.documentSequence) || prepared.before.documentSequence < 0
      || prepared.before.documentSequence >= Number.MAX_SAFE_INTEGER
      || !/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u.test(prepared.before.stateProof)
      || !/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u.test(prepared.after.stateProof)
      || prepared.before.stateProof === prepared.after.stateProof) fail();
    binary(prepared.before.stateVector, 4 * 1024 * 1024); binary(prepared.after.stateVector, 4 * 1024 * 1024);
    const { updateBase64, ...body } = prepared;
    if (!equal(item.binding, bindingFor(context, { ...body, update: binary(updateBase64, 16 * 1024 * 1024) }))) fail();
    documents.add(source.documentId);
  }
  return value;
}
export function assertOriginalDeleteNativeLinkPlan(plan: WorkspaceOperationNativeDeleteBatchPlan,
  intents: readonly AnyOriginalDeleteNativeLinkIntent[]): void {
  if (intents.some(item => item.prepared.contractVersion !== (plan.planIdentityVersion === 4 ? 4 : 2))) fail();
  const recipes = getWorkspaceOperationNativeDeleteLinkRecipes(plan);
  assertOriginalDeleteNativeLinkRecipeIntents(recipes, intents);
}
export function prepareOriginalDeleteNativeLinks(plan: WorkspaceOperationNativeDeleteBatchPlan,
  observation: WorkspaceLinkSourceAuthorityObservation, context: OriginalDeleteNativeLinkContext): OriginalDeleteNativeLinkIntent[] {
  const recipes = getWorkspaceOperationNativeDeleteLinkRecipes(plan), result: OriginalDeleteNativeLinkIntent[] = [];
  for (const documentId of [...new Set(recipes.map(recipe => recipe.source.documentId))].sort()) {
    const state = observation.privateNativeStates.find(candidate => candidate.documentId === documentId);
    if (!state) fail('ORIGINAL_DELETE_CHANGED');
    const prepared = prepareNativeLinkMutations({ state, recipes: recipes.filter(recipe => recipe.source.documentId === documentId),
      operationId: operationId(context, documentId) });
    const { update, ...body } = prepared;
    result.push({ prepared: { ...body, updateBase64: Buffer.from(update).toString('base64') }, binding: bindingFor(context, prepared) });
  }
  if (result.length) decodeOriginalDeleteNativeLinkIntents(result, context);
  assertOriginalDeleteNativeLinkPlan(plan, result);
  return result;
}
/** Compute exact proposed containment bytes before the physical stage. The
 * caller supplies a conservative bound for the remaining fixed completion envelope. */
export function assertOriginalDeleteNativeLinkCompletionBudget(intents: readonly OriginalDeleteNativeLinkIntent[],
  observation: WorkspaceLinkSourceAuthorityObservation, envelopeBytes: number, resultEvidenceVersion?: 3): void {
  const receipts: OriginalDeleteNativeLinkReceipt[] = [];
  for (const item of intents) {
    const { prepared, binding } = item, state = observation.privateNativeStates.find(value => value.documentId === prepared.source.documentId);
    if (!state) fail('ORIGINAL_DELETE_CHANGED');
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, state.yjsState); Y.applyUpdate(candidate, binary(prepared.updateBase64, 16 * 1024 * 1024));
      const snapshot = captureAgentStateSnapshot(candidate, Y);
      if (!snapshot || snapshot.byteLength > 4 * 1024 * 1024 || `yjs-snapshot-sha256-v1:${hash(snapshot)}` !== prepared.after.stateProof) fail();
      receipts.push({ contractVersion: 2, operationId: prepared.operationId, source: prepared.source, binding, before: prepared.before,
        after: { ...prepared.after, documentSequence: prepared.before.documentSequence + 1, persistedAt: Number.MAX_SAFE_INTEGER },
        inverseRecipes: prepared.inverseRecipes, afterStateSnapshotBase64: Buffer.from(snapshot).toString('base64'),
        ...(resultEvidenceVersion === 3 ? { resultEvidenceVersion: 3, afterBinaryHash: '0'.repeat(64), afterVectorHash: '0'.repeat(64) } : {}) });
    } finally { candidate.destroy(); }
  }
  if (!Number.isSafeInteger(envelopeBytes) || envelopeBytes < 0
    || envelopeBytes + Buffer.byteLength(JSON.stringify(receipts)) > 2097152) fail('ORIGINAL_DELETE_UNSUPPORTED');
}

/** Replay the exact immutable delta over the verified original full state.
 * This allocates no new CRDT content or identities. */
function originalDeleteLinkCandidateHash(state: PersistedCollaborationState, intent: OriginalDeleteNativeLinkIntent): string {
  return inspectPersistedNativeCollaborationSnapshot(state, (before, snapshot) => {
    if (snapshot.version.stateProof !== intent.prepared.before.stateProof
      || snapshot.version.stateVector !== intent.prepared.before.stateVector
      || snapshot.version.documentSequence !== intent.prepared.before.documentSequence) fail('ORIGINAL_DELETE_CHANGED');
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(before));
      Y.applyUpdate(candidate, binary(intent.prepared.updateBase64, 16 * 1024 * 1024));
      return hash(Y.encodeStateAsUpdate(candidate));
    } finally { candidate.destroy(); }
  });
}
export async function applyOriginalDeleteNativeLinks(database: SqlConnection, workspace: WorkspaceContext,
  intents: readonly OriginalDeleteNativeLinkIntent[], validateAuthority: () => Promise<void>,
  originalEvidence?: WorkspaceOperationNativeSourceEvidenceV2): Promise<OriginalDeleteNativeLinkReceipt[]> {
  const result: OriginalDeleteNativeLinkReceipt[] = [];
  for (const item of intents) {
    const { updateBase64, ...body } = item.prepared;
    await validateAuthority();
    let expectedBinaryHash: string | undefined;
    if (originalEvidence) {
      const expected = originalEvidence.nativeBindings.find(binding => binding.expected.documentId === body.source.documentId)?.expected;
      const state = await loadCollaborationStateOnConnection(database, body.source.documentId, true);
      if (!expected || !state || hash(state.yjsState) !== expected.binaryHash || hash(state.stateVector) !== expected.vectorHash
        || state.documentSequence !== expected.documentSequence || state.persistedAt !== expected.persistedAt) fail('ORIGINAL_DELETE_CHANGED');
      expectedBinaryHash = originalDeleteLinkCandidateHash(state, item);
    }
    const applied = await persistPreparedNativeLinkMutationOnConnection(database, { workspace,
      prepared: { ...body, update: binary(updateBase64, 16 * 1024 * 1024) }, binding: item.binding, validateAuthority });
    // This transaction has not committed yet. Only the original Owner may acknowledge completion.
    const { afterStateSnapshot, ...receipt } = applied.receipt;
    let resultEvidence: Pick<OriginalDeleteNativeLinkReceipt, 'resultEvidenceVersion' | 'afterBinaryHash' | 'afterVectorHash'> = {};
    if (originalEvidence) {
      const state = await loadCollaborationStateOnConnection(database, body.source.documentId, true);
      if (!state || hash(state.yjsState) !== expectedBinaryHash || state.documentSequence !== receipt.after.documentSequence
        || state.persistedAt !== receipt.after.persistedAt || Buffer.from(state.stateVector).toString('base64') !== receipt.after.stateVector
        || authoritativeNativeCollaborationSnapshot(state).version.stateProof !== receipt.after.stateProof) fail('ORIGINAL_DELETE_POSTCONDITION');
      resultEvidence = { resultEvidenceVersion: 3, afterBinaryHash: expectedBinaryHash, afterVectorHash: hash(state.stateVector) };
    }
    result.push({ ...receipt, afterStateSnapshotBase64: Buffer.from(afterStateSnapshot).toString('base64'), ...resultEvidence });
  }
  return result;
}
export function assertOriginalDeleteNativeLinkReceipts(value: unknown, intents: readonly OriginalDeleteNativeLinkIntent[], resultEvidenceVersion?: 3):
asserts value is OriginalDeleteNativeLinkReceipt[] {
  if (!Array.isArray(value) || value.length !== intents.length) fail();
  for (const [index, item] of value.entries()) {
    keys(item, ['contractVersion', 'operationId', 'source', 'binding', 'before', 'after', 'afterStateSnapshotBase64', 'inverseRecipes',
      ...(resultEvidenceVersion === 3 ? ['resultEvidenceVersion', 'afterBinaryHash', 'afterVectorHash'] : [])]);
    const expected = intents[index], prepared = expected.prepared, receipt = item as OriginalDeleteNativeLinkReceipt;
    keys(receipt.after, ['stateProof', 'stateVector', 'documentSequence', 'persistedAt']);
    if (receipt.contractVersion !== 2 || receipt.operationId !== prepared.operationId || !equal(receipt.source, prepared.source)
      || !equal(receipt.binding, expected.binding) || !equal(receipt.before, prepared.before)
      || !equal(receipt.inverseRecipes, prepared.inverseRecipes) || receipt.after.stateProof !== prepared.after.stateProof
      || receipt.after.stateVector !== prepared.after.stateVector || receipt.after.documentSequence !== prepared.before.documentSequence + 1
      || !Number.isSafeInteger(receipt.after.persistedAt) || receipt.after.persistedAt < 0
      || `yjs-snapshot-sha256-v1:${hash(binary(receipt.afterStateSnapshotBase64, 4 * 1024 * 1024))}` !== receipt.after.stateProof) fail();
    if (resultEvidenceVersion === 3 && (receipt.resultEvidenceVersion !== 3
      || typeof receipt.afterBinaryHash !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.afterBinaryHash)
      || receipt.afterVectorHash !== hash(binary(receipt.after.stateVector, 4 * 1024 * 1024)))) fail();
  }
}

/** Fresh native semantic state, not projection bytes, proves the complete final graph.
 * Original logical keys survive link-anchor changes; surviving links are matched in inventory order. */
export function assertOriginalDeleteNativeFinalGraph(plan: WorkspaceOperationNativeDeleteBatchPlan,
  observation: WorkspaceLinkSourceAuthorityObservation,
  original?: Readonly<{ sourceEvidence: WorkspaceOperationNativeSourceEvidenceV2;
    nativeLinks: readonly OriginalDeleteNativeLinkReceipt[] }>): void {
  // Mixed read sources have a separate full-namespace comparison. This
  // historical V1/V2 entry never reduces a V3 graph to its native component.
  if (plan.planIdentityVersion === 3 || plan.planIdentityVersion === 4) fail('ORIGINAL_DELETE_POSTCONDITION');
  if (plan.planIdentityVersion === 2) {
    if (!original) fail('ORIGINAL_DELETE_POSTCONDITION');
    assertOriginalDeleteNativeFinalBindings(plan, observation, original);
  }
  const { stage, privateNativeStates } = observation, expected = plan.nativeGraphPlan;
  const inferredDirectory = (entity: typeof expected.finalNamespace[number]) => entity.kind === 'directory'
    && entity.binding.kind === 'existing' && entity.binding.namespaceEvidence.filesystemIdentity === null
    && entity.binding.namespaceEvidence.identity === `registry-directory:${nativeLinkJsonProof({ workspaceId: entity.workspaceId, path: entity.path })}`;
  // Registry-only parents are derived views of live descendants. Archiving
  // their last native descendant removes that view, without deleting a real directory.
  const finalNamespace = expected.finalNamespace.filter(entity => !inferredDirectory(entity)
    || expected.finalNamespace.some(descendant => !inferredDirectory(descendant) && descendant.path.startsWith(`${entity.path}/`)));
  if (!stage.coverage.complete || stage.coverage.gaps.length || stage.sources.some(source => source.kind !== 'native')
    || stage.namespace.length !== finalNamespace.length) fail('ORIGINAL_DELETE_POSTCONDITION');
  const snapshotBody = { contractVersion: 2 as const, workspaceId: stage.workspaceId, namespace: stage.namespace,
    documents: stage.sources.flatMap(source => source.kind === 'native' ? [source.inventory] : []), coverage: { complete: true, gaps: [] } };
  const snapshot: NativeWorkspaceLinkSnapshot = { ...snapshotBody, snapshotProof: nativeLinkJsonProof(snapshotBody) };
  const graph = buildWorkspaceNativeLinkGraph(snapshot), recipes = getWorkspaceOperationNativeDeleteLinkRecipes(plan);
  for (const entity of finalNamespace) {
    const entry = stage.namespace.find(candidate => candidate.path === entity.path), original = entity.binding;
    if (!entry || original.kind !== 'existing' || entry.workspaceId !== entity.workspaceId || entry.kind !== entity.kind
      || entry.documentId !== original.namespaceEvidence.documentId || entry.lifecycleGeneration !== original.namespaceEvidence.lifecycleGeneration) {
      fail('ORIGINAL_DELETE_POSTCONDITION');
    }
    // Projection identities and parent-directory timestamps may change during our own physical stage.
    // Native identity/generation and actual asset identities remain independently bound.
    if (!entry.documentId && entry.kind === 'file' && !equal(entry, original.namespaceEvidence)) fail('ORIGINAL_DELETE_POSTCONDITION');
    if (entry.documentId && entry.identity !== original.namespaceEvidence.identity) fail('ORIGINAL_DELETE_POSTCONDITION');
    if (entry.kind === 'directory') {
      const directoryIdentity = (value: typeof entry) => value.filesystemIdentity === null ? value.identity
        : `directory:${value.filesystemIdentity.split(':').slice(0, 2).join(':')}`;
      if (directoryIdentity(entry) !== directoryIdentity(original.namespaceEvidence)) fail('ORIGINAL_DELETE_POSTCONDITION');
    }
    const inventory = snapshot.documents.find(item => item.document.documentId === entry.documentId);
    const state = privateNativeStates.find(item => item.documentId === entry.documentId);
    if (entry.documentId && (!inventory || !state || nativeLinkJsonProof(authoritativeNativeCollaborationSnapshot(state).content) !== entity.contentBasisProof
      || !equal(inventory.metadata, entity.metadata))) fail('ORIGINAL_DELETE_POSTCONDITION');
    const before = plan.sourceEvidence.stage.sources.find(source => source.kind === 'native' && source.inventory.document.documentId === entry.documentId);
    if (!before || before.kind !== 'native') { if (inventory || state) fail('ORIGINAL_DELETE_POSTCONDITION'); continue; }
    const removed = new Set(recipes.filter(recipe => recipe.source.documentId === entry.documentId).map(recipe => recipe.linkId));
    const retained = before.inventory.links.filter(link => !removed.has(link.id));
    const actual = graph.edges.filter(edge => edge.source.documentId === entry.documentId);
    if (actual.length !== retained.length) fail('ORIGINAL_DELETE_POSTCONDITION');
    for (const [index, link] of retained.entries()) {
      const edge = actual[index], desired = expected.finalEdges.find(item => item.sourceEntityKey === entity.entityKey && item.originEvidenceLinkId === link.id);
      const entityKey = (target: { workspaceId: string; identity: string }) => nativeLinkJsonProof({ workspaceId: target.workspaceId, identity: target.identity });
      const resolution = { status: edge.resolution.status, targetEntityKey: edge.resolution.target ? entityKey(edge.resolution.target) : null,
        candidateEntityKeys: edge.resolution.candidates.map(entityKey).sort() };
      if (!desired || desired.literal !== edge.literal || desired.targetPathText !== edge.targetPathText || !equal(desired.resolution, resolution)) {
        fail('ORIGINAL_DELETE_POSTCONDITION');
      }
    }
  }
  if (graph.edges.length !== expected.finalEdges.length) fail('ORIGINAL_DELETE_POSTCONDITION');
}

function assertOriginalDeleteNativeFinalBindings(plan: WorkspaceOperationNativeDeleteBatchPlan,
  observation: WorkspaceLinkSourceAuthorityObservation,
  original: Readonly<{ sourceEvidence: WorkspaceOperationNativeSourceEvidenceV2;
    nativeLinks: readonly OriginalDeleteNativeLinkReceipt[] }>): void {
  if (plan.planIdentityVersion !== 2) fail('ORIGINAL_DELETE_POSTCONDITION');
  const before = decodeWorkspaceOperationNativeOriginalSourceWitness(plan.sourceEvidence, original.sourceEvidence);
  const actual = captureWorkspaceOperationNativeSourceEvidenceV2(before.workspaceScope, observation);
  assertOriginalDeleteNativeBindingEvidence(before, actual, plan.nativeTarget.documentId,
    getWorkspaceOperationNativeDeleteLinkRecipes(plan), original.nativeLinks);
}

/** Version-independent comparison of already validated native provider facts.
 * Mixed callers must separately prove their complete physical namespace and
 * current catalogue; this helper creates no current authority or graph view. */
export function assertOriginalDeleteNativeBindingEvidence(before: WorkspaceOperationNativeSourceEvidenceV2,
  actual: WorkspaceOperationNativeSourceEvidenceV2, targetDocumentId: string,
  recipes: readonly NativeLinkMutationRecipe[], nativeLinks: readonly OriginalDeleteNativeLinkReceipt[]): void {
  const survivors = before.nativeBindings.filter(binding => binding.expected.documentId !== targetDocumentId);
  if (actual.nativeBindings.length !== survivors.length) fail('ORIGINAL_DELETE_POSTCONDITION');
  const changed = new Set(recipes.map(recipe => recipe.source.documentId));
  const receipts = new Map(nativeLinks.map(receipt => [receipt.source.documentId, receipt]));
  if (receipts.size !== nativeLinks.length || receipts.size !== changed.size
    || [...receipts.keys()].some(id => !changed.has(id))) fail('ORIGINAL_DELETE_POSTCONDITION');
  for (const binding of survivors) {
    const id = binding.expected.documentId, observed = actual.nativeBindings.find(item => item.expected.documentId === id);
    const receipt = receipts.get(id);
    if (!receipt) {
      if (!equal(observed, binding)) fail('ORIGINAL_DELETE_POSTCONDITION');
      continue;
    }
    const inventory = actual.stage.sources.find(item => item.inventory.document.documentId === id)?.inventory;
    const priorInventory = before.stage.sources.find(item => item.inventory.document.documentId === id)?.inventory;
    if (!observed || !inventory || !priorInventory || receipt.resultEvidenceVersion !== 3
      || typeof receipt.afterBinaryHash !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.afterBinaryHash)
      || receipt.afterVectorHash !== hash(binary(receipt.after.stateVector, 4 * 1024 * 1024))
      || !equal(receipt.source, priorInventory.document)
      || !equal(receipt.before, { stateProof: binding.expected.stateProof, documentSequence: binding.expected.documentSequence,
        stateVector: priorInventory.version.stateVector })) fail('ORIGINAL_DELETE_POSTCONDITION');
    const expected = { ...binding, expected: { ...binding.expected, stateProof: receipt.after.stateProof,
      documentSequence: receipt.after.documentSequence, persistedAt: receipt.after.persistedAt,
      binaryHash: receipt.afterBinaryHash, vectorHash: receipt.afterVectorHash }, inventoryProof: nativeLinkJsonProof(inventory) };
    if (!equal(observed, expected) || inventory.version.stateVector !== receipt.after.stateVector
      || inventory.version.stateProof !== receipt.after.stateProof || inventory.version.documentSequence !== receipt.after.documentSequence
      || inventory.version.persistedAt !== receipt.after.persistedAt) fail('ORIGINAL_DELETE_POSTCONDITION');
  }
}
