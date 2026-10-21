import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { authoritativeNativeCollaborationSnapshot, inspectPersistedNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { loadCollaborationStateOnConnection, type PersistedCollaborationState } from '../collaboration/persistence';
import { captureAgentStateSnapshot } from '../collaboration/agent-durability';
import { Y } from '../collaboration/server-runtime';
import { prepareNativeLinkMutationsV4, assertPreparedNativeLinkInspectionProfile,
  type PreparedNativeLinkUpdateV4 } from '../markdown/workspace-native-link-mutations';
import { nativeLinkPreparedIntentProof, persistPreparedNativeLinkMutationOnConnection,
  type NativeLinkMutationBinding, type NativeLinkMutationReceipt } from '../markdown/native-link-mutation-persistence';
import type { NativeLinkMutationRecipe } from '../markdown/workspace-link-contract-v2';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationNativeHtmlSourceEvidenceV4 } from './workspace-operation-native-source-evidence';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import type { OriginalDeleteNativeLinkContext } from './workspace-operation-original-delete-links';
import { assertOriginalDeleteNativeLinkRecipeIntents } from './workspace-operation-original-delete-link-recipe-intents';

/** Explicit profile4 wrapper; the genuine persistence receipt itself remains2. */
export type OriginalDeleteNativeLinkIntentV4 = Readonly<{
  prepared: Omit<PreparedNativeLinkUpdateV4, 'update'> & { updateBase64: string };
  binding: NativeLinkMutationBinding;
}>;
export type OriginalDeleteNativeLinkReceiptV4 = Omit<NativeLinkMutationReceipt, 'afterStateSnapshot'> & {
  afterStateSnapshotBase64: string;
  resultEvidenceVersion: 4; parserVersion: 4; htmlSourceProof: string;
  afterBinaryHash: string; afterVectorHash: string;
};
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
function fail(code = 'ORIGINAL_DELETE_UNPROVEN'): never { throw Object.assign(new Error(code), { code, status: 409 }); }
function keys(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) fail();
}
function binary(value: unknown, maximum: number): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4) fail();
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.byteLength || bytes.byteLength > maximum || bytes.toString('base64') !== value) fail(); return bytes;
}
function mutationId(context: OriginalDeleteNativeLinkContext, documentId: string): string {
  return 'native-delete-link:' + hash(context.batchId + '\n' + documentId);
}
function binding(context: OriginalDeleteNativeLinkContext, prepared: PreparedNativeLinkUpdateV4): NativeLinkMutationBinding {
  return { actorUserId: context.actor.userId, actorId: context.actor.actorId, actorType: context.actor.actorType,
    actorSessionId: context.actor.actorSessionId, requestId: mutationId(context, prepared.source.documentId), requestHash: context.requestHash,
    authorizedPreparedProof: nativeLinkPreparedIntentProof(prepared) };
}
function prepared(intent: OriginalDeleteNativeLinkIntentV4): PreparedNativeLinkUpdateV4 {
  const { updateBase64, ...facts } = intent.prepared;
  return { ...facts, update: binary(updateBase64, 16 * 1024 * 1024) };
}

/** Own-data facts only. Profile4 cannot enter the historical profile2 decoder. */
export function decodeOriginalDeleteNativeHtmlLinkIntentsV4(input: unknown,
  context: OriginalDeleteNativeLinkContext): OriginalDeleteNativeLinkIntentV4[] {
  const value = captureWorkspaceOperationNativePlanData(input, () => fail(), 1024 * 1024);
  if (!Array.isArray(value) || value.length > 256) fail();
  const documents = new Set<string>();
  for (const raw of value) {
    keys(raw, ['prepared', 'binding']);
    const intent = raw as unknown as OriginalDeleteNativeLinkIntentV4;
    keys(intent.prepared, ['contractVersion','operationId','source','before','after','updateBase64','inverseRecipes','parserVersion','htmlSourceProof']);
    const item = prepared(intent);
    assertPreparedNativeLinkInspectionProfile(item);
    keys(item.source, ['workspaceId','organizationId','documentId','path','lifecycleGeneration','representation','schemaVersion']);
    keys(item.before, ['stateProof','stateVector','documentSequence']); keys(item.after, ['stateProof','stateVector']);
    if (item.contractVersion !== 4 || item.parserVersion !== 4 || !/^[a-f0-9]{64}$/u.test(item.htmlSourceProof)
      || typeof item.source.documentId !== 'string' || !item.source.documentId || item.source.workspaceId !== context.workspaceId
      || item.source.path === context.sourcePath || documents.has(item.source.documentId)
      || item.operationId !== mutationId(context, item.source.documentId) || !Array.isArray(item.inverseRecipes)
      || !item.inverseRecipes.length || !Number.isSafeInteger(item.before.documentSequence)
      || item.before.documentSequence < 0 || item.before.documentSequence >= Number.MAX_SAFE_INTEGER
      || !/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u.test(item.before.stateProof)
      || !/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u.test(item.after.stateProof)
      || item.before.stateProof === item.after.stateProof) fail();
    binary(item.before.stateVector, 4 * 1024 * 1024); binary(item.after.stateVector, 4 * 1024 * 1024);
    if (!equal(intent.binding, binding(context, item))) fail();
    documents.add(item.source.documentId);
  }
  return value as OriginalDeleteNativeLinkIntentV4[];
}

