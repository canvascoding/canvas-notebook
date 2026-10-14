import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { getSchema } from '@tiptap/core';
import { getPostgresRuntimeQueryable, openDb, type SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import type { WorkspaceRequestPrincipalAccess } from '../workspaces/request-principal';
import { ensureActiveFileLineage, lockFileCollaborationPaths } from '../files/collaboration-repository';
import { assertWorkspaceOriginalPathCurrent, readWorkspaceOriginalFileSource,
  type WorkspaceOriginalPathObservation, type WorkspaceOriginalRootObservation } from '../files/workspace-original-file-source';
import { isInternalWorkspaceStagingPath } from '../files/internal-staging-path';
import { filesystemFileVersion } from '../filesystem/file-version';
import { assertWorkspaceFileLifecycleSqlAvailable, withWorkspaceFileLifecycleGuard } from '../files/workspace-file-lifecycle-guard';
import { captureAgentStateSnapshot, persistedUpdateIncludesAgentSnapshot } from './agent-durability';
import { authoritativeNativeCollaborationSnapshot, inspectPersistedNativeCollaborationSnapshot } from './document-snapshot';
import { getWorkspaceFileLifecycleLeases, withWorkspaceFileLifecycleCollaborationWrite } from './file-lifecycle-admission-context';
import { hasCollaborationHandoffExecutionContext } from './handoff-execution-context';
import { lockFileLifecycleCollaborationWriterAdmission } from './file-lifecycle-writer-admission';
import { executeLifecycleTransaction } from './lifecycle-transaction';
import { MARKDOWN_FILE_IMPORT_LIMIT, MarkdownFileImportError, prepareMarkdownFileImport, type PreparedMarkdownFileImport } from './markdown-file-import';
import { replaceRichMarkdownInYDoc, richMarkdownFromYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from './markdown-state';
import { assertNativeDocumentSchema } from './native-document-schema';
import { loadCollaborationStateOnConnection, type PersistedCollaborationState } from './persistence';
import { assertCollaborationAdmissionOpen } from './room-admission';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from './room-admission-contract';
import { lockIdentity } from './room-owner';
import { getCollaborationRoomConnectionCount } from './runtime-state';
import { Y } from './server-runtime';
import { isCollaborationStateProof } from './state-proof';
import { readWorkspaceDocumentCatalogue } from './workspace-document-catalogue';
import type { TextCollaborationRepresentation } from './types';

export type MarkdownImportIdentity = Pick<PersistedCollaborationState, 'documentId' | 'workspaceId' | 'organizationId'
  | 'path' | 'representation' | 'schemaVersion' | 'lifecycleGeneration' | 'newlineStyle' | 'hasBom'>;
export type MarkdownImportTarget = { kind: 'absent' } | { kind: 'pristine'; documentId: string }
  | ({ kind: 'initialized'; documentSequence: number; stateProof: string } & MarkdownImportIdentity);
/** Private coordinator receipt; never spread this into file/upload API results. */
export type MarkdownFileImportReceipt = {
  version: 1;
  operationId: string;
  requestFingerprint: string;
  sourceHash: string;
  sourceBytes: number;
  target: MarkdownImportIdentity & { lineageId: string; initialSequence: number; initialStateProof: string; persistedAt: number };
  /** The checkpoint/projection journal remains the sole physical writer. */
  checkpointRequired: true;
};
export type MarkdownFileImportResult = { disposition: 'applied' | 'already-applied' | 'commit-recovered';
  receipt: MarkdownFileImportReceipt; currentObservation: { documentSequence: number; stateProof: string; persistedAt: number } };
export type MarkdownFileImportRequest = {
  workspace: WorkspaceContext;
  path: string;
  operationId: string;
  requestId: string;
  actorUserId: string;
  actorSessionId: string | null;
  bytes: Uint8Array;
  expectedTarget: MarkdownImportTarget;
  representation?: TextCollaborationRepresentation | 'auto';
  /** Recheck current actor/path rights under the actual mutation fence. */
  validateAuthority: () => Promise<void>;
};
type Captured = Omit<MarkdownFileImportRequest, 'bytes' | 'validateAuthority'> & {
  prepared: PreparedMarkdownFileImport; fingerprint: string;
};
const fail = (code: MarkdownFileImportError['code']): never => { throw new MarkdownFileImportError(code); };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const knownKeys = (value: object, keys: string[]) => !Object.keys(value).some(key => !keys.includes(key));
const identityKeys = ['documentId', 'workspaceId', 'organizationId', 'path', 'representation', 'schemaVersion', 'lifecycleGeneration', 'newlineStyle', 'hasBom'] as const;
function validIdentity(value: MarkdownImportIdentity): boolean {
  return !!value && typeof value === 'object' && validId(value.documentId) && validId(value.workspaceId)
    && (value.organizationId === null || validId(value.organizationId)) && isCanonicalAdmissionPath(value.path)
    && ['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(value.representation) && value.schemaVersion === 1
    && Number.isSafeInteger(value.lifecycleGeneration) && value.lifecycleGeneration > 0
    && ['lf', 'crlf'].includes(value.newlineStyle) && typeof value.hasBom === 'boolean';
}
function capture(input: MarkdownFileImportRequest): Captured {
  if (typeof input.validateAuthority !== 'function' || !(input.bytes instanceof Uint8Array)
    || input.bytes.byteLength > MARKDOWN_FILE_IMPORT_LIMIT) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  const workspace = structuredClone(input.workspace), expectedTarget = structuredClone(input.expectedTarget);
  if (!workspace.permissions.canRead || !workspace.permissions.canWrite
    || workspace.status !== undefined && workspace.status !== 'active'
    || workspace.actor && workspace.actor.userId !== input.actorUserId) {
    throw Object.assign(new Error('Current workspace import permission is required.'), { status: 403 });
  }
  if (!validId(input.operationId) || !validId(input.requestId) || !validId(input.actorUserId)
    || input.actorSessionId !== null && !validId(input.actorSessionId) || !validId(workspace.workspaceId)
    || workspace.organizationId != null && !validId(workspace.organizationId)
    || !isCanonicalAdmissionPath(input.path) || !/\.(?:md|markdown)$/iu.test(input.path)
    || !expectedTarget || typeof expectedTarget !== 'object') return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  if (expectedTarget.kind === 'absent') {
    if (!knownKeys(expectedTarget, ['kind'])) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  } else if (expectedTarget.kind === 'pristine') {
    if (!validId(expectedTarget.documentId) || !knownKeys(expectedTarget, ['kind', 'documentId'])) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  } else if (expectedTarget.kind === 'initialized') {
    if (!validIdentity(expectedTarget) || expectedTarget.workspaceId !== workspace.workspaceId
      || expectedTarget.organizationId !== (workspace.organizationId ?? null) || expectedTarget.path !== input.path
      || !Number.isSafeInteger(expectedTarget.documentSequence) || expectedTarget.documentSequence < 0
      || expectedTarget.documentSequence >= Number.MAX_SAFE_INTEGER || !isCollaborationStateProof(expectedTarget.stateProof)
      || !knownKeys(expectedTarget, ['kind', 'documentSequence', 'stateProof', ...identityKeys])) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  } else return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  const representation = input.representation ?? (expectedTarget.kind === 'initialized' ? expectedTarget.representation : 'auto');
  const prepared = prepareMarkdownFileImport(new Uint8Array(input.bytes), { representation });
  if (expectedTarget.kind === 'initialized' && (expectedTarget.representation !== prepared.representation
    || expectedTarget.newlineStyle !== prepared.newlineStyle || expectedTarget.hasBom !== prepared.hasBom)) {
    return fail('MARKDOWN_IMPORT_LIFECYCLE_REQUIRED');
  }
  // Canonical key ordering prevents caller property-order changes from becoming a new request.
  const expected = expectedTarget.kind === 'initialized' ? { kind: expectedTarget.kind,
    ...Object.fromEntries(identityKeys.map(key => [key, expectedTarget[key]])),
    documentSequence: expectedTarget.documentSequence, stateProof: expectedTarget.stateProof } : expectedTarget;
  const fingerprint = hash(JSON.stringify({ version: 1, workspaceId: workspace.workspaceId,
    organizationId: workspace.organizationId ?? null, path: input.path, sourceHash: prepared.sourceHash,
    sourceBytes: prepared.sourceBytes, representation: prepared.representation,
    newlineStyle: prepared.newlineStyle, hasBom: prepared.hasBom, expectedTarget: expected }));
  return { workspace, path: input.path, operationId: input.operationId, requestId: input.requestId,
    actorUserId: input.actorUserId, actorSessionId: input.actorSessionId, expectedTarget, prepared, fingerprint };
}

async function observedState(database: SqlConnection, input: Captured, receipt: MarkdownFileImportReceipt): Promise<PersistedCollaborationState> {
  const documents = await readWorkspaceDocumentCatalogue(database, input.workspace, { paths: [input.path] });
  const document = documents.find(document => document.path === input.path);
  const state = await loadCollaborationStateOnConnection(database, receipt.target.documentId, true);
  const lineage = await database.get(`SELECT id FROM file_collaboration_lineages WHERE id=$1 AND workspace_id=$2
    AND organization_id IS NOT DISTINCT FROM $3 AND path=$4 AND status='active'`,
  [receipt.target.lineageId, input.workspace.workspaceId, input.workspace.organizationId ?? null, input.path]);
  if (documents.length !== 1 || !document || document.id !== receipt.target.documentId
    || document.authority !== 'initialized' || document.yjs_state_lifecycle !== 'initialized'
    || document.lineage_id !== receipt.target.lineageId || !lineage || !state
    || identityKeys.some(key => state[key] !== receipt.target[key]) || state.documentSequence < document.state_version) {
    return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
  }
  authoritativeNativeCollaborationSnapshot(state);
  return state;
}
async function confirmedRetry(database: SqlConnection, input: Captured): Promise<Omit<MarkdownFileImportResult, 'disposition'> | null> {
  const rows = await database.all(`SELECT * FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1
    AND (operation_id=$2 OR (actor_user_id=$3 AND actor_session_id IS NOT DISTINCT FROM $4 AND request_id=$5))`,
  [input.workspace.workspaceId, input.operationId, input.actorUserId, input.actorSessionId, input.requestId]) as Array<Record<string, unknown>>;
  if (!rows.length) return null;
  if (rows.length !== 1) return fail('MARKDOWN_IMPORT_REQUEST_CONFLICT');
  const row = rows[0], receipt = row.private_result as MarkdownFileImportReceipt;
  if (row.version !== 1 || row.operation_id !== input.operationId || row.organization_id !== (input.workspace.organizationId ?? null)
    || row.actor_user_id !== input.actorUserId || row.actor_session_id !== input.actorSessionId || row.request_id !== input.requestId
    || row.request_fingerprint !== input.fingerprint || !receipt || !knownKeys(receipt, ['version', 'operationId', 'requestFingerprint', 'sourceHash', 'sourceBytes', 'target', 'checkpointRequired'])
    || receipt.version !== 1 || receipt.operationId !== input.operationId || receipt.requestFingerprint !== input.fingerprint
    || receipt.sourceHash !== input.prepared.sourceHash || receipt.sourceBytes !== input.prepared.sourceBytes || receipt.checkpointRequired !== true
    || !validIdentity(receipt.target) || receipt.target.workspaceId !== input.workspace.workspaceId
    || receipt.target.organizationId !== (input.workspace.organizationId ?? null) || receipt.target.path !== input.path
    || receipt.target.representation !== input.prepared.representation || receipt.target.newlineStyle !== input.prepared.newlineStyle
    || receipt.target.hasBom !== input.prepared.hasBom || !validId(receipt.target.lineageId)
    || !knownKeys(receipt.target, [...identityKeys, 'lineageId', 'initialSequence', 'initialStateProof', 'persistedAt'])
    || !Number.isSafeInteger(receipt.target.initialSequence) || receipt.target.initialSequence < 0
    || !isCollaborationStateProof(receipt.target.initialStateProof) || !Number.isSafeInteger(receipt.target.persistedAt) || receipt.target.persistedAt < 0
    || !(row.after_state_snapshot instanceof Uint8Array) || row.after_state_snapshot.byteLength > MARKDOWN_FILE_IMPORT_LIMIT
    || `yjs-snapshot-sha256-v1:${hash(row.after_state_snapshot)}` !== receipt.target.initialStateProof) return fail('MARKDOWN_IMPORT_REQUEST_CONFLICT');
  const expected = input.expectedTarget;
  if (expected.kind === 'initialized') {
    if (identityKeys.some(key => receipt.target[key] !== expected[key])
      || receipt.target.initialSequence !== expected.documentSequence + 1) return fail('MARKDOWN_IMPORT_REQUEST_CONFLICT');
  } else if (receipt.target.initialSequence !== 0 || receipt.target.lifecycleGeneration !== 1
    || input.expectedTarget.kind === 'pristine' && receipt.target.documentId !== input.expectedTarget.documentId) return fail('MARKDOWN_IMPORT_REQUEST_CONFLICT');
  const state = await observedState(database, input, receipt);
  // The empty initial Plain snapshot is a legitimate subset with no client items.
  const empty = Y.encodeSnapshot(Y.createSnapshot(Y.createDeleteSet(), new Map()));
  if (state.documentSequence < receipt.target.initialSequence || !Buffer.from(row.after_state_snapshot).equals(Buffer.from(empty))
    && !persistedUpdateIncludesAgentSnapshot(state.yjsState, row.after_state_snapshot, Y)) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
  const native = authoritativeNativeCollaborationSnapshot(state);
  return { receipt, currentObservation: { documentSequence: state.documentSequence, stateProof: native.version.stateProof, persistedAt: state.persistedAt } };
}

function importedState(input: Captured, documentId: string, now: number): PersistedCollaborationState {
  return { documentId, workspaceId: input.workspace.workspaceId, organizationId: input.workspace.organizationId ?? null,
    path: input.path, representation: input.prepared.representation, lifecycleGeneration: 1, schemaVersion: 1,
    yjsState: input.prepared.yjsState, stateVector: input.prepared.stateVector, documentSequence: 0, persistedAt: now,
    checkpointedAt: null, checkpointSequence: 0, canonicalHash: null, serializedHash: null,
    newlineStyle: input.prepared.newlineStyle, hasBom: input.prepared.hasBom, degraded: false, status: 'active', projectionFinalized: false };
}
function mutateEmpty(state: PersistedCollaborationState, input: Captured): PersistedCollaborationState {
  const expected = input.expectedTarget;
  if (expected.kind !== 'initialized') return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  return inspectPersistedNativeCollaborationSnapshot(state, (source, snapshot) => {
    if (identityKeys.some(key => state[key] !== expected[key]) || state.documentSequence !== expected.documentSequence
      || snapshot.version.stateProof !== expected.stateProof) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
    const schema = getSchema(richMarkdownSchemaExtensions());
    assertNativeDocumentSchema(source, state.representation, schema);
    if (snapshot.content.kind === 'plain_text') {
      if (snapshot.content.text.length) return fail('MARKDOWN_IMPORT_TARGET_NOT_EMPTY');
    } else {
      const { document, frontmatter, bodyFinalLineEnding } = snapshot.content;
      const nodes = document.content ?? [];
      if (frontmatter.length || bodyFinalLineEnding.length || nodes.length > 1 || nodes.some(node => node.type !== 'paragraph'
        || node.text || node.content?.length || node.marks?.length
        || Object.entries(node.attrs ?? {}).some(([key, value]) => key !== 'id' && value !== schema.nodes.paragraph.spec.attrs?.[key]?.default))) {
        return fail('MARKDOWN_IMPORT_TARGET_NOT_EMPTY');
      }
    }
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, state.yjsState);
      if (state.representation === 'plain_text') candidate.transact(() => {
        if (input.prepared.canonical) candidate.getText('content').insert(0, input.prepared.canonical);
      }, { kind: 'markdown-file-import', operationId: input.operationId });
      else {
        replaceRichMarkdownInYDoc(candidate, input.prepared.canonical, { kind: 'markdown-file-import', operationId: input.operationId });
        if (!validateRichMarkdownYDoc(candidate).valid || richMarkdownFromYDoc(candidate) !== input.prepared.canonical) {
          return fail('MARKDOWN_IMPORT_RICH_UNAVAILABLE');
        }
      }
      return { ...state, yjsState: Y.encodeStateAsUpdate(candidate), stateVector: Y.encodeStateVector(candidate),
        documentSequence: state.documentSequence + 1, persistedAt: Math.max(Date.now(), state.persistedAt), projectionFinalized: false };
    } finally { candidate.destroy(); }
  });
}

/** Internal original-file bootstrap only; this is not an API response or a grant. */
export type PristineOriginalWorkspaceFileRequest = {
  workspaceId: string; path: string; operationId: string; requestId: string;
  expectedTarget: Extract<MarkdownImportTarget, { kind: 'absent' | 'pristine' }>;
  /** Explicit modes never normalize or fall back. TXT permits only Auto/Plain. */
  initialRepresentation?: TextCollaborationRepresentation | 'auto';
  /** Auto-only preference. Omitted Auto keeps the current Blocks default. */
  richFormat?: 'tiptap_blocks' | 'tiptap_xml';
};
/** Expectations from an earlier genuine phase, never caller authority. */
export type PristineOriginalRequestScopeExpectation = Readonly<{
  userId: string; sessionId: string; workspaceId: string; workspaceType: WorkspaceContext['workspaceType'];
  organizationId: string | null; projectId: string | null; customerId: string | null; ownerUserId: string | null;
  rootPath: string; rootRelativePath: string; legacy: false; status: 'active';
  schema: string; schemaOid: number; databaseOid: number; searchPath: string;
}>;
const bootstrapExpectationKeys = ['userId', 'sessionId', 'workspaceId', 'workspaceType', 'organizationId', 'projectId',
  'customerId', 'ownerUserId', 'rootPath', 'rootRelativePath', 'legacy', 'status', 'schema', 'schemaOid', 'databaseOid', 'searchPath'] as const;
function captureBootstrapExpectation(value: PristineOriginalRequestScopeExpectation | undefined): PristineOriginalRequestScopeExpectation | undefined {
  if (value === undefined) return undefined;
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== bootstrapExpectationKeys.length
    || bootstrapExpectationKeys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value');
    }) || !validId(value.userId) || !validId(value.sessionId) || !validId(value.workspaceId)
    || !['personal', 'organization', 'team', 'project'].includes(value.workspaceType)
    || ['organizationId', 'projectId', 'customerId', 'ownerUserId'].some(key => Reflect.get(value, key) !== null && !validId(Reflect.get(value, key)))
    || typeof value.rootPath !== 'string' || !value.rootPath || value.rootPath.length > 8192
    || typeof value.rootRelativePath !== 'string' || value.rootRelativePath.length > 4096 || value.legacy !== false || value.status !== 'active'
    || !validId(value.schema) || value.schema.length > 63 || !Number.isSafeInteger(value.schemaOid) || value.schemaOid < 1
    || !Number.isSafeInteger(value.databaseOid) || value.databaseOid < 1
    || typeof value.searchPath !== 'string' || !value.searchPath || value.searchPath.length > 4096) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  return Object.freeze({ ...value });
}
type BootstrapRealm = { schema: string; database: number };
type BootstrapOwner = BootstrapRealm & { backend: number; start: string; searchPath: string };
type BootstrapFrame = { request: NextRequest; selection: PristineOriginalWorkspaceFileRequest; realm: BootstrapRealm;
  owner: SqlConnection; identity: BootstrapOwner; mutationIdentity?: BootstrapOwner;
  permission: 'canRead' | 'canWrite'; expectedScope?: PristineOriginalRequestScopeExpectation };
