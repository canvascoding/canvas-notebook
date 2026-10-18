import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal, types } from 'node:util';
import { deserializeNativeRecoveryPayload, serializeNativeRecoveryPayload,
  NATIVE_RECOVERY_PAYLOAD_LIMIT, type NativeRecoveryRecord } from '../collaboration/native-document-recovery';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import { captureWorkspaceSceneSnapshot, captureWorkspaceSceneSnapshotHeader,
  type WorkspaceSceneSnapshotRecord } from '../excalidraw-collaboration/workspace-scene-snapshot';
import { captureExcalidrawReadonlyAssetMetadata, type ExcalidrawReadonlyAssetRecord } from '../excalidraw-collaboration/readonly-assets';
import { serializePortableExcalidrawSceneFromReadonlyAssets } from '../excalidraw-collaboration/portable-serialization';
import type { ExcalidrawAssetMetadata } from '../excalidraw-collaboration/protocol';
import { decodePreparedWorkspacePathCopyOriginal, type PreparedPathCopyIdentity,
  type PreparedWorkspacePathCopyOriginalV2, type PreparedWorkspacePathCopyOriginalV3 } from '../filesystem/prepared-workspace-path-copy-contract';
import { compileWorkspaceNativeMixedBatch } from '../markdown/workspace-native-mixed-batch-compiler';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { assertWorkspaceOperationNativeSourceEvidenceCurrent } from './workspace-operation-native-source-evidence';
import { captureWorkspaceOperationNativePlanData, workspaceOperationNativePlanSnapshot } from './workspace-operation-native-plan-data';
import { decodeWorkspaceOperationManagedCopyPlan, type WorkspaceOperationManagedCopyPlan } from './workspace-operation-managed-copy-plan';
import { decodeWorkspaceOperationCopyOrigin, type WorkspaceOperationCopyOrigin } from './workspace-operation-copy-origin';
import { serializeWorkspaceOperationRequest, type WorkspaceOperationRequest } from './workspace-operation-journal';
import { decodeNativeCopyMetadataSnapshot, type NativeCopyMetadataSnapshot } from './workspace-operation-native-copy-metadata';
import { captureNativeCopyStageIdentity, NativeCopyStageDataError, NATIVE_COPY_STAGE_MANIFEST_LIMIT,
  type WorkspaceOperationNativeCopyStageIdentity } from './workspace-operation-native-copy-stage';

