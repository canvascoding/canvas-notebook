import 'server-only';

import { createHash } from 'node:crypto';
import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { lockFileCollaborationPaths } from '../files/collaboration-repository';
import { inspectArchivedNativeSnapshot, ARCHIVED_NATIVE_BINARY_LIMIT } from '../collaboration/archived-native-snapshot';
import { authoritativeNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { captureAgentStateSnapshot, persistedUpdateIncludesAgentSnapshot } from '../collaboration/agent-durability';
import { loadCollaborationStateOnConnection, type PersistedCollaborationState } from '../collaboration/persistence';
import { Y } from '../collaboration/server-runtime';
import { COLLABORATION_SCHEMA_VERSION } from '../collaboration/types';
import { isCollaborationStateProof } from '../collaboration/state-proof';
import { admissionScopeContains, captureCollaborationAdmissionRequest, collaborationAdmissionActionDigest,
  isCanonicalAdmissionPath, type CollaborationAdmissionRequest } from '../collaboration/room-admission-contract';
import { claimCollaborationAdmissionMutation, requireCollaborationAdmissionMutationRequest,
  withCollaborationAdmissionMutation } from '../collaboration/room-admission-handoff';
import { readCollaborationAdmissionOutcome } from '../collaboration/room-admission-outcome';
import { captureNativeFileOperationBundle, type NativeFileOperationBundle, type NativeFileOperationReceipt } from './native-file-operation-handoff';
import { readCommittedNativeFileOperationSideEffectsOnConnection } from './native-file-operation-side-effects';
import type { NativeLinkDocumentIdentity } from './workspace-link-contract-v2';

type Row = Record<string, unknown>;
type Actor = NativeFileOperationBundle['actor'];
type Clock = NativeFileOperationReceipt['before'];
export type NativeRestoreIntent = {
  version: 1; operationId: string; mutationId: string; requestId: string; actor: Actor; reviewDigest: string;
  workspaceType: WorkspaceContext['workspaceType'];
  source: NativeLinkDocumentIdentity; lineageId: string; trashEntryId: string; before: Clock;
  archive: { request: CollaborationAdmissionRequest; operationId: string; mutationId: string;
    receiptDigest: string; nativeReceiptSetProof: string; sideEffectSetProof: string };
};
export type NativeRestoreReceipt = Omit<NativeRestoreIntent, 'archive'> & {
  archive: Omit<NativeRestoreIntent['archive'], 'request'> & { requestId: string; requestDigest: string };
  requestDigest: string; changesBundleProof: string; beforeArchivedAt: number;
  after: { identity: NativeLinkDocumentIdentity; status: 'active'; clock: Clock; registryStateVersion: 0 };
  projection: { status: 'pending'; path: string; filesystemComplete: false };
};
type Identity = { schema: string; backend: number; backendStart: string; transaction: string };
type Prepared = { identity: Identity; requestDigest: string; captured: ReturnType<typeof captureNativeRestoreIntent>;
  principal: Actor; workspace: WorkspaceContext; state: 'prepared' | 'applying' };
const preparations = new WeakMap<SqlConnection, Prepared>();
const PRIVATE_LIMIT = 2 * 1024 * 1024;
const relations = ['collaboration_native_restore_intents', 'collaboration_native_restore_receipts',
  'collaboration_native_file_operation_intents', 'collaboration_native_file_operation_receipts',
  'collaboration_native_file_operation_side_effect_stages', 'collaboration_native_file_operation_side_effect_receipts',
  'collaboration_admission_requests', 'collaboration_admission_targets', 'collaboration_documents',
  'file_collaboration_lineages', 'collaboration_yjs_states', 'collaboration_file_projections', 'collaboration_agent_operations'];
export class NativeRestoreError extends Error {
  readonly status = 409;
  constructor(readonly code: 'NATIVE_RESTORE_INVALID' | 'NATIVE_RESTORE_ARCHIVE_UNCONFIRMED' | 'NATIVE_RESTORE_SOURCE_CHANGED'
    | 'NATIVE_RESTORE_DESTINATION_CONFLICT' | 'NATIVE_RESTORE_AUTHORITY_REQUIRED' | 'NATIVE_RESTORE_UNCONFIRMED') {
    super(code); this.name = 'NativeRestoreError';
  }
}
function fail(code: NativeRestoreError['code']): never { throw new NativeRestoreError(code); }
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const safe = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value)
  && value >= minimum && value < Number.MAX_SAFE_INTEGER;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, node) => node && typeof node === 'object' && !Array.isArray(node)
  ? Object.fromEntries(Object.keys(node).sort().map(key => [key, node[key]])) : node);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function number(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value))) fail('NATIVE_RESTORE_SOURCE_CHANGED');
  const parsed = Number(value); if (!safe(parsed)) fail('NATIVE_RESTORE_SOURCE_CHANGED'); return parsed;
}
function bounded(value: unknown, limit: number): asserts value is string {
  if (typeof value !== 'string' || value.length > limit || Buffer.byteLength(value) > limit) fail('NATIVE_RESTORE_INVALID');
}
function budget(value: unknown): void {
  let nodes = 0, bytes = 0; const ancestors = new Set<object>();
  const visit = (node: unknown, depth: number): void => {
    if (++nodes > 32_768 || depth > 20) fail('NATIVE_RESTORE_INVALID');
    if (typeof node === 'string') { bounded(node, 1024 * 1024); bytes += Buffer.byteLength(JSON.stringify(node)); }
    else if (node === null || typeof node === 'boolean' || typeof node === 'number' && Number.isFinite(node)) bytes += 32;
    else {
      if (typeof node !== 'object' || ancestors.has(node) || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(node))) fail('NATIVE_RESTORE_INVALID');
      if (Array.isArray(node) && node.length > 1024) fail('NATIVE_RESTORE_INVALID');
      ancestors.add(node); bytes += 2;
      for (const key in node) if (Object.hasOwn(node, key)) {
        if (key.length > 256 || Array.isArray(node) && !/^(?:0|[1-9][0-9]*)$/u.test(key)) fail('NATIVE_RESTORE_INVALID');
        const descriptor = Object.getOwnPropertyDescriptor(node, key)!;
        if (descriptor.get || descriptor.set) fail('NATIVE_RESTORE_INVALID');
        bytes += Buffer.byteLength(JSON.stringify(key)) + 2; visit(descriptor.value, depth + 1);
      }
      ancestors.delete(node);
    }
    if (bytes > PRIVATE_LIMIT) fail('NATIVE_RESTORE_INVALID');
  };
  visit(value, 0);
}
function actorValid(actor: Actor): boolean {
  return !!actor && validId(actor.actorId) && validId(actor.actorUserId) && ['user', 'agent', 'automation', 'system'].includes(actor.actorType)
    && (actor.actorSessionId === null || validId(actor.actorSessionId));
}