type BootstrapLineage = { id: string; organizationId: string | null; existing: boolean };
type OriginalBootstrapScope = { active: boolean; database: SqlConnection; access: WorkspaceRequestPrincipalAccess;
  frame: BootstrapFrame; documentId: string; originalLineageId: string | null; lineage: BootstrapLineage;
  source: { configuredRootPath: string; root: WorkspaceOriginalRootObservation; observed: WorkspaceOriginalPathObservation } };
const originalBootstrapScopes = new WeakMap<Captured, OriginalBootstrapScope>();
const ORIGINAL_BOOTSTRAP_LIMIT = 5 * 1024 * 1024;
const BOOTSTRAP_STATE_LIMIT = 64 * 1024 * 1024, BOOTSTRAP_VECTOR_LIMIT = 1024 * 1024;
const bootstrapRelations = ['collaboration_documents', 'collaboration_yjs_states', 'collaboration_yjs_state_backups',
  'collaboration_agent_operations', 'file_collaboration_lineages', 'file_revisions', 'collaboration_admission_requests',
  'collaboration_admission_scopes', 'collaboration_markdown_file_import_receipts'];
const quoteBootstrap = (value: string) => `"${value.replaceAll('"', '""')}"`;

async function bootstrapConnectionRealm(database: SqlConnection): Promise<BootstrapOwner> {
  const row = await database.get(`SELECT current_schema() AS schema,current_setting('search_path') AS "searchPath",
    (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database,pg_backend_pid() AS backend,
    extract(epoch FROM a.backend_start)::text AS start FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`) as BootstrapOwner | undefined;
  if (!row || typeof row.schema !== 'string' || !row.schema || row.schema.length > 256 || typeof row.searchPath !== 'string'
    || !Number.isSafeInteger(Number(row.database)) || Number(row.database) < 1 || !Number.isSafeInteger(Number(row.backend))
    || Number(row.backend) < 1 || typeof row.start !== 'string' || !row.start) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  return { ...row, database: Number(row.database), backend: Number(row.backend) };
}
async function assertBootstrapOwner(frame: BootstrapFrame): Promise<void> {
  const current = await bootstrapConnectionRealm(frame.owner);
  if (Object.keys(frame.identity).some(key => Reflect.get(current, key) !== Reflect.get(frame.identity, key))) return fail('MARKDOWN_IMPORT_BUSY');
  const lease = getWorkspaceFileLifecycleLeases()?.get(frame.selection.workspaceId);
  if (!lease?.active || !await lease.verify()) return fail('MARKDOWN_IMPORT_BUSY');
  const key = BigInt.asUintN(64, BigInt(collaborationAdmissionLockKey(frame.selection.workspaceId)));
  const held = await frame.owner.get(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted
    AND mode='ExclusiveLock' AND pid=pg_backend_pid() AND database=$1 AND classid::bigint=$2 AND objid::bigint=$3 AND objsubid=1) AS held`,
  [frame.realm.database, Number(key >> BigInt(32)), Number(key & BigInt('0xffffffff'))]) as { held?: boolean } | undefined;
  if (held?.held !== true) return fail('MARKDOWN_IMPORT_BUSY');
}
async function assertBootstrapNativeRealm(database: SqlConnection, frame: BootstrapFrame, lock = false): Promise<void> {
  const current = await bootstrapConnectionRealm(database);
  if (current.schema !== frame.realm.schema || current.database !== frame.realm.database || current.backend === frame.identity.backend) {
    return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  }
  if (lock) await database.run(`LOCK TABLE ${bootstrapRelations.map(name => `${quoteBootstrap(frame.realm.schema)}.${quoteBootstrap(name)}`).join(',')}
    IN ROW EXCLUSIVE MODE NOWAIT`);
  const rows = await database.all(`SELECT name,to_regclass(name)::oid=to_regclass($1||'.'||quote_ident(name))::oid AS same
    FROM unnest($2::text[]) names(name)`, [quoteBootstrap(frame.realm.schema), bootstrapRelations]) as Array<{ same: boolean }>;
  if (rows.length !== bootstrapRelations.length || rows.some(row => row.same !== true)) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
}
async function assertBootstrapScope(database: SqlConnection, input: Captured, scope: OriginalBootstrapScope): Promise<void> {
  if (!scope.active || scope.database !== database || originalBootstrapScopes.get(input) !== scope
    || scope.access.workspace.workspaceId !== input.workspace.workspaceId || scope.access.userId !== input.actorUserId
    || scope.access.sessionId !== input.actorSessionId) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  await scope.access.assertCurrent(); await assertBootstrapOwner(scope.frame);
  await assertBootstrapNativeRealm(database, scope.frame);
  await assertBootstrapExpectedScope(database, scope.frame, scope.access);
}
async function assertBootstrapExpectedScope(database: SqlConnection, frame: BootstrapFrame,
  access: WorkspaceRequestPrincipalAccess): Promise<void> {
  const expected = frame.expectedScope; if (!expected) return;
  const workspace = access.workspace;
  if (access.userId !== expected.userId || access.sessionId !== expected.sessionId
    || ['workspaceId', 'workspaceType', 'organizationId', 'projectId', 'customerId', 'ownerUserId', 'rootPath', 'rootRelativePath', 'legacy', 'status']
      .some(key => (Reflect.get(workspace, key) ?? null) !== Reflect.get(expected, key))) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
  const row = await database.get(`SELECT current_schema() AS schema,to_regnamespace(current_schema())::oid::bigint AS schema_oid,
    (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid,
    current_setting('search_path') AS search_path,quote_ident($2)||', pg_catalog, pg_temp' AS bootstrap_search_path,
    w.id,w.type,w.organization_id,w.project_id,w.customer_id,w.owner_user_id,w.root_relative_path,w.status
    FROM canvas_workspaces w WHERE w.id=$1`, [expected.workspaceId, expected.schema]) as Record<string, unknown> | undefined;
  if (!row || row.schema !== expected.schema || Number(row.schema_oid) !== expected.schemaOid || Number(row.database_oid) !== expected.databaseOid
    || row.id !== expected.workspaceId || row.type !== expected.workspaceType || row.organization_id !== expected.organizationId
    || row.project_id !== expected.projectId || row.customer_id !== expected.customerId || row.owner_user_id !== expected.ownerUserId
    || row.root_relative_path !== expected.rootRelativePath || row.status !== expected.status
    || row.search_path !== row.bootstrap_search_path) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
}
async function assertBootstrapRoomAbsent(database: SqlConnection, documentId: string): Promise<void> {
  if (getCollaborationRoomConnectionCount(documentId) !== 0) return fail('MARKDOWN_IMPORT_BUSY');
  const key = lockIdentity(documentId);
  const row = await database.get(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND mode='ExclusiveLock'
    AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid::bigint=$1 AND objid::bigint=$2 AND objsubid=1) AS held`,
  [key.high, key.low]) as { held?: boolean } | undefined;
  if (row?.held !== false) return fail('MARKDOWN_IMPORT_BUSY');
}
async function assertBootstrapVirgin(database: SqlConnection, documentId: string): Promise<void> {
  const row = await database.get(`SELECT EXISTS(SELECT 1 FROM collaboration_yjs_states WHERE document_id=$1)
    OR EXISTS(SELECT 1 FROM collaboration_yjs_state_backups WHERE document_id=$1)
    OR EXISTS(SELECT 1 FROM collaboration_agent_operations WHERE document_id=$1) AS history`, [documentId]) as { history?: boolean } | undefined;
  if (row?.history !== false) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
  await assertBootstrapRoomAbsent(database, documentId);
}
async function observeBootstrapOriginal(workspace: WorkspaceContext, filePath: string) {
  const resolvedRootPath = await fs.realpath(workspace.rootPath), rootStat = await fs.stat(resolvedRootPath);
  if (!rootStat.isDirectory()) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
  const entries = new Map<string, WorkspaceOriginalPathObservation>(); let relativePath = '';
  for (const segment of filePath.split('/')) {
    relativePath = relativePath ? `${relativePath}/${segment}` : segment;
    const stat = await fs.lstat(path.join(resolvedRootPath, relativePath));
    entries.set(relativePath, { relativePath, stat, identity: filesystemFileVersion(stat) });
  }
  return { configuredRootPath: workspace.rootPath,
    root: { resolvedRootPath, identity: filesystemFileVersion(rootStat), entries }, observed: entries.get(filePath)! };
}
function sameBootstrapWorkspace(a: WorkspaceContext, b: WorkspaceContext): boolean {
  return ['workspaceId', 'workspaceType', 'organizationId', 'projectId', 'customerId', 'ownerUserId', 'rootPath', 'rootRelativePath', 'legacy']
    .every(key => (Reflect.get(a, key) ?? null) === (Reflect.get(b, key) ?? null));
}
async function captureOriginalBootstrap(database: SqlConnection, frame: BootstrapFrame,
  access: WorkspaceRequestPrincipalAccess): Promise<Captured> {
  const { selection } = frame, workspace = access.workspace;
  if (workspace.workspaceId !== selection.workspaceId || !workspace.permissions.canRead
    || !workspace.permissions[frame.permission]) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
  await assertBootstrapExpectedScope(database, frame, access);
  // Capture B only inside the genuine current Principal phase. A different
  // wrapper cannot turn its discarded backend into a fresh confirmation C.
  frame.mutationIdentity = await bootstrapConnectionRealm(database);
  await assertBootstrapOwner(frame); await assertBootstrapNativeRealm(database, frame, true);
  await assertWorkspaceFileLifecycleSqlAvailable(database, workspace.workspaceId, [selection.path]);
  await lockFileCollaborationPaths(database, workspace.workspaceId, [selection.path]);
  const catalogue = await readWorkspaceDocumentCatalogue(database, workspace, { paths: [selection.path], maxEntries: 2 });
  const rows = await database.all(`SELECT id,lineage_id,workspace_id,organization_id,path,workspace_type,provider,status,state_version,yjs_state_lifecycle
    FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 AND status='active' ORDER BY id LIMIT 2 FOR UPDATE`,
  [workspace.workspaceId, selection.path]) as Array<{ id: string; lineage_id: string | null; workspace_id: string;
    organization_id: string | null; path: string; workspace_type: string; provider: string; status: string;
    state_version: number | string; yjs_state_lifecycle: string }>;
  const document = rows[0];
  if (selection.expectedTarget.kind === 'absent') {
    if (catalogue.length || rows.length) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
    // A leftover projection from an archived native document is not a new
    // original file; reopening that namespace requires its lifecycle/birth proof.
    if (await database.get(`SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 LIMIT 1`,
      [workspace.workspaceId, selection.path])) return fail('MARKDOWN_IMPORT_LIFECYCLE_REQUIRED');
  } else if (rows.length !== 1 || catalogue.length !== 1 || document.id !== selection.expectedTarget.documentId
    || catalogue[0].id !== document.id || catalogue[0].authority !== 'pristine' || document.provider !== 'yjs'
    || document.workspace_type !== workspace.workspaceType || Number(document.state_version) !== 0
    || document.yjs_state_lifecycle !== 'never_initialized' || document.organization_id !== (workspace.organizationId ?? null)
    || document.lineage_id !== null && !validId(document.lineage_id)) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
  const documentId = document?.id ?? `collab-${randomUUID()}`;
  await assertBootstrapVirgin(database, documentId);
  const lineages = await database.all(`SELECT id,organization_id,workspace_type,customer_id,project_id FROM file_collaboration_lineages
    WHERE workspace_id=$1 AND path=$2 AND status='active' ORDER BY id LIMIT 2 FOR UPDATE`, [workspace.workspaceId, selection.path]) as Array<{
      id: string; organization_id: string | null; workspace_type: string; customer_id: string | null; project_id: string | null }>;
  const existing = lineages[0];
  if (lineages.length > 1 || existing && (!validId(existing.id) || existing.organization_id !== (workspace.organizationId ?? null)
    || existing.workspace_type !== workspace.workspaceType || existing.customer_id !== null && existing.customer_id !== (workspace.customerId ?? null)
    || existing.project_id !== null && existing.project_id !== (workspace.projectId ?? null))
    || document?.lineage_id && document.lineage_id !== existing?.id) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
  if (existing && await database.get(`SELECT id FROM collaboration_documents WHERE lineage_id=$1 AND id<>$2 LIMIT 1`,
    [existing.id, documentId])) return fail('MARKDOWN_IMPORT_LIFECYCLE_REQUIRED');
  const lineage: BootstrapLineage = { id: existing?.id ?? `file-lineage-${randomUUID()}`,
    organizationId: workspace.organizationId ?? null, existing: !!existing };
  const source = await observeBootstrapOriginal(workspace, selection.path);
  const verify = async () => {
    await access.assertCurrent(); await assertBootstrapOwner(frame); await assertBootstrapNativeRealm(database, frame);
    await assertBootstrapVirgin(database, documentId);
  };
  const bytes = await readWorkspaceOriginalFileSource({ ...source, maxBytes: ORIGINAL_BOOTSTRAP_LIMIT, verifyCurrentSource: verify });
  let prepared: PreparedMarkdownFileImport;
  const initialRepresentation = selection.initialRepresentation ?? 'auto';
  if (/\.txt$/iu.test(selection.path) || initialRepresentation === 'plain_text') prepared = prepareMarkdownFileImport(bytes, { representation: 'plain_text' });
  else if (initialRepresentation !== 'auto') prepared = prepareMarkdownFileImport(bytes, { representation: initialRepresentation });
  else if (selection.richFormat === 'tiptap_xml') {
    try { prepared = prepareMarkdownFileImport(bytes, { representation: 'tiptap_xml' }); }
    catch (error) {
      if (!(error instanceof MarkdownFileImportError) || error.code !== 'MARKDOWN_IMPORT_RICH_UNAVAILABLE') throw error;
      prepared = prepareMarkdownFileImport(bytes, { representation: 'plain_text' });
    }
  } else prepared = prepareMarkdownFileImport(bytes);
  if (prepared.yjsState.byteLength > BOOTSTRAP_STATE_LIMIT || prepared.stateVector.byteLength > BOOTSTRAP_VECTOR_LIMIT) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  const input: Captured = { workspace, path: selection.path, operationId: selection.operationId, requestId: selection.requestId,
    actorUserId: access.userId, actorSessionId: access.sessionId, expectedTarget: selection.expectedTarget, prepared,
    fingerprint: hash(JSON.stringify({ domain: 'canvas-pristine-original-bootstrap-v1', workspaceId: workspace.workspaceId,
      organizationId: workspace.organizationId ?? null, path: selection.path, operationId: selection.operationId, requestId: selection.requestId,
      userId: access.userId, sessionId: access.sessionId, expectedTarget: selection.expectedTarget,
      ...(frame.permission === 'canWrite' ? { requiredPermission: 'canWrite' } : {}),
      ...(frame.expectedScope ? { expectedRequestScope: frame.expectedScope } : {}),
      ...(initialRepresentation === 'auto' ? {} : { initialRepresentation }),
      originalLineageId: document?.lineage_id ?? null, lineageId: existing?.id ?? null, representation: prepared.representation,
      sourceHash: prepared.sourceHash, sourceBytes: prepared.sourceBytes, newlineStyle: prepared.newlineStyle, hasBom: prepared.hasBom,
      root: source.root.identity, source: [...source.root.entries.values()].map(entry => [entry.relativePath, entry.identity]) })) };
  inspectPersistedNativeCollaborationSnapshot(importedState(input, documentId, Date.now()), doc => {
    assertNativeDocumentSchema(doc, prepared.representation, getSchema(richMarkdownSchemaExtensions()));
  });
  await verify(); await assertWorkspaceOriginalPathCurrent(source);
  originalBootstrapScopes.set(input, { active: true, database, access, frame, documentId,
    originalLineageId: document?.lineage_id ?? null, lineage, source });
  return input;
}
async function bindBootstrapLineage(database: SqlConnection, input: Captured, scope: OriginalBootstrapScope, now: number) {
  await assertBootstrapScope(database, input, scope); await assertBootstrapVirgin(database, scope.documentId);
  if (!scope.lineage.existing) {
    await database.run(`INSERT INTO file_collaboration_lineages(id,organization_id,customer_id,project_id,workspace_id,workspace_type,path,status,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8)`, [scope.lineage.id, scope.lineage.organizationId, input.workspace.customerId ?? null,
    input.workspace.projectId ?? null, input.workspace.workspaceId, input.workspace.workspaceType, input.path, now]);
  }
  return scope.lineage;
}
async function initializeBootstrapRegistry(database: SqlConnection, input: Captured, scope: OriginalBootstrapScope, now: number) {
  await assertBootstrapScope(database, input, scope); await assertBootstrapVirgin(database, scope.documentId);
  const changed = await database.get(`UPDATE collaboration_documents SET lineage_id=$1,yjs_state_lifecycle='initialized',updated_at=$2
    WHERE id=$3 AND workspace_id=$4 AND organization_id IS NOT DISTINCT FROM $5 AND path=$6 AND provider='yjs' AND status='active'
      AND workspace_type=$7 AND lineage_id IS NOT DISTINCT FROM $8 AND state_version=0 AND yjs_state_lifecycle='never_initialized'
      AND NOT EXISTS(SELECT 1 FROM collaboration_yjs_states WHERE document_id=$3)
      AND NOT EXISTS(SELECT 1 FROM collaboration_yjs_state_backups WHERE document_id=$3)
      AND NOT EXISTS(SELECT 1 FROM collaboration_agent_operations WHERE document_id=$3) RETURNING id`,
  [scope.lineage.id, now, scope.documentId, input.workspace.workspaceId, input.workspace.organizationId ?? null, input.path,
    input.workspace.workspaceType, scope.originalLineageId]);
  if (!changed) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
}

