import 'server-only';

import { createHash } from 'node:crypto';
import * as decoding from 'lib0/decoding';
import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { lockFileCollaborationPaths } from '../files/collaboration-repository';
import { captureAgentStateSnapshot, persistedUpdateIncludesAgentSnapshot } from '../collaboration/agent-durability';
import { authoritativeNativeCollaborationSnapshot, inspectPersistedNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { loadCollaborationStateOnConnection, type PersistedCollaborationState } from '../collaboration/persistence';
import { Y } from '../collaboration/server-runtime';
import { isCollaborationStateProof } from '../collaboration/state-proof';
import { admissionScopeContains, captureCollaborationAdmissionRequest, collaborationAdmissionActionDigest,
  isCanonicalAdmissionPath, type CollaborationAdmissionRequest } from '../collaboration/room-admission-contract';
import { claimCollaborationAdmissionMutation, requireCollaborationAdmissionMutationRequest,
  withCollaborationAdmissionMutation } from '../collaboration/room-admission-handoff';
import { readCollaborationAdmissionOutcome, readHistoricalCollaborationAdmissionOutcomeOnConnection } from '../collaboration/room-admission-outcome';
import { inspectCollaborationAdmissionQuiescence } from '../collaboration/room-admission-quiescence';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from './workspace-native-link-inventory';
import type { NativeLinkDocumentIdentity } from './workspace-link-contract-v2';
import type { PreparedNativeLinkUpdate } from './workspace-native-link-mutations';

type Action = 'move' | 'rename' | 'archive';
type Actor = { actorUserId: string; actorId: string; actorType: 'user' | 'agent' | 'automation' | 'system'; actorSessionId: string | null };
type Clock = { documentSequence: number; persistedAt: number; stateProof: string; stateVector: string; binaryHash: string };
export type NativeFileOperationMutationIntent = {
  mutationId: string;
  kind: 'move' | 'archive' | 'link';
  source: NativeLinkDocumentIdentity;
  lineageId: string;
  registryStateVersion: number;
  before: Clock;
  destinationPath: string | null;
  trashEntryId: string | null;
  prepared: PreparedNativeLinkUpdate | null;
};
export type NativeFileOperationBundle = {
  version: 1; operationId: string; requestId: string; action: Action;
  actor: Actor; reviewDigest: string;
  mutations: NativeFileOperationMutationIntent[];
};
export type NativeFileOperationReceipt = {
  version: 1; operationId: string; mutationId: string; requestId: string; requestDigest: string;
  changesBundleProof: string; actor: Actor; reviewDigest: string; action: Action;
  kind: NativeFileOperationMutationIntent['kind']; source: NativeLinkDocumentIdentity; lineageId: string;
  before: Clock; beforeRegistryStateVersion: number;
  after: { identity: NativeLinkDocumentIdentity; status: 'active' | 'archived'; clock: Clock; registryStateVersion: number };
  projection: { status: 'pending'; path: string; filesystemComplete: false };
  inverseRecipes: PreparedNativeLinkUpdate['inverseRecipes'];
};
type Row = Record<string, unknown>;
export class NativeFileOperationHandoffError extends Error {
  readonly status = 409;
  constructor(readonly code: 'NATIVE_FILE_INVALID_INTENT' | 'NATIVE_FILE_INTENT_CONFLICT' | 'NATIVE_FILE_SOURCE_CHANGED'
    | 'NATIVE_FILE_DESTINATION_CONFLICT' | 'NATIVE_FILE_MUTATION_BUSY' | 'NATIVE_FILE_RECEIPT_UNCONFIRMED') {
    super(code); this.name = 'NativeFileOperationHandoffError';
  }
}
const fail = (code: NativeFileOperationHandoffError['code']): never => { throw new NativeFileOperationHandoffError(code); };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const safeNumber = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value < Number.MAX_SAFE_INTEGER;
function rowVersion(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value))) return fail('NATIVE_FILE_SOURCE_CHANGED');
  const number = Number(value); if (!safeNumber(number)) return fail('NATIVE_FILE_SOURCE_CHANGED'); return number;
}
function decodeVector(value: string): Buffer {
  if (typeof value !== 'string' || !value || value.length > 6 * 1024 * 1024) return fail('NATIVE_FILE_INVALID_INTENT');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) return fail('NATIVE_FILE_INVALID_INTENT');
  return bytes;
}
function assertPrivateBundleBudget(input: NativeFileOperationBundle): void {
  const allowedUpdates = new Set<Uint8Array>();
  if (!input || typeof input !== 'object') return fail('NATIVE_FILE_INVALID_INTENT');
  const mutationsProperty = Object.getOwnPropertyDescriptor(input, 'mutations');
  if (!mutationsProperty || mutationsProperty.get || mutationsProperty.set || !Array.isArray(mutationsProperty.value)
    || mutationsProperty.value.length > 1024) return fail('NATIVE_FILE_INVALID_INTENT');
  const mutations = mutationsProperty.value as unknown[];
  for (let index = 0; index < mutations.length; index++) {
    const property = Object.getOwnPropertyDescriptor(mutations, String(index));
    if (!property || property.get || property.set || !property.value || typeof property.value !== 'object') return fail('NATIVE_FILE_INVALID_INTENT');
    const prepared = Object.getOwnPropertyDescriptor(property.value, 'prepared');
    if (!prepared || prepared.get || prepared.set) return fail('NATIVE_FILE_INVALID_INTENT');
    if (prepared.value !== null) {
      if (!prepared.value || typeof prepared.value !== 'object') return fail('NATIVE_FILE_INVALID_INTENT');
      const update = Object.getOwnPropertyDescriptor(prepared.value, 'update');
      if (!update || update.get || update.set || !(update.value instanceof Uint8Array)) return fail('NATIVE_FILE_INVALID_INTENT');
      allowedUpdates.add(update.value);
    }
  }
  let nodes = 0; let encodedBytes = 0; const ancestors = new Set<object>();
  const charge = (bytes: number) => { encodedBytes += bytes; if (encodedBytes > 64 * 1024 * 1024) fail('NATIVE_FILE_INVALID_INTENT'); };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 262_144 || depth > 32) return fail('NATIVE_FILE_INVALID_INTENT');
    if (value instanceof Uint8Array) {
      if (!allowedUpdates.has(value) || value.byteLength > 16 * 1024 * 1024) return fail('NATIVE_FILE_INVALID_INTENT');
      charge(4 * Math.ceil(value.byteLength / 3) + 2); return;
    }
    if (typeof value === 'string') {
      if (value.length > 6 * 1024 * 1024) return fail('NATIVE_FILE_INVALID_INTENT');
      charge(Buffer.byteLength(JSON.stringify(value))); return;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) { charge(32); return; }
    if (typeof value !== 'object' || ancestors.has(value)) return fail('NATIVE_FILE_INVALID_INTENT');
    if (Array.isArray(value) ? value.length > 262_144 : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('NATIVE_FILE_INVALID_INTENT');
    ancestors.add(value); charge(2);
    // Do not allocate Object.keys for a huge supplied inverse object, invoke a
    // getter/toJSON, or clone any payload before the aggregate bound passes.
    for (const key in value) if (Object.hasOwn(value, key)) {
      if (key.length > 4096 || Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/u.test(key)) return fail('NATIVE_FILE_INVALID_INTENT');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (descriptor.get || descriptor.set) return fail('NATIVE_FILE_INVALID_INTENT');
      charge(Buffer.byteLength(JSON.stringify(key)) + 2); visit(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  };
  visit(input, 0);
}

/** Private server intent only. Its computed membership proof binds ALL mutations,
 * including native bytes/inverses; the bounded public request contains only a
 * digest. Staging grants no authorization and installs no runtime route. */
export function captureNativeFileOperationBundle(input: NativeFileOperationBundle) {
  assertPrivateBundleBudget(input);
  if (!input || input.version !== 1 || !validId(input.operationId)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(input.requestId) || !['move','rename','archive'].includes(input.action)
    || !input.actor || !validId(input.actor.actorUserId) || !validId(input.actor.actorId)
    || !['user','agent','automation','system'].includes(input.actor.actorType)
    || input.actor.actorSessionId !== null && !validId(input.actor.actorSessionId)
    || !validHash(input.reviewDigest) || !Array.isArray(input.mutations) || !input.mutations.length || input.mutations.length > 1024) return fail('NATIVE_FILE_INVALID_INTENT');
  const mutations = input.mutations.map((mutation) => {
    const source = mutation?.source;
    if (!mutation || !validId(mutation.mutationId) || !validId(mutation.lineageId) || !safeNumber(mutation.registryStateVersion)
      || !source || !validId(source.documentId) || !validId(source.workspaceId) || source.organizationId !== null && !validId(source.organizationId)
      || !isCanonicalAdmissionPath(source.path) || !['plain_text','tiptap_xml','tiptap_blocks'].includes(source.representation)
      || !safeNumber(source.lifecycleGeneration, 1) || source.schemaVersion !== 1
      || !mutation.before || !safeNumber(mutation.before.documentSequence) || !safeNumber(mutation.before.persistedAt)
      || !isCollaborationStateProof(mutation.before.stateProof) || !validHash(mutation.before.binaryHash)
      || !['move','archive','link'].includes(mutation.kind)
      || mutation.kind === 'move' && (!isCanonicalAdmissionPath(mutation.destinationPath) || mutation.destinationPath === source.path || input.action === 'archive')
      || mutation.kind !== 'move' && mutation.destinationPath !== null
      || mutation.kind === 'archive' && (input.action !== 'archive' || !validId(mutation.trashEntryId) || mutation.prepared !== null)
      || mutation.kind !== 'archive' && mutation.trashEntryId !== null
      || mutation.kind === 'link' && mutation.prepared === null) return fail('NATIVE_FILE_INVALID_INTENT');
    decodeVector(mutation.before.stateVector);
    const prepared = mutation.prepared;
    if (prepared && (prepared.contractVersion !== 2 || prepared.operationId !== mutation.mutationId
      || nativeLinkJsonProof(prepared.source) !== nativeLinkJsonProof(source)
      || nativeLinkJsonProof(prepared.before) !== nativeLinkJsonProof({ documentSequence: mutation.before.documentSequence,
        stateProof: mutation.before.stateProof, stateVector: mutation.before.stateVector })
      || !isCollaborationStateProof(prepared.after.stateProof) || prepared.after.stateProof === prepared.before.stateProof
      || !(prepared.update instanceof Uint8Array) || !prepared.update.length || prepared.update.length > 16 * 1024 * 1024
      || !Array.isArray(prepared.inverseRecipes) || Buffer.byteLength(JSON.stringify(prepared.inverseRecipes)) > 4 * 1024 * 1024)) return fail('NATIVE_FILE_INVALID_INTENT');
    if (prepared) decodeVector(prepared.after.stateVector);
    return structuredClone(mutation);
  }).sort((a, b) => a.mutationId < b.mutationId ? -1 : a.mutationId > b.mutationId ? 1 : 0);
  if (new Set(mutations.map((mutation) => mutation.mutationId)).size !== mutations.length
    || new Set(mutations.map((mutation) => mutation.source.documentId)).size !== mutations.length
    || new Set(mutations.map((mutation) => mutation.source.workspaceId)).size !== 1
    || new Set(mutations.map((mutation) => mutation.source.organizationId)).size !== 1) return fail('NATIVE_FILE_INVALID_INTENT');
  const bundle: NativeFileOperationBundle = { version: 1, operationId: input.operationId, requestId: input.requestId,
    action: input.action, actor: structuredClone(input.actor), reviewDigest: input.reviewDigest, mutations };
  const privateText = JSON.stringify({ ...bundle, mutations: mutations.map((mutation) => ({ ...mutation,
    prepared: mutation.prepared ? { ...mutation.prepared, update: Buffer.from(mutation.prepared.update).toString('base64') } : null })) });
  if (Buffer.byteLength(privateText) > 64 * 1024 * 1024) return fail('NATIVE_FILE_INVALID_INTENT');
  const changesBundleProof = hash(privateText);
  const actionPayloadText = JSON.stringify({ kind: 'native_file_operation', version: 1, operationId: bundle.operationId,
    requestId: bundle.requestId, actor: bundle.actor, reviewDigest: bundle.reviewDigest, changesBundleProof });
  return { bundle, privateText, changesBundleProof, actionPayloadText };
}
function decodeBundle(text: unknown) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 64 * 1024 * 1024) return fail('NATIVE_FILE_INTENT_CONFLICT');
  try {
    const parsed = JSON.parse(text) as NativeFileOperationBundle;
    for (const mutation of parsed.mutations) if (mutation.prepared) {
      const encoded: unknown = mutation.prepared.update;
      if (typeof encoded !== 'string' || encoded.length > 24 * 1024 * 1024) return fail('NATIVE_FILE_INTENT_CONFLICT');
      mutation.prepared.update = Buffer.from(encoded, 'base64');
      if (Buffer.from(mutation.prepared.update).toString('base64') !== encoded) return fail('NATIVE_FILE_INTENT_CONFLICT');
    }
    const captured = captureNativeFileOperationBundle(parsed);
    if (captured.privateText !== text) return fail('NATIVE_FILE_INTENT_CONFLICT');
    return captured;
  } catch { return fail('NATIVE_FILE_INTENT_CONFLICT'); }
}

