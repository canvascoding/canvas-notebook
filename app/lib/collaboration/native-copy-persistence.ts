import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { openDb, type SqlConnection } from '../db';
import { withBorrowedWriteTransaction } from '../db/borrowed-write-transaction';
import type { WorkspaceContext } from '../workspaces/types';
import { assertWorkspaceFileLifecycleSqlAvailable } from '../files/workspace-file-lifecycle-guard';
import { ensureActiveFileLineage, initializeCopiedFileCollaborationPathScopes,
  lockFileCollaborationPaths } from '../files/collaboration-repository';
import { authoritativeNativeCollaborationSnapshot } from './document-snapshot';
import { executeLifecycleTransaction } from './lifecycle-transaction';
import { cloneNativeCollaborationDocument, deserializeNativeRecoveryPayload, serializeNativeRecoveryPayload,
  NativeDocumentRecoveryError, type NativeRecoveryRecord } from './native-document-recovery';
import { loadCollaborationStateOnConnection, type PersistedCollaborationState } from './persistence';
import { isCanonicalAdmissionPath } from './room-admission-contract';
import { readWorkspaceDocumentCatalogue } from './workspace-document-catalogue';
import { Y } from './server-runtime';
import { withWorkspaceFileLifecycleCollaborationWrite } from './file-lifecycle-admission-context';
import { lockFileLifecycleCollaborationWriterAdmission } from './file-lifecycle-writer-admission';
import { assertCollaborationAdmissionOpen } from './room-admission';

export type CopyTargetExpectation = { documentId: string; path: string; authority: 'initialized' | 'pristine';
  lifecycleGeneration?: number; stateProof?: string };
export type NativeCopyDocumentReceipt = {
  version: 1;
  source: { documentId: string; lifecycleGeneration: number; stateProof: string; documentSequence: number };
  clone: { documentId: string; lineageId: string; path: string; lifecycleGeneration: 1; stateProof: string; initialSequence: 0 };
  blockIdMapping: Record<string, string>;
};
export type NativeCopyReceipt = { version: 1; operationId: string; workspaceId: string;
  requestFingerprint: string; documents: NativeCopyDocumentReceipt[];
  publicationStatus: 'native_committed' | 'published' | 'publication_failed' };
export type NativeCopyRequest = {
  operationId: string;
  actorUserId: string;
  actorSessionId?: string | null;
  kind: 'native_clone' | 'native_restore';
  sourceWorkspace: WorkspaceContext;
  targetWorkspace: WorkspaceContext;
  targetScopes: readonly string[];
  copies: readonly { source: NativeRecoveryRecord; targetPath: string }[];
  /** Exact catalogue observed before replacement, including pristine registry entries. */
  expectedTargets: readonly CopyTargetExpectation[];
  /** Hash of the caller's exact physical publication plan, retained before any physical write. */
  publicationFingerprint?: string;
  /** Recovery gate: an existing physical target may only resume an already committed request. */
  resumeOnly?: boolean;
};
type LedgerRow = { workspace_id: string; operation_id: string; organization_id: string | null;
  actor_user_id: string; actor_session_id: string | null; version: number; kind: string;
  request_fingerprint: string; private_result: Omit<NativeCopyReceipt, 'publicationStatus'>;
  scope_paths: string[]; publication_fingerprint: string | null;
  publication_status: NativeCopyReceipt['publicationStatus'] };

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const inScope = (path: string, scopes: readonly string[]) => scopes.some(scope => path === scope || path.startsWith(`${scope}/`));
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
function unavailable(): never { throw new NativeDocumentRecoveryError(); }
function assertAccess(input: NativeCopyRequest): void {
  if (!input.sourceWorkspace.permissions.canRead || !input.targetWorkspace.permissions.canWrite
    || !input.targetWorkspace.permissions.canRead
    || [input.sourceWorkspace, input.targetWorkspace].some(workspace => workspace.status !== undefined && workspace.status !== 'active')
    || !validId(input.actorUserId) || input.actorSessionId != null && !validId(input.actorSessionId)
    || !validId(input.operationId) || !['native_clone', 'native_restore'].includes(input.kind)
    || input.publicationFingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(input.publicationFingerprint)
    || !input.targetScopes.length || input.targetScopes.some(scope => !isCanonicalAdmissionPath(scope))
    || input.copies.some(copy => !isCanonicalAdmissionPath(copy.targetPath) || !inScope(copy.targetPath, input.targetScopes)
      || copy.source.state.workspaceId !== input.sourceWorkspace.workspaceId
      || copy.source.state.organizationId !== (input.sourceWorkspace.organizationId ?? null))
    || new Set(input.copies.map(copy => copy.targetPath)).size !== input.copies.length
    || input.kind === 'native_clone' && input.sourceWorkspace.workspaceId === input.targetWorkspace.workspaceId
      && input.copies.some(copy => inScope(copy.source.state.path, input.targetScopes))
    || input.kind === 'native_restore' && (input.sourceWorkspace.workspaceId !== input.targetWorkspace.workspaceId
      || input.sourceWorkspace.organizationId !== input.targetWorkspace.organizationId)) unavailable();
}