function bootstrapSqlFlag(value: unknown): number {
  if (![false, true, 0, 1, '0', '1'].includes(value as never)) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
  return value === true || value === 1 || value === '1' ? 1 : 0;
}
function bootstrapSqlClock(value: unknown, minimum: number): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value))) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
  return number;
}
function normalizeBootstrapStateRow(row: Record<string, unknown>): Record<string, unknown> {
  if (!validId(row.document_id) || !validId(row.workspace_id) || row.organization_id !== null && !validId(row.organization_id)
    || !isCanonicalAdmissionPath(row.path as string) || row.status !== 'active'
    || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(row.representation as string)
    || !['lf', 'crlf'].includes(row.newline_style as string) || bootstrapSqlClock(row.schema_version, 1) !== 1) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
  const documentSequence = bootstrapSqlClock(row.document_sequence, 0), checkpointSequence = bootstrapSqlClock(row.checkpoint_sequence, 0);
  if (checkpointSequence > documentSequence) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
  const generation = bootstrapSqlClock(row.lifecycle_generation, 1); bootstrapSqlClock(row.persisted_at, 0);
  if (row.checkpointed_at !== null) bootstrapSqlClock(row.checkpointed_at, 0);
  const permanent = bootstrapSqlFlag(row.projection_error_permanent), code = row.projection_error_code;
  if (code !== null) {
    if (!validId(code) || row.projection_error_phase !== null && (typeof row.projection_error_phase !== 'string'
      || row.projection_error_phase.length > 256 || /[\u0000-\u001f\u007f]/u.test(row.projection_error_phase))) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
    const sequence = bootstrapSqlClock(row.projection_error_sequence, 0), errorGeneration = bootstrapSqlClock(row.projection_error_generation, 1);
    if (sequence > documentSequence || errorGeneration > generation || permanent === 1 && errorGeneration !== generation) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
  } else if (permanent !== 0 || row.projection_error_sequence !== null || row.projection_error_generation !== null
    || row.projection_error_phase !== null) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
  return { ...row, has_bom: bootstrapSqlFlag(row.has_bom), degraded: bootstrapSqlFlag(row.degraded),
    projection_error_permanent: permanent };
}
/** Only adapts genuine rows read on this fixed C. It carries no Principal or
 * mutation authority and cannot open, commit, close, or change a connection. */
