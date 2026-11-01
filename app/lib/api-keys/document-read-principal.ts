import 'server-only';

import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual, types } from 'node:util';
import type { SqlConnection } from '@/app/lib/db';
import { principalSchemaSnapshotSql } from '@/app/lib/db/principal-schema-snapshot';
import { postgresScalarSnapshotSql } from '@/app/lib/db/postgres-scalar-snapshot';
import { getLicenseStatus } from '@/app/lib/license';
import type { LicenseStatus } from '@/app/lib/license/types';
import { evaluateUserSeatAccessSnapshot, resolveEffectiveSeatPolicy, userSeatAccessSnapshotSql,
  type CurrentSeatSnapshotRow } from '@/app/lib/license/seat-limit';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { workspaceContextFromPermissionSnapshot, workspacePermissionSnapshotSetSql, workspacePermissionSnapshotScalarColumns,
  type WorkspacePermissionSnapshotRow } from '@/app/lib/workspaces/postgres-runtime';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { ApiKeyAccessError, type ApiKeyAction } from './contracts';
import { assertApiKeyMcpToolEnabled } from './mcp-runtime';
import { apiKeyCredentialBinding, apiKeyCredentialSnapshotSql, currentApiKeyIdentityFromSnapshot,
  currentApiKeyReceiptIdentityFromSnapshot, assertApiKeyReceiptSearchPath,
  type ApiKeyCredential, type ApiKeyCredentialBinding } from './authentication';

declare const principalBrand: unique symbol;
export type ApiKeyDocumentReadPrincipal = Readonly<{ [principalBrand]: never }>;
declare const workspaceListBrand: unique symbol;
export type ApiKeyWorkspaceListPrincipal = Readonly<{ [workspaceListBrand]: never }>;
declare const workspaceBrowseBrand: unique symbol;
export type ApiKeyWorkspaceBrowsePrincipal = Readonly<{ [workspaceBrowseBrand]: never }>;
export type ApiKeyWorkspaceBrowsePurpose = 'tree' | 'overview' | 'manifest';
declare const documentEditBrand: unique symbol;
export type ApiKeyDocumentEditPrincipal = Readonly<{ [documentEditBrand]: never }>;
export type ApiKeyDocumentEditPurpose = 'edit' | 'edit_status';
declare const documentCreateBrand: unique symbol;
export type ApiKeyDocumentCreatePrincipal = Readonly<{ [documentCreateBrand]: never }>;
export type ApiKeyDocumentCreatePurpose = 'create' | 'import';
declare const workspaceCopyBrand: unique symbol;
export type ApiKeyWorkspaceCopyPrincipal = Readonly<{ [workspaceCopyBrand]: never }>;
const copyPurposes = ['copy_preview', 'copy_apply', 'copy_status', 'copy_recover'] as const;
export type ApiKeyWorkspaceCopyPurpose = typeof copyPurposes[number];
type CopySelection = Readonly<{ sourceWorkspaceId: string; destinationWorkspaceId: string }>;
declare const workspacePathBrand: unique symbol;
export type ApiKeyWorkspacePathPrincipal = Readonly<{ [workspacePathBrand]: never }>;
const pathPurposes = ['move_preview', 'move_apply', 'move_status', 'move_recover',
  'delete_preview', 'delete_apply', 'delete_status', 'delete_recover'] as const;
export type ApiKeyWorkspacePathPurpose = typeof pathPurposes[number];
export type ApiKeyDocumentReadOrigin = Readonly<{
  kind: 'api_key';
  userId: string; integrationId: string; instanceId: string; credentialId: string;
  workspaceId: string; workspaceType: string; organizationId: string | null; customerId: string | null;
  projectId: string | null; ownerUserId: string | null; rootPath: string; rootRelativePath: string;
  legacy: false; status: 'active'; schema: string; schemaOid: number; databaseOid: number; searchPath: string;
}>;
export type ApiKeyDocumentCreateOrigin = ApiKeyDocumentReadOrigin & Readonly<{
  purpose: ApiKeyDocumentCreatePurpose; entryPoint: 'request' | 'mcp';
}>;
type Access = Readonly<{ workspace: WorkspaceContext; userId: string; integrationId: string; instanceId: string;
  assertCurrent: () => Promise<void> }>;
export type ApiKeyDocumentCreatePrincipalAccess = Access & Readonly<{ purpose: ApiKeyDocumentCreatePurpose; assertActive: () => void }>;
export type ApiKeyWorkspaceCopyPrincipalAccess = Readonly<Omit<Access, 'workspace'> & {
  sourceWorkspace: WorkspaceContext; destinationWorkspace: WorkspaceContext; credentialId: string;
  purpose: ApiKeyWorkspaceCopyPurpose; entryPoint: 'request' | 'mcp'; assertActive: () => void;
}>;
export type ApiKeyWorkspacePathPrincipalAccess = Access & Readonly<{
  credentialId: string; purpose: ApiKeyWorkspacePathPurpose; entryPoint: 'request' | 'mcp'; assertActive: () => void;
}>;
type ListAccess = Readonly<Omit<Access, 'workspace'> & { workspaces: readonly WorkspaceContext[] }>;
type Capture = {
  credential: ApiKeyCredential; binding: ApiKeyCredentialBinding; workspaceId: string | null;
  purpose: 'read' | 'search' | 'list' | ApiKeyWorkspaceBrowsePurpose | ApiKeyDocumentEditPurpose | ApiKeyDocumentCreatePurpose | ApiKeyWorkspaceCopyPurpose | ApiKeyWorkspacePathPurpose;
  copy?: CopySelection;
  path?: 'move' | 'delete';
  license: LicenseStatus; observer?: (origin: ApiKeyDocumentReadOrigin) => void; origins?: readonly ApiKeyDocumentReadOrigin[];
  mcp: boolean; active: boolean; accepting: boolean; busy: boolean; failure?: unknown; pending: Set<Promise<unknown>>;
};
type Identity = { backend: number; start: string; xid: string };
type Phase = { capture: Capture; connection: SqlConnection; identity?: Identity; deadline: number; credentialExpiresAt?: number;
  active: boolean; accepting: boolean; checking: boolean; failure?: unknown; pending: Set<Promise<unknown>>; expectedSearchPath?: string };
