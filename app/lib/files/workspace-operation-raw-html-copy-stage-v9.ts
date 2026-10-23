import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal, types } from 'node:util';
import { deserializeNativeRecoveryPayload, serializeNativeRecoveryPayload,
  NATIVE_RECOVERY_PAYLOAD_LIMIT, type NativeRecoveryRecord } from '../collaboration/native-document-recovery';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import { decodePreparedWorkspacePathCopyOriginal, type PreparedPathCopyIdentity,
  type PreparedWorkspacePathCopyOriginalV3 } from '../filesystem/prepared-workspace-path-copy-contract';
import { compileWorkspaceMixedSelectedHtmlImportCopyBatchV6, type NativeMixedHtmlImportCopyBatchPlanV6 } from '../markdown/workspace-native-mixed-batch-compiler';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { decodeWorkspaceOperationManagedCopyPlanV8, type WorkspaceOperationManagedCopyPlanV8 } from './workspace-operation-managed-copy-plan-v8';
import { captureNativeCopyHtmlOriginalStates } from './workspace-operation-native-source-evidence';
import { captureNativeCopyStageIdentity, NativeCopyStageDataError,
  type WorkspaceOperationNativeCopyStageIdentity } from './workspace-operation-native-copy-stage';
import { decodeWorkspaceOperationCopyOrigin, type WorkspaceOperationCopyOrigin } from './workspace-operation-copy-origin';
import { serializeWorkspaceOperationRequest, type WorkspaceOperationRequest } from './workspace-operation-journal';
import { prepareMarkdownFileImport } from '../collaboration/markdown-file-import';
import { captureRawHtmlSourceBindingV2 } from '../markdown/workspace-raw-html-source-binding-v2';
import type { OriginalPhysicalLinkInventoryV4 } from '../markdown/workspace-physical-link-inventory';
import type { ManagedCopyRawOriginalDescriptor } from './workspace-operation-managed-copy-stage';
import { decodeNativeCopyMetadataSnapshot, nativeCopyMetadataWitness, type NativeCopyMetadataSnapshot } from './workspace-operation-native-copy-metadata';