function decodeNativeFileOperationReceipt(text: string): NativeFileOperationReceipt {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return fail('NATIVE_FILE_RECEIPT_UNCONFIRMED'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !Object.hasOwn(parsed, 'version') || (parsed as Record<string, unknown>).version !== 1) {
    return fail('NATIVE_FILE_RECEIPT_UNCONFIRMED');
  }
  return parsed as NativeFileOperationReceipt;
}

/** Caller owns authorization and transaction; this immutable private record is
 * prepared BEFORE reservation. No principal is inferred from supplied fields. */
export async function stageNativeFileOperationBundleOnConnection(database: SqlConnection, input: NativeFileOperationBundle) {
  const captured = captureNativeFileOperationBundle(input);
  await database.run(`INSERT INTO collaboration_native_file_operation_intents(operation_id,request_id,changes_bundle_proof,intent_text)
    VALUES($1,$2,$3,$4) ON CONFLICT(operation_id) DO NOTHING`,
  [captured.bundle.operationId, captured.bundle.requestId, captured.changesBundleProof, captured.privateText]);
  const row = await database.get('SELECT * FROM collaboration_native_file_operation_intents WHERE operation_id=$1', [captured.bundle.operationId]) as Row | undefined;
  if (!row || row.intent_text !== captured.privateText || row.request_id !== captured.bundle.requestId
    || row.changes_bundle_proof !== captured.changesBundleProof) return fail('NATIVE_FILE_INTENT_CONFLICT');
  return { actionPayloadText: captured.actionPayloadText, changesBundleProof: captured.changesBundleProof, executionReady: false as const };
}

