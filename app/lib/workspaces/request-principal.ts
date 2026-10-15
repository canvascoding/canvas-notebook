import 'server-only';

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { NextRequest } from 'next/server';
import { getPostgresRuntimeQueryable, type SqlConnection } from '../db';
import { normalizeDatabaseTimestamp } from '../db/timestamps';
import { getLicenseStatus } from '../license';
import { assertUserSeatAccess } from '../license/seat-limit';
import type { LicenseStatus } from '../license/types';
import { resolveWorkspaceActor } from './context';
import { readPostgresWorkspaceForActorOnConnection } from './postgres-runtime';
import { requireRequestWorkspace } from './request';
import type { WorkspaceContext } from './types';

/** Inactive identity/rights foundation. This grants no document admission,
 * lifecycle claim, content read/write, filesystem or COMMIT authority. */
declare const principalBrand: unique symbol;
export type WorkspaceRequestPrincipal = Readonly<{ [principalBrand]: never }>;
export type WorkspaceRequestPrincipalAccess = Readonly<{
  workspace: WorkspaceContext; userId: string; sessionId: string; assertCurrent: () => Promise<void>;
}>;
type Row = Record<string, unknown>;
type Identity = Readonly<{ schema: string; searchPath: string; database: number; backend: number; start: string; transaction: string }>;
type RequestCapture = {
  active: boolean; accepting: boolean; failure?: unknown; pending: Set<Promise<unknown>>;
  userId: string; sessionId: string; tokenHash: string; impersonatedBy: unknown;
  workspace: WorkspaceContext; permission: 'canRead' | 'canWrite'; license: LicenseStatus; database: number; schema: string; enterBefore: number;
  originalOrigin?: { observe: WorkspaceRequestHistoricalOriginObserver; realm: Readonly<{ schemaOid: number; searchPath: string }> };
};
/** Historical identity only. It conveys neither permissions nor a live principal. */
export type WorkspaceRequestHistoricalOrigin = Readonly<{
  userId: string; sessionId: string; impersonatedBy: string | null; workspaceId: string; workspaceType: string;
  organizationId: string | null; customerId: string | null; projectId: string | null; ownerUserId: string | null;
  rootPath: string; rootRelativePath: string; legacy: false; status: 'active';
  schema: string; schemaOid: number; searchPath: string; databaseOid: number;
}>;
export type WorkspaceRequestHistoricalOriginObserver = (origin: WorkspaceRequestHistoricalOrigin) => void;
type Phase = { active: boolean; failure?: unknown; request: RequestCapture; database: SqlConnection;
  identity?: Identity; deadline: number; checking: boolean; pending: Set<Promise<unknown>> };
const requests = new WeakMap<WorkspaceRequestPrincipal, RequestCapture>();
const phases = new WeakMap<SqlConnection, Phase>();
const MAX_ORGANIZATIONS = 16, MAX_ROWS = 1024, MAX_PHASE_MS = 5000;
const tables = ['canvas_organization_settings', 'team_memberships', 'team_membership_sync_state', 'user', 'session',
  'organization_user_permissions', 'canvas_workspaces', 'canvas_projects', 'canvas_workspace_members', 'canvas_project_members'];
const expectedFks = [
  ['organization_user_permissions','organization_id','canvas_organization_settings','organization_id'],
  ['organization_user_permissions','user_id','user','id'],
  ['team_memberships','organization_id','canvas_organization_settings','organization_id'],
  ['team_memberships','user_id','user','id'],
  ['team_membership_sync_state','organization_id','canvas_organization_settings','organization_id'],
  ['canvas_workspaces','organization_id','canvas_organization_settings','organization_id'],
  ['canvas_workspace_members','organization_id','canvas_organization_settings','organization_id'],
  ['canvas_workspace_members','workspace_id','canvas_workspaces','id'],
  ['canvas_workspace_members','user_id','user','id'],
  ['canvas_project_members','organization_id','canvas_organization_settings','organization_id'],
  ['canvas_project_members','project_id','canvas_projects','id'],
  ['canvas_project_members','user_id','user','id'],
  ['session','user_id','user','id'],
] as const;
const quote = (s: string) => `"${s.replaceAll('"','""')}"`;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const id = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 256
  && s === s.trim() && !/[\u0000-\u001f\u007f]/u.test(s);