/** Pure private capture: bounds precede cloning/JSON allocation; no principal,
 * lifecycle permission or Yjs identity is created by staging this intent. */
export function captureNativeRestoreIntent(input: NativeRestoreIntent) {
  budget(input);
  const source = input?.source, archive = input?.archive;
  if (input?.version !== 1 || !validId(input.operationId) || !validId(input.mutationId) || !actorValid(input.actor)
    || !validHash(input.reviewDigest) || !validId(input.lineageId) || !validId(input.trashEntryId)
    || !['personal', 'organization', 'team', 'project'].includes(input.workspaceType)
    || !source || !validId(source.documentId) || !validId(source.workspaceId) || source.organizationId !== null && !validId(source.organizationId)
    || !isCanonicalAdmissionPath(source.path) || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(source.representation)
    || !safe(source.lifecycleGeneration, 1) || source.schemaVersion !== COLLABORATION_SCHEMA_VERSION
    || !input.before || !safe(input.before.documentSequence) || !safe(input.before.persistedAt)
    || !validHash(input.before.binaryHash) || !isCollaborationStateProof(input.before.stateProof)
    || typeof input.before.stateVector !== 'string' || input.before.stateVector.length > 1024 * 1024
    || Buffer.from(input.before.stateVector, 'base64').toString('base64') !== input.before.stateVector
    || !archive || !validId(archive.operationId) || !validId(archive.mutationId) || archive.operationId === input.operationId
    || ![archive.receiptDigest, archive.nativeReceiptSetProof, archive.sideEffectSetProof].every(validHash)) fail('NATIVE_RESTORE_INVALID');
  const archived = captureCollaborationAdmissionRequest(archive.request);
  if (archived.request.action !== 'archive') fail('NATIVE_RESTORE_INVALID');
  const intent = structuredClone({ version: 1 as const, operationId: input.operationId, mutationId: input.mutationId,
    requestId: input.requestId, actor: input.actor, reviewDigest: input.reviewDigest, workspaceType: input.workspaceType, source, lineageId: input.lineageId,
    trashEntryId: input.trashEntryId, before: input.before, archive: { ...archive, request: archived.request } });
  // Canonical known shapes; unknown fields cannot hide outside the private proof.
  if (canonical(intent) !== canonical(input)) fail('NATIVE_RESTORE_INVALID');
  const privateText = canonical(intent); bounded(privateText, PRIVATE_LIMIT);
  const changesBundleProof = hash(privateText);
  const actionPayloadText = canonical({ kind: 'native_restore', version: 1, operationId: intent.operationId,
    requestId: intent.requestId, actor: intent.actor, reviewDigest: intent.reviewDigest, changesBundleProof });
  captureCollaborationAdmissionRequest({ requestId: intent.requestId, actorId: intent.actor.actorId, action: 'restore', actionPayloadText,
    actionDigest: collaborationAdmissionActionDigest('restore', actionPayloadText),
    scopes: [{ workspaceId: source.workspaceId, organizationId: source.organizationId, path: source.path, kind: 'exact' }],
    expectedDocuments: [{ ...source, status: 'archived' }] });
  return { intent, privateText, changesBundleProof, actionPayloadText };
}
async function connectionIdentity(database: SqlConnection): Promise<Identity> {
  const row = await database.get(`SELECT current_schema() AS schema_name,pg_backend_pid() AS backend,
    (SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS backend_start,
    pg_current_xact_id()::text AS transaction_id,current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS readonly`) as Row | undefined;
  if (!row || typeof row.schema_name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/u.test(row.schema_name)
    || !safe(row.backend, 1) || typeof row.backend_start !== 'string' || !row.backend_start
    || typeof row.transaction_id !== 'string' || !/^[0-9]{1,32}$/u.test(row.transaction_id)
    || row.isolation !== 'read committed' || row.readonly !== 'off') fail('NATIVE_RESTORE_AUTHORITY_REQUIRED');
  return { schema: row.schema_name, backend: row.backend, backendStart: row.backend_start, transaction: row.transaction_id };
}
async function schemaMatches(database: SqlConnection, identity: Identity): Promise<void> {
  for (const name of relations) {
    const row = await database.get('SELECT to_regclass($1)::oid=to_regclass($2)::oid AS same_relation', [name, `${quote(identity.schema)}.${quote(name)}`]) as Row | undefined;
    if (row?.same_relation !== true) fail('NATIVE_RESTORE_AUTHORITY_REQUIRED');
  }
}
function assertPrincipal(workspace: WorkspaceContext, principal: Actor, intent: NativeRestoreIntent): void {
  if (!workspace || workspace.legacy || workspace.status !== 'active' || workspace.workspaceId !== intent.source.workspaceId || workspace.workspaceType !== intent.workspaceType
    || (workspace.organizationId ?? null) !== intent.source.organizationId || workspace.actor?.userId !== intent.actor.actorUserId
    || !workspace.permissions.canRead || !workspace.permissions.canWrite || !workspace.permissions.canDelete
    || !actorValid(principal) || canonical(principal) !== canonical(intent.actor)) fail('NATIVE_RESTORE_AUTHORITY_REQUIRED');
}
function boundRequest(request: CollaborationAdmissionRequest, captured: ReturnType<typeof captureNativeRestoreIntent>) {
  const bound = captureCollaborationAdmissionRequest(request), { intent } = captured;
  if (request.action !== 'restore' || request.requestId !== intent.requestId || request.actorId !== intent.actor.actorId
    || request.actionPayloadText !== captured.actionPayloadText
    || request.actionDigest !== collaborationAdmissionActionDigest('restore', captured.actionPayloadText)
    || request.expectedDocuments.some(document => document.workspaceId !== intent.source.workspaceId || document.organizationId !== intent.source.organizationId)
    || request.scopes.some(scope => scope.workspaceId !== intent.source.workspaceId || scope.organizationId !== intent.source.organizationId)
    || canonical(request.expectedDocuments.find(document => document.documentId === intent.source.documentId)) !== canonical({ ...intent.source, status: 'archived' })
    || !request.scopes.some(scope => admissionScopeContains(scope, intent.source.workspaceId, intent.source.path))) fail('NATIVE_RESTORE_INVALID');
  return bound;
}
async function readIntent(database: SqlConnection, operationId: string) {
  const row = await database.get('SELECT intent_text,changes_bundle_proof FROM collaboration_native_restore_intents WHERE operation_id=$1 AND octet_length(intent_text)<=$2 FOR SHARE', [operationId, PRIVATE_LIMIT]) as Row | undefined;
  if (!row) fail('NATIVE_RESTORE_INVALID'); bounded(row.intent_text, PRIVATE_LIMIT);
  const captured = captureNativeRestoreIntent(JSON.parse(row.intent_text));
  if (captured.intent.operationId !== operationId || captured.privateText !== row.intent_text || captured.changesBundleProof !== row.changes_bundle_proof) fail('NATIVE_RESTORE_INVALID');
  return captured;
}