type Registry = { captures: WeakMap<object, Capture>; phases: WeakMap<SqlConnection, Phase> };
type Row = Record<string, unknown>;
const policyTables = ['canvas_organization_settings', 'team_memberships', 'team_membership_sync_state', 'user',
  'organization_user_permissions', 'canvas_workspaces', 'canvas_projects', 'canvas_workspace_members', 'canvas_project_members'];
const tables = [...policyTables, 'canvas_api_keys', 'canvas_api_integrations'];
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value).toString('utf8') === value;
function failure(code: 'API_KEY_PRINCIPAL_REQUIRED' | 'API_KEY_PRINCIPAL_SCOPE_CHANGED' | 'API_KEY_STATE_INVALID'
  | 'API_KEY_ACCESS_DENIED' | 'API_KEY_PRINCIPAL_BUSY' | 'API_KEY_PRINCIPAL_EXPIRED' | 'API_KEY_PRINCIPAL_DETACHED'): never {
  throw new ApiKeyAccessError(code, code, code === 'API_KEY_PRINCIPAL_REQUIRED' ? 401
    : code === 'API_KEY_STATE_INVALID' ? 503 : code === 'API_KEY_ACCESS_DENIED' ? 403 : 409);
}
function registry(): Registry {
  const key = Symbol.for('canvas.api-key-document-read-principals.v2'), descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  if (!descriptor) {
    const value: Registry = Object.freeze({ captures: new WeakMap<object, Capture>(), phases: new WeakMap<SqlConnection, Phase>() });
    Object.defineProperty(globalThis, key, { value }); return value;
  }
  const value: unknown = descriptor.value;
  if (!Object.hasOwn(descriptor, 'value') || !value || typeof value !== 'object' || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) failure('API_KEY_STATE_INVALID');
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(properties).length !== 2 || !['captures', 'phases'].every(name => properties[name]?.enumerable
    && Object.hasOwn(properties[name], 'value') && types.isWeakMap(properties[name].value))) failure('API_KEY_STATE_INVALID');
  return value as Registry;
}
const shared = registry();
function poison(phase: Phase, error: unknown): never {
  phase.failure ??= error ?? new ApiKeyAccessError('API_KEY_STATE_INVALID', 'Invalid principal phase.', 503);
  phase.capture.failure ??= phase.failure; throw phase.failure;
}
function active(phase: Phase): void {
  if (!phase.active || !phase.capture.active || shared.phases.get(phase.connection) !== phase) failure('API_KEY_PRINCIPAL_DETACHED');
  if (phase.failure !== undefined) throw phase.failure;
  if (phase.capture.failure !== undefined) throw phase.capture.failure;
  if (performance.now() >= phase.deadline) failure('API_KEY_PRINCIPAL_EXPIRED');
  if (phase.credentialExpiresAt !== undefined && phase.credentialExpiresAt <= Date.now()) {
    throw new ApiKeyAccessError('API_KEY_INVALID', 'The API key is invalid or has expired.', 401);
  }
  const license = phase.capture.license;
  if (license.licensed && ['active', 'grace'].includes(license.licenseState)) {
    const expiry = Date.parse(license.licenseState === 'grace' ? license.graceExpiresAt ?? '' : license.expiresAt ?? '');
    if (!Number.isFinite(expiry) || expiry <= Date.now()) failure('API_KEY_PRINCIPAL_EXPIRED');
  }
}
function validateHeader(phase: Phase, row: Row | undefined): void {
  active(phase);
  const realm = phase.capture.binding.realm;
  if (row && (phase.capture.copy || phase.capture.path) && phase.expectedSearchPath === undefined && row.search_path !== realm.searchPath) {
    // Existing native owners enter B through native-inspection's canonical
    // path. Admit only that exact path; schema/OIDs/catalog/TX remain checked.
    try { assertApiKeyReceiptSearchPath(phase.capture.credential, row.search_path); }
    catch { failure('API_KEY_PRINCIPAL_SCOPE_CHANGED'); }
    phase.expectedSearchPath = row.search_path;
  }
  if (!row || row.schema !== realm.schema || Number(row.schema_oid) !== realm.schemaOid || Number(row.database_oid) !== realm.databaseOid
    || row.search_path !== (phase.expectedSearchPath ?? realm.searchPath) || row.isolation !== 'read committed' || row.read_only !== 'off' || row.replication !== 'origin'
    || !Number.isSafeInteger(Number(row.backend)) || Number(row.backend) < 1
    || typeof row.start !== 'string' || !/^[0-9]+\.[0-9]+$/u.test(row.start)
    || typeof row.xid !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(row.xid)) failure('API_KEY_PRINCIPAL_SCOPE_CHANGED');
  const identity = { backend: Number(row.backend), start: row.start, xid: row.xid };
  if (phase.identity && !isDeepStrictEqual(identity, phase.identity)) failure('API_KEY_PRINCIPAL_SCOPE_CHANGED');
  phase.identity ??= identity;
  const relations = row.schema_relations;
  if (!Array.isArray(relations) || relations.length !== tables.length || new Set(relations.map(value => value?.name)).size !== tables.length
    || relations.some(value => !value || typeof value !== 'object' || Object.keys(value).length !== 2
      || !Object.hasOwn(value, 'name') || !Object.hasOwn(value, 'same_relation')
      || !tables.includes(value.name) || value.same_relation !== true)) failure('API_KEY_STATE_INVALID');
}

