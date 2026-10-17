import 'server-only';

import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { isCanonicalWorkspacePath } from '../workspaces/path-identity';
import { readWorkspaceSceneCatalogue, type WorkspaceSceneCatalogueEntry } from '../collaboration/workspace-scene-catalogue';
import type { PersistedExcalidrawScene } from './repository';
import { EXCALIDRAW_COLLABORATION_SCHEMA_VERSION, type ExcalidrawAssetMetadata } from './protocol';
import { EXCALIDRAW_MAX_ASSET_REFERENCES, EXCALIDRAW_PORTABLE_MAX_BYTES } from './limits';
import { captureExcalidrawReadonlyAssetMetadata, ExcalidrawReadonlyAssetError } from './readonly-assets';
import { canonicalSceneHash, sharedExcalidrawAppState, validateExcalidrawElements,
  validateExcalidrawSceneAssetReferences, validateExcalidrawSceneReferences } from './scene';

export type WorkspaceSceneSnapshotOptions = { maxSceneBytes?: number; maxTotalBytes?: number };
export type WorkspaceSceneSnapshotRecord = Readonly<{
  version: 1;
  header: Readonly<WorkspaceSceneCatalogueEntry>;
  scene: Readonly<PersistedExcalidrawScene>;
  /** Integrity of detached data, never a current-state or mutation capability. */
  contentProof: string;
}>;
type SnapshotErrorCode = 'SCENE_SNAPSHOT_INVALID' | 'SCENE_SNAPSHOT_CHANGED' | 'SCENE_SNAPSHOT_TOO_LARGE';
export class WorkspaceSceneSnapshotError extends Error {
  readonly status: 409 | 413;
  constructor(readonly code: SnapshotErrorCode) {
    super('The captured workspace scene could not be verified within its read budget.');
    this.name = 'WorkspaceSceneSnapshotError'; this.status = code === 'SCENE_SNAPSHOT_TOO_LARGE' ? 413 : 409;
  }
}
const invalid = (): never => { throw new WorkspaceSceneSnapshotError('SCENE_SNAPSHOT_INVALID'); };
const changed = (): never => { throw new WorkspaceSceneSnapshotError('SCENE_SNAPSHOT_CHANGED'); };
const tooLarge = (): never => { throw new WorkspaceSceneSnapshotError('SCENE_SNAPSHOT_TOO_LARGE'); };
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const HEADER_ALLOWANCE = 64 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= minimum && !Object.is(value, -0);
const nullableId = (value: unknown) => value === null || id(value);
const nullableHash = (value: unknown) => value === null || typeof value === 'string' && HASH.test(value);

/** Reject accessors/proxies/non-JSON data before inspecting untrusted stage data.
 * Bounds include keys, dense array slots, recursion and serialized bytes. */
function captureData(input: unknown, limit: number): unknown {
  let nodes = 0, bytes = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 2_000_000 || depth > 40) return tooLarge();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value) || Object.is(value, -0)) return invalid(); return value; }
    if (typeof value === 'string') { bytes += Buffer.byteLength(value); if (bytes > limit) return tooLarge(); return value; }
    if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)
      || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return invalid();
    ancestors.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      if (value.length > 100_000) return tooLarge();
      if (Reflect.ownKeys(value).length !== value.length + 1) return invalid();
      result = Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor)) return invalid();
        return visit(descriptor.value, depth + 1);
      });
    } else {
      const output: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) return invalid();
        bytes += Buffer.byteLength(key); if (bytes > limit) return tooLarge();
        Object.defineProperty(output, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      result = output;
    }
    ancestors.delete(value); return result;
  };
  const result = visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > limit) return tooLarge();
  return result;
}
function exactObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) return invalid();
  return value as Record<string, unknown>;
}
function canonicalJson(value: unknown): string {
  const ordered = (input: unknown): unknown => Array.isArray(input) ? input.map(ordered)
    : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, ordered(child)])) : input;
  return JSON.stringify(ordered(value));
}
function freezeData<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeData); Object.freeze(value); }
  return value;
}
function limits(options: WorkspaceSceneSnapshotOptions): Required<WorkspaceSceneSnapshotOptions> {
  const value = captureData(options, HEADER_ALLOWANCE);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'maxSceneBytes' && key !== 'maxTotalBytes')) return invalid();
  const record = value as WorkspaceSceneSnapshotOptions;
  const maxSceneBytes = record.maxSceneBytes === undefined ? EXCALIDRAW_PORTABLE_MAX_BYTES : record.maxSceneBytes;
  const maxTotalBytes = record.maxTotalBytes === undefined ? MAX_TOTAL_BYTES : record.maxTotalBytes;
  if (!integer(maxSceneBytes, 1) || maxSceneBytes > EXCALIDRAW_PORTABLE_MAX_BYTES
    || !integer(maxTotalBytes, 1) || maxTotalBytes > MAX_TOTAL_BYTES) return invalid();
  return { maxSceneBytes, maxTotalBytes };
}
const headerFields = ['id', 'lineage_id', 'workspace_id', 'workspace_type', 'organization_id', 'customer_id', 'project_id',
  'path', 'provider', 'status', 'state_version', 'has_persisted_state', 'authority', 'state_document_id', 'state_workspace_id',
  'state_organization_id', 'state_path', 'state_status', 'lifecycle_generation', 'scene_schema_version', 'excalidraw_version',
  'scene_sequence', 'checkpoint_sequence', 'canonical_hash', 'elements_bytes', 'shared_app_state_bytes', 'assets_bytes',
  'lineage_row_id', 'lineage_workspace_id', 'lineage_workspace_type', 'lineage_organization_id', 'lineage_customer_id',
  'lineage_project_id', 'lineage_path', 'lineage_status', 'lineage_archived_at', 'lineage_trash_entry_id'] as const;