export const RAW_HTML_COPY_STAGE_V9_MANIFEST_LIMIT = 16 * 1024 * 1024;
export type WorkspaceOperationRawHtmlCopyPhysicalV9 = Readonly<{ selectionIndex: number; original: PreparedWorkspacePathCopyOriginalV3 }>;
export type WorkspaceOperationRawHtmlCopyStageV9Input = Readonly<{
  operationId: string; request: WorkspaceOperationRequest; plan: WorkspaceOperationManagedCopyPlanV8;
  physical: readonly WorkspaceOperationRawHtmlCopyPhysicalV9[]; nativeRecords: readonly NativeRecoveryRecord[];
  metadata: NativeCopyMetadataSnapshot; rawOriginals: readonly OriginalPhysicalLinkInventoryV4[];
}>;
export type RawHtmlCopyStageManifestV9 = Readonly<{
  version: 9; kind: 'native-copy'; identity: WorkspaceOperationNativeCopyStageIdentity;
  request: WorkspaceOperationRequest; origin: WorkspaceOperationCopyOrigin; plan: WorkspaceOperationManagedCopyPlanV8;
  physical: readonly WorkspaceOperationRawHtmlCopyPhysicalV9[]; metadata: NativeCopyMetadataSnapshot;
  records: Readonly<{ file: 'native-records.bin'; sizeBytes: number; sha256: string; count: number }>;
  rawOriginals: Readonly<{ file: 'raw-originals.bin'; sizeBytes: number; sha256: string; count: number; entries: readonly ManagedCopyRawOriginalDescriptor[] }>;
  payloadSha256: string;
}>;
export type WorkspaceOperationRawHtmlCopyStageV9 = Readonly<Omit<RawHtmlCopyStageManifestV9, 'records' | 'rawOriginals'> & {
  nativeRecords: readonly NativeRecoveryRecord[]; rawOriginals: readonly OriginalPhysicalLinkInventoryV4[];
}>;
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function fail(code: NativeCopyStageDataError['code'] = 'STAGE_CONFLICT'): never { throw new NativeCopyStageDataError(code); }
function capture(value: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(value, reason => fail(reason === 'too-large' ? 'STAGE_TOO_LARGE' : 'STAGE_CONFLICT'), RAW_HTML_COPY_STAGE_V9_MANIFEST_LIMIT);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return !property?.enumerable || !Object.hasOwn(property, 'value');
    })) fail();
  return value as Record<string, unknown>;
}
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail();
  return property.value;
}
function list(value: unknown, maximum: number): unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
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
function fingerprint(identity: PreparedPathCopyIdentity): string {
  const milliseconds = (value: string) => {
    const ns = BigInt(value); return Number(ns / BigInt(1_000_000_000)) * 1000 + Number(ns % BigInt(1_000_000_000)) / 1_000_000;
  };
  return `${identity.device}:${identity.inode}:${identity.size}:${milliseconds(identity.mtimeNs)}:${milliseconds(identity.ctimeNs)}`;
}
function physicals(input: unknown, plan: WorkspaceOperationManagedCopyPlanV8): readonly WorkspaceOperationRawHtmlCopyPhysicalV9[] {
  const values = list(input, 1000);
  if (values.length !== plan.selections.length) fail();
  const namespace = new Map(plan.sourceEvidence.namespace.map(entry => [entry.path, entry]));
  return freeze(values.map((value, index) => {
    const item = object(value, ['selectionIndex', 'original']), selected = plan.selections[index];
    if (item.selectionIndex !== index) fail();
    const original = decodePreparedWorkspacePathCopyOriginal(item.original);
    if (plan.version !== 8 || original.version !== 3
      || original.sourceProjectionPolicy !== 'provider-derived-files-v3' || original.derivedFiles.length) fail();
    if (!equal(original.sourceWorkspace, plan.sourceScope) || !equal(original.destinationWorkspace, plan.destinationScope)
      || original.sourcePath !== selected.sourcePath || original.destinationPath !== selected.destinationPath) fail();
    const under = (pathname: string) => pathname === selected.sourcePath || pathname.startsWith(selected.sourcePath + '/');
    const omitted = plan.sourceEvidence.nativeComponent.nativeBindings.map(binding => binding.expected.path).filter(under).sort();
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
      // must be the actual physical entities in the original complete C2 graph.
      if (expected.documentId === null && expected.filesystemIdentity !== fingerprint(node.identity)) fail();
    }
    for (const entry of namespace.values()) if (under(entry.path) && !paths.has(entry.path)
      && entry.documentId === null && entry.filesystemIdentity !== null) fail();
    if (original.source.kind === 'projection_absent' && selectedEntry.documentId === null
      && !(selectedEntry.kind === 'directory' && selectedEntry.filesystemIdentity === null)) fail();
    return { selectionIndex: index, original: original as PreparedWorkspacePathCopyOriginalV3 };
  }));
}

