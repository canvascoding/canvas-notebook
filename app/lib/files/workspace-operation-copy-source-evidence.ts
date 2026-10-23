import 'server-only';

import { isDeepStrictEqual, types } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { NativeNamespaceEntry } from '../markdown/workspace-link-contract-v2';
import { workspaceSourceAuthorityStageProof } from '../markdown/workspace-physical-link-inventory';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { captureWorkspaceSceneSnapshot, captureWorkspaceSceneSnapshotHeader } from '../excalidraw-collaboration/workspace-scene-snapshot';
import type { WorkspaceSceneSourceBinding } from './workspace-operation-copy-source-observation';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { captureWorkspaceOperationNativeSourceEvidenceV2, decodeWorkspaceOperationNativeSourceEvidence,
  isNativeSourceFilesystemFingerprint,
  WorkspaceOperationNativeSourceEvidenceError, type WorkspaceOperationNativeSourceEvidenceV2 } from './workspace-operation-native-source-evidence';

/** The native component explicitly excludes Scene paths. The complete stage
 * retains both providers and is the only namespace compiled for a mixed Copy.
 * Neither component is an execution capability. Historical V1/V2 stay strict. */
export type WorkspaceOperationCopySourceEvidenceV3 = Readonly<{
  evidenceVersion: 3;
  workspaceScope: WorkspaceOperationJobScope;
  stage: WorkspaceOperationNativeSourceEvidenceV2['stage'];
  nativeBindings: WorkspaceOperationNativeSourceEvidenceV2['nativeBindings'];
  nativeComponent: WorkspaceOperationNativeSourceEvidenceV2;
  sceneBindings: readonly WorkspaceSceneSourceBinding[];
  semanticProof: string;
  evidenceProof: string;
}>;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const fail = (): never => { throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID'); };
function capture(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, reason => {
    throw new WorkspaceOperationNativeSourceEvidenceError(reason === 'too-large'
      ? 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE' : 'NATIVE_SOURCE_EVIDENCE_INVALID');
  });
}
function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length) return fail();
  for (const key of keys) field(input, key);
  return input as Record<string, unknown>;
}
function field(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return fail();
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return fail();
  return descriptor.value;
}
function freeze<T>(input: T): T {
  if (input && typeof input === 'object') { for (const child of Object.values(input)) freeze(child); Object.freeze(input); }
  return input;
}
function list(input: unknown): unknown[] {
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype
    || input.length > 10_000 || Reflect.ownKeys(input).length !== input.length + 1) return fail();
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return fail(); return descriptor.value;
  });
}
function bindings(input: unknown, scope: WorkspaceOperationJobScope): WorkspaceSceneSourceBinding[] {
  const value = capture(input);
  if (!Array.isArray(value) || value.length > 10_000) return fail();
  const ids = new Set<string>(), lineages = new Set<string>(), paths = new Set<string>();
  return value.map(raw => {
    const row = exact(raw, ['provider', 'header', 'contentProof']);
    const header = captureWorkspaceSceneSnapshotHeader(row.header);
    if (row.provider !== 'excalidraw' || !hash(row.contentProof)
      || !header.path.toLowerCase().endsWith('.excalidraw') || header.path.split('/').pop()?.toLowerCase() === '.excalidraw'
      || header.workspace_id !== scope.workspaceId || header.workspace_type !== scope.workspaceType
      || header.organization_id !== scope.organizationId || ids.has(header.id) || lineages.has(header.lineage_id) || paths.has(header.path)
      || [header.customer_id, header.lineage_customer_id].some(value => value !== null && value !== scope.customerId)
      || [header.project_id, header.lineage_project_id].some(value => value !== null && value !== scope.projectId)) return fail();
    ids.add(header.id); lineages.add(header.lineage_id); paths.add(header.path);
    return { provider: 'excalidraw', header, contentProof: row.contentProof };
  });
}

/** Validate the complete shape before the native component can normalize its
 * exclusions. A proof of malformed data does not make it a valid full stage. */
function fullStage(input: unknown): WorkspaceOperationCopySourceEvidenceV3['stage'] {
  const stage = exact(input, ['stageVersion', 'workspaceId', 'organizationId', 'catalogueProof', 'namespace',
    'sources', 'scope', 'coverage', 'readiness', 'executionReady', 'stageProof']);
  const scope = exact(stage.scope, ['kind', 'excludedPaths']);
  const exclusions = list(scope.excludedPaths);
  const pathValid = (value: unknown): value is string => isCanonicalAdmissionPath(value)
    && Buffer.byteLength(value) <= 4096 && value.split('/').length <= 33;
  if (scope.kind !== 'visible-workspace' || exclusions.some(value => !pathValid(value))
    || new Set(exclusions).size !== exclusions.length) return fail();
  const coverage = exact(stage.coverage, ['complete', 'gaps']);
  if (coverage.complete !== true || list(coverage.gaps).length) return fail();
  for (const entry of list(stage.namespace)) if (!pathValid(field(entry, 'path'))) return fail();
  list(stage.sources);
  return input as WorkspaceOperationCopySourceEvidenceV3['stage'];
}

