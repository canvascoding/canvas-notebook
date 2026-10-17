import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import type { NativeCopyReceipt } from '../collaboration/native-copy-persistence';
import { authoritativeNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { captureCollaborationAdmissionRequest, collaborationAdmissionActionDigest,
  type CollaborationAdmissionRequest, type CollaborationAdmissionScope } from '../collaboration/room-admission-contract';
import type { NativeMixedBatchPlan } from '../markdown/workspace-native-mixed-batch-compiler';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { workspaceOperationNativePlanSnapshot } from './workspace-operation-native-plan-data';
import { assertWorkspaceOperationNativeCopyPlanCurrent } from './workspace-operation-native-copy-plan';
import { prepareNativeCopyStage, decodeNativeCopyStage, type WorkspaceOperationNativeCopyStage } from './workspace-operation-native-copy-stage';
import { preparedWorkspacePathCopyProof, type PreparedWorkspacePathCopyParentReceipt } from '../filesystem/prepared-workspace-path-copy-contract';
import { nativeCopyMetadataCompletionWitness } from './workspace-operation-native-copy-metadata';

export class NativeCopyPhaseError extends Error {
  readonly status = 409;
  constructor(readonly code: 'NATIVE_COPY_PHASE_CHANGED' | 'NATIVE_COPY_PHASE_TOO_LARGE' | 'NATIVE_COPY_PHASE_UNSUPPORTED'
    | 'NATIVE_COPY_PHASE_UNCONFIRMED' = 'NATIVE_COPY_PHASE_CHANGED', options?: ErrorOptions) {
    super(code, options); this.name = 'NativeCopyPhaseError';
  }
}
export function copyPhaseChanged(): never { throw new NativeCopyPhaseError(); }
export const nativeCopyPhaseSha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function captureNativeCopyPhaseStageRaw(stage: WorkspaceOperationNativeCopyStage): WorkspaceOperationNativeCopyStage {
  if (!stage || Object.getPrototypeOf(stage) !== Object.prototype) copyPhaseChanged();
  const discriminator = Object.getOwnPropertyDescriptor(stage, 'version');
  if (!discriminator?.enumerable || !Object.hasOwn(discriminator, 'value') || discriminator.value !== 2 && discriminator.value !== 3) copyPhaseChanged();
  const expected = ['version', 'kind', 'identity', 'request', 'origin', 'plan', 'physical', 'nativeRecords', 'payloadSha256',
    ...(discriminator.value === 3 ? ['coreV2StageDigest', 'metadata'] : [])];
  if (!stage || Object.getPrototypeOf(stage) !== Object.prototype || Reflect.ownKeys(stage).length !== expected.length
    || expected.some(key => { const property = Object.getOwnPropertyDescriptor(stage, key);
      return !property?.enumerable || !Object.hasOwn(property, 'value'); })) copyPhaseChanged();
  const prepared = prepareNativeCopyStage({ operationId: stage.identity.operationId, request: stage.request, plan: stage.plan,
    physical: stage.physical, nativeRecords: stage.nativeRecords, ...(stage.version === 3 ? { metadata: stage.metadata } : {}) });
  if (stage.version !== prepared.manifest.version || stage.kind !== 'native-copy' || prepared.manifest.payloadSha256 !== stage.payloadSha256
    || !equal(stage.origin, prepared.manifest.origin) || !equal(stage.identity, prepared.manifest.identity)) copyPhaseChanged();
  if (stage.version === 3 && (prepared.manifest.version !== 3 || stage.coreV2StageDigest !== prepared.manifest.coreV2StageDigest
    || !equal(stage.metadata, prepared.manifest.metadata))) copyPhaseChanged();
  return decodeNativeCopyStage(prepared.manifest, prepared.recordsBytes, prepared.manifest.identity);
}
type CapturedStageFrame = {
  stage: WorkspaceOperationNativeCopyStage | null; pin: string | null; active: boolean;
  failure: unknown; failed: boolean;
};
const capturedStages = new AsyncLocalStorage<CapturedStageFrame>();
export function captureNativeCopyPhaseStage(stage: WorkspaceOperationNativeCopyStage): WorkspaceOperationNativeCopyStage {
  const frame = capturedStages.getStore();
  if (frame && !frame.active) copyPhaseChanged();
  if (frame?.stage === stage) { assertCapturedStagePin(frame); return stage; }
  return captureNativeCopyPhaseStageRaw(stage);
}
export function nativeCopyPhaseOriginals(stage: WorkspaceOperationNativeCopyStage) {
  return (stage.plan.sourceScope.workspaceId === stage.plan.destinationScope.workspaceId
    ? [stage.plan.sourceEvidence] : [stage.plan.sourceEvidence, stage.plan.destinationEvidence])
    .map(evidence => workspaceOperationNativePlanSnapshot(evidence, copyPhaseChanged));
}
type CompilationFrame = {
  stage: WorkspaceOperationNativeCopyStage | null; pin: string | null; active: boolean;
  compiled: NativeMixedBatchPlan | null; failure: unknown; failed: boolean;
};
const compilations = new AsyncLocalStorage<CompilationFrame>();
/** Pin every original data descriptor, including native lineage/state metadata.
 * Hash the actual binary views directly instead of JSON-expanding their bytes.
 * This is only an integrity observation of an already detached frozen Stage. */
function compilationPin(stage: WorkspaceOperationNativeCopyStage): string {
  const hash = createHash('sha256'), parents = new Set<object>();
  let nodes = 0, metadataBytes = 0, binaryBytes = 0;
  const pending: string[] = [];
  let pendingBytes = 0;
  const flush = () => {
    if (pending.length) { hash.update(pending.join('')); pending.length = 0; pendingBytes = 0; }
  };
  const add = (value: string) => {
    const bytes = Buffer.byteLength(value);
    metadataBytes += bytes;
    if (metadataBytes > 64 * 1024 * 1024) copyPhaseChanged();
    // Each value is a whole JSON token or an ASCII marker. Keep their exact
    // UTF-8 byte order while avoiding a native Hash.update call per token.
    // Never split UTF-16 strings; an oversized token is hashed intact.
    if (pendingBytes + bytes > 64 * 1024 || pending.length >= 1024) flush();
    if (bytes > 64 * 1024) hash.update(value);
    else { pending.push(value); pendingBytes += bytes; }
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 1_000_000 || depth > 64) copyPhaseChanged();
    if (value === null || typeof value === 'boolean' || typeof value === 'string'
      || typeof value === 'number' && Number.isFinite(value)) { add(JSON.stringify(value)); return; }
    if (value instanceof Uint8Array) {
      // Native buffers remain mutable even though their enclosing data is frozen.
      // Include view length and digest, never its numeric JSON representation.
      binaryBytes += value.byteLength;
      if (binaryBytes > 128 * 1024 * 1024) copyPhaseChanged();
      add(`bytes:${value.byteLength}:${nativeCopyPhaseSha(value)}`); return;
    }
    if (!value || typeof value !== 'object' || !Object.isFrozen(value) || parents.has(value)
      || Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)) copyPhaseChanged();
    parents.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 100_000 || Reflect.ownKeys(value).length !== value.length + 1) copyPhaseChanged();
        add('[');
        for (let index = 0; index < value.length; index++) {
          const property = Object.getOwnPropertyDescriptor(value, String(index));
          if (!property?.enumerable || !Object.hasOwn(property, 'value')) copyPhaseChanged();
          add(','); visit(property.value, depth + 1);
        }
        add(']');
      } else {
        add('{');
        for (const key of Reflect.ownKeys(value)) {
          const property = Object.getOwnPropertyDescriptor(value, key);
          if (typeof key !== 'string' || !property?.enumerable || !Object.hasOwn(property, 'value')) copyPhaseChanged();
          add(JSON.stringify(key)); add(':'); visit(property.value, depth + 1); add(',');
        }
        add('}');
      }
    } finally { parents.delete(value); }
  };
  visit(stage, 0); flush(); return hash.digest('hex');
}
function assertCapturedStagePin(frame: CapturedStageFrame): void {
  if (frame.failed) throw frame.failure;
  try { if (!frame.active || !frame.stage || compilationPin(frame.stage) !== frame.pin) copyPhaseChanged(); }
  catch (error) { frame.failed = true; frame.failure = error; throw error; }
}
/** Detach and fully validate the original data before one caller-owned phase.
 * This frame retains no compiler result, SQL observation, principal or lease.
 * Each invocation captures afresh, even inside another active data frame. */
