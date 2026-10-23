import 'server-only';

import path from 'node:path';
import { isDeepStrictEqual, types } from 'node:util';
import type { SqlConnection } from '../db';
import { readWorkspaceSceneCatalogue, type WorkspaceSceneCatalogueEntry } from '../collaboration/workspace-scene-catalogue';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { captureWorkspaceSceneSnapshot, readWorkspaceSceneSnapshotsOnConnection,
  type WorkspaceSceneSnapshotRecord } from '../excalidraw-collaboration/workspace-scene-snapshot';
import { EXCALIDRAW_PORTABLE_MAX_BYTES } from '../excalidraw-collaboration/limits';
import type { NativeNamespaceEntry } from '../markdown/workspace-link-contract-v2';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof } from '../markdown/workspace-physical-link-inventory';
import { readWorkspaceLinkSourceAuthorityOnConnection,
  type WorkspaceLinkSourceAuthorityObservation, type WorkspacePhysicalSourceReadOptions } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceContext } from '../workspaces/types';
import type { WorkspaceOperationCopySourceEvidenceV3 } from './workspace-operation-copy-source-evidence';
import type { WorkspaceOperationCopySourceEvidenceV4 } from './workspace-operation-copy-source-evidence-v4';
import { WorkspaceOperationNativeSourceEvidenceError } from './workspace-operation-native-source-evidence';

export type WorkspaceSceneSourceBinding = Readonly<{
  provider: 'excalidraw'; header: Readonly<WorkspaceSceneCatalogueEntry>; contentProof: string;
}>;
export type WorkspaceCopySourceObservation = WorkspaceLinkSourceAuthorityObservation & Readonly<{
  sceneBindings: readonly WorkspaceSceneSourceBinding[];
  privateSceneSnapshots: readonly WorkspaceSceneSnapshotRecord[];
  privateSceneCatalogue: readonly Readonly<WorkspaceSceneCatalogueEntry>[];
}>;
type SceneSourceErrorCode = 'SCENE_SOURCE_MISSING_STATE' | 'SCENE_SOURCE_PATH_INVALID'
  | 'SCENE_SOURCE_CONFLICT' | 'SCENE_SOURCE_CHANGED' | 'SCENE_SOURCE_NAMESPACE_LIMIT';
export class WorkspaceCopySourceObservationError extends Error {
  readonly status: 409 | 413;
  constructor(readonly code: SceneSourceErrorCode) {
    super('The workspace Scene copy sources could not be observed consistently.');
    this.name = 'WorkspaceCopySourceObservationError'; this.status = code === 'SCENE_SOURCE_NAMESPACE_LIMIT' ? 413 : 409;
  }
}
const fail = (code: SceneSourceErrorCode): never => { throw new WorkspaceCopySourceObservationError(code); };
const MAX_PATHS = 10_000, MAX_DEPTH = 32;
const SCENE_LIMITS = Object.freeze({ maxSceneBytes: EXCALIDRAW_PORTABLE_MAX_BYTES, maxTotalBytes: 128 * 1024 * 1024 });

/** Select only the parser already bound by a strictly decoded stored Copy
 * evidence. This is not an evidence decoder or an authorization check. Missing
 * historical markers and an empty physical set retain parser 2; mixed markers
 * cannot silently reinterpret one source or destination during recovery. */
