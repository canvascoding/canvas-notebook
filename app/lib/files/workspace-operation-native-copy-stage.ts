import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { deserializeNativeRecoveryPayload, serializeNativeRecoveryPayload,
  type NativeRecoveryRecord } from '../collaboration/native-document-recovery';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { PreparedWorkspacePathCopyOriginal, PreparedPathCopyIdentity } from '../filesystem/prepared-workspace-path-copy-contract';
import { decodePreparedWorkspacePathCopyOriginal } from '../filesystem/prepared-workspace-path-copy-contract';
import { decodeWorkspaceOperationNativeCopyPlan, assertWorkspaceOperationNativeCopyPlanCurrent,
  type WorkspaceOperationNativeCopyPlan } from './workspace-operation-native-copy-plan';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { decodeWorkspaceOperationCopyOrigin, type WorkspaceOperationCopyOrigin } from './workspace-operation-copy-origin';
import { serializeWorkspaceOperationRequest, type WorkspaceOperationRequest } from './workspace-operation-journal';
import type { WorkspaceOperationStageIdentity } from './workspace-operation-staging';

export type WorkspaceOperationNativeCopyStageIdentity = Readonly<WorkspaceOperationStageIdentity & {
  kind: 'native-copy'; canonicalRequestHash: string;
}>;
export type WorkspaceOperationNativeCopyPhysical = Readonly<{ selectionIndex: number; original: PreparedWorkspacePathCopyOriginal }>;
export type WorkspaceOperationNativeCopyStageInput = Readonly<{
  operationId: string; request: WorkspaceOperationRequest; plan: WorkspaceOperationNativeCopyPlan;
  physical: readonly WorkspaceOperationNativeCopyPhysical[]; nativeRecords: readonly NativeRecoveryRecord[];
}>;
export type WorkspaceOperationNativeCopyStage = Readonly<{
  version: 2; kind: 'native-copy'; identity: WorkspaceOperationNativeCopyStageIdentity;
  request: WorkspaceOperationRequest; origin: WorkspaceOperationCopyOrigin; plan: WorkspaceOperationNativeCopyPlan;
  physical: readonly WorkspaceOperationNativeCopyPhysical[]; nativeRecords: readonly NativeRecoveryRecord[]; payloadSha256: string;
}>;
export type NativeCopyStageManifest = Readonly<{
  version: 2; kind: 'native-copy'; identity: WorkspaceOperationNativeCopyStageIdentity;
  request: WorkspaceOperationRequest; origin: WorkspaceOperationCopyOrigin; plan: WorkspaceOperationNativeCopyPlan;
  physical: readonly WorkspaceOperationNativeCopyPhysical[];
  records: Readonly<{ file: 'native-records.bin'; sizeBytes: number; sha256: string; count: number }>;
  payloadSha256: string;
}>;
export class NativeCopyStageDataError extends Error {
  constructor(readonly code: 'CORRUPT_STAGE' | 'STAGE_CONFLICT' | 'STAGE_TOO_LARGE') {
    super(code); this.name = 'NativeCopyStageDataError';
  }
}
export const NATIVE_COPY_STAGE_MANIFEST_LIMIT = 16 * 1024 * 1024;
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function fail(code: NativeCopyStageDataError['code'] = 'STAGE_CONFLICT'): never { throw new NativeCopyStageDataError(code); }
function capture(value: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(value, reason => fail(reason === 'too-large' ? 'STAGE_TOO_LARGE' : 'STAGE_CONFLICT'));
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return !property?.enumerable || !Object.hasOwn(property, 'value');
    })) fail();
  return value as Record<string, unknown>;
}
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail();
  return property.value;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) fail();
  return Array.from({ length: value.length }, (_, index) => {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail(); return property.value;
  });
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    for (const item of Object.values(value)) freeze(item); Object.freeze(value);
  }
  return value;
}
export function captureNativeCopyStageIdentity(input: unknown): WorkspaceOperationNativeCopyStageIdentity {
  const value = object(capture(input), ['operationId', 'planId', 'sourceWorkspaceId', 'destinationWorkspaceId', 'kind', 'canonicalRequestHash']);
  if (value.kind !== 'native-copy' || typeof value.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u.test(value.operationId)
    || ![value.planId, value.canonicalRequestHash].every(item => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item))
    || ![value.sourceWorkspaceId, value.destinationWorkspaceId].every(item => typeof item === 'string' && item.length > 0 && item.length <= 256)) fail();
  return freeze(value as WorkspaceOperationNativeCopyStageIdentity);
}
function fingerprint(identity: PreparedPathCopyIdentity): string {
  const milliseconds = (value: string) => {
    const ns = BigInt(value); return Number(ns / BigInt(1_000_000_000)) * 1000 + Number(ns % BigInt(1_000_000_000)) / 1_000_000;
  };
  return `${identity.device}:${identity.inode}:${identity.size}:${milliseconds(identity.mtimeNs)}:${milliseconds(identity.ctimeNs)}`;
}
function physicals(input: unknown, plan: WorkspaceOperationNativeCopyPlan): readonly WorkspaceOperationNativeCopyPhysical[] {
  const values = list(input, 1000);
  if (values.length !== plan.selections.length) fail();
  const namespace = new Map(plan.sourceEvidence.stage.namespace.map(entry => [entry.path, entry]));
  return freeze(values.map((value, index) => {
    const item = object(value, ['selectionIndex', 'original']), selected = plan.selections[index];
    if (item.selectionIndex !== index) fail();
    const original = decodePreparedWorkspacePathCopyOriginal(item.original);
    if (!equal(original.sourceWorkspace, plan.sourceScope) || !equal(original.destinationWorkspace, plan.destinationScope)
      || original.sourcePath !== selected.sourcePath || original.destinationPath !== selected.destinationPath) fail();
    const under = (pathname: string) => pathname === selected.sourcePath || pathname.startsWith(selected.sourcePath + '/');
    const omitted = plan.sourceEvidence.nativeBindings.map(binding => binding.expected.path).filter(under).sort();
    if (!equal(original.projectionPaths, omitted)) fail();
    const selectedEntry = namespace.get(selected.sourcePath);
    if (!selectedEntry) fail();
    const observed = original.source.kind === 'directory' ? original.source.entries
      : original.source.kind === 'projection_absent' ? [] : [{ relativePath: '', ...original.source }];
    const paths = new Set<string>();
    for (const node of observed) {
      const pathname = node.relativePath ? selected.sourcePath + '/' + node.relativePath : selected.sourcePath;
      const expected = namespace.get(pathname); paths.add(pathname);
      if (!expected || expected.kind !== (node.kind === 'directory' ? 'directory' : 'file')
        || (node.kind === 'projection_file') !== (expected.documentId !== null)) fail();
      // Native projections are replaceable checkpoints, while assets/directories
      // must be the actual physical entities in the original complete C1 graph.
      if (expected.documentId === null && expected.filesystemIdentity !== fingerprint(node.identity)) fail();
    }
    for (const entry of namespace.values()) if (under(entry.path) && !paths.has(entry.path)
      && entry.documentId === null && entry.filesystemIdentity !== null) fail();
    if (original.source.kind === 'projection_absent' && selectedEntry.documentId === null
      && !(selectedEntry.kind === 'directory' && selectedEntry.filesystemIdentity === null)) fail();
    return { selectionIndex: index, original };
  }));
}
function replay(plan: WorkspaceOperationNativeCopyPlan, records: readonly NativeRecoveryRecord[]): void {
  const evidences = plan.sourceScope.workspaceId === plan.destinationScope.workspaceId
    ? [plan.sourceEvidence] : [plan.sourceEvidence, plan.destinationEvidence];
  const expected = new Map(evidences.flatMap(evidence => evidence.nativeBindings.map(binding => [binding.expected.documentId, binding] as const)));
  if (records.length !== expected.size) fail();
  const states = new Map<string, PersistedCollaborationState>();
  for (const record of records) {
    const binding = expected.get(record.state.documentId);
    if (!binding || states.has(record.state.documentId) || record.lineageId !== binding.expected.lineageId) fail();
    states.set(record.state.documentId, record.state);
  }
  const observation = (evidence: typeof plan.sourceEvidence): WorkspaceLinkSourceAuthorityObservation => ({
    stage: evidence.stage, nativeBindings: evidence.nativeBindings,
    privateNativeStates: evidence.nativeBindings.map(binding => states.get(binding.expected.documentId)!),
  });
  assertWorkspaceOperationNativeCopyPlanCurrent(plan, { sourceScope: plan.sourceScope, destinationScope: plan.destinationScope,
    sourceObservation: observation(plan.sourceEvidence), destinationObservation: observation(plan.destinationEvidence) });
}
function captureRecords(input: unknown, plan: WorkspaceOperationNativeCopyPlan): Buffer {
  const raw = list(input, 10_000).map(value => {
    const item = object(value, ['lineageId', 'state']);
    if (typeof item.lineageId !== 'string') fail();
    const state = item.state as PersistedCollaborationState;
    // Read only explicit data descriptors before the shared evidence validator
    // captures every remaining primitive, metadata object and typed-array byte.
    for (const key of ['documentId', 'workspaceId']) if (typeof field(state, key) !== 'string') fail();
    return { lineageId: item.lineageId, state };
  });
  // The original compiler/evidence validators reject getters, unexpected state
  // fields, duplicate/missing records and binary budgets before codec accesses.
  const detachedHeader = raw.map(record => ({ lineageId: record.lineageId, state: record.state }));
  replay(plan, detachedHeader);
  return serializeNativeRecoveryPayload(detachedHeader);
}
export function prepareNativeCopyStage(input: WorkspaceOperationNativeCopyStageInput): { manifest: NativeCopyStageManifest; manifestBytes: Buffer; recordsBytes: Buffer } {
  try {
    const fields = object(input, ['operationId', 'request', 'plan', 'physical', 'nativeRecords']);
    const plan = decodeWorkspaceOperationNativeCopyPlan(fields.plan);
    const request = capture(fields.request) as WorkspaceOperationRequest;
    if (request.kind !== 'copy' || !request.origin || !equal(request.selections, plan.selections)) fail();
    const origin = decodeWorkspaceOperationCopyOrigin(request.origin);
    if (!equal(origin.sourceScope, plan.sourceScope) || !equal(origin.destinationScope, plan.destinationScope)) fail();
    const { requestHash } = serializeWorkspaceOperationRequest(request);
    const identity = captureNativeCopyStageIdentity({ operationId: fields.operationId, planId: plan.planId,
      sourceWorkspaceId: plan.sourceScope.workspaceId, destinationWorkspaceId: plan.destinationScope.workspaceId,
      kind: 'native-copy', canonicalRequestHash: requestHash });
    const physical = physicals(capture(fields.physical), plan), recordsBytes = captureRecords(fields.nativeRecords, plan);
    const records = { file: 'native-records.bin' as const, sizeBytes: recordsBytes.length, sha256: sha(recordsBytes), count: list(fields.nativeRecords, 10_000).length };
    const body = { version: 2 as const, kind: 'native-copy' as const, identity, request, origin, plan, physical, records };
    const manifest = freeze({ ...body, payloadSha256: sha(JSON.stringify(body)) }), manifestBytes = Buffer.from(JSON.stringify(manifest));
    if (manifestBytes.length > NATIVE_COPY_STAGE_MANIFEST_LIMIT) fail('STAGE_TOO_LARGE');
    return { manifest, manifestBytes, recordsBytes };
  } catch (error) { if (error instanceof NativeCopyStageDataError) throw error; return fail(); }
}
export function decodeNativeCopyStage(manifestInput: unknown, bytes: Buffer,
  expected: WorkspaceOperationNativeCopyStageIdentity): WorkspaceOperationNativeCopyStage {
  try {
    const manifest = object(capture(manifestInput), ['version', 'kind', 'identity', 'request', 'origin', 'plan', 'physical', 'records', 'payloadSha256']);
    const recordInfo = object(manifest.records, ['file', 'sizeBytes', 'sha256', 'count']);
    if (manifest.version !== 2 || manifest.kind !== 'native-copy' || !equal(captureNativeCopyStageIdentity(manifest.identity), expected)
      || recordInfo.file !== 'native-records.bin' || recordInfo.sizeBytes !== bytes.length || recordInfo.sha256 !== sha(bytes)) fail('CORRUPT_STAGE');
    const nativeRecords = deserializeNativeRecoveryPayload(bytes);
    if (recordInfo.count !== nativeRecords.length) fail('CORRUPT_STAGE');
    const rebuilt = prepareNativeCopyStage({ operationId: expected.operationId, request: manifest.request as WorkspaceOperationRequest,
      plan: manifest.plan as WorkspaceOperationNativeCopyPlan, physical: manifest.physical as WorkspaceOperationNativeCopyPhysical[], nativeRecords });
    if (!equal(rebuilt.manifest, manifest)) fail('CORRUPT_STAGE');
    return freeze({ version: 2 as const, kind: 'native-copy' as const, identity: expected, request: rebuilt.manifest.request,
      origin: rebuilt.manifest.origin, plan: rebuilt.manifest.plan, physical: rebuilt.manifest.physical,
      nativeRecords, payloadSha256: rebuilt.manifest.payloadSha256 });
  } catch (error) { if (error instanceof NativeCopyStageDataError && error.code === 'STAGE_TOO_LARGE') throw error; return fail('CORRUPT_STAGE'); }
}
