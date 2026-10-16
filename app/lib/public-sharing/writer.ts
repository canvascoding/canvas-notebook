import 'server-only';

import { NextRequest } from 'next/server';
import { openDb, type SqlConnection } from '../db';
import { executeLifecycleTransaction } from '../collaboration/lifecycle-transaction';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { getWorkspaceFileLifecycleLeases } from '../collaboration/file-lifecycle-admission-context';
import { lockFileCollaborationPaths } from '../files/collaboration-repository/transaction';
import { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection,
  withWorkspaceAgentToolPrincipal, withWorkspaceAgentToolPrincipalOnConnection,
  withWorkspaceRequestPrincipalOriginalOrigin, WorkspaceRequestPrincipalError,
  type WorkspaceRequestHistoricalOrigin } from '../workspaces/request-principal';
import type { WorkspaceContext } from '../workspaces/types';
import { resolveWorkspaceActor } from '../workspaces/context';
import { readPostgresWorkspaceForActorOnConnection } from '../workspaces/postgres-runtime';
import { captureCurrentAgentToolInvocation, assertCurrentAgentToolInvocation } from '../pi/agent-tool-invocation';
import type { PublicShareRow } from './public-file-shares';
import { readPublicShareOnConnection, revokePublicShareOnConnection, updatePublicSharePolicyOnConnection } from './repository';
import { withPreparedPublicShareToolPolicy, PublicShareToolPolicyError } from './tool-policy';
import { withWorkspaceMutationLock, WorkspaceMutationLockError } from '../files/workspace-mutation-lock';
import { withWorkspaceSideEffectWriterFenceOnConnection, withWorkspaceSideEffectWriterMutationOnConnection,
  WorkspaceSideEffectWriterFenceError, type WorkspaceSideEffectWriterTarget } from '../files/workspace-side-effect-writer-fence';
import { readWorkspaceDocumentCatalogue, WorkspaceDocumentCatalogueError } from '../collaboration/workspace-document-catalogue';
import { COLLABORATION_SCHEMA_VERSION } from '../collaboration/types';
import { isInternalWorkspaceStagingPath } from '../files/internal-staging-path';
import { isSensitiveWorkspacePath } from './public-file-shares';
import { isHtmlWorkspacePath, type PublicShareSecurityMode } from './public-share-security';
import { withPreparedPublicSharePhysicalTarget, PublicSharePhysicalTargetError } from './physical-target';

export class PublicShareWriterError extends Error {
  constructor(readonly code: 'PUBLIC_SHARE_WRITE_INVALID' | 'PUBLIC_SHARE_WRITE_DENIED' | 'PUBLIC_SHARE_WRITE_CHANGED'
    | 'PUBLIC_SHARE_WRITE_BUSY' | 'PUBLIC_SHARE_WRITE_REENTRANT') {
    super(code); this.name = 'PublicShareWriterError';
  }
  get status() { return this.code === 'PUBLIC_SHARE_WRITE_INVALID' ? 400 : this.code === 'PUBLIC_SHARE_WRITE_DENIED' ? 403 : 409; }
}
export class PublicShareWriterCommitError extends Error {
  readonly code = 'PUBLIC_SHARE_WRITE_COMMIT_UNCONFIRMED';
  readonly status = 503;
  constructor() {
    super('The public link action could not be confirmed. Reload its current state before requesting another change.');
    this.name = 'PublicShareWriterCommitError';
  }
}
type Revocation = Readonly<{ id: string; workspaceId?: string }>;
type RevokedShare = Readonly<{ row: PublicShareRow; workspace: WorkspaceContext }>;
type Authority = Readonly<{ workspace: WorkspaceContext; userId: string; source: 'ui' | 'agent'; assertCurrent: () => Promise<void> }>;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
function fail(code: PublicShareWriterError['code']): never { throw new PublicShareWriterError(code); }
function captureRevocation(input: Revocation): Revocation {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['id','workspaceId'].includes(key)
      || !Object.getOwnPropertyDescriptor(input,key)?.enumerable
      || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(input,key),'value'))
    || !validId(input.id) || input.workspaceId !== undefined && !validId(input.workspaceId)) fail('PUBLIC_SHARE_WRITE_INVALID');
  return Object.freeze({id:input.id,...(input.workspaceId === undefined ? {} : {workspaceId:input.workspaceId})});
}