function validateBoundBundle(row: Row, request: CollaborationAdmissionRequest, action: Action, operationId: string) {
  const captured = decodeBundle(row.intent_text);
  const { bundle } = captured;
  const workspaceId = bundle.mutations[0].source.workspaceId; const organizationId = bundle.mutations[0].source.organizationId;
  const expectedById = new Map(request.expectedDocuments.map((document) => [document.documentId, document]));
  if (bundle.operationId !== operationId || bundle.action !== action || request.requestId !== bundle.requestId || request.actorId !== bundle.actor.actorId
    || row.request_id !== bundle.requestId || row.changes_bundle_proof !== captured.changesBundleProof
    || request.actionPayloadText === undefined || request.actionDigest !== collaborationAdmissionActionDigest(action, captured.actionPayloadText)
    || nativeLinkJsonProof(JSON.parse(request.actionPayloadText)) !== nativeLinkJsonProof(JSON.parse(captured.actionPayloadText))
    || request.scopes.some((scope) => scope.workspaceId !== workspaceId || scope.organizationId !== organizationId)
    || request.expectedDocuments.some((document) => document.workspaceId !== workspaceId || document.organizationId !== organizationId)
    || bundle.mutations.some((mutation) => nativeLinkJsonProof(expectedById.get(mutation.source.documentId) ?? null)
      !== nativeLinkJsonProof({ ...mutation.source, status: 'active' }))) return fail('NATIVE_FILE_INTENT_CONFLICT');
  // Additional real guards retain their requestDigest/scope/quiescence binding.
  // DA04 certifies their unchanged snapshots; they receive no claim or receipt.
  return { ...captured, request, requestDigest: captureCollaborationAdmissionRequest(request).requestDigest };
}
async function boundBundle(database: SqlConnection, action: Action, operationId: string) {
  const request = requireCollaborationAdmissionMutationRequest(database, action);
  const row = await database.get('SELECT * FROM collaboration_native_file_operation_intents WHERE operation_id=$1 FOR SHARE', [operationId]) as Row | undefined;
  if (!row) return fail('NATIVE_FILE_INTENT_CONFLICT');
  return validateBoundBundle(row, request, action, operationId);
}
function bindingSummary(bound: ReturnType<typeof validateBoundBundle>) {
  return structuredClone({ operationId: bound.bundle.operationId, requestId: bound.bundle.requestId, requestDigest: bound.requestDigest,
    changesBundleProof: bound.changesBundleProof, actor: bound.bundle.actor, reviewDigest: bound.bundle.reviewDigest, action: bound.bundle.action,
    mutations: bound.bundle.mutations.map(({ prepared: _prepared, ...mutation }) => mutation), executionReady: false as const });
}

