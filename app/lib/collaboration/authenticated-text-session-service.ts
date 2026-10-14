import 'server-only';

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getPostgresRuntimeQueryable, openDb, type SqlConnection } from '../db';
import { WorkspaceOriginalFileSourceError } from '../files/workspace-original-file-source';
import { WorkspaceRequestPrincipalError, withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection } from '../workspaces/request-principal';
import { requireRequestWorkspace } from '../workspaces/request';
import { analyzeMarkdownRichMode } from '../markdown/rich-markdown-codec';
import {
  captureAuthenticatedNativeSessionTransportOnConnection, disposeAuthenticatedNativeSessionTransport,
  withAuthenticatedNativeSessionTransportOnConnection, type AuthenticatedNativeSessionTransport,
} from './authenticated-native-session-transport';
import {
  assertExistingNativeCollaborationSessionCurrentOnConnection, assertReadOnlyNativeSessionDiagnosisCurrentOnConnection,
  inspectExistingNativeCollaborationSessionOnConnection, NativeSessionStateReaderError,
  withAuthenticatedNativeSessionDiagnosisOnConnection, type ExistingNativeSessionIdentity,
  type ExistingNativeSessionSnapshot, type ExistingNativeSessionRequestAccess,
} from './native-session-state-reader';
import { MarkdownFileImportError } from './markdown-file-import';
import { persistPristineOriginalWorkspaceFileForWrite, type PristineOriginalWorkspaceFileRequest,
  type PristineOriginalRequestScopeExpectation } from './markdown-file-import-persistence';
import { collaborationAdmissionLockKey } from './room-admission-contract';
import { readWorkspaceDocumentCatalogue } from './workspace-document-catalogue';
import { CollaborationSessionError, parseCollaborationSessionRequest, type CollaborationSessionGrant,
  type CollaborationSessionRequest } from './session-service';
import { supportsBlockTreeCollaboration, type TextCollaborationRepresentation } from './types';
import type { RichMigrationResult } from './representation-migration-contract';
import { CollaborationRepresentationMigrationError } from './persistence';
import { advanceAuthenticatedRichRepresentationMigration, changeAuthenticatedCollaborationRepresentation } from './representation-migration';
import { materializeCollaborationCheckpoint } from './checkpoint';

type TextRequest = Extract<CollaborationSessionRequest, { provider: 'yjs' }>;
type Input = { request: NextRequest; workspaceId: string; sessionRequest: TextRequest; permission: 'read' | 'write' };
export type AuthenticatedTextSessionIdentity = Readonly<{ userId: string; sessionId: string;
  workspaceId: string; organizationId: string | null }>;
/** Private publication seam. A ticket owner adopts ONLY the opaque transport,
 * after every Principal/native capability and SQL connection has closed. */
export type AuthenticatedTextSessionPublication = Readonly<{ grant: CollaborationSessionGrant;
  identity: AuthenticatedTextSessionIdentity;
  takeTransport: (rollbackAdoption: () => void | Promise<void>) => AuthenticatedNativeSessionTransport }>;
type Observation = { grant: CollaborationSessionGrant; identity: AuthenticatedTextSessionIdentity;
  native: ExistingNativeSessionIdentity; target: TextCollaborationRepresentation; normalizable: boolean };
type ReadPhase = { retryable: boolean; entered: boolean };
// Only this service's confirmed read rollback/close can certify contention.
// A wire code, caller exception, final check or unconfirmed COMMIT cannot.
const cleanReadContention = new WeakSet<WorkspaceRequestPrincipalError>();

export class AuthenticatedTextSessionError extends Error {
  constructor(readonly code: 'NATIVE_SESSION_INVALID_REQUEST' | 'NATIVE_SESSION_INITIALIZATION_REQUIRED'
    | 'NATIVE_SESSION_COMMIT_UNCONFIRMED' | 'NATIVE_SESSION_PUBLICATION_CLOSED', readonly status: 400 | 409 | 503) {
    super(code); this.name = 'AuthenticatedTextSessionError';
  }
}

