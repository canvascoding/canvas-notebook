import 'server-only';

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { NextRequest } from 'next/server';
import { measureDocumentPhase } from '../observability/document-operation-metrics';
import { getPostgresRuntimeQueryable, openDb, type SqlConnection } from '../db';
import { normalizeDatabaseTimestamp } from '../db/timestamps';
import { postgresScalarSnapshotSql } from '../db/postgres-scalar-snapshot';
import { getLicenseStatus } from '../license';
import { requireTeamRuntimeLicense } from '../license/entitlements';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { isFileGuestId } from '../file-guests/types';
import { assertUserSeatAccess, assertUserSeatAccessInSingleSnapshotOnConnection, resolveEffectiveSeatPolicy,
  userSeatAccessSnapshotSql, evaluateUserSeatAccessSnapshot, type CurrentSeatSnapshotRow, type EffectiveSeatPolicy } from '../license/seat-limit';
import type { LicenseStatus } from '../license/types';
import { captureCurrentAgentToolInvocation, assertCurrentAgentToolInvocation, withCapturedAgentToolInvocation,
  type AgentToolInvocation, type AgentToolInvocationOrigin } from '../pi/agent-tool-invocation';
import { readStoredAgentWorkspaceOnConnection } from '../pi/session-workspace-context';
import { normalizeManagedAgentId } from '../agents/registry';
import { getAgentAccessOnConnection } from '../agents/access';
import { resolveVerifiedAgentActorContextOnConnection } from '../agents/actor-context';
import { resolveWorkspaceActor } from './context';
import { assertWorkspacePermission } from './permissions';
import { assertWorkspaceOperationBatchClaimOnConnection, readWorkspaceOperationBatchClaimBinding,
  type WorkspaceOperationBatchClaim, type WorkspaceOperationBatchClaimBinding } from '../files/workspace-operation-batch-store';
import { workspaceOperationJobScopeMatches } from '../files/workspace-operation-job-scope';
import { readPostgresWorkspaceForActorOnConnection, readPostgresWorkspaceForActorInSingleSnapshotOnConnection,
  workspacePermissionSnapshotJsonSql, workspaceContextFromPermissionSnapshot, type WorkspacePermissionSnapshotRow } from './postgres-runtime';
import { requireExistingSelectedRequestWorkspace } from './request';
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
type AuthorizationCapture = {
  active: boolean; accepting: boolean; failure?: unknown; pending: Set<Promise<unknown>>;
  userId: string;
  workspace: WorkspaceContext; permission: 'canRead' | 'canWrite'; license: LicenseStatus; database: number; schema: string; enterBefore: number;
};
type RequestCapture = AuthorizationCapture & {
  kind: 'member'; sessionId: string; tokenHash: string; impersonatedBy: unknown;
  originalOrigin?: { observe: WorkspaceRequestHistoricalOriginObserver; realm: Readonly<{ schemaOid: number; searchPath: string }> };
};
declare const agentToolPrincipalBrand: unique symbol;
export type WorkspaceAgentToolPrincipal = Readonly<{ [agentToolPrincipalBrand]: never }>;
export type WorkspaceAgentToolPrincipalAccess = Readonly<{
  workspace: WorkspaceContext; userId: string; agentId: string; piSessionId: string;
  toolName: string; toolCallId: string; assertCurrent: () => Promise<void>;
}>;
type AgentProfilePin = Readonly<{
  id: number; revision: number; enabledToolsJson: string | null;
  workflowVersion: number | null; workflowRevision: number;
}>;
type AgentCapture = AuthorizationCapture & {
  kind: 'agent_tool'; invocation: AgentToolInvocation; origin: AgentToolInvocationOrigin;
  agentId: string; piSessionDbId: number; profile: AgentProfilePin;
  originalOrigin?: { observe: WorkspaceAgentToolHistoricalOriginObserver; realm: Readonly<{ schemaOid: number; searchPath: string }> };
};
type AgentWorkspaceOrigin = Pick<AgentToolInvocationOrigin, 'userId' | 'sessionId' | 'workspaceId' | 'workspaceType'
  | 'organizationId' | 'customerId' | 'projectId' | 'workspaceRoot' | 'workspaceRootRelativePath' | 'legacy'>;
declare const jobPolicyBrand: unique symbol;
/** One fresh policy capture, never a member session, actor grant or SQL owner. */
export type WorkspaceOperationJobPolicy = Readonly<{ [jobPolicyBrand]: never }>;
export type WorkspaceOperationJobPolicyAccess = Readonly<{
  workspace: WorkspaceContext; userId: string; actorType: 'user' | 'agent'; actorId: string;
  piSessionId?: string; batchId: string; planId: string; assertCurrent: () => Promise<void>;
}>;
type JobPolicyCapture = Readonly<{
  license: LicenseStatus; database: number; schema: string; schemaOid: number; searchPath: string; enterBefore: number;
}> & { used: boolean; failure?: unknown };
type JobCaptureBase = AuthorizationCapture & {
  claim: WorkspaceOperationBatchClaim; binding: WorkspaceOperationBatchClaimBinding; policy: JobPolicyCapture;
  initializeWorkspace: (workspace: WorkspaceContext) => void;
};
type JobUserCapture = JobCaptureBase & { kind: 'job_user' };
type JobAgentCapture = JobCaptureBase & {
  kind: 'job_agent'; agentId: string; origin: AgentWorkspaceOrigin; piSessionDbId: number; profile: AgentProfilePin;
  initializeAgent: (sessionId: number, profile: AgentProfilePin) => void;
};
declare const guestInvitationAuthorityBrand: unique symbol;
export type FileGuestInvitationAuthority = Readonly<{ [guestInvitationAuthorityBrand]: never }>;
export type FileGuestInvitationAuthorityPurpose = 'challenge' | 'redeem' | 'failed_challenge_cleanup' | 'access';
export type FileGuestInvitationAuthorityTarget = Readonly<{
  id: string; workspaceId: string; path: string; documentId: string; lineageId: string; lifecycleGeneration: number;
  policyRevision: number; permission: 'read' | 'write'; createdByUserId: string;
}>;
export type FileGuestInvitationAuthorityAccess = Readonly<{
  workspace: WorkspaceContext; invitation: FileGuestInvitationAuthorityTarget; userId: string; assertCurrent: () => Promise<void>;
}>;
type InvitationCapture = AuthorizationCapture & {
  kind: 'file_guest'; invitation: FileGuestInvitationAuthorityTarget; purpose: FileGuestInvitationAuthorityPurpose; expiresAt: number | null;
};
/** Historical identity only. It conveys neither permissions nor a live principal. */
export type WorkspaceRequestHistoricalOrigin = Readonly<{
  userId: string; sessionId: string; impersonatedBy: string | null; workspaceId: string; workspaceType: string;
  organizationId: string | null; customerId: string | null; projectId: string | null; ownerUserId: string | null;
  rootPath: string; rootRelativePath: string; legacy: false; status: 'active';
  schema: string; schemaOid: number; searchPath: string; databaseOid: number;
}>;
export type WorkspaceRequestHistoricalOriginObserver = (origin: WorkspaceRequestHistoricalOrigin) => void;
/** Historical PI invocation scalars only; this is neither a Web session nor
 * a permission, SQL connection, document admission or reusable principal. */
export type WorkspaceAgentToolHistoricalOrigin = Readonly<{
  userId: string; agentId: string; piSessionId: string; toolName: string; toolCallId: string; agentTurnId: string | null;
  piSessionDbId: number; agentProfileId: number; agentProfileRevision: number;
  workflowVersion: number | null; workflowRevision: number;
  workspaceId: string; workspaceType: string; organizationId: string | null; customerId: string | null;
  projectId: string | null; ownerUserId: string | null; rootPath: string; rootRelativePath: string; legacy: false; status: 'active';
  schema: string; schemaOid: number; searchPath: string; databaseOid: number;
}>;
/** Idempotent synchronous sink: initial, final and explicit current checks can
 * observe the same original scalars repeatedly within the genuine phase. */
export type WorkspaceAgentToolHistoricalOriginObserver = (origin: WorkspaceAgentToolHistoricalOrigin) => void;
type Phase = { active: boolean; failure?: unknown; request: RequestCapture | InvitationCapture | AgentCapture | JobUserCapture | JobAgentCapture; database: SqlConnection;
  identity?: Identity; deadline: number; checking: boolean; pending: Set<Promise<unknown>>;
  accepting: boolean; nativeEditSessionExpiresAt?: number; agentCreateRealm?: string };