async function ledger(connection: SqlConnection, workspaceId: string, operationId: string): Promise<LedgerRow | undefined> {
  return await connection.get(`SELECT * FROM collaboration_native_copy_receipts WHERE workspace_id=$1 AND operation_id=$2`,
  [workspaceId, operationId]) as LedgerRow | undefined;
}

async function validateCommittedReceipt(connection: SqlConnection, input: NativeCopyRequest,
  fingerprint: string, row: LedgerRow): Promise<NativeCopyReceipt> {
  if (row.version !== 1 || row.workspace_id !== input.targetWorkspace.workspaceId || row.operation_id !== input.operationId
    || row.organization_id !== (input.targetWorkspace.organizationId ?? null) || row.actor_user_id !== input.actorUserId
    || row.actor_session_id !== (input.actorSessionId ?? null) || row.kind !== input.kind || row.request_fingerprint !== fingerprint
    || row.publication_fingerprint !== (input.publicationFingerprint ?? null)
    || JSON.stringify(row.scope_paths) !== JSON.stringify(input.targetScopes)
    || !['native_committed', 'published', 'publication_failed'].includes(row.publication_status)
    || !row.private_result || row.private_result.version !== 1 || row.private_result.requestFingerprint !== fingerprint
    || row.private_result.operationId !== input.operationId || row.private_result.workspaceId !== input.targetWorkspace.workspaceId
    || !Array.isArray(row.private_result.documents) || row.private_result.documents.length !== input.copies.length) unavailable();
  const expected = new Map(input.copies.map(copy => [copy.targetPath, copy]));
  const documents = await readWorkspaceDocumentCatalogue(connection, input.targetWorkspace, { paths: input.targetScopes });
  for (const receipt of row.private_result.documents) {
    if (!receipt || typeof receipt !== 'object' || !receipt.clone || !receipt.source || !receipt.blockIdMapping
      || typeof receipt.blockIdMapping !== 'object' || Array.isArray(receipt.blockIdMapping)
      || !validId(receipt.clone.documentId) || !validId(receipt.clone.lineageId)) unavailable();
    const copy = expected.get(receipt.clone.path);
    const document = documents.find(document => document.id === receipt.clone.documentId && document.path === receipt.clone.path);
    const state = await loadCollaborationStateOnConnection(connection, receipt.clone.documentId);
    const lineage = await connection.get(`SELECT id FROM file_collaboration_lineages WHERE id=$1 AND workspace_id=$2
      AND path=$3 AND organization_id IS NOT DISTINCT FROM $4 AND status='active'`,
    [receipt.clone.lineageId, input.targetWorkspace.workspaceId, receipt.clone.path, input.targetWorkspace.organizationId ?? null]);
    const source = copy && authoritativeNativeCollaborationSnapshot(copy.source.state);
    if (!copy || !source || receipt.version !== 1 || receipt.clone.lifecycleGeneration !== 1 || receipt.clone.initialSequence !== 0
      || receipt.source.documentId !== source.documentId || receipt.source.lifecycleGeneration !== source.lifecycleGeneration
      || receipt.source.stateProof !== source.version.stateProof || receipt.source.documentSequence !== source.version.documentSequence
      || !document || document.authority !== 'initialized' || document.lineage_id !== receipt.clone.lineageId || !lineage
      || !state || state.workspaceId !== input.targetWorkspace.workspaceId || state.organizationId !== (input.targetWorkspace.organizationId ?? null)
      || state.path !== receipt.clone.path || state.lifecycleGeneration !== receipt.clone.lifecycleGeneration || state.documentSequence < receipt.clone.initialSequence
      || !/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u.test(receipt.clone.stateProof)) unavailable();
    if (row.publication_status !== 'published') {
      try { authoritativeNativeCollaborationSnapshot(state); }
      catch { unavailable(); }
    }
    const ids: string[] = [];
    if (source.content.kind === 'rich_text') {
      const visit = (node: typeof source.content.document) => {
        if (node.type !== 'doc' && node.type !== 'text') ids.push(node.attrs?.id as string);
        for (const child of node.content ?? []) visit(child);
      }; visit(source.content.document);
    }
    const mapping = Object.entries(receipt.blockIdMapping);
    if (mapping.length !== ids.length || new Set(mapping.map(([, value]) => value)).size !== mapping.length
      || mapping.some(([key, value]) => !ids.includes(key) || !validId(value) || ids.includes(value))) unavailable();
    expected.delete(receipt.clone.path);
  }
  if (expected.size) unavailable();
  return { ...row.private_result, publicationStatus: row.publication_status };
}

