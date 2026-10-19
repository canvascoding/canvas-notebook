import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { isDeepStrictEqual as equal, types } from 'node:util';
import { NextRequest } from 'next/server';
import { openDb, type SqlConnection } from '../db';
import { withNativeInspectionSchema } from '../collaboration/native-inspection-schema';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { getWorkspaceFileLifecycleLeases, withWorkspaceFileLifecycleLeases,
  type WorkspaceFileLifecycleLease } from '../collaboration/file-lifecycle-admission-context';
import { withWorkspaceCopyRequestOnConnection, withWorkspaceCopyAgentOnConnection, withWorkspaceCopyMcpOnConnection,
  type WorkspaceCopyPrincipalAccess } from '../workspaces/copy-principal';
import { assertDirectMcpWorkspaceCopyPrincipalCaptured,
  type DirectMcpWorkspaceCopyPrincipal } from '../mcp/server/document-read-principal';
import { readWorkspaceCopySourceObservationOnConnection } from './workspace-operation-copy-source-observation';
import { readWorkspaceSceneCatalogue } from '../collaboration/workspace-scene-catalogue';
import type { WorkspaceOperationNativeCopyPlan, WorkspaceOperationNativeCopySelection } from './workspace-operation-native-copy-plan';
import { createWorkspaceOperationManagedCopyPlan } from './workspace-operation-managed-copy-plan';
import { createWorkspaceOperationManagedCopyPlanV4, type WorkspaceOperationAnyManagedCopyPlan } from './workspace-operation-managed-copy-plan-v4';
import { createWorkspaceOperationManagedCopyPlanV5, type WorkspaceOperationManagedCopyPlanV5 } from './workspace-operation-managed-copy-plan-v5';
import { readExcalidrawAssetsOnConnection } from '../excalidraw-collaboration/readonly-assets';
import { serializePortableExcalidrawSceneFromReadonlyAssets } from '../excalidraw-collaboration/portable-serialization';
import { readOriginalExcalidrawCopyOnConnection, readExcalidrawCopyReceiptStorageIdentityOnConnection } from '../excalidraw-collaboration/copy-domain';
import { withPreparedExcalidrawCopyAssets, withRecoveredExcalidrawCopyAssets, readPreparedExcalidrawCopyAssets,
  assertPreparedExcalidrawCopyAssetsCurrent, publishPreparedExcalidrawCopyAssets, retireExcalidrawCopyAssetOriginal,
  type PreparedExcalidrawCopyAssets } from '../excalidraw-collaboration/copy-asset-publication';
import { ExcalidrawCopyError, type ExcalidrawCopyAssetOriginal, type ExcalidrawCopyBirthReceipt } from '../excalidraw-collaboration/copy-contract';
import { decodeWorkspaceOperationCopyOrigin, assertWorkspaceOperationCopyOriginCurrent,
  type WorkspaceOperationCopyOrigin } from './workspace-operation-copy-origin';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';
import type { WorkspaceContext } from '../workspaces/types';
import type { WorkspaceOperationOwnedCopyStage, WorkspaceOperationManagedCopyPhysical, WorkspaceOperationAnyManagedCopyStage } from './workspace-operation-managed-copy-stage';
import { withRecoveredWorkspacePathCopy, withPreparedWorkspacePathCopy, readPreparedWorkspacePathCopy,
  publishPreparedWorkspacePathCopy, discardPreparedWorkspacePathCopy, assertPreparedWorkspacePathCopyCurrent,
  assertPreparedWorkspacePathCopyReceiptCurrent, preparedWorkspacePathCopyProof,
  type PreparedWorkspacePathCopyParentReceipt,
  type PreparedWorkspacePathCopySharedParent } from '../filesystem/prepared-workspace-path-copy';
import { WorkspaceOperationStaging } from './workspace-operation-staging';
import { serializeWorkspaceOperationRequest, prepareWorkspaceOperationOnConnection,
  failWorkspaceOperationOnConnection,
  type WorkspaceOperationRecord, type WorkspaceOperationWithSteps, type WorkspaceOperationRequest } from './workspace-operation-journal';
import { prepareNativeCopyPhaseOnConnection, recordNativeCopyParentOnConnection,
  recordNativeCopyPathOnConnection, completeNativeCopyPhaseOnConnection,
  type NativeCopyPhasePathReceipt } from './workspace-operation-native-copy-phase';
import { nativeCopyPhaseStepCount, nativeCopyPhasePathSteps, nativeCopyPhaseParentSteps,
  assertNativeCopyPhaseParent, withCapturedNativeCopyPhaseStage } from './workspace-operation-native-copy-phase-contract';
import { readNativeCopyPhaseJournalOnConnection, readCompletedNativeCopyHistoryOnConnection } from './workspace-operation-native-copy-phase-read';
import { readNativeCopyReceiptStorageIdentityOnConnection } from '../collaboration/native-copy-historical-receipt';
import type { WorkspaceOperationExecutionResult } from './workspace-file-operation-executor';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { captureNativeCopyMetadataSnapshotOnConnection } from './workspace-operation-native-copy-metadata';
import { assertNativeCopyRequestBudget } from './workspace-operation-native-copy-request-budget';
import type { NativeCopyViewOutcome } from './workspace-operation-copy-view-finalizer';

export class NativeCopyOwnerError extends Error {
  readonly status: number;
  constructor(readonly code: 'NATIVE_COPY_OWNER_REQUIRED' | 'NATIVE_COPY_OWNER_CHANGED' | 'NATIVE_COPY_INVALID_REQUEST'
    | 'NATIVE_COPY_COMMIT_UNCONFIRMED' | 'NATIVE_COPY_LIFECYCLE_BUSY' | 'NATIVE_COPY_PLAN_CHANGED', options?: ErrorOptions) {
    super(code, options); this.name = 'NativeCopyOwnerError';
    this.status = code === 'NATIVE_COPY_COMMIT_UNCONFIRMED' ? 503 : 409;
  }
}
export class NativeCopyOperationNotFoundError extends Error {
  readonly code = 'NATIVE_COPY_OPERATION_NOT_FOUND';
  readonly status = 404;
  constructor() {
    super('NATIVE_COPY_OPERATION_NOT_FOUND'); this.name = 'NativeCopyOperationNotFoundError';
  }
}
export class NativeCopyDestinationError extends Error {
  readonly status: number;
  constructor(readonly code: 'DESTINATION_NOT_FOUND' | 'DESTINATION_NOT_DIRECTORY') {
    super(code); this.name = 'NativeCopyDestinationError'; this.status = code === 'DESTINATION_NOT_FOUND' ? 404 : 409;
  }
}
type Invocation = Readonly<{ origin: WorkspaceOperationCopyOrigin; request?: NextRequest;
  mcpPrincipal?: DirectMcpWorkspaceCopyPrincipal }>;
