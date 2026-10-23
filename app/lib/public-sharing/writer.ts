import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
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
import { readPublicShareOnConnection, revokePublicShareOnConnection, updatePublicSharePolicyOnConnection,
  readActivePublicShareAtPathOnConnection, insertPublicShareOnConnection, assignPublicShareShortCodeOnConnection } from './repository';
import { withPreparedPublicShareToolPolicy, PublicShareToolPolicyError } from './tool-policy';
import { withWorkspaceMutationLock, WorkspaceMutationLockError } from '../files/workspace-mutation-lock';
import { withWorkspaceSideEffectWriterFenceOnConnection, withWorkspaceSideEffectWriterMutationOnConnection,
  WorkspaceSideEffectWriterFenceError, type WorkspaceSideEffectWriterTarget } from '../files/workspace-side-effect-writer-fence';
import { readWorkspaceDocumentCatalogue, WorkspaceDocumentCatalogueError } from '../collaboration/workspace-document-catalogue';
import { COLLABORATION_SCHEMA_VERSION } from '../collaboration/types';
import { isInternalWorkspaceStagingPath } from '../files/internal-staging-path';
import { isSensitiveWorkspacePath, getPublicShareMimeType, createToken, createShortCode } from './public-file-shares';
import { isHtmlWorkspacePath, type PublicShareSecurityMode } from './public-share-security';
import { withPreparedPublicSharePhysicalTarget, withPreparedPublicSharePhysicalPublicationTarget,
  PublicSharePhysicalTargetError, type PublicSharePhysicalPublicationMetadata } from './physical-target';
import { readPublicShareNativeTargetOnConnection, PublicShareNativeTargetError } from './native-target';

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