async function assertExpectedTargets(connection: SqlConnection, input: NativeCopyRequest): Promise<void> {
  const documents = await readWorkspaceDocumentCatalogue(connection, input.targetWorkspace, { paths: input.targetScopes });
  if (documents.length !== input.expectedTargets.length) unavailable();
  for (const document of documents) {
    const expected = input.expectedTargets.find(target => target.documentId === document.id && target.path === document.path);
    if (!expected || expected.authority !== document.authority) unavailable();
    if (document.authority === 'initialized') {
      const state = await loadCollaborationStateOnConnection(connection, document.id);
      if (!state || expected.lifecycleGeneration !== state.lifecycleGeneration
        || expected.stateProof !== authoritativeNativeCollaborationSnapshot(state).version.stateProof) unavailable();
    }
  }
}

async function insertVirginNativeDocument(connection: SqlConnection, workspace: WorkspaceContext,
  state: PersistedCollaborationState, lineageId: string): Promise<void> {
  const scope = { documentId: state.documentId, workspaceId: state.workspaceId, organizationId: state.organizationId,
    path: state.path, representation: state.representation, lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion };
  await withWorkspaceFileLifecycleCollaborationWrite(scope, async () => {
    const query = async (sql: string, values?: unknown[]) => await connection.all(sql, values) as Array<Record<string, unknown>>;
    // Only an exact verified virgin writer may inherit the held dedicated-session admission guard.
    await lockFileLifecycleCollaborationWriterAdmission(query, scope);
    await assertCollaborationAdmissionOpen(query, scope);
    await connection.run(`INSERT INTO collaboration_documents (id,lineage_id,organization_id,customer_id,project_id,
      workspace_id,workspace_type,path,provider,state_version,snapshot_revision_id,status,created_at,updated_at,yjs_state_lifecycle)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'yjs',0,NULL,'active',$9,$9,'initialized')`,
    [state.documentId, lineageId, state.organizationId, workspace.customerId ?? null, workspace.projectId ?? null,
      state.workspaceId, workspace.workspaceType, state.path, state.persistedAt]);
    await connection.run(`INSERT INTO collaboration_yjs_states (document_id,workspace_id,organization_id,path,representation,
      lifecycle_generation,schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpointed_at,checkpoint_sequence,
      canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
      VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,0,$9,NULL,0,NULL,NULL,$10,$11,0,'active')`,
    [state.documentId, state.workspaceId, state.organizationId, state.path, state.representation, state.schemaVersion,
      Buffer.from(state.yjsState), Buffer.from(state.stateVector), state.persistedAt, state.newlineStyle, state.hasBom ? 1 : 0]);
  });
}