function bootstrapStateReadConnection(database: SqlConnection): SqlConnection {
  const read = async (sql: string, values?: unknown[]) => {
    const rows = await database.all(sql, values);
    if (/^SELECT \* FROM collaboration_yjs_states\s+WHERE document_id = \$1(?:\s|$)/u.test(sql)) {
      return rows.map(row => normalizeBootstrapStateRow(row as Record<string, unknown>));
    }
    return rows;
  };
  return { all: read, get: async (sql, values) => (await read(sql, values))[0],
    run: () => fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED'), close: () => fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED') };
}

async function recoverOriginalBootstrap(input: Captured, frame: BootstrapFrame,
  openConnection: () => Promise<SqlConnection>): Promise<MarkdownFileImportResult> {
  const { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection } = await import('../workspaces/request-principal');
  // Actual reauthentication/license capture runs before C is opened or starts
  // SQL. Never renew an expired/poisoned old principal or reread the projection.
  return withWorkspaceRequestPrincipal(frame.request, { workspaceId: frame.selection.workspaceId, permission: frame.permission }, async principal => {
    await assertBootstrapOwner(frame);
    const database = await openConnection(); let discard: Error | undefined;
    if (database === frame.owner || database === originalBootstrapScopes.get(input)?.database) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
    try {
      const currentIdentity = await bootstrapConnectionRealm(database), before = frame.mutationIdentity;
      if (!before || currentIdentity.backend === before.backend && currentIdentity.start === before.start) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
      if (frame.expectedScope && currentIdentity.searchPath !== frame.expectedScope.searchPath) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
      await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
      await database.run("SELECT set_config('search_path',quote_ident($1)||', pg_catalog, pg_temp',true)", [frame.realm.schema]);
      const result = await withWorkspaceRequestPrincipalOnConnection(database, principal, async access => {
        if (access.userId !== input.actorUserId || access.sessionId !== input.actorSessionId
          || !sameBootstrapWorkspace(access.workspace, input.workspace)) return fail('MARKDOWN_IMPORT_REQUEST_CONFLICT');
        await assertBootstrapExpectedScope(database, frame, access);
        await assertBootstrapOwner(frame); await assertBootstrapNativeRealm(database, frame, true);
        await assertWorkspaceFileLifecycleSqlAvailable(database, input.workspace.workspaceId, [input.path]);
        await lockFileCollaborationPaths(database, input.workspace.workspaceId, [input.path]);
        const metadata = await database.get(`SELECT document_id,workspace_id,organization_id,path,status,representation,lifecycle_generation,
          schema_version,document_sequence,checkpoint_sequence,persisted_at,checkpointed_at,newline_style,has_bom,degraded,projection_error_permanent,
          projection_error_code,projection_error_sequence,projection_error_generation,projection_error_phase,
          octet_length(yjs_state) AS state_bytes,octet_length(state_vector) AS vector_bytes
          FROM collaboration_yjs_states WHERE document_id=(SELECT (private_result->'target'->>'documentId') FROM collaboration_markdown_file_import_receipts
            WHERE workspace_id=$1 AND operation_id=$2) LIMIT 1 FOR UPDATE`, [input.workspace.workspaceId, input.operationId]) as Record<string, unknown> | undefined;
        if (!metadata || bootstrapSqlClock(metadata.state_bytes, 1) > BOOTSTRAP_STATE_LIMIT
          || bootstrapSqlClock(metadata.vector_bytes, 1) > BOOTSTRAP_VECTOR_LIMIT) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
        normalizeBootstrapStateRow(metadata);
        const nativeReads = bootstrapStateReadConnection(database), prior = await confirmedRetry(nativeReads, input);
        if (!prior) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
        const current = await loadCollaborationStateOnConnection(nativeReads, prior.receipt.target.documentId, true);
        if (!current || current.yjsState.byteLength > BOOTSTRAP_STATE_LIMIT || current.stateVector.byteLength > BOOTSTRAP_VECTOR_LIMIT) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
        const observed = inspectPersistedNativeCollaborationSnapshot(current, (doc, snapshot) => {
          assertNativeDocumentSchema(doc, current.representation, getSchema(richMarkdownSchemaExtensions())); return snapshot;
        });
        if (observed.version.stateProof !== prior.currentObservation.stateProof) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
        await access.assertCurrent(); await assertBootstrapOwner(frame); await assertBootstrapExpectedScope(database, frame, access);
        return { disposition: 'commit-recovered' as const, ...prior };
      });
      await database.run('COMMIT'); await assertBootstrapOwner(frame); return result;
    } catch (error) {
      try { await database.run('ROLLBACK'); }
      catch (rollbackError) { discard = new Error('Discarding unresolved original bootstrap confirmation.', { cause: rollbackError }); }
      throw error;
    } finally { await database.close(discard); }
  });
}