async function assertAdmission(database: SqlConnection, prefix: string, workspaceId: string,
  row: Pick<PublicShareRow,'workspacePath'|'documentId'>): Promise<void> {
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
async function readCurrentPublicWorkspace(database: SqlConnection, prefix: string, authority: Authority): Promise<WorkspaceContext> {
  await authority.assertCurrent();
  const user = await database.get(`SELECT id,email,role FROM ${prefix}."user" WHERE id=$1`,[authority.userId]) as
    {id:string;email:string|null;role:string|null}|undefined;
  if (!user || user.id !== authority.userId) fail('PUBLIC_SHARE_WRITE_DENIED');
  const workspace = await readPostgresWorkspaceForActorOnConnection(database,
    resolveWorkspaceActor({id:user.id,email:user.email,role:user.role}),authority.workspace.workspaceId);
  if (!workspace || ['workspaceId','workspaceType','organizationId','customerId','projectId','ownerUserId','rootPath',
    'rootRelativePath','legacy','status'].some(key => (Reflect.get(workspace,key) ?? null) !== (Reflect.get(authority.workspace,key) ?? null))
    || !workspace.permissions.canRead) fail('PUBLIC_SHARE_WRITE_DENIED');
  await authority.assertCurrent();
  return workspace;
}
async function assertPublicCapabilityCurrent(database: SqlConnection, prefix: string, row: PublicShareRow,
  authority: Authority, policy = false): Promise<void> {
  const workspace = await readCurrentPublicWorkspace(database,prefix,authority);
  if ((policy || authority.source === 'agent') && !workspace.permissions.canCreatePublicLinks
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

export type PublicSharePublication = Readonly<{
  paths: readonly string[]; workspaceId?: string; expiresAt?: Date | null; defaultExpiresAt?: Date | null;
  securityMode?: PublicShareSecurityMode; reason?: string | null; confirmPublicExposure?: boolean;
}>;
type Publication = Readonly<{
  paths: readonly string[]; workspaceId?: string; changes: PolicyChanges; defaultExpiresAtMs?: number | null;
  confirmPublicExposure: boolean;
}>;
type PublicationAuthority = Authority & Readonly<{ createdByAgentId: string | null; sourceSessionId: string | null }>;
type PublicationOptions = { workspaceId?: string; origin?: WorkspaceRequestHistoricalOrigin;
  observeOrigin?: (origin: WorkspaceRequestHistoricalOrigin) => void; prepared?: () => void };
type PublicationRunner = <T>(options: PublicationOptions,
  execute: (database: SqlConnection, authority: PublicationAuthority) => Promise<T>) => Promise<T>;
type PublicationTarget = Readonly<{ workspace: WorkspaceContext; userId: string; path: string;
  native: WorkspaceSideEffectWriterTarget | null }>;
type PublishedShare = Readonly<{ row: PublicShareRow; workspace: WorkspaceContext }>;
type PublicationResult = { shares: PublishedShare[]; skipped: Array<{ path: string; reason: string }> };

function capturePublication(input: PublicSharePublication): Publication {
  const keys = ['paths','workspaceId','expiresAt','defaultExpiresAt','securityMode','reason','confirmPublicExposure'];
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key)
      || !Object.getOwnPropertyDescriptor(input,key)?.enumerable
      || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(input,key),'value'))
    || !Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 100
    || Object.getPrototypeOf(input.paths) !== Array.prototype || Reflect.ownKeys(input.paths).length !== input.paths.length + 1
    || Array.from({length:input.paths.length},(_,index) => Object.getOwnPropertyDescriptor(input.paths,String(index)))
      .some(descriptor => !descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor,'value'))
    || input.paths.some(value => typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value))
    || input.workspaceId !== undefined && !validId(input.workspaceId)
    || input.securityMode !== undefined && input.securityMode !== 'strict' && input.securityMode !== 'interactive'
    || input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string'
    || input.confirmPublicExposure !== undefined && typeof input.confirmPublicExposure !== 'boolean') fail('PUBLIC_SHARE_WRITE_INVALID');
  const expiry = (value: Date | null | undefined): number | null | undefined => {
    if (value === undefined || value === null) return value;
    let result: number; try { result = Date.prototype.getTime.call(value); } catch { return fail('PUBLIC_SHARE_WRITE_INVALID'); }
    if (!Number.isSafeInteger(result) || result <= Date.now()) fail('PUBLIC_SHARE_WRITE_INVALID');
    return result;
  };
  const expiresAtMs = expiry(input.expiresAt), defaultExpiresAtMs = expiry(input.defaultExpiresAt);
  return Object.freeze({ paths:Object.freeze([...new Set(input.paths)]),
    ...(input.workspaceId === undefined ? {} : {workspaceId:input.workspaceId}),
    changes:Object.freeze({...(expiresAtMs === undefined ? {} : {expiresAtMs}),
      ...(input.securityMode === undefined ? {} : {securityMode:input.securityMode}),
      ...(input.reason === undefined ? {} : {reason:input.reason?.trim().slice(0,500) || null})}),
    ...(defaultExpiresAtMs === undefined ? {} : {defaultExpiresAtMs}),confirmPublicExposure:input.confirmPublicExposure === true });
}

/** Sharing preserves exact names. The documented Agent alias is mapped only
 * after the genuine workspace is known; the global path normalizer is untouched. */
function publicationPath(value: string, authority: PublicationAuthority): string {
  let selected = value;
  if (authority.source === 'agent' && selected.startsWith('/data/workspace/')) selected = selected.slice('/data/workspace/'.length);
  else if (path.isAbsolute(selected)) {
    if (path.resolve(selected) !== selected) fail('PUBLIC_SHARE_WRITE_INVALID');
    selected = path.relative(authority.workspace.rootPath,selected).split(path.sep).join('/');
  }
  if (!isCanonicalAdmissionPath(selected) || isInternalWorkspaceStagingPath(selected)
    || isSensitiveWorkspacePath(selected)) fail('PUBLIC_SHARE_WRITE_INVALID');
  return selected;
}