export const MANAGED_COPY_SCENE_RECORDS_LIMIT = 128 * 1024 * 1024;
export const MANAGED_COPY_SCENE_ASSETS_LIMIT = 50 * 1024 * 1024;
const DERIVED_BYTES_LIMIT = 128 * 1024 * 1024;
const MAX_ASSETS = 2_000;
export type WorkspaceOperationManagedCopyStageIdentity = WorkspaceOperationNativeCopyStageIdentity;
export type WorkspaceOperationManagedCopyPhysical = Readonly<{
  selectionIndex: number; original: PreparedWorkspacePathCopyOriginalV2 | PreparedWorkspacePathCopyOriginalV3;
}>;
export type WorkspaceOperationManagedCopyAsset = Readonly<{ workspaceId: string; asset: ExcalidrawReadonlyAssetRecord }>;
export type WorkspaceOperationManagedCopyStageInput = Readonly<{
  operationId: string; request: WorkspaceOperationRequest; plan: WorkspaceOperationManagedCopyPlan;
  physical: readonly WorkspaceOperationManagedCopyPhysical[]; nativeRecords: readonly NativeRecoveryRecord[];
  sceneRecords: readonly WorkspaceSceneSnapshotRecord[]; sceneAssets: readonly WorkspaceOperationManagedCopyAsset[];
  metadata: NativeCopyMetadataSnapshot;
}>;
type PayloadDescriptor<File extends string> = Readonly<{ file: File; sizeBytes: number; sha256: string; count: number }>;
export type ManagedCopySceneAssetDescriptor = Readonly<{
  workspaceId: string; metadata: Readonly<ExcalidrawAssetMetadata>;
  sourceStorageIdentity: Readonly<{ dev: string; ino: string; sizeBytes: number }>;
  offset: number; sizeBytes: number; sha256: string; metadataProof: string;
}>;
export type ManagedCopyStageManifestV4 = Readonly<{
  version: 4; kind: 'native-copy'; identity: WorkspaceOperationManagedCopyStageIdentity;
  request: WorkspaceOperationRequest; origin: WorkspaceOperationCopyOrigin; plan: WorkspaceOperationManagedCopyPlan;
  physical: readonly WorkspaceOperationManagedCopyPhysical[]; metadata: NativeCopyMetadataSnapshot;
  records: PayloadDescriptor<'native-records.bin'>; sceneRecords: PayloadDescriptor<'scene-records.json'>;
  sceneAssets: PayloadDescriptor<'scene-assets.bin'> & Readonly<{ entries: readonly ManagedCopySceneAssetDescriptor[] }>;
  payloadSha256: string;
}>;
export type WorkspaceOperationManagedCopyStageV4 = Readonly<Omit<ManagedCopyStageManifestV4, 'records' | 'sceneRecords' | 'sceneAssets'> & {
  nativeRecords: readonly NativeRecoveryRecord[]; sceneRecords: readonly WorkspaceSceneSnapshotRecord[];
  sceneAssets: readonly WorkspaceOperationManagedCopyAsset[];
}>;
export type ManagedCopyStagePayloads = Readonly<{ recordsBytes: Buffer; sceneRecordsBytes: Buffer; sceneAssetsBytes: Buffer }>;
const fail = (code: NativeCopyStageDataError['code'] = 'STAGE_CONFLICT'): never => { throw new NativeCopyStageDataError(code); };
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum;
const key = (workspaceId: string, fileId: string) => JSON.stringify([workspaceId, fileId]);
function capture(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, reason => fail(reason === 'too-large' ? 'STAGE_TOO_LARGE' : 'STAGE_CONFLICT'));
}
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length) return fail();
  for (const name of keys) field(input, name); return input as Record<string, unknown>;
}
function field(input: unknown, name: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return fail();
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return fail(); return descriptor.value;
}
function list(input: unknown, maximum: number): unknown[] {
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype) return fail();
  if (input.length > maximum) return fail('STAGE_TOO_LARGE');
  if (Reflect.ownKeys(input).length !== input.length + 1) return fail();
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return fail(); return descriptor.value;
  });
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, (_name, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry));
}
function guarded<T>(operation: () => T, decoding = false): T {
  try { return operation(); } catch (error) {
    if (error instanceof NativeCopyStageDataError) {
      if (error.code === 'STAGE_TOO_LARGE' || !decoding) throw error; return fail('CORRUPT_STAGE');
    }
    const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
    const status = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'status')?.value : undefined;
    if (status === 413 || typeof code === 'string' && /(?:TOO_LARGE|BUDGET_EXCEEDED)$/u.test(code)) return fail('STAGE_TOO_LARGE');
    return fail(decoding ? 'CORRUPT_STAGE' : 'STAGE_CONFLICT');
  }
}
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!;
const arrayBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!;
function binary(input: unknown, maximum: number, expected?: number): Buffer {
  if (!input || typeof input !== 'object' || types.isProxy(input) || !ArrayBuffer.isView(input)
    || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(input))
    || ['byteLength', 'byteOffset', 'buffer', 'constructor'].some(name => Object.hasOwn(input, name))) return fail();
  const length = byteLength.call(input) as number;
  if (!integer(length) || length > maximum) return fail('STAGE_TOO_LARGE');
  if (expected !== undefined && length !== expected || Object.getPrototypeOf(arrayBuffer.call(input)) !== ArrayBuffer.prototype) return fail();
  const copy = Buffer.alloc(length); Uint8Array.prototype.set.call(copy, input as Uint8Array); return copy;
}
function evidences(plan: WorkspaceOperationManagedCopyPlan) {
  return plan.sourceScope.workspaceId === plan.destinationScope.workspaceId ? [plan.sourceEvidence] : [plan.sourceEvidence, plan.destinationEvidence];
}