/** Inactive private service entry. CanRead maps ONLY proven original bytes into
 * the first native state; no source overwrite, room/grant or public DTO occurs.
 * Recovery is limited to this retained attempt. A later absent/pristine request
 * rejects an initialized winner; callers must observe it through existing-only
 * native reads without claiming their own successful import. */
export async function persistPristineOriginalWorkspaceFile(request: NextRequest, selection: PristineOriginalWorkspaceFileRequest,
  dependencies: { openConnection: () => Promise<SqlConnection> } = { openConnection: openDb }): Promise<MarkdownFileImportResult> {
  return persistOriginalWorkspaceFile(request, selection, 'canRead', dependencies);
}

/** Authenticated session bootstrap. FIXED canWrite applies to the complete
 * mutation B and fresh recovery C. No caller permission flag can downgrade it.
 * The existing CanRead original-import entry retains its separate contract. */
export async function persistPristineOriginalWorkspaceFileForWrite(request: NextRequest, selection: PristineOriginalWorkspaceFileRequest,
  dependencies: { openConnection: () => Promise<SqlConnection>; expectedRequestScope?: PristineOriginalRequestScopeExpectation } = { openConnection: openDb }): Promise<MarkdownFileImportResult> {
  const expected = captureBootstrapExpectation(dependencies.expectedRequestScope);
  return persistOriginalWorkspaceFile(request, selection, 'canWrite', dependencies, expected);
}

