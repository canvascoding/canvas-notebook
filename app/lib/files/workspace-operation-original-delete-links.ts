import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { authoritativeNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { captureAgentStateSnapshot } from '../collaboration/agent-durability';
import { Y } from '../collaboration/server-runtime';
import { buildWorkspaceNativeLinkGraph } from '../markdown/workspace-native-link-graph';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import { prepareNativeLinkMutations, type PreparedNativeLinkUpdate } from '../markdown/workspace-native-link-mutations';
import { nativeLinkPreparedIntentProof, persistPreparedNativeLinkMutationOnConnection,
  type NativeLinkMutationBinding, type NativeLinkMutationReceipt } from '../markdown/native-link-mutation-persistence';
import type { NativeWorkspaceLinkSnapshot } from '../markdown/workspace-link-contract-v2';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-batch-contract';
import { getWorkspaceOperationNativeDeleteLinkRecipes } from './workspace-operation-native-delete-plan';

/** Private immutable journal data, never an actor permission or a SQL capability. */
export type OriginalDeleteNativeLinkIntent = {
  prepared: Omit<PreparedNativeLinkUpdate, 'update'> & { updateBase64: string };
  binding: NativeLinkMutationBinding;
};
export type OriginalDeleteNativeLinkReceipt = Omit<NativeLinkMutationReceipt, 'afterStateSnapshot'> & {
  afterStateSnapshotBase64: string;
};
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
  context: OriginalDeleteNativeLinkContext): OriginalDeleteNativeLinkIntent[] {
  if (!Array.isArray(value) || !value.length || value.length > 256 || Buffer.byteLength(JSON.stringify(value)) > 900_000) fail();
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
  intents: readonly OriginalDeleteNativeLinkIntent[]): void {
  const recipes = getWorkspaceOperationNativeDeleteLinkRecipes(plan);
  const documents = [...new Set(recipes.map(recipe => recipe.source.documentId))].sort();
  if (!equal(documents, intents.map(item => item.prepared.source.documentId).sort())) fail();
  for (const item of intents) {
    const selected = recipes.filter(recipe => recipe.source.documentId === item.prepared.source.documentId);
    if (!selected.length || selected.some(recipe => !equal(recipe.source, item.prepared.source)
      || recipe.sourceVersion.stateProof !== item.prepared.before.stateProof
      || recipe.sourceVersion.stateVector !== item.prepared.before.stateVector
      || recipe.sourceVersion.documentSequence !== item.prepared.before.documentSequence)
      || !equal(selected.map(recipe => `${recipe.linkId}:${nativeLinkJsonProof(recipe)}`).sort(),
        item.prepared.inverseRecipes.map(inverse => `${inverse.originalLinkId}:${inverse.authorizedForwardRecipeProof}`).sort())) fail();
  }
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
  observation: WorkspaceLinkSourceAuthorityObservation, envelopeBytes: number): void {
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
        inverseRecipes: prepared.inverseRecipes, afterStateSnapshotBase64: Buffer.from(snapshot).toString('base64') });
    } finally { candidate.destroy(); }
  }
  if (!Number.isSafeInteger(envelopeBytes) || envelopeBytes < 0
    || envelopeBytes + Buffer.byteLength(JSON.stringify(receipts)) > 2097152) fail('ORIGINAL_DELETE_UNSUPPORTED');
}
export async function applyOriginalDeleteNativeLinks(database: SqlConnection, workspace: WorkspaceContext,
  intents: readonly OriginalDeleteNativeLinkIntent[], validateAuthority: () => Promise<void>): Promise<OriginalDeleteNativeLinkReceipt[]> {
  const result: OriginalDeleteNativeLinkReceipt[] = [];
  for (const item of intents) {
    const { updateBase64, ...body } = item.prepared;
    await validateAuthority();
    const applied = await persistPreparedNativeLinkMutationOnConnection(database, { workspace,
      prepared: { ...body, update: binary(updateBase64, 16 * 1024 * 1024) }, binding: item.binding, validateAuthority });
    // This transaction has not committed yet. Only the original Owner may acknowledge completion.
    const { afterStateSnapshot, ...receipt } = applied.receipt;
    result.push({ ...receipt, afterStateSnapshotBase64: Buffer.from(afterStateSnapshot).toString('base64') });
  }
  return result;
}
export function assertOriginalDeleteNativeLinkReceipts(value: unknown, intents: readonly OriginalDeleteNativeLinkIntent[]):
asserts value is OriginalDeleteNativeLinkReceipt[] {
  if (!Array.isArray(value) || value.length !== intents.length) fail();
  for (const [index, item] of value.entries()) {
    keys(item, ['contractVersion', 'operationId', 'source', 'binding', 'before', 'after', 'afterStateSnapshotBase64', 'inverseRecipes']);
    const expected = intents[index], prepared = expected.prepared, receipt = item as OriginalDeleteNativeLinkReceipt;
    keys(receipt.after, ['stateProof', 'stateVector', 'documentSequence', 'persistedAt']);
    if (receipt.contractVersion !== 2 || receipt.operationId !== prepared.operationId || !equal(receipt.source, prepared.source)
      || !equal(receipt.binding, expected.binding) || !equal(receipt.before, prepared.before)
      || !equal(receipt.inverseRecipes, prepared.inverseRecipes) || receipt.after.stateProof !== prepared.after.stateProof
      || receipt.after.stateVector !== prepared.after.stateVector || receipt.after.documentSequence !== prepared.before.documentSequence + 1
      || !Number.isSafeInteger(receipt.after.persistedAt) || receipt.after.persistedAt < 0
      || `yjs-snapshot-sha256-v1:${hash(binary(receipt.afterStateSnapshotBase64, 4 * 1024 * 1024))}` !== receipt.after.stateProof) fail();
  }
}

/** Fresh native semantic state, not projection bytes, proves the complete final graph.
 * Original logical keys survive link-anchor changes; surviving links are matched in inventory order. */
export function assertOriginalDeleteNativeFinalGraph(plan: WorkspaceOperationNativeDeleteBatchPlan,
  observation: WorkspaceLinkSourceAuthorityObservation): void {
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
