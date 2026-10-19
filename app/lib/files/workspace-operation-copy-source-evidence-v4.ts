import 'server-only';

import { isDeepStrictEqual as equal, types } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { NativeNamespaceEntry } from '../markdown/workspace-link-contract-v2';
import type { WorkspaceMixedReadLinkSnapshotV3 } from '../markdown/workspace-link-contract-v3';
import type { WorkspaceSourceAuthorityStage } from '../markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { captureWorkspaceSceneSnapshot, captureWorkspaceSceneSnapshotHeader } from '../excalidraw-collaboration/workspace-scene-snapshot';
import type { WorkspaceSceneSourceBinding } from './workspace-operation-copy-source-observation';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { captureWorkspaceOperationNativeCatalogueWitness } from './workspace-operation-native-catalogue-witness';
import { workspaceOperationMixedSourceSnapshot } from './workspace-operation-mixed-source-evidence';
import { captureWorkspaceOperationNativeSourceEvidenceV3, decodeWorkspaceOperationNativeSourceEvidenceV3,
  type PhysicalReadSourceEvidenceV3, type WorkspaceOperationNativeSourceEvidenceV3 } from './workspace-operation-native-source-evidence-v3';
import { isNativeSourceFilesystemFingerprint, WorkspaceOperationNativeSourceEvidenceError,
  type WorkspaceOperationNativeSourceEvidenceV2 } from './workspace-operation-native-source-evidence';

/** Historical full-workspace facts. Physical spans are read facts, never native
 * references, and originalBytes are intentionally absent from this Stage view. */
export type WorkspaceOperationMixedCopySourceStageV4 = Omit<WorkspaceSourceAuthorityStage, 'sources'> & {
  sources: Array<Extract<WorkspaceSourceAuthorityStage['sources'][number], { kind: 'native' }>
    | { kind: 'physical'; inventory: PhysicalReadSourceEvidenceV3 }>;
};
export type WorkspaceOperationCopySourceEvidenceV4 = Readonly<{
  evidenceVersion: 4;
  workspaceScope: WorkspaceOperationJobScope;
  stage: WorkspaceOperationMixedCopySourceStageV4;
  nativeBindings: WorkspaceOperationNativeSourceEvidenceV2['nativeBindings'];
  /** Explicit Scene exclusions only; this component still contains all Raw facts. */
  nativeComponent: WorkspaceOperationNativeSourceEvidenceV3;
  sceneBindings: readonly WorkspaceSceneSourceBinding[];
  semanticProof: string;
  evidenceProof: string;
}>;
const copyV4StageKeys = ['stageVersion', 'workspaceId', 'organizationId', 'catalogueProof', 'namespace',
  'sources', 'scope', 'coverage', 'readiness', 'executionReady', 'stageProof'] as const;
const copyV4PhysicalKeys = ['physicalSourceVersion', 'parserVersion', 'source', 'workspaceId', 'organizationId',
  'path', 'authority', 'physical', 'originalBytes', 'encoding', 'hasBom', 'lineEndings', 'frontmatterPrefix',
  'metadata', 'links', 'coverage', 'applicability', 'executionReady', 'physicalSourceProof'] as const;
function rejectCopyV4Evidence(reason: 'invalid' | 'too-large' = 'invalid'): never {
  throw new WorkspaceOperationNativeSourceEvidenceError(reason === 'too-large'
    ? 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE' : 'NATIVE_SOURCE_EVIDENCE_INVALID');
}
function copyV4Field(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return rejectCopyV4Evidence();
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return rejectCopyV4Evidence();
  return descriptor.value;
}
function copyV4Object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length) return rejectCopyV4Evidence();
  return Object.fromEntries(keys.map(key => [key, copyV4Field(input, key)]));
}
function copyV4List(input: unknown): unknown[] {
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype) return rejectCopyV4Evidence();
  const size = Object.getOwnPropertyDescriptor(input, 'length')!.value as number;
  if (size > 10_000) return rejectCopyV4Evidence('too-large');
  if (Reflect.ownKeys(input).length !== size + 1) return rejectCopyV4Evidence();
  return Array.from({ length: size }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return rejectCopyV4Evidence();
    return descriptor.value;
  });
}
function captureCopyV4Facts(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, rejectCopyV4Evidence, 8 * 1024 * 1024);
}
function freezeCopyV4Evidence<T>(input: T): T {
  if (typeof input === 'string' && Buffer.from(input).toString('utf8') !== input) return rejectCopyV4Evidence();
  if (input && typeof input === 'object') {
    for (const child of Object.values(input)) freezeCopyV4Evidence(child);
    Object.freeze(input);
  }
  return input;
}
/** Reproduce the original stage hash using already validated byte hashes. Fresh
 * capture still reparses every actual original byte through MixedEvidence3. */