/** Read-only binding for an authorized coordinator's SAME DA04 prepare session.
 * prepare precedes mutation authority: this read grants no with/claim capability,
 * exposes no delta/inverse bytes and must never be used as user authorization. */
export async function readStagedNativeFileOperationBindingOnConnection(database: SqlConnection, input: {
  request: CollaborationAdmissionRequest; operationId: string;
}) {
  const captured = captureCollaborationAdmissionRequest(structuredClone(input.request));
  if (!['move','rename','archive'].includes(captured.request.action)) return fail('NATIVE_FILE_INTENT_CONFLICT');
  const header = await database.get('SELECT request_digest,intent_text,status FROM collaboration_admission_requests WHERE request_id=$1 FOR SHARE', [captured.request.requestId]) as Row | undefined;
  if (!header || header.request_digest !== captured.requestDigest || header.intent_text !== captured.intentText
    || !['reserved','draining'].includes(header.status as string)) return fail('NATIVE_FILE_INTENT_CONFLICT');
  const row = await database.get('SELECT * FROM collaboration_native_file_operation_intents WHERE operation_id=$1 FOR SHARE', [input.operationId]) as Row | undefined;
  if (!row) return fail('NATIVE_FILE_INTENT_CONFLICT');
  return bindingSummary(validateBoundBundle(row, captured.request, captured.request.action as Action, input.operationId));
}

function candidateState(state: PersistedCollaborationState, mutation: NativeFileOperationMutationIntent) {
  return inspectPersistedNativeCollaborationSnapshot(state, (before, snapshot) => {
    if (snapshot.version.stateProof !== mutation.before.stateProof || snapshot.version.stateVector !== mutation.before.stateVector
      || snapshot.version.documentSequence !== mutation.before.documentSequence || snapshot.version.persistedAt !== mutation.before.persistedAt
      || hash(state.yjsState) !== mutation.before.binaryHash) return fail('NATIVE_FILE_SOURCE_CHANGED');
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, state.yjsState);
      if (mutation.prepared) {
        const decoder = decoding.createDecoder(mutation.prepared.update); Y.readUpdate(decoder, doc);
        if (decoding.hasContent(decoder)) return fail('NATIVE_FILE_INVALID_INTENT');
      }
      const yjsState = mutation.prepared ? Y.encodeStateAsUpdate(doc) : state.yjsState;
      const stateVector = mutation.prepared ? Y.encodeStateVector(doc) : state.stateVector;
      const next = { ...state, yjsState, stateVector };
      const checked = authoritativeNativeCollaborationSnapshot(next);
      if (mutation.prepared && (checked.version.stateProof !== mutation.prepared.after.stateProof
        || checked.version.stateVector !== mutation.prepared.after.stateVector || !inspectPersistedDocumentLinks(next).coverage.complete)) return fail('NATIVE_FILE_INVALID_INTENT');
      const afterStateSnapshot = captureAgentStateSnapshot(doc, Y);
      if (!afterStateSnapshot || afterStateSnapshot.length > 4 * 1024 * 1024) return fail('NATIVE_FILE_INVALID_INTENT');
      return { yjsState, stateVector, stateProof: checked.version.stateProof, afterStateSnapshot };
    } finally { doc.destroy(); }
  });
}

/** SAME-CONNECTION DA04 capability only; never BEGIN/COMMIT/open a connection,
 * inherit a bool exception, or nest the ordinary lifecycle/link persistence.
 * Root must validate current permissions/Review effect in Handoff.prepare.
 * This commits native+registry+lineage identity, NOT whole file-operation success:
 * metadata, guests, locks, agent policy, physical journal and Undo remain gated. */