function identity(snapshot: ExistingNativeSessionSnapshot): ExistingNativeSessionIdentity {
  const { documentId, lineageId, workspaceId, organizationId, path, lifecycleGeneration, representation, schemaVersion } = snapshot;
  return Object.freeze({ documentId, lineageId, workspaceId, organizationId, path, lifecycleGeneration, representation, schemaVersion });
}
function requestIdentity(access: ExistingNativeSessionRequestAccess): AuthenticatedTextSessionIdentity {
  return Object.freeze({ userId: access.userId, sessionId: access.sessionId,
    workspaceId: access.workspace.workspaceId, organizationId: access.workspace.organizationId ?? null });
}
async function assertRequestScope(connection: SqlConnection, expected: PristineOriginalRequestScopeExpectation,
  access: ExistingNativeSessionRequestAccess): Promise<void> {
  await access.assertCurrent(); const workspace = access.workspace;
  if (access.userId !== expected.userId || access.sessionId !== expected.sessionId
    || ['workspaceId', 'workspaceType', 'organizationId', 'projectId', 'customerId', 'ownerUserId', 'rootPath', 'rootRelativePath', 'legacy', 'status']
      .some(key => (Reflect.get(workspace, key) ?? null) !== Reflect.get(expected, key))) throw new NativeSessionStateReaderError('NATIVE_SESSION_SCOPE_CHANGED');
  const row = await connection.get(`SELECT current_schema() AS schema,to_regnamespace(current_schema())::oid::bigint AS schema_oid,
    (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid,
    current_setting('search_path') AS search_path,
    w.id,w.type,w.organization_id,w.project_id,w.customer_id,w.owner_user_id,w.root_relative_path,w.status
    FROM canvas_workspaces w WHERE w.id=$1`, [expected.workspaceId]) as Record<string, unknown> | undefined;
  if (!row || row.schema !== expected.schema || Number(row.schema_oid) !== expected.schemaOid || Number(row.database_oid) !== expected.databaseOid
    || row.id !== expected.workspaceId || row.type !== expected.workspaceType || row.organization_id !== expected.organizationId
    || row.project_id !== expected.projectId || row.customer_id !== expected.customerId || row.owner_user_id !== expected.ownerUserId
    || row.root_relative_path !== expected.rootRelativePath || row.status !== expected.status
    || row.search_path !== expected.searchPath) throw new NativeSessionStateReaderError('NATIVE_SESSION_SCOPE_CHANGED');
}
/** An actual request/realm observation, never a permission capability. Capture
 * it once before retryable B so a failed first phase cannot reset the origin. */
async function observeRequestOrigin(request: NextRequest, workspaceId: string,
  permission: 'read' | 'write'): Promise<PristineOriginalRequestScopeExpectation> {
  const result = await requireRequestWorkspace(request, { workspaceId, permissions: permission === 'write' ? 'canWrite' : 'canRead' });
  if (result.response) {
    if (result.response.status === 500) throw new WorkspaceRequestPrincipalError('PRINCIPAL_WORKSPACE_UNCONFIRMED');
    throw new WorkspaceRequestPrincipalError(result.response.status === 401 ? 'PRINCIPAL_AUTH_REVOKED' : 'PRINCIPAL_ACCESS_DENIED');
  }
  const workspace = result.workspace, userId = result.session.user.id, sessionId = result.session.session.id;
  const runtime = getPostgresRuntimeQueryable();
  if (!runtime || !userId || !sessionId || workspace.legacy || workspace.status !== 'active'
    || workspace.workspaceId !== workspaceId || !workspace.permissions.canRead
    || !workspace.permissions[permission === 'write' ? 'canWrite' : 'canRead']) throw new WorkspaceRequestPrincipalError('PRINCIPAL_INVALID');
  // Capture primitives before the realm await: a later mutable resolver object
  // must never redefine which workspace/root this original request selected.
  const scope = Object.freeze({ userId, sessionId, workspaceId, workspaceType: workspace.workspaceType,
    organizationId: workspace.organizationId ?? null, projectId: workspace.projectId ?? null,
    customerId: workspace.customerId ?? null, ownerUserId: workspace.ownerUserId ?? null,
    rootPath: workspace.rootPath, rootRelativePath: workspace.rootRelativePath!, legacy: false as const, status: 'active' as const });
  const realm = (await runtime.query(`SELECT current_schema() AS schema,to_regnamespace(current_schema())::oid::bigint AS schema_oid,
    (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid,
    current_setting('search_path') AS search_path`)).rows[0];
  if (!realm || typeof realm.schema !== 'string' || !realm.schema || typeof realm.search_path !== 'string'
    || !Number.isSafeInteger(Number(realm.schema_oid)) || Number(realm.schema_oid) < 1
    || !Number.isSafeInteger(Number(realm.database_oid)) || Number(realm.database_oid) < 1) throw new WorkspaceRequestPrincipalError('PRINCIPAL_SCOPE_CHANGED');
  return Object.freeze({ ...scope,
    schema: realm.schema, schemaOid: Number(realm.schema_oid), databaseOid: Number(realm.database_oid), searchPath: realm.search_path });
}
async function observeRequestScope(request: NextRequest, workspaceId: string,
  permission: 'read' | 'write', expected: PristineOriginalRequestScopeExpectation): Promise<void> {
  return withWorkspaceRequestPrincipal(request, { workspaceId, permission: permission === 'write' ? 'canWrite' : 'canRead' }, principal =>
    transaction((connection, phase) => {
      phase.retryable = true;
      return withWorkspaceRequestPrincipalOnConnection(connection, principal, async access => {
        phase.entered = true; await assertRequestScope(connection, expected, access);
      });
    }));
}