/** Bind only SQL relations; the genuine Principal owns account/ACL authority.
 * ROW EXCLUSIVE allows ordinary independent DML and blocks stronger trigger DDL. */
async function bindRelations(database: SqlConnection, assertAuthority: () => Promise<void>, extraNames: readonly string[] = []): Promise<{
  table: string; prefix: string; assertCurrent: () => Promise<void>;
}> {
  await assertAuthority();
  const realm = await database.get('SELECT current_schema() AS name') as {name:string};
  const prefix = quote(realm.name);
  const names = ['public_file_shares','collaboration_admission_requests','collaboration_admission_scopes','collaboration_admission_targets',...extraNames];
  const read = () => database.all(`SELECT name,to_regclass(name)::oid::bigint AS resolved,
    to_regclass($1||'.'||quote_ident(name))::oid::bigint AS bound FROM unnest($2::text[]) names(name)`,[prefix,names]) as
    Promise<Array<{name:string;resolved:number|string|null;bound:number|string|null}>>;
  const valid = (rows: Awaited<ReturnType<typeof read>>) => rows.length === names.length
    && new Set(rows.map(row => row.name)).size === names.length
    && rows.every(row => names.includes(row.name) && Number.isSafeInteger(Number(row.bound)) && Number(row.bound) > 0
      && Number(row.resolved) === Number(row.bound));
  const original = await read();
  if (!valid(original)) fail('PUBLIC_SHARE_WRITE_CHANGED');
  const expected = new Map(original.map(row => [row.name,Number(row.bound)]));
  await database.run(`LOCK TABLE ${names.map(name => `${prefix}.${quote(name)}`).join(',')} IN ROW EXCLUSIVE MODE NOWAIT`);
  const assertCurrent = async () => {
    await assertAuthority();
    const current = await read();
    if (!valid(current) || current.some(row => expected.get(row.name) !== Number(row.bound))) fail('PUBLIC_SHARE_WRITE_CHANGED');
    const fk = await database.get(`SELECT count(*)=1 AS valid FROM pg_constraint c
      WHERE c.conrelid=to_regclass($1) AND c.contype='f' AND c.convalidated AND NOT c.condeferrable
        AND c.conenforced
        AND (SELECT count(*)=2 AND bool_and(t.tgenabled IN ('O','A')) FROM pg_trigger t
          WHERE t.tgconstraint=c.oid AND t.tgrelid=c.conrelid)
        AND c.confrelid=to_regclass($2) AND cardinality(c.conkey)=1 AND cardinality(c.confkey)=1
        AND (SELECT attname FROM pg_attribute WHERE attrelid=c.conrelid AND attnum=c.conkey[1])='created_by_user_id'
        AND (SELECT attname FROM pg_attribute WHERE attrelid=c.confrelid AND attnum=c.confkey[1])='id'`,
    [`${prefix}.public_file_shares`,`${prefix}."user"`]) as {valid:boolean}|undefined;
    if (fk?.valid !== true) fail('PUBLIC_SHARE_WRITE_CHANGED');
  };
  await assertCurrent();
  return {table:`${prefix}.public_file_shares`,prefix,assertCurrent};
}

async function assertAdmission(database: SqlConnection, prefix: string, workspaceId: string, row: PublicShareRow): Promise<void> {
  // A historical malformed name must not be normalized onto another target.
  const canonical = isCanonicalAdmissionPath(row.workspacePath);
  const reserved = await database.get(`SELECT 1 FROM ${prefix}.collaboration_admission_scopes s
    JOIN ${prefix}.collaboration_admission_requests r ON r.request_id=s.request_id
    WHERE s.workspace_id=$1 AND r.status NOT IN ('committed','cancelled')
      AND ($4::boolean=false OR s.path=$2 OR s.kind='subtree' AND (s.path='' OR left($2,length(s.path)+1)=s.path||'/'))
    UNION ALL SELECT 1 FROM ${prefix}.collaboration_admission_targets WHERE document_id=$3 AND active LIMIT 1`,
  [workspaceId,row.workspacePath,row.documentId,canonical]);
  if (reserved) fail('PUBLIC_SHARE_WRITE_BUSY');
}
function canManage(row: PublicShareRow, authority: Authority, adminOverride = true): boolean {
  const workspace = authority.workspace;
  if (row.createdByUserId === authority.userId) return true;
  if (adminOverride && authority.source === 'ui' && workspace.actor?.role === 'admin') return true;
  return row.workspaceType === 'project' ? workspace.permissions.canManageWorkspace
    : (row.workspaceType === 'organization' || row.workspaceType === 'team') && workspace.permissions.canCreatePublicLinks;
}