const requests = new WeakMap<WorkspaceRequestPrincipal, RequestCapture>();
const invitationAuthorities = new WeakMap<FileGuestInvitationAuthority, InvitationCapture>();
const agentToolPrincipals = new WeakMap<WorkspaceAgentToolPrincipal, AgentCapture>();
declare const agentMarkdownCreateBrand: unique symbol;
export type WorkspaceAgentMarkdownCreatePrincipal = WorkspaceAgentToolPrincipal & Readonly<{ [agentMarkdownCreateBrand]: never }>;
const agentMarkdownCreatePrincipals = new WeakMap<WorkspaceAgentMarkdownCreatePrincipal, AgentCapture>();
const agentMarkdownCreateCaptures = new WeakSet<AgentCapture>();
const jobPolicies = new WeakMap<WorkspaceOperationJobPolicy, JobPolicyCapture>();
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
const agentTables = ['pi_sessions', 'agents', 'agent_members', 'agent_grants'];
const agentFks = [
  ['pi_sessions','user_id','user','id'],
  ['agents','organization_id','canvas_organization_settings','organization_id'],
  ['agents','owner_user_id','user','id'],
  ['agents','created_by_user_id','user','id'],
  ['agent_members','agent_id','agents','agent_id'],
  ['agent_members','organization_id','canvas_organization_settings','organization_id'],
  ['agent_members','user_id','user','id'],
  ['agent_members','invited_by_user_id','user','id'],
  ['agent_grants','agent_id','agents','agent_id'],
  ['agent_grants','organization_id','canvas_organization_settings','organization_id'],
  ['agent_grants','created_by_user_id','user','id'],
  ['agent_grants','updated_by_user_id','user','id'],
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
function poison(request: AuthorizationCapture, error: unknown): never { request.failure ??= reason(error); throw request.failure; }
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
  const authenticated = await requireExistingSelectedRequestWorkspace(original, { workspaceId, permissions: permission });
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
  const captured: RequestCapture = { kind: 'member', active: true, accepting: true, pending: new Set(), userId: session.user.id,
    sessionId: session.session.id, tokenHash: hash(session.session.token), impersonatedBy: Reflect.get(session.session,'impersonatedBy') ?? null,
    workspace: freeze(workspace), permission, license, database: Number(source.database), schema: source.schema,
    enterBefore: performance.now()+MAX_PHASE_MS,
    ...(observe ? { originalOrigin: { observe, realm: Object.freeze({ schemaOid: Number(source.schema_oid), searchPath: String(source.search_path) }) } } : {}) };
  const principal = Object.freeze({}) as WorkspaceRequestPrincipal; requests.set(principal,captured);
  try {
    let result: T | undefined, operationFailure: unknown;
    try { result = await operation(principal); }
    catch (error) { operationFailure = reason(error); captured.failure ??= operationFailure; }
    captured.accepting = false;
    if (captured.pending.size) {
      captured.failure ??= new WorkspaceRequestPrincipalError('PRINCIPAL_DETACHED');
      await Promise.allSettled([...captured.pending]);
    }
    // Preserve later transaction cleanup failures after draining held work.
    if (operationFailure !== undefined) throw operationFailure;
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
  if (phase.request.kind === 'agent_tool') assertCurrentAgentToolInvocation(phase.request.invocation);
  if (performance.now() > phase.deadline) fail('PRINCIPAL_EXPIRED');
  if (phase.request.kind === 'file_guest' && phase.request.expiresAt !== null
    && phase.request.expiresAt <= Date.now()) guestFail('FILE_GUEST_INVITATION_UNAVAILABLE');
  const license = phase.request.license;
  if (license.licensed && ['active','grace'].includes(license.licenseState)) {
    const expires = Date.parse(license.licenseState === 'grace' ? license.graceExpiresAt ?? '' : license.expiresAt ?? '');
    if (!Number.isFinite(expires) || expires <= Date.now()) fail('PRINCIPAL_EXPIRED');
  }
}
const principalIdentitySql = `SELECT current_schema() AS schema,current_setting('search_path') AS search_path,
    pg_backend_pid() AS backend,extract(epoch FROM a.backend_start)::text AS start,
    pg_current_xact_id()::text AS transaction,(SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database,
    current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
    current_setting('session_replication_role') AS replication FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`;
function principalIdentitySnapshotQuery(schemaParameter: number, relationsParameter: number): string {
  if (![schemaParameter, relationsParameter].every(value => Number.isInteger(value) && value >= 1 && value <= 32)) {
    throw new RangeError('Invalid Principal snapshot parameter ordinal.');
  }
  return `SELECT header.*,to_regnamespace(current_schema())::oid::bigint AS schema_oid,
    (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.name COLLATE "C"),'[]'::jsonb) FROM (
      SELECT name,to_regclass(name)::oid=to_regclass($${schemaParameter}||'.'||quote_ident(name))::oid AS same
      FROM unnest($${relationsParameter}::text[]) names(name)) r) AS relations
    FROM (${principalIdentitySql}) header`;
}
const principalIdentitySnapshotSql = principalIdentitySnapshotQuery(1, 2);
function parseIdentity(phase: Phase, row: Row | undefined): Identity {
  if (!row || row.schema !== phase.request.schema || !number(row.database,1) || Number(row.database) !== phase.request.database
    || typeof row.search_path !== 'string' || !number(row.backend,1) || typeof row.start !== 'string'
    || typeof row.transaction !== 'string' || !/^[0-9]{1,32}$/u.test(row.transaction)
    || row.isolation !== 'read committed' || row.read_only !== 'off' || row.replication !== 'origin') fail('PRINCIPAL_SCOPE_CHANGED');
  return { schema: String(row.schema), searchPath: row.search_path, backend: Number(row.backend), start: row.start,
    transaction: row.transaction, database: Number(row.database) };
}
async function identity(phase: Phase): Promise<Identity> {
  active(phase);
  const row = await phase.database.get(principalIdentitySql) as Row | undefined;
  active(phase);
  return parseIdentity(phase,row);
}
async function checkIdentity(phase: Phase): Promise<Row> {
  active(phase);
  const requiredTables = principalRelations(phase);
  // One fresh context snapshot, including every required relation. The extra
  // realm field is consumed only by the private durable-job check below.
  const row = await phase.database.get(principalIdentitySnapshotSql, [quote(phase.request.schema),requiredTables]) as Row | undefined;
  return validatePrincipalIdentitySnapshot(phase, row, requiredTables);
}
/** Same context/relations decision for standalone and joint actual snapshots. */
function validatePrincipalIdentitySnapshot(phase: Phase, row: Row | undefined, requiredTables: readonly string[]): Row {
  active(phase);
  const current = parseIdentity(phase,row), before = phase.identity;
  if (!before || Object.keys(before).some(k => Reflect.get(before,k) !== Reflect.get(current,k))) fail('PRINCIPAL_SCOPE_CHANGED');
  const rows = row!.relations as Row[];
  if (!Array.isArray(rows) || rows.some(relation => !relation || typeof relation !== 'object')) fail('PRINCIPAL_SCHEMA_INVALID');
  if (rows.length !== requiredTables.length || rows.some(row => row.same !== true)) fail('PRINCIPAL_SCHEMA_INVALID');
  return row!;
}
function principalRelations(phase: Phase): readonly string[] {
  if (phase.request.kind === 'agent_tool' || phase.request.kind === 'job_agent') return [...tables.filter(name => name !== 'session'), ...agentTables];
  if (phase.request.kind === 'job_user') return tables.filter(name => name !== 'session');
  return phase.request.kind === 'file_guest' ? [...tables, 'file_guest_invitations'] : tables;
}
const table = (phase: Phase, name: string) => `${quote(phase.identity!.schema)}.${quote(name)}`;
async function observeOriginalOrigin(phase: Phase): Promise<void> {
  const request = phase.request;
  if (request.kind !== 'member') fail('PRINCIPAL_REQUIRED');
  const optin = request.originalOrigin;
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
  const sharedTables = phase.request.kind === 'agent_tool' || phase.request.kind === 'job_agent'
    ? principalRelations(phase).filter(name => name !== 'pi_sessions') : tables;
  const policyTables = phase.request.kind === 'job_user' ? principalRelations(phase) : sharedTables;
  // Brief ANALYZE/VACUUM conflicts use the phase's existing 50ms lock budget.
  // Keep the same SHARE fence; longer contention still fails the transaction.
  await phase.database.run(`LOCK TABLE ${policyTables.map(name => table(phase,name)).join(',')} IN SHARE MODE`);
  // Keep the invitation relation/FK stable while permitting cooperating Guest
  // DML on other rows. Its actual row lock belongs after the Shared fence.
  if (phase.request.kind === 'file_guest') await phase.database.run(`LOCK TABLE ${table(phase,'file_guest_invitations')} IN ROW SHARE MODE NOWAIT`);
  // A genuine PI row is locked below. Other chats may continue to save; the
  // unrelated Better Auth session relation is not an Agent authority source.
  if (phase.request.kind === 'agent_tool' || phase.request.kind === 'job_agent') await phase.database.run(`LOCK TABLE ${table(phase,'pi_sessions')} IN ROW EXCLUSIVE MODE NOWAIT`);
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
  const requiredFks = phase.request.kind === 'file_guest'
    ? [...expectedFks, ['file_guest_invitations','created_by_user_id','user','id'] as const]
    : phase.request.kind === 'agent_tool' || phase.request.kind === 'job_agent'
      ? [...expectedFks.filter(([child]) => child !== 'session'), ...agentFks]
      : phase.request.kind === 'job_user' ? expectedFks.filter(([child]) => child !== 'session') : expectedFks;
  for (const [child,column,parent,parentColumn] of requiredFks) {
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
  if (phase.request.kind === 'member') await lockMemberSession(phase, phase.request);
  if (phase.request.kind === 'agent_tool' || phase.request.kind === 'job_agent') await lockAgentOrigin(phase, phase.request);
  await checkIdentity(phase);
}
async function lockMemberSession(phase: Phase, request: RequestCapture): Promise<void> {
  const session = await phase.database.get(`SELECT id FROM ${table(phase,'session')} WHERE id=$1 FOR SHARE NOWAIT`, [request.sessionId]);
  if (!session) fail('PRINCIPAL_AUTH_REVOKED');
}
/** Private reuse only: this reads actual account/seat/workspace policy and does
 * not mint a Principal, a member session, admission or a general actor grant. */
async function currentUserWorkspace(phase: Phase, row: Row): Promise<WorkspaceContext> {
  const request = phase.request;
  const singleSnapshot = request.kind === 'member'
    || request.kind === 'job_user' && request.binding.actionMode === 'apply'
      && (request.binding.plan.version === 3 || request.binding.plan.version === 6);
  if (singleSnapshot) {
    // This actual B already holds the seat tables in SHARE. Reuse the same
    // decision bodies with one fresh snapshot at every retained Current fence.
    // Ordinary native Move/Rename jobs use the same direct-user capture as
    // Delete. No decision survives this check or is reused by another phase.
    await assertUserSeatAccessInSingleSnapshotOnConnection(phase.database, request.userId, request.license);
  } else await assertUserSeatAccess({ userId: request.userId, database: phase.database, licenseStatus: request.license });
  active(phase);
  const actor = resolveWorkspaceActor({ id: request.userId, email: row.email as string | null, role: row.role as string | null });
  const workspace = singleSnapshot
    ? await readPostgresWorkspaceForActorInSingleSnapshotOnConnection(phase.database,actor,request.workspace.workspaceId)
    : await readPostgresWorkspaceForActorOnConnection(phase.database,actor,request.workspace.workspaceId);
  active(phase);
  if (!workspace || !scope(workspace,request.workspace) || !workspace.permissions.canRead || !workspace.permissions[request.permission]) fail('PRINCIPAL_ACCESS_DENIED');
  await checkIdentity(phase);
  return workspace;
}
type MemberScopeSnapshot = {
  row: Row & { workspace: WorkspacePermissionSnapshotRow | null; seat: CurrentSeatSnapshotRow | null };
  seatPolicy: EffectiveSeatPolicy;
};
/** Fresh facts on the actual held Member connection, never a cached grant.
 * Pin data relations while observing the real search path independently. */
async function readMemberScopeSnapshot(phase: Phase): Promise<MemberScopeSnapshot> {
  active(phase);
  const request = phase.request;
  if (request.kind !== 'member') fail('PRINCIPAL_REQUIRED');
  const seatPolicy = resolveEffectiveSeatPolicy(request.license), requiredTables = principalRelations(phase);
  // Fixed, inlined aliases let the existing policy SQL read the pinned schema
  // even when the actual path has drifted. The header must still reject drift.
  const relations = tables.map(name => `${quote(name)} AS NOT MATERIALIZED (SELECT * FROM ${table(phase,name)})`).join(',');
  let row: MemberScopeSnapshot['row'] | undefined;
  try {
    row = await phase.database.get(`WITH ${relations}
      SELECT header.*,account.*,
        (SELECT w.facts FROM (${workspacePermissionSnapshotJsonSql}) w) AS workspace,
        (SELECT seat.facts FROM (${postgresScalarSnapshotSql(userSeatAccessSnapshotSql(2,4),
          ['account_banned', 'reconciliation_seat_limit'])}) seat) AS seat
      FROM (${principalIdentitySnapshotQuery(5,6)}) header
      LEFT JOIN LATERAL (
        SELECT s.user_id,s.expires_at,s.impersonated_by,
          encode(sha256(convert_to(s.token,'UTF8')),'hex') AS token_hash,u.id,u.email,u.role,u.banned
        FROM ${table(phase,'session')} s JOIN ${table(phase,'user')} u ON u.id=s.user_id WHERE s.id=$3
      ) account ON true`, [request.workspace.workspaceId,request.userId,request.sessionId,seatPolicy.mode,
      quote(request.schema),requiredTables]) as typeof row;
  } catch (error) {
    const code = error && typeof error === 'object' ? Reflect.get(error,'code') : undefined;
    if (code === '42P01' || code === '42703') fail('PRINCIPAL_SCHEMA_INVALID');
    if (code === '3F000') fail('PRINCIPAL_SCOPE_CHANGED');
    throw error;
  }
  validatePrincipalIdentitySnapshot(phase,row,requiredTables);
  if ([row!.workspace, row!.seat].some(value => value && Reflect.get(value, 'scalar_types_supported') !== true)) {
    fail('PRINCIPAL_SCHEMA_INVALID');
  }
  return { row: row!, seatPolicy };
}
/** Reuse the ordinary seat/workspace decisions for each actual fresh reply. */
function memberSnapshotWorkspace(phase: Phase, { row, seatPolicy }: MemberScopeSnapshot): WorkspaceContext {
  active(phase);
  const request = phase.request;
  if (request.kind !== 'member') fail('PRINCIPAL_REQUIRED');
  assertWorkspaceRow(phase,row.workspace ?? undefined);
  active(phase);
  if (row.user_id !== request.userId || row.id !== request.userId || row.token_hash !== request.tokenHash
    || row.impersonated_by !== request.impersonatedBy || !number(row.expires_at) || !flag(row.banned)
    || normalizeDatabaseTimestamp(Number(row.expires_at)) <= Date.now()) fail('PRINCIPAL_AUTH_REVOKED');
  evaluateUserSeatAccessSnapshot(request.userId,seatPolicy,row.seat ?? undefined);
  const actor = resolveWorkspaceActor({ id: request.userId, email: row.email as string | null, role: row.role as string | null });
  const workspace = workspaceContextFromPermissionSnapshot(row.workspace ?? undefined,actor);
  active(phase);
  if (!workspace || !scope(workspace,request.workspace) || !workspace.permissions.canRead || !workspace.permissions[request.permission]) fail('PRINCIPAL_ACCESS_DENIED');
  return workspace;
}
async function current(phase: Phase): Promise<WorkspaceContext> {
  memberSnapshotWorkspace(phase,await readMemberScopeSnapshot(phase));
  // Retain a fresh final fence. Session/account/seat/workspace and context are
  // all observed again, including changes after the first real query reply.
  const final = await readMemberScopeSnapshot(phase);
  const workspace = memberSnapshotWorkspace(phase,final);
  // Private evidence for the fixed native edit fence, never a caller expiry.
  phase.nativeEditSessionExpiresAt = normalizeDatabaseTimestamp(Number(final.row.expires_at));
  return freeze(workspace);
}

/** Caller owns BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE, mandatory ROLLBACK on ANY
 * failure, COMMIT/recovery and all native/file guards. No pooling here. */
export function withWorkspaceRequestPrincipalOnConnection<T>(database: SqlConnection, principal: WorkspaceRequestPrincipal,
  operation: (access: WorkspaceRequestPrincipalAccess) => Promise<T>): Promise<T> {
  const request = requests.get(principal);
  return withCapturedPrincipalOnConnection(database, request, new WorkspaceRequestPrincipalError('PRINCIPAL_REQUIRED'), current,
    (workspace, assertCurrent) => Object.freeze({ workspace, userId: request!.userId, sessionId: request!.sessionId, assertCurrent }), operation);
}

/** Synchronous native WRITE fence inside the exact genuine member B phase. */
export function assertWorkspaceNativeEditRequestPrincipalActiveOnConnection(database: SqlConnection,
  principal: WorkspaceRequestPrincipal): void {
  assertNativeEditPhaseActive(database, requests.get(principal));
}

/** PI remains its real active invocation; it never becomes a member session. */
export function assertWorkspaceNativeEditAgentPrincipalActiveOnConnection(database: SqlConnection,
  principal: WorkspaceAgentToolPrincipal): void {
  assertNativeEditPhaseActive(database, agentToolPrincipals.get(principal));
}

function assertNativeEditPhaseActive(database: SqlConnection, captured: RequestCapture | AgentCapture | undefined): void {
  const phase = phases.get(database);
  try {
    if (!captured || !phase || phase.request !== captured || !captured.accepting || !phase.accepting) fail('PRINCIPAL_REQUIRED');
    active(phase);
    if (captured.permission !== 'canWrite') fail('PRINCIPAL_ACCESS_DENIED');
    if (phase.checking || phase.pending.size) fail('PRINCIPAL_REENTRANT');
    if (captured.kind === 'member' && (!Number.isSafeInteger(phase.nativeEditSessionExpiresAt)
      || phase.nativeEditSessionExpiresAt! <= Date.now())) fail('PRINCIPAL_AUTH_REVOKED');
  } catch (error) {
    const failure = reason(error);
    if (phase) { phase.failure ??= failure; phase.request.failure ??= failure; }
    if (captured) return poison(captured, failure);
    throw failure;
  }
}

/** Shared phase mechanics only. Each private adapter supplies its actual
 * captured origin and fixed authorization reader; callers never supply either. */
function withCapturedPrincipalOnConnection<T, Access>(database: SqlConnection, request: Phase['request'] | undefined,
  unavailable: Error, readCurrent: (phase: Phase) => Promise<WorkspaceContext>,
  makeAccess: (workspace: WorkspaceContext, assertCurrent: () => Promise<void>) => Access,
  operation: (access: Access) => Promise<T>): Promise<T> {
  if (!request || !request.active || !request.accepting || request.failure !== undefined) {
    const error = unavailable, held = phases.get(database);
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
  const phase: Phase = { active: true, accepting: true, request, database, deadline: performance.now()+MAX_PHASE_MS, checking: false, pending: new Set() };
  phases.set(database,phase);
  const pending = (async () => {
    try {
      phase.identity = await identity(phase); await checkIdentity(phase);
      await database.run("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='50ms'; SET LOCAL transaction_timeout='5s'");
      if (request.kind === 'job_user' || request.kind === 'job_agent') await initializeJobCapture(phase);
      if (request.kind === 'member') await observeOriginalOrigin(phase);
      await schema(phase); await locks(phase);
      if (request.kind === 'agent_tool' && agentMarkdownCreateCaptures.has(request)) await pinAgentCreateReceiptRealm(phase);
      const workspace = await measureDocumentPhase('authorization', () => readCurrent(phase));
      const assertCurrent = (): Promise<void> => {
        if (phase.checking) {
          phase.failure ??= new WorkspaceRequestPrincipalError('PRINCIPAL_REENTRANT'); request.failure ??= phase.failure;
          return Promise.reject(phase.failure);
        }
        phase.checking = true;
        const checked = measureDocumentPhase('authorization', () => readCurrent(phase)).then(() => undefined).catch(error => { phase.failure ??= reason(error); request.failure ??= phase.failure; throw phase.failure; })
          .finally(() => { phase.checking = false; });
        phase.pending.add(checked);
        void checked.then(() => phase.pending.delete(checked), () => phase.pending.delete(checked));
        return checked;
      };
      const result = await operation(makeAccess(workspace, assertCurrent));
      phase.accepting = false;
      if (phase.pending.size) {
        phase.failure ??= new WorkspaceRequestPrincipalError('PRINCIPAL_DETACHED');
        await Promise.allSettled([...phase.pending]); throw phase.failure;
      }
      await measureDocumentPhase('authorization', () => readCurrent(phase)); return result;
    } catch (error) {
      if ((error as { code?: string })?.code === '55P03') error = new WorkspaceRequestPrincipalError('PRINCIPAL_BUSY');
      return poison(request,error);
    } finally { phase.active = false; phase.accepting = false; if (phases.get(database) === phase) phases.delete(database); }
  })();
  request.pending.add(pending);
  void pending.then(() => request.pending.delete(pending), () => request.pending.delete(pending));
  return pending;
}

/** One fixed initial transition, after authenticating the original realm and
 * relation identities. Never repairs drift after the consumer has started. */
async function pinAgentCreateReceiptRealm(phase: Phase): Promise<void> {
  const request = phase.request, before = phase.identity;
  if (request.kind !== 'agent_tool' || !agentMarkdownCreateCaptures.has(request) || !before || phase.agentCreateRealm
    || !request.originalOrigin || before.searchPath !== request.originalOrigin.realm.searchPath) fail('PRINCIPAL_SCOPE_CHANGED');
  await checkIdentity(phase); await schema(phase);
  const row = await phase.database.get("SELECT quote_ident($1)||', pg_catalog, pg_temp' AS canonical", [request.schema]) as Row | undefined;
  if (!row || typeof row.canonical !== 'string') fail('PRINCIPAL_SCOPE_CHANGED');
  await phase.database.run("SELECT set_config('search_path',$1,true)", [row.canonical]);
  const after = await identity(phase);
  if (after.searchPath !== row.canonical || Object.keys(before).some(key => key !== 'searchPath'
    && Reflect.get(before,key) !== Reflect.get(after,key))) fail('PRINCIPAL_SCOPE_CHANGED');
  phase.agentCreateRealm = row.canonical; phase.identity = after;
  await checkIdentity(phase); await schema(phase);
}

export class FileGuestInvitationAuthorityError extends Error {
  constructor(readonly code: 'FILE_GUEST_INVITATION_INVALID' | 'FILE_GUEST_INVITATION_UNAVAILABLE'
    | 'FILE_GUEST_INVITATION_SCOPE_CHANGED' | 'FILE_GUEST_INVITATION_AUTHORITY_REQUIRED') {
    super(code === 'FILE_GUEST_INVITATION_INVALID' ? 'Eine gültige Einladung ist erforderlich.'
      : code === 'FILE_GUEST_INVITATION_UNAVAILABLE' ? 'Diese Einladung ist abgelaufen oder wurde widerrufen.'
        : code === 'FILE_GUEST_INVITATION_SCOPE_CHANGED' ? 'Die ursprüngliche Dokumentbindung wurde geändert. Eine neue Einladung ist nötig.'
          : 'Die Gastaktion ist nicht autorisiert.');
    this.name = 'FileGuestInvitationAuthorityError';
  }
  get status(): number {
    return this.code === 'FILE_GUEST_INVITATION_INVALID' ? 400 : this.code === 'FILE_GUEST_INVITATION_UNAVAILABLE' ? 410
      : this.code === 'FILE_GUEST_INVITATION_SCOPE_CHANGED' ? 409 : 403;
  }
}
function guestFail(code: FileGuestInvitationAuthorityError['code']): never { throw new FileGuestInvitationAuthorityError(code); }

function invitationTarget(row: Row | undefined): { invitation: FileGuestInvitationAuthorityTarget; expiresAt: number | null } {
  if (!row || !isFileGuestId(String(row.id)) || !id(row.workspace_id) || !isCanonicalAdmissionPath(row.path)
    || !id(row.document_id) || !id(row.lineage_id) || !number(row.lifecycle_generation,1) || !number(row.policy_revision,1)
    || !id(row.created_by_user_id) || row.permission !== 'read' && row.permission !== 'write'
    || row.expires_at !== null && !number(row.expires_at)) guestFail('FILE_GUEST_INVITATION_SCOPE_CHANGED');
  if (row.status !== 'active' || row.expires_at !== null && Number(row.expires_at) <= Date.now()) guestFail('FILE_GUEST_INVITATION_UNAVAILABLE');
  return { invitation: Object.freeze({ id: String(row.id),workspaceId: row.workspace_id,path: row.path,
    documentId: row.document_id,lineageId: row.lineage_id,lifecycleGeneration: Number(row.lifecycle_generation),
    policyRevision: Number(row.policy_revision),permission: row.permission,createdByUserId: row.created_by_user_id }),
  expiresAt: row.expires_at === null ? null : Number(row.expires_at) };
}

/** Fixed invitation lookup only. This creates no app identity, member session or
 * WorkspaceRequestPrincipal. The verified license is captured before held SQL. */
export async function withFileGuestInvitationAuthority<T>(invitationId: string, purpose: FileGuestInvitationAuthorityPurpose,
  operation: (authority: FileGuestInvitationAuthority) => Promise<T>): Promise<T> {
  if (!isFileGuestId(invitationId) || !['challenge','redeem','failed_challenge_cleanup','access'].includes(purpose)
    || typeof operation !== 'function') guestFail('FILE_GUEST_INVITATION_INVALID');
  const license = freeze(structuredClone(await requireTeamRuntimeLicense()));
  if (!license.licensed || !['active','grace'].includes(license.licenseState)) fail('PRINCIPAL_EXPIRED');
  const database = await openDb();
  let captured: InvitationCapture;
  try {
    const realm = await database.get(`SELECT current_schema() AS schema,
      (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database`) as Row | undefined;
    if (!realm || typeof realm.schema !== 'string' || !realm.schema || !number(realm.database,1)) fail('PRINCIPAL_SCOPE_CHANGED');
    const prefix = quote(realm.schema);
    const row = await database.get(`SELECT id,workspace_id,path,document_id,lineage_id,lifecycle_generation,policy_revision,
      permission,created_by_user_id,status,expires_at FROM ${prefix}.file_guest_invitations WHERE id=$1`, [invitationId]) as Row | undefined;
    const target = invitationTarget(row);
    const user = await database.get(`SELECT id,email,role,banned FROM ${prefix}."user" WHERE id=$1`, [target.invitation.createdByUserId]) as Row | undefined;
    if (!user || user.id !== target.invitation.createdByUserId || !flag(user.banned) || Number(user.banned) === 1) fail('PRINCIPAL_AUTH_REVOKED');
    await assertUserSeatAccess({ userId: target.invitation.createdByUserId,database,licenseStatus: license });
    const workspace = await readPostgresWorkspaceForActorOnConnection(database,resolveWorkspaceActor({
      id: target.invitation.createdByUserId,email: user.email as string | null,role: user.role as string | null }),target.invitation.workspaceId);
    if (!workspace || workspace.legacy || workspace.status !== 'active' || !workspace.permissions.canRead
      || !workspace.permissions.canCreatePublicLinks || target.invitation.permission === 'write' && !workspace.permissions.canWrite
      || workspace.actor?.userId !== target.invitation.createdByUserId || typeof workspace.rootRelativePath !== 'string'
      || workspace.rootRelativePath.length > 4096) fail('PRINCIPAL_ACCESS_DENIED');
    captured = { kind: 'file_guest',active: true,accepting: true,pending: new Set(),userId: target.invitation.createdByUserId,
      workspace: freeze(structuredClone(workspace)),permission: target.invitation.permission === 'write' ? 'canWrite' : 'canRead',
      license,database: Number(realm.database),schema: realm.schema,enterBefore: 0,purpose,
      invitation: target.invitation,expiresAt: target.expiresAt };
  } finally { await database.close(); }
  captured.enterBefore = performance.now()+MAX_PHASE_MS;
  const authority = Object.freeze({}) as FileGuestInvitationAuthority;
  invitationAuthorities.set(authority,captured);
  try {
    let result: T | undefined, operationFailure: unknown;
    try { result = await operation(authority); }
    catch (error) { operationFailure = reason(error); captured.failure ??= operationFailure; }
    captured.accepting = false;
    if (captured.pending.size) {
      captured.failure ??= new WorkspaceRequestPrincipalError('PRINCIPAL_DETACHED');
      await Promise.allSettled([...captured.pending]);
    }
    // The callback owns rollback/disposal; its later error must survive poison.
    if (operationFailure !== undefined) throw operationFailure;
    if (captured.failure !== undefined) throw captured.failure;
    return result as T;
  } finally { captured.active = false; captured.accepting = false; invitationAuthorities.delete(authority); }
}

async function currentInvitation(phase: Phase): Promise<WorkspaceContext> {
  await checkIdentity(phase);
  const request = phase.request;
  if (request.kind !== 'file_guest') guestFail('FILE_GUEST_INVITATION_AUTHORITY_REQUIRED');
  // Deliberately no FOR UPDATE: the service must take Shared admission first.
  // Mutable OTP/session fields are absent from this fixed authority comparison.
  const row = await phase.database.get(`SELECT id,workspace_id,path,document_id,lineage_id,lifecycle_generation,policy_revision,
    permission,created_by_user_id,status,expires_at FROM ${table(phase,'file_guest_invitations')} WHERE id=$1`, [request.invitation.id]) as Row | undefined;
  active(phase);
  const target = invitationTarget(row);
  if (Object.keys(request.invitation).some(key => Reflect.get(request.invitation,key) !== Reflect.get(target.invitation,key))
    || target.expiresAt !== request.expiresAt) guestFail('FILE_GUEST_INVITATION_SCOPE_CHANGED');
  const rawWorkspace = await phase.database.get(`SELECT id,organization_id,type,status,owner_user_id,project_id,root_relative_path
    FROM ${table(phase,'canvas_workspaces')} WHERE id=$1`, [request.workspace.workspaceId]) as Row | undefined;
  active(phase); assertWorkspaceRow(phase,rawWorkspace);
  const user = await phase.database.get(`SELECT id,email,role,banned FROM ${table(phase,'user')} WHERE id=$1`, [request.userId]) as Row | undefined;
  active(phase);
  if (!user || user.id !== request.userId || !flag(user.banned) || Number(user.banned) === 1) fail('PRINCIPAL_AUTH_REVOKED');
  const workspace = await currentUserWorkspace(phase,user);
  if (!workspace.permissions.canCreatePublicLinks) fail('PRINCIPAL_ACCESS_DENIED');
  await checkIdentity(phase);
  return freeze(workspace);
}

/** Caller owns one RC/RW transaction, mandatory rollback, Shared admission,
 * exact invitation row locks, narrow SQL and confirmed COMMIT. No pool here. */
export function withFileGuestInvitationAuthorityOnConnection<T>(database: SqlConnection, authority: FileGuestInvitationAuthority,
  operation: (access: FileGuestInvitationAuthorityAccess) => Promise<T>): Promise<T> {
  const request = invitationAuthorities.get(authority);
  return withCapturedPrincipalOnConnection(database, request,
    new FileGuestInvitationAuthorityError('FILE_GUEST_INVITATION_AUTHORITY_REQUIRED'), currentInvitation,
    (workspace, assertCurrent) => Object.freeze({ workspace, invitation: request!.invitation, userId: request!.userId, assertCurrent }), operation);
}

function agentOptions(input: { permission: 'canRead' | 'canWrite'; workspaceId?: string }) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
    || !Object.hasOwn(input,'permission')
    || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['permission','workspaceId'].includes(key)
      || !Object.getOwnPropertyDescriptor(input,key)?.enumerable
      || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(input,key),'value'))
    || !['canRead','canWrite'].includes(input.permission)
    || input.workspaceId !== undefined && !id(input.workspaceId)) fail('PRINCIPAL_INVALID');
  return Object.freeze({ permission: input.permission, workspaceId: input.workspaceId });
}