/** Historical raw equality, never an assertion of current SQL/principal facts. */
function replay(plan: WorkspaceOperationManagedCopyPlan, records: readonly NativeRecoveryRecord[]): void {
  const components = evidences(plan), expected = new Map(components.flatMap(evidence => evidence.nativeBindings
    .map(binding => [binding.expected.documentId, binding] as const)));
  if (records.length !== expected.size) return fail();
  const states = new Map<string, PersistedCollaborationState>();
  for (const record of records) {
    const documentId = field(record.state, 'documentId'), binding = typeof documentId === 'string' ? expected.get(documentId) : undefined;
    if (!binding || states.has(binding.expected.documentId) || record.lineageId !== binding.expected.lineageId) return fail();
    states.set(binding.expected.documentId, record.state);
  }
  for (const evidence of components) {
    const component = evidence.nativeComponent;
    assertWorkspaceOperationNativeSourceEvidenceCurrent(component, { stage: component.stage, nativeBindings: component.nativeBindings,
      privateNativeStates: component.nativeBindings.map(binding => states.get(binding.expected.documentId)!) }, component.workspaceScope);
  }
  const compiled = compileWorkspaceNativeMixedBatch({ snapshots: components.map(evidence => workspaceOperationNativePlanSnapshot(evidence, fail)),
    requests: [{ kind: 'copy', sourceWorkspaceId: plan.sourceScope.workspaceId, destinationWorkspaceId: plan.destinationScope.workspaceId,
      selections: plan.selections.map(selection => ({ ...selection })) }], states: [...states.values()] });
  if (compiled.issues.length || compiled.executionReady !== false || compiled.planId !== plan.compilerPlanProof
    || compiled.finalGraphProof !== plan.finalGraphProof || !equal(compiled.cloneRequirements, plan.cloneRequirements)) return fail();
}
function nativeBytes(input: unknown, plan: WorkspaceOperationManagedCopyPlan): Buffer {
  const records = list(input, 10_000).map(raw => {
    const value = object(raw, ['lineageId', 'state']);
    if (typeof value.lineageId !== 'string') return fail();
    return { lineageId: value.lineageId, state: value.state as PersistedCollaborationState };
  });
  // Shared native validation inspects every descriptor and copies typed bytes
  // before the recovery codec may inspect caller fields or binary containers.
  replay(plan, records);
  const detached = records.map(record => ({ lineageId: record.lineageId, state: structuredClone(record.state) }));
  replay(plan, detached); return serializeNativeRecoveryPayload(detached);
}
function scenes(input: unknown, plan: WorkspaceOperationManagedCopyPlan): { records: readonly WorkspaceSceneSnapshotRecord[]; bytes: Buffer } {
  const raw = list(input, 10_000), requirements = plan.sceneCopyRequirements;
  if (raw.length !== requirements.length) return fail();
  const expected = new Map(requirements.map(requirement => [requirement.sourceDocumentId, requirement]));
  const bindings = new Map(plan.sourceEvidence.sceneBindings.map(binding => [binding.header.id, binding]));
  const records = new Map<string, WorkspaceSceneSnapshotRecord>(), encoded = new Map<string, Buffer>();
  let remaining = MANAGED_COPY_SCENE_RECORDS_LIMIT - 2;
  for (const value of raw) {
    const item = object(value, ['version', 'header', 'scene', 'contentProof']);
    const header = captureWorkspaceSceneSnapshotHeader(item.header), required = expected.get(header.id), binding = bindings.get(header.id);
    if (!required || !binding || records.has(header.id) || !equal(header, binding.header)
      || item.contentProof !== binding.contentProof || item.contentProof !== required.sourceContentProof) return fail();
    const headerBytes = header.elements_bytes! + header.shared_app_state_bytes! + header.assets_bytes!;
    if (headerBytes > remaining) return fail('STAGE_TOO_LARGE');
    const record = captureWorkspaceSceneSnapshot(value, { maxTotalBytes: remaining });
    // Portable JSON binds element property order as well as values. Preserve it
    // through C1 replay; the independent content/manifest proofs stay canonical.
    const bytes = Buffer.from(JSON.stringify(record)), charged = bytes.length + (records.size ? 1 : 0);
    if (charged > remaining) return fail('STAGE_TOO_LARGE'); remaining -= charged;
    records.set(header.id, record); encoded.set(header.id, bytes);
  }
  const ordered = requirements.map(requirement => records.get(requirement.sourceDocumentId)!);
  const chunks: Buffer[] = [Buffer.from('[')];
  for (const [index, record] of ordered.entries()) { if (index) chunks.push(Buffer.from(',')); chunks.push(encoded.get(record.header.id)!); }
  chunks.push(Buffer.from(']')); return { records: freeze(ordered), bytes: Buffer.concat(chunks) };
}
function storage(input: unknown, size: number): ExcalidrawReadonlyAssetRecord['storageIdentity'] {
  const value = object(capture(input), ['dev', 'ino', 'sizeBytes']);
  for (const field of ['dev', 'ino']) if (typeof value[field] !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value[field] as string)
    || BigInt(value[field] as string) > BigInt('18446744073709551615')) return fail();
  if (value.ino === '0' || value.sizeBytes !== size) return fail();
  return freeze(value as ExcalidrawReadonlyAssetRecord['storageIdentity']);
}
function assets(input: unknown, records: readonly WorkspaceSceneSnapshotRecord[]): {
  assets: readonly WorkspaceOperationManagedCopyAsset[]; entries: readonly ManagedCopySceneAssetDescriptor[]; bytes: Buffer;
} {
  const expected = new Map<string, Readonly<ExcalidrawAssetMetadata>>();
  for (const record of records) for (const metadata of record.scene.assets) {
    const identity = key(record.scene.workspaceId, metadata.fileId), prior = expected.get(identity);
    if (prior && !equal(prior, metadata)) return fail(); expected.set(identity, metadata);
    if (expected.size > MAX_ASSETS) return fail('STAGE_TOO_LARGE');
  }
  const values = list(input, MAX_ASSETS); if (values.length !== expected.size) return fail();
  const headers = new Map<string, { workspaceId: string; metadata: Readonly<ExcalidrawAssetMetadata>;
    storageIdentity: ExcalidrawReadonlyAssetRecord['storageIdentity']; bytes: unknown }>();
  let total = 0;
  for (const raw of values) {
    const value = object(raw, ['workspaceId', 'asset']), asset = object(value.asset, ['metadata', 'bytes', 'contentProof', 'storageIdentity']);
    const metadata = captureExcalidrawReadonlyAssetMetadata(asset.metadata);
    if (typeof value.workspaceId !== 'string') return fail();
    const identity = key(value.workspaceId, metadata.fileId);
    if (headers.has(identity) || !equal(expected.get(identity), metadata) || asset.contentProof !== metadata.contentHash) return fail();
    const storageIdentity = storage(asset.storageIdentity, metadata.sizeBytes);
    total += metadata.sizeBytes; if (total > MANAGED_COPY_SCENE_ASSETS_LIMIT) return fail('STAGE_TOO_LARGE');
    headers.set(identity, { workspaceId: value.workspaceId, metadata, storageIdentity, bytes: asset.bytes });
  }
  // All metadata/count/total budgets are checked before the first byte copy.
  const captured: WorkspaceOperationManagedCopyAsset[] = [], entries: ManagedCopySceneAssetDescriptor[] = [], chunks: Buffer[] = [];
  let offset = 0;
  for (const identity of [...headers.keys()].sort()) {
    const header = headers.get(identity)!, bytes = binary(header.bytes, MANAGED_COPY_SCENE_ASSETS_LIMIT, header.metadata.sizeBytes);
    if (hash(bytes) !== header.metadata.contentHash) return fail();
    entries.push(freeze({ workspaceId: header.workspaceId, metadata: header.metadata, sourceStorageIdentity: header.storageIdentity,
      offset, sizeBytes: bytes.length, sha256: hash(bytes), metadataProof: proof({ workspaceId: header.workspaceId, metadata: header.metadata }) }));
    captured.push(freeze({ workspaceId: header.workspaceId, asset: { metadata: header.metadata, bytes: new Uint8Array(bytes),
      contentProof: hash(bytes), storageIdentity: header.storageIdentity } }));
    chunks.push(bytes); offset += bytes.length;
  }
  return { assets: freeze(captured), entries: freeze(entries), bytes: Buffer.concat(chunks, offset) };
}
function fingerprint(identity: PreparedPathCopyIdentity): string {
  const milliseconds = (value: string) => { const ns = BigInt(value); return Number(ns / BigInt(1_000_000_000)) * 1000 + Number(ns % BigInt(1_000_000_000)) / 1_000_000; };
  return `${identity.device}:${identity.inode}:${identity.size}:${milliseconds(identity.mtimeNs)}:${milliseconds(identity.ctimeNs)}`;
}
function physicals(input: unknown, plan: WorkspaceOperationManagedCopyPlan): readonly WorkspaceOperationManagedCopyPhysical[] {
  const raw = list(input, 1000); if (raw.length !== plan.selections.length) return fail();
  const namespace = new Map(plan.sourceEvidence.stage.namespace.map(entry => [entry.path, entry]));
  let derivedBytes = 0;
  return freeze(raw.map((value, index) => {
    const row = object(value, ['selectionIndex', 'original']), selection = plan.selections[index];
    const original = decodePreparedWorkspacePathCopyOriginal(row.original);
    const under = (path: string) => path === selection.sourcePath || path.startsWith(selection.sourcePath + '/');
    const selectedScenes = plan.sceneCopyRequirements.filter(requirement => under(requirement.sourcePath));
    if (row.selectionIndex !== index || original.version !== 2 && original.version !== 3
      || original.version === 2 && selectedScenes.length || !equal(original.sourceWorkspace, plan.sourceScope)
      || !equal(original.destinationWorkspace, plan.destinationScope) || original.sourcePath !== selection.sourcePath
      || original.destinationPath !== selection.destinationPath) return fail();
    const projected = plan.sourceEvidence.nativeBindings.map(binding => binding.expected.path).filter(under).sort();
    if (!equal(original.projectionPaths, projected)) return fail();
    if (original.version === 3) {
      if (original.sourceProjectionPolicy !== 'provider-derived-files-v3' || original.derivedFiles.length !== selectedScenes.length) return fail();
      const derived = new Map(original.derivedFiles.map(file => [file.path, file]));
      if (derived.size !== selectedScenes.length) return fail();
      for (const requirement of selectedScenes) {
        const file = derived.get(requirement.sourcePath);
        if (!file || file.provider !== 'excalidraw' || file.documentId !== requirement.sourceDocumentId
          || file.lineageId !== requirement.sourceLineageId || file.lifecycleGeneration !== requirement.sourceGeneration
          || file.sourceContentProof !== requirement.sourceContentProof) return fail();
        derivedBytes += file.sizeBytes; if (derivedBytes > DERIVED_BYTES_LIMIT) return fail('STAGE_TOO_LARGE');
      }
    }
    const selected = namespace.get(selection.sourcePath); if (!selected) return fail();
    const observed = original.source.kind === 'directory' ? original.source.entries : original.source.kind === 'projection_absent'
      ? [] : [{ relativePath: '', ...original.source }];
    const paths = new Set<string>();
    for (const node of observed) {
      const path = node.relativePath ? selection.sourcePath + '/' + node.relativePath : selection.sourcePath, expected = namespace.get(path);
      const provider = expected?.documentId !== null && expected?.documentId !== undefined || expected?.provider === 'excalidraw';
      if (!expected || expected.kind !== (node.kind === 'directory' ? 'directory' : 'file')
        || (node.kind === 'projection_file') !== Boolean(provider)) return fail();
      if (!provider && expected.filesystemIdentity !== fingerprint(node.identity)) return fail(); paths.add(path);
    }
    for (const entry of namespace.values()) if (under(entry.path) && !paths.has(entry.path)
      && entry.documentId === null && entry.provider !== 'excalidraw' && entry.filesystemIdentity !== null) return fail();
    if (original.source.kind === 'projection_absent' && selected.documentId === null && selected.provider !== 'excalidraw'
      && !(selected.kind === 'directory' && selected.filesystemIdentity === null)) return fail();
    return { selectionIndex: index, original } as WorkspaceOperationManagedCopyPhysical;
  }));
}
function projectionBytes(physical: readonly WorkspaceOperationManagedCopyPhysical[], records: readonly WorkspaceSceneSnapshotRecord[],
  capturedAssets: readonly WorkspaceOperationManagedCopyAsset[]): void {
  const scenesById = new Map(records.map(record => [record.header.id, record]));
  const byAsset = new Map(capturedAssets.map(value => [key(value.workspaceId, value.asset.metadata.fileId), value.asset]));
  for (const { original } of physical) if (original.version === 3) for (const file of original.derivedFiles) {
    const record = scenesById.get(file.documentId); if (!record || record.header.path !== file.path) return fail();
    const scene = record.scene, content = serializePortableExcalidrawSceneFromReadonlyAssets({ elements: scene.elements,
      appState: scene.appState, assets: scene.assets, canonicalHash: scene.canonicalHash }, scene.assets.map(metadata => {
      const asset = byAsset.get(key(scene.workspaceId, metadata.fileId)); if (!asset) return fail();
      return { metadata: asset.metadata, bytes: asset.bytes };
    }));
    if (Buffer.byteLength(content) !== file.sizeBytes || hash(content) !== file.sha256) return fail();
  }
}
function descriptor<File extends string>(input: unknown, file: File, maximum: number, count: number): PayloadDescriptor<File> {
  const value = object(input, ['file', 'sizeBytes', 'sha256', 'count']);
  if (value.file !== file || !integer(value.sizeBytes) || value.count !== count || !digest(value.sha256)) return fail();
  if (value.sizeBytes > maximum) return fail('STAGE_TOO_LARGE');
  return value as PayloadDescriptor<File>;
}
function assetDescriptors(input: unknown): ManagedCopyStageManifestV4['sceneAssets'] {
  const value = object(input, ['file', 'sizeBytes', 'sha256', 'count', 'entries']), rows = list(value.entries, MAX_ASSETS);
  const base = descriptor({ file: value.file, sizeBytes: value.sizeBytes, sha256: value.sha256, count: value.count }, 'scene-assets.bin', MANAGED_COPY_SCENE_ASSETS_LIMIT, rows.length);
  let offset = 0, previous = '';
  const entries = rows.map(raw => {
    const entry = object(raw, ['workspaceId', 'metadata', 'sourceStorageIdentity', 'offset', 'sizeBytes', 'sha256', 'metadataProof']);
    const metadata = captureExcalidrawReadonlyAssetMetadata(entry.metadata);
    if (typeof entry.workspaceId !== 'string' || !entry.workspaceId || entry.workspaceId.length > 256) return fail();
    const identity = key(entry.workspaceId, metadata.fileId);
    if (identity <= previous || entry.offset !== offset || entry.sizeBytes !== metadata.sizeBytes || entry.sha256 !== metadata.contentHash
      || entry.metadataProof !== proof({ workspaceId: entry.workspaceId, metadata })) return fail();
    const sourceStorageIdentity = storage(entry.sourceStorageIdentity, metadata.sizeBytes);
    offset += metadata.sizeBytes; if (offset > MANAGED_COPY_SCENE_ASSETS_LIMIT) return fail('STAGE_TOO_LARGE'); previous = identity;
    return { workspaceId: entry.workspaceId, metadata, sourceStorageIdentity, offset: entry.offset, sizeBytes: entry.sizeBytes,
      sha256: entry.sha256, metadataProof: entry.metadataProof } as ManagedCopySceneAssetDescriptor;
  });
  if (offset !== base.sizeBytes) return fail(); return freeze({ ...base, entries });
}
const manifestFields = ['version', 'kind', 'identity', 'request', 'origin', 'plan', 'physical', 'metadata',
  'records', 'sceneRecords', 'sceneAssets', 'payloadSha256'] as const;
