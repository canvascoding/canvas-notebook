import 'server-only';

import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual, types } from 'node:util';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { getPostgresRuntimeQueryable, type SqlConnection } from '@/app/lib/db';
import { normalizeDatabaseTimestamp } from '@/app/lib/db/timestamps';
import { getLicenseStatus } from '@/app/lib/license';
import type { LicenseStatus } from '@/app/lib/license/types';
import { assertUserSeatAccess } from '@/app/lib/license/seat-limit';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { readPostgresWorkspaceForActorOnConnection } from '@/app/lib/workspaces/postgres-runtime';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { assertGrantStateActive, DirectMcpAuthorizationError, loadDirectMcpGrantStateOnConnection,
  verifyDirectMcpJwtClaims, type DirectMcpJwtClaims } from './access-token-verifier';
import { resolveDirectMcpOAuthConfig } from './config';
import { getDirectMcpRuntimeSettings } from './runtime-settings';

declare const principalBrand: unique symbol;
/** A live private MCP read capture. Neither this type nor historical data is a grant. */
export type DirectMcpDocumentReadPrincipal = Readonly<{ [principalBrand]: never }>;
export type DirectMcpDocumentReadPurpose = 'read' | 'search';
export type DirectMcpDocumentReadPrincipalAccess = Readonly<{
  workspace: WorkspaceContext; userId: string; clientId: string; sessionId: string;
  assertCurrent: () => Promise<void>;
}>;
/** Primitive comparison data only; never a token, verified claim or authority. */
export type DirectMcpDocumentReadHistoricalOrigin = Readonly<{
  userId: string; clientId: string; sessionId: string; workspaceId: string; workspaceType: string;
  organizationId: string | null; customerId: string | null; projectId: string | null; ownerUserId: string | null;
  rootPath: string; rootRelativePath: string; legacy: false; status: 'active';
  schema: string; schemaOid: number; searchPath: string; databaseOid: number;
}>;
/** Synchronous, idempotent sink, called before the first B consumer and on rechecks. */
export type DirectMcpDocumentReadHistoricalOriginObserver = (origin: DirectMcpDocumentReadHistoricalOrigin) => void;
declare const createPrincipalBrand: unique symbol;
/** Actual current MCP write capture; original operation attribution stays data. */
export type DirectMcpDocumentCreatePrincipal = Readonly<{ [createPrincipalBrand]: never }>;
export type DirectMcpDocumentCreateTool = 'create_knowledge_source' | 'import_knowledge_file';
export type DirectMcpDocumentCreateCurrentOrigin = DirectMcpDocumentReadHistoricalOrigin
  & Readonly<{ workspaceType: WorkspaceContext['workspaceType']; tool: DirectMcpDocumentCreateTool }>;
export type DirectMcpDocumentCreatePrincipalAccess = DirectMcpDocumentReadPrincipalAccess
  & Readonly<{ tool: DirectMcpDocumentCreateTool }>;
declare const editPrincipalBrand: unique symbol;
/** A distinct fixed editing capture; a read/create handle cannot enter it. */
export type DirectMcpDocumentEditPrincipal = Readonly<{ [editPrincipalBrand]: never }>;
export type DirectMcpDocumentEditCurrentOrigin = DirectMcpDocumentReadHistoricalOrigin
  & Readonly<{ tool: 'edit_knowledge_source' }>;
export type DirectMcpDocumentEditPrincipalAccess = DirectMcpDocumentReadPrincipalAccess
  & Readonly<{ tool: 'edit_knowledge_source'; assertActive: () => void }>;
declare const copyPrincipalBrand: unique symbol;
/** One genuine current MCP capture for both fixed Copy workspaces. */
export type DirectMcpWorkspaceCopyPrincipal = Readonly<{ [copyPrincipalBrand]: never }>;
export type DirectMcpWorkspaceCopyPrincipalAccess = Readonly<{
  sourceWorkspace: WorkspaceContext; destinationWorkspace: WorkspaceContext;
  userId: string; clientId: string; sessionId: string; tool: 'copy_knowledge_source';
  assertCurrent: () => Promise<void>;
}>;
type FixedPolicy = Readonly<{ kind: 'read'; purpose: DirectMcpDocumentReadPurpose }>
  | Readonly<{ kind: 'create'; tool: DirectMcpDocumentCreateTool }>
  | Readonly<{ kind: 'edit'; tool: 'edit_knowledge_source' }>
  | Readonly<{ kind: 'copy'; tool: 'copy_knowledge_source' }>;
type SharedPrincipal = DirectMcpDocumentReadPrincipal | DirectMcpDocumentCreatePrincipal
  | DirectMcpDocumentEditPrincipal | DirectMcpWorkspaceCopyPrincipal;
type AccessFor<Kind extends FixedPolicy['kind']> = Kind extends 'copy'
  ? DirectMcpWorkspaceCopyPrincipalAccess : Kind extends 'create'
    ? DirectMcpDocumentCreatePrincipalAccess : Kind extends 'edit'
      ? DirectMcpDocumentEditPrincipalAccess : DirectMcpDocumentReadPrincipalAccess;
