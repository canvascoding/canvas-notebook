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
import { ApiKeyAccessError } from './contracts';
import { assertApiKeyMcpToolEnabled } from './mcp-runtime';
import { apiKeyCredentialBinding, apiKeyCredentialSnapshotSql, currentApiKeyIdentityFromSnapshot,
  type ApiKeyCredential, type ApiKeyCredentialBinding } from './authentication';

declare const principalBrand: unique symbol;
export type ApiKeyDocumentReadPrincipal = Readonly<{ [principalBrand]: never }>;
declare const workspaceListBrand: unique symbol;
export type ApiKeyWorkspaceListPrincipal = Readonly<{ [workspaceListBrand]: never }>;
export type ApiKeyDocumentReadOrigin = Readonly<{
  kind: 'api_key';
  userId: string; integrationId: string; instanceId: string; credentialId: string;
  workspaceId: string; workspaceType: string; organizationId: string | null; customerId: string | null;
  projectId: string | null; ownerUserId: string | null; rootPath: string; rootRelativePath: string;
  legacy: false; status: 'active'; schema: string; schemaOid: number; databaseOid: number; searchPath: string;
}>;
type Access = Readonly<{ workspace: WorkspaceContext; userId: string; integrationId: string; instanceId: string;
  assertCurrent: () => Promise<void> }>;