async function current(phase: Phase): Promise<readonly WorkspaceContext[]> {
  active(phase);
  const capture = phase.capture, binding = capture.binding, schema = quote(binding.realm.schema);
  const tool = ({ list: 'list_workspaces', read: 'read_knowledge_source', search: 'search_knowledge',
    tree: 'list_knowledge_tree', overview: 'get_workspace_overview', manifest: 'get_knowledge_manifest',
    edit: 'edit_knowledge_source', edit_status: 'edit_knowledge_source',
    create: 'create_knowledge_source', import: 'import_knowledge_file',
    copy_preview: 'copy_knowledge_source', copy_apply: 'copy_knowledge_source',
    copy_status: 'copy_knowledge_source', copy_recover: 'copy_knowledge_source',
    move_preview: 'move_knowledge_source', move_apply: 'move_knowledge_source',
    move_status: 'move_knowledge_source', move_recover: 'move_knowledge_source',
    delete_preview: 'delete_knowledge_source', delete_apply: 'delete_knowledge_source',
    delete_status: 'delete_knowledge_source', delete_recover: 'delete_knowledge_source' } as const)[capture.purpose];
  if (capture.mcp) { await assertApiKeyMcpToolEnabled(tool); active(phase); }
  const seatPolicy = resolveEffectiveSeatPolicy(capture.license);
  const pinned = policyTables.map(name => `${quote(name)} AS NOT MATERIALIZED (SELECT * FROM ${schema}.${quote(name)})`).join(',');
  const keySql = postgresScalarSnapshotSql(apiKeyCredentialSnapshotSql(3, binding.realm.schema), ['account_banned', 'expires_at', 'revision']);
  const seatSql = postgresScalarSnapshotSql(userSeatAccessSnapshotSql(2, 4), ['account_banned', 'reconciliation_seat_limit']);
  const workspaceSql = postgresScalarSnapshotSql(workspacePermissionSnapshotSetSql, workspacePermissionSnapshotScalarColumns);
  const selectedIds = capture.copy ? 'ARRAY(SELECT DISTINCT unnest(ARRAY[$1::text,$7::text]))'
    : `CASE WHEN $1::text IS NOT NULL THEN ARRAY[$1::text]
      ELSE ARRAY(SELECT value FROM pg_catalog.jsonb_array_elements_text(
        (credential.credential_snapshot->>'workspace_ids_json')::jsonb) selected(value) LIMIT 101) END`;
  const row = await phase.connection.get(`WITH ${pinned}
    SELECT header.*,credential.credential_snapshot AS credential,seat.seat_snapshot AS seat,workspaces.snapshots AS workspaces
    FROM (${principalSchemaSnapshotSql(5, 6, tables.length)}) header
    LEFT JOIN (${keySql}) credential(credential_snapshot) ON true
    LEFT JOIN (${seatSql}) seat(seat_snapshot) ON true
    LEFT JOIN LATERAL (SELECT ${selectedIds} AS ids) selected_workspace_ids ON true
    LEFT JOIN LATERAL (SELECT COALESCE(pg_catalog.jsonb_agg(selected_scope.workspace_snapshot ORDER BY selected_scope.workspace_snapshot->>'id'),'[]'::jsonb) AS snapshots
      FROM (${workspaceSql}) selected_scope(workspace_snapshot)) workspaces ON true`,
  [capture.workspaceId, binding.userId, binding.credentialId, seatPolicy.mode, schema, tables,
    ...(capture.copy ? [capture.copy.destinationWorkspaceId] : [])]) as Row | undefined;
  active(phase); validateHeader(phase, row);
  if (capture.mcp) { await assertApiKeyMcpToolEnabled(tool); active(phase); }
  const credential = row!.credential as Row | null;
  if (!credential) throw new ApiKeyAccessError('API_KEY_INVALID', 'The API key is invalid or has expired.', 401);
  const rows = row!.workspaces;
  if (!Array.isArray(rows) || rows.length > 100 || [credential, row!.seat, ...rows]
    .some(value => value && Reflect.get(value, 'scalar_types_supported') !== true)) failure('API_KEY_STATE_INVALID');
  const identity = phase.expectedSearchPath === undefined ? currentApiKeyIdentityFromSnapshot(capture.credential, credential)
    : currentApiKeyReceiptIdentityFromSnapshot(capture.credential, credential, phase.expectedSearchPath);
  phase.credentialExpiresAt = identity.expiresAt;
  const editing = capture.purpose === 'edit' || capture.purpose === 'edit_status';
  const creating = capture.purpose === 'create' || capture.purpose === 'import';
  const requiredActions: readonly ApiKeyAction[] = capture.path ? [capture.path,
    ...(capture.purpose === `${capture.path}_status` ? ['status' as const]
      : capture.purpose === `${capture.path}_recover` ? ['recover' as const] : [])] : capture.copy ? capture.purpose === 'copy_status' ? ['copy', 'status']
    : capture.purpose === 'copy_recover' ? ['copy', 'recover'] : ['copy'] : capture.purpose === 'edit_status' ? ['edit', 'status']
    : editing ? ['edit'] : creating ? [capture.purpose as ApiKeyDocumentCreatePurpose] : ['read'];
  if (requiredActions.some(action => !identity.actions.includes(action))
    || capture.workspaceId !== null && !identity.workspaceIds.includes(capture.workspaceId)
    || capture.copy && !identity.workspaceIds.includes(capture.copy.destinationWorkspaceId)) failure('API_KEY_ACCESS_DENIED');
  evaluateUserSeatAccessSnapshot(binding.userId, seatPolicy, row!.seat as CurrentSeatSnapshotRow | undefined);
  const actor = resolveWorkspaceActor({ id: identity.userId, email: typeof credential.account_email === 'string' ? credential.account_email : null,
    role: typeof credential.account_role === 'string' ? credential.account_role : null });
  const workspaces: WorkspaceContext[] = [], origins: ApiKeyDocumentReadOrigin[] = [];
  for (const facts of rows) {
    const selected = workspaceContextFromPermissionSnapshot(facts as WorkspacePermissionSnapshotRow, actor);
    if (!selected || !identity.workspaceIds.includes(selected.workspaceId) || selected.legacy || selected.status !== 'active'
      || !selected.permissions.canRead || typeof selected.rootRelativePath !== 'string') {
      if (capture.workspaceId !== null) failure('API_KEY_ACCESS_DENIED');
      continue;
    }
    const copyDestination = capture.copy?.destinationWorkspaceId === selected.workspaceId;
    if ((editing || creating || copyDestination || capture.path) && (!selected.permissions.canWrite || !selected.permissions.canRunAgent)
      || capture.path && !selected.permissions.canDelete) failure('API_KEY_ACCESS_DENIED');
    const workspace = Object.freeze({ ...selected, permissions: Object.freeze({ ...selected.permissions,
      canWrite: editing || creating || copyDestination || !!capture.path, canDelete: !!capture.path, canCreatePublicLinks: false, canManageWorkspace: false,
      canRunAgent: editing || creating || copyDestination || !!capture.path }) });
    const origin: ApiKeyDocumentReadOrigin = Object.freeze({ kind: 'api_key', userId: identity.userId, integrationId: identity.integrationId,
      credentialId: identity.credentialId, instanceId: identity.instanceId, workspaceId: workspace.workspaceId, workspaceType: workspace.workspaceType,
      organizationId: workspace.organizationId ?? null, customerId: workspace.customerId ?? null, projectId: workspace.projectId ?? null,
      ownerUserId: workspace.ownerUserId ?? null, rootPath: workspace.rootPath, rootRelativePath: selected.rootRelativePath,
      legacy: false, status: 'active', schema: binding.realm.schema, schemaOid: binding.realm.schemaOid,
      databaseOid: binding.realm.databaseOid, searchPath: binding.realm.searchPath });
    workspaces.push(workspace); origins.push(origin);
  }
  if (capture.copy ? workspaces.length !== new Set([capture.copy.sourceWorkspaceId, capture.copy.destinationWorkspaceId]).size
    || ![capture.copy.sourceWorkspaceId, capture.copy.destinationWorkspaceId].every(id => workspaces.some(workspace => workspace.workspaceId === id))
    : capture.workspaceId !== null && (workspaces.length !== 1 || workspaces[0].workspaceId !== capture.workspaceId)) failure('API_KEY_ACCESS_DENIED');
  if (new Set(workspaces.map(workspace => workspace.workspaceId)).size !== workspaces.length) failure('API_KEY_STATE_INVALID');
  if (capture.origins && !isDeepStrictEqual(capture.origins, origins)) failure('API_KEY_PRINCIPAL_SCOPE_CHANGED');
  capture.origins ??= Object.freeze(origins); for (const origin of origins) capture.observer?.(origin);
  active(phase); return Object.freeze(workspaces);
}