/** The generic Principal proves canRead. Public management additionally needs
 * the current operation-specific rights, including changes made on this B.
 * Resolve the actor only from the actual bound user row, never caller claims. */
async function assertPublicCapabilityCurrent(database: SqlConnection, prefix: string, row: PublicShareRow,
  authority: Authority, policy = false): Promise<void> {
  await authority.assertCurrent();
  const user = await database.get(`SELECT id,email,role FROM ${prefix}."user" WHERE id=$1`,[authority.userId]) as
    {id:string;email:string|null;role:string|null}|undefined;
  if (!user || user.id !== authority.userId) fail('PUBLIC_SHARE_WRITE_DENIED');
  const workspace = await readPostgresWorkspaceForActorOnConnection(database,
    resolveWorkspaceActor({id:user.id,email:user.email,role:user.role}),authority.workspace.workspaceId);
  if (!workspace || ['workspaceId','workspaceType','organizationId','customerId','projectId','ownerUserId','rootPath',
    'rootRelativePath','legacy','status'].some(key => (Reflect.get(workspace,key) ?? null) !== (Reflect.get(authority.workspace,key) ?? null))
    || !workspace.permissions.canRead
    || (policy || authority.source === 'agent') && !workspace.permissions.canCreatePublicLinks
    || !canManage(row,{...authority,workspace},!policy)) fail('PUBLIC_SHARE_WRITE_DENIED');
  await authority.assertCurrent();
}
const originKeys = ['id','workspaceId','organizationId','customerId','projectId','workspaceType','workspaceRootRelativePath',
  'workspacePath','tokenHash','policyRevision','status','documentId','lineageId','lifecycleGeneration','fileIdentity',
  'targetRevisionPolicy','createdByUserId'] as const;
function sameOrigin(left: PublicShareRow, right: PublicShareRow): boolean {
  return originKeys.every(key => left[key] === right[key]);
}
function sameRow(left: PublicShareRow, right: PublicShareRow): boolean {
  return Object.keys(left).every(key => {
    const a = Reflect.get(left,key), b = Reflect.get(right,key);
    return a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
  });
}

async function revokeOnConnection(database: SqlConnection, input: Revocation, authority: Authority): Promise<RevokedShare | null> {
  const {workspace} = authority;
  if (input.workspaceId !== undefined && input.workspaceId !== workspace.workspaceId || !workspace.permissions.canRead
    || authority.source === 'agent' && !workspace.permissions.canCreatePublicLinks) fail('PUBLIC_SHARE_WRITE_DENIED');
  if (getWorkspaceFileLifecycleLeases()?.has(workspace.workspaceId)) fail('PUBLIC_SHARE_WRITE_REENTRANT');
  const relations = await bindRelations(database,authority.assertCurrent);
  const shared = await database.get('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS locked',
    [collaborationAdmissionLockKey(workspace.workspaceId)]) as {locked?:boolean}|undefined;
  if (shared?.locked !== true) fail('PUBLIC_SHARE_WRITE_BUSY');
  const selector = {table:relations.table,workspaceId:workspace.workspaceId,id:input.id};
  const before = await readPublicShareOnConnection(database,selector);
  if (!before) { await relations.assertCurrent(); return null; }
  if (!canManage(before,authority)) fail('PUBLIC_SHARE_WRITE_DENIED');
  await assertPublicCapabilityCurrent(database,relations.prefix,before,authority);
  await assertAdmission(database,relations.prefix,workspace.workspaceId,before);
  await lockFileCollaborationPaths(database,workspace.workspaceId,[before.workspacePath]);
  const locked = await readPublicShareOnConnection(database,{...selector,forUpdate:true});
  if (!locked || !sameOrigin(before,locked)) fail('PUBLIC_SHARE_WRITE_CHANGED');
  await relations.assertCurrent();
  await assertPublicCapabilityCurrent(database,relations.prefix,locked,authority);
  await assertAdmission(database,relations.prefix,workspace.workspaceId,locked);
  if (locked.status === 'revoked') return {row:locked,workspace};
  const now = Date.now();
  const updated = await revokePublicShareOnConnection(database,{table:relations.table,expected:locked,nowMs:now,reason:'manual'});
  const expected: PublicShareRow = {...locked,status:'revoked',policyRevision:locked.policyRevision+1,
    revokedAt:new Date(now),revokedReason:'manual',updatedAt:new Date(now)};
  if (!updated || !sameRow(expected,updated)) fail('PUBLIC_SHARE_WRITE_CHANGED');
  const stored = await readPublicShareOnConnection(database,selector);
  if (!stored || !sameRow(expected,stored)) fail('PUBLIC_SHARE_WRITE_CHANGED');
  await relations.assertCurrent();
  await assertPublicCapabilityCurrent(database,relations.prefix,stored,authority);
  await assertAdmission(database,relations.prefix,workspace.workspaceId,locked);
  return {row:stored,workspace};
}