export async function withCapturedNativeCopyPhaseStage<T>(stage: WorkspaceOperationNativeCopyStage,
  operation: (detached: WorkspaceOperationNativeCopyStage) => T | Promise<T>): Promise<T> {
  const inherited = capturedStages.getStore();
  if (inherited) assertCapturedStagePin(inherited);
  const detached = captureNativeCopyPhaseStageRaw(stage);
  const frame: CapturedStageFrame = { stage: detached, pin: compilationPin(detached), active: true,
    failure: undefined, failed: false };
  try {
    return await capturedStages.run(frame, async () => {
      const result = await operation(detached); assertCapturedStagePin(frame); return result;
    });
  } finally { frame.active = false; frame.stage = null; frame.pin = null; }
}
function assertCompilationPin(frame: CompilationFrame): void {
  if (frame.failed) throw frame.failure;
  try { if (!frame.active || !frame.stage || compilationPin(frame.stage) !== frame.pin) copyPhaseChanged(); }
  catch (error) { frame.failed = true; frame.failure = error; throw error; }
}
/** Pure mathematical reuse within one fully awaited phase callback. This does
 * not retain SQL/current ACL/FS/receipt/final-graph observations or grant access.
 * The caller first captures its original Stage and owns all transaction bounds. */
export async function withNativeCopyPhaseCompilation<T>(stage: WorkspaceOperationNativeCopyStage,
  operation: () => T | Promise<T>): Promise<T> {
  const frame: CompilationFrame = { stage, pin: compilationPin(stage), active: true, compiled: null, failure: undefined, failed: false };
  try {
    return await compilations.run(frame, async () => {
      const result = await operation(); assertCompilationPin(frame); return result;
    });
  } finally { frame.active = false; frame.compiled = null; frame.stage = null; frame.pin = null; }
}
export function nativeCopyPhaseCompiler(stage: WorkspaceOperationNativeCopyStage): NativeMixedBatchPlan {
  const frame = compilations.getStore();
  if (frame && !frame.active) copyPhaseChanged();
  const current = frame?.stage === stage ? frame : null;
  if (current) { assertCompilationPin(current); if (current.compiled) return current.compiled; }
  const states = new Map(stage.nativeRecords.map(record => [record.state.documentId, record.state]));
  const observation = (evidence: typeof stage.plan.sourceEvidence) => ({ stage: evidence.stage,
    nativeBindings: evidence.nativeBindings, privateNativeStates: evidence.nativeBindings.map(binding =>
      states.get(binding.expected.documentId) ?? copyPhaseChanged()) });
  try {
    const compiled = assertWorkspaceOperationNativeCopyPlanCurrent(stage.plan, { sourceScope: stage.plan.sourceScope,
      destinationScope: stage.plan.destinationScope, sourceObservation: observation(stage.plan.sourceEvidence),
      destinationObservation: observation(stage.plan.destinationEvidence) });
    if (current) { assertCompilationPin(current); current.compiled = compiled; }
    return compiled;
  } catch (error) {
    if (current) { current.failed = true; current.failure = error; }
    throw error;
  }
}
export type NativeCopyPhaseStep = Readonly<{ stepKey: string; beforeFence: string; afterFence: string }>;
export const NATIVE_COPY_COMPLETION_STEP_KEY = 'copy-completion';
export function nativeCopyPhaseCompletionFence(input: Readonly<{ canonicalRequestHash: string; planId: string; stageDigest: string }>): string {
  return proof({ version: 1, kind: 'native-copy-completion', canonicalRequestHash: input.canonicalRequestHash,
    planId: input.planId, stageDigest: input.stageDigest });
}
export function nativeCopyPhaseCompletionReceipt(stage: WorkspaceOperationNativeCopyStage, receipt: NativeCopyReceipt,
  admissions: readonly CollaborationAdmissionRequest[], copyCreatedAt?: number) {
  const original = { version: 1, kind: 'native-copy-completion', canonicalRequestHash: stage.identity.canonicalRequestHash,
    planId: stage.plan.planId, stageDigest: stage.payloadSha256, nativeRequestFingerprint: receipt.requestFingerprint,
    copyReceiptProof: nativeCopyPhaseReceiptProof(receipt), admissionsProof: proof(admissions.map(request => {
      const captured = captureCollaborationAdmissionRequest(request);
      return { requestId: request.requestId, requestDigest: captured.requestDigest };
    })) } as const;
  if (stage.version === 2) return original;
  if (copyCreatedAt === undefined) copyPhaseChanged();
  return { ...original, version: 2 as const, coreV2StageDigest: stage.coreV2StageDigest,
    metadata: nativeCopyMetadataCompletionWitness(stage.metadata, copyCreatedAt) };
}
export type NativeCopyPhaseParent = NativeCopyPhaseStep & Readonly<{
  path: string; producerSelectionIndex: number; consumerSelectionIndexes: readonly number[];
}>;
export function nativeCopyPhasePathSteps(stage: WorkspaceOperationNativeCopyStage): readonly NativeCopyPhaseStep[] {
  return stage.physical.map(({ selectionIndex, original }) => ({ stepKey: `copy-path:${selectionIndex}`,
    beforeFence: preparedWorkspacePathCopyProof(original), afterFence: proof({ stage: stage.payloadSha256,
      destinationPath: original.destinationPath, payload: original.staging?.payload ?? null }) }));
}
/** Global producer/consumer map. No receipt is rewritten to impersonate another
 * original. Projection-only selections cannot produce a physical parent. */