/** Fixed read/search capture. A stored identity or caller-supplied actor is insufficient. */
export async function withApiKeyDocumentReadPrincipal<T>(credential: ApiKeyCredential,
  options: { workspaceId: string; purpose: 'read' | 'search'; mcp?: true }, observer: (origin: ApiKeyDocumentReadOrigin) => void,
  consume: (principal: ApiKeyDocumentReadPrincipal) => Promise<T>): Promise<T> {
  if (!options || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) failure('API_KEY_PRINCIPAL_REQUIRED');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const workspaceId: unknown = descriptors.workspaceId?.value, purpose: unknown = descriptors.purpose?.value;
  const mcp = Object.hasOwn(descriptors, 'mcp');
  const mcpDescriptor = descriptors.mcp;
  if (Reflect.ownKeys(descriptors).length !== (mcp ? 3 : 2)
    || mcp && (!mcpDescriptor || !mcpDescriptor.enumerable || !Object.hasOwn(mcpDescriptor, 'value') || mcpDescriptor.value !== true)
    || !['workspaceId', 'purpose'].every(name => descriptors[name]?.enumerable
    && Object.hasOwn(descriptors[name], 'value')) || !validId(workspaceId)
    || purpose !== 'read' && purpose !== 'search' || typeof observer !== 'function' || typeof consume !== 'function') failure('API_KEY_PRINCIPAL_REQUIRED');
  return withCapture(credential, { workspaceId, purpose, observer, mcp }, consume);
}

/** Lists only the current explicit key allowlist, evaluated in one actual B snapshot. */
export async function withApiKeyWorkspaceListPrincipal<T>(credential: ApiKeyCredential, source: 'request' | 'mcp',
  consume: (principal: ApiKeyWorkspaceListPrincipal) => Promise<T>): Promise<T> {
  if (source !== 'request' && source !== 'mcp' || typeof consume !== 'function') failure('API_KEY_PRINCIPAL_REQUIRED');
  return withCapture(credential, { workspaceId: null, purpose: 'list', mcp: source === 'mcp' }, consume);
}

/** Fixed bounded browse purpose. A list/read handle cannot substitute for it. */
export async function withApiKeyWorkspaceBrowsePrincipal<T>(credential: ApiKeyCredential,
  options: { workspaceId: string; purpose: ApiKeyWorkspaceBrowsePurpose; source: 'request' | 'mcp' },
  consume: (principal: ApiKeyWorkspaceBrowsePrincipal) => Promise<T>): Promise<T> {
  if (!options || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) failure('API_KEY_PRINCIPAL_REQUIRED');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const workspaceId: unknown = descriptors.workspaceId?.value, purpose: unknown = descriptors.purpose?.value, source: unknown = descriptors.source?.value;
  if (Reflect.ownKeys(descriptors).length !== 3 || !['workspaceId', 'purpose', 'source'].every(name => descriptors[name]?.enumerable
    && Object.hasOwn(descriptors[name], 'value')) || !validId(workspaceId)
    || purpose !== 'tree' && purpose !== 'overview' && purpose !== 'manifest' || source !== 'request' && source !== 'mcp'
    || typeof consume !== 'function') failure('API_KEY_PRINCIPAL_REQUIRED');
  return withCapture(credential, { workspaceId, purpose, mcp: source === 'mcp' }, consume);
}