const number = (v: unknown, minimum = 0) => (typeof v === 'number' || typeof v === 'string' && /^(0|[1-9][0-9]*)$/u.test(v))
  && Number.isSafeInteger(Number(v)) && Number(v) >= minimum;
const flag = (v: unknown) => v === null || [false,true,0,1,'0','1'].includes(v as never);
export class WorkspaceRequestPrincipalError extends Error {
  constructor(readonly code: 'PRINCIPAL_REQUIRED' | 'PRINCIPAL_INVALID' | 'PRINCIPAL_BUSY' | 'PRINCIPAL_SCOPE_CHANGED'
    | 'PRINCIPAL_AUTH_REVOKED' | 'PRINCIPAL_ACCESS_DENIED' | 'PRINCIPAL_WORKSPACE_UNCONFIRMED' | 'PRINCIPAL_TOO_LARGE' | 'PRINCIPAL_DETACHED'
    | 'PRINCIPAL_REENTRANT' | 'PRINCIPAL_SCHEMA_INVALID' | 'PRINCIPAL_EXPIRED') {
    super(code); this.name = 'WorkspaceRequestPrincipalError';
  }
}
function fail(code: WorkspaceRequestPrincipalError['code']): never { throw new WorkspaceRequestPrincipalError(code); }
function reason(error: unknown): unknown { return error ?? new WorkspaceRequestPrincipalError('PRINCIPAL_INVALID'); }
function poison(request: RequestCapture, error: unknown): never { request.failure ??= reason(error); throw request.failure; }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
function scope(a: WorkspaceContext, b: WorkspaceContext): boolean {
  return ['workspaceId','workspaceType','organizationId','projectId','ownerUserId','rootPath','legacy']
    .every(k => (Reflect.get(a,k) ?? null) === (Reflect.get(b,k) ?? null));
}

/** Only this actual Better Auth/Workspace request path can mint the opaque cap.
 * No credentials, license override or preconstructed actor/session are accepted. */
export async function withWorkspaceRequestPrincipal<T>(request: NextRequest,
  options: { permission: 'canRead' | 'canWrite'; workspaceId?: string },
  operation: (principal: WorkspaceRequestPrincipal) => Promise<T>): Promise<T> {
  return withRequestPrincipal(request, options, operation);
}

/** Opted native factory: fixed genuine authentication, primitive-only history,
 * no caller validator, permissions, source snapshot or authority replacement. */
export async function withWorkspaceRequestPrincipalOriginalOrigin<T>(request: NextRequest,
  options: { permission: 'canRead' | 'canWrite'; workspaceId?: string },
  observe: WorkspaceRequestHistoricalOriginObserver,
  operation: (principal: WorkspaceRequestPrincipal) => Promise<T>): Promise<T> {
  if (typeof observe !== 'function') fail('PRINCIPAL_INVALID');
  return withRequestPrincipal(request, options, operation, observe);
}

