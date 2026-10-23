import 'server-only';

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { NextRequest } from 'next/server';

import { openDb, type SqlConnection } from '../db';
import { persistedUpdateIncludesAgentSnapshot } from '../collaboration/agent-durability';
import { authenticatedNativeTextSessionEnabled } from '../collaboration/native-text-session-activation';
import { persistPristineOriginalWorkspaceFileForWrite, type MarkdownFileImportReceipt,
  type PristineOriginalRequestScopeExpectation, type PristineOriginalWorkspaceFileRequest } from '../collaboration/markdown-file-import-persistence';
import { withAuthenticatedExistingNativeCollaborationSessionOnConnection } from '../collaboration/native-session-state-reader';
import { loadCollaborationStateOnConnection } from '../collaboration/persistence';
import { Y } from '../collaboration/server-runtime';
import { readWorkspaceDocumentCatalogue } from '../collaboration/workspace-document-catalogue';
import { assertWorkspaceOriginalPathCurrent, readWorkspaceOriginalFileSource } from '../files/workspace-original-file-source';
import { filesystemFileVersion } from '../filesystem/file-version';
import { withWorkspaceRequestPrincipalOnConnection, withWorkspaceRequestPrincipalOriginalOrigin,
  type WorkspaceRequestHistoricalOrigin } from './request-principal';
import { WORKSPACE_STARTER_MAX_BYTES } from './starter-document';
import { readWorkspaceStarterInitializationIntent, type WorkspaceStarterInitializationIntent } from './starter-document-initialization-store';
import type { WorkspaceStarterInitializationResult } from './starter-document-initialization-contract';

export type WorkspaceStarterInitializationOptions = Readonly<{ requireIntent?: true }>;
type Prepared = Readonly<{ scope: PristineOriginalRequestScopeExpectation; intent: WorkspaceStarterInitializationIntent;
  target: PristineOriginalWorkspaceFileRequest['expectedTarget']; completed: boolean }>;
type Inspection = Prepared | WorkspaceStarterInitializationResult;
const relations = ['canvas_workspace_starter_initializations', 'collaboration_markdown_file_import_receipts',
  'collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages'] as const;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const id = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 256
  && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const integer = (value: unknown, minimum = 0) => (typeof value === 'number' || typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value))
  && Number.isSafeInteger(Number(value)) && Number(value) >= minimum;