async function assertPublicationCapability(database: SqlConnection, prefix: string, authority: PublicationAuthority): Promise<void> {
  const workspace = await readCurrentPublicWorkspace(database,prefix,authority);
  if (!workspace.permissions.canCreatePublicLinks) fail('PUBLIC_SHARE_WRITE_DENIED');
  await authority.assertCurrent();
}

async function selectPublicationTarget(database: SqlConnection, authority: PublicationAuthority, requested: string): Promise<PublicationTarget> {
  const relations = await bindRelations(database,authority.assertCurrent,policyTargetRelations);
  await assertPublicationCapability(database,relations.prefix,authority);
  const selected = publicationPath(requested,authority), workspace = authority.workspace;
  const documents = await readWorkspaceDocumentCatalogue(database,workspace,{paths:[selected],maxEntries:2});
  if (documents.some(document => document.path !== selected || document.authority === 'missing-state')) fail('PUBLIC_SHARE_WRITE_CHANGED');
  const document = documents.find(entry => entry.authority === 'initialized');
  let native: WorkspaceSideEffectWriterTarget | null = null;
  if (document) {
    const state = await database.get(`SELECT representation,schema_version FROM ${relations.prefix}.collaboration_yjs_states WHERE document_id=$1`,
      [document.id]) as {representation:WorkspaceSideEffectWriterTarget['representation'];schema_version:number|string}|undefined;
    if (!state || !document.lineage_id || !document.lifecycle_generation
      || !['plain_text','tiptap_xml','tiptap_blocks'].includes(state.representation)
      || Number(state.schema_version) !== COLLABORATION_SCHEMA_VERSION) fail('PUBLIC_SHARE_WRITE_CHANGED');
    native = Object.freeze({kind:'native_file',workspaceId:workspace.workspaceId,organizationId:workspace.organizationId ?? null,
      documentId:document.id,lineageId:document.lineage_id,path:selected,lifecycleGeneration:document.lifecycle_generation,
      representation:state.representation,schemaVersion:Number(state.schema_version)});
  }
  await relations.assertCurrent(); await assertPublicationCapability(database,relations.prefix,authority);
  return Object.freeze({workspace,userId:authority.userId,path:selected,native});
}

/** The real uniqueness constraints remain held by the relation DDL lock. No
 * random-candidate retry is safe after dropping their actual enforcement. */
async function publicationConstraints(database: SqlConnection, table: string): Promise<readonly string[]> {
  const rows = await database.all(`SELECT i.indnkeyatts,i.indisunique,i.indisvalid,i.indisready,i.indimmediate,
    c.relname,pg_get_expr(i.indpred,i.indrelid) AS predicate,
    pg_get_indexdef(i.indexrelid,1,true) AS first_key,pg_get_indexdef(i.indexrelid,2,true) AS second_key
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=to_regclass($1)`,[table]) as
    Array<{indnkeyatts:number;indisunique:boolean;indisvalid:boolean;indisready:boolean;indimmediate:boolean;
      relname:string;predicate:string|null;first_key:string;second_key:string|null}>;
  const valid = rows.filter(row => row.indisunique && row.indisvalid && row.indisready && row.indimmediate);
  const ordinary = (key: string) => valid.filter(row => Number(row.indnkeyatts) === 1 && row.predicate === null && row.first_key === key);
  const activePath = valid.some(row => Number(row.indnkeyatts) === 2
    && row.first_key === "COALESCE(workspace_id, 'legacy-personal-workspace'::text)"
    && row.second_key === 'workspace_path' && row.predicate === "(status = 'active'::text)");
  if (!activePath || ['id','token','token_hash','short_code'].some(key => !ordinary(key).length)) fail('PUBLIC_SHARE_WRITE_CHANGED');
  return Object.freeze(ordinary('short_code').map(row => row.relname));
}

function publicationRowScope(row: PublicShareRow, workspace: WorkspaceContext): boolean {
  return row.workspaceId === workspace.workspaceId && row.workspaceType === workspace.workspaceType
    && row.organizationId === (workspace.organizationId ?? null) && row.workspaceRootRelativePath === workspace.rootRelativePath
    && (row.customerId === null || row.customerId === (workspace.customerId ?? null))
    && (row.projectId === null || row.projectId === (workspace.projectId ?? null));
}