async function readAgentSession(database: SqlConnection, schemaName: string, origin: AgentWorkspaceOrigin,
  agentId: string, lock = false): Promise<number> {
  const rows = await database.all(`SELECT id,session_id,user_id,agent_id,workspace_id,workspace_type,
    organization_id,customer_id,project_id,workspace_root_relative_path,archived_at
    FROM ${quote(schemaName)}.pi_sessions WHERE user_id=$1 AND session_id=$2 LIMIT 2${lock ? ' FOR SHARE NOWAIT' : ''}`,
  [origin.userId, origin.sessionId]) as Row[];
  return parseAgentSession(rows, origin, agentId);
}

function parseAgentSession(rows: Row[], origin: AgentWorkspaceOrigin, agentId: string): number {
  const row = rows[0];
  if (rows.length !== 1 || !number(row?.id,1) || row.session_id !== origin.sessionId || row.user_id !== origin.userId
    || row.agent_id !== agentId || row.archived_at !== null) fail('PRINCIPAL_AUTH_REVOKED');
  if (row.workspace_id !== origin.workspaceId || row.workspace_type !== origin.workspaceType
    || (row.organization_id ?? null) !== origin.organizationId || (row.customer_id ?? null) !== origin.customerId
    || (row.project_id ?? null) !== origin.projectId
    || row.workspace_root_relative_path !== origin.workspaceRootRelativePath) fail('PRINCIPAL_SCOPE_CHANGED');
  return Number(row.id);
}

