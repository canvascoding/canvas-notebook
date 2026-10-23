import 'server-only';

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { openDb, type SqlConnection } from '../db';
import { loadCollaborationStateOnConnection, type PersistedCollaborationState } from '../collaboration/persistence';
import { mapValidatedNativeStateRow, validateRawState } from '../collaboration/native-session-state-reader';
import { inspectPersistedNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { assertNativeDocumentSchema } from '../collaboration/native-document-schema';
import { getNativeInspectionSchema } from '../collaboration/native-inspection-schema';
import type { NativeFileArchiveExpected } from '../collaboration/native-file-archive-transition';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { readWorkspaceDocumentCatalogue, type WorkspaceDocumentCatalogueEntry } from '../collaboration/workspace-document-catalogue';
import { isInternalWorkspaceStagingPath } from '../files/internal-staging-path';
import { readOriginalMoveCollectorOverlay } from '../files/workspace-operation-original-move-sources';
import { assertWorkspaceOriginalPathsCurrent, readWorkspaceOriginalFileSource, WorkspaceOriginalFileSourceError,
  type WorkspaceOriginalPathObservation, type WorkspaceOriginalRootObservation } from '../files/workspace-original-file-source';
import { filesystemFileVersion } from '../filesystem/file-version';
import { assertWorkspacePathHasNoAliases } from '../workspaces/path-guard';
import type { WorkspaceContext } from '../workspaces/types';
import type { WorkspaceSceneCatalogueEntry } from '../collaboration/workspace-scene-catalogue';
import type { WorkspaceSceneSnapshotRecord } from '../excalidraw-collaboration/workspace-scene-snapshot';
import type { WorkspaceSceneSourceBinding } from '../files/workspace-operation-copy-source-observation';
import { MAX_INDEXED_MARKDOWN_BYTES } from './workspace-link-limits';
import { inspectNativeDocumentLinks, nativeLinkJsonProof } from './workspace-native-link-inventory';
import type { NativeDocumentLinkInventory, NativeNamespaceEntry } from './workspace-link-contract-v2';
import { inspectOriginalPhysicalLinks, inspectOriginalPhysicalLinksV3, workspaceSourceAuthorityStageProof, type PhysicalSourceGap,
  type WorkspaceSourceAuthorityStage } from './workspace-physical-link-inventory';

type Limits = { maxPaths: number; maxDepth: number; maxSourceBytes: number; maxTotalSourceBytes: number; maxLinks: number };
type Dependencies = {
  openConnection?: () => Promise<SqlConnection>;
  loadState?: typeof loadCollaborationStateOnConnection;
  /** Fault-injection seam: authority/path/inode are rechecked AFTER this await. */
  afterSourceFingerprint?: (relativePath: string) => Promise<void>;
  limits?: Partial<Limits>;
};
const DEFAULT_LIMITS: Limits = { maxPaths: 10_000, maxDepth: 32, maxSourceBytes: MAX_INDEXED_MARKDOWN_BYTES,
  maxTotalSourceBytes: 32 * 1024 * 1024, maxLinks: 20_000 };
// Same visible-workspace domain as workspace-files/listDirectory. Exclusions
// are explicit in the stage scope; ignored internal backups are not link sources.
const EXCLUDED_DIRECTORIES = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.cache', '.canvas-brand', '.canvas-copy-backups']);
const EXCLUDED_FILES = new Set(['.gitkeep', '.keep']);
class PhysicalStageConflict extends Error {
  constructor(readonly code: string, readonly filePath: string) { super(code); }
}
class ConfirmedSourceReadChange extends PhysicalStageConflict {}
const fail = (code: string, filePath: string): never => { throw new PhysicalStageConflict(code, filePath); };

export type WorkspaceNativeSourceBinding = Readonly<{
  expected: NativeFileArchiveExpected;
  registry: Readonly<{ documentId: string; lineageId: string; workspaceId: string; workspaceType: WorkspaceContext['workspaceType'];
    organizationId: string | null; customerId: string | null; projectId: string | null; path: string;
    provider: 'yjs'; stateLifecycle: 'initialized'; stateVersion: number; status: 'active' }>;
  lineage: Readonly<{ lineageId: string; workspaceId: string; workspaceType: WorkspaceContext['workspaceType'];
    organizationId: string | null; customerId: string | null; projectId: string | null; path: string;
    status: 'active'; archivedAt: null; trashEntryId: string | null }>;
  byteProfile: Readonly<{ newlineStyle: 'lf' | 'crlf'; hasBom: boolean }>;
  inventoryProof: string;
}>;
export type WorkspaceLinkSourceAuthorityObservation = Readonly<{
  stage: WorkspaceSourceAuthorityStage;
  nativeBindings: readonly WorkspaceNativeSourceBinding[];
  /** Private transient compiler inputs, never serialized plan data or authority. */
  privateNativeStates: readonly PersistedCollaborationState[];
  /** Private transient full catalogue witness, never serialized stage data or authority. */
  privateCatalogue?: readonly Readonly<WorkspaceDocumentCatalogueEntry>[];
  /** Scene provider component. Historical Yjs-only observers omit these. */
  sceneBindings?: readonly WorkspaceSceneSourceBinding[];
  privateSceneSnapshots?: readonly WorkspaceSceneSnapshotRecord[];
  privateSceneCatalogue?: readonly Readonly<WorkspaceSceneCatalogueEntry>[];
}>;
// Rejection-only provenance. No public DTO field or current authority is cached.
const confirmedSourceReadChanges = new WeakSet<WorkspaceLinkSourceAuthorityObservation>();
export function requiresWorkspaceLinkSourceAuthorityRevalidation(observation: WorkspaceLinkSourceAuthorityObservation): boolean {
  return confirmedSourceReadChanges.has(observation);
}
/** A data-reader choice only. It never changes the caller's fences or rights. */
export type WorkspacePhysicalSourceReadOptions = Readonly<{ physicalParserVersion?: 2 | 3 }>;
type CollectorDependencies = Omit<Dependencies, 'openConnection'> & WorkspacePhysicalSourceReadOptions;
type Row = Record<string, unknown>;
const MAX_VECTOR_BYTES = 1024 * 1024;
const stateMetadata = ['document_id', 'workspace_id', 'organization_id', 'path', 'representation', 'lifecycle_generation',
  'schema_version', 'status', 'document_sequence', 'persisted_at', 'checkpoint_sequence', 'checkpointed_at', 'newline_style',
  'has_bom', 'degraded', 'projection_error_code', 'projection_error_sequence', 'projection_error_generation',
  'projection_error_phase', 'projection_error_permanent'] as const;
const bytesHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const validInteger = (value: unknown, minimum = 0): boolean => (typeof value === 'number'
  || typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) && Number.isSafeInteger(Number(value))
  && Number(value) >= minimum && Number(value) < Number.MAX_SAFE_INTEGER;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value).toString('utf8') === value;