/** These phases publish no SQL mutations. A lost COMMIT response still forbids
 * a ticket; close/discard rather than assuming publication or replaying. */
async function transaction<T>(operation: (connection: SqlConnection, phase: ReadPhase) => Promise<T>): Promise<T> {
  const connection = await openDb(); let began = false, committing = false, discard: Error | undefined;
  const phase: ReadPhase = { retryable: false, entered: false };
  let cleanBusy: WorkspaceRequestPrincipalError | undefined;
  try {
    await connection.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); began = true;
    const result = await operation(connection, phase);
    committing = true;
    try { await connection.run('COMMIT'); began = false; }
    catch (error) {
      discard = new Error('Discarding unconfirmed native session completion.', { cause: error });
      throw new AuthenticatedTextSessionError('NATIVE_SESSION_COMMIT_UNCONFIRMED', 503);
    }
    return result;
  } catch (error) {
    if (began && !committing) try {
      await connection.run('ROLLBACK');
      if (phase.retryable && !phase.entered && error instanceof WorkspaceRequestPrincipalError && error.code === 'PRINCIPAL_BUSY') cleanBusy = error;
    }
    catch (rollbackError) { discard = new Error('Discarding unresolved native session read.', { cause: rollbackError });
      throw new AggregateError([error, rollbackError], 'Native session rollback could not be confirmed.'); }
    throw error;
  } finally {
    await connection.close(discard);
    if (cleanBusy && !discard) cleanReadContention.add(cleanBusy);
  }
}

/** No serializer or filesystem dependency. Require the exact current row and
 * exact finalized receipt on the SAME B, never equality of sequence counters. */