function manifest(input: unknown): ManagedCopyStageManifestV4 {
  const raw = object(capture(input), manifestFields);
  if (raw.version !== 4 || raw.kind !== 'native-copy' || !digest(raw.payloadSha256)) return fail();
  const plan = decodeWorkspaceOperationManagedCopyPlan(raw.plan), identity = captureNativeCopyStageIdentity(raw.identity);
  const request = capture(raw.request) as WorkspaceOperationRequest;
  if (request.kind !== 'copy' || !request.origin || !equal(request.selections, plan.selections)) return fail();
  const origin = decodeWorkspaceOperationCopyOrigin(request.origin);
  if (!equal(origin, raw.origin) || !equal(origin.sourceScope, plan.sourceScope) || !equal(origin.destinationScope, plan.destinationScope)
    || identity.planId !== plan.planId || identity.sourceWorkspaceId !== plan.sourceScope.workspaceId
    || identity.destinationWorkspaceId !== plan.destinationScope.workspaceId || identity.canonicalRequestHash !== serializeWorkspaceOperationRequest(request).requestHash) return fail();
  const physical = physicals(raw.physical, plan), metadata = decodeNativeCopyMetadataSnapshot(raw.metadata, { plan, physical });
  const count = new Set(evidences(plan).flatMap(evidence => evidence.nativeBindings.map(binding => binding.expected.documentId))).size;
  descriptor(raw.records, 'native-records.bin', NATIVE_RECOVERY_PAYLOAD_LIMIT, count);
  descriptor(raw.sceneRecords, 'scene-records.json', MANAGED_COPY_SCENE_RECORDS_LIMIT, plan.sceneCopyRequirements.length);
  const assetInfo = assetDescriptors(raw.sceneAssets);
  if (!plan.sceneCopyRequirements.length && assetInfo.count !== 0
    || assetInfo.entries.some(entry => entry.workspaceId !== plan.sourceScope.workspaceId)) return fail();
  const { payloadSha256, ...body } = raw;
  if (proof(body) !== payloadSha256 || !equal(physical, raw.physical) || !equal(metadata, raw.metadata)) return fail();
  return freeze(raw as unknown as ManagedCopyStageManifestV4);
}