type ErrorCode = 'MCP_READ_PRINCIPAL_REQUIRED' | 'MCP_READ_PRINCIPAL_INVALID' | 'MCP_READ_PRINCIPAL_BUSY'
  | 'MCP_READ_PRINCIPAL_SCOPE_CHANGED' | 'MCP_READ_PRINCIPAL_ACCESS_DENIED' | 'MCP_READ_PRINCIPAL_SCHEMA_INVALID'
  | 'MCP_READ_PRINCIPAL_DETACHED' | 'MCP_READ_PRINCIPAL_REENTRANT' | 'MCP_READ_PRINCIPAL_EXPIRED';
export class DirectMcpDocumentReadPrincipalError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode) {
    super(code); this.name = 'DirectMcpDocumentReadPrincipalError';
    this.status = code === 'MCP_READ_PRINCIPAL_REQUIRED' ? 401 : code === 'MCP_READ_PRINCIPAL_INVALID' ? 400
      : code === 'MCP_READ_PRINCIPAL_ACCESS_DENIED' ? 403 : code === 'MCP_READ_PRINCIPAL_SCHEMA_INVALID' ? 503 : 409;
  }
}
type Row = Record<string, unknown>;
type OriginalRealm = Readonly<{ schema: string; schemaOid: number; databaseOid: number; searchPath: string }>;
type Identity = OriginalRealm & Readonly<{ backend: number; start: string; xid: string }>;
type WorkspaceSlot = Readonly<{ workspaceId: string }>;
type CaptureSlots = Readonly<{ kind: 'single'; workspace: WorkspaceSlot;
  observe: DirectMcpDocumentReadHistoricalOriginObserver }>
  | Readonly<{ kind: 'copy'; source: WorkspaceSlot; destination: WorkspaceSlot }>;
type CurrentWorkspaces = Readonly<{ kind: 'single'; workspace: WorkspaceContext }>
  | Readonly<{ kind: 'copy'; sourceWorkspace: WorkspaceContext; destinationWorkspace: WorkspaceContext }>;
type Capture = {
  active: boolean; accepting: boolean; busy: boolean; failure?: unknown; pending: Set<Promise<unknown>>;
  token: string; claims: DirectMcpJwtClaims; policy: FixedPolicy; slots: CaptureSlots;
  realm: OriginalRealm; license: LicenseStatus; issuer: string; resource: string;
  originals: Map<WorkspaceSlot, DirectMcpDocumentReadHistoricalOrigin>;
};
type Phase = {
  capture: Capture; connection: SqlConnection; active: boolean; accepting: boolean; checking: boolean;
  identity?: Identity; writeRealm?: OriginalRealm; failure?: unknown; deadline: number; pending: Set<Promise<unknown>>;
  editSessionExpiresAt?: number;
};
const captures = new WeakMap<SharedPrincipal, Capture>();
const phases = new WeakMap<SqlConnection, Phase>();
const MAX_PHASE_MS = 5000;
const tables = ['canvas_organization_settings', 'team_memberships', 'team_membership_sync_state', 'user', 'session',
  'organization_user_permissions', 'canvas_workspaces', 'canvas_projects', 'canvas_workspace_members', 'canvas_project_members',
  'oauth_client', 'oauth_consent', 'mcp_revoked_access_token', 'mcp_direct_grant_revocation',
  'mcp_direct_workspace_setting', 'mcp_direct_workspace_grant'] as const;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value).toString('utf8') === value;
const integer = (value: unknown) => (typeof value === 'number' || typeof value === 'string' && /^[1-9][0-9]*$/u.test(value))
  && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const flag = (value: unknown) => value === null || [false, true, 0, 1, '0', '1'].includes(value as never);
