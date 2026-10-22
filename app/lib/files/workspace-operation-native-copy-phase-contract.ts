import 'server-only';
import { prepareRawHtmlCopyStage, decodeRawHtmlCopyStage, replayRawHtmlCopyStageCompiler,
  type WorkspaceOperationRawHtmlCopyStageV8 } from './workspace-operation-raw-html-copy-stage';
import type { RawHtmlCopyNativeBindingV2 } from '../markdown/workspace-raw-html-copy-binding';
import { prepareHtmlCopyStage, decodeHtmlCopyStage, replayHtmlCopyStageCompiler } from './workspace-operation-html-copy-stage';
import { workspaceOperationMixedSourceSnapshotV5 } from './workspace-operation-mixed-source-evidence-v5';
import type { NativeMixedHtmlBatchPlanV5, NativeMixedHtmlImportCopyBatchPlanV6 } from '../markdown/workspace-native-mixed-batch-compiler';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual as equal, types } from 'node:util';
import type { NativeCopyReceipt } from '../collaboration/native-copy-persistence';
import { authoritativeNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { captureCollaborationAdmissionRequest, collaborationAdmissionActionDigest,
  type CollaborationAdmissionRequest, type CollaborationAdmissionScope } from '../collaboration/room-admission-contract';
import type { NativeMixedBatchPlan, NativeMixedReadBatchPlanV3, NativeMixedImportCopyBatchPlanV4 } from '../markdown/workspace-native-mixed-batch-compiler';
import { workspaceOperationMixedCopySourceSnapshot } from './workspace-operation-copy-source-evidence-v4';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { workspaceOperationNativePlanSnapshot, captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { assertWorkspaceOperationNativeCopyPlanCurrent } from './workspace-operation-native-copy-plan';
import { prepareNativeCopyStage, decodeNativeCopyStage } from './workspace-operation-native-copy-stage';
import { prepareManagedCopyStage, decodeManagedCopyStage, replayManagedCopyStageCompiler, prepareRawCopyStage, decodeRawCopyStage,
  type WorkspaceOperationOwnedCopyStage, type WorkspaceOperationManagedCopyStageV6 as LegacyRawStageV6 } from './workspace-operation-managed-copy-stage';
import { preparedWorkspacePathCopyProof, type PreparedWorkspacePathCopyParentReceipt } from '../filesystem/prepared-workspace-path-copy-contract';
import { nativeCopyMetadataCompletionWitness } from './workspace-operation-native-copy-metadata';
import type { ExcalidrawCopyBirthReceipt } from '../excalidraw-collaboration/copy-contract';
import { decodeNativeCopyMarkdownBirthV1, nativeCopyMarkdownBirthText, nativeCopyMarkdownImportIds,
  type NativeCopyMarkdownBirthV1 } from '../collaboration/native-copy-markdown-birth-contract';
import { nativeCopyMarkdownBirthsProof } from '../collaboration/native-copy-markdown-birth-persistence';
import { isCollaborationStateProof } from '../collaboration/state-proof';
import type { NativeLinkMutationReceipt } from '../markdown/native-link-mutation-persistence';
import { nativeRawCopyLinkMutationId } from '../markdown/workspace-native-raw-copy-link-updates';
import { nativeCopyLinkReceiptProof } from './workspace-operation-native-copy-link-receipt-proof';
import { decodeWorkspaceOperationCopyOrigin, type WorkspaceOperationCopyOrigin } from './workspace-operation-copy-origin';

type WorkspaceOperationManagedCopyStageV6 = LegacyRawStageV6 | WorkspaceOperationRawHtmlCopyStageV8;
export class NativeCopyPhaseError extends Error {
  readonly status = 409;
  constructor(readonly code: 'NATIVE_COPY_PHASE_CHANGED' | 'NATIVE_COPY_PHASE_TOO_LARGE' | 'NATIVE_COPY_PHASE_UNSUPPORTED'
    | 'NATIVE_COPY_PHASE_UNCONFIRMED' = 'NATIVE_COPY_PHASE_CHANGED', options?: ErrorOptions) {
    super(code, options); this.name = 'NativeCopyPhaseError';
  }
}
export function copyPhaseChanged(): never { throw new NativeCopyPhaseError(); }
export const nativeCopyPhaseSha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function captureNativeCopyPhaseStageRaw(stage: WorkspaceOperationOwnedCopyStage): WorkspaceOperationOwnedCopyStage {
  if (!stage || types.isProxy(stage) || Object.getPrototypeOf(stage) !== Object.prototype) copyPhaseChanged();
  const discriminator = Object.getOwnPropertyDescriptor(stage, 'version');
  if (!discriminator?.enumerable || !Object.hasOwn(discriminator, 'value') || ![2, 3, 4, 5, 6, 7, 8].includes(discriminator.value)) copyPhaseChanged();
  if (discriminator.value === 8) {
    const expected = ['version','kind','identity','request','origin','plan','physical','metadata','nativeRecords','rawOriginals','payloadSha256'];
    if (Reflect.ownKeys(stage).length !== expected.length || expected.some(key => {
      const property = Object.getOwnPropertyDescriptor(stage,key); return !property?.enumerable || !Object.hasOwn(property,'value');
    }) || stage.version !== 8) copyPhaseChanged();
    const prepared = prepareRawHtmlCopyStage({ operationId: stage.identity.operationId, request: stage.request, plan: stage.plan,
      physical: stage.physical, nativeRecords: stage.nativeRecords, rawOriginals: stage.rawOriginals, metadata: stage.metadata });
    if (stage.kind !== 'native-copy' || prepared.manifest.payloadSha256 !== stage.payloadSha256
      || !equal(stage.origin, prepared.manifest.origin) || !equal(stage.identity, prepared.manifest.identity)) copyPhaseChanged();
    return decodeRawHtmlCopyStage(prepared.manifest, prepared.recordsBytes, prepared.rawOriginalsBytes, prepared.manifest.identity);
  }
  if (discriminator.value === 7) {
    const expected = ['version', 'kind', 'identity', 'request', 'origin', 'plan', 'physical', 'metadata', 'nativeRecords', 'payloadSha256'];
    if (Reflect.ownKeys(stage).length !== expected.length || expected.some(key => {
      const property = Object.getOwnPropertyDescriptor(stage, key);
      return !property?.enumerable || !Object.hasOwn(property, 'value');
    }) || stage.version !== 7) copyPhaseChanged();
    const prepared = prepareHtmlCopyStage({ operationId: stage.identity.operationId, request: stage.request, plan: stage.plan,
      physical: stage.physical, nativeRecords: stage.nativeRecords, metadata: stage.metadata });
    if (stage.kind !== 'native-copy' || prepared.manifest.payloadSha256 !== stage.payloadSha256
      || !equal(stage.origin, prepared.manifest.origin) || !equal(stage.identity, prepared.manifest.identity)) copyPhaseChanged();
    return decodeHtmlCopyStage(prepared.manifest, prepared.recordsBytes, prepared.manifest.identity);
  }
  if (discriminator.value === 6) {
    const expected = ['version', 'kind', 'identity', 'request', 'origin', 'plan', 'physical', 'metadata',
      'nativeRecords', 'sceneRecords', 'sceneAssets', 'rawOriginals', 'payloadSha256'];
    if (Reflect.ownKeys(stage).length !== expected.length || expected.some(key => {
      const field = Object.getOwnPropertyDescriptor(stage, key);
      return !field?.enumerable || !Object.hasOwn(field, 'value');
    }) || stage.version !== 6) copyPhaseChanged();
    const prepared = prepareRawCopyStage({ operationId: stage.identity.operationId, request: stage.request, plan: stage.plan,
      physical: stage.physical, nativeRecords: stage.nativeRecords, sceneRecords: stage.sceneRecords,
      sceneAssets: stage.sceneAssets, rawOriginals: stage.rawOriginals, metadata: stage.metadata });
    if (stage.kind !== 'native-copy' || prepared.manifest.version !== 6 || prepared.manifest.payloadSha256 !== stage.payloadSha256
      || !equal(stage.origin, prepared.manifest.origin) || !equal(stage.identity, prepared.manifest.identity)) copyPhaseChanged();
    return decodeRawCopyStage(prepared.manifest, { recordsBytes: prepared.recordsBytes, sceneRecordsBytes: prepared.sceneRecordsBytes,
      sceneAssetsBytes: prepared.sceneAssetsBytes, rawOriginalsBytes: prepared.rawOriginalsBytes }, prepared.manifest.identity);
  }
  if (discriminator.value === 4 || discriminator.value === 5) {
    const expected = ['version', 'kind', 'identity', 'request', 'origin', 'plan', 'physical', 'metadata',
      'nativeRecords', 'sceneRecords', 'sceneAssets', 'payloadSha256'];
    if (Reflect.ownKeys(stage).length !== expected.length || expected.some(key => {
      const property = Object.getOwnPropertyDescriptor(stage, key);
      return !property?.enumerable || !Object.hasOwn(property, 'value');
    }) || stage.version !== 4 && stage.version !== 5) copyPhaseChanged();
    const prepared = prepareManagedCopyStage({ operationId: stage.identity.operationId, request: stage.request, plan: stage.plan,
      physical: stage.physical, nativeRecords: stage.nativeRecords, sceneRecords: stage.sceneRecords,
      sceneAssets: stage.sceneAssets, metadata: stage.metadata });
    if (stage.kind !== 'native-copy' || stage.version !== prepared.manifest.version || prepared.manifest.payloadSha256 !== stage.payloadSha256
      || !equal(stage.origin, prepared.manifest.origin) || !equal(stage.identity, prepared.manifest.identity)) copyPhaseChanged();
    return decodeManagedCopyStage(prepared.manifest, { recordsBytes: prepared.recordsBytes,
      sceneRecordsBytes: prepared.sceneRecordsBytes, sceneAssetsBytes: prepared.sceneAssetsBytes }, prepared.manifest.identity);
  }
  if (stage.version !== 2 && stage.version !== 3) copyPhaseChanged();
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
  stage: WorkspaceOperationOwnedCopyStage | null; pin: string | null; active: boolean;
  failure: unknown; failed: boolean;
};
const capturedStages = new AsyncLocalStorage<CapturedStageFrame>();
export function captureNativeCopyPhaseStage(stage: WorkspaceOperationOwnedCopyStage): WorkspaceOperationOwnedCopyStage {
  const frame = capturedStages.getStore();
  if (frame && !frame.active) copyPhaseChanged();
  if (frame?.stage === stage) { assertCapturedStagePin(frame); return stage; }
  return captureNativeCopyPhaseStageRaw(stage);
}
export function nativeCopyPhaseOriginals(stage: WorkspaceOperationOwnedCopyStage) {
  if (stage.version === 7 || stage.version === 8) return (stage.plan.sourceScope.workspaceId === stage.plan.destinationScope.workspaceId
    ? [stage.plan.sourceEvidence] : [stage.plan.sourceEvidence, stage.plan.destinationEvidence]).map(workspaceOperationMixedSourceSnapshotV5);
  if (stage.version === 5 || stage.version === 6) return (stage.plan.sourceScope.workspaceId === stage.plan.destinationScope.workspaceId
    ? [stage.plan.sourceEvidence] : [stage.plan.sourceEvidence, stage.plan.destinationEvidence]).map(workspaceOperationMixedCopySourceSnapshot);
  return (stage.plan.sourceScope.workspaceId === stage.plan.destinationScope.workspaceId
    ? [stage.plan.sourceEvidence] : [stage.plan.sourceEvidence, stage.plan.destinationEvidence])
    .map(evidence => workspaceOperationNativePlanSnapshot(evidence, copyPhaseChanged));
}
type CompilationFrame = {
  stage: WorkspaceOperationOwnedCopyStage | null; pin: string | null; active: boolean;
  compiled: NativeMixedBatchPlan | NativeMixedReadBatchPlanV3 | NativeMixedImportCopyBatchPlanV4 | NativeMixedHtmlBatchPlanV5 | NativeMixedHtmlImportCopyBatchPlanV6 | null; failure: unknown; failed: boolean;
};
const compilations = new AsyncLocalStorage<CompilationFrame>();
/** Pin every original data descriptor, including native lineage/state metadata.
 * Hash the actual binary views directly instead of JSON-expanding their bytes.
 * This is only an integrity observation of an already detached frozen Stage. */
function compilationPin(stage: WorkspaceOperationOwnedCopyStage): string {
  const hash = createHash('sha256'), parents = new Set<object>();
  let nodes = 0, metadataBytes = 0, binaryBytes = 0;
  const maximumMetadataBytes = ((stage.version === 6 || stage.version === 8) ? 448 : (stage.version === 4 || stage.version === 5) ? 384 : 64) * 1024 * 1024;
  const maximumBinaryBytes = ((stage.version === 6 || stage.version === 8) ? 242 : (stage.version === 4 || stage.version === 5) ? 178 : 128) * 1024 * 1024;
  const maximumNodes = (stage.version === 4 || stage.version === 5 || stage.version === 6 || stage.version === 8) ? maximumMetadataBytes : 1_000_000;
  const pending: string[] = [];
  let pendingBytes = 0;
  const flush = () => {
    if (pending.length) { hash.update(pending.join('')); pending.length = 0; pendingBytes = 0; }
  };
  const add = (value: string) => {
    const bytes = Buffer.byteLength(value);
    metadataBytes += bytes;
    if (metadataBytes > maximumMetadataBytes) copyPhaseChanged();
    // Each value is a whole JSON token or an ASCII marker. Keep their exact
    // UTF-8 byte order while avoiding a native Hash.update call per token.
    // Never split UTF-16 strings; an oversized token is hashed intact.
    if (pendingBytes + bytes > 64 * 1024 || pending.length >= 1024) flush();
    if (bytes > 64 * 1024) hash.update(value);
    else { pending.push(value); pendingBytes += bytes; }
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > maximumNodes || depth > 64) copyPhaseChanged();
    if (value === null || typeof value === 'boolean' || typeof value === 'string'
      || typeof value === 'number' && Number.isFinite(value)) { add(JSON.stringify(value)); return; }
    if (value instanceof Uint8Array) {
      // Native buffers remain mutable even though their enclosing data is frozen.
      // Include view length and digest, never its numeric JSON representation.
      binaryBytes += value.byteLength;
      if (binaryBytes > maximumBinaryBytes) copyPhaseChanged();
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
export async function withCapturedNativeCopyPhaseStage<T>(stage: WorkspaceOperationOwnedCopyStage,
  operation: (detached: WorkspaceOperationOwnedCopyStage) => T | Promise<T>): Promise<T> {
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
export async function withNativeCopyPhaseCompilation<T>(stage: WorkspaceOperationOwnedCopyStage,
  operation: () => T | Promise<T>): Promise<T> {
  const frame: CompilationFrame = { stage, pin: compilationPin(stage), active: true, compiled: null, failure: undefined, failed: false };
  try {
    return await compilations.run(frame, async () => {
      const result = await operation(); assertCompilationPin(frame); return result;
    });
  } finally { frame.active = false; frame.compiled = null; frame.stage = null; frame.pin = null; }
}
export function nativeCopyPhaseCompiler(stage: WorkspaceOperationOwnedCopyStage): NativeMixedBatchPlan | NativeMixedReadBatchPlanV3 | NativeMixedImportCopyBatchPlanV4 | NativeMixedHtmlBatchPlanV5 | NativeMixedHtmlImportCopyBatchPlanV6 {
  const frame = compilations.getStore();
  if (frame && !frame.active) copyPhaseChanged();
  const current = frame?.stage === stage ? frame : null;
  if (current) { assertCompilationPin(current); if (current.compiled) return current.compiled; }
  if (stage.version === 8) {
    try {
      const compiled = replayRawHtmlCopyStageCompiler(stage.plan, stage.nativeRecords);
      if (current) { assertCompilationPin(current); current.compiled = compiled; } return compiled;
    } catch (error) { if (current) { current.failed = true; current.failure = error; } throw error; }
  }
  if (stage.version === 7) {
    try {
      const compiled = replayHtmlCopyStageCompiler(stage.plan, stage.nativeRecords);
      if (current) { assertCompilationPin(current); current.compiled = compiled; }
      return compiled;
    } catch (error) { if (current) { current.failed = true; current.failure = error; } throw error; }
  }
  if (stage.version === 4 || stage.version === 5 || stage.version === 6) {
    try {
      const compiled = replayManagedCopyStageCompiler(stage.plan, stage.nativeRecords);
      if (current) { assertCompilationPin(current); current.compiled = compiled; }
      return compiled;
    } catch (error) {
      if (current) { current.failed = true; current.failure = error; }
      throw error;
    }
  }
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
export function nativeCopyPhaseCompletionReceipt(stage: WorkspaceOperationOwnedCopyStage, receipt: NativeCopyReceipt,
  admissions: readonly CollaborationAdmissionRequest[], copyCreatedAt?: number, managedReceipt?: ExcalidrawCopyBirthReceipt | null,
  rawBirths?: readonly NativeCopyMarkdownBirthV1[]) {
  const original = { version: 1, kind: 'native-copy-completion', canonicalRequestHash: stage.identity.canonicalRequestHash,
    planId: stage.plan.planId, stageDigest: stage.payloadSha256, nativeRequestFingerprint: receipt.requestFingerprint,
    copyReceiptProof: nativeCopyPhaseReceiptProof(receipt), admissionsProof: proof(admissions.map(request => {
      const captured = captureCollaborationAdmissionRequest(request);
      return { requestId: request.requestId, requestDigest: captured.requestDigest };
    })) } as const;
  if (stage.version === 2) return original;
  if (copyCreatedAt === undefined) copyPhaseChanged();
  if (stage.version === 8) {
    const births = nativeCopyPhaseRawBirths(stage, receipt, rawBirths);
    if (managedReceipt || !equal(admissions, nativeCopyPhaseAdmissions(stage,receipt,births))) copyPhaseChanged();
    return { ...original, version: 7 as const, metadata: nativeCopyMetadataCompletionWitness(stage.metadata,copyCreatedAt),
      htmlAssessmentProof: stage.plan.nativePathPlan.htmlAssessmentProof,
      rawBirthsProof: nativeCopyMarkdownBirthsProof(births), rawBirthCount: births.length };
  }
  if (stage.version === 7) return { ...original, version: 6 as const,
    metadata: nativeCopyMetadataCompletionWitness(stage.metadata, copyCreatedAt),
    htmlAssessmentProof: stage.plan.nativePathPlan.htmlAssessmentProof };
  if (stage.version === 6) {
    const births = nativeCopyPhaseRawBirths(stage, receipt, rawBirths);
    if (!managedReceipt || managedReceipt.operationId !== stage.identity.operationId || managedReceipt.stageDigest !== stage.payloadSha256
      || managedReceipt.intent.nativeRequestFingerprint !== receipt.requestFingerprint
      || managedReceipt.intent.nativeReceiptProof !== nativeCopyPhaseReceiptProof(receipt)
      || !equal(admissions, nativeCopyPhaseAdmissions(stage, receipt, births))) copyPhaseChanged();
    return { ...original, version: 5 as const, metadata: nativeCopyMetadataCompletionWitness(stage.metadata, copyCreatedAt),
      sceneIntentProof: managedReceipt.intent.intentDigest, sceneBirthProof: managedReceipt.receiptProof,
      assetReceiptProof: managedReceipt.assetReceipt.receiptProof,
      rawBirthsProof: nativeCopyMarkdownBirthsProof(births), rawBirthCount: births.length };
  }
  if (stage.version === 4 || stage.version === 5) {
    if (!managedReceipt || managedReceipt.operationId !== stage.identity.operationId || managedReceipt.stageDigest !== stage.payloadSha256
      || managedReceipt.intent.nativeRequestFingerprint !== receipt.requestFingerprint
      || managedReceipt.intent.nativeReceiptProof !== nativeCopyPhaseReceiptProof(receipt)) copyPhaseChanged();
    return { ...original, version: stage.version === 5 ? 4 as const : 3 as const, metadata: nativeCopyMetadataCompletionWitness(stage.metadata, copyCreatedAt),
      sceneIntentProof: managedReceipt.intent.intentDigest, sceneBirthProof: managedReceipt.receiptProof,
      assetReceiptProof: managedReceipt.assetReceipt.receiptProof };
  }
  return { ...original, version: 2 as const, coreV2StageDigest: stage.coreV2StageDigest,
    metadata: nativeCopyMetadataCompletionWitness(stage.metadata, copyCreatedAt) };
}
export type NativeCopyPhaseParent = NativeCopyPhaseStep & Readonly<{
  path: string; producerSelectionIndex: number; consumerSelectionIndexes: readonly number[];
}>;
export function nativeCopyPhasePathSteps(stage: WorkspaceOperationOwnedCopyStage): readonly NativeCopyPhaseStep[] {
  return stage.physical.map(({ selectionIndex, original }) => ({ stepKey: `copy-path:${selectionIndex}`,
    beforeFence: preparedWorkspacePathCopyProof(original), afterFence: proof({ stage: stage.payloadSha256,
      destinationPath: original.destinationPath, payload: original.staging?.payload ?? null }) }));
}
/** Global producer/consumer map. No receipt is rewritten to impersonate another
 * original. Projection-only selections cannot produce a physical parent. */
export function nativeCopyPhaseParentSteps(stage: WorkspaceOperationOwnedCopyStage): readonly NativeCopyPhaseParent[] {
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
export function nativeCopyPhaseLinkId(stage: WorkspaceOperationOwnedCopyStage, documentId: string): string {
  return `copy-link:${proof({ operationId: stage.identity.operationId, stage: stage.payloadSha256, documentId })}`;
}
export function nativeCopyPhaseReceiptProof(receipt: NativeCopyReceipt): string {
  const { publicationStatus: _status, ...original } = receipt;
  return proof(original);
}
function cloneBindings(stage: WorkspaceOperationOwnedCopyStage, compiled = nativeCopyPhaseCompiler(stage)) {
  const entities = new Map(compiled.finalNamespace.map(entity => [entity.entityKey, entity]));
  const sources = new Map(((stage.version === 7 || stage.version === 8) ? stage.plan.sourceEvidence.namespace : stage.plan.sourceEvidence.stage.namespace).map(entry => [proof({ workspaceId: entry.workspaceId, identity: entry.identity }), entry]));
  return compiled.cloneRequirements.map(requirement => {
    const entity = entities.get(requirement.entityKey), source = sources.get(requirement.sourceEntityKey);
    if (!entity || entity.binding.kind !== 'unbound-copy' || !source?.documentId
      || entity.workspaceId !== stage.identity.destinationWorkspaceId || source.path !== requirement.sourcePath) copyPhaseChanged();
    return { ...requirement, destinationPath: entity.path, sourceDocumentId: source.documentId };
  });
}
export function nativeCopyPhaseExpectedLinks(stage: WorkspaceOperationOwnedCopyStage, receipt: NativeCopyReceipt) {
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
export function nativeCopyPhaseAdmissions(stage: WorkspaceOperationOwnedCopyStage, receipt: NativeCopyReceipt,
  rawBirths?: readonly NativeCopyMarkdownBirthV1[]): readonly CollaborationAdmissionRequest[] {
  if (stage.version === 6 || stage.version === 8) return nativeCopyPhaseRawAdmissions(stage, receipt, nativeCopyPhaseRawBirths(stage, receipt, rawBirths));
  const groups: Array<{ scopes: CollaborationAdmissionScope[]; indexes: number[]; count: number }> = [];
  for (const [index, selected] of stage.plan.selections.entries()) {
    const source = (stage.version === 7 ? stage.plan.sourceEvidence.namespace : stage.plan.sourceEvidence.stage.namespace).find(entry => entry.path === selected.sourcePath) ?? copyPhaseChanged();
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
export function assertNativeCopyPhaseReceipt(stage: WorkspaceOperationOwnedCopyStage, receipt: NativeCopyReceipt): void {
  if (receipt.version !== 1 || receipt.operationId !== stage.identity.operationId || receipt.workspaceId !== stage.identity.destinationWorkspaceId
    || !/^[a-f0-9]{64}$/u.test(receipt.requestFingerprint) || !['native_committed', 'published'].includes(receipt.publicationStatus)) copyPhaseChanged();
  const expected = new Map(cloneBindings(stage).map(requirement => [requirement.destinationPath, requirement]));
  if (receipt.documents.length !== expected.size || new Set(receipt.documents.map(document => document.clone.documentId)).size !== expected.size
    || new Set(receipt.documents.map(document => document.clone.lineageId)).size !== expected.size) copyPhaseChanged();
  const originals = new Map(stage.nativeRecords.map(record => [record.state.documentId, record]));
  for (const document of receipt.documents) {
    const requirement = expected.get(document.clone.path), source = originals.get(document.source.documentId);
    const binding = ((stage.version === 7 || stage.version === 8) ? stage.plan.sourceEvidence.nativeComponent.nativeBindings : stage.plan.sourceEvidence.nativeBindings).find(binding => binding.expected.documentId === requirement?.sourceDocumentId);
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
export function assertNativeCopyPhaseParent(stage: WorkspaceOperationOwnedCopyStage, selectionIndex: number,
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
export function nativeCopyPhaseStepCount(stage: WorkspaceOperationOwnedCopyStage): number {
  const compiled = nativeCopyPhaseCompiler(stage);
  const count = 1 + stage.physical.length + nativeCopyPhaseParentSteps(stage).length
    + new Set(compiled.steps[0].linkIntents.map(intent => intent.entityKey)).size
    + ((stage.version === 6 || stage.version === 8) ? stage.plan.rawImportRequirements.length : 0);
  if (count < 1 || count > 10_000) throw new NativeCopyPhaseError('NATIVE_COPY_PHASE_TOO_LARGE');
  return count;
}
export const nativeCopyPhaseParentPath = (pathname: string) => path.posix.dirname(pathname);

function rawPhaseBirth(stage: WorkspaceOperationManagedCopyStageV6, input: NativeCopyMarkdownBirthV1,
  expectedIndex?: number): NativeCopyMarkdownBirthV1 {
  const birth = decodeNativeCopyMarkdownBirthV1(input), index = birth.parent.requirementIndex;
  const required = stage.plan.rawImportRequirements[index], original = stage.rawOriginals[index];
  if (!required || !original || expectedIndex !== undefined && index !== expectedIndex) copyPhaseChanged();
  const ids = nativeCopyMarkdownImportIds(stage.identity.operationId, stage.payloadSha256, index);
  const imported = birth.binding.receipt, target = imported.target, source = birth.binding.source;
  if (!equal(birth.origin, stage.origin) || birth.parent.operationId !== stage.identity.operationId
    || birth.parent.planId !== stage.plan.planId || birth.parent.stageDigest !== stage.payloadSha256
    || birth.parent.requestHash !== stage.identity.canonicalRequestHash || birth.parent.entityKey !== required.entityKey
    || birth.parent.requirementProof !== proof(required) || imported.operationId !== ids.operationId
    || source.workspaceId !== required.sourceWorkspaceId || source.organizationId !== stage.plan.sourceScope.organizationId
    || source.path !== required.sourcePath || source.physicalSourceProof !== required.physicalSourceProof
    || source.filesystemIdentity !== required.physical.filesystemIdentity || source.sourceHash !== required.physical.byteHash
    || source.sourceBytes !== required.physical.byteLength || original.physicalSourceProof !== required.physicalSourceProof
    || target.workspaceId !== required.destinationWorkspaceId || target.organizationId !== stage.plan.destinationScope.organizationId
    || target.path !== required.destinationPath || imported.sourceHash !== required.preparation.sourceHash
    || imported.sourceBytes !== required.preparation.sourceBytes || target.representation !== required.preparation.representation
    || target.newlineStyle !== required.preparation.newlineStyle || target.hasBom !== required.preparation.hasBom
    || !equal([...required.linkBindings.map(link => link.physicalLinkId)].sort(), [...birth.binding.links.map(link => link.physicalLinkId)].sort())) copyPhaseChanged();
  return birth;
}
/** Pure complete-cohort validation. The actual Owner must separately read the
 * immutable Parent/Birth/Import SQL rows on its current B; this grants nothing. */
export function nativeCopyPhaseRawBirths(stage: WorkspaceOperationManagedCopyStageV6, receipt: NativeCopyReceipt,
  input?: readonly NativeCopyMarkdownBirthV1[]): readonly NativeCopyMarkdownBirthV1[] {
  const captured = captureNativeCopyPhaseStage(stage); if (captured.version !== 6 && captured.version !== 8) copyPhaseChanged();
  assertNativeCopyPhaseReceipt(captured, receipt);
  if (!input || types.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype
    || input.length !== captured.plan.rawImportRequirements.length || input.length > 10000
    || Reflect.ownKeys(input).length !== input.length + 1) copyPhaseChanged();
  const documents = new Set(captured.nativeRecords.map(record => record.state.documentId));
  const lineages = new Set(captured.nativeRecords.map(record => record.lineageId));
  for (const document of receipt.documents) { documents.add(document.clone.documentId); lineages.add(document.clone.lineageId); }
  const destinations = new Set<string>(); let bytes = 0, xid: string | null = null;
  const births = Array.from({ length: input.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(input, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) return copyPhaseChanged();
    const birth = rawPhaseBirth(captured, field.value as NativeCopyMarkdownBirthV1, index), target = birth.binding.receipt.target;
    bytes += Buffer.byteLength(nativeCopyMarkdownBirthText(birth));
    if (bytes > 64 * 1024 * 1024 || documents.has(target.documentId) || lineages.has(target.lineageId)
      || destinations.has(target.path) || xid !== null && xid !== birth.b1TransactionId) return copyPhaseChanged();
    documents.add(target.documentId); lineages.add(target.lineageId); destinations.add(target.path); xid = birth.b1TransactionId;
    return birth;
  });
  return Object.freeze(births);
}
function nativeCopyPhaseRawAdmissions(stage: WorkspaceOperationManagedCopyStageV6, receipt: NativeCopyReceipt,
  births: readonly NativeCopyMarkdownBirthV1[]): readonly CollaborationAdmissionRequest[] {
  const states = new Map(stage.nativeRecords.map(record => [record.state.documentId, record.state]));
  const clones = receipt.documents.map(document => {
    const original = states.get(document.source.documentId) ?? copyPhaseChanged();
    return { documentId: document.clone.documentId, workspaceId: stage.plan.destinationScope.workspaceId,
      organizationId: stage.plan.destinationScope.organizationId, path: document.clone.path, representation: original.representation,
      lifecycleGeneration: 1 as const, schemaVersion: original.schemaVersion, status: 'active' as const };
  });
  const documents = [...clones, ...births.map(birth => {
    const target = birth.binding.receipt.target;
    return { documentId: target.documentId, workspaceId: target.workspaceId, organizationId: target.organizationId,
      path: target.path, representation: target.representation, lifecycleGeneration: 1 as const, schemaVersion: target.schemaVersion, status: 'active' as const };
  })];
  const groups: Array<{ scopes: CollaborationAdmissionScope[]; indexes: number[]; count: number }> = [];
  for (const [index, selected] of stage.plan.selections.entries()) {
    const source = (stage.version === 8 ? stage.plan.sourceEvidence.namespace : stage.plan.sourceEvidence.stage.namespace).find(entry => entry.path === selected.sourcePath) ?? copyPhaseChanged();
    const count = documents.filter(document => document.path === selected.destinationPath
      || source.kind === 'directory' && document.path.startsWith(`${selected.destinationPath}/`)).length;
    if (count > 1024) throw new NativeCopyPhaseError('NATIVE_COPY_PHASE_UNSUPPORTED');
    let group = groups.at(-1);
    if (!group || group.scopes.length === 64 || group.count + count > 1024) { group = { scopes: [], indexes: [], count: 0 }; groups.push(group); }
    group.indexes.push(index); group.count += count;
    group.scopes.push({ workspaceId: stage.plan.destinationScope.workspaceId, organizationId: stage.plan.destinationScope.organizationId,
      path: selected.destinationPath, kind: source.kind === 'directory' ? 'subtree' : 'exact' });
  }
  const admitted = new Set<string>(), rawBirthsProof = nativeCopyMarkdownBirthsProof(births);
  const requests = groups.map((group, ordinal) => {
    const expectedDocuments = documents.filter(document => group.scopes.some(scope => document.path === scope.path
      || scope.kind === 'subtree' && document.path.startsWith(`${scope.path}/`)));
    for (const document of expectedDocuments) {
      if (admitted.has(document.documentId)) copyPhaseChanged(); admitted.add(document.documentId);
    }
    const payload = JSON.stringify({ version: 2, kind: 'native-copy-publication', operationId: stage.identity.operationId,
      requestHash: stage.identity.canonicalRequestHash, planId: stage.plan.planId, stageDigest: stage.payloadSha256,
      copyReceiptProof: nativeCopyPhaseReceiptProof(receipt), rawBirthsProof, rawBirthCount: births.length,
      ordinal, selectionIndexes: group.indexes });
    const hex = proof({ kind: 'native-copy-admission', operationId: stage.identity.operationId, stage: stage.payloadSha256, ordinal }).slice(0, 32);
    const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return captureCollaborationAdmissionRequest({ requestId, actorId: stage.origin.actor.actorId, action: 'copy_replace',
      actionPayloadText: payload, actionDigest: collaborationAdmissionActionDigest('copy_replace', payload), scopes: group.scopes,
      expectedDocuments }).request;
  });
  if (admitted.size !== documents.length) copyPhaseChanged();
  return Object.freeze(requests);
}

export type NativeCopyPhaseRawTargetConfirmationV1 = Readonly<{
  version: 1; kind: 'native-copy-raw-target-confirmation'; operationId: string; planId: string; stageDigest: string; requestHash: string;
  requirementIndex: number; entityKey: string; birthProof: string; documentId: string; lineageId: string;
  after: Readonly<{ documentSequence: 0 | 1; stateProof: string; stateVectorSha256: string; persistedAt: number }>;
  mutationId: string | null; receiptProof: string | null;
}>;
export type NativeCopyPhaseRawTargetStepV1 = NativeCopyPhaseStep & Readonly<{ receipt: NativeCopyPhaseRawTargetConfirmationV1 }>;
function rawVector(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1398104
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return copyPhaseChanged();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > 1024 * 1024 || bytes.toString('base64') !== value) return copyPhaseChanged(); return bytes;
}
/** One compact B2 journal confirmation per Raw requirement, including the
 * unchanged outcome. All after facts come from immutable original receipts;
 * the actual current target and SQL authority remain the fixed Owner's work. */
export function nativeCopyPhaseRawTargetStep(stage: WorkspaceOperationManagedCopyStageV6, input: NativeCopyMarkdownBirthV1,
  mutation: NativeLinkMutationReceipt | null): NativeCopyPhaseRawTargetStepV1 {
  const captured = captureNativeCopyPhaseStage(stage); if (captured.version !== 6) copyPhaseChanged();
  const birth = rawPhaseBirth(captured, input);
  return nativeCopyPhaseRawTargetHistoryStep({ operationId: captured.identity.operationId, planId: captured.plan.planId,
    stageDigest: captured.payloadSha256, requestHash: captured.identity.canonicalRequestHash, origin: captured.origin }, birth, mutation);
}
export type NativeCopyPhaseRawTargetHistoryParentV1 = Readonly<{
  operationId: string; planId: string; stageDigest: string; requestHash: string; origin: WorkspaceOperationCopyOrigin;
}>;
/** Reproduce one compact confirmation solely from bounded immutable original
 * facts. The caller proves genuine Completion/Parent/Birth/Mutation history and
 * current authorization; this data-only helper grants no authority. */
export function nativeCopyPhaseRawTargetHistoryStep(inputParent: NativeCopyPhaseRawTargetHistoryParentV1,
  input: NativeCopyMarkdownBirthV1, mutation: NativeLinkMutationReceipt | null): NativeCopyPhaseRawTargetStepV1 {
  const parent = captureWorkspaceOperationNativePlanData(inputParent, copyPhaseChanged, 64 * 1024) as NativeCopyPhaseRawTargetHistoryParentV1;
  if (!parent || typeof parent !== 'object' || Array.isArray(parent)
    || Object.keys(parent).sort().join(',') !== 'operationId,origin,planId,requestHash,stageDigest') copyPhaseChanged();
  let origin: WorkspaceOperationCopyOrigin;
  try { origin = decodeWorkspaceOperationCopyOrigin(parent.origin); } catch { return copyPhaseChanged(); }
  const birth = decodeNativeCopyMarkdownBirthV1(input), target = birth.binding.receipt.target;
  if (!equal(origin, birth.origin) || birth.parent.operationId !== parent.operationId || birth.parent.planId !== parent.planId
    || birth.parent.stageDigest !== parent.stageDigest || birth.parent.requestHash !== parent.requestHash) copyPhaseChanged();
  const initialVector = rawVector(birth.binding.nativeInventory.version.stateVector);
  if (nativeCopyPhaseSha(initialVector) !== birth.binding.nativeVectorHash) copyPhaseChanged();
  let after: NativeCopyPhaseRawTargetConfirmationV1['after'] = { documentSequence: 0, stateProof: target.initialStateProof,
    stateVectorSha256: birth.binding.nativeVectorHash, persistedAt: target.persistedAt };
  let mutationId: string | null = null, receiptProof: string | null = null;
  if (mutation !== null) {
    if (!mutation || types.isProxy(mutation) || Object.getPrototypeOf(mutation) !== Object.prototype
      || Reflect.ownKeys(mutation).length !== 8) copyPhaseChanged();
    const keys = ['contractVersion', 'operationId', 'source', 'binding', 'before', 'after', 'afterStateSnapshot', 'inverseRecipes'];
    const fields = Object.fromEntries(keys.map(key => {
      const field = Object.getOwnPropertyDescriptor(mutation, key);
      if (!field?.enumerable || !Object.hasOwn(field, 'value')) return copyPhaseChanged(); return [key, field.value];
    }));
    const snapshot = fields.afterStateSnapshot;
    const typed = Object.getPrototypeOf(Uint8Array.prototype);
    const getLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!, getBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
    if (!snapshot || typeof snapshot !== 'object' || types.isProxy(snapshot) || !ArrayBuffer.isView(snapshot)
      || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(snapshot))
      || Object.getPrototypeOf(getBuffer.call(snapshot)) !== ArrayBuffer.prototype) copyPhaseChanged();
    const size = getLength.call(snapshot) as number;
    if (size < 1 || size > 4 * 1024 * 1024) copyPhaseChanged();
    const copied = Buffer.alloc(size); Uint8Array.prototype.set.call(copied, snapshot as Uint8Array);
    const { afterStateSnapshot: _binary, ...header } = fields;
    const facts = captureWorkspaceOperationNativePlanData(header, copyPhaseChanged, 8 * 1024 * 1024) as Omit<NativeLinkMutationReceipt, 'afterStateSnapshot'>;
    if (!facts.source || !facts.binding || !facts.before || !facts.after
      || [facts.source, facts.binding, facts.before, facts.after].some(value => typeof value !== 'object'
        || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
      || Object.keys(facts.binding).sort().join(',') !== 'actorId,actorSessionId,actorType,actorUserId,authorizedPreparedProof,requestHash,requestId'
      || Object.keys(facts.before).sort().join(',') !== 'documentSequence,stateProof,stateVector'
      || Object.keys(facts.after).sort().join(',') !== 'documentSequence,persistedAt,stateProof,stateVector'
      || !Array.isArray(facts.inverseRecipes) || !facts.inverseRecipes.length
      || Buffer.byteLength(JSON.stringify(facts.inverseRecipes)) > 4 * 1024 * 1024) copyPhaseChanged();
    mutationId = nativeRawCopyLinkMutationId({ operationId: parent.operationId, stageDigest: parent.stageDigest,
      entityKey: birth.parent.entityKey });
    if (facts.contractVersion !== 2 || facts.operationId !== mutationId || !equal(facts.source, birth.binding.nativeInventory.document)
      || facts.before.documentSequence !== 0 || facts.before.stateProof !== target.initialStateProof
      || facts.before.stateVector !== birth.binding.nativeInventory.version.stateVector
      || facts.after.documentSequence !== 1 || !isCollaborationStateProof(facts.after.stateProof)
      || `yjs-snapshot-sha256-v1:${nativeCopyPhaseSha(copied)}` !== facts.after.stateProof
      || !Number.isSafeInteger(facts.after.persistedAt) || facts.after.persistedAt < target.persistedAt
      || facts.binding.actorUserId !== origin.actor.userId || facts.binding.actorId !== origin.actor.actorId
      || facts.binding.actorType !== origin.actor.type || facts.binding.actorSessionId !== origin.actor.sessionId
      || facts.binding.requestId !== mutationId || facts.binding.requestHash !== parent.requestHash
      || !/^[a-f0-9]{64}$/u.test(facts.binding.authorizedPreparedProof) || !Array.isArray(facts.inverseRecipes)) copyPhaseChanged();
    const receipt: NativeLinkMutationReceipt = { ...facts, afterStateSnapshot: copied };
    receiptProof = nativeCopyLinkReceiptProof(receipt);
    after = { documentSequence: 1, stateProof: facts.after.stateProof, stateVectorSha256: nativeCopyPhaseSha(rawVector(facts.after.stateVector)),
      persistedAt: facts.after.persistedAt };
  }
  const receipt: NativeCopyPhaseRawTargetConfirmationV1 = Object.freeze({ version: 1, kind: 'native-copy-raw-target-confirmation',
    operationId: parent.operationId, planId: parent.planId, stageDigest: parent.stageDigest,
    requestHash: parent.requestHash, requirementIndex: birth.parent.requirementIndex,
    entityKey: birth.parent.entityKey, birthProof: birth.birthProof, documentId: target.documentId, lineageId: target.lineageId,
    after: Object.freeze(after), mutationId, receiptProof });
  const stepKey = `copy-raw-target:${proof({ version: 1, operationId: parent.operationId, stageDigest: parent.stageDigest,
    entityKey: birth.parent.entityKey })}`;
  const beforeFence = proof({ version: 1, kind: 'native-copy-raw-target-before', operationId: parent.operationId,
    planId: parent.planId, stageDigest: parent.stageDigest, requestHash: parent.requestHash,
    requirementIndex: birth.parent.requirementIndex, entityKey: birth.parent.entityKey, requirementProof: birth.parent.requirementProof,
    birthProof: birth.birthProof, documentId: target.documentId, lineageId: target.lineageId });
  return Object.freeze({ stepKey, beforeFence, afterFence: proof(receipt), receipt });
}

/** Stage8 keeps a compact exact actual4 initial-byte certificate. The caller
 * derives it from the immutable real import snapshot, never a current target. */
export type NativeCopyPhaseRawTargetStepV2 = NativeCopyPhaseStep & Readonly<{ receipt: Omit<NativeCopyPhaseRawTargetConfirmationV1,'version'> &
  Readonly<{ version:2; ordinaryBinding:RawHtmlCopyNativeBindingV2 }> }>;
export function nativeCopyPhaseRawHtmlTargetHistoryStep(parent: NativeCopyPhaseRawTargetHistoryParentV1,
  input: NativeCopyMarkdownBirthV1, mutation:NativeLinkMutationReceipt|null, certificate:RawHtmlCopyNativeBindingV2):NativeCopyPhaseRawTargetStepV2 {
  const original=nativeCopyPhaseRawTargetHistoryStep(parent,input,mutation);
  const captured=captureWorkspaceOperationNativePlanData(certificate,copyPhaseChanged,4096) as RawHtmlCopyNativeBindingV2;
  const {bindingProof,...body}=captured;
  if (Reflect.ownKeys(captured).length!==4 || captured.version!==2 || captured.birthProof!==input.birthProof
    || !/^[a-f0-9]{64}$/u.test(captured.inventory4Proof) || proof(body)!==bindingProof) copyPhaseChanged();
  const receipt=Object.freeze({...original.receipt,version:2 as const,ordinaryBinding:Object.freeze(captured)});
  return Object.freeze({...original,receipt,afterFence:proof(receipt)});
}