/** Before reservation; writes a private intent, not a mutation capability. */
export async function stageNativeRestoreIntentOnConnection(database: SqlConnection, input: NativeRestoreIntent) {
  const captured = captureNativeRestoreIntent(input), { intent } = captured;
  await database.run(`INSERT INTO collaboration_native_restore_intents(operation_id,request_id,intent_text,changes_bundle_proof)
    VALUES($1,$2,$3,$4) ON CONFLICT(operation_id) DO NOTHING`, [intent.operationId, intent.requestId, captured.privateText, captured.changesBundleProof]);
  const actual = await readIntent(database, intent.operationId);
  if (actual.privateText !== captured.privateText) fail('NATIVE_RESTORE_INVALID');
  return { actionPayloadText: captured.actionPayloadText, changesBundleProof: captured.changesBundleProof, executionReady: false as const };
}
async function verifyArchive(database: SqlConnection, intent: NativeRestoreIntent): Promise<void> {
  const reference = intent.archive;
  // Sideeffect capture already caps the historical bundle at 64 mutations/8MiB.
  // Check SQL octet/count limits BEFORE loading or decoding that private bundle.
  const row = await database.get(`SELECT i.intent_text,r.receipt_text,r.receipt_digest,r.after_state_snapshot
    FROM collaboration_native_file_operation_intents i JOIN collaboration_native_file_operation_receipts r USING(operation_id)
    WHERE i.operation_id=$1 AND r.mutation_id=$2 AND octet_length(i.intent_text)<=8388608
      AND jsonb_array_length(i.intent_text::jsonb->'mutations') BETWEEN 1 AND 64
      AND octet_length(r.receipt_text)<=8192 AND octet_length(r.after_state_snapshot)<=4194304`, [reference.operationId, reference.mutationId]) as Row | undefined;
  if (!row || row.receipt_digest !== reference.receiptDigest || !(row.after_state_snapshot instanceof Uint8Array)) fail('NATIVE_RESTORE_ARCHIVE_UNCONFIRMED');
  bounded(row.intent_text, 8 * 1024 * 1024); bounded(row.receipt_text, 8192);
  const raw = JSON.parse(row.intent_text) as NativeFileOperationBundle;
  for (const mutation of raw.mutations) if (mutation.prepared) {
    const update: unknown = mutation.prepared.update;
    if (typeof update !== 'string' || Buffer.from(update, 'base64').toString('base64') !== update) fail('NATIVE_RESTORE_ARCHIVE_UNCONFIRMED');
    mutation.prepared.update = Buffer.from(update, 'base64');
  }
  const historical = captureNativeFileOperationBundle(raw);
  const request = captureCollaborationAdmissionRequest(reference.request);
  if (historical.privateText !== row.intent_text || historical.bundle.operationId !== reference.operationId || historical.bundle.action !== 'archive'
    || request.request.requestId !== historical.bundle.requestId || request.request.actorId !== historical.bundle.actor.actorId
    || canonical(JSON.parse(request.request.actionPayloadText!)) !== canonical(JSON.parse(historical.actionPayloadText))
    || request.request.actionDigest !== collaborationAdmissionActionDigest('archive', historical.actionPayloadText)) fail('NATIVE_RESTORE_ARCHIVE_UNCONFIRMED');
  const mutation = historical.bundle.mutations.find(item => item.mutationId === reference.mutationId);
  const receipt = JSON.parse(row.receipt_text) as NativeFileOperationReceipt;
  const expectedSource = mutation && { ...mutation.source, lifecycleGeneration: mutation.source.lifecycleGeneration + 1 };
  const expectedReceipt = mutation && { version: 1, operationId: reference.operationId, mutationId: reference.mutationId,
    requestId: historical.bundle.requestId, requestDigest: request.requestDigest, changesBundleProof: historical.changesBundleProof,
    actor: historical.bundle.actor, reviewDigest: historical.bundle.reviewDigest, action: 'archive', kind: 'archive',
    source: mutation.source, lineageId: mutation.lineageId, before: mutation.before, beforeRegistryStateVersion: mutation.registryStateVersion,
    after: { identity: expectedSource, status: 'archived', clock: mutation.before, registryStateVersion: 0 },
    projection: { status: 'pending', path: mutation.source.path, filesystemComplete: false }, inverseRecipes: [] };
  if (!mutation || mutation.kind !== 'archive' || mutation.prepared !== null || mutation.trashEntryId !== intent.trashEntryId
    || mutation.lineageId !== intent.lineageId || canonical(expectedSource) !== canonical(intent.source) || canonical(mutation.before) !== canonical(intent.before)
    || canonical(receipt) !== canonical(expectedReceipt) || hash(row.receipt_text) !== reference.receiptDigest
    || intent.before.stateProof !== `yjs-snapshot-sha256-v1:${hash(row.after_state_snapshot)}`) fail('NATIVE_RESTORE_ARCHIVE_UNCONFIRMED');
  const entries = await database.all(`SELECT mutation_id,receipt_digest FROM collaboration_native_file_operation_receipts
    WHERE operation_id=$1 ORDER BY mutation_id COLLATE "C" LIMIT 65`, [reference.operationId]) as Row[];
  if (entries.length !== historical.bundle.mutations.length || entries.some((entry, index) => entry.mutation_id !== historical.bundle.mutations[index].mutationId)
    || hash('canvas.native-file-receipt-set.v1\n' + entries.map(entry => `${entry.mutation_id}\t${entry.receipt_digest}`).join('\n')) !== reference.nativeReceiptSetProof) fail('NATIVE_RESTORE_ARCHIVE_UNCONFIRMED');
  const outcome = await readCollaborationAdmissionOutcome(database, request);
  if (!outcome || outcome.result.nativeFileReceiptSetProof !== reference.nativeReceiptSetProof) fail('NATIVE_RESTORE_ARCHIVE_UNCONFIRMED');
  const supplemental = await readCommittedNativeFileOperationSideEffectsOnConnection(database,
    { request: request.request, operationId: reference.operationId, actor: historical.bundle.actor });
  if (supplemental?.nativeFileSideEffectSetProof !== reference.sideEffectSetProof) fail('NATIVE_RESTORE_ARCHIVE_UNCONFIRMED');
}