/** Build the explicitly scoped Yjs/ordinary-file component, not a substitute
 * complete workspace. Scene-only virtual parents carry no physical authority. */
function nativeComponentStage(stage: WorkspaceOperationCopySourceEvidenceV3['stage'], scenes: readonly WorkspaceSceneSourceBinding[]) {
  const nativeParents = new Set<string>();
  for (const entry of stage.namespace.filter(entry => entry.documentId !== null)) {
    const segments = entry.path.split('/'); segments.pop();
    while (segments.length) { nativeParents.add(segments.join('/')); segments.pop(); }
  }
  const scenePaths = new Set(scenes.map(scene => scene.header.path));
  const namespace = stage.namespace.filter(entry => !scenePaths.has(entry.path)
    && (entry.kind !== 'directory' || entry.filesystemIdentity !== null || nativeParents.has(entry.path)));
  const body = { ...stage, namespace,
    scope: { ...stage.scope, excludedPaths: [...new Set([...stage.scope.excludedPaths, ...scenePaths])].sort() } };
  return { ...body, stageProof: workspaceSourceAuthorityStageProof(body) };
}
function semanticBody(value: Omit<WorkspaceOperationCopySourceEvidenceV3, 'semanticProof' | 'evidenceProof'>) {
  return { version: 3, workspaceScope: value.workspaceScope, nativeComponent: value.nativeComponent.semanticProof,
    scenes: value.sceneBindings.map(({ header }) => ({ documentId: header.id, lineageId: header.lineage_id,
      path: header.path, workspaceId: header.workspace_id, organizationId: header.organization_id,
      workspaceType: header.workspace_type, customerId: header.customer_id, projectId: header.project_id,
      lineageCustomerId: header.lineage_customer_id, lineageProjectId: header.lineage_project_id,
      generation: header.lifecycle_generation, schemaVersion: header.scene_schema_version,
      excalidrawVersion: header.excalidraw_version, sequence: header.scene_sequence, canonicalHash: header.canonical_hash,
      lineageTrashEntryId: header.lineage_trash_entry_id })) };
}
function inspectStage(value: WorkspaceOperationCopySourceEvidenceV3): void {
  const { stage, workspaceScope: scope, sceneBindings: scenes } = value;
  if (stage.stageVersion !== 1 || stage.workspaceId !== scope.workspaceId || stage.organizationId !== scope.organizationId
    || !stage.coverage.complete || stage.coverage.gaps.length || stage.readiness !== 'native-coordinator-required'
    || stage.executionReady !== false || workspaceSourceAuthorityStageProof(stage) !== stage.stageProof
    || !isDeepStrictEqual(value.nativeBindings, value.nativeComponent.nativeBindings)
    || !isDeepStrictEqual(nativeComponentStage(stage, scenes), value.nativeComponent.stage)) return fail();
  const byPath = new Map(scenes.map(scene => [scene.header.path, scene]));
  const componentPaths = new Set(value.nativeComponent.stage.namespace.map(entry => entry.path));
  const sceneParents = new Set<string>();
  for (const scene of scenes) {
    const segments = scene.header.path.split('/'); segments.pop();
    while (segments.length) { sceneParents.add(segments.join('/')); segments.pop(); }
  }
  const nativeIds = new Set(value.nativeBindings.map(native => native.expected.documentId));
  const nativeLineages = new Set(value.nativeBindings.map(native => native.expected.lineageId));
  const seen = new Set<string>(), allPaths = new Map<string, NativeNamespaceEntry>();
  for (const entry of stage.namespace) {
    if (allPaths.has(entry.path)) return fail(); allPaths.set(entry.path, entry);
    const scene = byPath.get(entry.path);
    if (!isCanonicalAdmissionPath(entry.path) || Buffer.byteLength(entry.path) > 4096 || entry.path.split('/').length > 33) return fail();
    if (!scene) {
      if (Object.hasOwn(entry, 'provider')) return fail();
      if (!componentPaths.has(entry.path)) {
        exact(entry, ['workspaceId', 'path', 'kind', 'identity', 'documentId', 'lifecycleGeneration', 'filesystemIdentity']);
        if (!sceneParents.has(entry.path) || entry.kind !== 'directory' || entry.workspaceId !== scope.workspaceId
          || entry.documentId !== null || entry.lifecycleGeneration !== null || entry.filesystemIdentity !== null
          || entry.identity !== `registry-directory:${proof({ workspaceId: scope.workspaceId, path: entry.path })}`) return fail();
      }
      continue;
    }
    exact(entry, ['workspaceId', 'path', 'kind', 'identity', 'documentId', 'lifecycleGeneration', 'filesystemIdentity', 'provider']);
    if (entry.provider !== 'excalidraw' || entry.kind !== 'file' || entry.workspaceId !== scope.workspaceId
      || entry.documentId !== null || entry.lifecycleGeneration !== null
      || entry.identity !== `scene:${scene.header.id}:${scene.header.lifecycle_generation}:${scene.contentProof}`
      || entry.filesystemIdentity !== null && !isNativeSourceFilesystemFingerprint(entry.filesystemIdentity)
      || nativeIds.has(scene.header.id) || nativeLineages.has(scene.header.lineage_id)) return fail();
    seen.add(entry.path);
  }
  if (seen.size !== scenes.length || stage.namespace.length > 10_000) return fail();
  for (const entry of stage.namespace) {
    const segments = entry.path.split('/'); segments.pop();
    while (segments.length) { if (allPaths.get(segments.join('/'))?.kind !== 'directory') return fail(); segments.pop(); }
  }
}