/** Separate write family. Status additionally needs the explicit status action;
 * neither a read handle nor stored operation metadata can create this proof. */
export async function withApiKeyDocumentEditPrincipal<T>(credential: ApiKeyCredential,
  options: { workspaceId: string; purpose: ApiKeyDocumentEditPurpose; source: 'request' | 'mcp' },
  observer: (origin: ApiKeyDocumentReadOrigin) => void, consume: (principal: ApiKeyDocumentEditPrincipal) => Promise<T>): Promise<T> {
  if (!options || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) failure('API_KEY_PRINCIPAL_REQUIRED');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const workspaceId: unknown = descriptors.workspaceId?.value, purpose: unknown = descriptors.purpose?.value, source: unknown = descriptors.source?.value;
  if (Reflect.ownKeys(descriptors).length !== 3 || !['workspaceId', 'purpose', 'source'].every(name => descriptors[name]?.enumerable
    && Object.hasOwn(descriptors[name], 'value')) || !validId(workspaceId)
    || purpose !== 'edit' && purpose !== 'edit_status' || source !== 'request' && source !== 'mcp'
    || typeof observer !== 'function' || typeof consume !== 'function') failure('API_KEY_PRINCIPAL_REQUIRED');
  return withCapture(credential, { workspaceId, purpose, mcp: source === 'mcp', observer }, consume);
}

/** Fixed Create/Import family. Origin fields are comparison data; only the
 * private captured credential and its actual phase grant current authority. */
export async function withApiKeyDocumentCreatePrincipal<T>(credential: ApiKeyCredential,
  options: { workspaceId: string; purpose: ApiKeyDocumentCreatePurpose; source: 'request' | 'mcp' },
  observer: (origin: ApiKeyDocumentCreateOrigin) => void, consume: (principal: ApiKeyDocumentCreatePrincipal) => Promise<T>): Promise<T> {
  if (!options || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) failure('API_KEY_PRINCIPAL_REQUIRED');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const workspaceId: unknown = descriptors.workspaceId?.value, purpose: unknown = descriptors.purpose?.value, source: unknown = descriptors.source?.value;
  if (Reflect.ownKeys(descriptors).length !== 3 || !['workspaceId', 'purpose', 'source'].every(name => descriptors[name]?.enumerable
    && Object.hasOwn(descriptors[name], 'value')) || !validId(workspaceId)
    || purpose !== 'create' && purpose !== 'import' || source !== 'request' && source !== 'mcp'
    || typeof observer !== 'function' || typeof consume !== 'function') failure('API_KEY_PRINCIPAL_REQUIRED');
  return withCapture(credential, { workspaceId, purpose, mcp: source === 'mcp',
    observer: origin => observer(Object.freeze({ ...origin, purpose, entryPoint: source })) }, consume);
}

/** Fixed Copy pair and action. No actor, root, permission or historical origin
 * is accepted from the caller; both scopes use the same actual B snapshot. */
export async function withApiKeyWorkspaceCopyPrincipal<T>(credential: ApiKeyCredential,
  options: CopySelection & { purpose: ApiKeyWorkspaceCopyPurpose; source: 'request' | 'mcp' },
  consume: (principal: ApiKeyWorkspaceCopyPrincipal) => Promise<T>): Promise<T> {
  if (!options || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) failure('API_KEY_PRINCIPAL_REQUIRED');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const sourceWorkspaceId: unknown = descriptors.sourceWorkspaceId?.value, destinationWorkspaceId: unknown = descriptors.destinationWorkspaceId?.value;
  const purpose: unknown = descriptors.purpose?.value, source: unknown = descriptors.source?.value;
  if (Reflect.ownKeys(descriptors).length !== 4 || !['sourceWorkspaceId', 'destinationWorkspaceId', 'purpose', 'source'].every(name =>
    descriptors[name]?.enumerable && Object.hasOwn(descriptors[name], 'value'))
    || !validId(sourceWorkspaceId) || !validId(destinationWorkspaceId) || !copyPurposes.includes(purpose as ApiKeyWorkspaceCopyPurpose)
    || source !== 'request' && source !== 'mcp' || typeof consume !== 'function') failure('API_KEY_PRINCIPAL_REQUIRED');
  return withCapture(credential, { workspaceId: sourceWorkspaceId, purpose: purpose as ApiKeyWorkspaceCopyPurpose, mcp: source === 'mcp',
    copy: Object.freeze({ sourceWorkspaceId, destinationWorkspaceId }) }, consume);
}

/** Only a still-live exact capture can enter a later native Copy owner. This
 * assertion performs no SQL and grants no transaction or storage authority. */
export function assertApiKeyWorkspaceCopyPrincipalCaptured(principal: ApiKeyWorkspaceCopyPrincipal,
  options: CopySelection & { purpose: ApiKeyWorkspaceCopyPurpose }): void {
  const capture = shared.captures.get(principal);
  try {
    if (!capture?.active || !capture.accepting) failure('API_KEY_PRINCIPAL_REQUIRED');
    if (capture.failure !== undefined) throw capture.failure;
    if (!options || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) failure('API_KEY_PRINCIPAL_SCOPE_CHANGED');
    const descriptors = Object.getOwnPropertyDescriptors(options);
    if (Reflect.ownKeys(descriptors).length !== 3 || !['sourceWorkspaceId', 'destinationWorkspaceId', 'purpose'].every(name =>
      descriptors[name]?.enumerable && Object.hasOwn(descriptors[name], 'value')) || !capture.copy
      || descriptors.sourceWorkspaceId.value !== capture.copy.sourceWorkspaceId || descriptors.destinationWorkspaceId.value !== capture.copy.destinationWorkspaceId
      || descriptors.purpose.value !== capture.purpose || !copyPurposes.includes(capture.purpose as ApiKeyWorkspaceCopyPurpose)) failure('API_KEY_PRINCIPAL_SCOPE_CHANGED');
  } catch (error) { if (capture) capture.failure ??= error; throw error; }
}