async function persistOriginalWorkspaceFile(request: NextRequest, selection: PristineOriginalWorkspaceFileRequest,
  permission: 'canRead' | 'canWrite', dependencies: { openConnection: () => Promise<SqlConnection> },
  expectedScope?: PristineOriginalRequestScopeExpectation): Promise<MarkdownFileImportResult> {
  if (!(request instanceof NextRequest) || !selection || typeof selection !== 'object'
    || Object.getPrototypeOf(selection) !== Object.prototype
    || Reflect.ownKeys(selection).some(key => typeof key !== 'string'
      || !['workspaceId', 'path', 'operationId', 'requestId', 'expectedTarget', 'richFormat', 'initialRepresentation'].includes(key)
      || !Object.getOwnPropertyDescriptor(selection, key)?.enumerable
      || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(selection, key), 'value'))) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  const copied = structuredClone(selection), original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const openConnection = dependencies.openConnection;
  if (typeof openConnection !== 'function' || !validId(copied.workspaceId) || !validId(copied.operationId) || !validId(copied.requestId)
    || !isCanonicalAdmissionPath(copied.path) || isInternalWorkspaceStagingPath(copied.path) || !/\.(?:md|markdown|txt)$/iu.test(copied.path)
    || !copied.expectedTarget || typeof copied.expectedTarget !== 'object'
    || copied.expectedTarget.kind === 'absent' && !knownKeys(copied.expectedTarget, ['kind'])
    || copied.expectedTarget.kind === 'pristine' && (!validId(copied.expectedTarget.documentId) || !knownKeys(copied.expectedTarget, ['kind', 'documentId']))
    || !['absent', 'pristine'].includes(copied.expectedTarget.kind)
    || copied.richFormat !== undefined && !['tiptap_xml', 'tiptap_blocks'].includes(copied.richFormat)
    || copied.initialRepresentation !== undefined && !['auto', 'plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(copied.initialRepresentation)
    || copied.initialRepresentation !== undefined && copied.initialRepresentation !== 'auto' && copied.richFormat !== undefined
    || /\.txt$/iu.test(copied.path) && copied.initialRepresentation !== undefined
      && !['auto', 'plain_text'].includes(copied.initialRepresentation)) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  if (hasCollaborationHandoffExecutionContext() || getWorkspaceFileLifecycleLeases()?.size) return fail('MARKDOWN_IMPORT_BUSY');
  const { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection } = await import('../workspaces/request-principal');
  return withWorkspaceRequestPrincipal(original, { permission, workspaceId: copied.workspaceId }, async principal => {
    const runtime = getPostgresRuntimeQueryable();
    const source = runtime && (await runtime.query(`SELECT current_schema() AS schema,(SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database`)).rows[0];
    if (!source || typeof source.schema !== 'string' || !source.schema || !Number.isSafeInteger(Number(source.database))) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
    const realm: BootstrapRealm = { schema: source.schema, database: Number(source.database) };
    let owner: SqlConnection | undefined, ownerIdentity: BootstrapOwner | undefined;
    const openOwner = async () => {
      if (owner) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
      const connection = await openConnection();
      try {
        const identity = await bootstrapConnectionRealm(connection);
        if (identity.schema !== realm.schema || identity.database !== realm.database) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
        if (expectedScope && identity.searchPath !== expectedScope.searchPath) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
        owner = connection; ownerIdentity = identity; return connection;
      } catch (error) { await connection.close(new Error('Discarding mismatched original bootstrap owner.', { cause: error })); throw error; }
    };
    return withWorkspaceFileLifecycleGuard({ workspaceId: copied.workspaceId, paths: [copied.path] }, async () => {
      if (!owner || !ownerIdentity) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
      const frame: BootstrapFrame = { request: original, selection: copied, realm, owner, identity: ownerIdentity, permission, expectedScope };
      const openMutation = async () => {
        const database = await openConnection();
        if (database === owner) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
        try {
          const identity = await bootstrapConnectionRealm(database);
          if (identity.schema !== realm.schema || identity.database !== realm.database || identity.backend === frame.identity.backend) {
            return fail('MARKDOWN_IMPORT_INVALID_INPUT');
          }
          if (expectedScope && identity.searchPath !== expectedScope.searchPath) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
        } catch (error) {
          await database.close(new Error('Discarding mismatched original bootstrap mutation connection.', { cause: error })); throw error;
        }
        return database;
      };
      const outcome = await executeLifecycleTransaction<{ result: MarkdownFileImportResult; input: Captured }>({ openConnection: openMutation,
        execute: async database => {
          await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
          // The existing immutable receipt trigger uses this exact scoped path.
          // Fix it before Principal captures identity; never restore/mask drift.
          await database.run("SELECT set_config('search_path',quote_ident($1)||', pg_catalog, pg_temp',true)", [realm.schema]);
          return withWorkspaceRequestPrincipalOnConnection(database, principal, async access => {
            const input = await captureOriginalBootstrap(database, frame, access), scope = originalBootstrapScopes.get(input)!;
            try {
              const result = await executeCapturedMarkdownImportOnConnection(database, input, async () => {
                await assertBootstrapScope(database, input, scope); await assertWorkspaceOriginalPathCurrent(scope.source);
              });
              await assertBootstrapScope(database, input, scope); await assertWorkspaceOriginalPathCurrent(scope.source);
              return { result, input };
            } finally { scope.active = false; }
          });
        },
        recoverCommitted: async value => ({ input: value.input, result: await recoverOriginalBootstrap(value.input, frame, openConnection) }),
      });
      return outcome.result;
    }, openOwner);
  });
}