/** SAME authorized DA04.prepare connection only; root repeats current user/session
 * authorization. Capturing locks/state creates no DA04 with/claim permission. */
export async function prepareNativeRestoreOnConnection(database: SqlConnection, input: {
  request: CollaborationAdmissionRequest; operationId: string; workspace: WorkspaceContext; principal: Actor;
}): Promise<{ executionReady: false }> {
  budget(input); const local = structuredClone(input);
  if (preparations.has(database)) fail('NATIVE_RESTORE_AUTHORITY_REQUIRED');
  const identity = await connectionIdentity(database); await schemaMatches(database, identity);
  const captured = await readIntent(database, local.operationId), request = boundRequest(local.request, captured);
  assertPrincipal(local.workspace, local.principal, captured.intent);
  const header = await database.get('SELECT request_digest,intent_text,status FROM collaboration_admission_requests WHERE request_id=$1 FOR SHARE', [request.request.requestId]) as Row | undefined;
  if (!header || header.request_digest !== request.requestDigest || header.intent_text !== request.intentText || !['reserved', 'draining'].includes(header.status as string)) fail('NATIVE_RESTORE_AUTHORITY_REQUIRED');
  await lockFileCollaborationPaths(database, captured.intent.source.workspaceId, [captured.intent.source.path]);
  await verifyArchive(database, captured.intent);
  if (canonical(await connectionIdentity(database)) !== canonical(identity)) fail('NATIVE_RESTORE_AUTHORITY_REQUIRED');
  preparations.set(database, { identity, requestDigest: request.requestDigest, captured, principal: local.principal, workspace: local.workspace, state: 'prepared' });
  return { executionReady: false };
}
async function stillCurrent(database: SqlConnection, prepared: Prepared, assertActive: () => void): Promise<void> {
  assertActive();
  if (preparations.get(database) !== prepared || prepared.state !== 'applying'
    || canonical(await connectionIdentity(database)) !== canonical(prepared.identity)) fail('NATIVE_RESTORE_AUTHORITY_REQUIRED');
  assertActive();
}
function nativeIdentity(state: PersistedCollaborationState): NativeLinkDocumentIdentity {
  return { documentId: state.documentId, workspaceId: state.workspaceId, organizationId: state.organizationId, path: state.path,
    representation: state.representation, lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion };
}
function flag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const parsed = number(value); if (parsed > 1) fail('NATIVE_RESTORE_SOURCE_CHANGED'); return parsed === 1;
}
async function loadStrictState(database: SqlConnection, row: Row): Promise<PersistedCollaborationState> {
  if (!['active', 'archived'].includes(row.status as string) || !['lf', 'crlf'].includes(row.newline_style as string)) fail('NATIVE_RESTORE_SOURCE_CHANGED');
  const state = await loadCollaborationStateOnConnection(database, row.document_id as string, true);
  if (!state) fail('NATIVE_RESTORE_SOURCE_CHANGED');
  // The normal app configures INT8->Number. An explicit caller connection may
  // still expose decimal flags; never interpret a stored '1' quarantine as false.
  return { ...state, hasBom: flag(row.has_bom), degraded: flag(row.degraded),
    ...(state.projectionError ? { projectionError: { ...state.projectionError, permanent: flag(row.projection_error_permanent) } } : {}) };
}
const clockFor = (state: PersistedCollaborationState) => ({ ...inspectArchivedNativeSnapshot(state).version, binaryHash: hash(state.yjsState) });