export function applyNativeFileOperationMutationOnConnection(database: SqlConnection, input: {
  workspace: WorkspaceContext; action: Action; operationId: string; mutationId: string;
}): Promise<{ receipt: NativeFileOperationReceipt; receiptDigest: string; executionReady: false }> {
  const capturedInput = structuredClone(input);
  return withCollaborationAdmissionMutation(database, capturedInput.action, async (assertActive) => {
    const { workspace, action, operationId, mutationId } = capturedInput;
    if (!workspace.permissions.canRead || !workspace.permissions.canWrite || action === 'archive' && !workspace.permissions.canDelete
      || workspace.status !== undefined && workspace.status !== 'active') throw Object.assign(new Error('Current native file mutation permission is required.'), { status: 403 });
    const bound = await boundBundle(database, action, operationId); assertActive();
    const mutation = bound.bundle.mutations.find((candidate) => candidate.mutationId === mutationId);
    if (!mutation || mutation.source.workspaceId !== workspace.workspaceId || mutation.source.organizationId !== (workspace.organizationId ?? null)) return fail('NATIVE_FILE_INTENT_CONFLICT');
    const { source } = mutation; const afterPath = mutation.destinationPath ?? source.path;
    if (![source.path, afterPath].every((filePath) => bound.request.scopes.some((scope) => scope.organizationId === source.organizationId
      && admissionScopeContains(scope, source.workspaceId, filePath)))) return fail('NATIVE_FILE_INTENT_CONFLICT');
    await lockFileCollaborationPaths(database, source.workspaceId, [source.path, afterPath]); assertActive();
    const registry = await database.get('SELECT * FROM collaboration_documents WHERE id=$1 FOR UPDATE', [source.documentId]) as Row | undefined;
    const lineage = await database.get('SELECT * FROM file_collaboration_lineages WHERE id=$1 FOR UPDATE', [mutation.lineageId]) as Row | undefined;
    const row = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id=$1 FOR UPDATE', [source.documentId]) as Row | undefined;
    assertActive();
    if (!registry || !lineage || !row || registry.lineage_id !== mutation.lineageId || registry.provider !== 'yjs'
      || registry.yjs_state_lifecycle !== 'initialized' || rowVersion(registry.state_version) !== mutation.registryStateVersion
      || [registry, lineage].some((record) => record.workspace_id !== source.workspaceId || record.organization_id !== source.organizationId
        || record.path !== source.path || record.status !== 'active')) return fail('NATIVE_FILE_SOURCE_CHANGED');
    if (await database.get(`SELECT operation_id FROM collaboration_agent_operations WHERE document_id=$1
      AND status NOT IN ('persisted_yjs','checkpointed_file','cancelled','expired','superseded','failed','rejected','reverted') LIMIT 1`, [source.documentId])) return fail('NATIVE_FILE_MUTATION_BUSY');
    assertActive();
    if (mutation.kind === 'move' && (await database.get(`SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND status='active'
      AND (path=$2 OR left($2,length(path)+1)=path||'/' OR left(path,length($2)+1)=$2||'/') AND id<>$3
      UNION ALL SELECT id FROM file_collaboration_lineages WHERE workspace_id=$1 AND status='active'
      AND (path=$2 OR left($2,length(path)+1)=path||'/' OR left(path,length($2)+1)=$2||'/') AND id<>$4 LIMIT 1`,
    [source.workspaceId, afterPath, source.documentId, mutation.lineageId]))) return fail('NATIVE_FILE_DESTINATION_CONFLICT');
    const state = await loadCollaborationStateOnConnection(database, source.documentId, true); assertActive();
    if (!state || state.status !== 'active' || nativeLinkJsonProof({ documentId: state.documentId, workspaceId: state.workspaceId,
      organizationId: state.organizationId, path: state.path, representation: state.representation,
      lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion }) !== nativeLinkJsonProof(source)) return fail('NATIVE_FILE_SOURCE_CHANGED');
    const next = candidateState(state, mutation); assertActive();
    const previousProjection = await database.get('SELECT lifecycle_generation,projected_sequence FROM collaboration_file_projections WHERE document_id=$1 FOR UPDATE', [source.documentId]) as Row | undefined;
    if (previousProjection && (rowVersion(previousProjection.lifecycle_generation) > source.lifecycleGeneration
      || rowVersion(previousProjection.lifecycle_generation) === source.lifecycleGeneration && rowVersion(previousProjection.projected_sequence) > state.documentSequence)) return fail('NATIVE_FILE_SOURCE_CHANGED');
    assertActive();
    // The single-use claim covers BOTH link delta and path/lifecycle mutation.
    claimCollaborationAdmissionMutation(database, action, row);
    const afterStatus = mutation.kind === 'archive' ? 'archived' : 'active';
    const afterGeneration = source.lifecycleGeneration + (mutation.kind === 'archive' ? 1 : 0);
    const sequence = state.documentSequence + (mutation.prepared ? 1 : 0);
    const now = Math.max(Date.now(), state.persistedAt); const persistedAt = mutation.prepared ? now : state.persistedAt;
    const afterRegistryVersion = mutation.kind === 'link' ? mutation.registryStateVersion : 0;
    const changed = await database.get(`UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,path=$3,status=$4,
      lifecycle_generation=$5,document_sequence=$6,persisted_at=$7,checkpoint_sequence=0,checkpointed_at=NULL,canonical_hash=NULL,serialized_hash=NULL
      WHERE document_id=$8 AND workspace_id=$9 AND organization_id IS NOT DISTINCT FROM $10 AND path=$11 AND representation=$12
        AND lifecycle_generation=$13 AND schema_version=$14 AND status='active' AND document_sequence=$15 AND persisted_at=$16
        AND yjs_state=$17 AND state_vector=$18 RETURNING document_id`,
    [Buffer.from(next.yjsState), Buffer.from(next.stateVector), afterPath, afterStatus, afterGeneration, sequence, persistedAt,
      source.documentId, source.workspaceId, source.organizationId, source.path, source.representation, source.lifecycleGeneration,
      source.schemaVersion, state.documentSequence, state.persistedAt, Buffer.from(state.yjsState), Buffer.from(state.stateVector)]);
    assertActive(); if (!changed) return fail('NATIVE_FILE_SOURCE_CHANGED');
    const registryChanged = await database.get(`UPDATE collaboration_documents SET path=$1,status=$2,state_version=$3,
      snapshot_revision_id=NULL,updated_at=$4 WHERE id=$5 AND lineage_id=$6 AND provider='yjs' AND yjs_state_lifecycle='initialized'
      AND workspace_id=$7 AND organization_id IS NOT DISTINCT FROM $8 AND path=$9 AND status='active' AND state_version=$10 RETURNING id`,
    [afterPath, afterStatus, afterRegistryVersion, now, source.documentId, mutation.lineageId, source.workspaceId, source.organizationId, source.path, mutation.registryStateVersion]);
    const lineageChanged = await database.get(`UPDATE file_collaboration_lineages SET path=$1,status=$2,archived_at=$3,trash_entry_id=$4
      WHERE id=$5 AND workspace_id=$6 AND organization_id IS NOT DISTINCT FROM $7 AND path=$8 AND status='active' RETURNING id`,
    [afterPath, afterStatus, mutation.kind === 'archive' ? now : null, mutation.trashEntryId, mutation.lineageId, source.workspaceId, source.organizationId, source.path]);
    assertActive(); if (!registryChanged || !lineageChanged) return fail('NATIVE_FILE_SOURCE_CHANGED');
    await database.run(`INSERT INTO collaboration_file_projections(document_id,lifecycle_generation,projected_sequence,finalized,updated_at)
      VALUES($1,$2,$3,0,$4) ON CONFLICT(document_id) DO UPDATE SET lifecycle_generation=excluded.lifecycle_generation,
      projected_sequence=excluded.projected_sequence,revision_id=NULL,canonical_hash=NULL,serialized_hash=NULL,finalized=0,updated_at=excluded.updated_at`,
    [source.documentId, afterGeneration, sequence, now]); assertActive();
    const receipt: NativeFileOperationReceipt = { version: 1, operationId, mutationId, requestId: bound.bundle.requestId,
      requestDigest: bound.requestDigest, changesBundleProof: bound.changesBundleProof, actor: bound.bundle.actor,
      reviewDigest: bound.bundle.reviewDigest, action, kind: mutation.kind, source, lineageId: mutation.lineageId,
      before: mutation.before, beforeRegistryStateVersion: mutation.registryStateVersion,
      after: { identity: { ...source, path: afterPath, lifecycleGeneration: afterGeneration }, status: afterStatus,
        clock: { documentSequence: sequence, persistedAt, stateProof: next.stateProof,
          stateVector: Buffer.from(next.stateVector).toString('base64'), binaryHash: hash(next.yjsState) }, registryStateVersion: afterRegistryVersion },
      projection: { status: 'pending', path: afterPath, filesystemComplete: false }, inverseRecipes: mutation.prepared?.inverseRecipes ?? [] };
    const receiptText = JSON.stringify(receipt); const receiptDigest = hash(receiptText);
    await database.run(`INSERT INTO collaboration_native_file_operation_receipts(operation_id,mutation_id,document_id,request_id,
      changes_bundle_proof,receipt_text,receipt_digest,after_state_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [operationId, mutationId, source.documentId, bound.bundle.requestId, bound.changesBundleProof, receiptText, receiptDigest, Buffer.from(next.afterStateSnapshot)]);
    assertActive();
    return { receipt, receiptDigest, executionReady: false as const };
  });
}

/** Bind this compact set proof in AdmissionOutcome.result.nativeFileReceiptSetProof.
 * Deferred SQL checks reject partial bundle completion before COMMIT. */
export function nativeFileOperationReceiptSetProofOnConnection(database: SqlConnection, action: Action, operationId: string): Promise<string> {
  return withCollaborationAdmissionMutation(database, action, async (assertActive) => {
    const bound = await boundBundle(database, action, operationId);
    const rows = await database.all(`SELECT mutation_id,receipt_digest FROM collaboration_native_file_operation_receipts
      WHERE operation_id=$1 ORDER BY mutation_id COLLATE "C"`, [operationId]) as Row[]; assertActive();
    if (rows.length !== bound.bundle.mutations.length || rows.some((row, index) => row.mutation_id !== bound.bundle.mutations[index].mutationId)) return fail('NATIVE_FILE_RECEIPT_UNCONFIRMED');
    const mutated = new Set(bound.bundle.mutations.map((mutation) => mutation.source.documentId));
    for (const guard of bound.request.expectedDocuments) if (!mutated.has(guard.documentId)) {
      const inspected = await inspectCollaborationAdmissionQuiescence(database, captureCollaborationAdmissionRequest(bound.request), guard.documentId);
      assertActive(); if (!inspected.alreadyProven) return fail('NATIVE_FILE_RECEIPT_UNCONFIRMED');
    }
    return hash('canvas.native-file-receipt-set.v1\n' + rows.map((row) => `${row.mutation_id}\t${row.receipt_digest}`).join('\n'));
  });
}

/** Internal Sideeffect seam AFTER native mutations, before ReceiptSetProof/Outcome.
 * Actual SAME-CONNECTION authority is required, but no second document is claimed. */
export function readAppliedNativeFileOperationReceiptBindingsOnConnection(database: SqlConnection, action: Action, operationId: string) {
  return withCollaborationAdmissionMutation(database, action, async (assertActive) => {
    const bound = await boundBundle(database, action, operationId);
    const receiptSetProof = await nativeFileOperationReceiptSetProofOnConnection(database, action, operationId);
    const rows = await database.all('SELECT mutation_id,receipt_text,receipt_digest FROM collaboration_native_file_operation_receipts WHERE operation_id=$1 ORDER BY mutation_id COLLATE "C"', [operationId]) as Row[];
    assertActive();
    const receipts = rows.map(row => {
      if (typeof row.receipt_text !== 'string' || row.receipt_digest !== hash(row.receipt_text)) return fail('NATIVE_FILE_RECEIPT_UNCONFIRMED');
      const receipt = decodeNativeFileOperationReceipt(row.receipt_text);
      return { mutationId: receipt.mutationId, documentId: receipt.source.documentId, lineageId: receipt.lineageId,
        source: receipt.source, after: receipt.after, projection: receipt.projection, receiptDigest: row.receipt_digest as string };
    });
    return { ...bindingSummary(bound), receiptSetProof, receipts };
  });
}

/** Fresh dedicated coordinator read after uncertain COMMIT. Historical receipt
 * and current observation are separate; later peer edits never replay intent.
 * This does not prove current link effect, authorize access, or complete a route. */
async function readValidatedNativeFileOperationReceipt(database: SqlConnection, input: {
  request: CollaborationAdmissionRequest; operationId: string; mutationId: string;
}, historical = false, readOnly = false) {
  const captured = captureCollaborationAdmissionRequest(structuredClone(input.request));
  const row = await database.get(`SELECT ${historical
    ? "r.receipt_text,r.receipt_digest,r.request_id,r.changes_bundle_proof,r.after_state_snapshot,i.intent_text,CASE WHEN octet_length(q.request_digest)=64 THEN q.request_digest END AS request_digest,CASE WHEN octet_length(q.status)<=32 THEN q.status END AS request_status"
    : 'r.*,i.intent_text,q.request_digest,q.status AS request_status,q.outcome_text'}
    FROM collaboration_native_file_operation_receipts r JOIN collaboration_native_file_operation_intents i USING(operation_id)
    JOIN collaboration_admission_requests q ON q.request_id=r.request_id
    WHERE r.operation_id=$1 AND r.mutation_id=$2${historical ? ' AND r.request_id=$3 AND octet_length(r.changes_bundle_proof)=64 AND octet_length(r.receipt_digest)=64 AND octet_length(r.receipt_text)<=6291456 AND octet_length(i.intent_text)<=67108864 AND octet_length(r.after_state_snapshot)<=4194304' : ''}`, historical ? [input.operationId,input.mutationId,captured.request.requestId] : [input.operationId, input.mutationId]) as Row | undefined;
  if (!row) return null;
  const bound = decodeBundle(row.intent_text);
  if (row.request_id !== captured.request.requestId || row.request_digest !== captured.requestDigest || row.request_status !== 'committed'
    || captured.request.actionDigest !== collaborationAdmissionActionDigest(bound.bundle.action, bound.actionPayloadText)
    || bound.bundle.actor.actorId !== captured.request.actorId || row.changes_bundle_proof !== bound.changesBundleProof
    || typeof row.receipt_text !== 'string' || row.receipt_digest !== hash(row.receipt_text)
    || !(row.after_state_snapshot instanceof Uint8Array)) return fail('NATIVE_FILE_RECEIPT_UNCONFIRMED');
  const outcome = historical ? await readHistoricalCollaborationAdmissionOutcomeOnConnection(database,captured,readOnly?{readOnly:true}:undefined)
    : await readCollaborationAdmissionOutcome(database, captured);
  const receiptSet = await database.all(`SELECT ${historical ? "CASE WHEN octet_length(mutation_id)<=256 THEN mutation_id END AS mutation_id,CASE WHEN octet_length(receipt_digest)=64 THEN receipt_digest END AS receipt_digest" : 'mutation_id,receipt_digest'} FROM collaboration_native_file_operation_receipts
    WHERE operation_id=$1 ORDER BY mutation_id COLLATE "C"${historical ? ' LIMIT 1025' : ''}`, [input.operationId]) as Row[];
  if (!outcome || receiptSet.length !== bound.bundle.mutations.length || receiptSet.some((entry, index) => entry.mutation_id !== bound.bundle.mutations[index].mutationId)
    || outcome.result.nativeFileReceiptSetProof !== hash('canvas.native-file-receipt-set.v1\n' + receiptSet.map((entry) => `${entry.mutation_id}\t${entry.receipt_digest}`).join('\n'))) return fail('NATIVE_FILE_RECEIPT_UNCONFIRMED');
  const receipt = decodeNativeFileOperationReceipt(row.receipt_text);
  const mutation = bound.bundle.mutations.find((candidate) => candidate.mutationId === input.mutationId);
  if (!mutation) return fail('NATIVE_FILE_RECEIPT_UNCONFIRMED');
  const expectedIdentity = { ...mutation.source, path: mutation.destinationPath ?? mutation.source.path,
    lifecycleGeneration: mutation.source.lifecycleGeneration + (mutation.kind === 'archive' ? 1 : 0) };
  if (receipt.operationId !== input.operationId || receipt.mutationId !== input.mutationId || receipt.requestDigest !== captured.requestDigest
    || receipt.changesBundleProof !== bound.changesBundleProof || nativeLinkJsonProof(receipt.actor) !== nativeLinkJsonProof(bound.bundle.actor)
    || receipt.reviewDigest !== bound.bundle.reviewDigest || receipt.requestId !== bound.bundle.requestId || receipt.action !== bound.bundle.action
    || receipt.kind !== mutation.kind || receipt.lineageId !== mutation.lineageId || receipt.beforeRegistryStateVersion !== mutation.registryStateVersion
    || nativeLinkJsonProof(receipt.source) !== nativeLinkJsonProof(mutation.source) || nativeLinkJsonProof(receipt.before) !== nativeLinkJsonProof(mutation.before)
    || nativeLinkJsonProof(receipt.after.identity) !== nativeLinkJsonProof(expectedIdentity)
    || receipt.after.status !== (mutation.kind === 'archive' ? 'archived' : 'active')
    || receipt.after.registryStateVersion !== (mutation.kind === 'link' ? mutation.registryStateVersion : 0)
    || receipt.after.clock.documentSequence !== mutation.before.documentSequence + (mutation.prepared ? 1 : 0)
    || receipt.after.clock.stateProof !== (mutation.prepared?.after.stateProof ?? mutation.before.stateProof)
    || receipt.after.clock.stateVector !== (mutation.prepared?.after.stateVector ?? mutation.before.stateVector)
    || !safeNumber(receipt.after.clock.persistedAt) || receipt.after.clock.persistedAt < mutation.before.persistedAt
    || !mutation.prepared && (receipt.after.clock.persistedAt !== mutation.before.persistedAt || receipt.after.clock.binaryHash !== mutation.before.binaryHash)
    || !validHash(receipt.after.clock.binaryHash) || receipt.projection.status !== 'pending' || receipt.projection.filesystemComplete !== false
    || receipt.projection.path !== expectedIdentity.path || nativeLinkJsonProof(receipt.inverseRecipes) !== nativeLinkJsonProof(mutation.prepared?.inverseRecipes ?? [])
    || receipt.after.clock.stateProof !== `yjs-snapshot-sha256-v1:${hash(row.after_state_snapshot)}`) return fail('NATIVE_FILE_RECEIPT_UNCONFIRMED');
  return {receipt,receiptDigest:row.receipt_digest as string,afterStateSnapshot:row.after_state_snapshot};
}

/** Existing coordinator read keeps its current-Yjs inclusion observation. */
export async function readCommittedNativeFileOperationReceiptOnConnection(database: SqlConnection, input: {
  request: CollaborationAdmissionRequest; operationId: string; mutationId: string;
}) {
  const checked=await readValidatedNativeFileOperationReceipt(database,input);if(!checked)return null;
  const {receipt}=checked;
  const current = await loadCollaborationStateOnConnection(database, receipt.source.documentId, true);
  if (!current || current.documentId !== receipt.source.documentId || current.workspaceId !== receipt.source.workspaceId
    || current.organizationId !== receipt.source.organizationId || current.representation !== receipt.source.representation
    || current.schemaVersion !== receipt.source.schemaVersion || current.lifecycleGeneration < receipt.after.identity.lifecycleGeneration
    || current.documentSequence < receipt.after.clock.documentSequence
    || !persistedUpdateIncludesAgentSnapshot(current.yjsState, checked.afterStateSnapshot, Y)) return fail('NATIVE_FILE_RECEIPT_UNCONFIRMED');
  const observed = authoritativeNativeCollaborationSnapshot({ ...current, status: 'active' });
  return { receipt, receiptDigest: checked.receiptDigest, executionReady: false as const,
    currentObservation: { identity: { documentId: current.documentId, workspaceId: current.workspaceId, organizationId: current.organizationId,
      path: current.path, representation: current.representation, lifecycleGeneration: current.lifecycleGeneration, schemaVersion: current.schemaVersion },
    status: current.status, clock: { ...observed.version, binaryHash: hash(current.yjsState) } } };
}

/** Exact immutable original receipt/outcome facts; no current document or
 * projection is read and no principal, claim or mutation authority is created. */
export async function readHistoricalNativeFileOperationReceiptOnConnection(database:SqlConnection,input:{
  request:CollaborationAdmissionRequest;operationId:string;mutationId:string;readOnly?:true;
}) {
  if(!input||Object.getPrototypeOf(input)!==Object.prototype||Reflect.ownKeys(input).some(key=>typeof key!=='string'||!['request','operationId','mutationId','readOnly'].includes(key)))fail('NATIVE_FILE_INVALID_INTENT');
  const fields=['request','operationId','mutationId'].map(name=>{const property=Object.getOwnPropertyDescriptor(input,name);
    if(!property?.enumerable||!Object.hasOwn(property,'value'))fail('NATIVE_FILE_INVALID_INTENT');return property!.value;});
  if(!validId(fields[1])||!validId(fields[2]))fail('NATIVE_FILE_INVALID_INTENT');
  const option=Object.getOwnPropertyDescriptor(input,'readOnly');
  if(option&&(!option.enumerable||!Object.hasOwn(option,'value')||option.value!==true))fail('NATIVE_FILE_INVALID_INTENT');
  const captured=captureCollaborationAdmissionRequest(fields[0]);
  const checked=await readValidatedNativeFileOperationReceipt(database,{request:captured.request,operationId:fields[1],mutationId:fields[2]},true,!!option);
  if(!checked)return null;
  return {receipt:checked.receipt,receiptDigest:checked.receiptDigest,executionReady:false as const};
}