async function publicationTransaction<T>(execute: (database: SqlConnection) => Promise<T>, prepared?: () => void): Promise<T> {
  let completed = false;
  try { return await executeLifecycleTransaction({openConnection:openDb,execute:async database => {
    await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE');
    const result = await execute(database); completed = true; prepared?.(); return result;
  },recoverCommitted:async () => { throw new PublicShareWriterCommitError(); }}); }
  catch (error) { if (completed) throw new PublicShareWriterCommitError(); throw error; }
}

async function publishOnConnection(database: SqlConnection, authority: PublicationAuthority, initial: PublicationTarget,
  selected: Publication, physical?: {metadata:PublicSharePhysicalPublicationMetadata;assertCurrent:() => Promise<void>}): Promise<PublishedShare> {
  const workspace = authority.workspace;
  if (authority.userId !== initial.userId || ['workspaceId','workspaceType','organizationId','customerId','projectId',
    'ownerUserId','rootPath','rootRelativePath','legacy','status'].some(key =>
    (Reflect.get(workspace,key) ?? null) !== (Reflect.get(initial.workspace,key) ?? null))) fail('PUBLIC_SHARE_WRITE_CHANGED');
  if (getWorkspaceFileLifecycleLeases()?.has(workspace.workspaceId)) fail('PUBLIC_SHARE_WRITE_REENTRANT');
  const relations = await bindRelations(database,authority.assertCurrent,policyTargetRelations);
  const shortCodeConstraints = await publicationConstraints(database,relations.table);
  const target = initial.native, pathSelector = {table:relations.table,workspaceId:workspace.workspaceId,path:initial.path};
  const current = async (assertNative?: () => Promise<void>) => {
    await relations.assertCurrent(); await assertPublicationCapability(database,relations.prefix,authority);
    await assertAdmission(database,relations.prefix,workspace.workspaceId,{workspacePath:initial.path,documentId:target?.documentId ?? null});
    if (target) { if (!assertNative) fail('PUBLIC_SHARE_WRITE_CHANGED'); await assertNative(); }
    else {
      if (!physical) fail('PUBLIC_SHARE_WRITE_CHANGED');
      const documents = await readWorkspaceDocumentCatalogue(database,workspace,{paths:[initial.path],maxEntries:2});
      if (documents.some(document => document.path !== initial.path || document.authority !== 'pristine')) fail('PUBLIC_SHARE_WRITE_CHANGED');
      await physical.assertCurrent();
    }
    if (selected.changes.expiresAtMs != null && selected.changes.expiresAtMs <= Date.now()) fail('PUBLIC_SHARE_WRITE_INVALID');
  };
  const write = async (assertNative?: () => Promise<void>): Promise<PublishedShare> => {
    await current(assertNative); await lockFileCollaborationPaths(database,workspace.workspaceId,[initial.path]);
    let row = await readActivePublicShareAtPathOnConnection(database,{...pathSelector,forUpdate:true});
    const native = target ? await readPublicShareNativeTargetOnConnection(database,{workspace,target,prefix:relations.prefix}) : null;
    const metadata = native && target ? {workspacePath:initial.path,fileName:path.posix.basename(initial.path),
      fileIdentity:`native:${createHash('sha256').update(JSON.stringify([target.documentId,target.lineageId,target.lifecycleGeneration])).digest('hex')}`,
      lastKnownRevision:`native:${target.lifecycleGeneration}:${native.snapshot.version.documentSequence}:${native.snapshot.version.stateProof}`,
      sizeBytes:native.stateByteLength} : physical!.metadata;
    if (selected.changes.securityMode === 'interactive' && (target || !isHtmlWorkspacePath(initial.path))) fail('PUBLIC_SHARE_WRITE_INVALID');
    if (row) {
      if (!publicationRowScope(row,workspace)) fail('PUBLIC_SHARE_WRITE_CHANGED');
      await assertPublicCapabilityCurrent(database,relations.prefix,row,authority,true);
      await assertAdmission(database,relations.prefix,workspace.workspaceId,row);
      const compatible = target ? row.documentId === target.documentId && row.lineageId === target.lineageId
        && row.lifecycleGeneration === target.lifecycleGeneration
        : row.documentId === null && row.lineageId === null && row.lifecycleGeneration === null
          && (row.fileIdentity === metadata.fileIdentity || row.fileIdentity === metadata.fileIdentity.split(':').slice(0,2).join(':'));
      if (compatible && (row.expiresAt === null || row.expiresAt.getTime() > Date.now())) {
        const mode = selected.changes.securityMode ?? row.securityMode;
        if (mode !== 'strict' && mode !== 'interactive') fail('PUBLIC_SHARE_WRITE_CHANGED');
        if (mode === 'interactive' && (target || !isHtmlWorkspacePath(initial.path))) fail('PUBLIC_SHARE_WRITE_INVALID');
        if (policyChanged(row,selected.changes)) {
          const before = row, now = Date.now();
          row = await updatePublicSharePolicyOnConnection(database,{table:relations.table,expected:before,nowMs:now,changes:selected.changes});
          const expected = {...before,policyRevision:before.policyRevision+1,updatedAt:new Date(now),
            ...(selected.changes.expiresAtMs === undefined ? {} : {expiresAt:selected.changes.expiresAtMs === null ? null : new Date(selected.changes.expiresAtMs)}),
            ...(selected.changes.securityMode === undefined ? {} : {securityMode:selected.changes.securityMode}),
            ...(selected.changes.reason === undefined ? {} : {reason:selected.changes.reason})};
          if (!row || !sameRow(expected,row)) fail('PUBLIC_SHARE_WRITE_CHANGED');
        }
        if (row.shortCode === null) {
          let assigned = false;
          for (let attempt = 0; attempt < 20; attempt++) {
            await current(assertNative); await assertPublicCapabilityCurrent(database,relations.prefix,row,authority,true);
            if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) fail('PUBLIC_SHARE_WRITE_CHANGED');
            const result = await assignPublicShareShortCodeOnConnection(database,{table:relations.table,expected:row,
              shortCode:createShortCode(),shortCodeConstraints});
            if (result.kind === 'changed') fail('PUBLIC_SHARE_WRITE_CHANGED');
            if (result.kind === 'assigned') {
              if (!sameRow({...row,shortCode:result.row.shortCode},result.row) || !result.row.shortCode) fail('PUBLIC_SHARE_WRITE_CHANGED');
              row = result.row; assigned = true; break;
            }
          }
          if (!assigned) fail('PUBLIC_SHARE_WRITE_BUSY');
        }
      } else {
        const before = row, now = Date.now(), reason = row.expiresAt !== null && row.expiresAt.getTime() <= now
          ? 'republished_expired' as const : 'republished_stale' as const;
        const revoked = await revokePublicShareOnConnection(database,{table:relations.table,expected:before,nowMs:now,reason});
        const expected = {...before,status:'revoked',policyRevision:before.policyRevision+1,revokedAt:new Date(now),revokedReason:reason,updatedAt:new Date(now)};
        if (!revoked || !sameRow(expected,revoked)) fail('PUBLIC_SHARE_WRITE_CHANGED');
        const stored = await readPublicShareOnConnection(database,{table:relations.table,workspaceId:workspace.workspaceId,id:before.id});
        if (!stored || !sameRow(expected,stored)) fail('PUBLIC_SHARE_WRITE_CHANGED');
        await assertPublicCapabilityCurrent(database,relations.prefix,stored,authority,true);
        await current(assertNative); row = null;
      }
    }
    if (!row) {
      const expiresAtMs = selected.changes.expiresAtMs !== undefined ? selected.changes.expiresAtMs : selected.defaultExpiresAtMs ?? null;
      if (expiresAtMs !== null && expiresAtMs <= Date.now()) fail('PUBLIC_SHARE_WRITE_INVALID');
      for (let attempt = 0; attempt < 20; attempt++) {
        await current(assertNative);
        if (expiresAtMs !== null && expiresAtMs <= Date.now()) fail('PUBLIC_SHARE_WRITE_INVALID');
        const now = new Date(), token = createToken();
        const candidate: PublicShareRow = {id:randomUUID(),token,tokenHash:createHash('sha256').update(token).digest('hex'),
          tokenPreview:token.slice(0,8),shortCode:createShortCode(),organizationId:workspace.organizationId ?? null,
          customerId:workspace.customerId ?? null,projectId:workspace.projectId ?? null,workspaceId:workspace.workspaceId,
          workspaceType:workspace.workspaceType,workspaceRootRelativePath:workspace.rootRelativePath ?? null,
          documentId:target?.documentId ?? null,lineageId:target?.lineageId ?? null,
          lifecycleGeneration:target?.lifecycleGeneration ?? null,...metadata,mimeType:getPublicShareMimeType(initial.path),
          targetRevisionPolicy:'latest',status:'active',createdByUserId:authority.userId,
          createdByAgentId:authority.createdByAgentId,sourceSessionId:authority.sourceSessionId,source:authority.source,
          securityMode:selected.changes.securityMode ?? 'strict',reason:selected.changes.reason ?? null,
          createdAt:now,updatedAt:now,expiresAt:expiresAtMs === null ? null : new Date(expiresAtMs),revokedAt:null,
          revokedReason:null,passwordEnabled:0,passwordHash:null,lastAccessedAt:null,accessCount:0,policyRevision:1};
        row = await insertPublicShareOnConnection(database,{table:relations.table,row:candidate});
        if (row) { if (!sameRow(candidate,row)) fail('PUBLIC_SHARE_WRITE_CHANGED'); break; }
        // The workspace/path lock serializes cooperating writers. An older
        // winner requires a fresh explicit request; it cannot be silently adopted.
        if (await readActivePublicShareAtPathOnConnection(database,{...pathSelector,forUpdate:true})) fail('PUBLIC_SHARE_WRITE_CHANGED');
      }
      if (!row) fail('PUBLIC_SHARE_WRITE_BUSY');
    }
    const stored = await readPublicShareOnConnection(database,{table:relations.table,workspaceId:workspace.workspaceId,id:row.id});
    const active = await readActivePublicShareAtPathOnConnection(database,pathSelector);
    if (!stored || !active || !sameRow(row,stored) || !sameRow(row,active)) fail('PUBLIC_SHARE_WRITE_CHANGED');
    await assertPublicCapabilityCurrent(database,relations.prefix,stored,authority,true); await current(assertNative);
    if (stored.status !== 'active' || stored.expiresAt !== null && stored.expiresAt.getTime() <= Date.now()) fail('PUBLIC_SHARE_WRITE_CHANGED');
    return {row:stored,workspace};
  };
  if (target) return withWorkspaceSideEffectWriterFenceOnConnection(database,{workspace,targets:[target]},() =>
    withWorkspaceSideEffectWriterMutationOnConnection(database,target,assertNative => write(assertNative)));
  const lock = await database.get('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS locked',
    [collaborationAdmissionLockKey(workspace.workspaceId)]) as {locked?:boolean}|undefined;
  if (lock?.locked !== true) fail('PUBLIC_SHARE_WRITE_BUSY');
  return write();
}