/** One claim, no second connection/TX/ordinary lifecycle wrapper. This foundation
 * restores native+registry+lineage only. Metadata inverse, links, physical trash,
 * projection publication, undo and routes remain executionReady:false. */
export async function applyNativeRestoreOnConnection(database: SqlConnection, input: {
  operationId: string; workspace: WorkspaceContext; principal: Actor;
}): Promise<{ receipt: NativeRestoreReceipt; receiptDigest: string; nativeRestoreReceiptSetProof: string; executionReady: false }> {
  budget(input); const local = structuredClone(input);
  const prepared = preparations.get(database);
  if (!prepared || prepared.state !== 'prepared' || prepared.captured.intent.operationId !== local.operationId) fail('NATIVE_RESTORE_AUTHORITY_REQUIRED');
  prepared.state = 'applying';
  return withCollaborationAdmissionMutation(database, 'restore', async assertActive => {
    const { intent, changesBundleProof } = prepared.captured, { source } = intent;
    assertPrincipal(local.workspace, local.principal, intent);
    if (canonical(local.workspace) !== canonical(prepared.workspace) || canonical(local.principal) !== canonical(prepared.principal)) fail('NATIVE_RESTORE_AUTHORITY_REQUIRED');
    await stillCurrent(database, prepared, assertActive); await schemaMatches(database, prepared.identity);
    const request = boundRequest(requireCollaborationAdmissionMutationRequest(database, 'restore'), prepared.captured);
    if (request.requestDigest !== prepared.requestDigest) fail('NATIVE_RESTORE_AUTHORITY_REQUIRED');
    await stillCurrent(database, prepared, assertActive); await verifyArchive(database, intent); await stillCurrent(database, prepared, assertActive);
    const registry = await database.get('SELECT * FROM collaboration_documents WHERE id=$1 FOR UPDATE', [source.documentId]) as Row | undefined;
    const lineage = await database.get('SELECT * FROM file_collaboration_lineages WHERE id=$1 FOR UPDATE', [intent.lineageId]) as Row | undefined;
    const row = await database.get(`SELECT * FROM collaboration_yjs_states WHERE document_id=$1 AND octet_length(yjs_state)<=$2 AND octet_length(state_vector)<=$2 FOR UPDATE`, [source.documentId, ARCHIVED_NATIVE_BINARY_LIMIT]) as Row | undefined;
    await stillCurrent(database, prepared, assertActive);
    if (!registry || !lineage || !row || registry.lineage_id !== intent.lineageId || registry.provider !== 'yjs' || registry.yjs_state_lifecycle !== 'initialized'
      || number(registry.state_version) !== 0 || lineage.trash_entry_id !== intent.trashEntryId || !safe(number(lineage.archived_at))
      || [registry, lineage].some(record => record.workspace_id !== source.workspaceId || record.organization_id !== source.organizationId
        || record.workspace_type !== intent.workspaceType || record.path !== source.path || record.status !== 'archived')) fail('NATIVE_RESTORE_SOURCE_CHANGED');
    const state = await loadStrictState(database, row); await stillCurrent(database, prepared, assertActive);
    if (!state || state.status !== 'archived' || canonical(nativeIdentity(state)) !== canonical(source)
      || canonical(clockFor(state)) !== canonical(intent.before)) fail('NATIVE_RESTORE_SOURCE_CHANGED');
    if (await database.get(`SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND status='active'
      AND (path=$2 OR left($2,length(path)+1)=path||'/' OR left(path,length($2)+1)=$2||'/')
      UNION ALL SELECT id FROM file_collaboration_lineages WHERE workspace_id=$1 AND status='active'
      AND (path=$2 OR left($2,length(path)+1)=path||'/' OR left(path,length($2)+1)=$2||'/') LIMIT 1`, [source.workspaceId, source.path])) fail('NATIVE_RESTORE_DESTINATION_CONFLICT');
    if (await database.get(`SELECT operation_id FROM collaboration_agent_operations WHERE document_id=$1
      AND status NOT IN ('persisted_yjs','checkpointed_file','cancelled','expired','superseded','failed','rejected','reverted') LIMIT 1 FOR UPDATE`, [source.documentId])) fail('NATIVE_RESTORE_SOURCE_CHANGED');
    const projection = await database.get('SELECT lifecycle_generation,projected_sequence FROM collaboration_file_projections WHERE document_id=$1 FOR UPDATE', [source.documentId]) as Row | undefined;
    if (projection && (number(projection.lifecycle_generation) > source.lifecycleGeneration
      || number(projection.lifecycle_generation) === source.lifecycleGeneration && number(projection.projected_sequence) > state.documentSequence)) fail('NATIVE_RESTORE_SOURCE_CHANGED');
    const doc = new Y.Doc(); let snapshot: Uint8Array;
    try { Y.applyUpdate(doc, state.yjsState); const proof = captureAgentStateSnapshot(doc, Y);
      if (!proof || proof.length > 4 * 1024 * 1024) fail('NATIVE_RESTORE_SOURCE_CHANGED'); snapshot = proof; } finally { doc.destroy(); }
    await stillCurrent(database, prepared, assertActive);
    claimCollaborationAdmissionMutation(database, 'restore', row);
    const generation = source.lifecycleGeneration + 1, now = Math.max(Date.now(), state.persistedAt);
    const updated = await database.get(`UPDATE collaboration_yjs_states SET status='active',lifecycle_generation=$1,
      checkpoint_sequence=0,checkpointed_at=NULL,canonical_hash=NULL,serialized_hash=NULL
      WHERE document_id=$2 AND workspace_id=$3 AND organization_id IS NOT DISTINCT FROM $4 AND path=$5
        AND representation=$6 AND schema_version=$7 AND lifecycle_generation=$8 AND status='archived'
        AND document_sequence=$9 AND persisted_at=$10 AND yjs_state=$11 AND state_vector=$12 RETURNING document_id`,
    [generation, source.documentId, source.workspaceId, source.organizationId, source.path, source.representation, source.schemaVersion,
      source.lifecycleGeneration, state.documentSequence, state.persistedAt, Buffer.from(state.yjsState), Buffer.from(state.stateVector)]);
    const registryChanged = await database.get(`UPDATE collaboration_documents SET status='active',state_version=0,snapshot_revision_id=NULL,updated_at=$1
      WHERE id=$2 AND lineage_id=$3 AND workspace_id=$4 AND organization_id IS NOT DISTINCT FROM $5 AND path=$6
        AND status='archived' AND state_version=0 AND provider='yjs' AND yjs_state_lifecycle='initialized' AND workspace_type=$7 RETURNING id`,
    [now, source.documentId, intent.lineageId, source.workspaceId, source.organizationId, source.path, intent.workspaceType]);
    const lineageChanged = await database.get(`UPDATE file_collaboration_lineages SET status='active',archived_at=NULL,trash_entry_id=NULL
      WHERE id=$1 AND workspace_id=$2 AND organization_id IS NOT DISTINCT FROM $3 AND path=$4 AND status='archived'
        AND archived_at=$5 AND trash_entry_id=$6 AND workspace_type=$7 RETURNING id`,
    [intent.lineageId, source.workspaceId, source.organizationId, source.path, lineage.archived_at, intent.trashEntryId, intent.workspaceType]);
    await stillCurrent(database, prepared, assertActive);
    if (!updated || !registryChanged || !lineageChanged) fail('NATIVE_RESTORE_SOURCE_CHANGED');
    await database.run(`INSERT INTO collaboration_file_projections(document_id,lifecycle_generation,projected_sequence,finalized,updated_at)
      VALUES($1,$2,$3,0,$4) ON CONFLICT(document_id) DO UPDATE SET lifecycle_generation=excluded.lifecycle_generation,
      projected_sequence=excluded.projected_sequence,finalized=0,revision_id=NULL,canonical_hash=NULL,serialized_hash=NULL,updated_at=excluded.updated_at`,
    [source.documentId, generation, state.documentSequence, now]);
    const afterRow = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [source.documentId]) as Row | undefined;
    if (!afterRow) fail('NATIVE_RESTORE_SOURCE_CHANGED');
    const afterState = await loadStrictState(database, afterRow);
    const afterNative = authoritativeNativeCollaborationSnapshot(afterState);
    if (afterNative.lifecycleGeneration !== generation || canonical(afterNative.version) !== canonical(inspectArchivedNativeSnapshot(state).version)
      || hash(afterState.yjsState) !== intent.before.binaryHash) fail('NATIVE_RESTORE_SOURCE_CHANGED');
    await stillCurrent(database, prepared, assertActive);
    const { request: historicalRequest, ...archive } = intent.archive;
    const { archive: _archive, ...body } = intent;
    const receipt: NativeRestoreReceipt = { ...body, archive: { ...archive, requestId: historicalRequest.requestId,
      requestDigest: captureCollaborationAdmissionRequest(historicalRequest).requestDigest },
      requestDigest: request.requestDigest, changesBundleProof, beforeArchivedAt: number(lineage.archived_at),
      after: { identity: { ...source, lifecycleGeneration: generation }, status: 'active', clock: intent.before, registryStateVersion: 0 },
      projection: { status: 'pending', path: source.path, filesystemComplete: false } };
    const receiptText = canonical(receipt); bounded(receiptText, PRIVATE_LIMIT); const receiptDigest = hash(receiptText);
    await database.run(`INSERT INTO collaboration_native_restore_receipts(operation_id,mutation_id,document_id,request_id,
      changes_bundle_proof,receipt_text,receipt_digest,after_state_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [intent.operationId, intent.mutationId, source.documentId, intent.requestId, changesBundleProof, receiptText, receiptDigest, Buffer.from(snapshot)]);
    await stillCurrent(database, prepared, assertActive); preparations.delete(database);
    return { receipt, receiptDigest, nativeRestoreReceiptSetProof: hash(`canvas.native-restore-receipt-set.v1\n${intent.mutationId}\t${receiptDigest}`), executionReady: false };
  });
}

/** Freshly authorized coordinator recovery read. Historical commit and current
 * peer state are separate; it never replays restore or reinstates privileges. */
export async function readCommittedNativeRestoreOnConnection(database: SqlConnection, input: {
  request: CollaborationAdmissionRequest; operationId: string; workspace: WorkspaceContext; principal: Actor;
}) {
  budget(input); const local = structuredClone(input), identity = await connectionIdentity(database);
  await schemaMatches(database, identity); const captured = await readIntent(database, local.operationId);
  assertPrincipal(local.workspace, local.principal, captured.intent); const request = boundRequest(local.request, captured);
  const row = await database.get(`SELECT receipt_text,receipt_digest,after_state_snapshot FROM collaboration_native_restore_receipts
    WHERE operation_id=$1 AND mutation_id=$2 AND request_id=$3 AND octet_length(receipt_text)<=$4 AND octet_length(after_state_snapshot)<=4194304`,
  [local.operationId, captured.intent.mutationId, request.request.requestId, PRIVATE_LIMIT]) as Row | undefined;
  if (!row) return null; bounded(row.receipt_text, PRIVATE_LIMIT);
  const receipt = JSON.parse(row.receipt_text) as NativeRestoreReceipt, { intent } = captured;
  const { request: archiveRequest, ...archive } = intent.archive; const { archive: _archive, ...body } = intent;
  const expected = { ...body, archive: { ...archive, requestId: archiveRequest.requestId,
    requestDigest: captureCollaborationAdmissionRequest(archiveRequest).requestDigest }, requestDigest: request.requestDigest,
    changesBundleProof: captured.changesBundleProof, beforeArchivedAt: receipt.beforeArchivedAt,
    after: { identity: { ...intent.source, lifecycleGeneration: intent.source.lifecycleGeneration + 1 }, status: 'active', clock: intent.before, registryStateVersion: 0 },
    projection: { status: 'pending', path: intent.source.path, filesystemComplete: false } };
  const proof = hash(`canvas.native-restore-receipt-set.v1\n${intent.mutationId}\t${row.receipt_digest}`);
  const outcome = await readCollaborationAdmissionOutcome(database, request);
  const count = await database.get('SELECT count(*)::integer AS n FROM collaboration_native_restore_receipts WHERE operation_id=$1', [local.operationId]) as Row | undefined;
  if (canonical(receipt) !== canonical(expected) || !safe(receipt.beforeArchivedAt) || row.receipt_digest !== hash(row.receipt_text)
    || !(row.after_state_snapshot instanceof Uint8Array) || intent.before.stateProof !== `yjs-snapshot-sha256-v1:${hash(row.after_state_snapshot)}`
    || count?.n !== 1 || outcome?.result.nativeRestoreReceiptSetProof !== proof) fail('NATIVE_RESTORE_UNCONFIRMED');
  await verifyArchive(database, intent);
  // A historical receipt certifies its original commit, not today's namespace.
  // Lock all three current rows on this same transaction. Legitimate later moves
  // and archives may change their path/status; their identities must still agree.
  const currentRow = await database.get(`SELECT s.*,d.lineage_id AS current_lineage_id,d.workspace_id AS current_registry_workspace_id,
    d.workspace_type AS current_registry_workspace_type,d.organization_id AS current_registry_organization_id,
    d.path AS current_registry_path,d.status AS current_registry_status,d.provider AS current_provider,
    d.yjs_state_lifecycle AS current_initialization,d.state_version AS current_registry_state_version,
    l.workspace_id AS current_lineage_workspace_id,l.workspace_type AS current_lineage_workspace_type,
    l.organization_id AS current_lineage_organization_id,l.path AS current_lineage_path,l.status AS current_lineage_status
    FROM collaboration_yjs_states s JOIN collaboration_documents d ON d.id=s.document_id
    JOIN file_collaboration_lineages l ON l.id=d.lineage_id
    WHERE s.document_id=$1 AND octet_length(s.yjs_state)<=$2 AND octet_length(s.state_vector)<=$2
    FOR SHARE OF s,d,l`, [intent.source.documentId, ARCHIVED_NATIVE_BINARY_LIMIT]) as Row | undefined;
  if (!currentRow || currentRow.current_lineage_id !== intent.lineageId || currentRow.current_provider !== 'yjs'
    || currentRow.current_initialization !== 'initialized' || typeof currentRow.path !== 'string' || !isCanonicalAdmissionPath(currentRow.path)
    || currentRow.current_registry_workspace_id !== intent.source.workspaceId || currentRow.current_lineage_workspace_id !== intent.source.workspaceId
    || currentRow.current_registry_workspace_type !== local.workspace.workspaceType || currentRow.current_lineage_workspace_type !== local.workspace.workspaceType
    || currentRow.current_registry_organization_id !== intent.source.organizationId || currentRow.current_lineage_organization_id !== intent.source.organizationId
    || currentRow.current_registry_path !== currentRow.path || currentRow.current_lineage_path !== currentRow.path
    || currentRow.current_registry_status !== currentRow.status || currentRow.current_lineage_status !== currentRow.status) fail('NATIVE_RESTORE_UNCONFIRMED');
  number(currentRow.current_registry_state_version);
  const current = await loadStrictState(database, currentRow);
  if (current.documentId !== intent.source.documentId || current.workspaceId !== intent.source.workspaceId || current.organizationId !== intent.source.organizationId
    || current.representation !== intent.source.representation || current.schemaVersion !== intent.source.schemaVersion
    || current.lifecycleGeneration < receipt.after.identity.lifecycleGeneration || current.documentSequence < intent.before.documentSequence
    || !persistedUpdateIncludesAgentSnapshot(current.yjsState, row.after_state_snapshot, Y)) fail('NATIVE_RESTORE_UNCONFIRMED');
  const observed = current.status === 'archived' ? inspectArchivedNativeSnapshot(current) : authoritativeNativeCollaborationSnapshot(current);
  if (canonical(await connectionIdentity(database)) !== canonical(identity)) fail('NATIVE_RESTORE_AUTHORITY_REQUIRED');
  return { receipt, receiptDigest: row.receipt_digest as string, nativeRestoreReceiptSetProof: proof,
    currentObservation: { identity: nativeIdentity(current), status: current.status, clock: { ...observed.version, binaryHash: hash(current.yjsState) } }, executionReady: false as const };
}