type ListAccess = Readonly<Omit<Access, 'workspace'> & { workspaces: readonly WorkspaceContext[] }>;
type Capture = {
  credential: ApiKeyCredential; binding: ApiKeyCredentialBinding; workspaceId: string | null; purpose: 'read' | 'search' | 'list';
  license: LicenseStatus; observer?: (origin: ApiKeyDocumentReadOrigin) => void; origins?: readonly ApiKeyDocumentReadOrigin[];
  mcp: boolean; active: boolean; accepting: boolean; busy: boolean; failure?: unknown; pending: Set<Promise<unknown>>;
};
type Identity = { backend: number; start: string; xid: string };
type Phase = { capture: Capture; connection: SqlConnection; identity?: Identity; deadline: number;
  active: boolean; accepting: boolean; checking: boolean; failure?: unknown; pending: Set<Promise<unknown>> };
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
  const license = phase.capture.license;
  if (license.licensed && ['active', 'grace'].includes(license.licenseState)) {
    const expiry = Date.parse(license.licenseState === 'grace' ? license.graceExpiresAt ?? '' : license.expiresAt ?? '');
    if (!Number.isFinite(expiry) || expiry <= Date.now()) failure('API_KEY_PRINCIPAL_EXPIRED');
  }
}
function validateHeader(phase: Phase, row: Row | undefined): void {
  active(phase);
  const realm = phase.capture.binding.realm;
  if (!row || row.schema !== realm.schema || Number(row.schema_oid) !== realm.schemaOid || Number(row.database_oid) !== realm.databaseOid
    || row.search_path !== realm.searchPath || row.isolation !== 'read committed' || row.read_only !== 'off' || row.replication !== 'origin'
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
  const tool = capture.purpose === 'list' ? 'list_workspaces' : capture.purpose === 'read' ? 'read_knowledge_source' : 'search_knowledge';
  if (capture.mcp) { await assertApiKeyMcpToolEnabled(tool); active(phase); }
  const seatPolicy = resolveEffectiveSeatPolicy(capture.license);
  const pinned = policyTables.map(name => `${quote(name)} AS NOT MATERIALIZED (SELECT * FROM ${schema}.${quote(name)})`).join(',');
  const keySql = postgresScalarSnapshotSql(apiKeyCredentialSnapshotSql(3, binding.realm.schema), ['account_banned', 'expires_at', 'revision']);
  const seatSql = postgresScalarSnapshotSql(userSeatAccessSnapshotSql(2, 4), ['account_banned', 'reconciliation_seat_limit']);
  const workspaceSql = postgresScalarSnapshotSql(workspacePermissionSnapshotSetSql, workspacePermissionSnapshotScalarColumns);
  const row = await phase.connection.get(`WITH ${pinned}
    SELECT header.*,credential.credential_snapshot AS credential,seat.seat_snapshot AS seat,workspaces.snapshots AS workspaces
    FROM (${principalSchemaSnapshotSql(5, 6, tables.length)}) header
    LEFT JOIN (${keySql}) credential(credential_snapshot) ON true
    LEFT JOIN (${seatSql}) seat(seat_snapshot) ON true
    LEFT JOIN LATERAL (SELECT CASE WHEN $1::text IS NOT NULL THEN ARRAY[$1::text]
      ELSE ARRAY(SELECT value FROM pg_catalog.jsonb_array_elements_text(
        (credential.credential_snapshot->>'workspace_ids_json')::jsonb) selected(value) LIMIT 101) END AS ids) selected_workspace_ids ON true
    LEFT JOIN LATERAL (SELECT COALESCE(pg_catalog.jsonb_agg(selected_scope.workspace_snapshot ORDER BY selected_scope.workspace_snapshot->>'id'),'[]'::jsonb) AS snapshots
      FROM (${workspaceSql}) selected_scope(workspace_snapshot)) workspaces ON true`,
  [capture.workspaceId, binding.userId, binding.credentialId, seatPolicy.mode, schema, tables]) as Row | undefined;
  active(phase); validateHeader(phase, row);
  if (capture.mcp) { await assertApiKeyMcpToolEnabled(tool); active(phase); }
  const credential = row!.credential as Row | null;
  if (!credential) throw new ApiKeyAccessError('API_KEY_INVALID', 'The API key is invalid or has expired.', 401);
  const rows = row!.workspaces;
  if (!Array.isArray(rows) || rows.length > 100 || [credential, row!.seat, ...rows]
    .some(value => value && Reflect.get(value, 'scalar_types_supported') !== true)) failure('API_KEY_STATE_INVALID');
  const identity = currentApiKeyIdentityFromSnapshot(capture.credential, credential);
  if (!identity.actions.includes('read') || capture.workspaceId !== null && !identity.workspaceIds.includes(capture.workspaceId)) failure('API_KEY_ACCESS_DENIED');
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
    const workspace = Object.freeze({ ...selected, permissions: Object.freeze({ ...selected.permissions,
      canWrite: false, canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: false }) });
    const origin: ApiKeyDocumentReadOrigin = Object.freeze({ kind: 'api_key', userId: identity.userId, integrationId: identity.integrationId,
      credentialId: identity.credentialId, instanceId: identity.instanceId, workspaceId: workspace.workspaceId, workspaceType: workspace.workspaceType,
      organizationId: workspace.organizationId ?? null, customerId: workspace.customerId ?? null, projectId: workspace.projectId ?? null,
      ownerUserId: workspace.ownerUserId ?? null, rootPath: workspace.rootPath, rootRelativePath: selected.rootRelativePath,
      legacy: false, status: 'active', schema: binding.realm.schema, schemaOid: binding.realm.schemaOid,
      databaseOid: binding.realm.databaseOid, searchPath: binding.realm.searchPath });
    workspaces.push(workspace); origins.push(origin);
  }
  if (capture.workspaceId !== null && (workspaces.length !== 1 || workspaces[0].workspaceId !== capture.workspaceId)) failure('API_KEY_ACCESS_DENIED');
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

async function withCapture<T, P extends object>(credential: ApiKeyCredential,
  selection: Pick<Capture, 'workspaceId' | 'purpose' | 'observer' | 'mcp'>, consume: (principal: P) => Promise<T>): Promise<T> {
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

function withFixedPrincipalOnConnection<T>(connection: SqlConnection, principal: object, family: 'document' | 'list',
  consume: (access: ListAccess) => Promise<T>): Promise<T> {
  const capture = shared.captures.get(principal);
  const held = shared.phases.get(connection);
  const reject = (error: unknown): Promise<never> => {
    if (held) { held.failure ??= error; held.capture.failure ??= error; }
    if (capture) capture.failure ??= error;
    return Promise.reject(error);
  };
  if (!capture?.active || !capture.accepting) return reject(new ApiKeyAccessError('API_KEY_PRINCIPAL_REQUIRED', 'A current API-key principal is required.', 401));
  if (family === 'document' ? capture.purpose !== 'read' && capture.purpose !== 'search' : capture.purpose !== 'list') {
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