export type NativeCopyPublicationRequest = {
  workspace: WorkspaceContext; operationId: string; actorUserId: string; actorSessionId?: string | null;
  requestFingerprint: string; publicationFingerprint: string;
};

type CapturedNativeCopy = { input: NativeCopyRequest; fingerprint: string };
function captureNativeCopyRequest(input: NativeCopyRequest): CapturedNativeCopy {
  assertAccess(input);
  // Capture all binary input before asynchronous admission. No mutable caller state crosses the fence.
  const frozen = deserializeNativeRecoveryPayload(serializeNativeRecoveryPayload(input.copies.map(copy => copy.source)));
  input = { ...input, sourceWorkspace: structuredClone(input.sourceWorkspace), targetWorkspace: structuredClone(input.targetWorkspace),
    targetScopes: [...new Set(input.targetScopes)].sort(), expectedTargets: structuredClone(input.expectedTargets),
    copies: input.copies.map((copy, index) => ({ targetPath: copy.targetPath, source: frozen[index] })) };
  const fingerprint = digest(JSON.stringify({ version: 1, kind: input.kind, workspaceId: input.targetWorkspace.workspaceId,
    organizationId: input.targetWorkspace.organizationId ?? null, scopes: input.targetScopes,
    expectedTargets: input.expectedTargets, publicationFingerprint: input.publicationFingerprint, copies: input.copies.map(copy => ({ targetPath: copy.targetPath,
      sourceDocumentId: copy.source.state.documentId, sourceLineageId: copy.source.lineageId,
      sourceWorkspaceId: copy.source.state.workspaceId, sourceOrganizationId: copy.source.state.organizationId,
      sourcePath: copy.source.state.path, sourceRepresentation: copy.source.state.representation, sourceSchemaVersion: copy.source.state.schemaVersion,
      sourceGeneration: copy.source.state.lifecycleGeneration, sourceSequence: copy.source.state.documentSequence,
      nativeHash: digest(copy.source.state.yjsState), newlineStyle: copy.source.state.newlineStyle, hasBom: copy.source.state.hasBom })) }));
  return { input, fingerprint };
}