function captureHeader(input: unknown): WorkspaceSceneCatalogueEntry {
  const value = exactObject(captureData(input, HEADER_ALLOWANCE), headerFields);
  if (!id(value.id) || !id(value.lineage_id) || !id(value.workspace_id)
    || !['personal', 'organization', 'team', 'project'].includes(String(value.workspace_type))
    || !nullableId(value.organization_id) || !nullableId(value.customer_id) || !nullableId(value.project_id)
    || !isCanonicalWorkspacePath(value.path) || value.provider !== 'excalidraw' || value.status !== 'active'
    || !integer(value.state_version) || value.authority !== 'initialized' || value.has_persisted_state !== true
    || value.state_document_id !== value.id || value.state_workspace_id !== value.workspace_id
    || value.state_organization_id !== value.organization_id || value.state_path !== value.path || value.state_status !== 'active'
    || !integer(value.lifecycle_generation, 1) || value.scene_schema_version !== EXCALIDRAW_COLLABORATION_SCHEMA_VERSION
    || !id(value.excalidraw_version) || !integer(value.scene_sequence) || !integer(value.checkpoint_sequence)
    || value.checkpoint_sequence > value.scene_sequence || typeof value.canonical_hash !== 'string' || !HASH.test(value.canonical_hash)
    || !integer(value.elements_bytes, 1) || !integer(value.shared_app_state_bytes, 1) || !integer(value.assets_bytes, 1)
    || value.lineage_row_id !== value.lineage_id || value.lineage_workspace_id !== value.workspace_id
    || value.lineage_workspace_type !== value.workspace_type || value.lineage_organization_id !== value.organization_id
    || !nullableId(value.lineage_customer_id) || !nullableId(value.lineage_project_id) || value.lineage_path !== value.path
    || value.lineage_status !== 'active' || value.lineage_archived_at !== null || !nullableId(value.lineage_trash_entry_id)
    || value.customer_id !== null && value.lineage_customer_id !== null && value.customer_id !== value.lineage_customer_id
    || value.project_id !== null && value.lineage_project_id !== null && value.project_id !== value.lineage_project_id) return invalid();
  return freezeData(value as unknown as WorkspaceSceneCatalogueEntry);
}
/** Header data decoder only; no scene content or current authority is inferred. */
export { captureHeader as captureWorkspaceSceneSnapshotHeader };
function headerBytes(header: Readonly<WorkspaceSceneCatalogueEntry>): number {
  const bytes = header.elements_bytes! + header.shared_app_state_bytes! + header.assets_bytes!;
  if (!integer(bytes, 1)) return tooLarge(); return bytes;
}
const sceneFields = ['documentId', 'workspaceId', 'organizationId', 'path', 'lifecycleGeneration', 'excalidrawVersion',
  'sceneSchemaVersion', 'elements', 'appState', 'assets', 'sceneSequence', 'checkpointSequence', 'checkpointRevisionId',
  'checkpointContentHash', 'canonicalHash', 'persistedAt', 'checkpointedAt', 'degradedReason', 'status'] as const;