/** Genuine request only. Missing/stale targets remain revocable without FS,
 * native reads, exports, room ownership or a synthetic document identity. */
export async function revokePublicShareForRequest(request: NextRequest, input: Revocation): Promise<RevokedShare | null> {
  const selected = captureRevocation(input);
  let prepared = false;
  try { return await withWorkspaceRequestPrincipal(request,{permission:'canRead',workspaceId:selected.workspaceId},principal =>
    executeLifecycleTransaction({openConnection:openDb,execute:async database => {
      await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE');
      const result = await withWorkspaceRequestPrincipalOnConnection(database,principal,access =>
        revokeOnConnection(database,selected,{...access,source:'ui'}));
      prepared = true; return result;
    },recoverCommitted:async () => { throw new PublicShareWriterCommitError(); }}));
  } catch (error) { if (prepared) throw new PublicShareWriterCommitError(); throw error; }
}

/** Actual current tool invocation, stored PI/profile and fresh B rights. */
export async function revokePublicShareForAgent(input: Revocation): Promise<RevokedShare | null> {
  const selected = captureRevocation(input);
  const invocation = assertCurrentAgentToolInvocation(captureCurrentAgentToolInvocation());
  if (invocation.toolName !== 'public_share_file') fail('PUBLIC_SHARE_WRITE_DENIED');
  let prepared = false;
  try { return await withPreparedPublicShareToolPolicy(policy =>
    withWorkspaceAgentToolPrincipal({permission:'canRead',workspaceId:selected.workspaceId},principal =>
    executeLifecycleTransaction({openConnection:openDb,execute:async database => {
      await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE');
      const result = await withWorkspaceAgentToolPrincipalOnConnection(database,principal,async access => {
        const assertCurrent = () => policy.assertCurrent(database,access);
        await assertCurrent();
        return revokeOnConnection(database,selected,{workspace:access.workspace,userId:access.userId,source:'agent',assertCurrent});
      });
      prepared = true; return result;
    },recoverCommitted:async () => { throw new PublicShareWriterCommitError(); }})));
  } catch (error) { if (prepared) throw new PublicShareWriterCommitError(); throw error; }
}

export type PublicSharePolicyUpdate = Readonly<{
  id: string; workspaceId?: string; expectedPolicyRevision: number;
  expiresAt?: Date | null; securityMode?: PublicShareSecurityMode; reason?: string | null;
}>;
type PolicyChanges = Readonly<{ expiresAtMs?: number | null; securityMode?: PublicShareSecurityMode; reason?: string | null }>;
type PolicySelection = Revocation & Readonly<{ expectedPolicyRevision: number; changes: PolicyChanges }>;
const policyTargetRelations = ['collaboration_documents','file_collaboration_lineages','collaboration_yjs_states',
  'collaboration_yjs_state_backups','collaboration_agent_operations'] as const;