type Identity = Readonly<{ backend: string; start: string; database: string; schema: string; searchPath: string }>;
type Owner = {
  database: SqlConnection; invocation: Invocation; workspaceIds: readonly string[]; lockKeys: readonly string[];
  leases: ReadonlyMap<string, WorkspaceFileLifecycleLease>; identity?: Identity;
  active: boolean; phase: 'idle' | 'write' | 'history'; failure?: Error;
  workspaces?: Readonly<{ source: WorkspaceContext; destination: WorkspaceContext }>;
  stage?: WorkspaceOperationOwnedCopyStage;
  assetPublication?: Readonly<{ stageDigest: string; originalProof: string }>;
};
const context = new AsyncLocalStorage<Owner>();
const ownedConnections = new WeakMap<SqlConnection, Owner>();
const assetRetirement = new AsyncLocalStorage<{ owner: Owner; original: ExcalidrawCopyAssetOriginal; birth: ExcalidrawCopyBirthReceipt; active: boolean }>();
function problem(code: NativeCopyOwnerError['code'] = 'NATIVE_COPY_OWNER_CHANGED'): never { throw new NativeCopyOwnerError(code); }
function captureInvocation(input: Invocation): Invocation {
  if (!input || typeof input !== 'object' || types.isProxy(input)) problem('NATIVE_COPY_INVALID_REQUEST');
  const principal = Object.getOwnPropertyDescriptor(input, 'mcpPrincipal');
  if (principal && (!principal.enumerable || !Object.hasOwn(principal, 'value'))) problem('NATIVE_COPY_INVALID_REQUEST');
  const origin = decodeWorkspaceOperationCopyOrigin(input.origin);
  if (origin.version === 2) {
    if (input.request !== undefined || !principal || principal.value === undefined) problem('NATIVE_COPY_INVALID_REQUEST');
    // A live private capture is required before borrowing B. This is no SQL
    // grant; each owner/Copy phase still enters the actual current MCP checks.
    const mcpPrincipal: DirectMcpWorkspaceCopyPrincipal = principal.value;
    assertDirectMcpWorkspaceCopyPrincipalCaptured(mcpPrincipal,
      { sourceWorkspaceId: origin.sourceScope.workspaceId, destinationWorkspaceId: origin.destinationScope.workspaceId });
    return Object.freeze({ origin, mcpPrincipal });
  }
  if (principal) problem('NATIVE_COPY_INVALID_REQUEST');
  // Normalize real framework requests across compiled NextRequest constructors;
  // current authentication still runs on the local copy in every owner phase.
  if (origin.actor.type === 'user' ? !(input.request instanceof Request) : input.request !== undefined) problem('NATIVE_COPY_INVALID_REQUEST');
  return Object.freeze({ origin, ...(input.request ? { request: new NextRequest(input.request.url,
    { method: input.request.method, headers: new Headers(input.request.headers) }) } : {}) });
}
function current(owner: Owner): void {
  if (owner.failure) throw owner.failure;
  if (!owner.active || context.getStore() !== owner || ownedConnections.get(owner.database) !== owner) problem('NATIVE_COPY_OWNER_REQUIRED');
  const leases = getWorkspaceFileLifecycleLeases();
  for (const id of owner.workspaceIds) if (!owner.leases.get(id)?.active || leases?.get(id) !== owner.leases.get(id)) problem();
}
async function identity(database: SqlConnection): Promise<Identity> {
  const row = await database.get(`SELECT pg_catalog.pg_backend_pid()::text AS backend,
    extract(epoch FROM a.backend_start)::text AS start,
    a.datid::text AS database, pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::text AS schema,
    pg_catalog.current_setting('search_path') AS search_path
    FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`) as Record<string, unknown> | undefined;
  if (!row || ![row.backend, row.database, row.schema].every(value => typeof value === 'string' && /^[1-9][0-9]*$/u.test(value))
    || typeof row.start !== 'string' || !/^[0-9]+\.[0-9]+$/u.test(row.start) || typeof row.search_path !== 'string') problem();
  return Object.freeze({ backend: row.backend as string, start: row.start, database: row.database as string,
    schema: row.schema as string, searchPath: row.search_path });
}
async function verify(owner: Owner): Promise<void> {
  current(owner);
  try {
    const observed = await identity(owner.database); current(owner);
    if (!owner.identity || !equal(observed, owner.identity)) problem();
    const rows = await owner.database.all(`SELECT (classid::bigint::numeric*4294967296+objid::bigint::numeric)::text AS key
      FROM pg_catalog.pg_locks WHERE locktype='advisory' AND granted AND mode='ExclusiveLock' AND objsubid=1
        AND pid=pg_catalog.pg_backend_pid() AND database=$1::oid
        AND (classid::bigint::numeric*4294967296+objid::bigint::numeric)=ANY($2::numeric[])`,
    [observed.database, owner.lockKeys]) as Array<{ key: string }>;
    current(owner);
    const held = new Set(rows.map(row => row.key));
    if (held.size !== owner.lockKeys.length || owner.lockKeys.some(key => !held.has(key))) problem();
  } catch (error) {
    owner.failure ??= error instanceof Error ? error : new NativeCopyOwnerError('NATIVE_COPY_OWNER_CHANGED');
    throw owner.failure;
  }
}

/** Read-only assertion for fixed Copy phases. No caller-supplied lease, B,
 * original request or ALS map can construct this private session lifetime. */
export async function assertNativeCopySessionOnConnection(database: SqlConnection,
  supplied: WorkspaceOperationCopyOrigin): Promise<void> {
  const owner = context.getStore();
  if (!owner || owner.database !== database || !equal(owner.invocation.origin, decodeWorkspaceOperationCopyOrigin(supplied))) {
    problem('NATIVE_COPY_OWNER_REQUIRED');
  }
  await verify(owner);
}

/** Fixed phase-only check of the actual retained FD payloads. This is not a
 * caller-mintable proof: only execute sets stage on the private session frame. */
export async function assertNativeCopyPhysicalStageOnConnection(database: SqlConnection,
  stage: WorkspaceOperationOwnedCopyStage): Promise<void> {
  await assertNativeCopySessionOnConnection(database, stage.origin);
  const owner = context.getStore()!;
  if (owner.phase !== 'write' || !owner.workspaces || !owner.stage || owner.stage.payloadSha256 !== stage.payloadSha256
    || !equal(owner.stage.identity, stage.identity) || !equal(owner.stage.physical, stage.physical)) problem();
  for (const physical of stage.physical) {
    await withRecoveredWorkspacePathCopy({ sourceWorkspace: owner.workspaces.source, destinationWorkspace: owner.workspaces.destination,
      original: physical.original }, async cap => { await assertPreparedWorkspacePathCopyCurrent(cap); });
    await verify(owner);
  }
}