export function withApiKeyWorkspaceCopyPrincipalOnConnection<T>(connection: SqlConnection, principal: ApiKeyWorkspaceCopyPrincipal,
  purpose: ApiKeyWorkspaceCopyPurpose, consume: (access: ApiKeyWorkspaceCopyPrincipalAccess) => Promise<T>): Promise<T> {
  return withFixedPrincipalOnConnection(connection, principal, 'copy', access => {
    const capture = shared.captures.get(principal)!;
    const source = access.workspaces.find(workspace => workspace.workspaceId === capture.copy!.sourceWorkspaceId);
    const destination = access.workspaces.find(workspace => workspace.workspaceId === capture.copy!.destinationWorkspaceId);
    if (!source || !destination) failure('API_KEY_ACCESS_DENIED');
    const sourceWorkspace = Object.freeze({ ...source, permissions: Object.freeze({ ...source.permissions, canWrite: false, canRunAgent: false }) });
    return consume(Object.freeze({ sourceWorkspace, destinationWorkspace: destination, userId: access.userId,
      integrationId: access.integrationId, instanceId: access.instanceId, credentialId: capture.binding.credentialId,
      purpose, entryPoint: capture.mcp ? 'mcp' : 'request', assertCurrent: access.assertCurrent,
      assertActive: () => assertApiKeyWorkspaceCopyPrincipalActiveOnConnection(connection, principal, purpose) }));
  }, purpose);
}

export function assertApiKeyWorkspaceCopyPrincipalActiveOnConnection(connection: SqlConnection,
  principal: ApiKeyWorkspaceCopyPrincipal, purpose: ApiKeyWorkspaceCopyPurpose): void {
  assertFixedWritePrincipalActiveOnConnection(connection, principal, copyPurposes.includes(purpose) ? [purpose] : []);
}

/** Fixed Move/Delete action family. Neither a stored job nor a Read/Copy
 * handle can authorize these destructive path operations. */
export async function withApiKeyWorkspacePathPrincipal<T>(credential: ApiKeyCredential,
  options: Readonly<{ workspaceId: string; purpose: ApiKeyWorkspacePathPurpose; source: 'request' | 'mcp' }>,
  consume: (principal: ApiKeyWorkspacePathPrincipal) => Promise<T>): Promise<T> {
  if (!options || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) failure('API_KEY_PRINCIPAL_REQUIRED');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const workspaceId: unknown = descriptors.workspaceId?.value, purpose: unknown = descriptors.purpose?.value, source: unknown = descriptors.source?.value;
  if (Reflect.ownKeys(descriptors).length !== 3 || !['workspaceId', 'purpose', 'source'].every(name => descriptors[name]?.enumerable
    && Object.hasOwn(descriptors[name], 'value')) || !validId(workspaceId) || !pathPurposes.includes(purpose as ApiKeyWorkspacePathPurpose)
    || source !== 'request' && source !== 'mcp' || typeof consume !== 'function') failure('API_KEY_PRINCIPAL_REQUIRED');
  return withCapture(credential, { workspaceId, purpose: purpose as ApiKeyWorkspacePathPurpose,
    path: (purpose as string).startsWith('move_') ? 'move' : 'delete', mcp: source === 'mcp' }, consume);
}

/** Lifetime/scope proof only; every real transaction must check current SQL
 * policy separately. This preflight never borrows a database connection. */
export function assertApiKeyWorkspacePathPrincipalCaptured(principal: ApiKeyWorkspacePathPrincipal,
  options: Readonly<{ workspaceId: string; purpose: ApiKeyWorkspacePathPurpose }>): void {
  const capture = shared.captures.get(principal);
  try {
    if (!capture?.active || !capture.accepting) failure('API_KEY_PRINCIPAL_REQUIRED');
    if (capture.failure !== undefined) throw capture.failure;
    if (!options || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) failure('API_KEY_PRINCIPAL_SCOPE_CHANGED');
    const descriptors = Object.getOwnPropertyDescriptors(options);
    if (Reflect.ownKeys(descriptors).length !== 2 || !['workspaceId', 'purpose'].every(name => descriptors[name]?.enumerable
      && Object.hasOwn(descriptors[name], 'value')) || !capture.path
      || descriptors.workspaceId.value !== capture.workspaceId || descriptors.purpose.value !== capture.purpose
      || !pathPurposes.includes(capture.purpose as ApiKeyWorkspacePathPurpose)) failure('API_KEY_PRINCIPAL_SCOPE_CHANGED');
  } catch (error) { if (capture) capture.failure ??= error; throw error; }
}

export function withApiKeyWorkspacePathPrincipalOnConnection<T>(connection: SqlConnection, principal: ApiKeyWorkspacePathPrincipal,
  purpose: ApiKeyWorkspacePathPurpose, consume: (access: ApiKeyWorkspacePathPrincipalAccess) => Promise<T>): Promise<T> {
  return withFixedPrincipalOnConnection(connection, principal, 'path', access => {
    const capture = shared.captures.get(principal)!;
    return consume(Object.freeze({ workspace: access.workspaces[0], userId: access.userId, integrationId: access.integrationId,
      instanceId: access.instanceId, credentialId: capture.binding.credentialId, purpose, entryPoint: capture.mcp ? 'mcp' : 'request',
      assertCurrent: access.assertCurrent, assertActive: () => assertApiKeyWorkspacePathPrincipalActiveOnConnection(connection, principal, purpose) }));
  }, purpose);
}

export function assertApiKeyWorkspacePathPrincipalActiveOnConnection(connection: SqlConnection,
  principal: ApiKeyWorkspacePathPrincipal, purpose: ApiKeyWorkspacePathPurpose): void {
  assertFixedWritePrincipalActiveOnConnection(connection, principal, pathPurposes.includes(purpose) ? [purpose] : []);
}

