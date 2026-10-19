import 'server-only';
import { notifyWorkspaceFileInvalidationOnConnection } from '../filesystem/workspace-file-invalidation';

import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual as equal, types } from 'node:util';
import { NextRequest } from 'next/server';
import type { SqlConnection } from '../db';
import { authoritativeNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { persistNativeWorkspaceCopiesOnConnection, completeNativeCopyPublicationOnConnection,
  type NativeCopyReceipt } from '../collaboration/native-copy-persistence';
import { loadCollaborationStateOnConnection } from '../collaboration/persistence';
import { reserveCollaborationAdmissionOnConnection } from '../collaboration/room-admission';
import { captureCollaborationAdmissionRequest, collaborationAdmissionLockKey, type CollaborationAdmissionRequest } from '../collaboration/room-admission-contract';
import { proveCollaborationAdmissionQuiescenceOnConnection } from '../collaboration/room-admission-quiescence';
import { executeCollaborationAdmissionHandoffOnConnection } from '../collaboration/room-admission-handoff';
import { withWorkspaceCopyRequestOnConnection, withWorkspaceCopyAgentOnConnection, withWorkspaceCopyMcpOnConnection,
  type WorkspaceCopyPrincipalAccess } from '../workspaces/copy-principal';
import { assertDirectMcpWorkspaceCopyPrincipalCaptured,
  type DirectMcpWorkspaceCopyPrincipal } from '../mcp/server/document-read-principal';
import { captureWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { prepareNativeCopyLinkUpdates } from '../markdown/workspace-native-copy-link-updates';
import { nativeLinkPreparedIntentProof, persistPreparedNativeLinkMutationOnConnection } from '../markdown/native-link-mutation-persistence';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { readWorkspaceLinkSourceAuthorityOnConnection } from '../markdown/workspace-source-authority-stage';
import { workspaceSourceAuthorityStageProof } from '../markdown/workspace-physical-link-inventory';
import type { NativeNamespaceEntry } from '../markdown/workspace-link-contract-v2';
import { workspaceOperationNativePlanSnapshot, captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { assertWorkspaceOperationNativeCopyPlanCurrent } from './workspace-operation-native-copy-plan';
import { assertNativeCopyFinalGraph, type NativeCopyFinalManagedScenes } from './workspace-operation-native-copy-graph';
import { assertNativeCopySessionOnConnection, assertNativeCopyPhysicalStageOnConnection } from './workspace-operation-native-copy-owner';
import type { WorkspaceOperationOwnedCopyStage, WorkspaceOperationManagedCopyStageV4 } from './workspace-operation-managed-copy-stage';
import { prepareWorkspaceOperationOnConnection, beginWorkspaceOperationStepOnConnection, finishWorkspaceOperationStepOnConnection,
  completeWorkspaceOperationOnConnection, resumeWorkspaceOperationOnConnection, type WorkspaceOperationWithSteps,
  type WorkspaceOperationRecord } from './workspace-operation-journal';
import { assertWorkspaceFileLifecycleSqlAvailable } from './workspace-file-lifecycle-guard';
import { lockFileCollaborationPaths } from './collaboration-repository';
import { decodePreparedWorkspacePathCopyOriginal, preparedWorkspacePathCopyProof,
  type PreparedWorkspacePathCopyReceipt, type PreparedWorkspacePathCopyParentReceipt, type PreparedPathCopyIdentity } from '../filesystem/prepared-workspace-path-copy-contract';
import { captureNativeCopyPhaseStage, copyPhaseChanged, nativeCopyPhasePathSteps, nativeCopyPhaseParentSteps,
  nativeCopyPhaseExpectedLinks, nativeCopyPhaseAdmissions, nativeCopyPhaseCompiler, nativeCopyPhaseOriginals,
  nativeCopyPhaseReceiptProof, nativeCopyPhaseStepCount, assertNativeCopyPhaseParent, nativeCopyPhaseCompletionReceipt,
  nativeCopyPhaseCompletionFence, NATIVE_COPY_COMPLETION_STEP_KEY, withNativeCopyPhaseCompilation } from './workspace-operation-native-copy-phase-contract';
import { readNativeCopyPhaseJournalOnConnection, readNativeCopyPhaseJournalHeaderOnConnection, readNativeCopyPhaseLedgerOnConnection,
  readNativeCopyPhaseLinkReceiptsOnConnection, type NativeCopyPhaseLinkReceipt } from './workspace-operation-native-copy-phase-read';
import { assertNativeCopyMetadataBeforeOnConnection, applyNativeCopyMetadataOnConnection } from './workspace-operation-native-copy-metadata';
import { readWorkspaceCopySourceObservationOnConnection } from './workspace-operation-copy-source-observation';
import { assertWorkspaceOperationManagedCopyPlanCurrent } from './workspace-operation-managed-copy-plan';
import { readWorkspaceSceneCatalogue } from '../collaboration/workspace-scene-catalogue';
import { prepareExcalidrawCopyIntentsOnConnection, readOriginalExcalidrawCopyOnConnection,
  commitExcalidrawCopiesOnConnection } from '../excalidraw-collaboration/copy-domain';
import type { ExcalidrawCopyAssetOriginal, ExcalidrawCopyAssetReceipt, ExcalidrawCopyIntent,
  ExcalidrawCopyBirthReceipt } from '../excalidraw-collaboration/copy-contract';

export { NativeCopyPhaseError, nativeCopyPhaseParentSteps } from './workspace-operation-native-copy-phase-contract';
export type NativeCopyPhaseInput = Readonly<{ stage: WorkspaceOperationOwnedCopyStage; request?: NextRequest;
  mcpPrincipal?: DirectMcpWorkspaceCopyPrincipal; assetOriginal?: ExcalidrawCopyAssetOriginal }>;
export type NativeCopyPhaseResult = Readonly<{
  disposition: 'prepared' | 'already-prepared' | 'completed'; operation: WorkspaceOperationRecord;
  nativeReceipt: NativeCopyReceipt; admissions: readonly CollaborationAdmissionRequest[]; linkReceipts: readonly NativeCopyPhaseLinkReceipt[];
  managedIntent: ExcalidrawCopyIntent | null; managedReceipt: ExcalidrawCopyBirthReceipt | null;
}>;
/** Domain disposition only; the owner must still confirm this B2 COMMIT. */
export type NativeCopyPhaseCompletionResult = NativeCopyPhaseResult & Readonly<{
  publication: 'published' | 'historical';
}>;
export type NativeCopyPhasePathReceipt = Readonly<{ selectionIndex: number; receipt: PreparedWorkspacePathCopyReceipt }>;
type Captured = NativeCopyPhaseInput;
type Row = Record<string, unknown>;
type RecoveryFrame = { database: SqlConnection; stage: WorkspaceOperationOwnedCopyStage; active: boolean };
const recoveryContext = new AsyncLocalStorage<RecoveryFrame>();
const recoveries = new WeakMap<SqlConnection, RecoveryFrame>();
const executing = new WeakSet<SqlConnection>();
type PhasePurpose = 'prepare' | 'path' | 'completion';
type PhaseWitness = { database: SqlConnection; identity: string; stageDigest: string; stage: WorkspaceOperationOwnedCopyStage;
  access: WorkspaceCopyPrincipalAccess; purpose: PhasePurpose; active: boolean };
const phaseContext = new AsyncLocalStorage<PhaseWitness>();

async function witness(database: SqlConnection): Promise<string> {
  const row = await database.get(`SELECT pg_catalog.pg_backend_pid() AS backend,a.backend_start::text AS start,
    (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database,
    pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::text AS schema,pg_catalog.current_setting('search_path') AS search_path,
    pg_catalog.pg_current_xact_id()::text AS xid,pg_catalog.current_setting('transaction_isolation') AS isolation,
    pg_catalog.current_setting('transaction_read_only') AS read_only,pg_catalog.current_setting('session_replication_role') AS replication
    FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`) as Row | undefined;
  if (!row || row.isolation !== 'read committed' || row.read_only !== 'off' || row.replication !== 'origin'
    || typeof row.xid !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(row.xid)) copyPhaseChanged();
  return JSON.stringify(row);
}
async function samePhase(database: SqlConnection): Promise<void> {
  const frame = phaseContext.getStore();
  if (!frame?.active || frame.database !== database || frame.identity !== await witness(database)
    || !frame.active || phaseContext.getStore() !== frame) copyPhaseChanged();
}
/** Only the exact captured stage in this actual principal/B/XID phase may
 * perform title SQL. A data digest or caller-provided flag is no grant. */
export async function assertNativeCopyMetadataPhaseOnConnection(database: SqlConnection, stage: WorkspaceOperationOwnedCopyStage): Promise<void> {
  const frame = phaseContext.getStore();
  if (!frame?.active || frame.database !== database || frame.stage !== stage || stage.version !== 3 && stage.version !== 4) copyPhaseChanged();
  captureNativeCopyPhaseStage(stage);
  await samePhase(database); await owner(database, stage);
  if (!frame.active || phaseContext.getStore() !== frame) copyPhaseChanged();
  captureNativeCopyPhaseStage(stage);
}

async function assertManagedScenePhase(database: SqlConnection, stage: WorkspaceOperationManagedCopyStageV4,
  purpose: 'prepare' | 'completion'): Promise<void> {
  const frame = phaseContext.getStore();
  if (!frame?.active || frame.database !== database || frame.stage !== stage || stage.version !== 4
    || frame.purpose !== purpose || frame.stageDigest !== stage.payloadSha256) copyPhaseChanged();
  captureNativeCopyPhaseStage(stage);
  await samePhase(database); await owner(database, stage);
  if (!frame.active || phaseContext.getStore() !== frame) copyPhaseChanged();
  captureNativeCopyPhaseStage(stage);
}
/** Only the fixed B1 entry point can hold this private preparation frame. */
export function assertNativeCopyManagedScenePreparationOnConnection(database: SqlConnection,
  stage: WorkspaceOperationManagedCopyStageV4): Promise<void> {
  return assertManagedScenePhase(database, stage, 'prepare');
}
/** Only the fixed B2 entry point can hold this private completion frame. */
export function assertNativeCopyManagedSceneCompletionOnConnection(database: SqlConnection,
  stage: WorkspaceOperationManagedCopyStageV4): Promise<void> {
  return assertManagedScenePhase(database, stage, 'completion');
}

/** Preserve only an own data field, without reading a caller getter or cloning
 * the opaque handle. Wrapper inputs carry additional domain-only fields. */
function captureMcpPrincipalField(input: NativeCopyPhaseInput): Pick<NativeCopyPhaseInput, 'mcpPrincipal'> {
  if (!input || typeof input !== 'object' || types.isProxy(input)) copyPhaseChanged();
  const principal = Object.getOwnPropertyDescriptor(input, 'mcpPrincipal');
  if (!principal) return {};
  if (!principal.enumerable || !Object.hasOwn(principal, 'value')) copyPhaseChanged();
  return { mcpPrincipal: principal.value };
}
function capture(input: NativeCopyPhaseInput): Captured {
  const principal = captureMcpPrincipalField(input);
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).some(key => {
    const property = Object.getOwnPropertyDescriptor(input, key);
    return typeof key !== 'string' || !['stage', 'request', 'mcpPrincipal', 'assetOriginal'].includes(key) || !property?.enumerable || !Object.hasOwn(property, 'value');
  })) copyPhaseChanged();
  const stage = captureNativeCopyPhaseStage(input.stage);
  const assetOriginal = input.assetOriginal === undefined ? undefined :
    captureWorkspaceOperationNativePlanData(input.assetOriginal, copyPhaseChanged) as ExcalidrawCopyAssetOriginal;
  if (stage.version !== 4 && assetOriginal !== undefined) copyPhaseChanged();
  if (stage.origin.version === 2) {
    if (input.request !== undefined || principal.mcpPrincipal === undefined) copyPhaseChanged();
    // capture() precedes current(): the helper rejects an already-busy phase.
    // SQL authority is obtained only by the fixed current() composition below.
    assertDirectMcpWorkspaceCopyPrincipalCaptured(principal.mcpPrincipal,
      { sourceWorkspaceId: stage.origin.sourceScope.workspaceId, destinationWorkspaceId: stage.origin.destinationScope.workspaceId });
    return { stage, mcpPrincipal: principal.mcpPrincipal, ...(assetOriginal === undefined ? {} : { assetOriginal }) };
  }
  if (Object.hasOwn(principal, 'mcpPrincipal')) copyPhaseChanged();
  const request = input.request === undefined ? undefined : new NextRequest(input.request.url,
    { method: input.request.method, headers: new Headers(input.request.headers), signal: input.request.signal });
  if (stage.origin.actor.type === 'user' && !request || stage.origin.actor.type === 'agent' && request) copyPhaseChanged();
  return { stage, request, ...(assetOriginal === undefined ? {} : { assetOriginal }) };
}
function current<T>(database: SqlConnection, input: Captured,
  operation: (access: WorkspaceCopyPrincipalAccess) => Promise<T>): Promise<T> {
  return input.stage.origin.version === 2
    ? withWorkspaceCopyMcpOnConnection(database, input.mcpPrincipal!, input.stage.origin, operation)
    : input.stage.origin.actor.type === 'user'
      ? withWorkspaceCopyRequestOnConnection(database, input.request!, input.stage.origin, operation)
      : withWorkspaceCopyAgentOnConnection(database, input.stage.origin, operation);
}
async function owner(database: SqlConnection, stage: WorkspaceOperationOwnedCopyStage): Promise<void> {
  await assertNativeCopySessionOnConnection(database, stage.origin);
}
/** An operation identity frame, never current ACL or a mutation capability.
 * Its only consumer checks exact original admission rows during own recovery.
 * The fixed session owner must exist; arbitrary B/DTO/callbacks cannot mint it. */
async function withNativeCopyOriginalRecovery<T>(database: SqlConnection, captured: Captured,
  operation: () => Promise<T>): Promise<T> {
  // Only phase() calls this private helper, with its synchronously detached,
  // fully decoded Stage and request. Replaying that original a second time
  // does not add a current owner, ACL or transaction check.
  await owner(database, captured.stage);
  const inherited = recoveryContext.getStore();
  if (inherited) {
    if (!inherited.active || inherited.database !== database || inherited.stage.payloadSha256 !== captured.stage.payloadSha256
      || recoveries.get(database) !== inherited) copyPhaseChanged();
    return operation();
  }
  if (recoveries.has(database)) copyPhaseChanged();
  const frame: RecoveryFrame = { database, stage: captured.stage, active: true }; recoveries.set(database, frame);
  try { return await recoveryContext.run(frame, operation); }
  finally { frame.active = false; if (recoveries.get(database) === frame) recoveries.delete(database); }
}
async function reservation(database: SqlConnection, request: CollaborationAdmissionRequest): Promise<void> {
  const expected = captureCollaborationAdmissionRequest(request);
  const header = await database.get(`SELECT request_digest,intent_text,status FROM collaboration_admission_requests
    WHERE request_id=$1 FOR SHARE`, [request.requestId]) as Row | undefined;
  if (!header || header.request_digest !== expected.requestDigest || header.intent_text !== expected.intentText
    || !['reserved', 'draining', 'committed'].includes(String(header.status))) copyPhaseChanged();
  const scopes = await database.all(`SELECT workspace_id,organization_id,path,kind FROM collaboration_admission_scopes
    WHERE request_id=$1 ORDER BY ordinal LIMIT 65`, [request.requestId]) as Row[];
  if (!equal(scopes.map(row => ({ workspaceId: row.workspace_id, organizationId: row.organization_id, path: row.path, kind: row.kind })), expected.request.scopes)) copyPhaseChanged();
  const targets = await database.all(`SELECT document_id,active FROM collaboration_admission_targets
    WHERE request_id=$1 ORDER BY document_id LIMIT 1025`, [request.requestId]) as Row[];
  if (targets.length !== expected.request.expectedDocuments.length || targets.some((target, index) =>
    target.document_id !== expected.request.expectedDocuments[index].documentId || target.active !== (header.status !== 'committed'))) copyPhaseChanged();
}
/** Read-only lifecycle consumer. A request ID is accepted only if freshly read
 * original Stage+Journal+immutable C3 derive the entire exact stored request.
 * No ignore-ID option and no permission boolean is exposed to the runner. */
export async function readNativeCopyOwnedReservationOnConnection(database: SqlConnection,
  requestId: string, workspaceId: string): Promise<CollaborationAdmissionRequest | null> {
  const frame = recoveryContext.getStore();
  if (!frame?.active || frame.database !== database || recoveries.get(database) !== frame) return null;
  await owner(database, frame.stage);
  if (workspaceId !== frame.stage.identity.destinationWorkspaceId) return null;
  const journal = await readNativeCopyPhaseJournalHeaderOnConnection(database, frame.stage);
  const ledger = await readNativeCopyPhaseLedgerOnConnection(database, frame.stage);
  if (!journal || !ledger) return null;
  const expected = nativeCopyPhaseAdmissions(frame.stage, ledger.receipt).find(request => request.requestId === requestId);
  if (!expected) return null;
  await reservation(database, expected); await owner(database, frame.stage);
  return expected;
}
async function write<T>(database: SqlConnection, input: Captured,
  operation: (access: WorkspaceCopyPrincipalAccess) => Promise<T>): Promise<T> {
  const frame = phaseContext.getStore();
  if (!frame?.active || frame.database !== database || frame.stageDigest !== input.stage.payloadSha256) copyPhaseChanged();
  await owner(database, input.stage); await samePhase(database);
  const result = await operation(frame.access);
  await samePhase(database); await owner(database, input.stage); return result;
}
async function fences(database: SqlConnection, access: WorkspaceCopyPrincipalAccess, stage: WorkspaceOperationOwnedCopyStage): Promise<void> {
  const scopes = [{ workspaceId: access.sourceWorkspace.workspaceId, paths: stage.plan.selections.map(selected => selected.sourcePath) },
    { workspaceId: access.destinationWorkspace.workspaceId, paths: stage.plan.selections.map(selected => selected.destinationPath) }]
    .sort((left, right) => left.workspaceId < right.workspaceId ? -1 : left.workspaceId > right.workspaceId ? 1 : 0);
  for (const scope of scopes) {
    await assertWorkspaceFileLifecycleSqlAvailable(database, scope.workspaceId, scope.paths);
    await lockFileCollaborationPaths(database, scope.workspaceId, scope.paths);
  }
  if (stage.version === 4) {
    const workspaces = access.sourceWorkspace.workspaceId === access.destinationWorkspace.workspaceId
      ? [access.sourceWorkspace] : [access.sourceWorkspace, access.destinationWorkspace];
    const ids = new Set<string>();
    for (const workspace of workspaces) for (const header of await readWorkspaceSceneCatalogue(database, workspace)) ids.add(header.id);
    for (const documentId of [...ids].sort()) {
      // Same lock domain/order as the Scene repository, on the owner's B.
      await database.get('SELECT pg_advisory_xact_lock(hashtext($1))', [`excalidraw:${documentId}`]);
      await database.get('SELECT document_id FROM collaboration_excalidraw_states WHERE document_id=$1 FOR UPDATE', [documentId]);
    }
  }
}
async function freshBirth(database: SqlConnection, stage: WorkspaceOperationOwnedCopyStage, receipt: NativeCopyReceipt, documentId?: string): Promise<void> {
  const xid = await database.get('SELECT (pg_catalog.pg_current_xact_id()::text::numeric % 4294967296)::text AS xid') as Row;
  if (documentId === undefined) {
    const ledger = await readNativeCopyPhaseLedgerOnConnection(database, stage);
    if (!ledger || ledger.xmin !== xid.xid || nativeCopyPhaseReceiptProof(ledger.receipt) !== nativeCopyPhaseReceiptProof(receipt)) copyPhaseChanged();
  } else {
    const ledger = await database.get(`SELECT xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE workspace_id=$1 AND operation_id=$2
      AND actor_user_id=$3 AND actor_session_id IS NOT DISTINCT FROM $4 AND request_fingerprint=$5 AND publication_fingerprint=$6`,
    [stage.identity.destinationWorkspaceId, stage.identity.operationId, stage.origin.actor.userId, stage.origin.actor.sessionId,
      receipt.requestFingerprint, stage.payloadSha256]) as Row | undefined;
    if (ledger?.xmin !== xid.xid) copyPhaseChanged();
  }
  const documents = documentId === undefined ? receipt.documents : receipt.documents.filter(document => document.clone.documentId === documentId);
  if (documentId !== undefined && documents.length !== 1) copyPhaseChanged();
  for (const document of documents) {
    const row = await database.get(`SELECT d.xmin::text AS document_xmin,s.xmin::text AS state_xmin,l.xmin::text AS lineage_xmin,
      d.workspace_id,d.organization_id,d.path,d.provider,d.status,d.yjs_state_lifecycle,d.lineage_id,
      s.room_owner_epoch,s.room_owner_token,s.room_owner_backend_pid,s.room_owner_backend_start,s.lifecycle_generation,
      l.workspace_id AS lineage_workspace,l.organization_id AS lineage_organization,l.path AS lineage_path,l.status AS lineage_status
      FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id
      JOIN file_collaboration_lineages l ON l.id=d.lineage_id WHERE d.id=$1`, [document.clone.documentId]) as Row | undefined;
    if (!row || row.document_xmin !== xid.xid || row.state_xmin !== xid.xid || row.lineage_xmin !== xid.xid
      || row.workspace_id !== stage.identity.destinationWorkspaceId || row.organization_id !== stage.origin.destinationScope.organizationId
      || row.path !== document.clone.path || row.provider !== 'yjs' || row.status !== 'active' || row.yjs_state_lifecycle !== 'initialized'
      || row.lineage_id !== document.clone.lineageId || Number(row.room_owner_epoch) !== 0 || row.room_owner_token !== null
      || row.room_owner_backend_pid !== null || row.room_owner_backend_start !== null || Number(row.lifecycle_generation) !== 1
      || row.lineage_workspace !== row.workspace_id || row.lineage_organization !== row.organization_id || row.lineage_path !== row.path
      || row.lineage_status !== 'active') copyPhaseChanged();
  }
}
async function phase<T>(database: SqlConnection, input: NativeCopyPhaseInput,
  operation: (captured: Captured) => Promise<T>, purpose: PhasePurpose = 'path'): Promise<T> {
  const captured = capture(input);
  if (executing.has(database)) copyPhaseChanged(); executing.add(database);
  try { return await withNativeCopyOriginalRecovery(database, captured, async () => {
    // Keep one genuine principal composition open for this caller-held TX.
    // Re-entering it for each small journal/link write repeats all auth/schema/
    // ACL capture and lock reads under the same five-second transaction budget.
    // Its real exit checks still run after every awaited domain step finishes;
    // no access survives this callback or the later filesystem interval.
    return current(database, captured, async access => {
      const frame: PhaseWitness = { database, identity: await witness(database), stageDigest: captured.stage.payloadSha256, stage: captured.stage,
        access, purpose, active: true };
      try { return await phaseContext.run(frame, () => withNativeCopyPhaseCompilation(captured.stage, async () => {
        await samePhase(database); await owner(database, captured.stage);
        const result = await operation(captured); await samePhase(database); await owner(database, captured.stage); return result;
      })); } finally { frame.active = false; }
    });
  }); } finally { executing.delete(database); }
}
async function existing(database: SqlConnection, input: Captured): Promise<NativeCopyPhaseResult | null> {
  const journal = await readNativeCopyPhaseJournalOnConnection(database, input.stage);
  const ledger = await readNativeCopyPhaseLedgerOnConnection(database, input.stage);
  const managed = input.stage.version === 4 ? await readOriginalExcalidrawCopyOnConnection(database, { stage: input.stage }) : null;
  if (!ledger) { if (managed || journal?.steps.length || journal?.status === 'completed') copyPhaseChanged(); return null; }
  if (!journal) copyPhaseChanged();
  if (input.stage.version === 4 && (!managed || managed.intent.nativeRequestFingerprint !== ledger.receipt.requestFingerprint
    || managed.intent.nativeReceiptProof !== nativeCopyPhaseReceiptProof(ledger.receipt)
    || input.assetOriginal !== undefined && !equal(input.assetOriginal, managed.intent.assetOriginal)
    || (journal.status === 'completed') !== (managed.receipt !== null))) copyPhaseChanged();
  const links = await readNativeCopyPhaseLinkReceiptsOnConnection(database, input.stage, ledger.receipt);
  const admissions = nativeCopyPhaseAdmissions(input.stage, ledger.receipt);
  const pathSteps = [...nativeCopyPhasePathSteps(input.stage), ...nativeCopyPhaseParentSteps(input.stage)];
  const paths = new Map(pathSteps.map(step => [step.stepKey, step]));
  const confirmations = new Map(links.map(link => [link.stepKey, link]));
  for (const step of journal.steps) {
    if (step.stepKey === NATIVE_COPY_COMPLETION_STEP_KEY) {
      if (step.phase !== 'link' || step.beforeFence !== nativeCopyPhaseCompletionFence({ canonicalRequestHash: input.stage.identity.canonicalRequestHash,
        planId: input.stage.plan.planId, stageDigest: input.stage.payloadSha256 }) || step.afterFence !== input.stage.payloadSha256
        || step.backupRef !== null || step.status === 'applied' && (!step.receiptJson
          || !equal(JSON.parse(step.receiptJson), nativeCopyPhaseCompletionReceipt(input.stage, ledger.receipt, admissions, ledger.createdAt, managed?.receipt)))) copyPhaseChanged();
      continue;
    }
    const path = paths.get(step.stepKey);
    if (path) {
      if (step.phase !== 'path' || step.beforeFence !== path.beforeFence || step.afterFence !== path.afterFence || step.backupRef !== null) copyPhaseChanged();
      if (step.status === 'applied') {
        if (!step.receiptJson) copyPhaseChanged();
        const data = JSON.parse(step.receiptJson) as Row;
        if (step.stepKey.startsWith('copy-parent:')) {
          if (Object.keys(data).sort().join(',') !== 'kind,parent,selectionIndex,version' || data.version !== 1 || data.kind !== 'native-copy-parent') copyPhaseChanged();
          const parent = assertNativeCopyPhaseParent(input.stage, data.selectionIndex as number, data.parent as PreparedWorkspacePathCopyParentReceipt);
          if (parent.stepKey !== step.stepKey) copyPhaseChanged();
        } else {
          const selectionIndex = nativeCopyPhasePathSteps(input.stage).findIndex(path => path.stepKey === step.stepKey);
          if (Object.keys(data).sort().join(',') !== 'kind,originalProof,receiptProof,selectionIndex,version' || data.version !== 1
            || data.kind !== 'native-copy-path' || data.selectionIndex !== selectionIndex || data.originalProof !== path.beforeFence
            || typeof data.receiptProof !== 'string' || !/^[a-f0-9]{64}$/u.test(data.receiptProof)) copyPhaseChanged();
        }
      } else if (step.receiptJson !== null) copyPhaseChanged();
      paths.delete(step.stepKey); continue;
    }
    const link = confirmations.get(step.stepKey);
    if (!link || step.phase !== 'link' || step.beforeFence !== proof({ stage: input.stage.payloadSha256,
      source: link.receipt.source, before: link.receipt.before }) || step.afterFence !== link.receiptProof || step.backupRef !== null) copyPhaseChanged();
    if (step.status === 'applied' && (!step.receiptJson || !equal(JSON.parse(step.receiptJson), { version: 1,
      kind: 'native-copy-link-confirmation', stageDigest: input.stage.payloadSha256, mutationId: link.mutationId,
      preparedProof: link.receipt.binding.authorizedPreparedProof, receiptProof: link.receiptProof }))) copyPhaseChanged();
    confirmations.delete(step.stepKey);
  }
  if (paths.size || journal.status === 'completed' && (confirmations.size || ledger.receipt.publicationStatus !== 'published'
    || journal.steps.length !== nativeCopyPhaseStepCount(input.stage) || journal.steps.some(step => step.status !== 'applied'))) copyPhaseChanged();
  for (const request of admissions) await reservation(database, request);
  return { disposition: journal.status === 'completed' ? 'completed' : 'already-prepared', operation: journal,
    nativeReceipt: ledger.receipt, admissions, linkReceipts: links, managedIntent: managed?.intent ?? null, managedReceipt: managed?.receipt ?? null };
}
/** B1 binds original paths, Yjs births, fixed Scene intents, fresh Yjs link
 * deltas and copy_replace reservations in one caller TX. No physical publication. */
export function prepareNativeCopyPhaseOnConnection(database: SqlConnection, input: NativeCopyPhaseInput): Promise<NativeCopyPhaseResult> {
  return phase(database, input, async captured => {
    const stage = captured.stage;
    const prior = await write(database, captured, () => existing(database, captured));
    if (prior) return prior;
    if (stage.version === 4 && !captured.assetOriginal) copyPhaseChanged();
    const header = await write(database, captured, () => readNativeCopyPhaseJournalOnConnection(database, stage));
    if (header && ['failed', 'recovery_required'].includes(header.status)) await write(database, captured,
      () => resumeWorkspaceOperationOnConnection(database, { operationId: stage.identity.operationId, expectedRevision: header.revision }));
    await write(database, captured, async access => {
      await fences(database, access, stage);
      await assertNativeCopyPhysicalStageOnConnection(database, stage);
      const normalize = (observation: Awaited<ReturnType<typeof readWorkspaceLinkSourceAuthorityOnConnection>>) => {
        if (observation.stage.workspaceId !== stage.identity.destinationWorkspaceId) return observation;
        const originals = new Set(stage.physical.flatMap(physical => physical.original.staging ? [physical.original.staging.relativePath] : []));
        const { stageProof: _oldProof, ...body } = observation.stage;
        const normalized = { ...body, scope: { ...body.scope, excludedPaths: body.scope.excludedPaths.filter(path => !originals.has(path)) } };
        return { ...observation, stage: { ...normalized, stageProof: workspaceSourceAuthorityStageProof(normalized) } };
      };
      if (stage.version === 4) {
        const source = normalize(await readWorkspaceCopySourceObservationOnConnection(database, access.sourceWorkspace));
        const destination = access.sourceWorkspace.workspaceId === access.destinationWorkspace.workspaceId ? source
          : normalize(await readWorkspaceCopySourceObservationOnConnection(database, access.destinationWorkspace));
        assertWorkspaceOperationManagedCopyPlanCurrent(stage.plan, { sourceScope: captureWorkspaceOperationJobScope(access.sourceWorkspace),
          destinationScope: captureWorkspaceOperationJobScope(access.destinationWorkspace), sourceObservation: source, destinationObservation: destination });
      } else {
        const source = normalize(await readWorkspaceLinkSourceAuthorityOnConnection(database, access.sourceWorkspace));
        const destination = access.sourceWorkspace.workspaceId === access.destinationWorkspace.workspaceId ? source
          : normalize(await readWorkspaceLinkSourceAuthorityOnConnection(database, access.destinationWorkspace));
        assertWorkspaceOperationNativeCopyPlanCurrent(stage.plan, { sourceScope: captureWorkspaceOperationJobScope(access.sourceWorkspace),
          destinationScope: captureWorkspaceOperationJobScope(access.destinationWorkspace), sourceObservation: source, destinationObservation: destination });
      }
    });
    if (stage.version !== 2) await write(database, captured, () => assertNativeCopyMetadataBeforeOnConnection(database, { stage }));
    await write(database, captured, () => prepareWorkspaceOperationOnConnection(database, { operationId: stage.identity.operationId,
      planId: stage.plan.planId, request: stage.request, actor: { type: stage.origin.actor.type, id: stage.origin.actor.userId },
      sourceWorkspaceId: stage.identity.sourceWorkspaceId, destinationWorkspaceId: stage.identity.destinationWorkspaceId,
      expectedStepCount: nativeCopyPhaseStepCount(stage) }));
    for (const step of [...nativeCopyPhasePathSteps(stage), ...nativeCopyPhaseParentSteps(stage)]) await write(database, captured,
      () => beginWorkspaceOperationStepOnConnection(database, { operationId: stage.identity.operationId, phase: 'path', ...step }));
    const records = new Map(stage.nativeRecords.map(record => [record.state.documentId, record]));
    const nativeReceipt = await write(database, captured, async access => {
      await fences(database, access, stage);
      return persistNativeWorkspaceCopiesOnConnection(database, { operationId: stage.identity.operationId,
        actorUserId: stage.origin.actor.userId, actorSessionId: stage.origin.actor.sessionId, kind: 'native_clone',
        sourceWorkspace: access.sourceWorkspace, targetWorkspace: access.destinationWorkspace,
        targetScopes: stage.plan.selections.map(selected => selected.destinationPath), expectedTargets: [], publicationFingerprint: stage.payloadSha256,
        ...(stage.version === 4 ? { deferredScenePaths: stage.plan.sceneCopyRequirements.map(required => required.destinationPath) } : {}),
        copies: stage.plan.nativePathPlan.pathMappings.filter(mapping => mapping.source.documentId !== null).map(mapping => ({
          source: records.get(mapping.source.documentId!) ?? copyPhaseChanged(), targetPath: mapping.destinationPath })) });
    });
    // A raced or foreign historical receipt cannot authorize fresh link writes.
    await freshBirth(database, stage, nativeReceipt);
    const managedIntent = stage.version === 4 ? await write(database, captured, () => prepareExcalidrawCopyIntentsOnConnection(database,
      { stage, nativeReceipt, assetOriginal: captured.assetOriginal! })) : null;
    nativeCopyPhaseAdmissions(stage, nativeReceipt); // Entire existing protocol budget, before any link write / FS.
    for (const link of nativeCopyPhaseExpectedLinks(stage, nativeReceipt)) await write(database, captured, async access => {
      await fences(database, access, stage); await freshBirth(database, stage, nativeReceipt, link.document.clone.documentId);
      const state = await loadCollaborationStateOnConnection(database, link.document.clone.documentId, true);
      const source = records.get(link.document.source.documentId);
      if (!state || !source) copyPhaseChanged();
      const prepared = prepareNativeCopyLinkUpdates({ sourceScope: stage.plan.sourceScope, destinationScope: stage.plan.destinationScope,
        source, clone: { lineageId: link.document.clone.lineageId, state }, receipt: link.document,
        recipes: stage.plan.nativePathPlan.mutations.filter(recipe => recipe.source.documentId === source.state.documentId
          && recipe.sourcePathAfter === link.document.clone.path), operationId: link.mutationId });
      if (!prepared.prepared) copyPhaseChanged();
      await persistPreparedNativeLinkMutationOnConnection(database, { workspace: access.destinationWorkspace, prepared: prepared.prepared,
        binding: { actorUserId: stage.origin.actor.userId, actorId: stage.origin.actor.actorId, actorType: stage.origin.actor.type,
          actorSessionId: stage.origin.actor.sessionId, requestId: link.mutationId, requestHash: stage.identity.canonicalRequestHash,
          authorizedPreparedProof: nativeLinkPreparedIntentProof(prepared.prepared) },
        validateAuthority: async () => { await owner(database, stage); await freshBirth(database, stage, nativeReceipt, link.document.clone.documentId);
          await readNativeCopyPhaseJournalOnConnection(database, stage); } });
    });
    const links = await readNativeCopyPhaseLinkReceiptsOnConnection(database, stage, nativeReceipt);
    const admissions = nativeCopyPhaseAdmissions(stage, nativeReceipt);
    for (const request of admissions) {
      await write(database, captured, () => reserveCollaborationAdmissionOnConnection(database, request));
      for (const document of request.expectedDocuments) await write(database, captured,
        () => proveCollaborationAdmissionQuiescenceOnConnection(database, request, document.documentId));
    }
    const operation = await readNativeCopyPhaseJournalOnConnection(database, stage) ?? copyPhaseChanged();
    return { disposition: 'prepared', operation, nativeReceipt, admissions, linkReceipts: links,
      managedIntent, managedReceipt: null };
  }, 'prepare');
}

export function recordNativeCopyParentOnConnection(database: SqlConnection,
  input: NativeCopyPhaseInput & Readonly<{ selectionIndex: number; receipt: PreparedWorkspacePathCopyParentReceipt }>): Promise<void> {
  const principal = captureMcpPrincipalField(input);
  const receipt = captureWorkspaceOperationNativePlanData(input.receipt, copyPhaseChanged) as PreparedWorkspacePathCopyParentReceipt;
  const selectionIndex = input.selectionIndex;
  return phase(database, { stage: input.stage, request: input.request, ...principal }, async captured => {
    const step = assertNativeCopyPhaseParent(captured.stage, selectionIndex, receipt);
    await write(database, captured, async () => {
      const prior = await existing(database, captured) ?? copyPhaseChanged();
      if (['failed', 'recovery_required'].includes(prior.operation.status)) await resumeWorkspaceOperationOnConnection(database,
        { operationId: captured.stage.identity.operationId, expectedRevision: prior.operation.revision });
      await finishWorkspaceOperationStepOnConnection(database, { operationId: captured.stage.identity.operationId,
        stepKey: step.stepKey, beforeFence: step.beforeFence, afterFence: step.afterFence,
        receipt: { version: 1, kind: 'native-copy-parent', selectionIndex, parent: receipt } });
    });
  });
}
function fingerprint(identity: PreparedPathCopyIdentity): string {
  const milliseconds = (text: string) => { const ns = BigInt(text); return Number(ns / BigInt(1_000_000_000)) * 1000 + Number(ns % BigInt(1_000_000_000)) / 1_000_000; };
  return `${identity.device}:${identity.inode}:${identity.size}:${milliseconds(identity.mtimeNs)}:${milliseconds(identity.ctimeNs)}`;
}
function physicalReceipts(stage: WorkspaceOperationOwnedCopyStage, input: readonly NativeCopyPhasePathReceipt[], requireAll = true): readonly NativeCopyPhasePathReceipt[] {
  const values = captureWorkspaceOperationNativePlanData(input, copyPhaseChanged) as NativeCopyPhasePathReceipt[];
  if (!Array.isArray(values) || (requireAll && values.length !== stage.physical.length)
    || new Set(values.map(value => value.selectionIndex)).size !== values.length) copyPhaseChanged();
  for (const { selectionIndex, receipt } of values) {
    const original = stage.physical[selectionIndex]?.original;
    if (!Number.isSafeInteger(selectionIndex) || selectionIndex < 0 || !original
      || Object.keys(receipt).sort().join(',') !== 'createdParents,observation,original,version'
      || receipt.version !== 1 || preparedWorkspacePathCopyProof(decodePreparedWorkspacePathCopyOriginal(receipt.original))
      !== preparedWorkspacePathCopyProof(original) || !Array.isArray(receipt.createdParents)) copyPhaseChanged();
    if (!original.staging) { if (!equal(receipt.observation, { kind: 'projection_absent' }) || receipt.createdParents.length) copyPhaseChanged(); continue; }
    if (Object.keys(receipt.observation).sort().join(',') !== 'copy,kind,method'
      || receipt.observation.kind !== 'published' || receipt.observation.method !== 'rename-no-replace') copyPhaseChanged();
    const observed = decodePreparedWorkspacePathCopyOriginal({ ...original, staging: { ...original.staging, payload: receipt.observation.copy } }).staging!.payload;
    const originalPayload = original.staging.payload;
    const root = originalPayload.kind === 'directory' ? originalPayload.entries[0].identity : originalPayload.identity;
    const currentPayload = observed.kind === 'directory' ? { ...observed, entries: observed.entries.map((entry, index) => index
      ? entry : { ...entry, identity: { ...entry.identity, ctimeNs: root.ctimeNs } }) }
      : { ...observed, identity: { ...observed.identity, ctimeNs: root.ctimeNs } };
    if (!equal(currentPayload, originalPayload)) copyPhaseChanged();
    for (const parent of receipt.createdParents) assertNativeCopyPhaseParent(stage, selectionIndex, parent);
  }
  return values;
}
function completedPaths(stage: WorkspaceOperationOwnedCopyStage, journal: WorkspaceOperationWithSteps,
  receipts: readonly NativeCopyPhasePathReceipt[], requireAll = true) {
  const required = new Set(receipts.map(receipt => receipt.selectionIndex));
  const births = nativeCopyPhaseParentSteps(stage).filter(parent => requireAll
    || parent.consumerSelectionIndexes.some(index => required.has(index))).map(expected => {
    const row = journal.steps.find(step => step.stepKey === expected.stepKey);
    if (!row || row.status !== 'applied' || !row.receiptJson || row.beforeFence !== expected.beforeFence || row.afterFence !== expected.afterFence) copyPhaseChanged();
    const data = JSON.parse(row.receiptJson) as { version: number; kind: string; selectionIndex: number; parent: PreparedWorkspacePathCopyParentReceipt };
    if (data.version !== 1 || data.kind !== 'native-copy-parent') copyPhaseChanged();
    assertNativeCopyPhaseParent(stage, data.selectionIndex, data.parent);
    return data.parent;
  });
  for (const value of receipts) for (const parent of value.receipt.createdParents) if (!births.some(birth => equal(birth, parent))) copyPhaseChanged();
  return births;
}

async function finishPath(database: SqlConnection, captured: Captured, value: NativeCopyPhasePathReceipt): Promise<void> {
  const stage = captured.stage, step = nativeCopyPhasePathSteps(stage)[value.selectionIndex];
  await write(database, captured, async () => {
    const journal = await readNativeCopyPhaseJournalOnConnection(database, stage) ?? copyPhaseChanged();
    if (['failed', 'recovery_required'].includes(journal.status)) await resumeWorkspaceOperationOnConnection(database,
      { operationId: stage.identity.operationId, expectedRevision: journal.revision });
    completedPaths(stage, journal, [value], false);
    await finishWorkspaceOperationStepOnConnection(database, { operationId: stage.identity.operationId,
      stepKey: step.stepKey, beforeFence: step.beforeFence, afterFence: step.afterFence,
      receipt: { version: 1, kind: 'native-copy-path', selectionIndex: value.selectionIndex,
        originalProof: preparedWorkspacePathCopyProof(value.receipt.original), receiptProof: proof(value.receipt) } });
  });
}
/** Durable producer acknowledgement before another physical selection consumes
 * its exact original birth. Actual FD publication stays with the fixed runner. */
export function recordNativeCopyPathOnConnection(database: SqlConnection,
  input: NativeCopyPhaseInput & NativeCopyPhasePathReceipt): Promise<void> {
  const principal = captureMcpPrincipalField(input);
  const stage = captureNativeCopyPhaseStage(input.stage);
  const value = physicalReceipts(stage, [{ selectionIndex: input.selectionIndex, receipt: input.receipt }], false)[0];
  return phase(database, { stage, request: input.request, ...principal }, async captured => {
    await write(database, captured, async () => { if (!await existing(database, captured)) copyPhaseChanged(); });
    await finishPath(database, captured, value);
  });
}

/** B2 consumes actual original-bound FD receipts, re-inventories the complete
 * graph on B, confirms existing link SQL receipts, publishes C3 and closes the
 * durable admission requests. It never prepares or applies a second link delta. */
export function completeNativeCopyPhaseOnConnection(database: SqlConnection,
  input: NativeCopyPhaseInput & Readonly<{ pathReceipts: readonly NativeCopyPhasePathReceipt[];
    assetReceipt?: ExcalidrawCopyAssetReceipt }>): Promise<NativeCopyPhaseCompletionResult> {
  const principal = captureMcpPrincipalField(input);
  const initialStage = captureNativeCopyPhaseStage(input.stage), receipts = physicalReceipts(initialStage, input.pathReceipts);
  const assetReceipt = input.assetReceipt === undefined ? undefined :
    captureWorkspaceOperationNativePlanData(input.assetReceipt, copyPhaseChanged) as ExcalidrawCopyAssetReceipt;
  if (initialStage.version !== 4 && assetReceipt !== undefined) copyPhaseChanged();
  return phase(database, { stage: initialStage, request: input.request, ...principal,
    ...(input.assetOriginal ? { assetOriginal: input.assetOriginal } : {}) }, async captured => {
    const stage = captured.stage;
    const before = await write(database, captured, () => existing(database, captured)) ?? copyPhaseChanged();
    if (before.disposition === 'completed') return { ...before, publication: 'historical' as const };
    const journal = await readNativeCopyPhaseJournalOnConnection(database, stage) ?? copyPhaseChanged();
    if (['failed', 'recovery_required'].includes(journal.status)) await write(database, captured,
      () => resumeWorkspaceOperationOnConnection(database, { operationId: stage.identity.operationId, expectedRevision: journal.revision }));
    const births = completedPaths(stage, journal, receipts);
    for (const value of receipts) await finishPath(database, captured, value);
    const managedReceipt = stage.version === 4 ? await write(database, captured, async access => {
      if (!before.managedIntent || !assetReceipt) copyPhaseChanged();
      await fences(database, access, stage);
      return commitExcalidrawCopiesOnConnection(database, { stage, intent: before.managedIntent,
        assetReceipt, pathReceipts: receipts });
    }) : null;
    await write(database, captured, async access => {
      await fences(database, access, stage);
      let observations: Awaited<ReturnType<typeof readWorkspaceLinkSourceAuthorityOnConnection>>[];
      let managedScenes: NativeCopyFinalManagedScenes | undefined;
      if (stage.version === 4) {
        if (!managedReceipt) copyPhaseChanged();
        const source = await readWorkspaceCopySourceObservationOnConnection(database, access.sourceWorkspace);
        const destination = access.sourceWorkspace.workspaceId === access.destinationWorkspace.workspaceId ? source
          : await readWorkspaceCopySourceObservationOnConnection(database, access.destinationWorkspace);
        const combined = source === destination ? [source] : [source, destination];
        observations = combined;
        managedScenes = { originalBindings: (stage.plan.sourceScope.workspaceId === stage.plan.destinationScope.workspaceId
          ? [stage.plan.sourceEvidence] : [stage.plan.sourceEvidence, stage.plan.destinationEvidence]).flatMap(evidence => evidence.sceneBindings),
        finalSnapshots: combined.flatMap(observation => observation.privateSceneSnapshots), receipt: managedReceipt };
      } else {
        const source = await readWorkspaceLinkSourceAuthorityOnConnection(database, access.sourceWorkspace);
        const destination = access.sourceWorkspace.workspaceId === access.destinationWorkspace.workspaceId ? source
          : await readWorkspaceLinkSourceAuthorityOnConnection(database, access.destinationWorkspace);
        observations = source === destination ? [source] : [source, destination];
      }
      const final = observations.map(observation => workspaceOperationNativePlanSnapshot(observation, copyPhaseChanged));
      const compiled = nativeCopyPhaseCompiler(stage), originalEntries = new Map(nativeCopyPhaseOriginals(stage).flatMap(snapshot => snapshot.namespace)
        .map(entry => [proof({ workspaceId: entry.workspaceId, identity: entry.identity }), entry]));
      const actualEntries = new Map(final.flatMap(snapshot => snapshot.namespace).map(entry => [JSON.stringify([entry.workspaceId, entry.path]), entry]));
      const physicalCopies: Array<{ entityKey: string; entry: NativeNamespaceEntry }> = [];
      for (const entity of compiled.finalNamespace) {
        if (entity.binding.kind !== 'unbound-copy' || entity.contentBasisProof !== null) continue;
        const original = originalEntries.get(entity.binding.sourceEntityKey) ?? copyPhaseChanged();
        if (original.filesystemIdentity === null && stage.version !== 4) continue;
        const selected = stage.physical.find(value => original.path === value.original.sourcePath || original.path.startsWith(value.original.sourcePath + '/'))
          ?? copyPhaseChanged();
        const receipt = receipts.find(value => value.selectionIndex === selected.selectionIndex)!.receipt;
        if (original.filesystemIdentity === null && !selected.original.staging) continue;
        if (receipt.observation.kind !== 'published') copyPhaseChanged();
        const payload = receipt.observation.copy, relative = original.path.slice(selected.original.sourcePath.length).replace(/^\//u, '');
        const node = payload.kind === 'directory' ? payload.entries.find(entry => entry.relativePath === relative) : relative === '' ? payload : undefined;
        if (!node && stage.version === 4 && original.filesystemIdentity === null && original.provider !== 'excalidraw') continue;
        const entry = actualEntries.get(JSON.stringify([entity.workspaceId, entity.path]));
        if (!node || !entry || entry.filesystemIdentity !== fingerprint(node.identity) || entry.documentId !== null) copyPhaseChanged();
        physicalCopies.push({ entityKey: entity.entityKey, entry });
      }
      const createdParents = births.map(birth => {
        const entry = actualEntries.get(JSON.stringify([stage.identity.destinationWorkspaceId, birth.relativePath]));
        if (!entry || entry.kind !== 'directory' || entry.documentId !== null
          || entry.filesystemIdentity?.split(':').slice(0, 2).join(':') !== `${birth.identity.device}:${birth.identity.inode}`) copyPhaseChanged();
        return entry;
      });
      const states = observations.flatMap(observation => [...observation.privateNativeStates]);
      assertNativeCopyFinalGraph({ compiled, originals: nativeCopyPhaseOriginals(stage), receipt: before.nativeReceipt, final, states, physicalCopies, createdParents,
        ...(managedScenes ? { managedScenes } : {}) });
      if (stage.version !== 2) for (const pathname of stage.metadata.exactVacancyPaths) {
        const entry = actualEntries.get(JSON.stringify([stage.identity.destinationWorkspaceId, pathname]));
        if (!entry || entry.kind !== 'directory' || entry.documentId !== null || stage.version === 3 && entry.filesystemIdentity !== null) copyPhaseChanged();
      }
      for (const link of before.linkReceipts) {
        const state = states.find(state => state.documentId === link.receipt.source.documentId) ?? copyPhaseChanged();
        const version = authoritativeNativeCollaborationSnapshot(state).version;
        if (version.stateProof !== link.receipt.after.stateProof || version.stateVector !== link.receipt.after.stateVector
          || version.documentSequence !== link.receipt.after.documentSequence || version.persistedAt !== link.receipt.after.persistedAt) copyPhaseChanged();
      }
    });
    const birth = stage.version !== 2 ? await write(database, captured, () => readNativeCopyPhaseLedgerOnConnection(database, stage)) : null;
    if (stage.version !== 2) {
      if (!birth) copyPhaseChanged();
      await write(database, captured, () => applyNativeCopyMetadataOnConnection(database, { stage, copyCreatedAt: birth.createdAt }));
    }
    for (const link of before.linkReceipts) {
      const beforeFence = proof({ stage: stage.payloadSha256, source: link.receipt.source, before: link.receipt.before });
      const afterFence = link.receiptProof;
      await write(database, captured, () => beginWorkspaceOperationStepOnConnection(database, { operationId: stage.identity.operationId,
        stepKey: link.stepKey, phase: 'link', beforeFence, afterFence }));
      await write(database, captured, () => finishWorkspaceOperationStepOnConnection(database, { operationId: stage.identity.operationId,
        stepKey: link.stepKey, beforeFence, afterFence, receipt: { version: 1, kind: 'native-copy-link-confirmation', stageDigest: stage.payloadSha256,
          mutationId: link.mutationId, preparedProof: link.receipt.binding.authorizedPreparedProof, receiptProof: link.receiptProof } }));
    }
    await write(database, captured, access => completeNativeCopyPublicationOnConnection(database, { workspace: access.destinationWorkspace,
      operationId: stage.identity.operationId, actorUserId: stage.origin.actor.userId, actorSessionId: stage.origin.actor.sessionId,
      requestFingerprint: before.nativeReceipt.requestFingerprint, publicationFingerprint: stage.payloadSha256 }));
    for (const request of before.admissions) {
      for (const document of request.expectedDocuments) await write(database, captured,
        () => proveCollaborationAdmissionQuiescenceOnConnection(database, request, document.documentId));
      await database.get('SELECT pg_advisory_xact_lock($1::bigint)', [collaborationAdmissionLockKey(stage.identity.destinationWorkspaceId)]);
      await executeCollaborationAdmissionHandoffOnConnection(database, request, { kind: 'apply',
        authorize: async supplied => { if (!equal(supplied, request)) copyPhaseChanged();
          await write(database, captured, async () => { await reservation(database, request); }); },
        prepare: async supplied => { if (supplied !== database) copyPhaseChanged();
          await write(database, captured, async access => {
            await reservation(database, request);
            // Generic room availability was checked before DA03. Its own real
            // document locks are now required by the borrowed handoff below.
            const scopes = [{ workspaceId: access.sourceWorkspace.workspaceId, paths: stage.plan.selections.map(selected => selected.sourcePath) },
              { workspaceId: access.destinationWorkspace.workspaceId, paths: stage.plan.selections.map(selected => selected.destinationPath) }]
              .sort((left, right) => left.workspaceId < right.workspaceId ? -1 : left.workspaceId > right.workspaceId ? 1 : 0);
            for (const scope of scopes) await lockFileCollaborationPaths(database, scope.workspaceId, scope.paths);
          }); },
        mutate: async supplied => { if (supplied !== database) copyPhaseChanged();
          return write(database, captured, async () => ({ kind: 'native-copy-publication', operationId: stage.identity.operationId,
            stageDigest: stage.payloadSha256, copyReceiptProof: nativeCopyPhaseReceiptProof(before.nativeReceipt), finalGraphProof: stage.plan.finalGraphProof })); } });
    }
    const completionFence = nativeCopyPhaseCompletionFence({ canonicalRequestHash: stage.identity.canonicalRequestHash,
      planId: stage.plan.planId, stageDigest: stage.payloadSha256 });
    await write(database, captured, () => beginWorkspaceOperationStepOnConnection(database, { operationId: stage.identity.operationId,
      stepKey: NATIVE_COPY_COMPLETION_STEP_KEY, phase: 'link', beforeFence: completionFence, afterFence: stage.payloadSha256 }));
    await write(database, captured, () => finishWorkspaceOperationStepOnConnection(database, { operationId: stage.identity.operationId,
      stepKey: NATIVE_COPY_COMPLETION_STEP_KEY, beforeFence: completionFence, afterFence: stage.payloadSha256,
      receipt: nativeCopyPhaseCompletionReceipt(stage, before.nativeReceipt, before.admissions, birth?.createdAt, managedReceipt) }));
    const operation = await write(database, captured, async () => {
      const completed = await completeWorkspaceOperationOnConnection(database, stage.identity.operationId);
      await notifyWorkspaceFileInvalidationOnConnection(database, stage.identity.destinationWorkspaceId);
      return completed;
    });
    return { ...before, disposition: 'completed', operation, nativeReceipt: { ...before.nativeReceipt, publicationStatus: 'published' },
      managedReceipt, publication: 'published' as const };
  }, 'completion');
}