async function withSession<T>(supplied: Invocation, operation: (owner: Owner) => Promise<T>): Promise<T> {
  const invocation = captureInvocation(supplied);
  if (context.getStore()) problem('NATIVE_COPY_OWNER_REQUIRED');
  const workspaceIds = [...new Set([invocation.origin.sourceScope.workspaceId, invocation.origin.destinationScope.workspaceId])].sort();
  if (workspaceIds.some(id => getWorkspaceFileLifecycleLeases()?.get(id)?.active)) problem('NATIVE_COPY_OWNER_REQUIRED');
  const signedKeys = workspaceIds.map(collaborationAdmissionLockKey), lockKeys = signedKeys.map(key => BigInt.asUintN(64, BigInt(key)).toString());
  if (new Set(lockKeys).size !== lockKeys.length) problem('NATIVE_COPY_INVALID_REQUEST');
  const enter = (index: number): Promise<T> => index < workspaceIds.length
    ? withWorkspaceMutationLock(workspaceIds[index], () => enter(index + 1)) : opened();
  const opened = async (): Promise<T> => {
    const database = await openDb();
    const leases = new Map<string, WorkspaceFileLifecycleLease>();
    const owner: Owner = { database, invocation, workspaceIds, lockKeys, leases, active: true, phase: 'idle' };
    ownedConnections.set(database, owner);
    let primary: unknown;
    try {
      await database.run("SET statement_timeout='5s'"); await database.run("SET lock_timeout='4s'");
      // Establish the existing import trigger's canonical realm before any
      // Owner/principal/phase witness. Later drift is rejected, never repaired.
      const realm = await database.get(`SELECT pg_catalog.current_schema() AS name,
        pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::text AS oid,
        pg_catalog.quote_ident(pg_catalog.current_schema())||', pg_catalog, pg_temp' AS search_path`) as
        { name?: unknown; oid?: unknown; search_path?: unknown } | undefined;
      if (typeof realm?.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(realm.name) || realm.name.startsWith('pg_')
        || typeof realm.oid !== 'string' || !/^[1-9][0-9]*$/u.test(realm.oid) || typeof realm.search_path !== 'string') problem();
      await database.run("SELECT pg_catalog.set_config('search_path',$1,false)", [realm.search_path]);
      owner.identity = await identity(database);
      if (owner.identity.schema !== realm.oid || owner.identity.searchPath !== realm.search_path) problem();
      for (const [index, workspaceId] of workspaceIds.entries()) {
        // Allow admitted readers to finish within this session's existing
        // per-key lock timeout, before entering any Copy phase.
        let held: { locked?: boolean } | undefined;
        try {
          held = await database.get('SELECT pg_advisory_lock($1::bigint), true AS locked', [signedKeys[index]]) as { locked?: boolean } | undefined;
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') {
            throw new NativeCopyOwnerError('NATIVE_COPY_LIFECYCLE_BUSY', { cause: error });
          }
          throw error;
        }
        if (held?.locked !== true) problem();
        const lease: WorkspaceFileLifecycleLease = { active: true, verify: async () => {
          try { await verify(owner); return true; } catch { return false; }
        } };
        leases.set(workspaceId, lease);
      }
      const inherited = new Map(getWorkspaceFileLifecycleLeases());
      for (const [id, lease] of leases) inherited.set(id, lease);
      return await context.run(owner, () => withWorkspaceFileLifecycleLeases(inherited, async () => {
        await verify(owner); const result = await operation(owner); await verify(owner); return result;
      }));
    } catch (error) { primary = error; throw error; }
    finally {
      owner.active = false; for (const lease of leases.values()) lease.active = false; ownedConnections.delete(database);
      // Discard the actual dedicated checkout, including unknown transaction
      // ends and session locks. It must never re-enter the shared idle pool.
      try { await database.close(new Error('Discarding native Copy owner session.')); }
      catch (error) { throw new AggregateError(primary === undefined ? [error] : [primary, error], 'Native Copy owner session disposal was not confirmed.'); }
    }
  };
  return enter(0);
}
async function transaction<T>(owner: Owner, mode: 'write' | 'history', operation: () => Promise<T>,
  onCommitted?: (result: T) => void): Promise<T> {
  return withNativeInspectionSchema(async () => {
    await verify(owner); if (owner.phase !== 'idle') problem();
    owner.phase = mode;
    let began = false, commitAttempted = false;
    try {
      await owner.database.run(mode === 'write' ? 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'
        : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); began = true;
      await verify(owner); const result = await operation(); await verify(owner);
      commitAttempted = true; await owner.database.run('COMMIT'); began = false; owner.phase = 'idle';
      // Fixed in-process notification capture only, after the actual ACK and
      // before any later session verification or disposal can fail.
      onCommitted?.(result);
      await verify(owner); return result;
    } catch (error) {
      if (commitAttempted) {
        const uncertain = new NativeCopyOwnerError('NATIVE_COPY_COMMIT_UNCONFIRMED', { cause: error });
        owner.failure ??= uncertain; throw uncertain;
      }
      if (began) {
        try { await verify(owner); await owner.database.run('ROLLBACK'); owner.phase = 'idle'; }
        catch (rollback) { owner.failure ??= new NativeCopyOwnerError('NATIVE_COPY_COMMIT_UNCONFIRMED', { cause: rollback }); throw new AggregateError([error, rollback]); }
      }
      throw error;
    }
  });
}
/** Detach original data before BEGIN. Current authority, B/XID and every write
 * remain inside the fixed phase; this pure frame ends with this one TX. */
function copyPhaseTransaction<T>(owner: Owner, stage: WorkspaceOperationOwnedCopyStage,
  operation: (detached: WorkspaceOperationOwnedCopyStage) => Promise<T>, onCommitted?: (result: T) => void): Promise<T> {
  return withCapturedNativeCopyPhaseStage(stage, detached => transaction(owner, 'write', () => operation(detached), onCommitted));
}

async function principal<T>(owner: Owner, operation: (current: WorkspaceCopyPrincipalAccess) => Promise<T>): Promise<T> {
  await verify(owner);
  const use = async (current: WorkspaceCopyPrincipalAccess) => {
    owner.workspaces = Object.freeze({ source: current.sourceWorkspace, destination: current.destinationWorkspace });
    return operation(current);
  };
  const result = owner.invocation.origin.version === 2
    ? await withWorkspaceCopyMcpOnConnection(owner.database, owner.invocation.mcpPrincipal!, owner.invocation.origin, use)
    : owner.invocation.origin.actor.type === 'user'
      ? await withWorkspaceCopyRequestOnConnection(owner.database, owner.invocation.request!, owner.invocation.origin, use)
      : await withWorkspaceCopyAgentOnConnection(owner.database, owner.invocation.origin, use);
  await verify(owner); return result;
}

/** Data-only Stage/Workspace DTOs cannot mint an asset writer. Only the fixed
 * execute continuation sets the original Stage on this actual private owner. */
export function assertNativeCopyManagedAssetOwner(stage: WorkspaceOperationAnyManagedCopyStage): void {
  const owner = context.getStore();
  if (!owner) problem('NATIVE_COPY_OWNER_REQUIRED');
  current(owner);
  if (owner.phase === 'history' || !owner.workspaces || (owner.stage?.version !== 4 && owner.stage?.version !== 5 && owner.stage?.version !== 6)
    || owner.stage.payloadSha256 !== stage.payloadSha256 || !equal(owner.stage.identity, stage.identity)
    || !equal(owner.stage.origin, stage.origin) || !equal(owner.invocation.origin, stage.origin)) problem();
}
/** The original asset proof is bound only after the genuine B1 COMMIT ACK.
 * A cap or a caller-provided historical receipt cannot create that binding. */
export function assertNativeCopyManagedAssetPublication(stage: WorkspaceOperationAnyManagedCopyStage,
  original: ExcalidrawCopyAssetOriginal): void {
  assertNativeCopyManagedAssetOwner(stage);
  const owner = context.getStore()!;
  if (owner.phase !== 'idle' || !owner.assetPublication || owner.assetPublication.stageDigest !== stage.payloadSha256
    || owner.assetPublication.originalProof !== original.originalProof || original.stageDigest !== stage.payloadSha256
    || original.operationId !== stage.identity.operationId || !equal(original.destinationScope, stage.origin.destinationScope)) problem();
}

/** Only the fixed post-ACK or pinned-history owner continuation enters this
 * private lifetime. A serialized receipt alone cannot retire recovery originals. */
export async function assertNativeCopyManagedAssetRetirement(original: ExcalidrawCopyAssetOriginal,
  birth: ExcalidrawCopyBirthReceipt): Promise<void> {
  const frame = assetRetirement.getStore(), owner = context.getStore();
  if (!frame?.active || !owner || frame.owner !== owner || owner.phase !== 'idle'
    || !equal(frame.original, original) || !equal(frame.birth, birth)
    || !equal(original, birth.intent.assetOriginal) || !equal(birth.intent.origin, owner.invocation.origin)) problem();
  await verify(owner);
  await transaction(owner, 'write', () => principal(owner, async () => undefined));
  if (!frame.active || assetRetirement.getStore() !== frame || context.getStore() !== owner) problem();
  await verify(owner);
}
async function retireConfirmedAssets(owner: Owner, birth: ExcalidrawCopyBirthReceipt): Promise<void> {
  const frame = { owner, original: birth.intent.assetOriginal, birth, active: true };
  try { await assetRetirement.run(frame, () => retireExcalidrawCopyAssetOriginal(frame.original, birth)); }
  finally { frame.active = false; }
}