async function readAgentProfilePin(database: SqlConnection, schemaName: string, agentId: string, lock = false): Promise<AgentProfilePin> {
  const row = await database.get(`SELECT id,revision,enabled_tools_json,workflow_version,workflow_revision
    FROM ${quote(schemaName)}.agents WHERE agent_id=$1${lock ? ' FOR SHARE NOWAIT' : ''}`, [agentId]) as Row | undefined;
  return parseAgentProfilePin(row);
}

function parseAgentProfilePin(row: Row | undefined): AgentProfilePin {
  if (!row || !number(row.id,1) || !number(row.revision,1) || !number(row.workflow_revision)
    || row.workflow_version !== null && Number(row.workflow_version) !== 1
    || row.enabled_tools_json !== null && (typeof row.enabled_tools_json !== 'string' || row.enabled_tools_json.length > 1024*1024)) fail('PRINCIPAL_ACCESS_DENIED');
  return Object.freeze({ id: Number(row.id), revision: Number(row.revision), enabledToolsJson: row.enabled_tools_json as string | null,
    workflowVersion: row.workflow_version === null ? null : Number(row.workflow_version), workflowRevision: Number(row.workflow_revision) });
}
function sameAgentProfile(expected: AgentProfilePin, actual: AgentProfilePin): boolean {
  return Object.keys(expected).every(key => Reflect.get(expected,key) === Reflect.get(actual,key));
}
function matchesAgentWorkspace(origin: AgentWorkspaceOrigin, workspace: WorkspaceContext): boolean {
  return !origin.legacy && workspace.legacy === false && workspace.status === 'active'
    && workspace.actor?.userId === origin.userId && workspace.workspaceId === origin.workspaceId
    && workspace.workspaceType === origin.workspaceType && (workspace.organizationId ?? null) === origin.organizationId
    && (workspace.customerId ?? null) === origin.customerId && (workspace.projectId ?? null) === origin.projectId
    && workspace.rootPath === origin.workspaceRoot && workspace.rootRelativePath === origin.workspaceRootRelativePath;
}