/** Only a previously assessed exact HTML Delete arm supplies these recipes.
 * Private actual native binaries remain necessary to prepare every delta. */
export function prepareOriginalDeleteNativeHtmlLinksV4(recipes: readonly NativeLinkMutationRecipe[],
  observation: WorkspaceLinkSourceAuthorityObservation, context: OriginalDeleteNativeLinkContext): OriginalDeleteNativeLinkIntentV4[] {
  const result: OriginalDeleteNativeLinkIntentV4[] = [];
  for (const documentId of [...new Set(recipes.map(recipe => recipe.source.documentId))].sort()) {
    const state = observation.privateNativeStates.find(candidate => candidate.documentId === documentId);
    if (!state) fail('ORIGINAL_DELETE_CHANGED');
    const item = prepareNativeLinkMutationsV4({ state, recipes: recipes.filter(recipe => recipe.source.documentId === documentId),
      operationId: mutationId(context, documentId) });
    const { update, ...facts } = item;
    result.push({ prepared: { ...facts, updateBase64: Buffer.from(update).toString('base64') }, binding: binding(context, item) });
  }
  const decoded = decodeOriginalDeleteNativeHtmlLinkIntentsV4(result, context);
  assertOriginalDeleteNativeLinkRecipeIntents(recipes, decoded);
  return decoded;
}

/** Conservative serialized completion budget, not a receipt or success claim. */
export function assertOriginalDeleteNativeHtmlLinkCompletionBudgetV4(intents: readonly OriginalDeleteNativeLinkIntentV4[],
  observation: WorkspaceLinkSourceAuthorityObservation, envelopeBytes: number): void {
  const receipts: OriginalDeleteNativeLinkReceiptV4[] = [];
  for (const intent of intents) {
    const item = prepared(intent), state = observation.privateNativeStates.find(value => value.documentId === item.source.documentId);
    if (!state) fail('ORIGINAL_DELETE_CHANGED');
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, state.yjsState); Y.applyUpdate(candidate, item.update);
      const snapshot = captureAgentStateSnapshot(candidate, Y);
      if (!snapshot || snapshot.byteLength > 4 * 1024 * 1024 || 'yjs-snapshot-sha256-v1:' + hash(snapshot) !== item.after.stateProof) fail();
      receipts.push({ contractVersion: 2, operationId: item.operationId, source: item.source, binding: intent.binding,
        before: item.before, after: { ...item.after, documentSequence: item.before.documentSequence + 1, persistedAt: Number.MAX_SAFE_INTEGER },
        inverseRecipes: item.inverseRecipes, afterStateSnapshotBase64: Buffer.from(snapshot).toString('base64'),
        resultEvidenceVersion: 4, parserVersion: 4, htmlSourceProof: item.htmlSourceProof,
        afterBinaryHash: '0'.repeat(64), afterVectorHash: '0'.repeat(64) });
    } finally { candidate.destroy(); }
  }
  if (!Number.isSafeInteger(envelopeBytes) || envelopeBytes < 0
    || envelopeBytes + Buffer.byteLength(JSON.stringify(receipts)) > 2097152) fail('ORIGINAL_DELETE_UNSUPPORTED');
}
function candidateHash(state: PersistedCollaborationState, intent: OriginalDeleteNativeLinkIntentV4): string {
  return inspectPersistedNativeCollaborationSnapshot(state, (before, snapshot) => {
    if (snapshot.version.stateProof !== intent.prepared.before.stateProof
      || snapshot.version.stateVector !== intent.prepared.before.stateVector
      || snapshot.version.documentSequence !== intent.prepared.before.documentSequence) fail('ORIGINAL_DELETE_CHANGED');
    const candidate = new Y.Doc();
    try { Y.applyUpdate(candidate, Y.encodeStateAsUpdate(before)); Y.applyUpdate(candidate, prepared(intent).update);
      return hash(Y.encodeStateAsUpdate(candidate)); } finally { candidate.destroy(); }
  });
}