export function nativeCopyPhaseParentSteps(stage: WorkspaceOperationNativeCopyStage): readonly NativeCopyPhaseParent[] {
  const consumers = new Map<string, number[]>();
  const producers = new Map<string, number>();
  for (const { selectionIndex, original } of stage.physical) {
    const parts = original.destinationPath.split('/').slice(0, -1);
    for (let index = original.filesystem.destinationParents.directories.length; index < parts.length; index++) {
      const parent = parts.slice(0, index + 1).join('/'), selected = consumers.get(parent) ?? [];
      selected.push(selectionIndex); consumers.set(parent, selected);
      if (original.staging && !producers.has(parent)) producers.set(parent, selectionIndex);
    }
  }
  return [...consumers].filter(([pathname]) => producers.has(pathname))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([pathname, indexes]) => {
    const producerSelectionIndex = producers.get(pathname)!;
    return Object.freeze({ stepKey: `copy-parent:${nativeCopyPhaseSha(pathname)}`, path: pathname, producerSelectionIndex,
      consumerSelectionIndexes: Object.freeze(indexes), beforeFence: stage.payloadSha256,
      afterFence: proof({ stage: stage.payloadSha256, path: pathname, producerSelectionIndex, consumerSelectionIndexes: indexes }) });
  });
}
export function nativeCopyPhaseLinkId(stage: WorkspaceOperationNativeCopyStage, documentId: string): string {
  return `copy-link:${proof({ operationId: stage.identity.operationId, stage: stage.payloadSha256, documentId })}`;
}
export function nativeCopyPhaseReceiptProof(receipt: NativeCopyReceipt): string {
  const { publicationStatus: _status, ...original } = receipt;
  return proof(original);
}
function cloneBindings(stage: WorkspaceOperationNativeCopyStage, compiled = nativeCopyPhaseCompiler(stage)) {
  const entities = new Map(compiled.finalNamespace.map(entity => [entity.entityKey, entity]));
  const sources = new Map(stage.plan.sourceEvidence.stage.namespace.map(entry => [proof({ workspaceId: entry.workspaceId, identity: entry.identity }), entry]));
  return compiled.cloneRequirements.map(requirement => {
    const entity = entities.get(requirement.entityKey), source = sources.get(requirement.sourceEntityKey);
    if (!entity || entity.binding.kind !== 'unbound-copy' || !source?.documentId
      || entity.workspaceId !== stage.identity.destinationWorkspaceId || source.path !== requirement.sourcePath) copyPhaseChanged();
    return { ...requirement, destinationPath: entity.path, sourceDocumentId: source.documentId };
  });
}
export function nativeCopyPhaseExpectedLinks(stage: WorkspaceOperationNativeCopyStage, receipt: NativeCopyReceipt) {
  const compiled = nativeCopyPhaseCompiler(stage);
  const entities = new Set(compiled.steps[0].linkIntents.map(intent => intent.entityKey));
  const requirements = new Map(cloneBindings(stage, compiled).map(requirement => [requirement.entityKey, requirement]));
  return [...entities].map(entityKey => {
    const requirement = requirements.get(entityKey) ?? copyPhaseChanged();
    const document = receipt.documents.find(document => document.clone.path === requirement.destinationPath
      && document.source.documentId === requirement.sourceDocumentId)
      ?? copyPhaseChanged();
    const mutationId = nativeCopyPhaseLinkId(stage, document.clone.documentId);
    return { stepKey: mutationId, mutationId, document, requirement };
  });
}
/** Actual requests partition disjoint selected destination roots; no scope or
 * expected document is omitted to fit the existing admission protocol. */