function validateScene(input: unknown, header: Readonly<WorkspaceSceneCatalogueEntry>, maxBytes: number): PersistedExcalidrawScene {
  const scene = exactObject(input, sceneFields);
  if (scene.documentId !== header.id || scene.workspaceId !== header.workspace_id || scene.organizationId !== header.organization_id
    || scene.path !== header.path || scene.lifecycleGeneration !== header.lifecycle_generation
    || scene.excalidrawVersion !== header.excalidraw_version || scene.sceneSchemaVersion !== header.scene_schema_version
    || scene.sceneSequence !== header.scene_sequence || scene.checkpointSequence !== header.checkpoint_sequence
    || scene.canonicalHash !== header.canonical_hash || scene.status !== 'active' || !integer(scene.persistedAt)
    || scene.checkpointedAt !== null && !integer(scene.checkpointedAt)
    || !nullableId(scene.checkpointRevisionId) || !nullableHash(scene.checkpointContentHash)
    || scene.degradedReason !== null && (typeof scene.degradedReason !== 'string' || scene.degradedReason.length > 4096)) return invalid();
  if (!scene.appState || typeof scene.appState !== 'object' || Array.isArray(scene.appState) || !Array.isArray(scene.assets)) return invalid();
  if (scene.assets.length > EXCALIDRAW_MAX_ASSET_REFERENCES) return tooLarge();
  try {
    const elements = validateExcalidrawElements(scene.elements, 'scene');
    const appState = sharedExcalidrawAppState(scene.appState);
    if (canonicalJson(appState) !== canonicalJson(scene.appState)) return invalid();
    const assets = scene.assets.map(captureExcalidrawReadonlyAssetMetadata);
    if (new Set(assets.map(asset => asset.fileId)).size !== assets.length) return invalid();
    if (assets.reduce((total, asset) => total + asset.sizeBytes, 0) > EXCALIDRAW_PORTABLE_MAX_BYTES) return tooLarge();
    validateExcalidrawSceneReferences(elements); validateExcalidrawSceneAssetReferences(elements, assets);
    if (Buffer.byteLength(JSON.stringify(elements)) + Buffer.byteLength(JSON.stringify(appState))
      + Buffer.byteLength(JSON.stringify(assets)) > maxBytes) return tooLarge();
    if (canonicalSceneHash({ elements, appState, assets }) !== scene.canonicalHash) return changed();
    return { ...scene, elements, appState, assets: assets as ExcalidrawAssetMetadata[] } as PersistedExcalidrawScene;
  } catch (error) {
    if (error instanceof WorkspaceSceneSnapshotError) throw error;
    if (error instanceof ExcalidrawReadonlyAssetError && error.status === 413) return tooLarge();
    return invalid();
  }
}
function proof(header: Readonly<WorkspaceSceneCatalogueEntry>, scene: Readonly<PersistedExcalidrawScene>): string {
  return createHash('sha256').update(canonicalJson({ version: 1, header, scene })).digest('hex');
}

/** Pure, detached and deeply frozen stage decoder. A valid proof asserts data
 * integrity only; the caller must separately revalidate SQL identity and fences. */
export function captureWorkspaceSceneSnapshot(input: unknown, options: WorkspaceSceneSnapshotOptions = {}): WorkspaceSceneSnapshotRecord {
  const bounds = limits(options);
  const record = exactObject(captureData(input, Math.min(bounds.maxSceneBytes, bounds.maxTotalBytes) + HEADER_ALLOWANCE), ['version', 'header', 'scene', 'contentProof']);
  if (record.version !== 1 || typeof record.contentProof !== 'string' || !HASH.test(record.contentProof)) return invalid();
  const header = captureHeader(record.header);
  if (headerBytes(header) > bounds.maxSceneBytes || headerBytes(header) > bounds.maxTotalBytes) return tooLarge();
  const scene = validateScene(record.scene, header, Math.min(bounds.maxSceneBytes, bounds.maxTotalBytes));
  if (proof(header, scene) !== record.contentProof) return changed();
  return freezeData({ version: 1 as const, header, scene, contentProof: record.contentProof });
}

function sqlInteger(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value))) return changed();
  const number = Number(value); if (!integer(number)) return changed(); return number;
}
type StateRow = Record<string, unknown>;
const stateBindings = { document_id: 'id', workspace_id: 'workspace_id', organization_id: 'organization_id', path: 'path',
  lifecycle_generation: 'lifecycle_generation', excalidraw_version: 'excalidraw_version', scene_schema_version: 'scene_schema_version',
  scene_sequence: 'scene_sequence', checkpoint_sequence: 'checkpoint_sequence', canonical_hash: 'canonical_hash', status: 'state_status',
  elements_bytes: 'elements_bytes', shared_app_state_bytes: 'shared_app_state_bytes', assets_bytes: 'assets_bytes' } as const;
const sqlNumbers = new Set(['lifecycle_generation', 'scene_schema_version', 'scene_sequence', 'checkpoint_sequence',
  'elements_bytes', 'shared_app_state_bytes', 'assets_bytes', 'persisted_at', 'checkpointed_at']);