type NativeSourceRead = { binding: WorkspaceNativeSourceBinding; state: PersistedCollaborationState;
  inventory: NativeDocumentLinkInventory; byteLength: number };

function nativeSourceHeader(workspace: WorkspaceContext, document: WorkspaceDocumentCatalogueEntry, rows: Row | undefined,
  limits: Limits): Row {
  const organizationId = workspace.organizationId ?? null;
  if (!rows || rows.requested_document_id !== document.id || rows.requested_lineage_id !== document.lineage_id
    || rows.id !== document.id || rows.lineage_id !== document.lineage_id || rows.lineage_id_actual !== document.lineage_id
    || rows.workspace_id !== workspace.workspaceId || rows.workspace_type !== workspace.workspaceType || rows.organization_id !== organizationId
    || rows.path !== document.path || rows.provider !== 'yjs' || rows.status !== 'active' || rows.yjs_state_lifecycle !== 'initialized'
    || !validInteger(rows.state_version) || Number(rows.state_version) !== document.state_version
    || rows.lineage_workspace_id !== workspace.workspaceId || rows.lineage_workspace_type !== workspace.workspaceType
    || rows.lineage_organization_id !== organizationId || rows.lineage_path !== document.path || rows.lineage_status !== 'active'
    || rows.lineage_archived_at !== null || rows.lineage_trash_entry_id !== null && !validId(rows.lineage_trash_entry_id)) {
    fail('native-identity-conflict', document.path);
  }
  for (const [field, expected] of [['customer_id', workspace.customerId ?? null], ['project_id', workspace.projectId ?? null]] as const) {
    for (const value of [rows![field], rows![`lineage_${field}`]]) if (value !== null && (!validId(value) || value !== expected)) fail('native-identity-conflict', document.path);
  }
  // Header-only join: validate all raw metadata and byte lengths before the
  // separate bounded binary read. Do not select either binary in this query.
  if (rows!.state_document_id === null) fail('missing-native-state', document.path);
  const metadata: Row = { ...Object.fromEntries(stateMetadata.map(key => [key, rows![`state_${key}`]])),
    state_bytes: rows!.state_bytes, vector_bytes: rows!.vector_bytes };
  validateRawState(metadata!);
  if (!validInteger(metadata!.state_bytes, 1) || !validInteger(metadata!.vector_bytes, 1)
    || Number(metadata!.state_bytes) > limits.maxSourceBytes || Number(metadata!.vector_bytes) > MAX_VECTOR_BYTES) fail('source-byte-limit', document.path);
  return metadata;
}