async function publicationBatch(selected: Publication, run: PublicationRunner): Promise<PublicationResult> {
  const shares: PublishedShare[] = [], skipped: PublicationResult['skipped'] = [];
  for (const requested of selected.paths) {
    let prepared = false, origin: WorkspaceRequestHistoricalOrigin | undefined;
    try {
      const initial = await run({workspaceId:selected.workspaceId,observeOrigin:value => { origin = value; }},
        (database,authority) => selectPublicationTarget(database,authority,requested));
      const published = await withWorkspaceMutationLock(initial.workspace.workspaceId,async () => {
        const execute = (physical?: {metadata:PublicSharePhysicalPublicationMetadata;assertCurrent:() => Promise<void>}) =>
          run({workspaceId:initial.workspace.workspaceId,origin,prepared:() => { prepared = true; }},
            (database,authority) => publishOnConnection(database,authority,initial,selected,physical));
        return initial.native ? execute() : withPreparedPublicSharePhysicalPublicationTarget(initial.workspace,initial.path,execute);
      });
      shares.push(published);
    } catch (error) {
      if (prepared) throw new PublicShareWriterCommitError();
      if (error instanceof PublicShareWriterError && ['PUBLIC_SHARE_WRITE_INVALID','PUBLIC_SHARE_WRITE_CHANGED','PUBLIC_SHARE_WRITE_BUSY'].includes(error.code)
        || error instanceof PublicSharePhysicalTargetError || error instanceof PublicShareNativeTargetError
        || error instanceof WorkspaceDocumentCatalogueError || error instanceof WorkspaceSideEffectWriterFenceError) {
        skipped.push({path:requested,reason:error instanceof Error ? error.message : 'Public share target changed.'});
      } else throw error; // Auth, SQL, factory and unconfirmed finality are fatal.
    }
  }
  return {shares,skipped};
}