/** Complete V4 data preparation, with no legacy-plan conversion or IO. */
export function prepareManagedCopyStage(input: WorkspaceOperationManagedCopyStageInput): {
  manifest: ManagedCopyStageManifestV4; manifestBytes: Buffer; recordsBytes: Buffer; sceneRecordsBytes: Buffer; sceneAssetsBytes: Buffer;
} {
  return guarded(() => {
    const raw = object(input, ['operationId', 'request', 'plan', 'physical', 'nativeRecords', 'sceneRecords', 'sceneAssets', 'metadata']);
    const plan = decodeWorkspaceOperationManagedCopyPlan(raw.plan), request = capture(raw.request) as WorkspaceOperationRequest;
    if (request.kind !== 'copy' || !request.origin || !equal(request.selections, plan.selections)) return fail();
    const origin = decodeWorkspaceOperationCopyOrigin(request.origin);
    if (!equal(origin.sourceScope, plan.sourceScope) || !equal(origin.destinationScope, plan.destinationScope)) return fail();
    const identity = captureNativeCopyStageIdentity({ operationId: raw.operationId, planId: plan.planId, kind: 'native-copy',
      sourceWorkspaceId: plan.sourceScope.workspaceId, destinationWorkspaceId: plan.destinationScope.workspaceId,
      canonicalRequestHash: serializeWorkspaceOperationRequest(request).requestHash });
    const physical = physicals(raw.physical, plan), metadata = decodeNativeCopyMetadataSnapshot(raw.metadata, { plan, physical });
    const sceneData = scenes(raw.sceneRecords, plan), assetData = assets(raw.sceneAssets, sceneData.records);
    projectionBytes(physical, sceneData.records, assetData.assets);
    const recordsBytes = nativeBytes(raw.nativeRecords, plan);
    const records = { file: 'native-records.bin' as const, sizeBytes: recordsBytes.length, sha256: hash(recordsBytes), count: list(raw.nativeRecords, 10_000).length };
    const sceneRecords = { file: 'scene-records.json' as const, sizeBytes: sceneData.bytes.length, sha256: hash(sceneData.bytes), count: sceneData.records.length };
    const sceneAssets = { file: 'scene-assets.bin' as const, sizeBytes: assetData.bytes.length, sha256: hash(assetData.bytes), count: assetData.entries.length, entries: assetData.entries };
    const body = { version: 4 as const, kind: 'native-copy' as const, identity, request, origin, plan, physical, metadata, records, sceneRecords, sceneAssets };
    const prepared = freeze({ ...body, payloadSha256: proof(body) }), manifestBytes = jsonBytes(prepared);
    if (manifestBytes.length > NATIVE_COPY_STAGE_MANIFEST_LIMIT) return fail('STAGE_TOO_LARGE');
    manifest(prepared);
    return { manifest: prepared, manifestBytes, recordsBytes, sceneRecordsBytes: sceneData.bytes, sceneAssetsBytes: assetData.bytes };
  });
}