async function projectionFinalized(connection: SqlConnection, snapshot: ExistingNativeSessionSnapshot): Promise<boolean> {
  const row = await connection.get(`SELECT EXISTS(SELECT 1 FROM collaboration_yjs_states y
    JOIN collaboration_file_projections p ON p.document_id=y.document_id
    JOIN collaboration_documents d ON d.id=y.document_id
    WHERE y.document_id=$1 AND y.workspace_id=$2 AND y.organization_id IS NOT DISTINCT FROM $3 AND y.path=$4
      AND y.lifecycle_generation=$5 AND y.representation=$6 AND y.schema_version=$7 AND y.status='active'
      AND y.document_sequence=$8 AND y.checkpoint_sequence=$9 AND y.checkpointed_at IS NOT NULL
      AND y.canonical_hash IS NOT NULL AND y.serialized_hash IS NOT NULL
      AND p.lifecycle_generation=y.lifecycle_generation AND p.projected_sequence=y.checkpoint_sequence
      AND p.canonical_hash=y.canonical_hash AND p.serialized_hash=y.serialized_hash
      AND p.revision_id IS NOT NULL AND p.finalized=1 AND d.status='active' AND d.provider='yjs'
      AND d.workspace_id=y.workspace_id AND d.organization_id IS NOT DISTINCT FROM y.organization_id
      AND d.path=y.path AND d.state_version>=y.checkpoint_sequence) AS finalized`,
  [snapshot.documentId, snapshot.workspaceId, snapshot.organizationId, snapshot.path, snapshot.lifecycleGeneration,
    snapshot.representation, snapshot.schemaVersion, snapshot.documentSequence, snapshot.checkpointSequence]) as { finalized?: boolean } | undefined;
  return row?.finalized === true;
}
function grant(snapshot: ExistingNativeSessionSnapshot, permission: 'read' | 'write', finalized: boolean): CollaborationSessionGrant {
  return Object.freeze({ path: snapshot.path, provider: 'yjs', representation: snapshot.representation,
    documentId: snapshot.documentId, documentName: snapshot.documentId, lifecycleGeneration: snapshot.lifecycleGeneration,
    permission, documentSequence: snapshot.documentSequence, checkpointSequence: snapshot.checkpointSequence,
    stateVector: snapshot.stateVector, stateProof: snapshot.stateProof, degraded: snapshot.degraded,
    projectionFinalized: finalized, ...(snapshot.projectionError ? { projectionError: snapshot.projectionError } : {}) });
}
function checkFormat(snapshot: ExistingNativeSessionSnapshot, request: TextRequest): void {
  if (snapshot.representation === 'tiptap_blocks' && !supportsBlockTreeCollaboration(request)) {
    throw new CollaborationSessionError('This document uses a newer collaboration format. Reload or update the editor before opening it.', 409, 'representation_mismatch');
  }
  if (request.representation !== 'auto' && request.representation !== snapshot.representation) {
    throw new CollaborationSessionError('The collaboration representation does not match this editor. Reload to use the current document representation.', 409, 'representation_mismatch');
  }
}
async function existing(transport: AuthenticatedNativeSessionTransport, request: TextRequest,
  permission: 'read' | 'write', expectedScope: PristineOriginalRequestScopeExpectation,
  expectedIdentity?: ExistingNativeSessionIdentity): Promise<Observation> {
  return transaction((connection, phase) => {
    phase.retryable = true;
    return withAuthenticatedNativeSessionTransportOnConnection(connection, transport,
    { path: request.path, permission: permission === 'write' ? 'canWrite' : 'canRead', expectedIdentity }, async (native, access) => {
      phase.entered = true;
      await assertRequestScope(connection, expectedScope, access);
      let snapshot = await assertExistingNativeCollaborationSessionCurrentOnConnection(connection, native);
      checkFormat(snapshot, request);
      const analysis = inspectExistingNativeCollaborationSessionOnConnection(connection, native, (observed): { target: TextCollaborationRepresentation; normalizable: boolean } => {
        const rich = supportsBlockTreeCollaboration(request) ? 'tiptap_blocks' : 'tiptap_xml';
        if (/\.txt$/iu.test(request.path)) return { target: snapshot.representation, normalizable: false };
        if (observed.content.kind === 'rich_text') return { target: rich, normalizable: false };
        const mode = analyzeMarkdownRichMode(observed.content.text).mode;
        return { target: mode === 'source' ? 'plain_text' : rich, normalizable: mode === 'normalizable' };
      });
      const finalized = await projectionFinalized(connection, snapshot);
      const before = snapshot; snapshot = await assertExistingNativeCollaborationSessionCurrentOnConnection(connection, native);
      checkFormat(snapshot, request); await assertRequestScope(connection, expectedScope, access);
      return { grant: grant(snapshot, permission, finalized && before.stateProof === snapshot.stateProof
        && before.checkpointSequence === snapshot.checkpointSequence), identity: requestIdentity(access), native: identity(snapshot), ...analysis };
    });
  });
}

async function diagnosis(request: NextRequest, workspaceId: string, requested: TextRequest,
  expectedScope: PristineOriginalRequestScopeExpectation): Promise<Observation> {
  return transaction((connection, phase) => {
    phase.retryable = true;
    return withAuthenticatedNativeSessionDiagnosisOnConnection(connection, request,
    { workspaceId, path: requested.path }, async (native, access) => {
      phase.entered = true;
      await assertRequestScope(connection, expectedScope, access);
      if (requested.migration || requested.allowRichMigration) throw new NativeSessionStateReaderError('NATIVE_SESSION_QUARANTINED');
      let snapshot = await assertReadOnlyNativeSessionDiagnosisCurrentOnConnection(connection, native); checkFormat(snapshot, requested);
      const finalized = await projectionFinalized(connection, snapshot), before = snapshot;
      snapshot = await assertReadOnlyNativeSessionDiagnosisCurrentOnConnection(connection, native);
      await assertRequestScope(connection, expectedScope, access); checkFormat(snapshot, requested);
      return { grant: grant(snapshot, 'read', finalized && before.stateProof === snapshot.stateProof
        && before.checkpointSequence === snapshot.checkpointSequence), identity: requestIdentity(access), native: identity(snapshot),
      target: snapshot.representation, normalizable: false };
    });
  });
}