async function withRequestPrincipal<T>(request: NextRequest,
  options: { permission: 'canRead' | 'canWrite'; workspaceId?: string },
  operation: (principal: WorkspaceRequestPrincipal) => Promise<T>, observe?: WorkspaceRequestHistoricalOriginObserver): Promise<T> {
  if (!(request instanceof NextRequest) || !options || !['canRead','canWrite'].includes(options.permission)
    || options.workspaceId !== undefined && !id(options.workspaceId) || typeof operation !== 'function') fail('PRINCIPAL_INVALID');
  const permission = options.permission, workspaceId = options.workspaceId;
  // The request's actual headers/selectors are copied before the first await.
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const authenticated = await requireRequestWorkspace(original, { workspaceId, permissions: permission });
  if (authenticated.response) {
    // A failed current resolver proves no permission result. Keep this native
    // factory closed without turning its server error into an access denial.
    if (authenticated.response.status === 500) fail('PRINCIPAL_WORKSPACE_UNCONFIRMED');
    fail(authenticated.response.status === 401 ? 'PRINCIPAL_AUTH_REVOKED' : 'PRINCIPAL_ACCESS_DENIED');
  }
  const session = structuredClone(authenticated.session), workspace = structuredClone(authenticated.workspace);
  if (!id(session.user.id) || !id(session.session.id) || session.session.userId !== session.user.id
    || typeof session.session.token !== 'string' || session.session.token.length < 1 || session.session.token.length > 4096
    || workspace.legacy || workspace.status !== 'active' || !workspace.permissions.canRead
    || workspace.actor?.userId !== session.user.id || typeof workspace.rootRelativePath !== 'string'
    || workspace.rootRelativePath.length > 4096) fail('PRINCIPAL_INVALID');
  const license = freeze(structuredClone(await getLicenseStatus()));
  const pool = getPostgresRuntimeQueryable();
  if (!pool) fail('PRINCIPAL_REQUIRED');
  const source = (await pool.query(observe
    ? `SELECT current_schema() AS schema,(SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database,
      to_regnamespace(current_schema())::oid::bigint AS schema_oid,current_setting('search_path') AS search_path`
    : `SELECT current_schema() AS schema,(SELECT oid::bigint FROM pg_database
    WHERE datname=current_database()) AS database`)).rows[0];
  if (!source || typeof source.schema !== 'string' || !source.schema || !number(source.database,1)) fail('PRINCIPAL_SCOPE_CHANGED');
  if (observe && (!number(source.schema_oid, 1) || typeof source.search_path !== 'string'
    || !source.search_path || source.search_path.length > 4096)) fail('PRINCIPAL_SCOPE_CHANGED');
  const captured: RequestCapture = { active: true, accepting: true, pending: new Set(), userId: session.user.id,
    sessionId: session.session.id, tokenHash: hash(session.session.token), impersonatedBy: Reflect.get(session.session,'impersonatedBy') ?? null,
    workspace: freeze(workspace), permission, license, database: Number(source.database), schema: source.schema,
    enterBefore: performance.now()+MAX_PHASE_MS,
    ...(observe ? { originalOrigin: { observe, realm: Object.freeze({ schemaOid: Number(source.schema_oid), searchPath: String(source.search_path) }) } } : {}) };
  const principal = Object.freeze({}) as WorkspaceRequestPrincipal; requests.set(principal,captured);
  try {
    let result: T | undefined;
    try { result = await operation(principal); } catch (error) { captured.failure ??= reason(error); }
    captured.accepting = false;
    if (captured.pending.size) {
      captured.failure ??= new WorkspaceRequestPrincipalError('PRINCIPAL_DETACHED');
      await Promise.allSettled([...captured.pending]);
    }
    if (captured.failure !== undefined) throw captured.failure;
    return result as T;
  } finally { captured.active = false; captured.accepting = false; requests.delete(principal); }
}