export type NativeCopyPreviewInput = Invocation & Readonly<{
  selections: readonly WorkspaceOperationNativeCopySelection[]; renameOnCollision?: boolean;
  /** HTTP folder selection, checked only for a new original request. */
  destinationDirectory?: string;
}>;
function captureDestinationDirectory(input: NativeCopyPreviewInput): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(input, 'destinationDirectory');
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
    || descriptor.value !== undefined && !isCanonicalAdmissionPath(descriptor.value, true)) problem('NATIVE_COPY_INVALID_REQUEST');
  return descriptor.value as string | undefined;
}
function captureSelections(input: NativeCopyPreviewInput): WorkspaceOperationNativeCopySelection[] {
  if (!Array.isArray(input.selections) || Object.getPrototypeOf(input.selections) !== Array.prototype
    || Reflect.ownKeys(input.selections).length !== input.selections.length + 1 || !input.selections.length || input.selections.length > 1000
    || input.renameOnCollision !== undefined && typeof input.renameOnCollision !== 'boolean') problem('NATIVE_COPY_INVALID_REQUEST');
  return Array.from({ length: input.selections.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input.selections, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) problem('NATIVE_COPY_INVALID_REQUEST');
    const selection = descriptor.value;
    if (!selection || Object.getPrototypeOf(selection) !== Object.prototype || Reflect.ownKeys(selection).length !== 2
      || ['sourcePath', 'destinationPath'].some(key => {
        const property = Object.getOwnPropertyDescriptor(selection, key);
        return !property?.enumerable || !Object.hasOwn(property, 'value');
      })
      || ![selection.sourcePath, selection.destinationPath].every(value => typeof value === 'string' && isCanonicalAdmissionPath(value))) {
      problem('NATIVE_COPY_INVALID_REQUEST');
    }
    return Object.freeze({ sourcePath: selection.sourcePath, destinationPath: selection.destinationPath });
  });
}
async function observe(owner: Owner, selections: readonly WorkspaceOperationNativeCopySelection[], renameOnCollision: boolean,
  destinationDirectory?: string) {
  return principal(owner, async current => {
    const workspaces = current.sourceWorkspace.workspaceId === current.destinationWorkspace.workspaceId
      ? [current.sourceWorkspace] : [current.sourceWorkspace, current.destinationWorkspace];
    const sceneIds = new Set<string>();
    for (const workspace of workspaces) for (const header of await readWorkspaceSceneCatalogue(owner.database, workspace)) sceneIds.add(header.id);
    for (const id of [...sceneIds].sort()) {
      await owner.database.get('SELECT pg_advisory_xact_lock(hashtext($1))', [`excalidraw:${id}`]);
      await owner.database.get('SELECT document_id FROM collaboration_excalidraw_states WHERE document_id=$1 FOR UPDATE', [id]);
    }
    const source = await readWorkspaceCopySourceObservationOnConnection(owner.database, current.sourceWorkspace, { physicalParserVersion: 3 });
    const destination = current.sourceWorkspace.workspaceId === current.destinationWorkspace.workspaceId ? source
      : await readWorkspaceCopySourceObservationOnConnection(owner.database, current.destinationWorkspace, { physicalParserVersion: 3 });
    if (destinationDirectory !== undefined && destinationDirectory !== '') {
      const directory = destination.stage.namespace.find(entry => entry.path === destinationDirectory);
      if (!directory) throw new NativeCopyDestinationError('DESTINATION_NOT_FOUND');
      if (directory.kind !== 'directory') throw new NativeCopyDestinationError('DESTINATION_NOT_DIRECTORY');
    }
    const occupied = new Set(destination.stage.namespace.map(entry => entry.path));
    const resolved = selections.map(selection => {
      let destinationPath = selection.destinationPath;
      if (renameOnCollision) {
        const extension = path.posix.extname(destinationPath), stem = destinationPath.slice(0, -extension.length || undefined);
        let index = 1; while (occupied.has(destinationPath)) destinationPath = `${stem} (${index++})${extension}`;
        occupied.add(destinationPath);
      }
      return { sourcePath: selection.sourcePath, destinationPath };
    });
    const selectedRaw = source.stage.sources.some(entry => entry.kind === 'physical' && resolved.some(selection => {
      if (entry.inventory.path === selection.sourcePath) return true;
      const selected = source.stage.namespace.find(node => node.path === selection.sourcePath);
      return selected?.kind === 'directory' && entry.inventory.path.startsWith(selection.sourcePath + '/');
    }));
    const createPlan = selectedRaw ? createWorkspaceOperationManagedCopyPlanV5
      : [source, destination].some(observation => observation.stage.sources.some(source => source.kind === 'physical'))
        ? createWorkspaceOperationManagedCopyPlanV4 : createWorkspaceOperationManagedCopyPlan;
    const plan = createPlan({ sourceScope: { workspace: current.sourceWorkspace, fileOptions: {} },
      destinationScope: { workspace: current.destinationWorkspace, fileOptions: {} }, selections: resolved,
      sourceObservation: source, destinationObservation: destination });
    assertNativeCopyRequestBudget({ kind: 'copy', origin: owner.invocation.origin, selections: plan.selections });
    return { plan, source, destination, current };
  });
}

/** Server-side preview through genuine current Web/PI/MCP principals on the same
 * actual dedicated B. Private plan data must be projected before an HTTP reply. */
export async function previewWorkspaceNativeCopyOperation(supplied: NativeCopyPreviewInput): Promise<WorkspaceOperationAnyManagedCopyPlan | WorkspaceOperationManagedCopyPlanV5> {
  const invocation = captureInvocation(supplied), selections = captureSelections(supplied), renameOnCollision = supplied.renameOnCollision === true;
  const destinationDirectory = captureDestinationDirectory(supplied);
  return withSession(invocation, owner => transaction(owner, 'write', async () => (await observe(owner, selections, renameOnCollision, destinationDirectory)).plan));
}

export type NativeCopyExecutionInput = NativeCopyPreviewInput & Readonly<{ operationId: string; expectedPlanId?: string }>;
export type NativeCopyExecutionResult = Readonly<{
  execution: WorkspaceOperationExecutionResult; plan: WorkspaceOperationNativeCopyPlan | WorkspaceOperationAnyManagedCopyPlan | WorkspaceOperationManagedCopyPlanV5 | null;
  copied: string[]; alreadyKnown: boolean;
}>;
const copyViewOutcomes = new WeakMap<object, NativeCopyViewOutcome>();
/** Exact returned result/error only. Serialized clones carry no event facts.
 * These facts authorize no read, write, recovery or journal operation. */
export function readWorkspaceNativeCopyViewOutcome(value: unknown): NativeCopyViewOutcome | null {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? copyViewOutcomes.get(value) ?? null : null;
}
function assertRequestedCopy(request: WorkspaceOperationRequest, original: WorkspaceOperationCopyOrigin,
  selections: readonly WorkspaceOperationNativeCopySelection[], renameOnCollision: boolean): void {
  if (request.kind !== 'copy' || !request.origin || !equal(decodeWorkspaceOperationCopyOrigin(request.origin), original)
    || request.selections.length !== selections.length || request.selections.some((saved, index) => {
      const selected = selections[index];
      return saved.sourcePath !== selected.sourcePath || saved.destinationPath !== selected.destinationPath
        && !(renameOnCollision && path.posix.dirname(saved.destinationPath) === path.posix.dirname(selected.destinationPath)
          && path.posix.basename(selected.destinationPath) === path.posix.basename(selected.sourcePath));
    })) problem('NATIVE_COPY_INVALID_REQUEST');
}