/** Validate all descriptor budgets before the store reads any binary sidecar. */
export function assertManagedCopyStageManifestDigest(input: unknown): void { guarded(() => { manifest(input); }, true); }

/** Historical C1 data replay only. The actual owner must acquire fresh SQL,
 * filesystem and principal authority before any resumed mutation/publication. */
export function decodeManagedCopyStage(manifestInput: unknown, payloads: ManagedCopyStagePayloads,
  expected: WorkspaceOperationManagedCopyStageIdentity): WorkspaceOperationManagedCopyStageV4 {
  return guarded(() => {
    const stored = manifest(manifestInput), identity = captureNativeCopyStageIdentity(expected);
    if (!equal(identity, stored.identity)) return fail('CORRUPT_STAGE');
    const raw = object(payloads, ['recordsBytes', 'sceneRecordsBytes', 'sceneAssetsBytes']);
    const recordsBytes = binary(raw.recordsBytes, NATIVE_RECOVERY_PAYLOAD_LIMIT, stored.records.sizeBytes);
    const sceneRecordsBytes = binary(raw.sceneRecordsBytes, MANAGED_COPY_SCENE_RECORDS_LIMIT, stored.sceneRecords.sizeBytes);
    const sceneAssetsBytes = binary(raw.sceneAssetsBytes, MANAGED_COPY_SCENE_ASSETS_LIMIT, stored.sceneAssets.sizeBytes);
    if (hash(recordsBytes) !== stored.records.sha256 || hash(sceneRecordsBytes) !== stored.sceneRecords.sha256
      || hash(sceneAssetsBytes) !== stored.sceneAssets.sha256) return fail('CORRUPT_STAGE');
    const nativeRecords = deserializeNativeRecoveryPayload(recordsBytes);
    const sceneRecords: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sceneRecordsBytes));
    const sceneAssets = stored.sceneAssets.entries.map(entry => ({ workspaceId: entry.workspaceId, asset: {
      metadata: entry.metadata, storageIdentity: entry.sourceStorageIdentity, contentProof: entry.sha256,
      bytes: new Uint8Array(sceneAssetsBytes.subarray(entry.offset, entry.offset + entry.sizeBytes)) } }));
    const rebuilt = prepareManagedCopyStage({ operationId: identity.operationId, request: stored.request, plan: stored.plan,
      physical: stored.physical, metadata: stored.metadata, nativeRecords,
      sceneRecords: sceneRecords as WorkspaceSceneSnapshotRecord[], sceneAssets });
    if (!equal(rebuilt.manifest, stored) || !rebuilt.recordsBytes.equals(recordsBytes)
      || !rebuilt.sceneRecordsBytes.equals(sceneRecordsBytes) || !rebuilt.sceneAssetsBytes.equals(sceneAssetsBytes)) return fail('CORRUPT_STAGE');
    const { records: _nativeDescriptor, sceneRecords: _sceneDescriptor, sceneAssets: _assetDescriptor, ...base } = stored;
    return freeze({ ...base, nativeRecords, sceneRecords: scenes(sceneRecords, stored.plan).records, sceneAssets });
  }, true);
}