async function readNativeSource(workspace: WorkspaceContext, document: WorkspaceDocumentCatalogueEntry,
  rows: Row, metadata: Row, raw: Row | undefined, loadState?: Dependencies['loadState']): Promise<NativeSourceRead> {
  const organizationId = workspace.organizationId ?? null;
  if (!raw || !(raw.yjs_state instanceof Uint8Array) || !(raw.state_vector instanceof Uint8Array)
    || raw.yjs_state.byteLength !== Number(metadata!.state_bytes) || raw.state_vector.byteLength !== Number(metadata!.vector_bytes)
    || stateMetadata.some(key => !Object.is(raw[key], metadata![key]))) fail('native-source-changed', document.path);
  const state = await mapValidatedNativeStateRow(raw!, document.id);
  if (!state || state.documentId !== document.id || state.workspaceId !== workspace.workspaceId || state.organizationId !== organizationId
    || state.path !== document.path || state.lifecycleGeneration !== document.lifecycle_generation
    || Number(rows!.state_version) > state.documentSequence) fail('native-identity-conflict', document.path);
  if (loadState) {
    // Legacy fault hook receives only the already-read row. Its result can reject
    // this observation but NEVER replace SQL data or bypass any strict check.
    const candidate = await loadState({ get: (sql, values) => {
      if (sql.replace(/\s+/gu, ' ').trim() !== 'SELECT * FROM collaboration_yjs_states WHERE document_id = $1 LIMIT 1'
        || values?.length !== 1 || values[0] !== document.id) fail('native-identity-conflict', document.path);
      return { ...raw, yjs_state: Uint8Array.from(state!.yjsState), state_vector: Uint8Array.from(state!.stateVector),
        has_bom: state!.hasBom ? 1 : 0, degraded: state!.degraded ? 1 : 0,
        projection_error_permanent: Number(raw!.projection_error_permanent) };
    } }, document.id, true);
    if (!isDeepStrictEqual(candidate, state)) fail('native-source-changed', document.path);
  }
  const inventory = inspectPersistedNativeCollaborationSnapshot(state!, (doc, snapshot) => {
    assertNativeDocumentSchema(doc, state!.representation, getNativeInspectionSchema());
    return inspectNativeDocumentLinks(doc, snapshot);
  });
  const expected: NativeFileArchiveExpected = Object.freeze({ documentId: document.id, lineageId: document.lineage_id!,
    workspaceId: workspace.workspaceId, organizationId, path: document.path, representation: state!.representation,
    schemaVersion: state!.schemaVersion, lifecycleGeneration: state!.lifecycleGeneration, registryStateVersion: Number(rows!.state_version),
    documentSequence: state!.documentSequence, persistedAt: state!.persistedAt, stateProof: inventory.version.stateProof,
    binaryHash: bytesHash(state!.yjsState), vectorHash: bytesHash(state!.stateVector) });
  const binding: WorkspaceNativeSourceBinding = Object.freeze({ expected,
    registry: Object.freeze({ documentId: document.id, lineageId: document.lineage_id!, workspaceId: workspace.workspaceId,
      workspaceType: workspace.workspaceType, organizationId, customerId: rows!.customer_id as string | null,
      projectId: rows!.project_id as string | null, path: document.path, provider: 'yjs', stateLifecycle: 'initialized',
      stateVersion: Number(rows!.state_version), status: 'active' }),
    lineage: Object.freeze({ lineageId: document.lineage_id!, workspaceId: workspace.workspaceId, workspaceType: workspace.workspaceType,
      organizationId, customerId: rows!.lineage_customer_id as string | null, projectId: rows!.lineage_project_id as string | null,
      path: document.path, status: 'active', archivedAt: null, trashEntryId: rows!.lineage_trash_entry_id as string | null }),
    byteProfile: Object.freeze({ newlineStyle: state!.newlineStyle, hasBom: state!.hasBom }), inventoryProof: nativeLinkJsonProof(inventory) });
  return { binding, state: state!, inventory, byteLength: state!.yjsState.byteLength + state!.stateVector.byteLength };
}

/** Two actual bounded SQL reads per pass, independent of document count. Rows
 * remain private observations, never caller-supplied authority or a cache. */