export function deriveCopyPhysicalParserVersion(evidence: WorkspaceOperationCopySourceEvidenceV3
  | WorkspaceOperationCopySourceEvidenceV4): 2 | 3 {
  if (!evidence || typeof evidence !== 'object' || types.isProxy(evidence)
    || Object.getPrototypeOf(evidence) !== Object.prototype) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
  const version = Object.getOwnPropertyDescriptor(evidence, 'evidenceVersion');
  const componentDescriptor = Object.getOwnPropertyDescriptor(evidence, 'nativeComponent');
  if (!version?.enumerable || !Object.hasOwn(version, 'value') || ![3, 4].includes(version.value)
    || !componentDescriptor?.enumerable || !Object.hasOwn(componentDescriptor, 'value')) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
  const component: unknown = componentDescriptor.value;
  if (!component || typeof component !== 'object' || types.isProxy(component)
    || Object.getPrototypeOf(component) !== Object.prototype) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
  const componentVersion = Object.getOwnPropertyDescriptor(component, 'evidenceVersion');
  if (!componentVersion?.enumerable || !Object.hasOwn(componentVersion, 'value')
    || componentVersion.value !== (version.value === 3 ? 2 : 3)) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
  const physicalDescriptor = Object.getOwnPropertyDescriptor(component, 'physicalSources');
  if (version.value === 3) {
    if (physicalDescriptor) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
    return 2;
  }
  if (!physicalDescriptor?.enumerable || !Object.hasOwn(physicalDescriptor, 'value')) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
  const physical: unknown = physicalDescriptor.value;
  if (!Array.isArray(physical) || types.isProxy(physical) || Object.getPrototypeOf(physical) !== Array.prototype
    || physical.length > MAX_PATHS || Reflect.ownKeys(physical).length !== physical.length + 1) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
  let parserVersion: 2 | 3 | undefined;
  for (let index = 0; index < physical.length; index++) {
    const sourceDescriptor = Object.getOwnPropertyDescriptor(physical, String(index));
    if (!sourceDescriptor?.enumerable || !Object.hasOwn(sourceDescriptor, 'value')) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
    const source: unknown = sourceDescriptor.value;
    if (!source || typeof source !== 'object' || types.isProxy(source)
      || Object.getPrototypeOf(source) !== Object.prototype) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
    const marker = Object.getOwnPropertyDescriptor(source, 'parserVersion');
    if (marker && (!marker.enumerable || !Object.hasOwn(marker, 'value'))) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
    const current = marker === undefined ? 2 : marker.value;
    if (current !== 2 && current !== 3 || parserVersion !== undefined && current !== parserVersion) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
    parserVersion = current;
  }
  return parserVersion ?? 2;
}
function checkSceneHeaders(catalogue: readonly WorkspaceSceneCatalogueEntry[], workspace: WorkspaceContext): void {
  if (catalogue.length > MAX_PATHS) return fail('SCENE_SOURCE_NAMESPACE_LIMIT');
  const ids = new Set<string>(), lineages = new Set<string>(), paths = new Set<string>();
  for (const header of catalogue) {
    // This rejection precedes the legacy filesystem collector, including its
    // physical Markdown/HTML reads. A Scene registry can never authorize fallback.
    if (header.authority !== 'initialized' || header.has_persisted_state !== true) return fail('SCENE_SOURCE_MISSING_STATE');
    if (!isCanonicalAdmissionPath(header.path) || !header.path.toLowerCase().endsWith('.excalidraw')
      || path.posix.basename(header.path).toLowerCase() === '.excalidraw') return fail('SCENE_SOURCE_PATH_INVALID');
    if (header.path.split('/').length - 1 > MAX_DEPTH) return fail('SCENE_SOURCE_NAMESPACE_LIMIT');
    if (header.provider !== 'excalidraw' || header.status !== 'active' || header.workspace_id !== workspace.workspaceId
      || header.workspace_type !== workspace.workspaceType || header.organization_id !== (workspace.organizationId ?? null)
      || ids.has(header.id) || lineages.has(header.lineage_id) || paths.has(header.path)) return fail('SCENE_SOURCE_CONFLICT');
    ids.add(header.id); lineages.add(header.lineage_id); paths.add(header.path);
  }
}
function overlayScenes(observation: WorkspaceLinkSourceAuthorityObservation, workspace: WorkspaceContext,
  snapshots: readonly WorkspaceSceneSnapshotRecord[]): NativeNamespaceEntry[] {
  const namespace = new Map<string, NativeNamespaceEntry>();
  for (const entry of observation.stage.namespace) {
    if (namespace.has(entry.path) || entry.workspaceId !== workspace.workspaceId) return fail('SCENE_SOURCE_CONFLICT');
    namespace.set(entry.path, Object.freeze({ ...entry }));
  }
  const nativeIds = new Set(observation.stage.namespace.flatMap(entry => entry.documentId ? [entry.documentId] : []));
  for (const binding of observation.nativeBindings) nativeIds.add(binding.expected.documentId);
  const nativeLineages = new Set(observation.nativeBindings.map(binding => binding.expected.lineageId));
  const sourcePaths = new Set(observation.stage.sources.map(source => source.kind === 'physical'
    ? source.inventory.path : source.inventory.document.path));
  for (const header of observation.privateCatalogue ?? []) {
    nativeIds.add(header.id); if (header.lineage_id) nativeLineages.add(header.lineage_id);
  }
  for (const { header, contentProof } of snapshots) {
    const prior = namespace.get(header.path);
    if (prior?.kind === 'directory' || prior?.documentId !== null && prior?.documentId !== undefined
      || nativeIds.has(header.id) || nativeLineages.has(header.lineage_id) || sourcePaths.has(header.path)) return fail('SCENE_SOURCE_CONFLICT');
    namespace.set(header.path, Object.freeze({ workspaceId: workspace.workspaceId, path: header.path, kind: 'file' as const,
      provider: 'excalidraw' as const, identity: `scene:${header.id}:${header.lifecycle_generation}:${contentProof}`,
      documentId: null, lifecycleGeneration: null, filesystemIdentity: prior?.filesystemIdentity ?? null }));
    let parent = path.posix.dirname(header.path);
    while (parent !== '.' && parent !== '/') {
      const actual = namespace.get(parent);
      if (actual?.kind === 'file') return fail('SCENE_SOURCE_CONFLICT');
      // Keep actual physical parent fingerprints. Only an absent ancestor gets
      // the same registry-directory witness used by the native collector.
      if (!actual) namespace.set(parent, Object.freeze({ workspaceId: workspace.workspaceId, path: parent,
        kind: 'directory' as const, identity: `registry-directory:${nativeLinkJsonProof({ workspaceId: workspace.workspaceId, path: parent })}`,
        documentId: null, lifecycleGeneration: null, filesystemIdentity: null }));
      if (namespace.size > MAX_PATHS) return fail('SCENE_SOURCE_NAMESPACE_LIMIT');
      parent = path.posix.dirname(parent);
    }
  }
  for (const entry of namespace.values()) {
    if (namespace.size > MAX_PATHS || !isCanonicalAdmissionPath(entry.path)
      || entry.path.split('/').length - 1 > MAX_DEPTH) return fail('SCENE_SOURCE_NAMESPACE_LIMIT');
    let parent = path.posix.dirname(entry.path);
    while (parent !== '.' && parent !== '/') {
      if (namespace.get(parent)?.kind !== 'directory') return fail('SCENE_SOURCE_CONFLICT');
      parent = path.posix.dirname(parent);
    }
  }
  return [...namespace.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Copy-only source facts on the owner's actual B. The caller retains the
 * kernel and SQL workspace/document fences, its current principal, and the
 * transaction through consumption. No connection/TX/lock/permission is created.
 * Scene bodies come solely from SQL; projection files never supply Scene data. */
export async function readWorkspaceCopySourceObservationOnConnection(connection: SqlConnection,
  workspace: WorkspaceContext, options: WorkspacePhysicalSourceReadOptions = {}): Promise<WorkspaceCopySourceObservation> {
  if (!options || typeof options !== 'object' || types.isProxy(options)
    || Object.getPrototypeOf(options) !== Object.prototype) throw new Error('Invalid physical source parser version.');
  const parserDescriptor = Object.getOwnPropertyDescriptor(options, 'physicalParserVersion');
  if (parserDescriptor && (!parserDescriptor.enumerable || !Object.hasOwn(parserDescriptor, 'value'))) throw new Error('Invalid physical source parser version.');
  const physicalParserVersion = parserDescriptor?.value === undefined ? 2 : parserDescriptor.value;
  if (physicalParserVersion !== 2 && physicalParserVersion !== 3) throw new Error('Invalid physical source parser version.');
  const scope = structuredClone(workspace);
  const catalogue = await readWorkspaceSceneCatalogue(connection, scope, { maxEntries: MAX_PATHS });
  checkSceneHeaders(catalogue, scope);
  const before = await readWorkspaceSceneSnapshotsOnConnection(connection, scope, catalogue, SCENE_LIMITS);
  const observation = await readWorkspaceLinkSourceAuthorityOnConnection(connection, scope, { physicalParserVersion });
  const namespace = overlayScenes(observation, scope, before);
  const currentCatalogue = await readWorkspaceSceneCatalogue(connection, scope, { maxEntries: MAX_PATHS });
  checkSceneHeaders(currentCatalogue, scope);
  if (!isDeepStrictEqual(currentCatalogue, catalogue)) return fail('SCENE_SOURCE_CHANGED');
  const current = await readWorkspaceSceneSnapshotsOnConnection(connection, scope, currentCatalogue, SCENE_LIMITS);
  if (!isDeepStrictEqual(current, before)) return fail('SCENE_SOURCE_CHANGED');
  if (!isDeepStrictEqual(await readWorkspaceSceneCatalogue(connection, scope, { maxEntries: MAX_PATHS }), catalogue)) return fail('SCENE_SOURCE_CHANGED');

  const privateSceneSnapshots = Object.freeze(before.map(snapshot => captureWorkspaceSceneSnapshot(snapshot, SCENE_LIMITS)));
  const privateSceneCatalogue = Object.freeze(privateSceneSnapshots.map(snapshot => snapshot.header));
  const sceneBindings = Object.freeze(privateSceneSnapshots.map(snapshot => Object.freeze({ provider: 'excalidraw' as const,
    header: snapshot.header, contentProof: snapshot.contentProof })));
  Object.freeze(namespace);
  const stageBody = { ...observation.stage, namespace };
  // Preserve every original gap/readiness fact. Adding Scene namespace entries
  // cannot upgrade native/physical link coverage or imply execution readiness.
  const stage = Object.freeze({ ...stageBody, stageProof: workspaceSourceAuthorityStageProof(stageBody) });
  return Object.freeze({ ...observation, stage, sceneBindings, privateSceneSnapshots, privateSceneCatalogue });
}