/** Missing reader state is never a pristine proof. The exact catalogue,
 * history, provider and path are checked again under a separate genuine B.
 * This shared transaction closes before the exclusive bootstrap A is opened. */
async function bootstrapTarget(request: NextRequest, workspaceId: string, path: string,
  expectedScope: PristineOriginalRequestScopeExpectation): Promise<PristineOriginalWorkspaceFileRequest['expectedTarget'] | null> {
  return withWorkspaceRequestPrincipal(request, { workspaceId, permission: 'canWrite' }, principal =>
    transaction((connection, phase) => {
      phase.retryable = true;
      return withWorkspaceRequestPrincipalOnConnection(connection, principal, async access => {
      phase.entered = true;
      await assertRequestScope(connection, expectedScope, access);
      const locked = await connection.get('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS locked',
        [collaborationAdmissionLockKey(workspaceId)]) as { locked?: boolean } | undefined;
      if (locked?.locked !== true) throw new NativeSessionStateReaderError('NATIVE_SESSION_BUSY');
      const catalogue = await readWorkspaceDocumentCatalogue(connection, access.workspace, { paths: [path], maxEntries: 2 });
      if (catalogue.some(entry => entry.path !== path)) throw new NativeSessionStateReaderError('NATIVE_SESSION_SCOPE_CHANGED');
      const rows = await connection.all(`SELECT id,provider,status FROM collaboration_documents
        WHERE workspace_id=$1 AND path=$2 ORDER BY id LIMIT 2`, [workspaceId, path]) as Array<{ id: string; provider: string; status: string }>;
      if (!rows.length && !catalogue.length) { await assertRequestScope(connection, expectedScope, access); return { kind: 'absent' as const }; }
      if (rows.length !== 1 || catalogue.length !== 1 || rows[0].provider !== 'yjs' || rows[0].status !== 'active'
        || rows[0].id !== catalogue[0].id) throw new NativeSessionStateReaderError('NATIVE_SESSION_SCOPE_CHANGED');
      const current = catalogue[0]; await assertRequestScope(connection, expectedScope, access);
      if (current.authority === 'initialized') return null;
      if (current.authority !== 'pristine') throw new NativeSessionStateReaderError('NATIVE_SESSION_STATE_MISSING');
      return { kind: 'pristine' as const, documentId: current.id };
      });
    }));
}

/** Concrete private Web/Mobile integration. No legacy ensureDocument, raw
 * readFile or broad resolver runs before an existing native state. */