async function readNativeSources(connection: SqlConnection, workspace: WorkspaceContext,
  documents: readonly WorkspaceDocumentCatalogueEntry[], limits: Limits, remainingBytes: number,
  loadState?: Dependencies['loadState']): Promise<NativeSourceRead[]> {
  if (!documents.length) return [];
  if (documents.length > limits.maxPaths || new Set(documents.map(document => document.id)).size !== documents.length
    || documents.some(document => !validId(document.id) || !validId(document.lineage_id))) fail('native-identity-conflict', '');
  const ids = documents.map(document => document.id), lineages = documents.map(document => document.lineage_id), selectedIds = new Set(ids);
  const headers = await connection.all(`SELECT requested.document_id AS requested_document_id,requested.lineage_id AS requested_lineage_id,
    d.id,d.lineage_id,d.workspace_id,d.workspace_type,d.organization_id,d.customer_id,d.project_id,
    d.path,d.provider,d.status,d.state_version,d.yjs_state_lifecycle,l.id AS lineage_id_actual,l.workspace_id AS lineage_workspace_id,
    l.workspace_type AS lineage_workspace_type,l.organization_id AS lineage_organization_id,l.customer_id AS lineage_customer_id,
    l.project_id AS lineage_project_id,l.path AS lineage_path,l.status AS lineage_status,l.archived_at AS lineage_archived_at,
    l.trash_entry_id AS lineage_trash_entry_id,${stateMetadata.map(key => `s.${key} AS state_${key}`).join(',')},
    octet_length(s.yjs_state) AS state_bytes,octet_length(s.state_vector) AS vector_bytes
    FROM unnest($1::text[],$2::text[]) WITH ORDINALITY AS requested(document_id,lineage_id,ordinal)
    LEFT JOIN collaboration_documents d ON d.id=requested.document_id AND d.lineage_id=requested.lineage_id
    LEFT JOIN file_collaboration_lineages l ON l.id=d.lineage_id
    LEFT JOIN collaboration_yjs_states s ON s.document_id=d.id ORDER BY requested.ordinal LIMIT $3`, [ids, lineages, documents.length + 1]) as Row[];
  const byId = new Map(headers.map(row => [row.requested_document_id, row]));
  if (headers.length !== documents.length || byId.size !== documents.length
    || headers.some(row => !selectedIds.has(row.requested_document_id as string))) fail('native-source-changed', '');
  const metadata = documents.map(document => nativeSourceHeader(workspace, document, byId.get(document.id), limits));
  const stateLengths = metadata.map(row => Number(row.state_bytes)), vectorLengths = metadata.map(row => Number(row.vector_bytes));
  if (metadata.reduce((sum, row) => sum + Number(row.state_bytes) + Number(row.vector_bytes), 0) > remainingBytes) fail('source-byte-limit', '');
  // Count ALL rows for each selected ID before exposing any binary payload,
  // including duplicates with different lengths. This statement's snapshot
  // keeps the precomputed total bound valid even without a state-table PK.
  const raws = await connection.all(`WITH expected AS MATERIALIZED (
      SELECT * FROM unnest($1::text[],$2::bigint[],$3::bigint[])
        WITH ORDINALITY AS requested(document_id,state_bytes,vector_bytes,ordinal)
    ), singleton_states AS MATERIALIZED (
      SELECT document_id FROM collaboration_yjs_states WHERE document_id=ANY($1::text[])
        GROUP BY document_id HAVING count(*)=1
    ) SELECT s.* FROM expected
    INNER JOIN singleton_states singleton ON singleton.document_id=expected.document_id
    INNER JOIN collaboration_yjs_states s ON s.document_id=expected.document_id
    WHERE octet_length(s.yjs_state)=expected.state_bytes AND octet_length(s.state_vector)=expected.vector_bytes
      AND octet_length(s.yjs_state) BETWEEN 1 AND $4 AND octet_length(s.state_vector) BETWEEN 1 AND $5
    ORDER BY expected.ordinal`, [ids, stateLengths, vectorLengths, limits.maxSourceBytes, MAX_VECTOR_BYTES]) as Row[];
  const rawById = new Map(raws.map(row => [row.document_id, row]));
  if (raws.length !== documents.length || rawById.size !== documents.length
    || raws.some(row => !selectedIds.has(row.document_id as string))) fail('native-source-changed', '');
  const result: NativeSourceRead[] = [];
  for (let index = 0; index < documents.length; index++) result.push(await readNativeSource(workspace, documents[index],
    byId.get(documents[index].id)!, metadata[index], rawById.get(documents[index].id), loadState));
  return result;
}