export function decodeWorkspaceOperationCopySourceEvidenceV3(input: unknown): WorkspaceOperationCopySourceEvidenceV3 {
  const raw = exact(capture(input), ['evidenceVersion', 'workspaceScope', 'stage', 'nativeBindings', 'nativeComponent',
    'sceneBindings', 'semanticProof', 'evidenceProof']);
  if (raw.evidenceVersion !== 3) return fail();
  const scope = parseWorkspaceOperationJobScope(raw.workspaceScope);
  const native = decodeWorkspaceOperationNativeSourceEvidence(raw.nativeComponent);
  if (native.evidenceVersion !== 2 || !isDeepStrictEqual(scope, native.workspaceScope)
    || !isDeepStrictEqual(raw.nativeBindings, native.nativeBindings) || !hash(raw.semanticProof) || !hash(raw.evidenceProof)) return fail();
  const value: WorkspaceOperationCopySourceEvidenceV3 = { evidenceVersion: 3, workspaceScope: scope,
    stage: fullStage(raw.stage), nativeBindings: native.nativeBindings, nativeComponent: native,
    sceneBindings: bindings(raw.sceneBindings, scope), semanticProof: raw.semanticProof, evidenceProof: raw.evidenceProof };
  inspectStage(value);
  const { evidenceProof, semanticProof, ...body } = value;
  if (!hash(semanticProof) || semanticProof !== proof(semanticBody(body)) || !hash(evidenceProof)
    || evidenceProof !== proof({ ...body, semanticProof })) return fail();
  return freeze(value);
}

/** Captures provider facts and verifies each full private snapshot before its
 * contentProof enters a plan. Current rights and the held fences stay outside. */
export function captureWorkspaceOperationCopySourceEvidenceV3(scope: WorkspaceOperationJobScope,
  observation: WorkspaceLinkSourceAuthorityObservation): WorkspaceOperationCopySourceEvidenceV3 {
  const boundScope = parseWorkspaceOperationJobScope(capture(scope));
  const stage = fullStage(capture(field(observation, 'stage')));
  const scenes = bindings(field(observation, 'sceneBindings'), boundScope);
  const rawSnapshots = list(field(observation, 'privateSceneSnapshots'));
  if (rawSnapshots.length !== scenes.length) return fail();
  let remaining = 128 * 1024 * 1024;
  const snapshots = rawSnapshots.map((raw, index) => {
    const header = captureWorkspaceSceneSnapshotHeader(field(raw, 'header'));
    if (!isDeepStrictEqual(header, scenes[index].header) || field(raw, 'contentProof') !== scenes[index].contentProof) return fail();
    const headerBytes = header.elements_bytes! + header.shared_app_state_bytes! + header.assets_bytes!;
    if (headerBytes > remaining) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
    const snapshot = captureWorkspaceSceneSnapshot(raw, { maxTotalBytes: remaining });
    const charged = Math.max(headerBytes, Buffer.byteLength(JSON.stringify(snapshot.scene)));
    if (charged > remaining) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
    remaining -= charged; return snapshot;
  });
  if (!isDeepStrictEqual(snapshots.map(snapshot => ({ provider: 'excalidraw', header: snapshot.header, contentProof: snapshot.contentProof })), scenes)
    || !isDeepStrictEqual(capture(field(observation, 'privateSceneCatalogue')), scenes.map(scene => scene.header))) return fail();
  const component = captureWorkspaceOperationNativeSourceEvidenceV2(boundScope, {
    stage: nativeComponentStage(stage, scenes), nativeBindings: field(observation, 'nativeBindings') as WorkspaceLinkSourceAuthorityObservation['nativeBindings'],
    privateNativeStates: field(observation, 'privateNativeStates') as WorkspaceLinkSourceAuthorityObservation['privateNativeStates'],
    privateCatalogue: field(observation, 'privateCatalogue') as WorkspaceLinkSourceAuthorityObservation['privateCatalogue'],
  });
  const body = { evidenceVersion: 3 as const, workspaceScope: boundScope, stage, nativeBindings: component.nativeBindings,
    nativeComponent: component, sceneBindings: scenes };
  const semanticProof = proof(semanticBody(body));
  return decodeWorkspaceOperationCopySourceEvidenceV3({ ...body, semanticProof, evidenceProof: proof({ ...body, semanticProof }) });
}