/** Snapshot caller data before any auth, lock wait or filesystem preparation. */
function capturePolicy(input: PublicSharePolicyUpdate): PolicySelection {
  const keys = ['id','workspaceId','expectedPolicyRevision','expiresAt','securityMode','reason'];
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key)
      || !Object.getOwnPropertyDescriptor(input,key)?.enumerable
      || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(input,key),'value'))
    || !validId(input.id) || input.workspaceId !== undefined && !validId(input.workspaceId)
    || !Number.isSafeInteger(input.expectedPolicyRevision) || input.expectedPolicyRevision < 1
    || input.expectedPolicyRevision >= Number.MAX_SAFE_INTEGER
    || input.securityMode !== undefined && input.securityMode !== 'strict' && input.securityMode !== 'interactive'
    || input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string') fail('PUBLIC_SHARE_WRITE_INVALID');
  let expiresAtMs: number | null | undefined;
  if (input.expiresAt === null) expiresAtMs = null;
  else if (input.expiresAt !== undefined) {
    try { expiresAtMs = Date.prototype.getTime.call(input.expiresAt); } catch { fail('PUBLIC_SHARE_WRITE_INVALID'); }
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs! <= Date.now()) fail('PUBLIC_SHARE_WRITE_INVALID');
  }
  const changes = Object.freeze({...(expiresAtMs === undefined ? {} : {expiresAtMs}),
    ...(input.securityMode === undefined ? {} : {securityMode:input.securityMode}),
    ...(input.reason === undefined ? {} : {reason:input.reason?.trim().slice(0,500) || null})});
  return Object.freeze({id:input.id,...(input.workspaceId === undefined ? {} : {workspaceId:input.workspaceId}),
    expectedPolicyRevision:input.expectedPolicyRevision,changes});
}

function assertPolicyRow(row: PublicShareRow, workspace: WorkspaceContext, input: PolicySelection): void {
  if (row.workspaceId !== workspace.workspaceId || row.workspaceType !== workspace.workspaceType
    || row.organizationId !== (workspace.organizationId ?? null)
    || row.customerId !== null && row.customerId !== (workspace.customerId ?? null)
    || row.projectId !== null && row.projectId !== (workspace.projectId ?? null)
    || row.workspaceRootRelativePath !== workspace.rootRelativePath
    || row.policyRevision !== input.expectedPolicyRevision || row.status !== 'active'
    || row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()
    || !isCanonicalAdmissionPath(row.workspacePath) || isInternalWorkspaceStagingPath(row.workspacePath)
    || isSensitiveWorkspacePath(row.workspacePath)) fail('PUBLIC_SHARE_WRITE_CHANGED');
  if (input.changes.expiresAtMs !== undefined && input.changes.expiresAtMs !== null
    && input.changes.expiresAtMs <= Date.now()) fail('PUBLIC_SHARE_WRITE_INVALID');
  const mode = input.changes.securityMode ?? row.securityMode;
  if (mode !== 'strict' && mode !== 'interactive') fail('PUBLIC_SHARE_WRITE_CHANGED');
  if (mode === 'interactive' && !isHtmlWorkspacePath(row.workspacePath)) fail('PUBLIC_SHARE_WRITE_INVALID');
}

/** Compare only intended policy fields, preserving the historical second-level
 * expiry semantics. Even a no-op must pass the full live authority/target phase. */
function policyChanged(row: PublicShareRow, changes: PolicyChanges): boolean {
  const seconds = (value: number | null) => value === null ? null : Math.floor(value/1000);
  return changes.expiresAtMs !== undefined && seconds(changes.expiresAtMs) !== seconds(row.expiresAt?.getTime() ?? null)
    || changes.securityMode !== undefined && changes.securityMode !== row.securityMode
    || changes.reason !== undefined && changes.reason !== row.reason;
}

function samePolicyOrigin(left: PublicShareRow, right: PublicShareRow): boolean {
  return sameOrigin(left,right) && left.expiresAt?.getTime() === right.expiresAt?.getTime()
    && left.securityMode === right.securityMode && left.reason === right.reason;
}

/** A fresh read selects stored identity; it grants no later authority. No file
 * preparation occurs while this preliminary connection is checked out. */
async function readPolicySelection(request: NextRequest, input: PolicySelection): Promise<
  {row:PublicShareRow;workspace:WorkspaceContext;origin:WorkspaceRequestHistoricalOrigin} | null> {
  let origin: WorkspaceRequestHistoricalOrigin | undefined;
  return withWorkspaceRequestPrincipalOriginalOrigin(request,{permission:'canRead',workspaceId:input.workspaceId},
    observed => { origin = observed; }, principal => executeLifecycleTransaction({openConnection:openDb,
      execute:async database => {
        await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE');
        return withWorkspaceRequestPrincipalOnConnection(database,principal,async access => {
          if (!origin || !access.workspace.permissions.canCreatePublicLinks) fail('PUBLIC_SHARE_WRITE_DENIED');
          const relations = await bindRelations(database,access.assertCurrent);
          const row = await readPublicShareOnConnection(database,{table:relations.table,workspaceId:access.workspace.workspaceId,id:input.id});
          if (row) {
            if (!canManage(row,{...access,source:'ui'},false)) fail('PUBLIC_SHARE_WRITE_DENIED');
            await assertPublicCapabilityCurrent(database,relations.prefix,row,{...access,source:'ui'},true);
            assertPolicyRow(row,access.workspace,input);
          }
          await relations.assertCurrent();
          return row ? {row,workspace:access.workspace,origin} : null;
        });
      },recoverCommitted:async () => { throw new PublicShareWriterCommitError(); }}));
}