/** Fixed observation only. Caller owns the actual connection, read transaction,
 * current rights and admission/lifecycle fence; this function opens/closes no
 * connection, transaction or lock. Neither its output nor dependencies grant
 * mutation authority. Re-run the whole observation under genuine B before use. */
export async function readWorkspaceLinkSourceAuthorityOnConnection(connection: SqlConnection, workspace: WorkspaceContext,
  dependencies: CollectorDependencies = {}): Promise<WorkspaceLinkSourceAuthorityObservation> {
  if (!dependencies || typeof dependencies !== 'object' || types.isProxy(dependencies)
    || Object.getPrototypeOf(dependencies) !== Object.prototype) throw new Error('Invalid physical source parser version.');
  const parserDescriptor = Object.getOwnPropertyDescriptor(dependencies, 'physicalParserVersion');
  if (parserDescriptor && (!parserDescriptor.enumerable || !Object.hasOwn(parserDescriptor, 'value'))) throw new Error('Invalid physical source parser version.');
  const physicalParserVersion = parserDescriptor?.value === undefined ? 2 : parserDescriptor.value;
  if (physicalParserVersion !== 2 && physicalParserVersion !== 3) throw new Error('Invalid physical source parser version.');
  workspace = structuredClone(workspace);
  if (!workspace.permissions.canRead || workspace.status !== undefined && workspace.status !== 'active') throw Object.assign(new Error('Current workspace read permission is required.'), { status: 403 });
  const originalMove = readOriginalMoveCollectorOverlay(connection, workspace);
  const limits = { ...DEFAULT_LIMITS, ...dependencies.limits };
  if (Object.entries(limits).some(([key, value]) => !Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key as keyof Limits])) throw new Error('Invalid physical source staging limit.');
  const sources: WorkspaceSourceAuthorityStage['sources'] = []; const namespace = new Map<string, NativeNamespaceEntry>();
  const gaps: PhysicalSourceGap[] = []; const excludedPaths: string[] = []; const observed: WorkspaceOriginalPathObservation[] = [];
  let catalogueProof: string | null = null;
  let confirmedSourceReadChange = false;
  let privateCatalogue: readonly Readonly<WorkspaceDocumentCatalogueEntry>[] | undefined;
  const nativeBindings: WorkspaceNativeSourceBinding[] = [], privateNativeStates: PersistedCollaborationState[] = [];
  const gap = (code: string, filePath: string) => gaps.push({ code, path: filePath });
  let totalBytes = 0; let totalLinks = 0;
  try {
    const catalogue = await readWorkspaceDocumentCatalogue(connection, workspace, { maxEntries: limits.maxPaths });
    if (catalogue.length > limits.maxPaths) fail('path-count-limit', '');
    catalogueProof = nativeLinkJsonProof(catalogue);
    privateCatalogue = Object.freeze(catalogue.map(entry => Object.freeze({ ...entry })));
    const registered = new Map(catalogue.map((entry) => [entry.path, entry]));
    const verifyPhysicalAuthority = async (filePath: string) => {
      const current = await readWorkspaceDocumentCatalogue(connection!, workspace, { paths: [filePath] });
      const expected = registered.get(filePath);
      if (current.some((entry) => entry.path !== filePath || entry.authority !== 'pristine')
        || nativeLinkJsonProof(current[0] ?? null) !== nativeLinkJsonProof(expected ?? null)) fail('physical-authority-changed', filePath);
    };
    const realRoot = await fs.realpath(workspace.rootPath); const rootStat = await fs.stat(realRoot);
    if (!rootStat.isDirectory()) fail('invalid-workspace-root', '');
    const entries = new Map<string, WorkspaceOriginalPathObservation>();
    const root: WorkspaceOriginalRootObservation = { resolvedRootPath: realRoot, identity: filesystemFileVersion(rootStat), entries };
    const pending = [{ relativePath: '', depth: 0 }];
    while (pending.length) {
      const directory = pending.pop()!;
      const children = (await fs.readdir(path.join(realRoot, directory.relativePath), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        const relativePath = directory.relativePath ? `${directory.relativePath}/${child.name}` : child.name;
        if (!isCanonicalAdmissionPath(relativePath)) { gap('invalid-source-path', relativePath); continue; }
        if (child.isDirectory() && (EXCLUDED_DIRECTORIES.has(child.name) || directory.depth === 0 && child.name === '.canvas-skill-drafts')
          || EXCLUDED_FILES.has(child.name) || isInternalWorkspaceStagingPath(child.name)) { excludedPaths.push(relativePath); continue; }
        if (observed.length >= limits.maxPaths) fail('path-count-limit', relativePath);
        // File names came from this actual parent listing. Keep the original
        // directory/unsafe-Dirent guard before traversal; the final batch below
        // freshly verifies exact membership and all physical ancestry for files.
        if (!child.isFile()) await assertWorkspacePathHasNoAliases(workspace, relativePath, { readOnly: true });
        const stat = await fs.lstat(path.join(realRoot, relativePath));
        if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) { gap('unsafe-physical-source', relativePath); continue; }
        const item = { relativePath, stat, identity: filesystemFileVersion(stat) }; observed.push(item); entries.set(relativePath, item);
        const physicalEntry: NativeNamespaceEntry = { workspaceId: workspace.workspaceId, path: relativePath, kind: stat.isDirectory() ? 'directory' : 'file',
          identity: item.identity, filesystemIdentity: item.identity, documentId: null, lifecycleGeneration: null };
        // Only the fixed owner can install this private active read frame. All
        // FS observations/rechecks above and below retain their actual paths.
        const logicalEntry = originalMove ? originalMove.physicalEntry(physicalEntry) : physicalEntry;
        if (logicalEntry) {
          if (namespace.has(logicalEntry.path)) fail('identity-conflict', relativePath);
          namespace.set(logicalEntry.path, logicalEntry);
        }
        if (stat.isDirectory()) {
          if (directory.depth + 1 > limits.maxDepth) fail('source-depth-limit', relativePath);
          pending.push({ relativePath, depth: directory.depth + 1 });
        }
      }
    }
    for (const document of catalogue) {
      const projection = namespace.get(document.path);
      if (projection?.kind === 'directory') { gap('identity-conflict', document.path); continue; }
      // A registered file becomes native only after initialization. Until then
      // its actual filesystem identity remains authoritative for every type.
      if (document.authority === 'pristine') {
        if (!projection?.filesystemIdentity) gap('missing-physical-source', document.path);
        continue;
      }
      namespace.set(document.path, { workspaceId: workspace.workspaceId, path: document.path, kind: 'file',
        identity: `registry:${document.id}:${document.lifecycle_generation ?? document.yjs_state_lifecycle}`,
        documentId: document.id, lifecycleGeneration: document.lifecycle_generation, filesystemIdentity: projection?.filesystemIdentity ?? null });
      if (document.authority === 'missing-state') { gap('missing-native-state', document.path); continue; }
    }
    // Extension/capability never authorize projection bytes for this branch.
    for (const native of await readNativeSources(connection, workspace, catalogue.filter(document => document.authority === 'initialized'),
      limits, limits.maxTotalSourceBytes - totalBytes, dependencies.loadState)) {
      totalBytes += native.byteLength; totalLinks += native.inventory.links.length;
      if (totalLinks > limits.maxLinks) fail('source-link-limit', native.state.path);
      nativeBindings.push(native.binding); privateNativeStates.push(native.state);
      sources.push({ kind: 'native', inventory: native.inventory });
      gaps.push(...native.inventory.coverage.gaps.map(entry => ({ code: entry.code, path: entry.path })));
    }
    // A registry-only document proves its namespace ancestors, not physical
    // directories. Preserve actual directory fingerprints where present and
    // never give an implied directory a filesystem or document identity.
    for (const document of catalogue.filter(document => document.authority !== 'pristine')) {
      let parentPath = path.posix.dirname(document.path);
      while (parentPath !== '.' && parentPath !== '/') {
        const prior = namespace.get(parentPath);
        if (prior?.kind === 'file') fail('identity-conflict', document.path);
        if (!prior) {
          if (namespace.size >= limits.maxPaths) fail('source-namespace-limit', parentPath);
          namespace.set(parentPath, { workspaceId: workspace.workspaceId, path: parentPath, kind: 'directory',
            identity: `registry-directory:${nativeLinkJsonProof({ workspaceId: workspace.workspaceId, path: parentPath })}`,
            documentId: null, lifecycleGeneration: null, filesystemIdentity: null });
        }
        parentPath = path.posix.dirname(parentPath);
      }
    }
    for (const entry of namespace.values()) {
      if (namespace.size > limits.maxPaths || entry.path.split('/').length - 1 > limits.maxDepth) fail('source-namespace-limit', entry.path);
      let parentPath = path.posix.dirname(entry.path);
      while (parentPath !== '.' && parentPath !== '/') {
        if (namespace.get(parentPath)?.kind === 'file') fail('identity-conflict', entry.path);
        parentPath = path.posix.dirname(parentPath);
      }
    }
    for (const item of observed) {
      if (!item.stat.isFile()) continue;
      const document = registered.get(originalMove?.logicalPath(item.relativePath) ?? item.relativePath);
      if (document && document.authority !== 'pristine') continue;
      if (!/\.(?:md|markdown|html?)$/iu.test(item.relativePath)) {
        if (/\.mdx$/iu.test(item.relativePath)) gap('unsupported-mdx-source', item.relativePath);
        continue;
      }
      try {
        const bytes = await readWorkspaceOriginalFileSource({ configuredRootPath: workspace.rootPath, root, observed: item,
          maxBytes: Math.min(limits.maxSourceBytes, limits.maxTotalSourceBytes - totalBytes),
          verifyCurrentSource: () => verifyPhysicalAuthority(item.relativePath), afterSourceFingerprint: dependencies.afterSourceFingerprint });
        totalBytes += bytes.length;
        const authority = document ? { kind: 'registered-never-initialized' as const, catalogueProof,
          registeredDocumentId: document.id, lineageId: document.lineage_id } : { kind: 'unregistered' as const, catalogueProof };
        // The private Move frame may restore an exact receipt-bound source
        // spelling/fingerprint only after the actual FD bytes and ancestry have
        // passed the reader above. It never changes the observed/rechecked path.
        const physicalSource = originalMove?.physicalSource(item.relativePath, item.identity, bytes)
          ?? { path: item.relativePath, filesystemIdentity: item.identity };
        const inventory = (physicalParserVersion === 3 ? inspectOriginalPhysicalLinksV3 : inspectOriginalPhysicalLinks)({ workspaceId: workspace.workspaceId, organizationId: workspace.organizationId ?? null,
          path: physicalSource.path, authority, bytes, filesystemIdentity: physicalSource.filesystemIdentity, maxLinks: limits.maxLinks - totalLinks });
        totalLinks += inventory.links.length;
        if (totalLinks > limits.maxLinks) fail('source-link-limit', item.relativePath);
        sources.push({ kind: 'physical', inventory }); gaps.push(...inventory.coverage.gaps);
      } catch (error) { if (error instanceof PhysicalStageConflict || error instanceof WorkspaceOriginalFileSourceError) gap(error.code, error.filePath); else gap('unreadable-physical-source', item.relativePath); }
    }
    // READ COMMITTED gives a fresh catalogue while the SAME shared admission
    // fence remains held. Never release it between classification and FS reads.
    const recheckedCatalogue = await readWorkspaceDocumentCatalogue(connection, workspace, { maxEntries: limits.maxPaths });
    if (nativeLinkJsonProof(recheckedCatalogue) !== catalogueProof) {
      if (recheckedCatalogue.some(entry => entry.authority === 'missing-state')) fail('source-authority-changed', '');
      throw new ConfirmedSourceReadChange('source-authority-changed', '');
    }
    const physicalBytes = totalBytes - privateNativeStates.reduce((sum, state) => sum + state.yjsState.byteLength + state.stateVector.byteLength, 0);
    let currentSources: NativeSourceRead[];
    try { currentSources = await readNativeSources(connection, workspace, nativeBindings.map(binding => registered.get(binding.expected.path)!),
      limits, limits.maxTotalSourceBytes - physicalBytes, dependencies.loadState); }
    catch { fail('native-source-changed', ''); }
    for (const [index, binding] of nativeBindings.entries()) {
      if (!isDeepStrictEqual(currentSources![index].binding, binding) || !isDeepStrictEqual(currentSources![index].state, privateNativeStates[index])) {
        throw new ConfirmedSourceReadChange('native-source-changed', binding.expected.path);
      }
    }
    await assertWorkspaceOriginalPathsCurrent({ configuredRootPath: workspace.rootPath, root, observed });
    if (filesystemFileVersion(await fs.stat(realRoot)) !== root.identity || await fs.realpath(workspace.rootPath) !== realRoot) fail('physical-scope-changed', '');
    const finalCatalogue = await readWorkspaceDocumentCatalogue(connection, workspace, { maxEntries: limits.maxPaths });
    if (nativeLinkJsonProof(finalCatalogue) !== catalogueProof) {
      if (finalCatalogue.some(entry => entry.authority === 'missing-state')) fail('source-authority-changed', '');
      throw new ConfirmedSourceReadChange('source-authority-changed', '');
    }
  } catch (error) {
    confirmedSourceReadChange = error instanceof ConfirmedSourceReadChange
      && gaps.every(entry => entry.code === 'uninspected-html');
    if (error instanceof PhysicalStageConflict || error instanceof WorkspaceOriginalFileSourceError) gap(error.code, error.filePath); else gap('source-authority-unavailable', '');
    // Incoherent global authority/namespace observations cannot certify bytes.
    sources.length = 0; nativeBindings.length = 0; privateNativeStates.length = 0;
    privateCatalogue = undefined;
  }
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId: workspace.workspaceId,
    organizationId: workspace.organizationId ?? null, catalogueProof,
    namespace: [...namespace.values()].sort((a, b) => a.path.localeCompare(b.path)), sources,
    scope: { kind: 'visible-workspace', excludedPaths: excludedPaths.sort() },
    coverage: { complete: !gaps.length, gaps }, readiness: gaps.length ? 'blocked'
      : sources.some((source) => source.kind === 'physical') ? 'requires-import-and-rebinding' : 'native-coordinator-required', executionReady: false };
  const observation = Object.freeze({ stage: { ...body, stageProof: workspaceSourceAuthorityStageProof(body) },
    // Coherent catalogue facts remain private read evidence even when a source
    // has a coverage gap. Each versioned consumer still validates its own
    // coverage contract; retaining this witness grants no execution authority.
    ...(privateCatalogue ? { privateCatalogue } : {}),
    nativeBindings: Object.freeze(nativeBindings), privateNativeStates: Object.freeze(privateNativeStates) });
  if (confirmedSourceReadChange) confirmedSourceReadChanges.add(observation);
  return observation;
}