function stateHeader(row: StateRow, header: Readonly<WorkspaceSceneCatalogueEntry>): StateRow {
  const output: StateRow = {};
  for (const [field, binding] of Object.entries(stateBindings)) {
    const value = sqlNumbers.has(field) ? sqlInteger(row[field]) : row[field];
    if (value !== header[binding as keyof WorkspaceSceneCatalogueEntry]) return changed(); output[field] = value;
  }
  for (const field of ['checkpoint_revision_id', 'checkpoint_content_hash', 'persisted_at', 'checkpointed_at', 'degraded_reason']) {
    output[field] = sqlNumbers.has(field) && row[field] !== null ? sqlInteger(row[field]) : row[field];
  }
  return output;
}
async function readRows(connection: SqlConnection, workspaceId: string, headers: readonly Readonly<WorkspaceSceneCatalogueEntry>[], bodies: boolean): Promise<Map<string, StateRow>> {
  // CASE prevents a concurrently enlarged JSON value from crossing the SQL
  // boundary. Size checks apply to all three bodies before returning any body.
  const rows = await connection.all(`SELECT s.document_id,s.workspace_id,s.organization_id,s.path,s.lifecycle_generation,
    s.excalidraw_version,s.scene_schema_version,s.scene_sequence,s.checkpoint_sequence,s.checkpoint_revision_id,
    s.checkpoint_content_hash,s.canonical_hash,s.persisted_at,s.checkpointed_at,s.degraded_reason,s.status,
    octet_length(s.elements_json::text) AS elements_bytes,octet_length(s.shared_app_state_json::text) AS shared_app_state_bytes,
    octet_length(s.assets_json::text) AS assets_bytes,
    CASE WHEN $6::boolean AND octet_length(s.elements_json::text)=r.eb AND octet_length(s.shared_app_state_json::text)=r.ab
      AND octet_length(s.assets_json::text)=r.fb THEN s.elements_json::text END AS elements_json_text,
    CASE WHEN $6::boolean AND octet_length(s.elements_json::text)=r.eb AND octet_length(s.shared_app_state_json::text)=r.ab
      AND octet_length(s.assets_json::text)=r.fb THEN s.shared_app_state_json::text END AS shared_app_state_json_text,
    CASE WHEN $6::boolean AND octet_length(s.elements_json::text)=r.eb AND octet_length(s.shared_app_state_json::text)=r.ab
      AND octet_length(s.assets_json::text)=r.fb THEN s.assets_json::text END AS assets_json_text
    FROM unnest($2::text[],$3::bigint[],$4::bigint[],$5::bigint[]) r(id,eb,ab,fb)
    JOIN collaboration_excalidraw_states s ON s.document_id=r.id
    WHERE s.workspace_id=$1 AND s.status='active'
      AND char_length(s.path)<=4096 AND char_length(s.excalidraw_version)<=256
      AND (s.organization_id IS NULL OR char_length(s.organization_id)<=256)
      AND (s.checkpoint_revision_id IS NULL OR char_length(s.checkpoint_revision_id)<=256)
      AND (s.checkpoint_content_hash IS NULL OR char_length(s.checkpoint_content_hash)<=64)
      AND (s.degraded_reason IS NULL OR char_length(s.degraded_reason)<=4096)
    ORDER BY s.document_id LIMIT $7`,
  [workspaceId, headers.map(header => header.id), headers.map(header => header.elements_bytes),
    headers.map(header => header.shared_app_state_bytes), headers.map(header => header.assets_bytes), bodies, headers.length + 1]);
  if (!Array.isArray(rows) || rows.length !== headers.length) return changed();
  const indexed = new Map<string, StateRow>();
  for (const value of rows) {
    if (!value || typeof value !== 'object' || !id((value as StateRow).document_id) || indexed.has((value as StateRow).document_id as string)) return changed();
    indexed.set((value as StateRow).document_id as string, value as StateRow);
  }
  return indexed;
}
async function assertCatalogue(connection: SqlConnection, workspace: WorkspaceContext, headers: readonly Readonly<WorkspaceSceneCatalogueEntry>[]): Promise<void> {
  let actual: WorkspaceSceneCatalogueEntry[];
  try { actual = await readWorkspaceSceneCatalogue(connection, workspace, { paths: headers.map(header => header.path) }); }
  catch { return changed(); }
  if (actual.length !== headers.length) return changed();
  const indexed = new Map(actual.map(header => [header.id, header]));
  for (const header of headers) if (canonicalJson(indexed.get(header.id)) !== canonicalJson(header)) return changed();
}