function copyV4StageFactsProof(stage: WorkspaceOperationMixedCopySourceStageV4): string {
  const { stageProof: _stored, ...body } = stage;
  return proof({ ...body, sources: stage.sources.map(source => source.kind === 'native' ? source
    : { kind: source.kind, claimedPhysicalSourceProof: source.inventory.physicalSourceProof,
      originalByteHash: source.inventory.physical.byteHash, physicalSourceProof: source.inventory.physicalSourceProof }) });
}
function captureCopyV4Stage(input: unknown): {
  facts: WorkspaceOperationMixedCopySourceStageV4; sources: WorkspaceSourceAuthorityStage['sources'];
} {
  const raw = copyV4Object(input, copyV4StageKeys), bytes = new Map<number, unknown>();
  const sources = copyV4List(raw.sources).map((input, index) => {
    const source = copyV4Object(input, ['kind', 'inventory']);
    if (source.kind === 'native') return source;
    if (source.kind !== 'physical') return rejectCopyV4Evidence();
    const inventory = copyV4Object(source.inventory, copyV4PhysicalKeys);
    bytes.set(index, inventory.originalBytes); delete inventory.originalBytes;
    return { kind: 'physical', inventory };
  });
  // One combined JSON budget, before proof traversal or private-byte allocation.
  const facts = freezeCopyV4Evidence(captureCopyV4Facts({ ...raw, sources })) as WorkspaceOperationMixedCopySourceStageV4;
  const originals: WorkspaceSourceAuthorityStage['sources'] = facts.sources.map((source, index) => source.kind === 'native'
    ? source : { kind: 'physical', inventory: { ...source.inventory, originalBytes: bytes.get(index) as Uint8Array } });
  return { facts, sources: originals };
}
function copyV4SceneBindings(input: unknown, scope: WorkspaceOperationJobScope): WorkspaceSceneSourceBinding[] {
  const rows = copyV4List(captureCopyV4Facts(input)), ids = new Set<string>(), lineages = new Set<string>(), paths = new Set<string>();
  return rows.map(input => {
    const row = copyV4Object(input, ['provider', 'header', 'contentProof']), header = captureWorkspaceSceneSnapshotHeader(row.header);
    if (row.provider !== 'excalidraw' || typeof row.contentProof !== 'string' || !/^[a-f0-9]{64}$/u.test(row.contentProof)
      || !header.path.toLowerCase().endsWith('.excalidraw') || header.path.split('/').pop()?.toLowerCase() === '.excalidraw'
      || header.workspace_id !== scope.workspaceId || header.workspace_type !== scope.workspaceType || header.organization_id !== scope.organizationId
      || [header.customer_id, header.lineage_customer_id].some(value => value !== null && value !== scope.customerId)
      || [header.project_id, header.lineage_project_id].some(value => value !== null && value !== scope.projectId)
      || ids.has(header.id) || lineages.has(header.lineage_id) || paths.has(header.path)) return rejectCopyV4Evidence();
    ids.add(header.id); lineages.add(header.lineage_id); paths.add(header.path);
    return { provider: 'excalidraw', header, contentProof: row.contentProof };
  });
}
/** Remove Scene leafs and only their Scene-only virtual ancestors. Raw files,
 * ordinary assets and all real directories remain in the component namespace. */