/** Header-only lookup before a Stage identity is known. No receipt payload or
 * current document state is materialized by this routing read. */
async function operationHeader(owner: Owner, operationId: string): Promise<WorkspaceOperationRecord | null> {
  return principal(owner, async () => {
    const row = await owner.database.get(`SELECT operation_id,plan_id,request_hash,
      CASE WHEN octet_length(request_json)<=65536 THEN request_json END AS request_json,
      actor_type,actor_id,source_workspace_id,destination_workspace_id,expected_step_count,status,phase,revision,error_code,created_at,updated_at
      FROM workspace_file_operations WHERE operation_id=$1 FOR UPDATE`, [operationId]) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (typeof row.request_json !== 'string' || typeof row.plan_id !== 'string' || !/^[a-f0-9]{64}$/u.test(row.plan_id)
      || !Number.isSafeInteger(row.expected_step_count) || Number(row.expected_step_count) < 1 || Number(row.expected_step_count) > 10_000) {
      problem('NATIVE_COPY_INVALID_REQUEST');
    }
    return { operationId: String(row.operation_id), planId: row.plan_id, requestHash: String(row.request_hash), requestJson: row.request_json,
      actor: { type: row.actor_type as WorkspaceOperationRecord['actor']['type'], id: String(row.actor_id) },
      sourceWorkspaceId: String(row.source_workspace_id), destinationWorkspaceId: String(row.destination_workspace_id),
      expectedStepCount: Number(row.expected_step_count), status: row.status as WorkspaceOperationRecord['status'],
      phase: row.phase as WorkspaceOperationRecord['phase'], revision: Number(row.revision),
      errorCode: row.error_code === null ? null : String(row.error_code), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  });
}
function bindOriginal(owner: Owner, original: WorkspaceOperationCopyOrigin): void {
  assertWorkspaceOperationCopyOriginCurrent(original, owner.invocation.origin);
  // Only the original receipt context changes. The genuine current request or
  // MCP capture survives session renewal and every phase authenticates afresh.
  owner.invocation = Object.freeze({ origin: original, ...(owner.invocation.request ? { request: owner.invocation.request } : {}),
    ...(owner.invocation.mcpPrincipal === undefined ? {} : { mcpPrincipal: owner.invocation.mcpPrincipal }) });
}
function bindHeader(owner: Owner, header: WorkspaceOperationRecord, selections: readonly WorkspaceOperationNativeCopySelection[],
  renameOnCollision: boolean, expectedPlanId?: string): WorkspaceOperationRequest {
  const request = JSON.parse(header.requestJson) as WorkspaceOperationRequest;
  const encoded = serializeWorkspaceOperationRequest(request);
  if (encoded.requestHash !== header.requestHash || encoded.requestJson !== header.requestJson || !request.origin
    || header.actor.id !== request.origin.actor.userId || header.actor.type !== request.origin.actor.type
    || header.sourceWorkspaceId !== request.origin.sourceScope.workspaceId || header.destinationWorkspaceId !== request.origin.destinationScope.workspaceId
    || expectedPlanId !== undefined && expectedPlanId !== header.planId) problem('NATIVE_COPY_INVALID_REQUEST');
  const original = assertWorkspaceOperationCopyOriginCurrent(request.origin, owner.invocation.origin);
  assertRequestedCopy(request, original, selections, renameOnCollision); bindOriginal(owner, original); return request;
}
function executionResult(operationId: string, planId: string, complete: boolean,
  completed: readonly string[], pending: readonly string[], errorCode: string | null): WorkspaceOperationExecutionResult {
  return { operationId, planId, status: complete ? 'complete' : 'needs_recovery',
    completedSteps: [...completed], pendingSteps: [...pending], errorCode };
}
async function completedHistory(owner: Owner, header: WorkspaceOperationRecord, request: WorkspaceOperationRequest): Promise<Readonly<{
  result: NativeCopyExecutionResult; stageVersion: 2 | 3 | 4 | 5 | 6; managedReceipt?: ExcalidrawCopyBirthReceipt;
}>> {
  const storage = await transaction(owner, 'write', () => principal(owner, async () => {
    const schema = await owner.database.get('SELECT pg_catalog.current_schema() AS name') as { name?: string } | undefined;
    if (typeof schema?.name !== 'string') problem();
    return { native: await readNativeCopyReceiptStorageIdentityOnConnection(owner.database, schema.name),
      scene: await readExcalidrawCopyReceiptStorageIdentityOnConnection(owner.database, schema.name) };
  }));
  const history = await transaction(owner, 'history', async () => {
    const historical = await readCompletedNativeCopyHistoryOnConnection(owner.database, { operationId: header.operationId,
      origin: owner.invocation.origin, requestHash: header.requestHash, planId: header.planId, storage: storage.native, sceneStorage: storage.scene });
    if (!historical) problem('NATIVE_COPY_INVALID_REQUEST');
    const rows = await owner.database.all(`SELECT step_key,status FROM workspace_file_operation_steps
      WHERE operation_id=$1 ORDER BY step_key LIMIT 10001`, [header.operationId]) as Array<{ step_key: string; status: string }>;
    if (rows.length !== historical.operation.expectedStepCount || rows.some(row => row.status !== 'applied')) problem();
    return { historical, steps: rows.map(row => row.step_key) };
  });
  // Authorization is current on both sides of the read-only historical phase.
  // Historical initial receipts never become permission for another mutation.
  await transaction(owner, 'write', () => principal(owner, async () => undefined));
  return { result: { execution: executionResult(header.operationId, header.planId, true, history.steps, [], null),
    plan: null, copied: request.selections.map(selection => selection.destinationPath), alreadyKnown: true },
    stageVersion: history.historical.stageVersion, ...(history.historical.managedReceipt ? { managedReceipt: history.historical.managedReceipt } : {}) };
}
async function createStage(owner: Owner, store: WorkspaceOperationStaging, operationId: string,
  selections: readonly WorkspaceOperationNativeCopySelection[], renameOnCollision: boolean,
  expectedPlanId?: string, destinationDirectory?: string): Promise<WorkspaceOperationOwnedCopyStage> {
  const observed = await transaction(owner, 'write', async () => {
    const observation = await observe(owner, selections, renameOnCollision, destinationDirectory);
    const selected = new Set(observation.plan.sceneCopyRequirements.map(row => row.sourceDocumentId));
    const sceneRecords = observation.source.privateSceneSnapshots.filter(row => selected.has(row.header.id));
    const metadata = new Map<string, (typeof sceneRecords)[number]['scene']['assets'][number]>();
    for (const record of sceneRecords) for (const asset of record.scene.assets) {
      const prior = metadata.get(asset.fileId);
      if (prior && !equal(prior, asset)) problem('NATIVE_COPY_PLAN_CHANGED');
      metadata.set(asset.fileId, asset);
    }
    const assets = await principal(owner, () => readExcalidrawAssetsOnConnection(owner.database,
      observation.current.sourceWorkspace.workspaceId, [...metadata.values()]));
    const sceneAssets = assets.map(asset => ({ workspaceId: observation.current.sourceWorkspace.workspaceId, asset }));
    return { ...observation, sceneRecords, sceneAssets };
  });
  if (expectedPlanId !== undefined && observed.plan.planId !== expectedPlanId) problem('NATIVE_COPY_PLAN_CHANGED');
  if (observed.current.currentActor.sessionId !== owner.invocation.origin.actor.sessionId) problem('NATIVE_COPY_INVALID_REQUEST');
  const spaces = { sourceWorkspace: observed.current.sourceWorkspace, destinationWorkspace: observed.current.destinationWorkspace };
  const physical: WorkspaceOperationManagedCopyPhysical[] = [];
  let persisted = false, derivedBytes = 0;
  try {
    for (const [selectionIndex, selected] of observed.plan.selections.entries()) {
      await transaction(owner, 'write', () => principal(owner, async () => undefined));
      const entry = observed.plan.sourceEvidence.stage.namespace.find(entry => entry.path === selected.sourcePath);
      if (!entry) problem('NATIVE_COPY_INVALID_REQUEST');
      const sourceKind = entry.filesystemIdentity === null ? 'projection_absent' : entry.kind === 'directory' ? 'directory' : 'regular_file';
      const projectionPaths = observed.plan.sourceEvidence.nativeBindings.map(binding => binding.expected.path)
        .filter(path => path === selected.sourcePath || entry.kind === 'directory' && path.startsWith(selected.sourcePath + '/'));
      const derivedFiles = [];
      for (const row of observed.sceneRecords) {
        if (row.header.path !== selected.sourcePath
          && !(entry.kind === 'directory' && row.header.path.startsWith(selected.sourcePath + '/'))) continue;
        const portable = serializePortableExcalidrawSceneFromReadonlyAssets({ elements: row.scene.elements,
          appState: row.scene.appState, assets: row.scene.assets, canonicalHash: row.scene.canonicalHash }, observed.sceneAssets
          .filter(asset => row.scene.assets.some(metadata => equal(metadata, asset.asset.metadata)))
          .map(({ asset }) => ({ metadata: asset.metadata, bytes: asset.bytes })));
        derivedBytes += Buffer.byteLength(portable);
        if (derivedBytes > 128 * 1024 * 1024) throw new ExcalidrawCopyError('EXCALIDRAW_COPY_TOO_LARGE');
        derivedFiles.push({ path: row.header.path, provider: 'excalidraw' as const, documentId: row.header.id,
          lineageId: row.header.lineage_id, lifecycleGeneration: row.header.lifecycle_generation!,
          sourceContentProof: row.contentProof, bytes: Buffer.from(portable) });
      }
      await withPreparedWorkspacePathCopy({ ...spaces, ...selected, sourceKind, projectionPaths,
        sourceProjectionPolicy: 'provider-derived-files-v3', derivedFiles }, async cap => {
        const original = readPreparedWorkspacePathCopy(cap);
        if (original.version !== 3) problem();
        physical.push({ selectionIndex, original });
      });
      await verify(owner);
    }
    const observations = observed.source === observed.destination ? [observed.source] : [observed.source, observed.destination];
    const nativeRecords = observations.flatMap(observation => observation.nativeBindings.map(binding => {
      const state = observation.privateNativeStates.find(state => state.documentId === binding.expected.documentId);
      if (!state) problem('NATIVE_COPY_INVALID_REQUEST');
      return { lineageId: binding.expected.lineageId, state };
    }));
    const metadata = await transaction(owner, 'write', () => principal(owner,
      () => captureNativeCopyMetadataSnapshotOnConnection(owner.database, { plan: observed.plan, physical })));
    const input = { operationId, request: { kind: 'copy' as const, origin: owner.invocation.origin, selections: observed.plan.selections },
      physical, nativeRecords, sceneRecords: observed.sceneRecords, sceneAssets: observed.sceneAssets, metadata };
    const stage = observed.plan.version === 5 ? await store.stageRawCopy({ ...input, plan: observed.plan,
      rawOriginals: observed.plan.rawImportRequirements.map(requirement => {
        const entry = observed.source.stage.sources.find(entry => entry.kind === 'physical' && entry.inventory.path === requirement.sourcePath);
        if (entry?.kind !== 'physical' || entry.inventory.workspaceId !== requirement.sourceWorkspaceId
          || entry.inventory.physicalSourceProof !== requirement.physicalSourceProof) problem('NATIVE_COPY_PLAN_CHANGED');
        return entry.inventory;
      }) }) : observed.plan.version === 4 ? await store.stageMixedCopy({ ...input, plan: observed.plan })
      : await store.stageManagedCopy({ ...input, plan: observed.plan });
    persisted = true; return stage;
  } catch (error) {
    // No publication occurred. Only exact preparations born here may be
    // discarded. Uncertain Stage publication retains all originals for retry.
    const kind = await store.readKind(operationId);
    if (persisted || kind !== null) throw error;
    const cleanupFailures: unknown[] = [];
    for (const value of physical) {
      try { await withRecoveredWorkspacePathCopy({ ...spaces, original: value.original }, async cap => {
        await discardPreparedWorkspacePathCopy(cap);
      }); } catch (cleanup) { cleanupFailures.push(cleanup); }
    }
    if (cleanupFailures.length) throw new AggregateError([error, ...cleanupFailures], 'Native Copy preparation cleanup was not confirmed.');
    throw error;
  }
}

type BornParent = { selectionIndex: number; parent: PreparedWorkspacePathCopyParentReceipt };
function readParents(stage: WorkspaceOperationOwnedCopyStage, journal: WorkspaceOperationWithSteps): BornParent[] {
  const births: BornParent[] = [];
  for (const expected of nativeCopyPhaseParentSteps(stage)) {
    const row = journal.steps.find(step => step.stepKey === expected.stepKey);
    if (!row || row.beforeFence !== expected.beforeFence || row.afterFence !== expected.afterFence || row.phase !== 'path') problem();
    if (row.status !== 'applied') continue;
    if (!row.receiptJson) problem();
    const data = JSON.parse(row.receiptJson) as { version: number; kind: string; selectionIndex: number; parent: PreparedWorkspacePathCopyParentReceipt };
    if (Object.keys(data).sort().join(',') !== 'kind,parent,selectionIndex,version' || data.version !== 1 || data.kind !== 'native-copy-parent') problem();
    assertNativeCopyPhaseParent(stage, data.selectionIndex, data.parent);
    births.push({ selectionIndex: data.selectionIndex, parent: data.parent });
  }
  return births;
}
function sharedParents(stage: WorkspaceOperationOwnedCopyStage, selectionIndex: number,
  journal: WorkspaceOperationWithSteps, receipts: readonly NativeCopyPhasePathReceipt[], births: readonly BornParent[]): PreparedWorkspacePathCopySharedParent[] {
  const steps = nativeCopyPhaseParentSteps(stage), paths = nativeCopyPhasePathSteps(stage);
  return births.filter(birth => birth.selectionIndex !== selectionIndex
    && steps.find(step => step.path === birth.parent.relativePath)?.consumerSelectionIndexes.includes(selectionIndex))
    .sort((a, b) => a.parent.relativePath.split('/').length - b.parent.relativePath.split('/').length)
    .map(birth => {
      const producer = receipts.find(value => value.selectionIndex === birth.selectionIndex);
      const expected = paths[birth.selectionIndex], row = journal.steps.find(step => step.stepKey === expected.stepKey);
      if (!producer || producer.receipt.observation.kind !== 'published' || !row || row.status !== 'applied'
        || row.beforeFence !== expected.beforeFence || row.afterFence !== expected.afterFence || !row.receiptJson) problem();
      const stored = JSON.parse(row.receiptJson) as Record<string, unknown>;
      if (!equal(stored, { version: 1, kind: 'native-copy-path', selectionIndex: birth.selectionIndex,
        originalProof: preparedWorkspacePathCopyProof(producer.receipt.original), receiptProof: proof(producer.receipt) })) problem();
      return { producerOriginal: stage.physical[birth.selectionIndex].original,
        producerReceipt: producer.receipt, parentReceipt: birth.parent };
    });
}
async function publishPaths(owner: Owner, stage: WorkspaceOperationOwnedCopyStage): Promise<NativeCopyPhasePathReceipt[]> {
  const receipts: NativeCopyPhasePathReceipt[] = [];
  // Physical producers run before logical absence observations, including a
  // projection-only selection that appeared first in the original request.
  const ordered = [...stage.physical].sort((a, b) => Number(Boolean(b.original.staging)) - Number(Boolean(a.original.staging))
    || a.selectionIndex - b.selectionIndex);
  for (const selected of ordered) {
    const journal = await transaction(owner, 'write', () => principal(owner, async () =>
      await readNativeCopyPhaseJournalOnConnection(owner.database, stage) ?? problem()));
    const births = readParents(stage, journal), inherited = sharedParents(stage, selected.selectionIndex, journal, receipts, births);
    const receipt = await withRecoveredWorkspacePathCopy({ sourceWorkspace: owner.workspaces!.source, destinationWorkspace: owner.workspaces!.destination,
      original: selected.original, createdParents: births.filter(birth => birth.selectionIndex === selected.selectionIndex).map(birth => birth.parent),
      sharedParents: inherited }, async cap => {
      const result = await publishPreparedWorkspacePathCopy(cap, parent => copyPhaseTransaction(owner, stage, detached =>
        recordNativeCopyParentOnConnection(owner.database, { stage: detached, request: owner.invocation.request,
          ...(owner.invocation.mcpPrincipal === undefined ? {} : { mcpPrincipal: owner.invocation.mcpPrincipal }),
          selectionIndex: selected.selectionIndex, receipt: parent })));
      await assertPreparedWorkspacePathCopyReceiptCurrent(cap, result); await verify(owner); return result;
    });
    await copyPhaseTransaction(owner, stage, detached => recordNativeCopyPathOnConnection(owner.database,
      { stage: detached, request: owner.invocation.request,
        ...(owner.invocation.mcpPrincipal === undefined ? {} : { mcpPrincipal: owner.invocation.mcpPrincipal }),
        selectionIndex: selected.selectionIndex, receipt }));
    receipts.push({ selectionIndex: selected.selectionIndex, receipt });
  }
  // Recheck every original-bound result after all sibling publications. A later
  // publication may have completed a parent needed by an earlier logical path.
  const journal = await transaction(owner, 'write', () => principal(owner, async () =>
    await readNativeCopyPhaseJournalOnConnection(owner.database, stage) ?? problem()));
  const births = readParents(stage, journal);
  for (const value of receipts) await withRecoveredWorkspacePathCopy({ sourceWorkspace: owner.workspaces!.source,
    destinationWorkspace: owner.workspaces!.destination, original: value.receipt.original,
    createdParents: births.filter(birth => birth.selectionIndex === value.selectionIndex).map(birth => birth.parent),
    sharedParents: sharedParents(stage, value.selectionIndex, journal, receipts, births) }, async cap => {
    const observed = await publishPreparedWorkspacePathCopy(cap);
    if (!equal(observed, value.receipt)) problem();
    await assertPreparedWorkspacePathCopyReceiptCurrent(cap, observed); await verify(owner);
  });
  return receipts;
}
function errorCode(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(errorCode).find(code => code === 'NATIVE_COPY_COMMIT_UNCONFIRMED')
    ?? 'NATIVE_COPY_PUBLICATION_UNCONFIRMED';
  if (error instanceof Error) {
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,95}$/u.test(code)) return code;
  }
  return 'NATIVE_COPY_PUBLICATION_UNCONFIRMED';
}
function authenticationError(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.some(authenticationError);
  return error instanceof Error && ([401, 403].includes(Number(Reflect.get(error, 'status')))
    || ['PRINCIPAL_AUTH_REVOKED', 'PRINCIPAL_ACCESS_DENIED', 'AGENT_ACTOR_CONTEXT_DENIED'].includes(String(Reflect.get(error, 'code'))));
}
async function recordRecovery(invocation: Invocation, stage: WorkspaceOperationOwnedCopyStage, code: string): Promise<void> {
  // This is a new actual checkout after the uncertain owner was discarded.
  // It records recovery status only; it never retries native or FS mutations.
  await withSession({ origin: stage.origin, request: invocation.request,
    ...(invocation.mcpPrincipal === undefined ? {} : { mcpPrincipal: invocation.mcpPrincipal }) }, owner => transaction(owner, 'write', async () => {
    const header = await operationHeader(owner, stage.identity.operationId);
    if (header && (header.planId !== stage.plan.planId || header.requestHash !== stage.identity.canonicalRequestHash
      || header.requestJson !== serializeWorkspaceOperationRequest(stage.request).requestJson)) problem('NATIVE_COPY_INVALID_REQUEST');
    if (header?.status === 'completed') return;
    await principal(owner, async () => {
      if (!header) await prepareWorkspaceOperationOnConnection(owner.database, { operationId: stage.identity.operationId,
        planId: stage.plan.planId, request: stage.request, actor: { type: stage.origin.actor.type, id: stage.origin.actor.userId },
        sourceWorkspaceId: stage.identity.sourceWorkspaceId, destinationWorkspaceId: stage.identity.destinationWorkspaceId,
        expectedStepCount: nativeCopyPhaseStepCount(stage) });
      await failWorkspaceOperationOnConnection(owner.database,
        { operationId: stage.identity.operationId, recoveryRequired: true, errorCode: code });
    });
  }));
}