/** Read-only facts on the caller's actual connection. The owner must already
 * hold its stable document/lifecycle locks and retain them through consumption.
 * No provider checkout, transaction, bootstrap, projection or blob IO occurs. */
export async function readWorkspaceSceneSnapshotsOnConnection(connection: SqlConnection, workspace: WorkspaceContext,
  catalogueEntries: readonly WorkspaceSceneCatalogueEntry[], options: WorkspaceSceneSnapshotOptions = {}): Promise<readonly WorkspaceSceneSnapshotRecord[]> {
  if (!workspace.permissions.canRead || workspace.status !== undefined && workspace.status !== 'active' || !id(workspace.workspaceId)) {
    throw Object.assign(new Error('The workspace scene snapshots are unavailable.'), { status: 403 });
  }
  const bounds = limits(options);
  if (!Array.isArray(catalogueEntries) || types.isProxy(catalogueEntries)) return invalid();
  if (catalogueEntries.length > 10_000) return tooLarge();
  if (Reflect.ownKeys(catalogueEntries).length !== catalogueEntries.length + 1) return invalid();
  const headers: Readonly<WorkspaceSceneCatalogueEntry>[] = [], ids = new Set<string>(), paths = new Set<string>();
  let total = 0;
  for (let index = 0; index < catalogueEntries.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(catalogueEntries, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) return invalid();
    const header = captureHeader(descriptor.value);
    if (header.workspace_id !== workspace.workspaceId || header.workspace_type !== workspace.workspaceType
      || header.organization_id !== (workspace.organizationId ?? null) || ids.has(header.id) || paths.has(header.path)) return invalid();
    for (const [field, expected] of [['customer_id', workspace.customerId ?? null], ['project_id', workspace.projectId ?? null]] as const) {
      if (header[field] !== null && header[field] !== expected
        || header[`lineage_${field}`] !== null && header[`lineage_${field}`] !== expected) return invalid();
    }
    const bytes = headerBytes(header); total += bytes;
    if (bytes > bounds.maxSceneBytes || total > bounds.maxTotalBytes) return tooLarge();
    headers.push(freezeData(header)); ids.add(header.id); paths.add(header.path);
  }
  if (!headers.length) return Object.freeze([]);
  // Capture scalar scope before awaiting. Caller-controlled object mutation is
  // not allowed to redirect a later check to a different workspace.
  const scope: WorkspaceContext = { ...workspace, permissions: { ...workspace.permissions } };
  await assertCatalogue(connection, scope, headers);
  const rows = await readRows(connection, scope.workspaceId, headers, true);
  const snapshots: WorkspaceSceneSnapshotRecord[] = [], observed = new Map<string, StateRow>();
  for (const header of headers) {
    const row = rows.get(header.id); if (!row) return changed();
    const raw = stateHeader(row, header); observed.set(header.id, raw);
    const decode = (field: string, bytes: number): unknown => {
      const text = row[field]; if (typeof text !== 'string' || Buffer.byteLength(text) !== bytes) return changed();
      try { return captureData(JSON.parse(text), bounds.maxSceneBytes); } catch (error) {
        if (error instanceof WorkspaceSceneSnapshotError) throw error; return invalid();
      }
    };
    const scene = validateScene({ documentId: raw.document_id, workspaceId: raw.workspace_id, organizationId: raw.organization_id,
      path: raw.path, lifecycleGeneration: raw.lifecycle_generation, excalidrawVersion: raw.excalidraw_version,
      sceneSchemaVersion: raw.scene_schema_version, sceneSequence: raw.scene_sequence, checkpointSequence: raw.checkpoint_sequence,
      checkpointRevisionId: raw.checkpoint_revision_id, checkpointContentHash: raw.checkpoint_content_hash,
      canonicalHash: raw.canonical_hash, persistedAt: raw.persisted_at, checkpointedAt: raw.checkpointed_at,
      degradedReason: raw.degraded_reason, status: raw.status, elements: decode('elements_json_text', header.elements_bytes!),
      appState: decode('shared_app_state_json_text', header.shared_app_state_bytes!), assets: decode('assets_json_text', header.assets_bytes!) }, header, bounds.maxSceneBytes);
    snapshots.push(freezeData({ version: 1 as const, header, scene, contentProof: proof(header, scene) }));
  }
  const after = await readRows(connection, scope.workspaceId, headers, false);
  for (const header of headers) {
    const row = after.get(header.id); if (!row || canonicalJson(stateHeader(row, header)) !== canonicalJson(observed.get(header.id))) return changed();
  }
  await assertCatalogue(connection, scope, headers);
  return Object.freeze(snapshots);
}