type AgentCreateScopeFacts = Readonly<{
  workspace?: WorkspacePermissionSnapshotRow; sessions: Row[]; profile?: Row; account?: Row;
  seat?: CurrentSeatSnapshotRow; seatPolicy: EffectiveSeatPolicy;
}>;

/** Reuses the ordinary account, seat, Workspace and Agent decisions. Genuine
 * Create facts are read together for this exact Current invocation, never cached. */
async function readAgentWorkspace(database: SqlConnection, schemaName: string, origin: AgentWorkspaceOrigin,
  agentId: string, permission: AuthorizationCapture['permission'], license: LicenseStatus,
  assertAlive: () => unknown, lock: boolean, createPhase?: Phase, createFacts?: AgentCreateScopeFacts): Promise<WorkspaceContext> {
  assertAlive();
  if (createPhase) {
    active(createPhase);
    const request = createPhase.request;
    if (createPhase.database !== database || request.kind !== 'agent_tool'
      || !agentMarkdownCreateCaptures.has(request) || !createPhase.agentCreateRealm || !createFacts
      || request.origin !== origin || request.agentId !== agentId || request.permission !== permission
      || request.license !== license || request.schema !== schemaName || !lock) fail('PRINCIPAL_REQUIRED');
  } else if (createFacts !== undefined) fail('PRINCIPAL_REQUIRED');
  const user = createPhase ? createFacts!.account
    : await database.get(`SELECT id,banned FROM ${quote(schemaName)}."user" WHERE id=$1`, [origin.userId]) as Row | undefined;
  assertAlive();
  if (!user || user.id !== origin.userId || !flag(user.banned) || Number(user.banned) === 1) fail('PRINCIPAL_AUTH_REVOKED');
  let workspace: WorkspaceContext;
  if (createPhase) {
    // These actual seat, session and Workspace rows belong to the same fresh
    // statement under schema()/locks()/receipt-realm pin. currentAgent has just
    // checked the complete original PI/session and profile from that statement.
    const seat = evaluateUserSeatAccessSnapshot(origin.userId, createFacts!.seatPolicy, createFacts!.seat);
    assertAlive();
    if (seat.organizationId !== origin.organizationId) fail('PRINCIPAL_SCOPE_CHANGED');
    if (user.email !== null && typeof user.email !== 'string'
      || user.role !== null && typeof user.role !== 'string') fail('PRINCIPAL_SCHEMA_INVALID');
    const actor = resolveWorkspaceActor({ id: origin.userId, email: user.email as string | null, role: user.role as string | null });
    const selected = workspaceContextFromPermissionSnapshot(createFacts!.workspace, actor);
    if (!selected || selected.legacy || selected.workspaceId !== origin.workspaceId) throw new Error('Workspace not found or inaccessible.');
    for (const requirement of ['canRead', 'canRunAgent', permission] as const) assertWorkspacePermission(selected.permissions, requirement);
    const access = await getAgentAccessOnConnection(database, origin.userId, agentId, {
      organizationId: selected.organizationId, workspaceId: selected.workspaceId, projectId: selected.projectId,
    });
    assertAlive();
    if (!access.canUse) throw new Error('Agent access is no longer available in this workspace.');
    workspace = selected;
  } else {
    await assertUserSeatAccess({ userId: origin.userId, database, licenseStatus: license }); assertAlive();
    await resolveVerifiedAgentActorContextOnConnection({ userId: origin.userId, organizationId: origin.organizationId,
      workspaceId: origin.workspaceId, projectId: origin.projectId }, database, { lock }); assertAlive();
    workspace = await readStoredAgentWorkspaceOnConnection(database, { userId: origin.userId, sessionId: origin.sessionId,
      agentId, workspaceId: origin.workspaceId, permissions: ['canRead','canRunAgent',permission] });
  }
  assertAlive();
  if (!matchesAgentWorkspace(origin,workspace)) fail('PRINCIPAL_SCOPE_CHANGED');
  return freeze(structuredClone(workspace));
}

async function lockAgentOrigin(phase: Phase, request: AgentCapture | JobAgentCapture): Promise<void> {
  const currentSessionId = await readAgentSession(phase.database, phase.identity!.schema, request.origin, request.agentId, true);
  active(phase);
  if (currentSessionId !== request.piSessionDbId) fail('PRINCIPAL_AUTH_REVOKED');
  const profile = await readAgentProfilePin(phase.database, phase.identity!.schema, request.agentId, true);
  active(phase);
  if (!sameAgentProfile(request.profile,profile)) fail('PRINCIPAL_SCOPE_CHANGED');
  bounded(await phase.database.all(`SELECT id FROM ${table(phase,'agent_grants')} WHERE agent_id=$1
    ORDER BY id COLLATE "C" LIMIT 1025 FOR SHARE NOWAIT`, [request.agentId]) as Row[]);
  bounded(await phase.database.all(`SELECT user_id FROM ${table(phase,'agent_members')} WHERE agent_id=$1
    ORDER BY user_id COLLATE "C" LIMIT 1025 FOR SHARE NOWAIT`, [request.agentId]) as Row[]);
  active(phase);
}

/** Fresh facts on the genuine Create phase's already locked connection. No
 * caller can supply these rows, and no observation survives this current check. */