export function nativeCopyPhaseAdmissions(stage: WorkspaceOperationNativeCopyStage, receipt: NativeCopyReceipt): readonly CollaborationAdmissionRequest[] {
  const groups: Array<{ scopes: CollaborationAdmissionScope[]; indexes: number[]; count: number }> = [];
  for (const [index, selected] of stage.plan.selections.entries()) {
    const source = stage.plan.sourceEvidence.stage.namespace.find(entry => entry.path === selected.sourcePath) ?? copyPhaseChanged();
    const count = receipt.documents.filter(document => document.clone.path === selected.destinationPath
      || source.kind === 'directory' && document.clone.path.startsWith(selected.destinationPath + '/')).length;
    if (count > 1024) throw new NativeCopyPhaseError('NATIVE_COPY_PHASE_UNSUPPORTED');
    let group = groups.at(-1);
    if (!group || group.scopes.length === 64 || group.count + count > 1024) {
      group = { scopes: [], indexes: [], count: 0 }; groups.push(group);
    }
    group.indexes.push(index); group.count += count;
    group.scopes.push({ workspaceId: stage.plan.destinationScope.workspaceId, organizationId: stage.plan.destinationScope.organizationId,
      path: selected.destinationPath, kind: source.kind === 'directory' ? 'subtree' : 'exact' });
  }
  return groups.map((group, ordinal) => {
    const documents = receipt.documents.filter(document => group.scopes.some(scope => document.clone.path === scope.path
      || scope.kind === 'subtree' && document.clone.path.startsWith(scope.path + '/')));
    const states = new Map(stage.nativeRecords.map(record => [record.state.documentId, record.state]));
    const payload = JSON.stringify({ version: 1, kind: 'native-copy-publication', operationId: stage.identity.operationId,
      requestHash: stage.identity.canonicalRequestHash, planId: stage.plan.planId, stageDigest: stage.payloadSha256,
      copyReceiptProof: nativeCopyPhaseReceiptProof(receipt), ordinal, selectionIndexes: group.indexes });
    const hex = proof({ kind: 'native-copy-admission', operationId: stage.identity.operationId, stage: stage.payloadSha256, ordinal }).slice(0, 32);
    const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return captureCollaborationAdmissionRequest({ requestId, actorId: stage.origin.actor.actorId, action: 'copy_replace',
      actionPayloadText: payload, actionDigest: collaborationAdmissionActionDigest('copy_replace', payload), scopes: group.scopes,
      expectedDocuments: documents.map(document => {
        const original = states.get(document.source.documentId) ?? copyPhaseChanged();
        return { documentId: document.clone.documentId, workspaceId: stage.plan.destinationScope.workspaceId,
          organizationId: stage.plan.destinationScope.organizationId, path: document.clone.path, representation: original.representation,
          lifecycleGeneration: 1, schemaVersion: original.schemaVersion, status: 'active' };
      }) }).request;
  });
}
export function assertNativeCopyPhaseReceipt(stage: WorkspaceOperationNativeCopyStage, receipt: NativeCopyReceipt): void {
  if (receipt.version !== 1 || receipt.operationId !== stage.identity.operationId || receipt.workspaceId !== stage.identity.destinationWorkspaceId
    || !/^[a-f0-9]{64}$/u.test(receipt.requestFingerprint) || !['native_committed', 'published'].includes(receipt.publicationStatus)) copyPhaseChanged();
  const expected = new Map(cloneBindings(stage).map(requirement => [requirement.destinationPath, requirement]));
  if (receipt.documents.length !== expected.size || new Set(receipt.documents.map(document => document.clone.documentId)).size !== expected.size
    || new Set(receipt.documents.map(document => document.clone.lineageId)).size !== expected.size) copyPhaseChanged();
  const originals = new Map(stage.nativeRecords.map(record => [record.state.documentId, record]));
  for (const document of receipt.documents) {
    const requirement = expected.get(document.clone.path), source = originals.get(document.source.documentId);
    const binding = stage.plan.sourceEvidence.nativeBindings.find(binding => binding.expected.documentId === requirement?.sourceDocumentId);
    if (!requirement || !source || !binding || document.source.documentId !== requirement.sourceDocumentId
      || source.state.workspaceId !== stage.identity.sourceWorkspaceId || source.state.organizationId !== stage.origin.sourceScope.organizationId
      || source.lineageId !== binding.expected.lineageId || source.state.path !== requirement.sourcePath || document.version !== 1
      || document.clone.lifecycleGeneration !== 1 || document.clone.initialSequence !== 0
      || document.source.documentId === document.clone.documentId || source.lineageId === document.clone.lineageId
      || !equal(document.source, (() => { const snapshot = authoritativeNativeCollaborationSnapshot(source.state);
        return { documentId: snapshot.documentId, lifecycleGeneration: snapshot.lifecycleGeneration,
          stateProof: snapshot.version.stateProof, documentSequence: snapshot.version.documentSequence }; })())) copyPhaseChanged();
    expected.delete(document.clone.path);
  }
  if (expected.size) copyPhaseChanged();
}
export function assertNativeCopyPhaseParent(stage: WorkspaceOperationNativeCopyStage, selectionIndex: number,
  receipt: PreparedWorkspacePathCopyParentReceipt): NativeCopyPhaseParent {
  if (!receipt || Object.getPrototypeOf(receipt) !== Object.prototype
    || Object.keys(receipt).sort().join(',') !== 'identity,originalProof,relativePath,version') copyPhaseChanged();
  const identity = receipt.identity;
  if (!identity || Object.getPrototypeOf(identity) !== Object.prototype
    || Object.keys(identity).sort().join(',') !== 'birthtimeNs,ctimeNs,device,gid,inode,linkCount,mode,mtimeNs,size,uid'
    || !['device', 'inode', 'linkCount', 'size'].every(key => /^(?:0|[1-9][0-9]{0,19})$/u.test(String(Reflect.get(identity, key))))
    || identity.inode === '0' || identity.linkCount === '0' || ![identity.mode, identity.uid, identity.gid].every(Number.isSafeInteger)
    || (identity.mode & 0o170000) !== 0o040000 || (identity.mode & 0o022) !== 0
    || identity.uid !== stage.physical[selectionIndex]?.original.filesystem.destinationRoot.identity.uid
    || ![identity.birthtimeNs, identity.mtimeNs, identity.ctimeNs].every(value => /^-?(?:0|[1-9][0-9]{0,29})$/u.test(value))) copyPhaseChanged();
  const expected = nativeCopyPhaseParentSteps(stage).find(parent => parent.path === receipt.relativePath) ?? copyPhaseChanged();
  if (expected.producerSelectionIndex !== selectionIndex || receipt.version !== 1
    || receipt.originalProof !== preparedWorkspacePathCopyProof(stage.physical[selectionIndex]?.original)) copyPhaseChanged();
  return expected;
}
export function nativeCopyPhaseStepCount(stage: WorkspaceOperationNativeCopyStage): number {
  const compiled = nativeCopyPhaseCompiler(stage);
  const count = 1 + stage.physical.length + nativeCopyPhaseParentSteps(stage).length
    + new Set(compiled.steps[0].linkIntents.map(intent => intent.entityKey)).size;
  if (count < 1 || count > 10_000) throw new NativeCopyPhaseError('NATIVE_COPY_PHASE_TOO_LARGE');
  return count;
}
export const nativeCopyPhaseParentPath = (pathname: string) => path.posix.dirname(pathname);