class StarterInitializationError extends Error {
  constructor(readonly code: 'SOURCE_CHANGED' | 'SCOPE_CHANGED' | 'RECEIPT_CHANGED' | 'TARGET_CHANGED' | 'UNCONFIRMED') {
    super(code); this.name = 'StarterInitializationError';
  }
}
function fail(code: StarterInitializationError['code']): never { throw new StarterInitializationError(code); }
function result(workspaceId: string, status: WorkspaceStarterInitializationResult['status'], code?: string,
  intent?: WorkspaceStarterInitializationIntent): WorkspaceStarterInitializationResult {
  return Object.freeze({ version: 1, workspaceId, status, ...(code ? { code: `WORKSPACE_STARTER_${code}` } : {}),
    ...(intent ? { operationId: intent.operationId, requestId: intent.requestId } : {}) });
}
function publicFailure(workspaceId: string, error: unknown, intent?: WorkspaceStarterInitializationIntent): WorkspaceStarterInitializationResult {
  // Cleanup/commit uncertainty must not become a definitive business denial.
  // Only named, known original errors are classified; arbitrary causes stay private.
  const code = error instanceof Error && typeof Reflect.get(error, 'code') === 'string' ? String(Reflect.get(error, 'code')) : '';
  const uncertain = error instanceof AggregateError || error instanceof Error && Reflect.get(error, 'status') === 503
    || ['MARKDOWN_IMPORT_COMMIT_UNCONFIRMED', 'PRINCIPAL_BUSY', 'PRINCIPAL_EXPIRED', 'PRINCIPAL_WORKSPACE_UNCONFIRMED', 'MARKDOWN_IMPORT_BUSY', '55P03', '25P04'].includes(code);
  if (uncertain) return result(workspaceId, 'pending', 'INITIALIZATION_UNCONFIRMED', intent);
  if (error instanceof StarterInitializationError) return result(workspaceId, error.code === 'UNCONFIRMED' ? 'pending' : 'blocked', error.code, intent);
  if (['PRINCIPAL_AUTH_REVOKED', 'PRINCIPAL_ACCESS_DENIED', 'PRINCIPAL_SCOPE_CHANGED'].includes(code)) {
    return result(workspaceId, 'blocked', 'ACCESS_CHANGED', intent);
  }
  if (['MARKDOWN_IMPORT_TARGET_CHANGED', 'MARKDOWN_IMPORT_TARGET_NOT_EMPTY', 'MARKDOWN_IMPORT_LIFECYCLE_REQUIRED', 'MARKDOWN_IMPORT_REQUEST_CONFLICT',
    'NATIVE_SESSION_SCOPE_CHANGED', 'NATIVE_SESSION_STATE_MISSING', 'NATIVE_SESSION_STATE_INVALID', 'NATIVE_SESSION_QUARANTINED', 'NATIVE_SESSION_TOO_LARGE',
    'physical-scope-changed', 'physical-source-changed', 'unsafe-physical-source', 'source-too-large', 'ENOENT', 'ENOTDIR', 'ELOOP'].includes(code)) {
    return result(workspaceId, 'blocked', 'TARGET_CHANGED', intent);
  }
  return result(workspaceId, 'pending', 'INITIALIZATION_UNCONFIRMED', intent);
}
function snapshotRequest(request: NextRequest, workspaceId: string): NextRequest {
  if (!(request instanceof NextRequest) || !id(workspaceId)) fail('SCOPE_CHANGED');
  return new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
}
function scopeFrom(origin: WorkspaceRequestHistoricalOrigin | undefined): PristineOriginalRequestScopeExpectation {
  if (!origin) return fail('UNCONFIRMED');
  const { userId, sessionId, workspaceId, workspaceType, organizationId, projectId, customerId, ownerUserId,
    rootPath, rootRelativePath, schema, schemaOid, databaseOid, searchPath } = origin;
  if (!['personal', 'team', 'organization', 'project'].includes(workspaceType)) return fail('SCOPE_CHANGED');
  return Object.freeze({ userId, sessionId, workspaceId, workspaceType: workspaceType as PristineOriginalRequestScopeExpectation['workspaceType'],
    organizationId, projectId, customerId, ownerUserId, rootPath, rootRelativePath, legacy: false, status: 'active', schema, schemaOid, databaseOid, searchPath });
}
function assertIntent(intent: WorkspaceStarterInitializationIntent, scope: PristineOriginalRequestScopeExpectation): void {
  if (intent.workspaceId !== scope.workspaceId || intent.actorUserId !== scope.userId || intent.organizationId !== scope.organizationId
    || intent.workspaceType !== scope.workspaceType || intent.projectId !== scope.projectId || intent.rootRelativePath !== scope.rootRelativePath) fail('SCOPE_CHANGED');
}
async function bindStorage(database: SqlConnection, scope: PristineOriginalRequestScopeExpectation): Promise<void> {
  const row = await database.get(`SELECT current_schema() AS schema,to_regnamespace(current_schema())::oid::bigint AS schema_oid,
    (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid,current_setting('search_path') AS search_path`) as Record<string, unknown> | undefined;
  if (!row || row.schema !== scope.schema || Number(row.schema_oid) !== scope.schemaOid || Number(row.database_oid) !== scope.databaseOid
    || row.search_path !== scope.searchPath) fail('SCOPE_CHANGED');
  const rows = await database.all(`SELECT n.name,c.oid::bigint AS oid,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
    pg_catalog.to_regclass(n.name)::oid::bigint AS unqualified_oid FROM unnest($1::text[]) n(name)
    LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass($2||'.'||quote_ident(n.name))`, [relations, quote(scope.schema)]) as Record<string, unknown>[];
  if (rows.length !== relations.length || relations.some(name => rows.filter(row => row.name === name && integer(row.oid, 1)
    && Number(row.oid) === Number(row.unqualified_oid) && row.relkind === 'r' && row.relrowsecurity === false && row.relforcerowsecurity === false).length !== 1)) fail('UNCONFIRMED');
  await database.run(`LOCK TABLE ${relations.map(name => `${quote(scope.schema)}.${quote(name)}`).sort().join(',')} IN ACCESS SHARE MODE NOWAIT`);
}
function plain(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => { const property = Object.getOwnPropertyDescriptor(value, key); return property?.enumerable && Object.prototype.hasOwnProperty.call(property, 'value'); });
}
async function readReceipt(database: SqlConnection, scope: PristineOriginalRequestScopeExpectation,
  intent: WorkspaceStarterInitializationIntent): Promise<{ receipt: MarkdownFileImportReceipt; snapshot: Uint8Array } | null> {
  const rows = await database.all(`SELECT workspace_id,operation_id,organization_id,actor_user_id,actor_session_id,request_id,version,request_fingerprint,
    CASE WHEN pg_column_size(private_result)<=32768 THEN private_result ELSE NULL END AS private_result,
    CASE WHEN octet_length(after_state_snapshot) BETWEEN 1 AND 8388608 THEN after_state_snapshot ELSE NULL END AS after_state_snapshot
    FROM ${quote(scope.schema)}.collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND (operation_id=$2 OR request_id=$3) LIMIT 2`,
  [intent.workspaceId, intent.operationId, intent.requestId]) as Record<string, unknown>[];
  if (!rows.length) return null;
  if (rows.length !== 1) return fail('RECEIPT_CHANGED');
  const row = rows[0], receipt = row.private_result;
  const keys = ['documentId', 'workspaceId', 'organizationId', 'path', 'representation', 'schemaVersion', 'lifecycleGeneration',
    'newlineStyle', 'hasBom', 'lineageId', 'initialSequence', 'initialStateProof', 'persistedAt'];
  if (row.workspace_id !== intent.workspaceId || row.operation_id !== intent.operationId || row.organization_id !== intent.organizationId
    || row.actor_user_id !== intent.actorUserId || !id(row.actor_session_id) || row.request_id !== intent.requestId || row.version !== 1
    || typeof row.request_fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(row.request_fingerprint)
    || !plain(receipt, ['version', 'operationId', 'requestFingerprint', 'sourceHash', 'sourceBytes', 'target', 'checkpointRequired'])
    || receipt.version !== 1 || receipt.operationId !== intent.operationId || receipt.requestFingerprint !== row.request_fingerprint
    || receipt.sourceHash !== intent.sourceSha256 || receipt.sourceBytes !== intent.sourceBytes || receipt.checkpointRequired !== true
    || !plain(receipt.target, keys)) return fail('RECEIPT_CHANGED');
  const target = receipt.target;
  if (!id(target.documentId) || !id(target.lineageId) || target.workspaceId !== intent.workspaceId || target.organizationId !== intent.organizationId
    || target.path !== intent.path || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(target.representation as string) || target.schemaVersion !== 1
    || target.lifecycleGeneration !== 1 || target.initialSequence !== 0 || !integer(target.persistedAt)
    || !['lf', 'crlf'].includes(target.newlineStyle as string) || typeof target.hasBom !== 'boolean'
    || !(row.after_state_snapshot instanceof Uint8Array) || target.initialStateProof !== `yjs-snapshot-sha256-v1:${digest(row.after_state_snapshot)}`) return fail('RECEIPT_CHANGED');
  return { receipt: receipt as unknown as MarkdownFileImportReceipt, snapshot: Uint8Array.from(row.after_state_snapshot) };
}
async function transaction<T>(operation: (database: SqlConnection) => Promise<T>): Promise<T> {
  const database = await openDb(); let began = false, committed = false, failed = false, failure: unknown, value: T | undefined;
  const errors: unknown[] = [];
  try {
    await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); began = true;
    value = await operation(database);
    await database.run('COMMIT'); committed = true;
  } catch (error) {
    failed = true; failure = error;
    if (began && !committed) try { await database.run('ROLLBACK'); } catch (cleanup) { errors.push(cleanup); }
  } finally {
    try { await database.close(failed ? new Error('Starter inspection did not complete.', { cause: failure }) : undefined); }
    catch (cleanup) { errors.push(cleanup); }
  }
  if (errors.length) throw new AggregateError(failed ? [failure, ...errors] : errors, 'Starter inspection cleanup is unconfirmed.');
  if (failed) throw failure;
  return value as T;
}
async function inspect(request: NextRequest, workspaceId: string, permission: 'canRead' | 'canWrite',
  requireIntent: boolean, enabled: boolean): Promise<Inspection> {
  let original: WorkspaceRequestHistoricalOrigin | undefined;
  return withWorkspaceRequestPrincipalOriginalOrigin(request, { permission, workspaceId }, origin => { original = origin; },
    principal => transaction(async database => {
      const prepared = await withWorkspaceRequestPrincipalOnConnection(database, principal, async access => {
        const scope = scopeFrom(original); await bindStorage(database, scope);
        const intent = await readWorkspaceStarterInitializationIntent(database, workspaceId);
        if (!intent) return result(workspaceId, requireIntent || enabled ? 'pending' : 'not_required',
          requireIntent || enabled ? 'INITIALIZATION_UNCONFIRMED' : undefined);
        assertIntent(intent, scope);
        const receipt = await readReceipt(database, scope, intent);
        const documents = await readWorkspaceDocumentCatalogue(database, access.workspace, { paths: [intent.path], maxEntries: 2 });
        if (documents.length > 1 || documents.some(document => document.path !== intent.path)) fail('TARGET_CHANGED');
        const document = documents[0];
        if (!receipt && document && document.authority !== 'pristine') fail('TARGET_CHANGED');
        await access.assertCurrent();
        return { scope, intent, receipt, target: document ? { kind: 'pristine' as const, documentId: document.id } : { kind: 'absent' as const } };
      });
      if ('status' in prepared) return prepared;
      if (prepared.receipt) {
        const { receipt, snapshot } = prepared.receipt, target = receipt.target;
        await withAuthenticatedExistingNativeCollaborationSessionOnConnection(database, principal, { path: prepared.intent.path,
          expectedIdentity: { documentId: target.documentId, lineageId: target.lineageId, workspaceId: target.workspaceId,
            organizationId: target.organizationId, path: target.path, lifecycleGeneration: target.lifecycleGeneration,
            representation: target.representation, schemaVersion: target.schemaVersion } }, async (session, access) => {
          if (!isDeepStrictEqual(scopeFrom(original), prepared.scope)) fail('SCOPE_CHANGED');
          assertIntent(prepared.intent, prepared.scope);
          const current = await loadCollaborationStateOnConnection(database, target.documentId, true);
          const empty = Y.encodeSnapshot(Y.createSnapshot(Y.createDeleteSet(), new Map()));
          if (!current || current.documentSequence !== session.snapshot.documentSequence || current.documentSequence < target.initialSequence
            || !Buffer.from(snapshot).equals(Buffer.from(empty)) && !persistedUpdateIncludesAgentSnapshot(current.yjsState, snapshot, Y)) fail('RECEIPT_CHANGED');
          await access.assertCurrent();
        });
      }
      return Object.freeze({ scope: prepared.scope, intent: prepared.intent, target: prepared.target, completed: !!prepared.receipt });
    }));
}
async function assertSource(prepared: Prepared): Promise<void> {
  const { intent, scope } = prepared, resolvedRootPath = await fs.realpath(scope.rootPath), rootStat = await fs.stat(resolvedRootPath);
  if (!rootStat.isDirectory()) fail('SOURCE_CHANGED');
  const stat = await fs.lstat(path.join(resolvedRootPath, intent.path));
  if (filesystemFileVersion(stat) !== intent.sourceFileVersion) fail('SOURCE_CHANGED');
  const observed = { relativePath: intent.path, stat, identity: filesystemFileVersion(stat) };
  const source = { configuredRootPath: scope.rootPath, root: { resolvedRootPath, identity: filesystemFileVersion(rootStat),
    entries: new Map([[intent.path, observed]]) }, observed };
  const bytes = await readWorkspaceOriginalFileSource({ ...source, maxBytes: WORKSPACE_STARTER_MAX_BYTES,
    verifyCurrentSource: () => assertWorkspaceOriginalPathCurrent(source) });
  if (bytes.byteLength !== intent.sourceBytes || digest(bytes) !== intent.sourceSha256) fail('SOURCE_CHANGED');
}
async function initialize(request: NextRequest, workspaceId: string, options: WorkspaceStarterInitializationOptions, mutate: boolean): Promise<WorkspaceStarterInitializationResult> {
  let prepared: Prepared | undefined;
  try {
    // Both actual credentials and optional behavior are captured before any await.
    const original = snapshotRequest(request, workspaceId), requireIntent = options.requireIntent === true;
    const enabled = authenticatedNativeTextSessionEnabled();
    const inspection = await inspect(original, workspaceId, mutate ? 'canWrite' : 'canRead', requireIntent, enabled);
    if ('status' in inspection) return inspection;
    prepared = inspection;
    if (prepared.completed) return result(workspaceId, 'completed', undefined, prepared.intent);
    await assertSource(prepared);
    if (!mutate || !enabled) return result(workspaceId, 'pending', enabled ? 'INITIALIZATION_PENDING' : 'INITIALIZATION_DISABLED', prepared.intent);
    // This entire actual A/B transaction and its connection/factory lifetime
    // have ended. The original importer owns its own lifecycle and A+B+C.
    const imported = await persistPristineOriginalWorkspaceFileForWrite(original, { workspaceId, path: prepared.intent.path,
      operationId: prepared.intent.operationId, requestId: prepared.intent.requestId, expectedTarget: prepared.target,
      expectedFileVersion: prepared.intent.sourceFileVersion }, { openConnection: openDb, expectedRequestScope: prepared.scope });
    if (imported.receipt.operationId !== prepared.intent.operationId || imported.receipt.sourceHash !== prepared.intent.sourceSha256
      || imported.receipt.sourceBytes !== prepared.intent.sourceBytes || imported.receipt.target.workspaceId !== workspaceId
      || imported.receipt.target.organizationId !== prepared.intent.organizationId || imported.receipt.target.path !== prepared.intent.path) fail('RECEIPT_CHANGED');
    return result(workspaceId, 'completed', undefined, prepared.intent);
  } catch (error) { return publicFailure(workspaceId, error, prepared?.intent); }
}

/** Admit only the saved original source through the existing genuine request import. */
export function completeWorkspaceStarterDocumentInitialization(request: NextRequest, workspaceId: string,
  options: WorkspaceStarterInitializationOptions = {}): Promise<WorkspaceStarterInitializationResult> {
  return initialize(request, workspaceId, options, true);
}
/** Read the immutable attempt and its original central receipt; never initialize. */
export function observeWorkspaceStarterDocumentInitialization(request: NextRequest, workspaceId: string,
  options: WorkspaceStarterInitializationOptions = {}): Promise<WorkspaceStarterInitializationResult> {
  return initialize(request, workspaceId, options, false);
}