async function withCapture<T, P extends object>(credential: ApiKeyCredential,
  selection: Pick<Capture, 'workspaceId' | 'purpose' | 'observer' | 'mcp' | 'copy' | 'path'>, consume: (principal: P) => Promise<T>): Promise<T> {
  const binding = apiKeyCredentialBinding(credential), license = await getLicenseStatus();
  const capture: Capture = { ...selection, credential, binding, license, active: true, accepting: true, busy: false, pending: new Set() };
  const principal = Object.freeze({}) as P; shared.captures.set(principal, capture);
  try { return await consume(principal); }
  finally {
    capture.accepting = false;
    if (capture.pending.size) { capture.failure ??= new ApiKeyAccessError('API_KEY_PRINCIPAL_DETACHED', 'Detached principal work.', 409); await Promise.allSettled([...capture.pending]); }
    capture.active = false;
    if (capture.failure !== undefined) throw capture.failure;
  }
}

/** Borrows the actual transaction; the document service owns COMMIT/ROLLBACK/disposal. */
export function withApiKeyDocumentReadPrincipalOnConnection<T>(connection: SqlConnection, principal: ApiKeyDocumentReadPrincipal,
  consume: (access: Access) => Promise<T>): Promise<T> {
  return withFixedPrincipalOnConnection(connection, principal, 'document', access => consume(Object.freeze({
    workspace: access.workspaces[0], userId: access.userId, integrationId: access.integrationId,
    instanceId: access.instanceId, assertCurrent: access.assertCurrent })));
}

export function withApiKeyWorkspaceListPrincipalOnConnection<T>(connection: SqlConnection, principal: ApiKeyWorkspaceListPrincipal,
  consume: (access: ListAccess) => Promise<T>): Promise<T> {
  return withFixedPrincipalOnConnection(connection, principal, 'list', consume);
}

export function withApiKeyWorkspaceBrowsePrincipalOnConnection<T>(connection: SqlConnection, principal: ApiKeyWorkspaceBrowsePrincipal,
  purpose: ApiKeyWorkspaceBrowsePurpose, consume: (access: Access) => Promise<T>): Promise<T> {
  return withFixedPrincipalOnConnection(connection, principal, 'browse', access => consume(Object.freeze({
    workspace: access.workspaces[0], userId: access.userId, integrationId: access.integrationId,
    instanceId: access.instanceId, assertCurrent: access.assertCurrent })), purpose);
}

export function withApiKeyDocumentEditPrincipalOnConnection<T>(connection: SqlConnection, principal: ApiKeyDocumentEditPrincipal,
  consume: (access: Access & { assertActive: () => void }) => Promise<T>): Promise<T> {
  return withFixedPrincipalOnConnection(connection, principal, 'edit', access => consume(Object.freeze({
    workspace: access.workspaces[0], userId: access.userId, integrationId: access.integrationId, instanceId: access.instanceId,
    assertCurrent: access.assertCurrent, assertActive: () => assertApiKeyDocumentEditPrincipalActiveOnConnection(connection, principal) })));
}

/** The exact expected purpose prevents a Create capture from authorizing an
 * import consumer, including one reached through an unsafe runtime cast. */
export function withApiKeyDocumentCreatePrincipalOnConnection<T>(connection: SqlConnection, principal: ApiKeyDocumentCreatePrincipal,
  purpose: ApiKeyDocumentCreatePurpose, consume: (access: ApiKeyDocumentCreatePrincipalAccess) => Promise<T>): Promise<T> {
  return withFixedPrincipalOnConnection(connection, principal, 'create', access => consume(Object.freeze({
    workspace: access.workspaces[0], userId: access.userId, integrationId: access.integrationId, instanceId: access.instanceId,
    purpose, assertCurrent: access.assertCurrent,
    assertActive: () => assertApiKeyDocumentCreatePrincipalActiveOnConnection(connection, principal, purpose) })), purpose);
}

export function assertApiKeyDocumentCreatePrincipalActiveOnConnection(connection: SqlConnection,
  principal: ApiKeyDocumentCreatePrincipal, purpose: ApiKeyDocumentCreatePurpose): void {
  assertFixedWritePrincipalActiveOnConnection(connection, principal, purpose === 'create' || purpose === 'import' ? [purpose] : []);
}

/** Synchronous final guard for the existing native writer's genuine B phase. */
export function assertApiKeyDocumentEditPrincipalActiveOnConnection(connection: SqlConnection, principal: ApiKeyDocumentEditPrincipal): void {
  assertFixedWritePrincipalActiveOnConnection(connection, principal, ['edit', 'edit_status']);
}

function assertFixedWritePrincipalActiveOnConnection(connection: SqlConnection, principal: object, purposes: readonly Capture['purpose'][]): void {
  const capture = shared.captures.get(principal), phase = shared.phases.get(connection);
  try {
    if (!capture || !phase || phase.capture !== capture || !capture.accepting || !phase.accepting) failure('API_KEY_PRINCIPAL_REQUIRED');
    if (!purposes.includes(capture.purpose) || phase.checking || phase.pending.size) failure('API_KEY_PRINCIPAL_SCOPE_CHANGED');
    active(phase);
  } catch (error) {
    if (capture) capture.failure ??= error;
    if (phase) poison(phase, error);
    throw error;
  }
}