async function readAgentCreateScopeFacts(phase: Phase): Promise<AgentCreateScopeFacts> {
  active(phase);
  const request = phase.request;
  if (request.kind !== 'agent_tool' || !agentMarkdownCreateCaptures.has(request)
    || !phase.agentCreateRealm || !phase.identity || phase.identity.schema !== request.schema) fail('PRINCIPAL_REQUIRED');
  const seatPolicy = resolveEffectiveSeatPolicy(request.license);
  const scopeSql = `SELECT
    (SELECT w.facts FROM (${workspacePermissionSnapshotJsonSql}) w) AS workspace,
    (SELECT COALESCE(jsonb_agg(s.facts),'[]'::jsonb) FROM (${postgresScalarSnapshotSql(`
      SELECT id,session_id,user_id,agent_id,workspace_id,workspace_type,organization_id,customer_id,
        project_id,workspace_root_relative_path,archived_at
      FROM ${table(phase,'pi_sessions')} WHERE user_id=$2 AND session_id=$3 LIMIT 2`, ['id', 'archived_at'])}) s) AS sessions,
    (SELECT a.facts FROM (${postgresScalarSnapshotSql(`
      SELECT id,revision,enabled_tools_json,workflow_version,workflow_revision
      FROM ${table(phase,'agents')} WHERE agent_id=$4 LIMIT 1`, ['id', 'revision', 'workflow_version', 'workflow_revision'])}) a) AS profile,
    (SELECT u.facts FROM (${postgresScalarSnapshotSql(`
      SELECT id,banned,email,role FROM ${table(phase,'user')} WHERE id=$2 LIMIT 1`, ['banned'])}) u) AS account,
    (SELECT seat.facts FROM (${postgresScalarSnapshotSql(userSeatAccessSnapshotSql(2,5),
      ['account_banned', 'reconciliation_seat_limit'])}) seat) AS seat`;
  const requiredTables = principalRelations(phase);
  let facts: {
    workspace: WorkspacePermissionSnapshotRow | null; sessions: Row[]; profile: Row | null; account: Row | null;
    seat: CurrentSeatSnapshotRow | null; principal_identity?: Row;
  } | undefined;
  try {
    // The initial context check and scope read have no intervening callback or
    // mutation. Read both fresh on this actual held B; the final check remains.
    // All result columns are JSONB. Reuse only the plan, with fresh rows on B.
    const prepared = Object.getOwnPropertyDescriptor(phase.database, 'getPrepared');
    const read = prepared && typeof prepared.value === 'function' ? prepared.value as SqlConnection['get'] : phase.database.get;
    facts = await read.call(phase.database, `SELECT facts.*,to_jsonb(context) AS principal_identity
      FROM (${scopeSql}) facts CROSS JOIN (${principalIdentitySnapshotQuery(6, 7)}) context`,
    [request.workspace.workspaceId, request.origin.userId, request.origin.sessionId, request.agentId, seatPolicy.mode,
      quote(request.schema), requiredTables]) as typeof facts;
  } catch (error) {
    // Namespace/relation drift can fail during planning of the combined read.
    // Deny through the Principal contract; never retry an aborted transaction.
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    if (code === '42P01' || code === '42703') fail('PRINCIPAL_SCHEMA_INVALID');
    if (code === '3F000') fail('PRINCIPAL_SCOPE_CHANGED');
    throw error;
  }
  validatePrincipalIdentitySnapshot(phase, facts?.principal_identity, requiredTables);
  active(phase);
  if (!facts || !Array.isArray(facts.sessions)) fail('PRINCIPAL_SCOPE_CHANGED');
  if ([facts.workspace, facts.account, facts.profile, facts.seat, ...facts.sessions]
    .some(value => value && Reflect.get(value, 'scalar_types_supported') !== true)) fail('PRINCIPAL_SCHEMA_INVALID');
  return freeze({ workspace: facts.workspace ?? undefined, sessions: facts.sessions,
    profile: facts.profile ?? undefined, account: facts.account ?? undefined, seat: facts.seat ?? undefined, seatPolicy });
}

/** Private core between the caller's actual context observations. */
async function readCurrentAgentWorkspace(phase: Phase): Promise<WorkspaceContext> {
  active(phase);
  const request = phase.request;
  if (request.kind !== 'agent_tool') fail('PRINCIPAL_REQUIRED');
  const create = agentMarkdownCreateCaptures.has(request);
  const facts = create ? await readAgentCreateScopeFacts(phase) : undefined;
  const rawWorkspace = create ? facts!.workspace
    : await phase.database.get(`SELECT id,organization_id,type,status,owner_user_id,project_id,root_relative_path
      FROM ${table(phase,'canvas_workspaces')} WHERE id=$1`, [request.workspace.workspaceId]) as Row | undefined;
  active(phase); assertWorkspaceRow(phase,rawWorkspace);
  const sessionId = create ? parseAgentSession(facts!.sessions, request.origin, request.agentId)
    : await readAgentSession(phase.database, phase.identity!.schema, request.origin, request.agentId);
  active(phase);
  if (sessionId !== request.piSessionDbId) fail('PRINCIPAL_AUTH_REVOKED');
  const profile = create ? parseAgentProfilePin(facts!.profile)
    : await readAgentProfilePin(phase.database, phase.identity!.schema, request.agentId);
  active(phase);
  if (!sameAgentProfile(request.profile,profile)) fail('PRINCIPAL_SCOPE_CHANGED');
  const workspace = await readAgentWorkspace(phase.database, phase.identity!.schema, request.origin, request.agentId,
    request.permission, request.license, () => active(phase), true, create ? phase : undefined, facts);
  if (!scope(workspace,request.workspace)) fail('PRINCIPAL_SCOPE_CHANGED');
  return workspace;
}

async function currentAgent(phase: Phase): Promise<WorkspaceContext> {
  await checkIdentity(phase);
  const workspace = await readCurrentAgentWorkspace(phase);
  await checkIdentity(phase);
  return workspace;
}

async function currentAgentWithOriginalOrigin(phase: Phase): Promise<WorkspaceContext> {
  const request = phase.request;
  const create = request.kind === 'agent_tool' && agentMarkdownCreateCaptures.has(request);
  let workspace: WorkspaceContext;
  if (create) {
    workspace = await readCurrentAgentWorkspace(phase);
  } else workspace = await currentAgent(phase);
  if (request.kind !== 'agent_tool') fail('PRINCIPAL_REQUIRED');
  const optin = request.originalOrigin;
  if (!optin) {
    if (create) await checkIdentity(phase);
    return workspace;
  }
  const original = request.workspace;
  const expected = Object.freeze({ userId: request.userId, agentId: request.agentId, piSessionId: request.origin.sessionId,
    toolName: request.origin.toolName, toolCallId: request.origin.toolCallId, agentTurnId: request.origin.agentTurnId ?? null,
    piSessionDbId: request.piSessionDbId, agentProfileId: request.profile.id, agentProfileRevision: request.profile.revision,
    workflowVersion: request.profile.workflowVersion, workflowRevision: request.profile.workflowRevision,
    workspaceId: original.workspaceId, workspaceType: original.workspaceType, organizationId: original.organizationId ?? null,
    customerId: original.customerId ?? null, projectId: original.projectId ?? null, ownerUserId: original.ownerUserId ?? null,
    rootPath: original.rootPath, rootRelativePath: original.rootRelativePath, legacy: original.legacy, status: original.status });
  active(phase);
  let row: Row | undefined;
  if (create) {
    const requiredTables = principalRelations(phase);
    // The three adjacent context/origin/context reads contain no intervening
    // callback or mutation. Observe their complete facts together, including a
    // context row when the Workspace row is absent. No earlier proof is cached.
    try {
      row = await phase.database.get(`SELECT w.id AS workspace_id,w.type AS workspace_type,w.organization_id,w.customer_id,
        w.project_id,w.owner_user_id,w.root_relative_path,w.status,header.*,header.database AS database_oid
        FROM (${principalIdentitySnapshotSql}) header
        LEFT JOIN ${table(phase,'canvas_workspaces')} w ON w.id=$3`,
      [quote(request.schema), requiredTables, expected.workspaceId]) as Row | undefined;
    } catch (error) {
      // A same-B rename/removal used to be rejected by the preceding standalone
      // relation check. Preserve that typed denial if lookup cannot be planned.
      const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
      if (code === '42P01') fail('PRINCIPAL_SCHEMA_INVALID');
      if (code === '3F000') fail('PRINCIPAL_SCOPE_CHANGED');
      throw error;
    }
    validatePrincipalIdentitySnapshot(phase, row, requiredTables);
  } else row = await phase.database.get(`SELECT w.id AS workspace_id,w.type AS workspace_type,w.organization_id,w.customer_id,
    w.project_id,w.owner_user_id,w.root_relative_path,w.status,current_schema() AS schema,
    to_regnamespace(current_schema())::oid::bigint AS schema_oid,current_setting('search_path') AS search_path,
    (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid
    FROM ${table(phase,'canvas_workspaces')} w WHERE w.id=$1`, [expected.workspaceId]) as Row | undefined;
  active(phase);
  if (!row || row.workspace_id !== expected.workspaceId || row.workspace_type !== expected.workspaceType
    || (row.organization_id ?? null) !== expected.organizationId || (row.customer_id ?? null) !== expected.customerId
    || (row.project_id ?? null) !== expected.projectId || (row.owner_user_id ?? null) !== expected.ownerUserId
    || row.root_relative_path !== expected.rootRelativePath || row.status !== 'active'
    || ['workspaceId','workspaceType','organizationId','customerId','projectId','ownerUserId','rootPath','rootRelativePath','legacy','status']
      .some(key => (Reflect.get(workspace,key) ?? null) !== (Reflect.get(original,key) ?? null))
    || expected.legacy !== false || expected.status !== 'active' || typeof expected.rootPath !== 'string' || !expected.rootPath
    || typeof expected.rootRelativePath !== 'string' || expected.rootRelativePath.length > 4096
    || row.schema !== request.schema || !number(row.schema_oid,1) || Number(row.schema_oid) !== optin.realm.schemaOid
    || row.search_path !== (agentMarkdownCreateCaptures.has(request) ? phase.agentCreateRealm : optin.realm.searchPath)
    || !number(row.database_oid,1) || Number(row.database_oid) !== request.database) fail('PRINCIPAL_SCOPE_CHANGED');
  if (!create) await checkIdentity(phase);
  const historical: WorkspaceAgentToolHistoricalOrigin = Object.freeze({ ...expected,
    rootRelativePath: expected.rootRelativePath, legacy: false, status: 'active', schema: request.schema,
    schemaOid: Number(row.schema_oid), searchPath: optin.realm.searchPath, databaseOid: request.database });
  const returned: unknown = optin.observe(historical);
  if (returned !== undefined) {
    if (returned instanceof Promise) void returned.catch(() => undefined);
    fail('PRINCIPAL_DETACHED');
  }
  active(phase);
  return workspace;
}