/** Fixed native Copy owner. Durable original staging precedes B0; all native
 * Yjs clone births, fixed Scene intents and link mutations commit in B1. Atomic FD publication
 * runs outside transactions while this actual session holds workspace keys.
 * B2 creates the fixed Scene/asset rows, confirms the graph and original receipt, and closes all
 * reservations. Unknown acknowledgements retain the original operation ID. */
export async function executeWorkspaceNativeCopyOperation(supplied: NativeCopyExecutionInput): Promise<NativeCopyExecutionResult> {
  return runWorkspaceNativeCopyOperation(supplied, 'execute');
}

/** One explicit attempt of an existing original only. Current authority,
 * Owner locks, historical validation and publication phases are unchanged. */
export async function recoverWorkspaceNativeCopyOperation(supplied: NativeCopyExecutionInput): Promise<NativeCopyExecutionResult> {
  return runWorkspaceNativeCopyOperation(supplied, 'recover');
}

async function runWorkspaceNativeCopyOperation(supplied: NativeCopyExecutionInput,
  mode: 'execute' | 'recover'): Promise<NativeCopyExecutionResult> {
  const invocation = captureInvocation(supplied), selections = captureSelections(supplied), renameOnCollision = supplied.renameOnCollision === true;
  const destinationDirectory = captureDestinationDirectory(supplied);
  const operationId = supplied.operationId, expectedPlanId = supplied.expectedPlanId;
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u.test(operationId)
    || expectedPlanId !== undefined && (typeof expectedPlanId !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedPlanId))) problem('NATIVE_COPY_INVALID_REQUEST');
  let durable: WorkspaceOperationOwnedCopyStage | undefined, alreadyKnown = false;
  let completedSteps: string[] = [], pendingSteps: string[] = [];
  let viewOutcome: NativeCopyViewOutcome | null = null;
  const bindViews = <T extends object>(value: T): T => {
    if (viewOutcome) copyViewOutcomes.set(value, viewOutcome);
    else copyViewOutcomes.delete(value);
    return value;
  };
  const bindViewError = (error: unknown): unknown => viewOutcome && (error === null
    || typeof error !== 'object' && typeof error !== 'function')
    ? bindViews(new Error('Native Copy failed after a confirmed view outcome.', { cause: error }))
    : error !== null && (typeof error === 'object' || typeof error === 'function') ? bindViews(error) : error;
  try {
    return bindViews(await withSession(invocation, async owner => {
      const store = new WorkspaceOperationStaging();
      const header = await transaction(owner, 'write', () => operationHeader(owner, operationId));
      const request = header ? bindHeader(owner, header, selections, renameOnCollision, expectedPlanId) : null;
      if (header?.status === 'completed') {
        const history = await completedHistory(owner, header, request!);
        viewOutcome = Object.freeze({ kind: 'historical', destinationWorkspaceId: header.destinationWorkspaceId });
        // A lost B2 acknowledgement may leave the original private Stage after
        // a proven completion. Retire that exact Stage without reading D2.
        const retained = await store.loadOwnedCopyByOperationId(operationId);
        if (retained) {
          if (retained.identity.canonicalRequestHash !== header.requestHash || retained.plan.planId !== header.planId
            || !equal(retained.origin, owner.invocation.origin)) problem();
          if (retained.version !== history.stageVersion) problem();
          if (retained.version === 6) await store.removeCompletedRawCopy(retained.identity);
          else if ((retained.version === 4 || retained.version === 5)) await store.removeCompletedManagedCopy(retained.identity);
          else await store.removeCompletedNativeCopy(retained.identity);
        }
        if (history.managedReceipt) await retireConfirmedAssets(owner, history.managedReceipt);
        return history.result;
      }
      const original = await store.loadOwnedCopyByOperationId(operationId);
      if (original) {
        bindOriginal(owner, original.origin); assertRequestedCopy(original.request, original.origin, selections, renameOnCollision);
        if (expectedPlanId !== undefined && expectedPlanId !== original.plan.planId
          || header && (header.requestHash !== original.identity.canonicalRequestHash || header.planId !== original.plan.planId)) problem('NATIVE_COPY_INVALID_REQUEST');
        alreadyKnown = true; durable = original;
      } else {
        if (header) problem('NATIVE_COPY_INVALID_REQUEST');
        if (mode === 'recover') throw new NativeCopyOperationNotFoundError();
        durable = await createStage(owner, store, operationId, selections, renameOnCollision, expectedPlanId, destinationDirectory);
      }
      const stage = durable; owner.stage = stage;
      pendingSteps = [...nativeCopyPhasePathSteps(stage), ...nativeCopyPhaseParentSteps(stage)].map(step => step.stepKey);
      // B0 is only an original-intent header. It lets the existing recovery
      // endpoint route a rollback before the clone/link transaction succeeds.
      await transaction(owner, 'write', () => principal(owner, () => prepareWorkspaceOperationOnConnection(owner.database,
        { operationId, planId: stage.plan.planId, request: stage.request,
          actor: { type: stage.origin.actor.type, id: stage.origin.actor.userId },
          sourceWorkspaceId: stage.identity.sourceWorkspaceId, destinationWorkspaceId: stage.identity.destinationWorkspaceId,
          expectedStepCount: nativeCopyPhaseStepCount(stage) })));
      const publish = async (assetCap?: PreparedExcalidrawCopyAssets): Promise<NativeCopyExecutionResult> => {
        const prepared = await copyPhaseTransaction(owner, stage, detached => prepareNativeCopyPhaseOnConnection(owner.database,
          { stage: detached, request: owner.invocation.request,
            ...(owner.invocation.mcpPrincipal === undefined ? {} : { mcpPrincipal: owner.invocation.mcpPrincipal }),
            ...(assetCap ? { assetOriginal: readPreparedExcalidrawCopyAssets(assetCap) } : {}) }));
        if ((stage.version === 4 || stage.version === 5 || stage.version === 6)) {
          if (!prepared.managedIntent) problem();
          owner.assetPublication = Object.freeze({ stageDigest: stage.payloadSha256,
            originalProof: prepared.managedIntent.assetOriginal.originalProof });
        }
        pendingSteps.push(...prepared.linkReceipts.map(link => link.stepKey), 'copy-completion');
        if (assetCap) await assertPreparedExcalidrawCopyAssetsCurrent(assetCap);
        const assetReceipt = assetCap ? await publishPreparedExcalidrawCopyAssets(assetCap) : undefined;
        const pathReceipts = await publishPaths(owner, stage);
        const entries = new Map(stage.plan.nativePathPlan.pathMappings.map(mapping => [mapping.destinationPath,
          Object.freeze({ path: mapping.destinationPath, type: mapping.source.kind === 'directory' ? 'addDir' as const : 'add' as const })]));
        for (const path of pathReceipts) for (const parent of path.receipt.createdParents) {
          entries.set(parent.relativePath, Object.freeze({ path: parent.relativePath, type: 'addDir' }));
        }
        const publishedViews: NativeCopyViewOutcome = Object.freeze({ kind: 'published',
          destinationWorkspaceId: stage.identity.destinationWorkspaceId,
          entries: Object.freeze([...entries.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) });
        const result = await copyPhaseTransaction(owner, stage, detached => completeNativeCopyPhaseOnConnection(owner.database,
          { stage: detached, request: owner.invocation.request,
            ...(owner.invocation.mcpPrincipal === undefined ? {} : { mcpPrincipal: owner.invocation.mcpPrincipal }),
            pathReceipts, ...(assetReceipt ? { assetReceipt } : {}) }), committed => {
          if (committed.disposition === 'completed' && committed.operation.status === 'completed') {
            viewOutcome = committed.publication === 'published' ? publishedViews
              : Object.freeze({ kind: 'historical', destinationWorkspaceId: stage.identity.destinationWorkspaceId });
          }
        });
        if (result.disposition !== 'completed' || result.operation.status !== 'completed') problem();
        const journal = await transaction(owner, 'write', () => principal(owner, async () =>
          await readNativeCopyPhaseJournalOnConnection(owner.database, stage) ?? problem()));
        completedSteps = journal.steps.filter(step => step.status === 'applied').map(step => step.stepKey);
        pendingSteps = journal.steps.filter(step => step.status !== 'applied').map(step => step.stepKey);
        if (pendingSteps.length || completedSteps.length !== nativeCopyPhaseStepCount(stage)) problem();
        if ((stage.version === 4 || stage.version === 5 || stage.version === 6)) {
          if (!result.managedReceipt) problem();
          await retireConfirmedAssets(owner, result.managedReceipt);
          if (stage.version === 6) await store.removeCompletedRawCopy(stage.identity);
          else await store.removeCompletedManagedCopy(stage.identity);
        } else await store.removeCompletedNativeCopy(stage.identity);
        return { execution: executionResult(operationId, stage.plan.planId, true, completedSteps, [], null), plan: stage.plan,
          copied: stage.plan.selections.map(selection => selection.destinationPath), alreadyKnown };
      };
      if ((stage.version !== 4 && stage.version !== 5 && stage.version !== 6)) return publish();
      const saved = await transaction(owner, 'write', () => principal(owner, () => readOriginalExcalidrawCopyOnConnection(owner.database, { stage })));
      const destinationWorkspace = owner.workspaces!.destination;
      return saved
        ? withRecoveredExcalidrawCopyAssets({ stage, destinationWorkspace, original: saved.intent.assetOriginal }, publish)
        : withPreparedExcalidrawCopyAssets({ stage, destinationWorkspace }, publish);
    }));
  } catch (error) {
    if (!durable || authenticationError(error)) throw bindViewError(error);
    try { await recordRecovery(invocation, durable, errorCode(error)); }
    catch (recording) {
      if (authenticationError(recording)) throw bindViewError(recording);
      // Preserve the original immutable Stage and error if the separate status
      // acknowledgement is itself uncertain. An explicit retry still uses D1.
    }
    return bindViews({ execution: executionResult(operationId, durable.plan.planId, false, completedSteps, pendingSteps, errorCode(error)),
      plan: durable.plan, copied: [], alreadyKnown });
  }
}