function copyV4PartitionStage(stage: WorkspaceOperationMixedCopySourceStageV4, scenes: readonly WorkspaceSceneSourceBinding[]): WorkspaceOperationMixedCopySourceStageV4 {
  const scenePaths = new Set(scenes.map(scene => scene.header.path)), sceneParents = new Set<string>(), retainedParents = new Set<string>();
  for (const scene of scenes) {
    const parts = scene.header.path.split('/'); parts.pop();
    while (parts.length) { sceneParents.add(parts.join('/')); parts.pop(); }
  }
  for (const entry of stage.namespace) {
    if (scenePaths.has(entry.path) || entry.kind === 'directory' && entry.filesystemIdentity === null) continue;
    const parts = entry.path.split('/'); parts.pop();
    while (parts.length) { retainedParents.add(parts.join('/')); parts.pop(); }
  }
  const namespace = stage.namespace.filter(entry => {
    if (scenePaths.has(entry.path)) return false;
    if (entry.kind !== 'directory' || entry.filesystemIdentity !== null || !sceneParents.has(entry.path) || retainedParents.has(entry.path)) return true;
    copyV4Object(entry, ['workspaceId', 'path', 'kind', 'identity', 'documentId', 'lifecycleGeneration', 'filesystemIdentity']);
    if (entry.workspaceId !== stage.workspaceId || entry.documentId !== null || entry.lifecycleGeneration !== null
      || entry.identity !== `registry-directory:${proof({ workspaceId: stage.workspaceId, path: entry.path })}`) return rejectCopyV4Evidence();
    return false;
  });
  const body = { ...stage, namespace, scope: { ...stage.scope, excludedPaths: [...new Set([...stage.scope.excludedPaths, ...scenePaths])].sort() } };
  return { ...body, stageProof: copyV4StageFactsProof(body) };
}
function copyV4SemanticBody(value: Omit<WorkspaceOperationCopySourceEvidenceV4, 'semanticProof' | 'evidenceProof'>) {
  return { version: 4, workspaceScope: value.workspaceScope, scope: value.stage.scope, coverage: value.stage.coverage,
    nativeComponent: value.nativeComponent.semanticProof,
    scenes: value.sceneBindings.map(({ header }) => ({ documentId: header.id, lineageId: header.lineage_id,
      path: header.path, workspaceId: header.workspace_id, organizationId: header.organization_id,
      workspaceType: header.workspace_type, customerId: header.customer_id, projectId: header.project_id,
      lineageCustomerId: header.lineage_customer_id, lineageProjectId: header.lineage_project_id,
      generation: header.lifecycle_generation, schemaVersion: header.scene_schema_version, excalidrawVersion: header.excalidraw_version,
      sequence: header.scene_sequence, canonicalHash: header.canonical_hash, lineageTrashEntryId: header.lineage_trash_entry_id })) };
}
function inspectCopyV4Evidence(input: unknown): WorkspaceOperationCopySourceEvidenceV4 {
  const raw = copyV4Object(freezeCopyV4Evidence(captureCopyV4Facts(input)), ['evidenceVersion', 'workspaceScope', 'stage', 'nativeBindings',
    'nativeComponent', 'sceneBindings', 'semanticProof', 'evidenceProof']);
  if (raw.evidenceVersion !== 4) return rejectCopyV4Evidence();
  const scope = parseWorkspaceOperationJobScope(raw.workspaceScope), component = decodeWorkspaceOperationNativeSourceEvidenceV3(raw.nativeComponent);
  const stage = copyV4Object(raw.stage, copyV4StageKeys) as unknown as WorkspaceOperationMixedCopySourceStageV4;
  const scenes = copyV4SceneBindings(raw.sceneBindings, scope), stageScope = copyV4Object(stage.scope, ['kind', 'excludedPaths']);
  copyV4Object(stage.coverage, ['complete', 'gaps']);
  const exclusions = copyV4List(stageScope.excludedPaths), namespace = copyV4List(stage.namespace), sources = copyV4List(stage.sources);
  if (stage.stageVersion !== 1 || stage.workspaceId !== scope.workspaceId || stage.organizationId !== scope.organizationId
    || !equal(scope, component.workspaceScope) || !equal(raw.nativeBindings, component.nativeComponent.nativeBindings)
    || stage.catalogueProof !== component.nativeComponent.stage.catalogueProof || stage.executionReady !== false
    || stage.readiness !== (component.physicalSources.length ? 'requires-import-and-rebinding' : 'native-coordinator-required')
    || stageScope.kind !== 'visible-workspace' || new Set(exclusions).size !== exclusions.length
    || exclusions.some(path => !isCanonicalAdmissionPath(path) || Buffer.byteLength(path) > 4096 || path.split('/').length > 33)
    || stage.coverage.complete !== true || copyV4List(stage.coverage.gaps).length) return rejectCopyV4Evidence();
  const byPath = new Map(scenes.map(scene => [scene.header.path, scene])), seen = new Set<string>(), allPaths = new Map<string, NativeNamespaceEntry>();
  const nativeIds = new Set(component.nativeComponent.nativeBindings.map(binding => binding.expected.documentId));
  const nativeLineages = new Set(component.nativeComponent.nativeBindings.map(binding => binding.expected.lineageId));
  for (const physical of component.physicalSources) if (physical.authority.kind === 'registered-never-initialized') {
    nativeIds.add(physical.authority.registeredDocumentId);
    if (physical.authority.lineageId !== null) nativeLineages.add(physical.authority.lineageId);
  }
  for (const input of namespace) {
    const entry = input as NativeNamespaceEntry, scene = byPath.get(entry.path);
    if (!isCanonicalAdmissionPath(entry.path) || Buffer.byteLength(entry.path) > 4096 || entry.path.split('/').length > 33
      || allPaths.has(entry.path) || exclusions.some(path => entry.path === path || entry.path.startsWith(`${path}/`))) return rejectCopyV4Evidence();
    allPaths.set(entry.path, entry);
    if (!scene) { if (Object.hasOwn(entry, 'provider')) return rejectCopyV4Evidence(); continue; }
    copyV4Object(entry, ['workspaceId', 'path', 'kind', 'identity', 'documentId', 'lifecycleGeneration', 'filesystemIdentity', 'provider']);
    if (entry.provider !== 'excalidraw' || entry.kind !== 'file' || entry.workspaceId !== scope.workspaceId
      || entry.documentId !== null || entry.lifecycleGeneration !== null
      || entry.identity !== `scene:${scene.header.id}:${scene.header.lifecycle_generation}:${scene.contentProof}`
      || entry.filesystemIdentity !== null && !isNativeSourceFilesystemFingerprint(entry.filesystemIdentity)
      || nativeIds.has(scene.header.id) || nativeLineages.has(scene.header.lineage_id)) return rejectCopyV4Evidence();
    seen.add(entry.path);
  }
  if (seen.size !== scenes.length) return rejectCopyV4Evidence();
  for (const entry of stage.namespace) {
    const parts = entry.path.split('/'); parts.pop();
    while (parts.length) { if (allPaths.get(parts.join('/'))?.kind !== 'directory') return rejectCopyV4Evidence(); parts.pop(); }
  }
  const nativeSources = sources.filter(source => copyV4Field(source, 'kind') === 'native');
  const physicalSources = sources.filter(source => copyV4Field(source, 'kind') === 'physical');
  for (const source of sources) copyV4Object(source, ['kind', 'inventory']);
  if (nativeSources.length + physicalSources.length !== sources.length
    || !equal(nativeSources, component.nativeComponent.stage.sources)
    || !equal(physicalSources.map(source => copyV4Field(source, 'inventory')).sort((left, right) =>
      String(copyV4Field(left, 'path')).localeCompare(String(copyV4Field(right, 'path')))), component.physicalSources)) return rejectCopyV4Evidence();
  const partitioned = copyV4PartitionStage(stage, scenes);
  if (!equal(partitioned.namespace, component.namespace) || !equal(partitioned.scope, component.scope)
    || !equal(partitioned.coverage, component.coverage) || partitioned.stageProof !== component.observedStageProof
    || copyV4StageFactsProof(stage) !== stage.stageProof) return rejectCopyV4Evidence();
  const value: WorkspaceOperationCopySourceEvidenceV4 = { evidenceVersion: 4, workspaceScope: scope, stage,
    nativeBindings: component.nativeComponent.nativeBindings, nativeComponent: component, sceneBindings: scenes,
    semanticProof: raw.semanticProof as string, evidenceProof: raw.evidenceProof as string };
  const { semanticProof, evidenceProof, ...body } = value;
  if (typeof semanticProof !== 'string' || !/^[a-f0-9]{64}$/u.test(semanticProof) || semanticProof !== proof(copyV4SemanticBody(body))
    || typeof evidenceProof !== 'string' || !/^[a-f0-9]{64}$/u.test(evidenceProof) || evidenceProof !== proof({ ...body, semanticProof })) return rejectCopyV4Evidence();
  return freezeCopyV4Evidence(value);
}