export async function withAuthenticatedTextCollaborationSessionGrant<T>(input: Input,
  publish: (publication: AuthenticatedTextSessionPublication) => Promise<T>): Promise<T> {
  if (!(input.request instanceof NextRequest) || typeof input.workspaceId !== 'string' || !input.workspaceId
    || !['read', 'write'].includes(input.permission) || typeof publish !== 'function') throw new AuthenticatedTextSessionError('NATIVE_SESSION_INVALID_REQUEST', 400);
  const original = new NextRequest(input.request.url, { method: input.request.method, headers: new Headers(input.request.headers) });
  const workspaceId = input.workspaceId, permission = input.permission;
  const requested = parseCollaborationSessionRequest(structuredClone(input.sessionRequest));
  if (!requested || requested.provider !== 'yjs') throw new AuthenticatedTextSessionError('NATIVE_SESSION_INVALID_REQUEST', 400);
  let transport: AuthenticatedNativeSessionTransport | undefined;
  // Two additional attempts TOTAL, shared by every read/enrollment site.
  // Bootstrap, migration, COMMIT recovery and publication never enter this loop.
  let retriesRemaining = 2;
  const retryRead = async <T>(operation: () => Promise<T>): Promise<T> => {
    for (;;) {
      try { return await operation(); }
      catch (error) {
        if (!(error instanceof WorkspaceRequestPrincipalError) || !cleanReadContention.has(error) || retriesRemaining === 0) throw error;
        cleanReadContention.delete(error); retriesRemaining--;
        await new Promise<void>(resolve => setTimeout(resolve, 25));
      }
    }
  };
  const enroll = async (expectedScope: PristineOriginalRequestScopeExpectation, maximum = permission) => {
    let captured: AuthenticatedNativeSessionTransport | undefined;
    try {
      // Mint before B: the auth resolver may write seat metadata. Its bounded
      // genuine phase runs sequentially on B after transport capture, with the
      // original full scope still required even after diagnostic reenrollment.
      return await withWorkspaceRequestPrincipal(original, { workspaceId, permission: maximum === 'write' ? 'canWrite' : 'canRead' }, principal => transaction(async (connection, phase) => {
        captured = await captureAuthenticatedNativeSessionTransportOnConnection(connection, original,
          { workspaceId, maxPermission: maximum === 'write' ? 'canWrite' : 'canRead' });
        // Capture's internal callback/final is opaque here. Its failure is NEVER
        // retryable merely because captured is undefined. Only the following
        // genuine phase has an observable pre-callback boundary.
        phase.retryable = true;
        await withWorkspaceRequestPrincipalOnConnection(connection, principal, access => {
          phase.entered = true; return assertRequestScope(connection, expectedScope, access);
        });
        return captured;
      }));
    } catch (error) {
      if (captured) try { await disposeAuthenticatedNativeSessionTransport(captured); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native session enrollment cleanup failed.'); }
      throw error;
    }
  };
  const readExisting = (expectedScope: PristineOriginalRequestScopeExpectation, expectedIdentity?: ExistingNativeSessionIdentity) => retryRead(async () => {
    try {
      if (!transport) transport = await enroll(expectedScope);
      return await existing(transport, requested, permission, expectedScope, expectedIdentity);
    } catch (error) {
      const previous = transport; transport = undefined;
      if (previous) try { await disposeAuthenticatedNativeSessionTransport(previous); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native session read cleanup failed.'); }
      throw error;
    }
  });
  let publicationActive = false, adopted = false, completed = false, rollbackAdoption: (() => void | Promise<void>) | undefined;
  try {
    const expectedScope = await observeRequestOrigin(original, workspaceId, permission);
    await retryRead(() => observeRequestScope(original, workspaceId, permission, expectedScope));
    transport = await retryRead(() => enroll(expectedScope)); let observed: Observation;
    try { observed = await readExisting(expectedScope); }
    catch (error) {
      if (error instanceof NativeSessionStateReaderError && error.code === 'NATIVE_SESSION_QUARANTINED') {
        observed = await retryRead(() => diagnosis(original, workspaceId, requested, expectedScope));
        transport = await retryRead(() => enroll(expectedScope, 'read'));
      } else {
        if (!(error instanceof NativeSessionStateReaderError) || error.code !== 'NATIVE_SESSION_STATE_MISSING') throw error;
        if (permission !== 'write') throw new AuthenticatedTextSessionError('NATIVE_SESSION_INITIALIZATION_REQUIRED', 409);
        const target = await retryRead(() => bootstrapTarget(original, workspaceId, requested.path, expectedScope));
        if (target) {
          try { await persistPristineOriginalWorkspaceFileForWrite(original, {
            workspaceId, path: requested.path, operationId: randomUUID(), requestId: randomUUID(), expectedTarget: target,
            initialRepresentation: requested.representation,
            ...(requested.representation === 'auto' ? { richFormat: supportsBlockTreeCollaboration(requested) ? 'tiptap_blocks' : 'tiptap_xml' } : {}),
          }, { openConnection: openDb, expectedRequestScope: expectedScope }); }
          catch (bootstrapError) {
            if (bootstrapError instanceof MarkdownFileImportError && bootstrapError.code === 'MARKDOWN_IMPORT_RICH_UNAVAILABLE') {
              throw new CollaborationSessionError('This Markdown document can only collaborate in source mode so its representation is preserved.', 409, 'source_representation_required');
            }
            // A concurrent initialized winner may be read; unknown COMMIT,
            // revoked rights, missing history or source errors are never replayed.
            if (!(bootstrapError instanceof MarkdownFileImportError) || bootstrapError.code !== 'MARKDOWN_IMPORT_TARGET_CHANGED') throw bootstrapError;
          }
        }
        observed = await readExisting(expectedScope);
      }
    }
    let migration: RichMigrationResult | undefined;
    if (requested.migration) {
      if (permission !== 'write') throw Object.assign(new Error('Write access is required to prepare formatted editing.'), { status: 403, code: 'migration_permission_denied' });
      const result = await advanceAuthenticatedRichRepresentationMigration({ request: original, workspaceId,
        path: requested.path, migration: requested.migration, ...(requested.migrationAction === 'cancel' ? { cancel: true } : {}) });
      migration = result.migration;
      if (migration.status === 'pending' && migration.reason === 'outcome_unconfirmed') {
        return await publish(Object.freeze({ grant: Object.freeze({ ...observed.grant, migration }), identity: observed.identity,
          takeTransport: () => { throw new AuthenticatedTextSessionError('NATIVE_SESSION_PUBLICATION_CLOSED', 409); } }));
      }
      observed = await readExisting(expectedScope, { ...observed.native, documentId: result.state.documentId,
        workspaceId: result.state.workspaceId, organizationId: result.state.organizationId, path: result.state.path,
        lifecycleGeneration: result.state.lifecycleGeneration, representation: result.state.representation, schemaVersion: result.state.schemaVersion });
    } else if (requested.allowRichMigration && requested.representation === 'auto' && permission === 'write'
      && requested.expectedLifecycleGeneration === observed.native.lifecycleGeneration
      && (observed.native.representation === 'plain_text' || observed.native.representation === 'tiptap_xml' && observed.target === 'tiptap_blocks')
      && observed.target !== 'plain_text' && !/\.txt$/iu.test(requested.path)) {
      let expectedIdentity = observed.native;
      try { const changed = await changeAuthenticatedCollaborationRepresentation({ request: original, workspaceId, path: requested.path,
        expectedLifecycleGeneration: observed.native.lifecycleGeneration, representation: observed.target,
        ...(observed.normalizable ? { normalizeSafeMarkdown: true, checkpoint: {
          materialize: async ({ state, workspace }) => (await materializeCollaborationCheckpoint({ state, workspace, actorType: 'system' })).state,
        } } : {}) });
        expectedIdentity = { ...observed.native, documentId: changed.documentId, workspaceId: changed.workspaceId,
          organizationId: changed.organizationId, path: changed.path, lifecycleGeneration: changed.lifecycleGeneration,
          representation: changed.representation, schemaVersion: changed.schemaVersion };
      }
      catch (error) { if (!(error instanceof CollaborationRepresentationMigrationError)) throw error; }
      observed = await readExisting(expectedScope, expectedIdentity);
    }
    if (!transport) throw new AuthenticatedTextSessionError('NATIVE_SESSION_COMMIT_UNCONFIRMED', 503);
    const currentTransport = transport;
    publicationActive = true;
    const publication = Object.freeze({ grant: Object.freeze({ ...observed.grant, ...(migration ? { migration } : {}) }), identity: observed.identity,
      takeTransport: (rollback: () => void | Promise<void>) => {
        if (!publicationActive || adopted || typeof rollback !== 'function') throw new AuthenticatedTextSessionError('NATIVE_SESSION_PUBLICATION_CLOSED', 409);
        adopted = true; rollbackAdoption = rollback; return currentTransport;
      } });
    const result = await publish(publication); completed = true; return result;
  } catch (error) {
    if (rollbackAdoption) try { await rollbackAdoption(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native session publication cleanup failed.'); }
    throw error;
  } finally {
    publicationActive = false;
    if (transport && (!adopted || !completed)) await disposeAuthenticatedNativeSessionTransport(transport);
  }
}

export function createAuthenticatedTextCollaborationSessionGrant(input: Input) {
  return withAuthenticatedTextCollaborationSessionGrant(input, async publication => ({ grant: publication.grant, identity: publication.identity }));
}

/** Preserve named conflicts and auth failures at the actual HTTP boundary. */
export function authenticatedTextSessionErrorStatus(error: unknown): number {
  if (error instanceof WorkspaceOriginalFileSourceError && error.code === 'source-too-large') return 413;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'PRINCIPAL_AUTH_REVOKED') return 401;
  if (code === 'PRINCIPAL_ACCESS_DENIED' || code === 'NATIVE_TRANSPORT_ACCESS_DENIED') return 403;
  if (code === 'PRINCIPAL_WORKSPACE_UNCONFIRMED') return 503;
  if (code === 'MARKDOWN_IMPORT_COMMIT_UNCONFIRMED') return 503;
  if (code === 'ENOENT') return 404;
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
  return [400, 401, 403, 404, 409, 413, 503].includes(status) ? status
    : /^(?:PRINCIPAL_|NATIVE_TRANSPORT_|RICH_MIGRATION_WRITE_|ADMISSION_)/u.test(code) ? 409 : 500;
}