function active(phase: Phase): void {
  const held = phases.get(phase.database);
  if (!phase.active || held !== phase || !phase.request.active) {
    const error = new WorkspaceRequestPrincipalError('PRINCIPAL_REQUIRED');
    if (held && held !== phase) { held.failure ??= error; held.request.failure ??= error; }
    throw error;
  }
  if (phase.failure !== undefined) throw phase.failure;
  if (phase.request.failure !== undefined) throw phase.request.failure;
  if (performance.now() > phase.deadline) fail('PRINCIPAL_EXPIRED');
  const license = phase.request.license;
  if (license.licensed && ['active','grace'].includes(license.licenseState)) {
    const expires = Date.parse(license.licenseState === 'grace' ? license.graceExpiresAt ?? '' : license.expiresAt ?? '');
    if (!Number.isFinite(expires) || expires <= Date.now()) fail('PRINCIPAL_EXPIRED');
  }
}
async function identity(phase: Phase): Promise<Identity> {
  active(phase);
  const row = await phase.database.get(`SELECT current_schema() AS schema,current_setting('search_path') AS search_path,
    pg_backend_pid() AS backend,extract(epoch FROM a.backend_start)::text AS start,
    pg_current_xact_id()::text AS transaction,(SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database,
    current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
    current_setting('session_replication_role') AS replication FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`) as Row | undefined;
  active(phase);
  if (!row || row.schema !== phase.request.schema || !number(row.database,1) || Number(row.database) !== phase.request.database
    || typeof row.search_path !== 'string' || !number(row.backend,1) || typeof row.start !== 'string'
    || typeof row.transaction !== 'string' || !/^[0-9]{1,32}$/u.test(row.transaction)
    || row.isolation !== 'read committed' || row.read_only !== 'off' || row.replication !== 'origin') fail('PRINCIPAL_SCOPE_CHANGED');
  return { schema: String(row.schema), searchPath: row.search_path, backend: Number(row.backend), start: row.start,
    transaction: row.transaction, database: Number(row.database) };
}
async function checkIdentity(phase: Phase): Promise<void> {
  const current = await identity(phase), before = phase.identity;
  if (!before || Object.keys(before).some(k => Reflect.get(before,k) !== Reflect.get(current,k))) fail('PRINCIPAL_SCOPE_CHANGED');
  const rows = await phase.database.all(`SELECT name,to_regclass(name)::oid=to_regclass($1||'.'||quote_ident(name))::oid AS same
    FROM unnest($2::text[]) names(name)`, [quote(before.schema),tables]) as Row[];
  active(phase);
  if (rows.length !== tables.length || rows.some(row => row.same !== true)) fail('PRINCIPAL_SCHEMA_INVALID');
}
const table = (phase: Phase, name: string) => `${quote(phase.identity!.schema)}.${quote(name)}`;
async function observeOriginalOrigin(phase: Phase): Promise<void> {
  const request = phase.request, optin = request.originalOrigin;
  if (!optin) return;
  // Capture all private factory primitives before the actual B query await.
  const workspace = request.workspace;
  if (request.impersonatedBy !== null && !id(request.impersonatedBy)) fail('PRINCIPAL_AUTH_REVOKED');
  const expected = Object.freeze({ userId: request.userId, sessionId: request.sessionId,
    impersonatedBy: request.impersonatedBy as string | null, workspaceId: workspace.workspaceId,
    workspaceType: workspace.workspaceType, organizationId: workspace.organizationId ?? null, customerId: workspace.customerId ?? null,
    projectId: workspace.projectId ?? null, ownerUserId: workspace.ownerUserId ?? null,
    rootPath: workspace.rootPath, rootRelativePath: workspace.rootRelativePath, legacy: workspace.legacy, status: workspace.status });
  active(phase);
  const row = await phase.database.get(`SELECT s.user_id,s.id AS session_id,u.banned,s.impersonated_by,
    encode(sha256(convert_to(s.token,'UTF8')),'hex') AS token_hash,s.expires_at,
    w.id AS workspace_id,w.type AS workspace_type,w.organization_id,w.customer_id,w.project_id,w.owner_user_id,
    w.root_relative_path,w.status,current_schema() AS schema,to_regnamespace(current_schema())::oid::bigint AS schema_oid,
    current_setting('search_path') AS search_path,(SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid
    FROM ${table(phase, 'session')} s JOIN ${table(phase, 'user')} u ON u.id=s.user_id
    CROSS JOIN ${table(phase, 'canvas_workspaces')} w
    WHERE s.id=$1 AND s.user_id=$2 AND w.id=$3 LIMIT 1`, [request.sessionId, request.userId, workspace.workspaceId]) as Row | undefined;
  active(phase);
  // A known invalid authentication must not be classified as lock contention
  // before the ordinary locked current/final checks have a chance to run.
  if (row && (!flag(row.banned) || Number(row.banned) === 1
    || row.impersonated_by !== null && !id(row.impersonated_by) || row.impersonated_by !== request.impersonatedBy)) fail('PRINCIPAL_AUTH_REVOKED');
  if (!row || row.user_id !== expected.userId || row.session_id !== expected.sessionId || row.token_hash !== request.tokenHash
    || !number(row.expires_at) || normalizeDatabaseTimestamp(Number(row.expires_at)) <= Date.now()
    || row.workspace_id !== expected.workspaceId || row.workspace_type !== expected.workspaceType
    || (row.organization_id ?? null) !== expected.organizationId || (row.customer_id ?? null) !== expected.customerId
    || (row.project_id ?? null) !== expected.projectId || (row.owner_user_id ?? null) !== expected.ownerUserId
    || row.root_relative_path !== expected.rootRelativePath || row.status !== 'active' || expected.status !== 'active'
    || expected.legacy !== false || typeof expected.rootPath !== 'string' || !expected.rootPath
    || typeof expected.rootRelativePath !== 'string' || expected.rootRelativePath.length > 4096
    || row.schema !== request.schema || !number(row.schema_oid, 1) || Number(row.schema_oid) !== optin.realm.schemaOid
    || row.search_path !== optin.realm.searchPath || !number(row.database_oid, 1) || Number(row.database_oid) !== request.database) fail('PRINCIPAL_SCOPE_CHANGED');
  const historical: WorkspaceRequestHistoricalOrigin = Object.freeze({ ...expected,
    rootRelativePath: expected.rootRelativePath, legacy: false, status: 'active', schema: request.schema,
    schemaOid: Number(row.schema_oid), searchPath: String(row.search_path), databaseOid: request.database });
  // The owner sink is synchronous and receives no facade/SQL/capability.
  const returned: unknown = optin.observe(historical);
  if (returned !== undefined) {
    // Observe a rejected accidental async sink without granting it any lifetime.
    if (returned instanceof Promise) void returned.catch(() => undefined);
    fail('PRINCIPAL_DETACHED');
  }
  active(phase);
}
async function schema(phase: Phase): Promise<void> {
  // Freeze auth/ACL DML and trigger DDL through caller transaction completion.
  // SHARE is compatible with other principal readers; ROW EXCLUSIVE followed
  // by the organization SHARE lock made those readers exclude each other.
  await phase.database.run(`LOCK TABLE ${tables.map(name => table(phase,name)).join(',')} IN SHARE MODE NOWAIT`);
  await checkIdentity(phase);
  const rows = await phase.database.all(`SELECT child.relname AS child,parent.relname AS parent,ca.attname AS column,
    pa.attname AS parent_column,c.convalidated,c.condeferrable,c.conenforced,
    (SELECT count(*)=2 AND bool_and(t.tgenabled IN('O','A')) FROM pg_trigger t
      WHERE t.tgconstraint=c.oid AND t.tgrelid=c.conrelid) AS enforced_trigger
    FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid
      JOIN pg_attribute ca ON ca.attrelid=c.conrelid AND ca.attnum=c.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid=c.confrelid AND pa.attnum=c.confkey[1]
    WHERE c.contype='f' AND cardinality(c.conkey)=1 AND cardinality(c.confkey)=1
      AND child.relnamespace=$1::regnamespace AND parent.relnamespace=$1::regnamespace`, [phase.identity!.schema]) as Row[];
  active(phase);
  for (const [child,column,parent,parentColumn] of expectedFks) {
    const matched = rows.filter(row => row.child === child && row.column === column && row.parent === parent && row.parent_column === parentColumn);
    if (matched.length !== 1 || matched[0].convalidated !== true || matched[0].condeferrable !== false
      || matched[0].conenforced !== true || matched[0].enforced_trigger !== true) fail('PRINCIPAL_SCHEMA_INVALID');
  }
}
function bounded(rows: Row[], max = MAX_ROWS): Row[] {
  if (rows.length > max) fail('PRINCIPAL_TOO_LARGE'); return rows;
}
function assertWorkspaceRow(phase: Phase, workspace: Row | undefined): void {
  const expected = phase.request.workspace;
  if (!workspace || workspace.id !== expected.workspaceId || workspace.organization_id !== expected.organizationId
    || workspace.type !== expected.workspaceType || workspace.status !== 'active'
    || (workspace.owner_user_id ?? null) !== (expected.ownerUserId ?? null)
    || (workspace.project_id ?? null) !== (expected.projectId ?? null)
    || workspace.root_relative_path !== expected.rootRelativePath) fail('PRINCIPAL_SCOPE_CHANGED');
}
async function locks(phase: Phase): Promise<void> {
  const db = phase.database;
  await db.run(`LOCK TABLE ${table(phase,'canvas_organization_settings')} IN SHARE MODE NOWAIT`);
  const organizations = bounded(await db.all(`SELECT organization_id,owner_user_id,created_at FROM ${table(phase,'canvas_organization_settings')}
    ORDER BY organization_id COLLATE "C" LIMIT 17 FOR SHARE NOWAIT`) as Row[],MAX_ORGANIZATIONS);
  if (!organizations.length || organizations.some(row => !id(row.organization_id) || !id(row.owner_user_id) || !number(row.created_at))) fail('PRINCIPAL_SCOPE_CHANGED');
  const firstTime = Math.min(...organizations.map(row => Number(row.created_at)));
  if (organizations.filter(row => Number(row.created_at) === firstTime).length !== 1) fail('PRINCIPAL_SCOPE_CHANGED');
  const users = new Set<string>([phase.request.userId]);
  for (const org of organizations) {
    users.add(String(org.owner_user_id));
    const members = bounded(await db.all(`SELECT id,user_id FROM ${table(phase,'team_memberships')}
      WHERE organization_id=$1 ORDER BY id COLLATE "C" LIMIT 1025 FOR SHARE NOWAIT`, [org.organization_id]) as Row[]);
    if (members.some(row => !id(row.id))) fail('PRINCIPAL_SCOPE_CHANGED');
    const orgUsers = new Set(members.flatMap(row => row.user_id == null ? [] : [String(row.user_id)]));
    if (orgUsers.size > MAX_ROWS || [...orgUsers].some(value => !id(value))) fail('PRINCIPAL_TOO_LARGE');
    for (const user of orgUsers) users.add(user);
    const permissions = bounded(await db.all(`SELECT user_id FROM ${table(phase,'organization_user_permissions')}
      WHERE organization_id=$1 ORDER BY user_id COLLATE "C" LIMIT 1025 FOR SHARE NOWAIT`, [org.organization_id]) as Row[]);
    for (const permission of permissions) {
      if (!id(permission.user_id)) fail('PRINCIPAL_SCOPE_CHANGED');
      orgUsers.add(permission.user_id); users.add(permission.user_id);
    }
    if (orgUsers.size > MAX_ROWS) fail('PRINCIPAL_TOO_LARGE');
  }
  const sync = await db.all(`SELECT organization_id FROM ${table(phase,'team_membership_sync_state')}
    ORDER BY organization_id COLLATE "C" LIMIT 17 FOR SHARE NOWAIT`) as Row[];
  bounded(sync,MAX_ORGANIZATIONS);
  const syncOrgs = organizations.filter(org => sync.some(row => row.organization_id === org.organization_id));
  if (syncOrgs.length) {
    const earliest = Math.min(...syncOrgs.map(row => Number(row.created_at)));
    if (syncOrgs.filter(row => Number(row.created_at) === earliest).length !== 1) fail('PRINCIPAL_SCOPE_CHANGED');
  }
  // All current members, including ineligible/inactive ones, contribute user
  // rows. The table SHARE locks also freeze new/retargeted predicate rows.
  if (users.size > MAX_ROWS * MAX_ORGANIZATIONS + 1) fail('PRINCIPAL_TOO_LARGE');
  for (const userId of [...users].sort((a,b) => Buffer.compare(Buffer.from(a,'utf8'),Buffer.from(b,'utf8')))) {
    const user = await db.get(`SELECT id,banned FROM ${table(phase,'user')} WHERE id=$1 FOR SHARE NOWAIT`, [userId]) as Row | undefined;
    if (!user || !flag(user.banned)) fail('PRINCIPAL_SCOPE_CHANGED');
  }
  const workspace = await db.get(`SELECT id,organization_id,type,status,owner_user_id,project_id,root_relative_path FROM ${table(phase,'canvas_workspaces')}
    WHERE id=$1 FOR SHARE NOWAIT`, [phase.request.workspace.workspaceId]) as Row | undefined;
  assertWorkspaceRow(phase,workspace);
  if (!workspace) fail('PRINCIPAL_SCOPE_CHANGED');
  if (workspace.project_id != null) {
    const project = await db.get(`SELECT id FROM ${table(phase,'canvas_projects')} WHERE id=$1 FOR SHARE NOWAIT`, [workspace.project_id]);
    if (!project) fail('PRINCIPAL_SCOPE_CHANGED');
    bounded(await db.all(`SELECT user_id FROM ${table(phase,'canvas_project_members')}
      WHERE project_id=$1 ORDER BY user_id COLLATE "C" LIMIT 1025 FOR SHARE NOWAIT`, [workspace.project_id]) as Row[]);
  }
  bounded(await db.all(`SELECT user_id FROM ${table(phase,'canvas_workspace_members')}
    WHERE workspace_id=$1 ORDER BY user_id COLLATE "C" LIMIT 1025 FOR SHARE NOWAIT`, [workspace.id]) as Row[]);
  const session = await db.get(`SELECT id FROM ${table(phase,'session')} WHERE id=$1 FOR SHARE NOWAIT`, [phase.request.sessionId]);
  if (!session) fail('PRINCIPAL_AUTH_REVOKED');
  await checkIdentity(phase);
}
async function current(phase: Phase): Promise<WorkspaceContext> {
  await checkIdentity(phase);
  const request = phase.request;
  const rawWorkspace = await phase.database.get(`SELECT id,organization_id,type,status,owner_user_id,project_id,root_relative_path
    FROM ${table(phase,'canvas_workspaces')} WHERE id=$1`, [request.workspace.workspaceId]) as Row | undefined;
  active(phase); assertWorkspaceRow(phase,rawWorkspace);
  const row = await phase.database.get(`SELECT s.user_id,s.expires_at,s.impersonated_by,
    encode(sha256(convert_to(s.token,'UTF8')),'hex') AS token_hash,u.id,u.email,u.role,u.banned
    FROM ${table(phase,'session')} s JOIN ${table(phase,'user')} u ON u.id=s.user_id WHERE s.id=$1`, [request.sessionId]) as Row | undefined;
  active(phase);
  if (!row || row.user_id !== request.userId || row.id !== request.userId || row.token_hash !== request.tokenHash
    || row.impersonated_by !== request.impersonatedBy || !number(row.expires_at) || !flag(row.banned)
    || normalizeDatabaseTimestamp(Number(row.expires_at)) <= Date.now()) fail('PRINCIPAL_AUTH_REVOKED');
  await assertUserSeatAccess({ userId: request.userId, database: phase.database, licenseStatus: request.license });
  active(phase);
  const actor = resolveWorkspaceActor({ id: request.userId, email: row.email as string | null, role: row.role as string | null });
  const workspace = await readPostgresWorkspaceForActorOnConnection(phase.database,actor,request.workspace.workspaceId);
  active(phase);
  if (!workspace || !scope(workspace,request.workspace) || !workspace.permissions.canRead || !workspace.permissions[request.permission]) fail('PRINCIPAL_ACCESS_DENIED');
  await checkIdentity(phase);
  const expiry = await phase.database.get(`SELECT expires_at FROM ${table(phase,'session')} WHERE id=$1`, [request.sessionId]) as Row | undefined;
  active(phase);
  if (!expiry || !number(expiry.expires_at) || normalizeDatabaseTimestamp(Number(expiry.expires_at)) <= Date.now()) fail('PRINCIPAL_AUTH_REVOKED');
  await checkIdentity(phase);
  return freeze(workspace);
}