/** Original standalone API. Its own short read TX/shared fence is retained;
 * never invoke this wrapper beneath an exclusive owner on another backend. */
export async function stageWorkspaceLinkSourceAuthorityObservation(workspace: WorkspaceContext,
  dependencies: Dependencies & WorkspacePhysicalSourceReadOptions = {}): Promise<WorkspaceLinkSourceAuthorityObservation> {
  let connection: SqlConnection | undefined, transaction = false, discard: Error | undefined;
  let stage: WorkspaceSourceAuthorityStage | undefined, observation: WorkspaceLinkSourceAuthorityObservation | undefined;
  const unavailable = () => {
    const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId: workspace.workspaceId,
      organizationId: workspace.organizationId ?? null, catalogueProof: stage?.catalogueProof ?? null,
      namespace: stage?.namespace ?? [], sources: [], scope: stage?.scope ?? { kind: 'visible-workspace', excludedPaths: [] },
      coverage: { complete: false, gaps: [...(stage?.coverage.gaps ?? []), { code: 'source-authority-unavailable', path: '' }] },
      readiness: 'blocked', executionReady: false };
    stage = { ...body, stageProof: workspaceSourceAuthorityStageProof(body) };
    observation = Object.freeze({ stage, nativeBindings: Object.freeze([]), privateNativeStates: Object.freeze([]) });
  };
  // Preserve the legacy pre-check before any SQL checkout.
  workspace = structuredClone(workspace);
  if (!workspace.permissions.canRead || workspace.status !== undefined && workspace.status !== 'active') throw Object.assign(new Error('Current workspace read permission is required.'), { status: 403 });
  const limits = { ...DEFAULT_LIMITS, ...dependencies.limits };
  if (Object.entries(limits).some(([key, value]) => !Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key as keyof Limits])) throw new Error('Invalid physical source staging limit.');
  try {
    connection = await (dependencies.openConnection ?? openDb)();
    await connection.run('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY'); transaction = true;
    await connection.run("SET LOCAL statement_timeout='5s'"); await connection.run("SET LOCAL lock_timeout='4s'");
    await connection.get('SELECT pg_advisory_xact_lock_shared($1::bigint)', [collaborationAdmissionLockKey(workspace.workspaceId)]);
    observation = await readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace, dependencies);
    stage = observation.stage;
    // An incomplete observation grants nothing. Roll back every failed readonly
    // stage instead of publishing a successful transaction for partial coverage.
    await connection.run(stage.coverage.complete ? 'COMMIT' : 'ROLLBACK'); transaction = false;
  } catch { unavailable(); }
  finally {
    if (transaction) try { await connection?.run('ROLLBACK'); } catch { discard = new Error('Discarding unresolved source authority stage.'); }
    try { await connection?.close(discard); } catch { unavailable(); }
  }
  return observation!;
}

/** Legacy preview callers receive only the original Stage DTO. */
export async function stageWorkspaceLinkSourceAuthority(workspace: WorkspaceContext, dependencies: Dependencies = {}): Promise<WorkspaceSourceAuthorityStage> {
  return (await stageWorkspaceLinkSourceAuthorityObservation(workspace, dependencies)).stage;
}