export function createPublicSharesForRequest(request: NextRequest, input: PublicSharePublication): Promise<PublicationResult> {
  if (!(request instanceof NextRequest)) return Promise.reject(new PublicShareWriterError('PUBLIC_SHARE_WRITE_INVALID'));
  const selected = capturePublication(input), original = new NextRequest(request.url,{method:request.method,headers:new Headers(request.headers)});
  const run: PublicationRunner = (options,execute) => withWorkspaceRequestPrincipalOriginalOrigin(original,
    {permission:'canRead',workspaceId:options.workspaceId},observed => {
      if (options.origin && Object.keys(options.origin).some(key => Reflect.get(observed,key) !== Reflect.get(options.origin!,key))) fail('PUBLIC_SHARE_WRITE_CHANGED');
      options.observeOrigin?.(observed);
    },principal => publicationTransaction(database => withWorkspaceRequestPrincipalOnConnection(database,principal,
      access => execute(database,{...access,source:'ui',createdByAgentId:null,sourceSessionId:null})),options.prepared));
  return publicationBatch(selected,run);
}

export async function createPublicSharesForAgent(input: PublicSharePublication): Promise<PublicationResult> {
  const selected = capturePublication(input);
  const invocation = assertCurrentAgentToolInvocation(captureCurrentAgentToolInvocation());
  if (invocation.toolName !== 'public_share_file' || !selected.confirmPublicExposure || !selected.changes.reason
    || selected.changes.securityMode === 'interactive') return Promise.reject(new PublicShareWriterError('PUBLIC_SHARE_WRITE_DENIED'));
  let prepared = false;
  try { return await withPreparedPublicShareToolPolicy(policy => {
    const run: PublicationRunner = (options,execute) => withWorkspaceAgentToolPrincipal({permission:'canRead',workspaceId:options.workspaceId},
      principal => publicationTransaction(database => withWorkspaceAgentToolPrincipalOnConnection(database,principal,async access => {
        const assertCurrent = () => policy.assertCurrent(database,access);
        await assertCurrent();
        return execute(database,{workspace:access.workspace,userId:access.userId,source:'agent',assertCurrent,
          createdByAgentId:access.agentId,sourceSessionId:access.piSessionId});
      }),options.prepared ? () => { prepared = true; options.prepared!(); } : undefined));
    return publicationBatch(selected,run);
  }); } catch (error) { if (prepared) throw new PublicShareWriterCommitError(); throw error; }
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
  if (error instanceof PublicShareNativeTargetError) return {code:error.code,status:error.status,
    message:'The native public link target is unavailable.'};
  return null;
}