function fail(code: ErrorCode): never { throw new DirectMcpDocumentReadPrincipalError(code); }
function primary(error: unknown): unknown { return error ?? new DirectMcpDocumentReadPrincipalError('MCP_READ_PRINCIPAL_INVALID'); }
function poison(phase: Phase, error: unknown): never {
  phase.failure ??= primary(error); phase.capture.failure ??= phase.failure; throw phase.failure;
}
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('MCP_READ_PRINCIPAL_INVALID');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail('MCP_READ_PRINCIPAL_INVALID');
  return descriptor.value;
}
function singleSlots(workspaceId: unknown,
  observe: DirectMcpDocumentReadHistoricalOriginObserver): CaptureSlots {
  if (!validId(workspaceId) || typeof observe !== 'function') fail('MCP_READ_PRINCIPAL_INVALID');
  return Object.freeze({ kind: 'single', workspace: Object.freeze({ workspaceId }), observe });
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function alive(phase: Phase): void {
  if (!phase.active || !phase.capture.active || phases.get(phase.connection) !== phase) fail('MCP_READ_PRINCIPAL_REQUIRED');
  if (phase.failure !== undefined) throw phase.failure;
  if (phase.capture.failure !== undefined) throw phase.capture.failure;
  if (performance.now() > phase.deadline) fail('MCP_READ_PRINCIPAL_EXPIRED');
  assertCaptureUnexpired(phase.capture);
}
function assertCaptureUnexpired(capture: Capture): void {
  if (capture.claims.expiresAt * 1000 <= Date.now()) fail('MCP_READ_PRINCIPAL_EXPIRED');
  const license = capture.license;
  if (license.licensed && ['active', 'grace'].includes(license.licenseState)) {
    const expiry = Date.parse(license.licenseState === 'grace' ? license.graceExpiresAt ?? '' : license.expiresAt ?? '');
    if (!Number.isFinite(expiry) || expiry <= Date.now()) fail('MCP_READ_PRINCIPAL_EXPIRED');
  }
}
const realmSql = `SELECT pg_catalog.current_schema() AS schema,
  pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema_oid,
  (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
  CASE WHEN octet_length(pg_catalog.current_setting('search_path'))<=16384 THEN pg_catalog.current_setting('search_path') END AS search_path`;
function parseRealm(row: Row | undefined): OriginalRealm {
  if (!row || !validId(row.schema) || row.schema.length > 63 || !integer(row.schema_oid) || !integer(row.database_oid)
    || typeof row.search_path !== 'string' || !row.search_path || row.search_path.length > 4096) fail('MCP_READ_PRINCIPAL_SCOPE_CHANGED');
  return Object.freeze({ schema: row.schema, schemaOid: Number(row.schema_oid), databaseOid: Number(row.database_oid), searchPath: row.search_path });
}
async function sourceRealm(): Promise<OriginalRealm> {
  const pool = getPostgresRuntimeQueryable(); if (!pool) fail('MCP_READ_PRINCIPAL_REQUIRED');
  return parseRealm((await pool.query(realmSql)).rows[0]);
}
async function identity(phase: Phase): Promise<Identity> {
  alive(phase);
  const row = await phase.connection.get(`SELECT r.*,pg_catalog.pg_backend_pid() AS backend,
    extract(epoch FROM a.backend_start)::text AS start,
    CASE WHEN pg_catalog.current_setting('transaction_isolation')='read committed'
      AND pg_catalog.current_setting('transaction_read_only')='off' THEN pg_catalog.pg_current_xact_id()::text END AS xid,
    pg_catalog.current_setting('transaction_isolation') AS isolation,pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('session_replication_role') AS replication
    FROM (${realmSql}) r JOIN pg_catalog.pg_stat_activity a ON a.pid=pg_catalog.pg_backend_pid()`) as Row | undefined;
  alive(phase); const realm = parseRealm(row);
  if (!row || !isDeepStrictEqual(realm, phase.writeRealm ?? phase.capture.realm) || !integer(row.backend)
    || typeof row.start !== 'string' || !/^[0-9]+\.[0-9]+$/u.test(row.start)
    || typeof row.xid !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(row.xid)
    || row.isolation !== 'read committed' || row.read_only !== 'off' || row.replication !== 'origin') fail('MCP_READ_PRINCIPAL_SCOPE_CHANGED');
  const result = Object.freeze({ ...realm, backend: Number(row.backend), start: row.start, xid: row.xid });
  if (phase.identity && !isDeepStrictEqual(result, phase.identity)) fail('MCP_READ_PRINCIPAL_SCOPE_CHANGED');
  return result;
}
/** Create alone enters the existing receipt triggers' fixed schema path.
 * The caller's original B/realm is checked first. The same backend/start/XID
 * must then confirm this one fixed transition before any consumer runs.
 * Historical origin continues to describe the actual source factory realm. */
async function pinCreateReceiptRealm(phase: Phase): Promise<void> {
  if (phase.capture.policy.kind !== 'create' || !phase.identity || phase.writeRealm) fail('MCP_READ_PRINCIPAL_INVALID');
  const before = phase.identity;
  const row = await phase.connection.get(`SELECT pg_catalog.set_config('search_path',
    pg_catalog.quote_ident($1::text)||', pg_catalog, pg_temp',true) AS search_path`,
  [phase.capture.realm.schema]) as Row | undefined;
  alive(phase);
  const realm = parseRealm({ schema: phase.capture.realm.schema, schema_oid: phase.capture.realm.schemaOid,
    database_oid: phase.capture.realm.databaseOid, search_path: row?.search_path });
  phase.writeRealm = realm;
  phase.identity = Object.freeze({ ...before, searchPath: realm.searchPath });
  await identity(phase); await schema(phase);
}
async function schema(phase: Phase): Promise<void> {
  await identity(phase);
  const rows = await phase.connection.all(`SELECT name,
    pg_catalog.to_regclass(name)::oid=pg_catalog.to_regclass($1||'.'||pg_catalog.quote_ident(name))::oid AS same_relation
    FROM pg_catalog.unnest($2::text[]) names(name)`, [quote(phase.capture.realm.schema), tables]) as Row[];
  alive(phase);
  if (rows.length !== tables.length || new Set(rows.map(row => row.name)).size !== tables.length
    || rows.some(row => !tables.includes(row.name as typeof tables[number]) || row.same_relation !== true)) fail('MCP_READ_PRINCIPAL_SCHEMA_INVALID');
}
async function runtime(capture: Capture): Promise<void> {
  const config = resolveDirectMcpOAuthConfig();
  if (config.issuer !== capture.issuer || config.resource !== capture.resource) fail('MCP_READ_PRINCIPAL_SCOPE_CHANGED');
  const settings = await getDirectMcpRuntimeSettings();
  const tool = capture.policy.kind !== 'read' ? capture.policy.tool
    : capture.policy.purpose === 'read' ? 'read_knowledge_source' : 'search_knowledge';
  if (settings.enabled !== true || !settings.tools.includes(tool)) fail('MCP_READ_PRINCIPAL_ACCESS_DENIED');
}
function historical(workspace: WorkspaceContext, capture: Capture, slot: WorkspaceSlot): DirectMcpDocumentReadHistoricalOrigin {
  if (!validId(workspace.workspaceId) || workspace.workspaceId !== slot.workspaceId || workspace.legacy !== false
    || workspace.status !== 'active' || !workspace.permissions.canRead || workspace.actor?.userId !== capture.claims.subject
    || typeof workspace.rootPath !== 'string' || !workspace.rootPath || workspace.rootPath.length > 4096
    || typeof workspace.rootRelativePath !== 'string' || !workspace.rootRelativePath || workspace.rootRelativePath.length > 4096
    || !['personal', 'organization', 'team', 'project'].includes(workspace.workspaceType)
    || [workspace.organizationId, workspace.customerId, workspace.projectId, workspace.ownerUserId]
      .some(value => value != null && !validId(value))) fail('MCP_READ_PRINCIPAL_SCOPE_CHANGED');
  return Object.freeze({ userId: capture.claims.subject, clientId: capture.claims.clientId, sessionId: capture.claims.sessionId,
    workspaceId: workspace.workspaceId, workspaceType: workspace.workspaceType, organizationId: workspace.organizationId ?? null,
    customerId: workspace.customerId ?? null, projectId: workspace.projectId ?? null, ownerUserId: workspace.ownerUserId ?? null,
    rootPath: workspace.rootPath, rootRelativePath: workspace.rootRelativePath, legacy: false, status: 'active', ...capture.realm });
}
/** Slots are private fixed selections, never caller-supplied permission DTOs. */
async function currentSlot(phase: Phase, slot: WorkspaceSlot): Promise<WorkspaceContext> {
  alive(phase); await schema(phase); const { connection, capture } = phase;
  const slots = capture.slots;
  if (slots.kind === 'single'
    ? capture.policy.kind === 'copy' || slot !== slots.workspace
    : capture.policy.kind !== 'copy' || slot !== slots.source && slot !== slots.destination) fail('MCP_READ_PRINCIPAL_INVALID');
  await runtime(capture); alive(phase);
  // Bound all strings before the unchanged shared grant loader materializes them.
  const raw = await connection.get(`SELECT
    CASE WHEN octet_length(u.id)<=1024 THEN u.id END AS id,
    CASE WHEN octet_length(u.email)<=4096 THEN u.email END AS email,
    CASE WHEN octet_length(u.role)<=256 THEN u.role END AS role,u.banned,c.disabled,s.expires_at AS edit_session_expires_at,
    (octet_length(u.id)<=1024 AND octet_length(u.email)<=4096 AND (u.role IS NULL OR octet_length(u.role)<=256)
      AND octet_length(s.id)<=1024 AND octet_length(s.user_id)<=1024 AND octet_length(c.client_id)<=1024
      AND (c.name IS NULL OR octet_length(c.name)<=4096)) AS bounded
    FROM "user" u JOIN "session" s ON s.user_id=u.id CROSS JOIN oauth_client c
    WHERE u.id=$1 AND s.id=$2 AND c.client_id=$3 LIMIT 1`, [capture.claims.subject, capture.claims.sessionId, capture.claims.clientId]) as Row | undefined;
  alive(phase);
  if (!raw || raw.bounded !== true || raw.id !== capture.claims.subject || typeof raw.email !== 'string'
    || raw.role !== null && typeof raw.role !== 'string' || !flag(raw.banned) || !flag(raw.disabled)) fail('MCP_READ_PRINCIPAL_ACCESS_DENIED');
  const state = await loadDirectMcpGrantStateOnConnection(connection, capture.claims, capture.token); alive(phase);
  if (state && (!flag(state.user_banned) || !flag(state.client_disabled))) fail('MCP_READ_PRINCIPAL_ACCESS_DENIED');
  assertGrantStateActive(state, capture.claims);
  const permitted = await connection.get(`SELECT EXISTS(SELECT 1 FROM mcp_direct_workspace_setting WHERE workspace_id=$1) AS opted_in,
    EXISTS(SELECT 1 FROM mcp_direct_workspace_grant WHERE workspace_id=$1 AND client_id=$2 AND user_id=$3) AS granted`,
  [slot.workspaceId, capture.claims.clientId, capture.claims.subject]) as Row | undefined;
  alive(phase); if (permitted?.opted_in !== true || permitted.granted !== true) fail('MCP_READ_PRINCIPAL_ACCESS_DENIED');
  const organizations = await connection.all('SELECT team_features_enabled FROM canvas_organization_settings LIMIT 17') as Row[];
  const permissions = await connection.all(`SELECT can_write_team_workspace,can_create_public_links,can_create_team_automations
    FROM organization_user_permissions WHERE user_id=$1 LIMIT 1025`, [capture.claims.subject]) as Row[];
  alive(phase);
  if (organizations.length > 16 || permissions.length > 1024 || organizations.some(row => !flag(row.team_features_enabled))
    || permissions.some(row => Object.values(row).some(value => !flag(value)))) fail('MCP_READ_PRINCIPAL_SCHEMA_INVALID');
  await assertUserSeatAccess({ userId: capture.claims.subject, database: connection, licenseStatus: capture.license }); alive(phase);
  const workspace = await readPostgresWorkspaceForActorOnConnection(connection,
    resolveWorkspaceActor({ id: capture.claims.subject, email: raw.email, role: raw.role as string | null }), slot.workspaceId);
  const requiresWrite = slots.kind === 'single' ? capture.policy.kind !== 'read' : slot === slots.destination;
  alive(phase); if (!workspace || workspace.permissions.canRead !== true
    || requiresWrite && (workspace.permissions.canWrite !== true
      || workspace.permissions.canRunAgent !== true)) fail('MCP_READ_PRINCIPAL_ACCESS_DENIED');
  const origin = historical(workspace, capture, slot), original = capture.originals.get(slot);
  if (original && !isDeepStrictEqual(origin, original)) fail('MCP_READ_PRINCIPAL_SCOPE_CHANGED');
  if (!original) capture.originals.set(slot, origin);
  await identity(phase);
  if (slots.kind === 'single') {
    const returned: unknown = slots.observe(original ?? origin);
    if (returned !== undefined) {
      if (types.isPromise(returned)) void returned.catch(() => undefined);
      fail('MCP_READ_PRINCIPAL_DETACHED');
    }
  }
  if (capture.policy.kind === 'edit') {
    if (!integer(raw.edit_session_expires_at)) fail('MCP_READ_PRINCIPAL_ACCESS_DENIED');
    phase.editSessionExpiresAt = normalizeDatabaseTimestamp(Number(raw.edit_session_expires_at));
    if (phase.editSessionExpiresAt <= Date.now()) fail('MCP_READ_PRINCIPAL_EXPIRED');
  }
  alive(phase); return freeze(structuredClone(workspace));
}

/** One common B/XID/deadline: source->destination before the consumer,
 * destination->source after it. Equal IDs share the stronger destination slot. */
async function current(phase: Phase, final = false): Promise<CurrentWorkspaces> {
  const slots = phase.capture.slots;
  if (slots.kind === 'single') {
    return Object.freeze({ kind: 'single', workspace: await currentSlot(phase, slots.workspace) });
  }
  if (slots.source === slots.destination) {
    const workspace = await currentSlot(phase, slots.destination);
    return Object.freeze({ kind: 'copy', sourceWorkspace: workspace, destinationWorkspace: workspace });
  }
  if (final) {
    const destinationWorkspace = await currentSlot(phase, slots.destination);
    const sourceWorkspace = await currentSlot(phase, slots.source);
    return Object.freeze({ kind: 'copy', sourceWorkspace, destinationWorkspace });
  }
  const sourceWorkspace = await currentSlot(phase, slots.source);
  const destinationWorkspace = await currentSlot(phase, slots.destination);
  return Object.freeze({ kind: 'copy', sourceWorkspace, destinationWorkspace });
}

/** Genuine JWT /mcp capture. SQL authorization belongs exclusively to caller B. */
export async function withDirectMcpDocumentReadPrincipal<T>(authInfo: AuthInfo,
  options: { workspaceId: string; purpose: DirectMcpDocumentReadPurpose },
  observe: DirectMcpDocumentReadHistoricalOriginObserver,
  operation: (principal: DirectMcpDocumentReadPrincipal) => Promise<T>): Promise<T> {
  const workspaceId = own(options, 'workspaceId'), purpose = own(options, 'purpose');
  if (!['read', 'search'].includes(purpose as string) || typeof observe !== 'function' || typeof operation !== 'function') {
    fail('MCP_READ_PRINCIPAL_INVALID');
  }
  return withFixedPrincipalCapture(authInfo, singleSlots(workspaceId, observe),
    Object.freeze({ kind: 'read', purpose: purpose as DirectMcpDocumentReadPurpose }),
    principal => operation(principal as DirectMcpDocumentReadPrincipal));
}

/** Actual current origin only; no stored original session enters this factory. */
export async function withDirectMcpDocumentCreatePrincipal<T>(authInfo: AuthInfo,
  options: { workspaceId: string; tool: DirectMcpDocumentCreateTool },
  observeCurrent: (origin: DirectMcpDocumentCreateCurrentOrigin) => void,
  operation: (principal: DirectMcpDocumentCreatePrincipal) => Promise<T>): Promise<T> {
  const workspaceId = own(options, 'workspaceId'), tool = own(options, 'tool');
  if (!['create_knowledge_source', 'import_knowledge_file'].includes(tool as string)
    || typeof observeCurrent !== 'function' || typeof operation !== 'function') fail('MCP_READ_PRINCIPAL_INVALID');
  const policy = Object.freeze({ kind: 'create' as const, tool: tool as DirectMcpDocumentCreateTool });
  return withFixedPrincipalCapture(authInfo, singleSlots(workspaceId,
    // Preserve the actual return: current() must still reject async observers.
    origin => {
      const workspaceType = origin.workspaceType;
      if (workspaceType !== 'personal' && workspaceType !== 'organization' && workspaceType !== 'team' && workspaceType !== 'project') {
        fail('MCP_READ_PRINCIPAL_SCOPE_CHANGED');
      }
      return observeCurrent(Object.freeze({ ...origin, workspaceType, tool: policy.tool }));
    }), policy,
    principal => operation(principal as DirectMcpDocumentCreatePrincipal));
}

/** Fixed tool and write scope; historical operation attribution is never an input. */
export async function withDirectMcpDocumentEditPrincipal<T>(authInfo: AuthInfo,
  options: { workspaceId: string },
  observeCurrent: (origin: DirectMcpDocumentEditCurrentOrigin) => void,
  operation: (principal: DirectMcpDocumentEditPrincipal) => Promise<T>): Promise<T> {
  const workspaceId = own(options, 'workspaceId');
  if (typeof observeCurrent !== 'function' || typeof operation !== 'function') fail('MCP_READ_PRINCIPAL_INVALID');
  return withFixedPrincipalCapture(authInfo, singleSlots(workspaceId,
    origin => observeCurrent(Object.freeze({ ...origin, tool: 'edit_knowledge_source' }))),
    Object.freeze({ kind: 'edit', tool: 'edit_knowledge_source' }),
    principal => operation(principal as DirectMcpDocumentEditPrincipal));
}

/** One actual token/claims capture. Stored Copy origins are not factory inputs. */
export async function withDirectMcpWorkspaceCopyPrincipal<T>(authInfo: AuthInfo,
  options: { sourceWorkspaceId: string; destinationWorkspaceId: string },
  operation: (principal: DirectMcpWorkspaceCopyPrincipal) => Promise<T>): Promise<T> {
  const sourceWorkspaceId = own(options, 'sourceWorkspaceId'), destinationWorkspaceId = own(options, 'destinationWorkspaceId');
  if (!validId(sourceWorkspaceId) || !validId(destinationWorkspaceId) || typeof operation !== 'function') {
    fail('MCP_READ_PRINCIPAL_INVALID');
  }
  const source = Object.freeze({ workspaceId: sourceWorkspaceId });
  const destination = sourceWorkspaceId === destinationWorkspaceId ? source : Object.freeze({ workspaceId: destinationWorkspaceId });
  return withFixedPrincipalCapture(authInfo, Object.freeze({ kind: 'copy', source, destination }),
    Object.freeze({ kind: 'copy', tool: 'copy_knowledge_source' }),
    principal => operation(principal as DirectMcpWorkspaceCopyPrincipal));
}

/** Registry/lifetime preflight before a Copy owner borrows B. This confirms
 * only the actual current capture and its fixed selections, never SQL rights.
 * Call outside its authority phase; every B still needs the full current
 * workspace/grant/session check. The handle must never enter stored history. */
export function assertDirectMcpWorkspaceCopyPrincipalCaptured(principal: DirectMcpWorkspaceCopyPrincipal,
  options: Readonly<{ sourceWorkspaceId: string; destinationWorkspaceId: string }>): void {
  const capture = captures.get(principal);
  if (!capture?.active || !capture.accepting) {
    fail('MCP_READ_PRINCIPAL_REQUIRED');
  }
  if (capture.failure !== undefined) throw capture.failure;
  try {
    if (capture.policy.kind !== 'copy' || capture.slots.kind !== 'copy') fail('MCP_READ_PRINCIPAL_REQUIRED');
    if (capture.busy) fail('MCP_READ_PRINCIPAL_REENTRANT');
    const sourceWorkspaceId = own(options, 'sourceWorkspaceId'), destinationWorkspaceId = own(options, 'destinationWorkspaceId');
    if (!validId(sourceWorkspaceId) || !validId(destinationWorkspaceId)
      || sourceWorkspaceId !== capture.slots.source.workspaceId || destinationWorkspaceId !== capture.slots.destination.workspaceId) {
      fail('MCP_READ_PRINCIPAL_SCOPE_CHANGED');
    }
    assertCaptureUnexpired(capture);
  } catch (error) { capture.failure ??= primary(error); throw capture.failure; }
}

/** Private fixed policy mechanics; callers cannot supply rights or auth readers. */
async function withFixedPrincipalCapture<T>(authInfo: AuthInfo, slots: CaptureSlots, policy: FixedPolicy,
  operation: (principal: SharedPrincipal) => Promise<T>): Promise<T> {
  const suppliedToken = own(authInfo, 'token');
  if (typeof suppliedToken !== 'string' || !suppliedToken.trim() || suppliedToken.length > 16384
    || typeof operation !== 'function' || (slots.kind === 'copy') !== (policy.kind === 'copy')) {
    fail('MCP_READ_PRINCIPAL_INVALID');
  }
  const token = suppliedToken.trim();
  // The runtime realm is observed BEFORE JWT/JWKS, license or settings capture.
  const realm = await sourceRealm();
  const config = resolveDirectMcpOAuthConfig();
  const claims = freeze(structuredClone(await verifyDirectMcpJwtClaims(token)));
  if (![claims.subject, claims.clientId, claims.sessionId].every(validId)) fail('MCP_READ_PRINCIPAL_INVALID');
  const requiredScope = policy.kind !== 'read' ? 'knowledge:write'
    : policy.purpose === 'read' ? 'knowledge:read' : 'knowledge:search';
  if (!claims.scopes.includes(requiredScope)) throw new DirectMcpAuthorizationError('insufficient_scope', 403,
    'Additional authorization is required.', { challengeError: 'insufficient_scope', scope: requiredScope });
  const capture: Capture = { active: true, accepting: true, busy: false, pending: new Set(), token, claims,
    slots, policy, realm, license: freeze(structuredClone(await getLicenseStatus())),
    issuer: config.issuer, resource: config.resource, originals: new Map() };
  await runtime(capture);
  if (!isDeepStrictEqual(await sourceRealm(), realm)) fail('MCP_READ_PRINCIPAL_SCOPE_CHANGED');
  const principal = Object.freeze({}) as SharedPrincipal; captures.set(principal, capture);
  try {
    let result: T | undefined, failure: unknown;
    try { result = await operation(principal); } catch (error) { failure = primary(error); capture.failure ??= failure; }
    capture.accepting = false;
    if (capture.pending.size) { capture.failure ??= new DirectMcpDocumentReadPrincipalError('MCP_READ_PRINCIPAL_DETACHED'); await Promise.allSettled([...capture.pending]); }
    if (failure !== undefined) throw failure;
    if (capture.failure !== undefined) throw capture.failure;
    return result as T;
  } finally { capture.active = false; capture.accepting = false; captures.delete(principal); capture.token = ''; }
}

/** No BEGIN, COMMIT, ROLLBACK or close. A caller must discard results on any failure. */
export function withDirectMcpDocumentReadPrincipalOnConnection<T>(connection: SqlConnection,
  principal: DirectMcpDocumentReadPrincipal,
  operation: (access: DirectMcpDocumentReadPrincipalAccess) => Promise<T>): Promise<T> {
  return withFixedPrincipalOnConnection(connection, principal, 'read', operation);
}

/** Same actual B/lifetime checks, with the fixed write policy and current tool. */
export function withDirectMcpDocumentCreatePrincipalOnConnection<T>(connection: SqlConnection,
  principal: DirectMcpDocumentCreatePrincipal,
  operation: (access: DirectMcpDocumentCreatePrincipalAccess) => Promise<T>): Promise<T> {
  return withFixedPrincipalOnConnection(connection, principal, 'create', operation);
}

/** Same B and actual current write policy; no transaction ownership is granted. */
export function withDirectMcpDocumentEditPrincipalOnConnection<T>(connection: SqlConnection,
  principal: DirectMcpDocumentEditPrincipal,
  operation: (access: DirectMcpDocumentEditPrincipalAccess) => Promise<T>): Promise<T> {
  return withFixedPrincipalOnConnection(connection, principal, 'edit', operation);
}

/** Both fixed workspaces on one caller-held B; this API owns no transaction. */
export function withDirectMcpWorkspaceCopyPrincipalOnConnection<T>(connection: SqlConnection,
  principal: DirectMcpWorkspaceCopyPrincipal,
  operation: (access: DirectMcpWorkspaceCopyPrincipalAccess) => Promise<T>): Promise<T> {
  return withFixedPrincipalOnConnection(connection, principal, 'copy', operation);
}

function assertEditPhaseActive(phase: Phase): void {
  try {
    alive(phase);
    if (phase.capture.policy.kind !== 'edit' || !phase.accepting) fail('MCP_READ_PRINCIPAL_REQUIRED');
    if (phase.checking || phase.pending.size) fail('MCP_READ_PRINCIPAL_REENTRANT');
    if (!Number.isSafeInteger(phase.editSessionExpiresAt) || phase.editSessionExpiresAt! <= Date.now()) {
      fail('MCP_READ_PRINCIPAL_EXPIRED');
    }
  } catch (error) { poison(phase, error); }
}

function withFixedPrincipalOnConnection<T, Kind extends FixedPolicy['kind']>(connection: SqlConnection,
  principal: SharedPrincipal, kind: Kind, operation: (access: AccessFor<Kind>) => Promise<T>): Promise<T> {
  const capture = captures.get(principal);
  if (capture && capture.policy.kind !== kind) {
    capture.failure ??= new DirectMcpDocumentReadPrincipalError('MCP_READ_PRINCIPAL_REQUIRED');
    const held = phases.get(connection);
    if (held) { held.failure ??= capture.failure; held.capture.failure ??= held.failure; }
    return Promise.reject(capture.failure);
  }
  if (!capture?.active || !capture.accepting) {
    const failure = new DirectMcpDocumentReadPrincipalError('MCP_READ_PRINCIPAL_REQUIRED');
    const held = phases.get(connection);
    if (held) { held.failure ??= failure; held.capture.failure ??= failure; }
    return Promise.reject(failure);
  }
  if (capture.failure !== undefined) return Promise.reject(capture.failure);
  if (capture.busy || phases.has(connection)) {
    capture.failure ??= new DirectMcpDocumentReadPrincipalError('MCP_READ_PRINCIPAL_REENTRANT');
    const held = phases.get(connection); if (held) { held.failure ??= capture.failure; held.capture.failure ??= capture.failure; }
    return Promise.reject(capture.failure);
  }
  if (!connection || typeof connection.get !== 'function' || typeof connection.all !== 'function'
    || typeof connection.run !== 'function' || typeof operation !== 'function') {
    capture.failure ??= new DirectMcpDocumentReadPrincipalError('MCP_READ_PRINCIPAL_INVALID'); return Promise.reject(capture.failure);
  }
  capture.busy = true;
  const phase: Phase = { capture, connection, active: true, accepting: true, checking: false,
    deadline: performance.now() + MAX_PHASE_MS, pending: new Set() };
  phases.set(connection, phase);
  const result = (async () => {
    try {
      phase.identity = await identity(phase);
      await connection.run("SET LOCAL statement_timeout='5s'");
      await connection.run("SET LOCAL lock_timeout='50ms'");
      await connection.run("SET LOCAL transaction_timeout='5s'");
      await schema(phase);
      if (capture.policy.kind === 'create') await pinCreateReceiptRealm(phase);
      // SHARE table locks cover absent rows and latest-consent phantoms too.
      await connection.run(`LOCK TABLE ${tables.map(name => `${quote(capture.realm.schema)}.${quote(name)}`).join(',')} IN SHARE MODE NOWAIT`);
      await schema(phase); const selected = await current(phase);
      const assertCurrent = () => {
        const check = (async () => {
          try {
            alive(phase); if (!phase.accepting) fail('MCP_READ_PRINCIPAL_DETACHED');
            if (phase.checking) fail('MCP_READ_PRINCIPAL_REENTRANT');
            phase.checking = true;
            try { await current(phase); } finally { phase.checking = false; }
          } catch (error) { poison(phase, error); }
        })();
        phase.pending.add(check); void check.finally(() => phase.pending.delete(check)).catch(() => undefined); return check;
      };
      // The private capture kind was checked before phase entry. No caller DTO
      // supplies the extra write-tool field or the live assertCurrent closure.
      const access = Object.freeze({
        ...(selected.kind === 'copy'
          ? { sourceWorkspace: selected.sourceWorkspace, destinationWorkspace: selected.destinationWorkspace }
          : { workspace: selected.workspace }),
        userId: capture.claims.subject, clientId: capture.claims.clientId,
        sessionId: capture.claims.sessionId, assertCurrent,
        ...(capture.policy.kind !== 'read' ? { tool: capture.policy.tool } : {}),
        ...(capture.policy.kind === 'edit' ? { assertActive: () => assertEditPhaseActive(phase) } : {}) }) as AccessFor<Kind>;
      const value = await operation(access); phase.accepting = false;
      if (phase.pending.size) { phase.failure ??= new DirectMcpDocumentReadPrincipalError('MCP_READ_PRINCIPAL_DETACHED'); await Promise.allSettled([...phase.pending]); }
      alive(phase); await current(phase, true); alive(phase); return value;
    } catch (error) {
      phase.accepting = false;
      if (phase.pending.size) {
        phase.failure ??= primary(error);
        await Promise.allSettled([...phase.pending]);
      }
      const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null;
      poison(phase, code === '55P03' ? new DirectMcpDocumentReadPrincipalError('MCP_READ_PRINCIPAL_BUSY') : error);
    } finally { phase.active = false; phase.accepting = false; phases.delete(connection); capture.busy = false; }
  })();
  capture.pending.add(result); void result.finally(() => capture.pending.delete(result)).catch(() => undefined); return result;
}