async function persistCapturedNativeWorkspaceCopiesOnConnection(connection: SqlConnection,
  captured: CapturedNativeCopy): Promise<NativeCopyReceipt> {
  const { input, fingerprint } = captured;
  const existing = await ledger(connection, input.targetWorkspace.workspaceId, input.operationId);
  if (existing) return validateCommittedReceipt(connection, input, fingerprint, existing);
  if (input.resumeOnly) unavailable();
  const scopes = [{ workspaceId: input.targetWorkspace.workspaceId, paths: [...input.targetScopes] }];
  if (input.kind === 'native_clone') scopes.push({ workspaceId: input.sourceWorkspace.workspaceId,
    paths: input.copies.map(copy => copy.source.state.path) });
  scopes.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
  for (const scope of scopes) if (scope.paths.length) {
    await assertWorkspaceFileLifecycleSqlAvailable(connection, scope.workspaceId, scope.paths);
    await lockFileCollaborationPaths(connection, scope.workspaceId, scope.paths);
  }
  // Recheck after acquiring the shared scopes; a racing same operation may have committed while waiting.
  const raced = await ledger(connection, input.targetWorkspace.workspaceId, input.operationId);
  if (raced) return validateCommittedReceipt(connection, input, fingerprint, raced);
  await assertExpectedTargets(connection, input);
  const sourceCatalogue = input.kind === 'native_clone' && input.copies.length
    ? await readWorkspaceDocumentCatalogue(connection, input.sourceWorkspace, { paths: input.copies.map(copy => copy.source.state.path) }) : [];
  if (input.kind === 'native_clone') for (const copy of input.copies) {
    const sourceDocument = sourceCatalogue.find(document => document.id === copy.source.state.documentId);
    const current = await loadCollaborationStateOnConnection(connection, copy.source.state.documentId);
    const expected = authoritativeNativeCollaborationSnapshot(copy.source.state);
    if (!sourceDocument || sourceDocument.authority !== 'initialized' || sourceDocument.lineage_id !== copy.source.lineageId
      || !current || current.workspaceId !== expected.workspaceId || current.organizationId !== expected.organizationId
      || current.path !== expected.path || current.lifecycleGeneration !== expected.lifecycleGeneration
      || authoritativeNativeCollaborationSnapshot(current).version.stateProof !== expected.version.stateProof) unavailable();
  }
  const now = Date.now();
  await initializeCopiedFileCollaborationPathScopes(connection, { workspace: input.targetWorkspace,
    paths: [...input.targetScopes], nowMs: now, createLineageId: () => `file-lineage-${randomUUID()}` });
  const receipts: NativeCopyDocumentReceipt[] = [];
  for (const copy of input.copies) {
    const source = authoritativeNativeCollaborationSnapshot(copy.source.state);
    const cloned = cloneNativeCollaborationDocument(copy.source.state);
    try {
      const lineage = await ensureActiveFileLineage(connection, { id: `file-lineage-${randomUUID()}`,
        workspace: input.targetWorkspace, path: copy.targetPath, nowMs: now });
      const documentId = `collab-${randomUUID()}`;
      const state: PersistedCollaborationState = { ...copy.source.state, documentId, workspaceId: input.targetWorkspace.workspaceId,
        organizationId: input.targetWorkspace.organizationId ?? null, path: copy.targetPath, lifecycleGeneration: 1,
        yjsState: Y.encodeStateAsUpdate(cloned.doc), stateVector: Y.encodeStateVector(cloned.doc), documentSequence: 0,
        persistedAt: now, checkpointedAt: null, checkpointSequence: 0, canonicalHash: null, serializedHash: null,
        degraded: false, status: 'active', projectionError: undefined, projectionFinalized: false };
      const native = authoritativeNativeCollaborationSnapshot(state);
      await insertVirginNativeDocument(connection, input.targetWorkspace, state, lineage.id);
      receipts.push({ version: 1, source: { documentId: source.documentId, lifecycleGeneration: source.lifecycleGeneration,
        stateProof: source.version.stateProof, documentSequence: source.version.documentSequence },
      clone: { documentId, lineageId: lineage.id, path: copy.targetPath, lifecycleGeneration: 1,
        stateProof: native.version.stateProof, initialSequence: 0 }, blockIdMapping: cloned.blockIdMapping });
    } finally { cloned.doc.destroy(); }
  }
  const result: Omit<NativeCopyReceipt, 'publicationStatus'> = { version: 1, operationId: input.operationId,
    workspaceId: input.targetWorkspace.workspaceId, requestFingerprint: fingerprint, documents: receipts };
  const privateResult = JSON.stringify(result);
  if (Buffer.byteLength(privateResult) > 8 * 1024 * 1024) unavailable();
  await connection.run(`INSERT INTO collaboration_native_copy_receipts (workspace_id,operation_id,organization_id,
    actor_user_id,actor_session_id,version,kind,request_fingerprint,scope_paths,private_result,created_at,publication_fingerprint)
    VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,
  [input.targetWorkspace.workspaceId, input.operationId, input.targetWorkspace.organizationId ?? null, input.actorUserId,
    input.actorSessionId ?? null, input.kind, fingerprint, JSON.stringify(input.targetScopes), privateResult, now, input.publicationFingerprint ?? null]);
  // Return the exact JSON shape persisted in jsonb, including ordinary mapping objects on retries.
  return { ...JSON.parse(privateResult) as typeof result, publicationStatus: 'native_committed' as const };
}

function captureNativeCopyPublication(input: NativeCopyPublicationRequest): NativeCopyPublicationRequest {
  input = { ...input, workspace: structuredClone(input.workspace) };
  if (!input.workspace.permissions.canWrite || input.workspace.status !== undefined && input.workspace.status !== 'active'
    || !validId(input.operationId) || !validId(input.actorUserId)
    || input.actorSessionId != null && !validId(input.actorSessionId)
    || !/^[a-f0-9]{64}$/u.test(input.requestFingerprint) || !/^[a-f0-9]{64}$/u.test(input.publicationFingerprint)) unavailable();
  return input;
}

async function verifyNativeCopyPublicationOnConnection(connection: SqlConnection,
  input: NativeCopyPublicationRequest, requirePublished = false): Promise<void> {
  const row = await connection.get(`SELECT * FROM collaboration_native_copy_receipts
    WHERE workspace_id=$1 AND operation_id=$2${requirePublished ? '' : ' FOR UPDATE'}`,
  [input.workspace.workspaceId, input.operationId]) as LedgerRow | undefined;
  if (!row || row.version !== 1 || row.organization_id !== (input.workspace.organizationId ?? null)
    || row.actor_user_id !== input.actorUserId || row.actor_session_id !== (input.actorSessionId ?? null)
    || row.request_fingerprint !== input.requestFingerprint || row.publication_fingerprint !== input.publicationFingerprint
    || !Array.isArray(row.scope_paths) || !row.scope_paths.length || row.scope_paths.some(path => !isCanonicalAdmissionPath(path))
    || requirePublished && row.publication_status !== 'published') unavailable();
  if (!requirePublished) {
    await assertWorkspaceFileLifecycleSqlAvailable(connection, input.workspace.workspaceId, row.scope_paths);
    await lockFileCollaborationPaths(connection, input.workspace.workspaceId, row.scope_paths);
  }
  for (const receipt of row.private_result.documents) {
    const current = await connection.get(`SELECT s.document_id FROM collaboration_yjs_states s
      JOIN collaboration_documents d ON d.id=s.document_id JOIN file_collaboration_lineages l ON l.id=d.lineage_id
      WHERE s.document_id=$1 AND s.workspace_id=$2 AND s.organization_id IS NOT DISTINCT FROM $3 AND s.path=$4
        AND s.lifecycle_generation=$5 AND s.status='active' AND d.status='active' AND d.path=s.path
        AND d.workspace_id=s.workspace_id AND d.organization_id IS NOT DISTINCT FROM s.organization_id
        AND l.id=$6 AND l.status='active' AND l.path=s.path AND l.workspace_id=s.workspace_id
        AND l.organization_id IS NOT DISTINCT FROM s.organization_id`,
    [receipt.clone.documentId, input.workspace.workspaceId, input.workspace.organizationId ?? null,
      receipt.clone.path, receipt.clone.lifecycleGeneration, receipt.clone.lineageId]);
    if (!current) unavailable();
    const state = await loadCollaborationStateOnConnection(connection, receipt.clone.documentId);
    if (!state) unavailable();
    try { authoritativeNativeCollaborationSnapshot(state); }
    catch { unavailable(); }
  }
}

async function completeCapturedNativeCopyPublicationOnConnection(connection: SqlConnection,
  input: NativeCopyPublicationRequest): Promise<void> {
  await verifyNativeCopyPublicationOnConnection(connection, input);
  await connection.run(`UPDATE collaboration_native_copy_receipts SET publication_status='published'
    WHERE workspace_id=$1 AND operation_id=$2 AND request_fingerprint=$3 AND publication_fingerprint=$4`,
  [input.workspace.workspaceId, input.operationId, input.requestFingerprint, input.publicationFingerprint]);
}

function withBorrowedNativeCopyTransaction<T>(database: SqlConnection, operation: () => Promise<T>): Promise<T> {
  return withBorrowedWriteTransaction(database, operation, () => new NativeDocumentRecoveryError());
}

/** Borrowed mechanical clone phase on the caller's actual RC/RW connection/TX.
 * Captures bytes and request primitives before awaiting. Never checks out,
 * controls/ends a transaction, closes B, sets timeouts or publishes projections.
 * Caller owns current rights, original request pins, statement/lock bounds,
 * lifecycle/room fences, rollback on ANY error and confirmed COMMIT/recovery.
 * The returned initial receipt is not proof that this transaction committed. */
export async function persistNativeWorkspaceCopiesOnConnection(database: SqlConnection,
  input: NativeCopyRequest): Promise<NativeCopyReceipt> {
  const captured = captureNativeCopyRequest(input);
  return withBorrowedNativeCopyTransaction(database, () => persistCapturedNativeWorkspaceCopiesOnConnection(database, captured));
}

/** Borrowed mechanical publication-receipt update, with the same original
 * current-document checks. Caller verifies exact physical publication and owns
 * the actual RC/RW B, fences, rollback and confirmed COMMIT/recovery. No returned
 * value authorizes another write or proves the caller's future COMMIT. */
export async function completeNativeCopyPublicationOnConnection(database: SqlConnection,
  input: NativeCopyPublicationRequest): Promise<void> {
  const captured = captureNativeCopyPublication(input);
  return withBorrowedNativeCopyTransaction(database, () => completeCapturedNativeCopyPublicationOnConnection(database, captured));
}

/** Caller owns physical publication and retains the existing source/target lifecycle guards.
 * This capability commits fresh native identity and its private receipt atomically, never via Markdown. */
export async function persistNativeWorkspaceCopies(input: NativeCopyRequest,
  openConnection: () => Promise<SqlConnection> = openDb): Promise<NativeCopyReceipt> {
  const captured = captureNativeCopyRequest(input);
  return executeLifecycleTransaction({
    openConnection,
    execute: async connection => {
      await connection.run("SET LOCAL statement_timeout='5s'");
      await connection.run("SET LOCAL lock_timeout='4s'");
      return persistCapturedNativeWorkspaceCopiesOnConnection(connection, captured);
    },
    recoverCommitted: async (_receipt, commitError) => {
      const connection = await openConnection();
      try {
        assertAccess(captured.input);
        const committed = await ledger(connection, captured.input.targetWorkspace.workspaceId, captured.input.operationId);
        if (!committed) throw commitError;
        return await validateCommittedReceipt(connection, captured.input, captured.fingerprint, committed);
      } finally { await connection.close(); }
    },
  });
}

/** Caller verifies the exact physical plan before completion and retains its lifecycle guard.
 * This journal update never republishes bytes or creates another native document. */
export async function completeNativeCopyPublication(input: NativeCopyPublicationRequest,
  openConnection: () => Promise<SqlConnection> = openDb): Promise<void> {
  const captured = captureNativeCopyPublication(input);
  await executeLifecycleTransaction({ openConnection,
    execute: connection => completeCapturedNativeCopyPublicationOnConnection(connection, captured),
    recoverCommitted: async (_value, error) => {
      const connection = await openConnection();
      try { await verifyNativeCopyPublicationOnConnection(connection, captured, true); }
      catch { throw error; }
      finally { await connection.close(); }
    },
  });
}