/** Genuine Owner-B only. Shared persistence rechecks actual before/after HTML4,
 * current authority and exact CAS. The wrapper records no fabricated receipt. */
export async function applyOriginalDeleteNativeHtmlLinksV4(database: SqlConnection, workspace: WorkspaceContext,
  intents: readonly OriginalDeleteNativeLinkIntentV4[], validateAuthority: () => Promise<void>,
  originalEvidence: WorkspaceOperationNativeHtmlSourceEvidenceV4): Promise<OriginalDeleteNativeLinkReceiptV4[]> {
  const result: OriginalDeleteNativeLinkReceiptV4[] = [];
  for (const intent of intents) {
    const item = prepared(intent); await validateAuthority();
    const expected = originalEvidence.nativeBindings.find(value => value.expected.documentId === item.source.documentId)?.expected;
    const before = await loadCollaborationStateOnConnection(database, item.source.documentId, true);
    if (!expected || !before || hash(before.yjsState) !== expected.binaryHash || hash(before.stateVector) !== expected.vectorHash
      || before.documentSequence !== expected.documentSequence || before.persistedAt !== expected.persistedAt) fail('ORIGINAL_DELETE_CHANGED');
    const expectedBinaryHash = candidateHash(before, intent);
    const applied = await persistPreparedNativeLinkMutationOnConnection(database, { workspace, prepared: item, binding: intent.binding, validateAuthority });
    const { afterStateSnapshot, ...receipt } = applied.receipt;
    const after = await loadCollaborationStateOnConnection(database, item.source.documentId, true);
    if (!after || hash(after.yjsState) !== expectedBinaryHash || after.documentSequence !== receipt.after.documentSequence
      || after.persistedAt !== receipt.after.persistedAt || Buffer.from(after.stateVector).toString('base64') !== receipt.after.stateVector
      || authoritativeNativeCollaborationSnapshot(after).version.stateProof !== receipt.after.stateProof) fail('ORIGINAL_DELETE_POSTCONDITION');
    result.push({ ...receipt, afterStateSnapshotBase64: Buffer.from(afterStateSnapshot).toString('base64'),
      resultEvidenceVersion: 4, parserVersion: 4, htmlSourceProof: item.htmlSourceProof,
      afterBinaryHash: expectedBinaryHash, afterVectorHash: hash(after.stateVector) });
  }
  assertOriginalDeleteNativeHtmlLinkReceiptsV4(result, intents);
  return result;
}
export function assertOriginalDeleteNativeHtmlLinkReceiptsV4(input: unknown, intents: readonly OriginalDeleteNativeLinkIntentV4[]):
asserts input is OriginalDeleteNativeLinkReceiptV4[] {
  const value = captureWorkspaceOperationNativePlanData(input, () => fail(), 2097152);
  if (!Array.isArray(value) || value.length !== intents.length) fail();
  for (const [index, raw] of value.entries()) {
    keys(raw, ['contractVersion','operationId','source','binding','before','after','afterStateSnapshotBase64','inverseRecipes',
      'resultEvidenceVersion','parserVersion','htmlSourceProof','afterBinaryHash','afterVectorHash']);
    const receipt = raw as unknown as OriginalDeleteNativeLinkReceiptV4, intent = intents[index], item = intent.prepared;
    keys(receipt.after, ['stateProof','stateVector','documentSequence','persistedAt']);
    if (receipt.contractVersion !== 2 || receipt.resultEvidenceVersion !== 4 || receipt.parserVersion !== 4
      || receipt.htmlSourceProof !== item.htmlSourceProof || receipt.operationId !== item.operationId
      || !equal(receipt.source, item.source) || !equal(receipt.binding, intent.binding) || !equal(receipt.before, item.before)
      || !equal(receipt.inverseRecipes, item.inverseRecipes) || receipt.after.stateProof !== item.after.stateProof
      || receipt.after.stateVector !== item.after.stateVector || receipt.after.documentSequence !== item.before.documentSequence + 1
      || !Number.isSafeInteger(receipt.after.persistedAt) || receipt.after.persistedAt < 0
      || receipt.after.persistedAt >= Number.MAX_SAFE_INTEGER || typeof receipt.afterBinaryHash !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.afterBinaryHash)
      || receipt.afterVectorHash !== hash(binary(receipt.after.stateVector, 4 * 1024 * 1024))
      || 'yjs-snapshot-sha256-v1:' + hash(binary(receipt.afterStateSnapshotBase64, 4 * 1024 * 1024)) !== receipt.after.stateProof) fail();
  }
}