async function updatePolicyOnConnection(database: SqlConnection, input: PolicySelection,
  initial: NonNullable<Awaited<ReturnType<typeof readPolicySelection>>>, authority: Authority,
  assertPhysical?: () => Promise<void>): Promise<RevokedShare> {
  const workspace = authority.workspace;
  if (!workspace.permissions.canRead || !workspace.permissions.canCreatePublicLinks
    || getWorkspaceFileLifecycleLeases()?.has(workspace.workspaceId)) fail('PUBLIC_SHARE_WRITE_DENIED');
  const relations = await bindRelations(database,authority.assertCurrent,policyTargetRelations);
  const selector = {table:relations.table,workspaceId:workspace.workspaceId,id:input.id};
  const before = await readPublicShareOnConnection(database,selector);
  if (!before || !samePolicyOrigin(initial.row,before)) fail('PUBLIC_SHARE_WRITE_CHANGED');
  if (!canManage(before,authority,false)) fail('PUBLIC_SHARE_WRITE_DENIED');
  assertPolicyRow(before,workspace,input);
  const targetCurrent = async () => {
    await relations.assertCurrent();
    await assertPublicCapabilityCurrent(database,relations.prefix,before,authority,true);
    await assertAdmission(database,relations.prefix,workspace.workspaceId,before);
    if (before.documentId === null) {
      if (!assertPhysical) fail('PUBLIC_SHARE_WRITE_CHANGED');
      const documents = await readWorkspaceDocumentCatalogue(database,workspace,{paths:[before.workspacePath],maxEntries:2});
      if (documents.some(document => document.authority !== 'pristine')) fail('PUBLIC_SHARE_WRITE_CHANGED');
      await assertPhysical();
    }
    assertPolicyRow(before,workspace,input);
  };
  const write = async () => {
    await targetCurrent(); await lockFileCollaborationPaths(database,workspace.workspaceId,[before.workspacePath]);
    const locked = await readPublicShareOnConnection(database,{...selector,forUpdate:true});
    if (!locked || !samePolicyOrigin(before,locked)) fail('PUBLIC_SHARE_WRITE_CHANGED');
    await targetCurrent();
    if (!policyChanged(locked,input.changes)) return {row:locked,workspace};
    const now = Date.now();
    const updated = await updatePublicSharePolicyOnConnection(database,{table:relations.table,expected:locked,nowMs:now,changes:input.changes});
    const expected = {...locked,policyRevision:locked.policyRevision+1,updatedAt:new Date(now),
      ...(input.changes.expiresAtMs === undefined ? {} : {expiresAt:input.changes.expiresAtMs === null ? null : new Date(input.changes.expiresAtMs)}),
      ...(input.changes.securityMode === undefined ? {} : {securityMode:input.changes.securityMode}),
      ...(input.changes.reason === undefined ? {} : {reason:input.changes.reason})};
    if (!updated || !sameRow(expected,updated)) fail('PUBLIC_SHARE_WRITE_CHANGED');
    const stored = await readPublicShareOnConnection(database,selector);
    if (!stored || !sameRow(expected,stored)) fail('PUBLIC_SHARE_WRITE_CHANGED');
    await targetCurrent(); return {row:stored,workspace};
  };
  if (before.documentId === null) {
    const shared = await database.get('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS locked',
      [collaborationAdmissionLockKey(workspace.workspaceId)]) as {locked?:boolean}|undefined;
    if (shared?.locked !== true) fail('PUBLIC_SHARE_WRITE_BUSY');
    return write();
  }
  // Resolve only representation/schema. The original share supplies identity;
  // the shared native fence verifies every registry/lineage/state field on B.
  const state = await database.get(`SELECT representation,schema_version FROM ${relations.prefix}.collaboration_yjs_states WHERE document_id=$1`,
    [before.documentId]) as {representation:WorkspaceSideEffectWriterTarget['representation'];schema_version:number|string}|undefined;
  if (!state || Number(state.schema_version) !== COLLABORATION_SCHEMA_VERSION) fail('PUBLIC_SHARE_WRITE_CHANGED');
  const target: WorkspaceSideEffectWriterTarget = {kind:'native_file',workspaceId:workspace.workspaceId,
    organizationId:workspace.organizationId ?? null,path:before.workspacePath,documentId:before.documentId,
    lineageId:before.lineageId!,lifecycleGeneration:before.lifecycleGeneration!,
    representation:state.representation,schemaVersion:Number(state.schema_version)};
  return withWorkspaceSideEffectWriterFenceOnConnection(database,{workspace,targets:[target]},() =>
    withWorkspaceSideEffectWriterMutationOnConnection(database,target,write));
}