async function executeCapturedMarkdownImportOnConnection(database: SqlConnection, input: Captured,
  validateAuthority: MarkdownFileImportRequest['validateAuthority']): Promise<MarkdownFileImportResult> {
  const original = originalBootstrapScopes.get(input);
  if (original) await assertBootstrapScope(database, input, original);
  else { await database.run("SET LOCAL statement_timeout='5s'"); await database.run("SET LOCAL lock_timeout='4s'"); }
  await assertWorkspaceFileLifecycleSqlAvailable(database, input.workspace.workspaceId, [input.path]);
  await lockFileCollaborationPaths(database, input.workspace.workspaceId, [input.path]);
  const prior = await confirmedRetry(database, input);
  if (prior) return { disposition: 'already-applied', ...prior };
  const documents = await readWorkspaceDocumentCatalogue(database, input.workspace, { paths: [input.path] });
  const all = await database.all(`SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 AND status='active' FOR UPDATE`,
  [input.workspace.workspaceId, input.path]);
  const document = documents.find(document => document.path === input.path);
  if (input.expectedTarget.kind === 'absent' ? documents.length !== 0 || all.length !== 0
    : documents.length !== 1 || all.length !== 1 || !document || document.id !== input.expectedTarget.documentId
      || document.authority !== (input.expectedTarget.kind === 'pristine' ? 'pristine' : 'initialized')) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
  const documentId = document?.id ?? original?.documentId ?? `collab-${randomUUID()}`;
  const active = await database.get(`SELECT operation_id FROM collaboration_agent_operations WHERE document_id=$1
          AND status IN ('preparing','ready','applying','applied_to_ydoc','cancel_requested') LIMIT 1`, [documentId]);
  if (active) return fail('MARKDOWN_IMPORT_BUSY');
  let state: PersistedCollaborationState;
  if (input.expectedTarget.kind === 'initialized') {
    const current = await loadCollaborationStateOnConnection(database, documentId, true);
    if (!current || !document?.lineage_id || document.yjs_state_lifecycle !== 'initialized'
      || current.documentSequence < document.state_version) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
    const existingLineage = await database.get(`SELECT id FROM file_collaboration_lineages WHERE id=$1 AND workspace_id=$2
            AND organization_id IS NOT DISTINCT FROM $3 AND path=$4 AND status='active'`,
    [document.lineage_id, current.workspaceId, current.organizationId, current.path]);
    if (!existingLineage) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
    state = mutateEmpty(current, input);
  } else state = importedState(input, documentId, Date.now());
  const lineage = original ? await bindBootstrapLineage(database, input, original, state.persistedAt)
    : await ensureActiveFileLineage(database, { id: document?.lineage_id ?? `file-lineage-${randomUUID()}`,
    workspace: input.workspace, path: input.path, nowMs: state.persistedAt });
  if (lineage.organizationId !== state.organizationId || document?.lineage_id && lineage.id !== document.lineage_id) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
  await validateAuthority();
  if (input.expectedTarget.kind === 'initialized') {
    const changed = await database.get(`UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,document_sequence=$3,persisted_at=$4
            WHERE document_id=$5 AND workspace_id=$6 AND organization_id IS NOT DISTINCT FROM $7 AND path=$8 AND representation=$9
              AND lifecycle_generation=$10 AND schema_version=$11 AND document_sequence=$12 AND status='active' RETURNING document_id`,
    [Buffer.from(state.yjsState), Buffer.from(state.stateVector), state.documentSequence, state.persistedAt, documentId,
      state.workspaceId, state.organizationId, state.path, state.representation, state.lifecycleGeneration, state.schemaVersion, input.expectedTarget.documentSequence]);
    if (!changed) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
  } else await withWorkspaceFileLifecycleCollaborationWrite(state, async () => {
    const query = async (sql: string, values?: unknown[]) => await database.all(sql, values) as Array<Record<string, unknown>>;
    await lockFileLifecycleCollaborationWriterAdmission(query, state); await assertCollaborationAdmissionOpen(query, state);
    if (document && original) await initializeBootstrapRegistry(database, input, original, state.persistedAt);
    else if (document) await database.run(`UPDATE collaboration_documents SET lineage_id=$1,yjs_state_lifecycle='initialized',updated_at=$2
            WHERE id=$3 AND workspace_id=$4 AND organization_id IS NOT DISTINCT FROM $5 AND path=$6 AND provider='yjs' AND status='active'`,
    [lineage.id, state.persistedAt, documentId, state.workspaceId, state.organizationId, state.path]);
    else await database.run(`INSERT INTO collaboration_documents(id,lineage_id,organization_id,customer_id,project_id,workspace_id,
            workspace_type,path,provider,state_version,status,created_at,updated_at,yjs_state_lifecycle)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,'yjs',0,'active',$9,$9,'initialized')`,
    [documentId, lineage.id, state.organizationId, input.workspace.customerId ?? null, input.workspace.projectId ?? null,
      state.workspaceId, input.workspace.workspaceType, state.path, state.persistedAt]);
    await database.run(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,
            schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpointed_at,checkpoint_sequence,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
            VALUES($1,$2,$3,$4,$5,1,1,$6,$7,0,$8,NULL,0,NULL,NULL,$9,$10,0,'active')`,
    [documentId, state.workspaceId, state.organizationId, state.path, state.representation, Buffer.from(state.yjsState),
      Buffer.from(state.stateVector), state.persistedAt, state.newlineStyle, state.hasBom ? 1 : 0]);
  });
  const snapshot = authoritativeNativeCollaborationSnapshot(state);
  const after = inspectPersistedNativeCollaborationSnapshot(state, doc => captureAgentStateSnapshot(doc, Y));
  if (!after || after.byteLength > MARKDOWN_FILE_IMPORT_LIMIT) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  const receipt: MarkdownFileImportReceipt = { version: 1, operationId: input.operationId, requestFingerprint: input.fingerprint,
    sourceHash: input.prepared.sourceHash, sourceBytes: input.prepared.sourceBytes,
    target: { ...Object.fromEntries(identityKeys.map(key => [key, state[key]])) as MarkdownImportIdentity,
      lineageId: lineage.id, initialSequence: state.documentSequence, initialStateProof: snapshot.version.stateProof, persistedAt: state.persistedAt }, checkpointRequired: true };
  await database.run(`INSERT INTO collaboration_markdown_file_import_receipts(workspace_id,operation_id,organization_id,actor_user_id,
          actor_session_id,request_id,version,request_fingerprint,private_result,after_state_snapshot,created_at)
          VALUES($1,$2,$3,$4,$5,$6,1,$7,$8::jsonb,$9,$10)`,
  [state.workspaceId, input.operationId, state.organizationId, input.actorUserId, input.actorSessionId, input.requestId,
    input.fingerprint, JSON.stringify(receipt), Buffer.from(after), state.persistedAt]);
  return { disposition: 'applied', receipt, currentObservation: { documentSequence: state.documentSequence,
    stateProof: snapshot.version.stateProof, persistedAt: state.persistedAt } };
}

async function recoverCapturedMarkdownImportCommit(input: Captured, openConnection: () => Promise<SqlConnection>,
  validateAuthority: MarkdownFileImportRequest['validateAuthority']): Promise<MarkdownFileImportResult> {
  const database = await openConnection(); let discard: Error | undefined;
  try {
    const lease = getWorkspaceFileLifecycleLeases()?.get(input.workspace.workspaceId);
    if (!lease?.active || !await lease.verify()) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
    await validateAuthority();
    await database.run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const prior = await confirmedRetry(database, input);
    if (!prior) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
    await database.run('COMMIT');
    if (!lease.active || !await lease.verify()) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
    return { disposition: 'commit-recovered', ...prior };
  } catch (error) {
    try { await database.run('ROLLBACK'); } catch (rollbackError) { discard = new Error('Discarding unresolved import receipt verification.', { cause: rollbackError }); }
    throw error;
  } finally { await database.close(discard); }
}

/** Internal complete-file capability. No file write, room mutation bypass,
 * representation migration, public response or projection completion occurs. */
export async function persistMarkdownFileImport(request: MarkdownFileImportRequest,
  dependencies: { openConnection: () => Promise<SqlConnection> } = { openConnection: openDb }): Promise<MarkdownFileImportResult> {
  const input = capture(request), validateAuthority = request.validateAuthority;
  return withWorkspaceFileLifecycleGuard({ workspaceId: input.workspace.workspaceId, paths: [input.path] }, async () => {
    await validateAuthority();
    return executeLifecycleTransaction<MarkdownFileImportResult>({ openConnection: dependencies.openConnection,
      execute: async database => executeCapturedMarkdownImportOnConnection(database, input, validateAuthority),
      recoverCommitted: async () => recoverCapturedMarkdownImportCommit(input, () => dependencies.openConnection(), validateAuthority),
    });
  }, dependencies.openConnection);
}