/** Actual wrapped Agent invocation only. No caller context, user/session ID,
 * synthetic web request, credential or license override can mint this origin.
 * The captured scope spans the caller's transaction and its COMMIT cleanup. */
export async function withWorkspaceAgentToolPrincipal<T>(input: { permission: 'canRead' | 'canWrite'; workspaceId?: string },
  operation: (principal: WorkspaceAgentToolPrincipal) => Promise<T>): Promise<T> {
  return withAgentToolPrincipal(input, operation);
}

/** Opt-in original PI history from the genuine invocation and current B phase.
 * The synchronous sink may run repeatedly; its scalars grant no authority. */
export async function withWorkspaceAgentToolPrincipalOriginalOrigin<T>(input: { permission: 'canRead' | 'canWrite'; workspaceId?: string },
  observe: WorkspaceAgentToolHistoricalOriginObserver,
  operation: (principal: WorkspaceAgentToolPrincipal) => Promise<T>): Promise<T> {
  if (typeof observe !== 'function') fail('PRINCIPAL_INVALID');
  return withAgentToolPrincipal(input, operation, observe);
}

async function withAgentToolPrincipal<T>(input: { permission: 'canRead' | 'canWrite'; workspaceId?: string },
  operation: (principal: WorkspaceAgentToolPrincipal) => Promise<T>, observe?: WorkspaceAgentToolHistoricalOriginObserver,
  markdownCreate = false): Promise<T> {
  const selected = agentOptions(input);
  if (typeof operation !== 'function') return Promise.reject(new WorkspaceRequestPrincipalError('PRINCIPAL_INVALID'));
  const invocation = captureCurrentAgentToolInvocation();
  return withCapturedAgentToolInvocation(invocation, async assertInvocation => {
    const origin = assertInvocation();
    if (markdownCreate && (selected.permission !== 'canWrite' || !observe
      || origin.toolName !== 'write' && origin.toolName !== 'pdf_to_markdown')) fail('PRINCIPAL_ACCESS_DENIED');
    if (origin.legacy || !id(origin.userId) || !id(origin.sessionId) || !id(origin.workspaceId)
      || origin.agentId !== null && !id(origin.agentId)
      || selected.workspaceId !== undefined && selected.workspaceId !== origin.workspaceId
      || typeof origin.workspaceRootRelativePath !== 'string' || origin.workspaceRootRelativePath.length > 4096) fail('PRINCIPAL_ACCESS_DENIED');
    const agentId = normalizeManagedAgentId(origin.agentId);
    if (!id(agentId)) fail('PRINCIPAL_INVALID');
    const license = freeze(structuredClone(await getLicenseStatus())); assertInvocation();
    const database = await openDb();
    let captured: AgentCapture;
    try {
      const realm = await database.get(observe
        ? `SELECT current_schema() AS schema,(SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database,
          to_regnamespace(current_schema())::oid::bigint AS schema_oid,current_setting('search_path') AS search_path`
        : `SELECT current_schema() AS schema,
        (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database`) as Row | undefined;
      assertInvocation();
      if (!realm || typeof realm.schema !== 'string' || !realm.schema || !number(realm.database,1)) fail('PRINCIPAL_SCOPE_CHANGED');
      if (observe && (!number(realm.schema_oid,1) || typeof realm.search_path !== 'string'
        || !realm.search_path || realm.search_path.length > 4096)) fail('PRINCIPAL_SCOPE_CHANGED');
      const piSessionDbId = await readAgentSession(database, realm.schema, origin, agentId); assertInvocation();
      const profile = await readAgentProfilePin(database, realm.schema, agentId); assertInvocation();
      const workspace = await readAgentWorkspace(database, realm.schema, origin, agentId, selected.permission, license, assertInvocation, false);
      captured = { kind: 'agent_tool', invocation, origin, agentId, piSessionDbId, profile, active: true, accepting: true,
        pending: new Set(), userId: origin.userId, workspace, permission: selected.permission, license,
        database: Number(realm.database), schema: realm.schema, enterBefore: 0,
        ...(observe ? { originalOrigin: { observe, realm: Object.freeze({ schemaOid: Number(realm.schema_oid), searchPath: String(realm.search_path) }) } } : {}) };
    } finally { await database.close(); }
    assertInvocation();
    captured.enterBefore = performance.now()+MAX_PHASE_MS;
    const principal = Object.freeze({}) as WorkspaceAgentToolPrincipal;
    if (markdownCreate) {
      agentMarkdownCreateCaptures.add(captured);
      agentMarkdownCreatePrincipals.set(principal as WorkspaceAgentMarkdownCreatePrincipal,captured);
    } else agentToolPrincipals.set(principal,captured);
    try {
      let result: T | undefined, operationFailure: unknown;
      try { result = await operation(principal); }
      catch (error) { operationFailure = reason(error); captured.failure ??= operationFailure; }
      captured.accepting = false;
      if (captured.pending.size) {
        captured.failure ??= new WorkspaceRequestPrincipalError('PRINCIPAL_DETACHED');
        await Promise.allSettled([...captured.pending]);
      }
      if (operationFailure !== undefined) throw operationFailure;
      if (captured.failure !== undefined) throw captured.failure;
      assertInvocation();
      return result as T;
    } finally {
      captured.active = false; captured.accepting = false; agentToolPrincipals.delete(principal);
      agentMarkdownCreatePrincipals.delete(principal as WorkspaceAgentMarkdownCreatePrincipal); agentMarkdownCreateCaptures.delete(captured);
    }
  });
}

/** Create-only genuine PI factory; ordinary Agent handles cannot enter it. */
export function withWorkspaceAgentMarkdownCreatePrincipalOriginalOrigin<T>(input: { workspaceId: string },
  observe: WorkspaceAgentToolHistoricalOriginObserver,
  operation: (principal: WorkspaceAgentMarkdownCreatePrincipal) => Promise<T>): Promise<T> {
  if (typeof observe !== 'function' || typeof operation !== 'function') fail('PRINCIPAL_INVALID');
  return withAgentToolPrincipal({ permission: 'canWrite', workspaceId: input.workspaceId },
    principal => operation(principal as WorkspaceAgentMarkdownCreatePrincipal), observe, true);
}

/** Caller owns the genuine short transaction and its COMMIT/close. */
export function withWorkspaceAgentMarkdownCreatePrincipalOnConnection<T>(database: SqlConnection,
  principal: WorkspaceAgentMarkdownCreatePrincipal,
  operation: (access: WorkspaceAgentToolPrincipalAccess) => Promise<T>): Promise<T> {
  const request = agentMarkdownCreatePrincipals.get(principal);
  return withCapturedPrincipalOnConnection(database, request, new WorkspaceRequestPrincipalError('PRINCIPAL_REQUIRED'), currentAgentWithOriginalOrigin,
    (workspace, assertCurrent) => Object.freeze({ workspace, userId: request!.userId, agentId: request!.agentId,
      piSessionId: request!.origin.sessionId, toolName: request!.origin.toolName, toolCallId: request!.origin.toolCallId, assertCurrent }), operation);
}

/** Caller owns the same RC/RW transaction, admission and confirmed COMMIT.
 * PI session identity remains explicit and never becomes a member session. */
export function withWorkspaceAgentToolPrincipalOnConnection<T>(database: SqlConnection, principal: WorkspaceAgentToolPrincipal,
  operation: (access: WorkspaceAgentToolPrincipalAccess) => Promise<T>): Promise<T> {
  const request = agentToolPrincipals.get(principal);
  return withCapturedPrincipalOnConnection(database, request, new WorkspaceRequestPrincipalError('PRINCIPAL_REQUIRED'), currentAgentWithOriginalOrigin,
    (workspace, assertCurrent) => Object.freeze({ workspace, userId: request!.userId, agentId: request!.agentId,
      piSessionId: request!.origin.sessionId, toolName: request!.origin.toolName, toolCallId: request!.origin.toolCallId, assertCurrent }), operation);
}

/** Capture actual runtime policy before each short owner-B transaction. This
 * single-use handle cannot supply or override a license, actor or namespace. */
export async function captureWorkspaceOperationJobPolicy(): Promise<WorkspaceOperationJobPolicy> {
  const license = freeze(structuredClone(await getLicenseStatus()));
  const enterBefore = performance.now()+MAX_PHASE_MS;
  const pool = getPostgresRuntimeQueryable();
  if (!pool) fail('PRINCIPAL_REQUIRED');
  const row = (await pool.query(`SELECT current_schema() AS schema,
    to_regnamespace(current_schema())::oid::bigint AS schema_oid,current_setting('search_path') AS search_path,
    (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database`)).rows[0];
  if (!row || typeof row.schema !== 'string' || !row.schema || !number(row.schema_oid,1)
    || !number(row.database,1) || typeof row.search_path !== 'string' || !row.search_path
    || row.search_path.length > 4096) fail('PRINCIPAL_SCOPE_CHANGED');
  const policy = Object.freeze({}) as WorkspaceOperationJobPolicy;
  jobPolicies.set(policy, { license, enterBefore, database: Number(row.database), schema: row.schema,
    schemaOid: Number(row.schema_oid), searchPath: row.search_path, used: false });
  return policy;
}

function jobRequest(phase: Phase): JobUserCapture | JobAgentCapture {
  if (phase.request.kind !== 'job_user' && phase.request.kind !== 'job_agent') fail('PRINCIPAL_REQUIRED');
  return phase.request;
}