/** Caller owns BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE, mandatory ROLLBACK on ANY
 * failure, COMMIT/recovery and all native/file guards. No pooling here. */
export function withWorkspaceRequestPrincipalOnConnection<T>(database: SqlConnection, principal: WorkspaceRequestPrincipal,
  operation: (access: WorkspaceRequestPrincipalAccess) => Promise<T>): Promise<T> {
  const request = requests.get(principal);
  if (!request || !request.active || !request.accepting || request.failure !== undefined) {
    const error = new WorkspaceRequestPrincipalError('PRINCIPAL_REQUIRED'), held = phases.get(database);
    if (held) { held.failure ??= error; held.request.failure ??= error; }
    return Promise.reject(error);
  }
  if (!database || typeof database !== 'object' || !['get','all','run'].every(key => typeof Reflect.get(database,key) === 'function')
    || typeof operation !== 'function') {
    const error = new WorkspaceRequestPrincipalError('PRINCIPAL_INVALID'), held = phases.get(database);
    if (held) { held.failure ??= error; held.request.failure ??= error; }
    return Promise.reject((request.failure ??= error));
  }
  if (performance.now() > request.enterBefore) return Promise.reject((request.failure ??= new WorkspaceRequestPrincipalError('PRINCIPAL_EXPIRED')));
  if (request.pending.size || phases.has(database)) {
    const error = new WorkspaceRequestPrincipalError('PRINCIPAL_REENTRANT'), held = phases.get(database);
    if (held) { held.failure ??= error; held.request.failure ??= error; }
    return Promise.reject((request.failure ??= error));
  }
  const phase: Phase = { active: true, request, database, deadline: performance.now()+MAX_PHASE_MS, checking: false, pending: new Set() };
  phases.set(database,phase);
  const pending = (async () => {
    try {
      phase.identity = await identity(phase); await checkIdentity(phase);
      await database.run("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='50ms'; SET LOCAL transaction_timeout='5s'");
      await observeOriginalOrigin(phase);
      await schema(phase); await locks(phase);
      const workspace = await current(phase);
      const assertCurrent = (): Promise<void> => {
        if (phase.checking) {
          phase.failure ??= new WorkspaceRequestPrincipalError('PRINCIPAL_REENTRANT'); request.failure ??= phase.failure;
          return Promise.reject(phase.failure);
        }
        phase.checking = true;
        const checked = current(phase).then(() => undefined).catch(error => { phase.failure ??= reason(error); request.failure ??= phase.failure; throw phase.failure; })
          .finally(() => { phase.checking = false; });
        phase.pending.add(checked);
        void checked.then(() => phase.pending.delete(checked), () => phase.pending.delete(checked));
        return checked;
      };
      const result = await operation(Object.freeze({ workspace,userId:request.userId,sessionId:request.sessionId,assertCurrent }));
      if (phase.pending.size) {
        phase.failure ??= new WorkspaceRequestPrincipalError('PRINCIPAL_DETACHED');
        await Promise.allSettled([...phase.pending]); throw phase.failure;
      }
      await current(phase); return result;
    } catch (error) {
      if ((error as { code?: string })?.code === '55P03') error = new WorkspaceRequestPrincipalError('PRINCIPAL_BUSY');
      return poison(request,error);
    } finally { phase.active = false; if (phases.get(database) === phase) phases.delete(database); }
  })();
  request.pending.add(pending);
  void pending.then(() => request.pending.delete(pending), () => request.pending.delete(pending));
  return pending;
}