/** Fresh original-byte reparse, full native Catalogue witness and genuine SQL
 * Scene snapshots. This is data capture; the caller owns current auth and B. */
export function captureWorkspaceOperationCopySourceEvidenceV4(scope: WorkspaceOperationJobScope,
  observation: WorkspaceLinkSourceAuthorityObservation): WorkspaceOperationCopySourceEvidenceV4 {
  const bound = parseWorkspaceOperationJobScope(captureCopyV4Facts(scope));
  const captured = captureCopyV4Stage(copyV4Field(observation, 'stage'));
  const scenes = copyV4SceneBindings(copyV4Field(observation, 'sceneBindings'), bound);
  const partitioned = copyV4PartitionStage(captured.facts, scenes);
  const component = captureWorkspaceOperationNativeSourceEvidenceV3(bound, {
    stage: { ...partitioned, sources: captured.sources },
    nativeBindings: copyV4Field(observation, 'nativeBindings') as WorkspaceLinkSourceAuthorityObservation['nativeBindings'],
    privateNativeStates: copyV4Field(observation, 'privateNativeStates') as WorkspaceLinkSourceAuthorityObservation['privateNativeStates'],
    privateCatalogue: copyV4Field(observation, 'privateCatalogue') as WorkspaceLinkSourceAuthorityObservation['privateCatalogue'],
  });
  const catalogue = captureWorkspaceOperationNativeCatalogueWitness(copyV4Field(observation, 'privateCatalogue'), bound,
    component.nativeComponent.stage.catalogueProof!, component.nativeComponent.nativeBindings, rejectCopyV4Evidence);
  const ids = new Set(catalogue.entries.map(entry => entry.id)), lineages = new Set(catalogue.entries.flatMap(entry => entry.lineage_id ? [entry.lineage_id] : []));
  if (scenes.some(scene => ids.has(scene.header.id) || lineages.has(scene.header.lineage_id))) return rejectCopyV4Evidence();
  const rawSnapshots = copyV4List(copyV4Field(observation, 'privateSceneSnapshots'));
  if (rawSnapshots.length !== scenes.length) return rejectCopyV4Evidence();
  let remaining = 128 * 1024 * 1024;
  const snapshots = rawSnapshots.map((raw, index) => {
    const header = captureWorkspaceSceneSnapshotHeader(copyV4Field(raw, 'header'));
    if (!equal(header, scenes[index].header) || copyV4Field(raw, 'contentProof') !== scenes[index].contentProof) return rejectCopyV4Evidence();
    const headerBytes = header.elements_bytes! + header.shared_app_state_bytes! + header.assets_bytes!;
    if (headerBytes > remaining) return rejectCopyV4Evidence('too-large');
    const snapshot = captureWorkspaceSceneSnapshot(raw, { maxTotalBytes: remaining });
    const charged = Math.max(headerBytes, Buffer.byteLength(JSON.stringify(snapshot.scene)));
    if (charged > remaining) return rejectCopyV4Evidence('too-large');
    remaining -= charged; return snapshot;
  });
  if (!equal(snapshots.map(snapshot => ({ provider: 'excalidraw', header: snapshot.header, contentProof: snapshot.contentProof })), scenes)
    || !equal(captureCopyV4Facts(copyV4Field(observation, 'privateSceneCatalogue')), scenes.map(scene => scene.header))) return rejectCopyV4Evidence();
  const body = { evidenceVersion: 4 as const, workspaceScope: bound, stage: captured.facts,
    nativeBindings: component.nativeComponent.nativeBindings, nativeComponent: component, sceneBindings: scenes };
  const semanticProof = proof(copyV4SemanticBody(body));
  return inspectCopyV4Evidence({ ...body, semanticProof, evidenceProof: proof({ ...body, semanticProof }) });
}
/** Historical integrity only. No private byte payload, current auth or grant. */
export function decodeWorkspaceOperationCopySourceEvidenceV4(input: unknown): WorkspaceOperationCopySourceEvidenceV4 {
  return inspectCopyV4Evidence(input);
}
export function assertWorkspaceOperationCopySourceEvidenceV4Current(expected: WorkspaceOperationCopySourceEvidenceV4,
  observation: WorkspaceLinkSourceAuthorityObservation, scope: WorkspaceOperationJobScope): void {
  const original = decodeWorkspaceOperationCopySourceEvidenceV4(expected), current = captureWorkspaceOperationCopySourceEvidenceV4(scope, observation);
  if (original.semanticProof !== current.semanticProof) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_CHANGED');
}
/** The compiler always sees the complete Scene+Native+Raw namespace. */
export function workspaceOperationMixedCopySourceSnapshot(evidence: WorkspaceOperationCopySourceEvidenceV4): WorkspaceMixedReadLinkSnapshotV3 {
  const original = decodeWorkspaceOperationCopySourceEvidenceV4(evidence), component = workspaceOperationMixedSourceSnapshot(original.nativeComponent);
  const { snapshotProof: _componentProof, ...facts } = component;
  const body = { ...facts, namespace: structuredClone(original.stage.namespace), coverage: { complete: true, gaps: [] } };
  return { ...body, snapshotProof: proof(body) };
}
export function workspaceOperationMixedCopySourceNativeComponent(evidence: WorkspaceOperationCopySourceEvidenceV4): WorkspaceOperationNativeSourceEvidenceV3 {
  return decodeWorkspaceOperationCopySourceEvidenceV4(evidence).nativeComponent;
}
export function workspaceOperationMixedCopySourceNativeEvidence(evidence: WorkspaceOperationCopySourceEvidenceV4): WorkspaceOperationNativeSourceEvidenceV2 {
  return workspaceOperationMixedCopySourceNativeComponent(evidence).nativeComponent;
}