function withFixedPrincipalOnConnection<T>(connection: SqlConnection, principal: object, family: 'document' | 'list' | 'browse' | 'edit' | 'create' | 'copy' | 'path',
  consume: (access: ListAccess) => Promise<T>, browsePurpose?: ApiKeyWorkspaceBrowsePurpose | ApiKeyDocumentCreatePurpose | ApiKeyWorkspaceCopyPurpose | ApiKeyWorkspacePathPurpose): Promise<T> {
  const capture = shared.captures.get(principal);
  const held = shared.phases.get(connection);
  const reject = (error: unknown): Promise<never> => {
    if (held) { held.failure ??= error; held.capture.failure ??= error; }
    if (capture) capture.failure ??= error;
    return Promise.reject(error);
  };
  if (!capture?.active || !capture.accepting) return reject(new ApiKeyAccessError('API_KEY_PRINCIPAL_REQUIRED', 'A current API-key principal is required.', 401));
  const matchesFamily = family === 'document' ? capture.purpose === 'read' || capture.purpose === 'search'
    : family === 'list' ? capture.purpose === 'list'
      : family === 'edit' ? capture.purpose === 'edit' || capture.purpose === 'edit_status'
      : family === 'create' ? (browsePurpose === 'create' || browsePurpose === 'import') && capture.purpose === browsePurpose
      : family === 'copy' ? !!capture.copy && copyPurposes.includes(browsePurpose as ApiKeyWorkspaceCopyPurpose) && capture.purpose === browsePurpose
      : family === 'path' ? !!capture.path && pathPurposes.includes(browsePurpose as ApiKeyWorkspacePathPurpose) && capture.purpose === browsePurpose
        && capture.purpose.startsWith(`${capture.path}_`)
      : (browsePurpose === 'tree' || browsePurpose === 'overview' || browsePurpose === 'manifest') && capture.purpose === browsePurpose;
  if (!matchesFamily) {
    return reject(new ApiKeyAccessError('API_KEY_PRINCIPAL_SCOPE_CHANGED', 'The fixed API-key principal family changed.', 409));
  }
  if (capture.failure !== undefined) return Promise.reject(capture.failure);
  if (capture.busy || held) return reject(new ApiKeyAccessError('API_KEY_PRINCIPAL_SCOPE_CHANGED', 'Reentrant principal use.', 409));
  if (!connection || typeof connection.get !== 'function' || typeof connection.all !== 'function' || typeof connection.run !== 'function'
    || typeof consume !== 'function') return reject(new ApiKeyAccessError('API_KEY_STATE_INVALID', 'Invalid principal connection.', 503));
  capture.busy = true;
  const phase: Phase = { capture, connection, active: true, accepting: true, checking: false, deadline: performance.now() + 5000, pending: new Set() };
  shared.phases.set(connection, phase);
  const result = (async () => {
    try {
      const schema = quote(capture.binding.realm.schema);
      await connection.run("SET LOCAL statement_timeout='5s'");
      await connection.run("SET LOCAL lock_timeout='50ms'");
      await connection.run("SET LOCAL transaction_timeout='5s'");
      await connection.run(`LOCK TABLE ${policyTables.map(name => `${schema}.${quote(name)}`).join(',')} IN SHARE MODE NOWAIT`);
      // Row locks fence this integration's revocation/grant changes while other
      // credentials can still update their bounded usage statistics.
      const locked = await connection.get(`SELECT k.id FROM ${schema}.canvas_api_keys k JOIN ${schema}.canvas_api_integrations i ON i.id=k.integration_id
        WHERE k.id=$1 AND i.id=$2 FOR SHARE OF k,i NOWAIT`, [capture.binding.credentialId, capture.binding.integrationId]);
      if (!locked) throw new ApiKeyAccessError('API_KEY_INVALID', 'The API key is invalid or has expired.', 401);
      const workspaces = await current(phase);
      if (capture.purpose === 'create' || capture.purpose === 'import' || capture.copy || capture.path) {
        // The existing immutable receipt trigger installs this exact schema
        // path during INSERT. Prove the raw entry first, then retain only this
        // server-derived path; other principal families keep their raw realm.
        const configured = await connection.get(`SELECT pg_catalog.set_config('search_path',pg_catalog.quote_ident($1)||', pg_catalog, pg_temp',true) AS actual,
          pg_catalog.quote_ident($1)||', pg_catalog, pg_temp' AS expected`, [capture.binding.realm.schema]) as Row | undefined;
        active(phase);
        if (!configured || typeof configured.expected !== 'string' || configured.actual !== configured.expected) failure('API_KEY_STATE_INVALID');
        phase.expectedSearchPath = configured.expected;
      }
      const assertCurrent = () => {
        const check = (async () => {
          try {
            active(phase); if (!phase.accepting) failure('API_KEY_PRINCIPAL_DETACHED');
            if (phase.checking) failure('API_KEY_PRINCIPAL_SCOPE_CHANGED');
            phase.checking = true;
            try { await current(phase); } finally { phase.checking = false; }
          } catch (error) { poison(phase, error); }
        })();
        phase.pending.add(check); void check.finally(() => phase.pending.delete(check)).catch(() => undefined); return check;
      };
      const value = await consume(Object.freeze({ workspaces, userId: capture.binding.userId, integrationId: capture.binding.integrationId,
        instanceId: capture.binding.instanceId, assertCurrent }));
      phase.accepting = false;
      if (phase.pending.size) { phase.failure ??= new ApiKeyAccessError('API_KEY_PRINCIPAL_DETACHED', 'Detached principal check.', 409); await Promise.allSettled([...phase.pending]); }
      active(phase); await current(phase); active(phase); return value;
    } catch (error) {
      phase.accepting = false;
      if (phase.pending.size) { phase.failure ??= error; await Promise.allSettled([...phase.pending]); }
      const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
      if (code === '55P03') poison(phase, new ApiKeyAccessError('API_KEY_PRINCIPAL_BUSY', 'The credential or workspace policy is busy.', 409));
      if (code === '25P01' || code === '25001' || code === '25006') poison(phase,
        new ApiKeyAccessError('API_KEY_PRINCIPAL_SCOPE_CHANGED', 'The actual principal transaction changed.', 409));
      if (code === '42P01' || code === '42703' || code === '22P02' || code === '22023') poison(phase, new ApiKeyAccessError('API_KEY_STATE_INVALID', 'Invalid credential policy storage.', 503));
      poison(phase, error);
    } finally { phase.active = false; shared.phases.delete(connection); capture.busy = false; }
  })();
  capture.pending.add(result); void result.finally(() => capture.pending.delete(result)).catch(() => undefined); return result;
}