/** Actual Web/Mobile request only. Never bootstrap or infer native identity from
 * a path. Kernel and physical FD precede the final fresh Principal/SQL phase. */
export async function updatePublicSharePolicyForRequest(request: NextRequest, input: PublicSharePolicyUpdate): Promise<RevokedShare | null> {
  if (!(request instanceof NextRequest)) fail('PUBLIC_SHARE_WRITE_INVALID');
  const selected = capturePolicy(input), original = new NextRequest(request.url,{method:request.method,headers:new Headers(request.headers)});
  let prepared = false;
  try {
    const initial = await readPolicySelection(original,selected);
    if (!initial) return null;
    return await withWorkspaceMutationLock(initial.workspace.workspaceId,async () => {
      const execute = (assertPhysical?: () => Promise<void>) => withWorkspaceRequestPrincipalOriginalOrigin(original,
        {permission:'canRead',workspaceId:initial.workspace.workspaceId}, current => {
          if (Object.keys(initial.origin).some(key => Reflect.get(current,key) !== Reflect.get(initial.origin,key))) fail('PUBLIC_SHARE_WRITE_CHANGED');
        },principal => executeLifecycleTransaction({openConnection:openDb,execute:async database => {
          await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE');
          const result = await withWorkspaceRequestPrincipalOnConnection(database,principal,access =>
            updatePolicyOnConnection(database,selected,initial,{...access,source:'ui'},assertPhysical));
          prepared = true; return result;
        },recoverCommitted:async () => { throw new PublicShareWriterCommitError(); }}));
      return initial.row.documentId === null
        ? withPreparedPublicSharePhysicalTarget(initial.workspace,initial.row,capture => execute(capture.assertCurrent))
        : execute();
    });
  } catch (error) {
    if (prepared) throw new PublicShareWriterCommitError();
    if (error instanceof WorkspaceSideEffectWriterFenceError) fail(error.code === 'SIDE_EFFECT_WRITER_BUSY' ? 'PUBLIC_SHARE_WRITE_BUSY' : 'PUBLIC_SHARE_WRITE_CHANGED');
    if (error instanceof PublicSharePhysicalTargetError || error instanceof WorkspaceDocumentCatalogueError) fail('PUBLIC_SHARE_WRITE_CHANGED');
    throw error;
  }
}

export function publicShareWriterFailure(error: unknown): {code:string;status:number;message:string}|null {
  if (error instanceof PublicShareWriterError || error instanceof PublicShareWriterCommitError) return {
    code:error.code,status:error.status,message:error.message,
  };
  if (error instanceof PublicShareToolPolicyError) return {code:error.code,
    status:error.code === 'TOOL_POLICY_DENIED' ? 403 : error.code === 'TOOL_POLICY_CHANGED' ? 409 : 503,
    message:'The current agent public link capability could not be confirmed.'};
  if (error instanceof WorkspaceRequestPrincipalError) return {code:error.code,
    status:error.code === 'PRINCIPAL_AUTH_REVOKED' ? 401 : error.code === 'PRINCIPAL_ACCESS_DENIED' ? 403 : 503,
    message:'The current public link authorization could not be confirmed.'};
  if (error instanceof WorkspaceMutationLockError) return {code:error.code,status:error.status,
    message:'The public link target is temporarily unavailable.'};
  return null;
}