/** Full original byte replay, never a fresh witness or a grant. */
export function replayRawHtmlCopyStageV9Compiler(planInput: WorkspaceOperationManagedCopyPlanV8,
  supplied: readonly NativeRecoveryRecord[]): NativeMixedHtmlImportCopyBatchPlanV6 {
  const plan = decodeWorkspaceOperationManagedCopyPlanV8(planInput);
  const records = list(supplied, 10_000).map(raw => {
    const row = object(raw, ['lineageId', 'state']);
    if (typeof row.lineageId !== 'string') fail();
    return { lineageId: row.lineageId, state: row.state as PersistedCollaborationState };
  });
  const evidence = plan.sourceScope.workspaceId === plan.destinationScope.workspaceId
    ? [plan.sourceEvidence] : [plan.sourceEvidence, plan.destinationEvidence];
  const bindings = evidence.flatMap(value => value.nativeComponent.nativeBindings);
  if (records.length !== bindings.length || new Set(records.map(record => field(record.state, 'documentId'))).size !== records.length) fail();
  const states: PersistedCollaborationState[] = [];
  for (const value of evidence) {
    const expected = new Map(value.nativeComponent.nativeBindings.map(binding => [binding.expected.documentId, binding]));
    const selected = records.filter(record => expected.has(field(record.state, 'documentId') as string));
    for (const record of selected) if (record.lineageId !== expected.get(field(record.state, 'documentId') as string)?.expected.lineageId) fail();
    states.push(...captureNativeCopyHtmlOriginalStates(value.nativeComponent, selected.map(record => record.state)).values());
  }
  const compiled = compileWorkspaceMixedSelectedHtmlImportCopyBatchV6({ sourceEvidence: plan.sourceEvidence,
    ...(plan.sourceScope.workspaceId === plan.destinationScope.workspaceId ? {} : { destinationEvidence: plan.destinationEvidence }),
    states, requests: [{ kind: 'copy', sourceWorkspaceId: plan.sourceScope.workspaceId, destinationWorkspaceId: plan.destinationScope.workspaceId,
      selections: plan.selections.map(selection => ({ ...selection })) }] });
  if (compiled.contractVersion !== 6 || compiled.issues.length || compiled.executionReady !== false
    || compiled.planId !== plan.compilerPlanProof || compiled.finalGraphProof !== plan.finalGraphProof
    || !equal(compiled.cloneRequirements, plan.cloneRequirements)) fail();
  return compiled;
}
function capturedRecords(input: unknown, plan: WorkspaceOperationManagedCopyPlanV8): readonly NativeRecoveryRecord[] {
  const rows = list(input, 10_000).map(raw => {
    const row = object(raw, ['lineageId', 'state']);
    if (typeof row.lineageId !== 'string') fail();
    return { lineageId: row.lineageId, state: row.state as PersistedCollaborationState };
  });
  // The original validator copies every binary view and validates every native
  // descriptor before structuredClone or serialization can touch raw fields.
  const states = new Map<string, PersistedCollaborationState>();
  for (const evidence of plan.sourceScope.workspaceId === plan.destinationScope.workspaceId
    ? [plan.sourceEvidence] : [plan.sourceEvidence, plan.destinationEvidence]) {
    const ids = new Set(evidence.nativeComponent.nativeBindings.map(binding => binding.expected.documentId));
    const selected = rows.filter(row => ids.has(field(row.state, 'documentId') as string));
    for (const [id, state] of captureNativeCopyHtmlOriginalStates(evidence.nativeComponent, selected.map(row => row.state))) {
      if (states.has(id)) fail(); states.set(id, state);
    }
  }
  const detached = rows.map(row => ({ lineageId: row.lineageId, state: states.get(field(row.state, 'documentId') as string) ?? fail() }));
  replayRawHtmlCopyStageV9Compiler(plan, detached); return detached;
}
const RAW_BYTES_LIMIT = 64 * 1024 * 1024;
function rawBinary(input: unknown, expected?: number): Buffer {
  if (!input || typeof input !== 'object' || types.isProxy(input) || !ArrayBuffer.isView(input)
    || ![Buffer.prototype, Uint8Array.prototype].includes(Object.getPrototypeOf(input))
    || ['buffer', 'byteOffset', 'byteLength', 'constructor'].some(key => Object.hasOwn(input, key))) fail();
  const typed = Object.getPrototypeOf(Uint8Array.prototype);
  const length = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!.call(input) as number;
  const backing = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!.call(input) as ArrayBuffer;
  if (!types.isArrayBuffer(backing) || Object.getPrototypeOf(backing) !== ArrayBuffer.prototype
    || length > RAW_BYTES_LIMIT || expected !== undefined && length !== expected) fail('STAGE_TOO_LARGE');
  const copy = Buffer.alloc(length); Uint8Array.prototype.set.call(copy, input as Uint8Array); return copy;
}
function capturedRawOriginals(input: unknown, plan: WorkspaceOperationManagedCopyPlanV8,
  physical: readonly WorkspaceOperationRawHtmlCopyPhysicalV9[]) {
  const rows = list(input, 10000); if (rows.length !== plan.rawImportRequirements.length) fail();
  const originals: OriginalPhysicalLinkInventoryV4[] = [], entries: ManagedCopyRawOriginalDescriptor[] = [], chunks: Buffer[] = [];
  let offset = 0;
  for (const [index, row] of rows.entries()) {
    const requirement = plan.rawImportRequirements[index], source4 = plan.sourceEvidence.physicalSources4.find(value => value.path === requirement.sourcePath) ?? fail();
    const sourceBinding = captureRawHtmlSourceBindingV2({ original: row as OriginalPhysicalLinkInventoryV4, source4 });
    if (!equal(sourceBinding, requirement.sourceBinding)) fail();
    const bytes = rawBinary(field(row, 'originalBytes'), requirement.physical.byteLength);
    if (offset + bytes.length > RAW_BYTES_LIMIT) fail('STAGE_TOO_LARGE');
    const prepared = prepareMarkdownFileImport(bytes, { representation: 'auto' });
    if (!equal(requirement.preparation, { version: 1, representation: prepared.representation, newlineStyle: prepared.newlineStyle,
      hasBom: prepared.hasBom, sourceHash: prepared.sourceHash, sourceBytes: prepared.sourceBytes, canonicalHash: sha(prepared.canonical) })) fail();
    const selected = physical.find(value => requirement.sourcePath === value.original.sourcePath || requirement.sourcePath.startsWith(value.original.sourcePath + '/')) ?? fail();
    const relative = requirement.sourcePath.slice(selected.original.sourcePath.length).replace(/^\//u, '');
    const node = selected.original.source.kind === 'directory' ? selected.original.source.entries.find(value => value.relativePath === relative)
      : relative === '' && selected.original.source.kind !== 'projection_absent' ? selected.original.source : undefined;
    if (!node || node.kind !== 'regular_file' || fingerprint(node.identity) !== requirement.physical.filesystemIdentity
      || node.sha256 !== requirement.physical.byteHash || node.identity.size !== String(bytes.length)
      || selected.original.destinationPath + (relative ? '/' + relative : '') !== requirement.destinationPath) fail();
    originals.push({ ...sourceBinding.original4, originalBytes: new Uint8Array(bytes) }); chunks.push(bytes);
    entries.push({ requirementKey: requirement.entityKey, sourcePath: requirement.sourcePath, physicalSourceProof: requirement.physicalSourceProof,
      filesystemIdentity: requirement.physical.filesystemIdentity, sourceHash: requirement.physical.byteHash, sourceBytes: bytes.length,
      offset, sizeBytes: bytes.length, sha256: sha(bytes) }); offset += bytes.length;
  }
  return { originals: freeze(originals), entries: freeze(entries), bytes: Buffer.concat(chunks, offset) };
}
function rawDescriptor(input: unknown): RawHtmlCopyStageManifestV9['rawOriginals'] {
  const value = object(input, ['file','sizeBytes','sha256','count','entries']), entries = list(value.entries, 10000);
  if (value.file !== 'raw-originals.bin' || value.count !== entries.length || !Number.isSafeInteger(value.sizeBytes)
    || Object.is(value.sizeBytes, -0) || Number(value.sizeBytes) < 0 || Number(value.sizeBytes) > RAW_BYTES_LIMIT
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) fail();
  let offset = 0;
  for (const raw of entries) {
    const item = object(raw, ['requirementKey','sourcePath','physicalSourceProof','filesystemIdentity','sourceHash','sourceBytes','offset','sizeBytes','sha256']);
    if (item.offset !== offset || !Number.isSafeInteger(item.sizeBytes) || Object.is(item.sizeBytes, -0)
      || Number(item.sizeBytes) < 0 || Number(item.sizeBytes) > 4 * 1024 * 1024 || item.sourceBytes !== item.sizeBytes
      || item.sha256 !== item.sourceHash || ![item.physicalSourceProof,item.sha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))) fail();
    offset += Number(item.sizeBytes); if (offset > RAW_BYTES_LIMIT) fail('STAGE_TOO_LARGE');
  }
  if (offset !== value.sizeBytes) fail(); return value as RawHtmlCopyStageManifestV9['rawOriginals'];
}
const manifestFields = ['version', 'kind', 'identity', 'request', 'origin', 'plan', 'physical', 'metadata', 'records', 'rawOriginals', 'payloadSha256'] as const;
/** Header-only bounded format gate. Full E5/records replay follows before use. */
export function assertRawHtmlCopyStageV9ManifestDigest(input: unknown): void {
  try {
    const value = object(capture(input), manifestFields), descriptor = object(value.records, ['file', 'sizeBytes', 'sha256', 'count']);
    if (value.version !== 9 || value.kind !== 'native-copy' || descriptor.file !== 'native-records.bin'
      || !Number.isSafeInteger(descriptor.sizeBytes) || Object.is(descriptor.sizeBytes, -0) || Number(descriptor.sizeBytes) < 0 || Number(descriptor.sizeBytes) > NATIVE_RECOVERY_PAYLOAD_LIMIT
      || !Number.isSafeInteger(descriptor.count) || Object.is(descriptor.count, -0) || Number(descriptor.count) < 0 || Number(descriptor.count) > 10_000
      || typeof descriptor.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(descriptor.sha256)) fail();
    captureNativeCopyStageIdentity(value.identity); nativeCopyMetadataWitness(value.metadata); rawDescriptor(value.rawOriginals);
    const { payloadSha256, ...body } = value;
    if (payloadSha256 !== proof(body)) fail();
  } catch (error) { if (error instanceof NativeCopyStageDataError && error.code === 'STAGE_TOO_LARGE') throw error; fail('CORRUPT_STAGE'); }
}
export function prepareRawHtmlCopyStageV9(input: WorkspaceOperationRawHtmlCopyStageV9Input): {
  manifest: RawHtmlCopyStageManifestV9; manifestBytes: Buffer; recordsBytes: Buffer; rawOriginalsBytes: Buffer;
} {
  try {
    const row = object(input, ['operationId', 'request', 'plan', 'physical', 'nativeRecords', 'metadata', 'rawOriginals']);
    const plan = decodeWorkspaceOperationManagedCopyPlanV8(row.plan), request = capture(row.request) as WorkspaceOperationRequest;
    if (request.kind !== 'copy' || !request.origin || !equal(request.selections, plan.selections)) fail();
    const origin = decodeWorkspaceOperationCopyOrigin(request.origin);
    if (!equal(origin.sourceScope, plan.sourceScope) || !equal(origin.destinationScope, plan.destinationScope)) fail();
    const identity = captureNativeCopyStageIdentity({ operationId: row.operationId, planId: plan.planId, kind: 'native-copy',
      sourceWorkspaceId: plan.sourceScope.workspaceId, destinationWorkspaceId: plan.destinationScope.workspaceId,
      canonicalRequestHash: serializeWorkspaceOperationRequest(request).requestHash });
    const physical = physicals(capture(row.physical), plan), metadata = decodeNativeCopyMetadataSnapshot(row.metadata, { plan, physical });
    const raw = capturedRawOriginals(row.rawOriginals, plan, physical);
    const nativeRecords = capturedRecords(row.nativeRecords, plan), recordsBytes = serializeNativeRecoveryPayload(nativeRecords);
    const body = { version: 9 as const, kind: 'native-copy' as const, identity, request, origin, plan, physical, metadata,
      records: { file: 'native-records.bin' as const, sizeBytes: recordsBytes.length, sha256: sha(recordsBytes), count: nativeRecords.length },
      rawOriginals: { file: 'raw-originals.bin' as const, sizeBytes: raw.bytes.length, sha256: sha(raw.bytes), count: raw.entries.length, entries: raw.entries } };
    const manifest = freeze({ ...body, payloadSha256: proof(body) }), manifestBytes = Buffer.from(JSON.stringify(manifest));
    if (manifestBytes.length > RAW_HTML_COPY_STAGE_V9_MANIFEST_LIMIT) fail('STAGE_TOO_LARGE');
    assertRawHtmlCopyStageV9ManifestDigest(manifest); return { manifest, manifestBytes, recordsBytes, rawOriginalsBytes: raw.bytes };
  } catch (error) { if (error instanceof NativeCopyStageDataError) throw error; fail(); }
}
export function decodeRawHtmlCopyStageV9(input: unknown, recordsBytes: Buffer, rawBytes: Buffer,
  expected: WorkspaceOperationNativeCopyStageIdentity): WorkspaceOperationRawHtmlCopyStageV9 {
  try {
    if (types.isProxy(recordsBytes) || !Buffer.isBuffer(recordsBytes)) fail('CORRUPT_STAGE');
    assertRawHtmlCopyStageV9ManifestDigest(input);
    const manifest = object(capture(input), manifestFields), descriptor = object(manifest.records, ['file', 'sizeBytes', 'sha256', 'count']);
    if (!equal(captureNativeCopyStageIdentity(expected), manifest.identity) || descriptor.sizeBytes !== recordsBytes.length
      || recordsBytes.length > NATIVE_RECOVERY_PAYLOAD_LIMIT || descriptor.sha256 !== sha(recordsBytes)) fail('CORRUPT_STAGE');
    const rawInfo = rawDescriptor(manifest.rawOriginals), rawOriginalsBytes = rawBinary(rawBytes, rawInfo.sizeBytes);
    if (rawInfo.sha256 !== sha(rawOriginalsBytes)) fail('CORRUPT_STAGE');
    const plan = decodeWorkspaceOperationManagedCopyPlanV8(manifest.plan);
    if (rawInfo.entries.length !== plan.rawImportRequirements.length) fail('CORRUPT_STAGE');
    const rawOriginals = rawInfo.entries.map((entry,index) => ({ ...plan.rawImportRequirements[index].sourceBinding.original4,
      originalBytes: new Uint8Array(rawOriginalsBytes.subarray(entry.offset, entry.offset + entry.sizeBytes)) }));
    const nativeRecords = deserializeNativeRecoveryPayload(recordsBytes);
    if (descriptor.count !== nativeRecords.length) fail('CORRUPT_STAGE');
    const rebuilt = prepareRawHtmlCopyStageV9({ operationId: expected.operationId, request: manifest.request as WorkspaceOperationRequest,
      plan: manifest.plan as WorkspaceOperationManagedCopyPlanV8, physical: manifest.physical as WorkspaceOperationRawHtmlCopyPhysicalV9[],
      nativeRecords, rawOriginals, metadata: manifest.metadata as NativeCopyMetadataSnapshot });
    if (!equal(rebuilt.manifest, manifest) || !rebuilt.rawOriginalsBytes.equals(rawOriginalsBytes)) fail('CORRUPT_STAGE');
    return freeze({ version: 9, kind: 'native-copy', identity: rebuilt.manifest.identity, request: rebuilt.manifest.request,
      origin: rebuilt.manifest.origin, plan: rebuilt.manifest.plan, physical: rebuilt.manifest.physical,
      metadata: rebuilt.manifest.metadata, nativeRecords, rawOriginals: capturedRawOriginals(rawOriginals, rebuilt.manifest.plan, rebuilt.manifest.physical).originals, payloadSha256: rebuilt.manifest.payloadSha256 });
  } catch (error) { if (error instanceof NativeCopyStageDataError && error.code === 'STAGE_TOO_LARGE') throw error; fail('CORRUPT_STAGE'); }
}