async function assertJobClaim(phase: Phase): Promise<void> {
  const request = jobRequest(phase);
  active(phase);
  if (request.policy.failure !== undefined) throw request.policy.failure;
  const binding = await assertWorkspaceOperationBatchClaimOnConnection(phase.database,request.claim);
  active(phase);
  if (binding !== request.binding || binding.source.databaseOid !== request.policy.database
    || binding.source.schemaName !== request.policy.schema || binding.source.schemaOid !== request.policy.schemaOid
    || binding.source.searchPath !== request.policy.searchPath) fail('PRINCIPAL_SCOPE_CHANGED');
  const row = await checkIdentity(phase);
  active(phase);
  if (!row || row.schema !== request.policy.schema || !number(row.schema_oid,1)
    || Number(row.schema_oid) !== request.policy.schemaOid || row.search_path !== request.policy.searchPath) fail('PRINCIPAL_SCOPE_CHANGED');
}

function assertJobWorkspace(request: JobUserCapture | JobAgentCapture, workspace: WorkspaceContext | null): asserts workspace is WorkspaceContext {
  if (!workspace || workspace.legacy || workspace.status !== 'active' || workspace.actor?.userId !== request.userId
    || !workspaceOperationJobScopeMatches(request.binding.authorization.mode === 'direct'
      ? request.binding.authorization.jobScope : undefined,workspace)) fail('PRINCIPAL_SCOPE_CHANGED');
  if (!workspace.permissions.canRead || !workspace.permissions.canWrite || !workspace.permissions.canDelete
    || request.kind === 'job_agent' && !workspace.permissions.canRunAgent) fail('PRINCIPAL_ACCESS_DENIED');
}

/** The first workspace is an actual same-B reader result, never a reconstructed
 * WorkspaceContext with invented permissions. No callback has run at this point. */
async function initializeJobCapture(phase: Phase): Promise<void> {
  const request = jobRequest(phase);
  await assertJobClaim(phase);
  const user = await phase.database.get(`SELECT id,email,role,banned FROM ${table(phase,'user')} WHERE id=$1`, [request.userId]) as Row | undefined;
  active(phase);
  if (!user || user.id !== request.userId || !flag(user.banned) || Number(user.banned) === 1) fail('PRINCIPAL_AUTH_REVOKED');
  const workspace = await readPostgresWorkspaceForActorOnConnection(phase.database,
    resolveWorkspaceActor({ id: request.userId,email: user.email as string | null,role: user.role as string | null }),request.binding.workspaceId);
  active(phase); assertJobWorkspace(request,workspace);
  request.initializeWorkspace(freeze(structuredClone(workspace)));
  if (request.kind === 'job_agent') {
    const sessionId = await readAgentSession(phase.database,phase.identity!.schema,request.origin,request.agentId);
    active(phase);
    const profile = await readAgentProfilePin(phase.database,phase.identity!.schema,request.agentId);
    active(phase); request.initializeAgent(sessionId,profile);
  }
  await assertJobClaim(phase);
}

async function currentJob(phase: Phase): Promise<WorkspaceContext> {
  const request = jobRequest(phase);
  await assertJobClaim(phase);
  const user = await phase.database.get(`SELECT id,email,role,banned FROM ${table(phase,'user')} WHERE id=$1`, [request.userId]) as Row | undefined;
  active(phase);
  if (!user || user.id !== request.userId || !flag(user.banned) || Number(user.banned) === 1) fail('PRINCIPAL_AUTH_REVOKED');
  let workspace: WorkspaceContext;
  if (request.kind === 'job_agent') {
    const sessionId = await readAgentSession(phase.database,phase.identity!.schema,request.origin,request.agentId);
    active(phase);
    const profile = await readAgentProfilePin(phase.database,phase.identity!.schema,request.agentId);
    active(phase);
    if (sessionId !== request.piSessionDbId || !sameAgentProfile(request.profile,profile)) fail('PRINCIPAL_SCOPE_CHANGED');
    workspace = await readAgentWorkspace(phase.database,phase.identity!.schema,request.origin,request.agentId,
      'canWrite',request.license,() => active(phase),true);
  } else workspace = await currentUserWorkspace(phase,user);
  active(phase); assertJobWorkspace(request,workspace);
  await assertJobClaim(phase);
  return freeze(structuredClone(workspace));
}

function captureJobRequest(claim: WorkspaceOperationBatchClaim, binding: WorkspaceOperationBatchClaimBinding,
  policy: JobPolicyCapture): JobUserCapture | JobAgentCapture {
  const authorization = binding.authorization;
  if (!['apply','undo'].includes(binding.actionMode) || authorization.mode !== 'direct' || !authorization.jobScope
    || authorization.jobScope.legacy || authorization.jobScope.workspaceId !== binding.workspaceId
    || typeof authorization.jobScope.rootRelativePath !== 'string'
    || !id(authorization.actorUserId) || !id(authorization.actorId)
    || authorization.actorType !== 'user' && authorization.actorType !== 'agent'
    || binding.actionMode === 'apply' && authorization.actorType === 'agent' && !id(authorization.actorSessionId)) fail('PRINCIPAL_INVALID');
  if (binding.source.databaseOid !== policy.database || binding.source.schemaName !== policy.schema
    || binding.source.schemaOid !== policy.schemaOid || binding.source.searchPath !== policy.searchPath) fail('PRINCIPAL_SCOPE_CHANGED');
  let resolved: WorkspaceContext | undefined;
  const base: JobCaptureBase = {
    claim,binding,policy,userId: authorization.actorUserId,permission: 'canWrite',license: policy.license,
    database: policy.database,schema: policy.schema,enterBefore: policy.enterBefore,
    active: true,accepting: true,pending: new Set(),
    get workspace() { if (!resolved) fail('PRINCIPAL_REQUIRED'); return resolved; },
    initializeWorkspace(workspace) { if (resolved) fail('PRINCIPAL_REENTRANT'); resolved = workspace; },
  };
  // A durable Undo is a fresh human request by the original initiating user.
  // Keep the original Agent actor in the immutable Delete intent, but never
  // borrow that Agent's old PI session or ACL as authority for human Undo.
  if (binding.actionMode === 'undo' || authorization.actorType === 'user') return Object.assign(base,{ kind: 'job_user' as const });
  const jobScope = authorization.jobScope;
  const origin: AgentWorkspaceOrigin = Object.freeze({ userId: authorization.actorUserId,sessionId: authorization.actorSessionId!,
    workspaceId: jobScope.workspaceId,workspaceType: jobScope.workspaceType,organizationId: jobScope.organizationId,
    customerId: jobScope.customerId,projectId: jobScope.projectId,workspaceRoot: jobScope.rootPath,
    workspaceRootRelativePath: jobScope.rootRelativePath,legacy: false });
  let sessionId: number | undefined, pinnedProfile: AgentProfilePin | undefined;
  const captured = Object.assign(base,{ kind: 'job_agent' as const,agentId: authorization.actorId,origin,
    initializeAgent(value: number, profile: AgentProfilePin) {
      if (sessionId !== undefined || pinnedProfile) fail('PRINCIPAL_REENTRANT');
      sessionId = value; pinnedProfile = profile;
    },
  });
  return Object.defineProperties(captured,{
    piSessionDbId: { get() { if (sessionId === undefined) fail('PRINCIPAL_REQUIRED'); return sessionId; } },
    profile: { get() { if (!pinnedProfile) fail('PRINCIPAL_REQUIRED'); return pinnedProfile; } },
  }) as JobAgentCapture;
}

/** Fixed durable direct Apply/Undo authority. The caller owns the genuine
 * lifecycle owner-B, BEGIN RC/RW, rollback, narrow SQL, COMMIT and recovery.
 * Drain heartbeats before B: its borrowed claim holds the exact job row SHARE.
 * A policy is consumed once; acquire fresh policy outside each subsequent TX. */
export function withWorkspaceOperationJobPolicyOnConnection<T>(database: SqlConnection,
  input: { claim: WorkspaceOperationBatchClaim; policy: WorkspaceOperationJobPolicy },
  operation: (access: WorkspaceOperationJobPolicyAccess) => Promise<T>): Promise<T> {
  let captured: JobUserCapture | JobAgentCapture;
  let selected: JobPolicyCapture | undefined;
  try {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== 2
      || ['claim','policy'].some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(input,key);
        return !descriptor?.enumerable || !Object.hasOwn(descriptor,'value');
      }) || typeof operation !== 'function') fail('PRINCIPAL_INVALID');
    const claim = input.claim, policy = input.policy;
    selected = jobPolicies.get(policy);
    if (!selected || selected.used || selected.failure !== undefined) fail('PRINCIPAL_REQUIRED');
    selected.used = true;
    if (performance.now() > selected.enterBefore) fail('PRINCIPAL_EXPIRED');
    const binding = readWorkspaceOperationBatchClaimBinding(claim);
    captured = captureJobRequest(claim,binding,selected);
  } catch (error) {
    const failed = reason(error), held = phases.get(database);
    if (selected) selected.failure ??= failed;
    if (held) { held.failure ??= failed; held.request.failure ??= failed; }
    return Promise.reject(failed);
  }
  return withCapturedPrincipalOnConnection(database,captured,new WorkspaceRequestPrincipalError('PRINCIPAL_REQUIRED'),currentJob,
    (workspace, assertCurrent) => {
      const authorization = captured.binding.authorization;
      if (authorization.mode !== 'direct') fail('PRINCIPAL_REQUIRED');
      return Object.freeze({ workspace,userId: captured.userId,
        actorType: captured.kind === 'job_agent' ? 'agent' as const : 'user' as const,
        actorId: captured.kind === 'job_agent' ? captured.agentId : captured.userId,
        ...(captured.kind === 'job_agent' ? { piSessionId: captured.origin.sessionId } : {}),
        batchId: captured.binding.batchId,planId: captured.binding.planId,assertCurrent });
    },operation).catch(error => {
    selected!.failure ??= reason(error); throw selected!.failure;
  }).finally(() => { captured.active = false; captured.accepting = false; });
}
