import 'server-only';

import { createHash } from 'node:crypto';
import * as decoding from 'lib0/decoding';
import type { SqlConnection } from '@/app/lib/db';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { lockFileCollaborationPaths } from '@/app/lib/files/collaboration-repository';
import { assertWorkspaceFileLifecycleSqlAvailable, withWorkspaceFileLifecycleGuard } from '@/app/lib/files/workspace-file-lifecycle-guard';
import { getWorkspaceFileLifecycleLeases } from '@/app/lib/collaboration/file-lifecycle-admission-context';
import { captureAgentStateSnapshot, persistedUpdateIncludesAgentSnapshot } from '@/app/lib/collaboration/agent-durability';
import { authoritativeNativeCollaborationSnapshot, inspectPersistedNativeCollaborationSnapshot } from '@/app/lib/collaboration/document-snapshot';
import { executeLifecycleTransaction } from '@/app/lib/collaboration/lifecycle-transaction';
import { loadCollaborationStateOnConnection, type PersistedCollaborationState } from '@/app/lib/collaboration/persistence';
import { isCollaborationStateProof } from '@/app/lib/collaboration/state-proof';
import { Y } from '@/app/lib/collaboration/server-runtime';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from './workspace-native-link-inventory';
import type { NativeLinkDocumentIdentity } from './workspace-link-contract-v2';
import type { NativeLinkInverseRecipe, PreparedNativeLinkUpdate } from './workspace-native-link-mutations';

export type NativeLinkMutationBinding = {
  actorUserId: string;
  actorId: string;
  actorType: 'user' | 'agent' | 'automation' | 'system';
  actorSessionId: string | null;
  requestId: string;
  /** Server-approved semantic request; never accept this as public authority. */
  requestHash: string;
  /** Bind the exact private prepared intent, including its CRDT delta and inverse. */
  authorizedPreparedProof: string;
};

type NativeMutationClock = { stateProof: string; stateVector: string; documentSequence: number; persistedAt: number };
export type NativeLinkMutationReceipt = {
  contractVersion: 2;
  operationId: string;
  source: NativeLinkDocumentIdentity;
  binding: NativeLinkMutationBinding;
  before: PreparedNativeLinkUpdate['before'];
  after: NativeMutationClock;
  /** Private, content-free durable containment evidence, including deletions. */
  afterStateSnapshot: Uint8Array;
  inverseRecipes: NativeLinkInverseRecipe[];
};
export type NativeLinkMutationPersistenceResult = {
  disposition: 'applied' | 'already-applied' | 'commit-recovered';
  receipt: NativeLinkMutationReceipt;
  /** A later observation is separate from the operation's committed sequence. */
  currentObservation: NativeMutationClock;
};

export class NativeLinkPersistenceError extends Error {
  readonly status = 409;
  constructor(readonly code: 'NATIVE_LINK_INVALID_PREPARED' | 'NATIVE_LINK_SOURCE_CHANGED'
    | 'NATIVE_LINK_REQUEST_CONFLICT' | 'NATIVE_LINK_MUTATION_BUSY' | 'NATIVE_LINK_COMMIT_UNCONFIRMED') {
    super(`Native link persistence is unavailable: ${code}.`);
    this.name = 'NativeLinkPersistenceError';
  }
}
const fail = (code: NativeLinkPersistenceError['code']): never => { throw new NativeLinkPersistenceError(code); };
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/** Persist/reuse this proof with the private intent before mutation. Re-preparing
 * a candidate with new Yjs client identities is a different prepared intent. */
export function nativeLinkPreparedIntentProof(prepared: PreparedNativeLinkUpdate): string {
  return nativeLinkJsonProof({ contractVersion: prepared.contractVersion, operationId: prepared.operationId,
    source: prepared.source, before: prepared.before, after: prepared.after,
    updateHash: digest(prepared.update), inverseRecipes: prepared.inverseRecipes });
}

function bytes(value: unknown): Buffer {
  if (!(value instanceof Uint8Array)) return fail('NATIVE_LINK_REQUEST_CONFLICT');
  return Buffer.from(value);
}
function vector(value: string): Buffer {
  if (typeof value !== 'string' || !value) return fail('NATIVE_LINK_INVALID_PREPARED');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) return fail('NATIVE_LINK_INVALID_PREPARED');
  return decoded;
}
function capture(input: { workspace: WorkspaceContext; prepared: PreparedNativeLinkUpdate; binding: NativeLinkMutationBinding }) {
  let value: typeof input;
  try { value = structuredClone(input); } catch { return fail('NATIVE_LINK_INVALID_PREPARED'); }
  const { workspace, prepared, binding } = value;
  if (!workspace.permissions.canRead || !workspace.permissions.canWrite
    || workspace.status !== undefined && workspace.status !== 'active') {
    throw Object.assign(new Error('Current workspace mutation permission is required.'), { status: 403 });
  }
  if (prepared.contractVersion !== 2 || !validId(prepared.operationId)
    || !validId(prepared.source.documentId) || prepared.source.workspaceId !== workspace.workspaceId
    || prepared.source.organizationId !== (workspace.organizationId ?? null)
    || !Number.isSafeInteger(prepared.before.documentSequence) || prepared.before.documentSequence < 0
    || prepared.before.documentSequence >= Number.MAX_SAFE_INTEGER
    || !isCollaborationStateProof(prepared.before.stateProof) || !isCollaborationStateProof(prepared.after.stateProof)
    || prepared.before.stateProof === prepared.after.stateProof
    || !(prepared.update instanceof Uint8Array) || !prepared.update.byteLength || prepared.update.byteLength > 16 * 1024 * 1024
    || !Array.isArray(prepared.inverseRecipes) || Buffer.byteLength(JSON.stringify(prepared.inverseRecipes)) > 4 * 1024 * 1024
    || !validId(binding.actorUserId) || !validId(binding.actorId) || !validId(binding.requestId)
    || binding.actorSessionId !== null && !validId(binding.actorSessionId)
    || !['user','agent','automation','system'].includes(binding.actorType)
    || !validHash(binding.requestHash) || !validHash(binding.authorizedPreparedProof)
    || binding.authorizedPreparedProof !== nativeLinkPreparedIntentProof(prepared)) return fail('NATIVE_LINK_INVALID_PREPARED');
  vector(prepared.before.stateVector); vector(prepared.after.stateVector);
  return value;
}

async function currentState(database: SqlConnection, source: NativeLinkDocumentIdentity): Promise<PersistedCollaborationState> {
  const registry = await database.get(`SELECT id,workspace_id,organization_id,path,provider,status,yjs_state_lifecycle
    FROM collaboration_documents WHERE id=$1`, [source.documentId]) as Record<string, unknown> | undefined;
  const state = await loadCollaborationStateOnConnection(database, source.documentId, true);
  if (!registry || registry.status !== 'active' || registry.provider !== 'yjs' || registry.yjs_state_lifecycle !== 'initialized'
    || registry.workspace_id !== source.workspaceId || registry.organization_id !== source.organizationId || registry.path !== source.path
    || !state || state.status !== 'active' || state.documentId !== source.documentId || state.workspaceId !== source.workspaceId
    || state.organizationId !== source.organizationId || state.path !== source.path || state.lifecycleGeneration !== source.lifecycleGeneration
    || state.representation !== source.representation || state.schemaVersion !== source.schemaVersion) return fail('NATIVE_LINK_SOURCE_CHANGED');
  return state;
}

function clock(state: PersistedCollaborationState): NativeMutationClock {
  const snapshot = authoritativeNativeCollaborationSnapshot(state);
  return { stateProof: snapshot.version.stateProof, stateVector: snapshot.version.stateVector,
    documentSequence: snapshot.version.documentSequence, persistedAt: snapshot.version.persistedAt };
}

type ReceiptRow = Record<string, unknown>;
function receiptFrom(row: ReceiptRow): NativeLinkMutationReceipt {
  const receipt: NativeLinkMutationReceipt = { contractVersion: 2,
    operationId: String(row.operation_id), source: { documentId: String(row.document_id), workspaceId: String(row.workspace_id),
      organizationId: row.organization_id as string | null, path: String(row.path),
      representation: row.representation as NativeLinkDocumentIdentity['representation'],
      lifecycleGeneration: Number(row.lifecycle_generation), schemaVersion: Number(row.schema_version) },
    binding: { actorUserId: String(row.actor_user_id), actorId: String(row.actor_id), actorType: row.actor_type as NativeLinkMutationBinding['actorType'],
      actorSessionId: row.actor_session_id as string | null, requestId: String(row.request_id), requestHash: String(row.request_hash),
      authorizedPreparedProof: String(row.authorized_prepared_proof) },
    before: { documentSequence: Number(row.before_sequence), stateProof: String(row.before_state_proof), stateVector: bytes(row.before_state_vector).toString('base64') },
    after: { documentSequence: Number(row.after_sequence), stateProof: String(row.after_state_proof), stateVector: bytes(row.after_state_vector).toString('base64'), persistedAt: Number(row.persisted_at) },
    afterStateSnapshot: bytes(row.after_state_snapshot), inverseRecipes: row.inverse_recipes as NativeLinkInverseRecipe[] };
  if (!Number.isSafeInteger(receipt.after.documentSequence) || receipt.after.documentSequence !== receipt.before.documentSequence + 1
    || !Number.isSafeInteger(receipt.after.persistedAt) || receipt.after.persistedAt < 0
    || !Array.isArray(receipt.inverseRecipes) || !isCollaborationStateProof(receipt.after.stateProof)
    || `yjs-snapshot-sha256-v1:${digest(receipt.afterStateSnapshot)}` !== receipt.after.stateProof) return fail('NATIVE_LINK_REQUEST_CONFLICT');
  return receipt;
}

async function existingReceipt(database: SqlConnection, prepared: PreparedNativeLinkUpdate, binding: NativeLinkMutationBinding) {
  const rows = await database.all(`SELECT * FROM collaboration_native_link_mutation_receipts
    WHERE operation_id=$1 OR (document_id=$2 AND actor_user_id=$3 AND actor_id=$4 AND actor_type=$5
      AND actor_session_id IS NOT DISTINCT FROM $6 AND request_id=$7)`,
  [prepared.operationId, prepared.source.documentId, binding.actorUserId, binding.actorId, binding.actorType, binding.actorSessionId, binding.requestId]) as ReceiptRow[];
  if (!rows.length) return null;
  if (rows.length !== 1) return fail('NATIVE_LINK_REQUEST_CONFLICT');
  const receipt = receiptFrom(rows[0]);
  if (receipt.operationId !== prepared.operationId || nativeLinkJsonProof(receipt.source) !== nativeLinkJsonProof(prepared.source)
    || nativeLinkJsonProof(receipt.binding) !== nativeLinkJsonProof(binding) || nativeLinkJsonProof(receipt.before) !== nativeLinkJsonProof(prepared.before)
    || receipt.after.stateProof !== prepared.after.stateProof || receipt.after.stateVector !== prepared.after.stateVector
    || nativeLinkJsonProof(receipt.inverseRecipes) !== nativeLinkJsonProof(prepared.inverseRecipes)) return fail('NATIVE_LINK_REQUEST_CONFLICT');
  return receipt;
}

function observeReceipt(state: PersistedCollaborationState, receipt: NativeLinkMutationReceipt): NativeMutationClock {
  const observed = clock(state);
  if (observed.documentSequence < receipt.after.documentSequence
    || !persistedUpdateIncludesAgentSnapshot(state.yjsState, receipt.afterStateSnapshot, Y)) return fail('NATIVE_LINK_COMMIT_UNCONFIRMED');
  return observed;
}

function applyPrepared(state: PersistedCollaborationState, prepared: PreparedNativeLinkUpdate) {
  return inspectPersistedNativeCollaborationSnapshot(state, (before, snapshot) => {
    if (snapshot.version.stateProof !== prepared.before.stateProof || snapshot.version.stateVector !== prepared.before.stateVector
      || snapshot.version.documentSequence !== prepared.before.documentSequence) return fail('NATIVE_LINK_SOURCE_CHANGED');
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(before));
      const decoder = decoding.createDecoder(prepared.update); Y.readUpdate(decoder, candidate);
      if (decoding.hasContent(decoder)) return fail('NATIVE_LINK_INVALID_PREPARED');
      const next = { ...state, yjsState: Y.encodeStateAsUpdate(candidate), stateVector: Y.encodeStateVector(candidate) };
      const inventory = inspectPersistedDocumentLinks(next);
      if (!inventory.coverage.complete || inventory.version.stateProof !== prepared.after.stateProof
        || inventory.version.stateVector !== prepared.after.stateVector) return fail('NATIVE_LINK_INVALID_PREPARED');
      const afterStateSnapshot = captureAgentStateSnapshot(candidate, Y);
      if (!afterStateSnapshot) return fail('NATIVE_LINK_INVALID_PREPARED');
      return { update: next.yjsState, stateVector: next.stateVector, afterStateSnapshot };
    } finally { candidate.destroy(); }
  });
}

async function confirmedRetry(database: SqlConnection, prepared: PreparedNativeLinkUpdate, binding: NativeLinkMutationBinding) {
  const receipt = await existingReceipt(database, prepared, binding);
  if (!receipt) return null;
  return { receipt, currentObservation: observeReceipt(await currentState(database, prepared.source), receipt) };
}

/**
 * Private coordinator seam, not a public edit API. The server must authorize
 * the exact reviewed graph effect and bind its private prepared intent before
 * calling. This function proves durable application once; a historical receipt
 * does not prove that later peers left the link target unchanged. It neither
 * exports Markdown nor marks a batch complete nor authorizes an Undo rebase.
 */
export async function persistPreparedNativeLinkMutation(input: {
  workspace: WorkspaceContext;
  prepared: PreparedNativeLinkUpdate;
  binding: NativeLinkMutationBinding;
  /** Required current actor/Review authority recheck under the real mutation fence. */
  validateAuthority: () => Promise<void>;
}, dependencies: { openConnection: () => Promise<SqlConnection> }): Promise<NativeLinkMutationPersistenceResult> {
  const { workspace, prepared, binding } = capture({ workspace: input.workspace, prepared: input.prepared, binding: input.binding });
  const { validateAuthority } = input;
  if (typeof validateAuthority !== 'function') return fail('NATIVE_LINK_INVALID_PREPARED');
  return withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [prepared.source.path] }, async () => {
    await validateAuthority();
    return executeLifecycleTransaction<NativeLinkMutationPersistenceResult>({ openConnection: dependencies.openConnection,
      execute: async database => {
        await assertWorkspaceFileLifecycleSqlAvailable(database, workspace.workspaceId, [prepared.source.path]);
        await lockFileCollaborationPaths(database, workspace.workspaceId, [prepared.source.path]);
        const prior = await confirmedRetry(database, prepared, binding);
        if (prior) return { disposition: 'already-applied' as const, ...prior };
        const active = await database.get(`SELECT operation_id FROM collaboration_agent_operations
          WHERE document_id=$1 AND status IN ('preparing','ready','applying','applied_to_ydoc','cancel_requested') LIMIT 1`, [prepared.source.documentId]);
        if (active) return fail('NATIVE_LINK_MUTATION_BUSY');
        await database.get('SELECT id FROM collaboration_documents WHERE id=$1 FOR UPDATE', [prepared.source.documentId]);
        const state = await currentState(database, prepared.source);
        const candidate = applyPrepared(state, prepared);
        await validateAuthority();
        const changed = await database.get(`UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,
          document_sequence=document_sequence+1,persisted_at=$3
          WHERE document_id=$4 AND workspace_id=$5 AND organization_id IS NOT DISTINCT FROM $6 AND path=$7
            AND representation=$8 AND lifecycle_generation=$9 AND schema_version=$10 AND status='active' AND document_sequence=$11
          RETURNING document_sequence,persisted_at`, [Buffer.from(candidate.update), Buffer.from(candidate.stateVector), Math.max(Date.now(), state.persistedAt),
        prepared.source.documentId, prepared.source.workspaceId, prepared.source.organizationId, prepared.source.path,
        prepared.source.representation, prepared.source.lifecycleGeneration, prepared.source.schemaVersion, prepared.before.documentSequence]) as ReceiptRow | undefined;
        if (!changed) return fail('NATIVE_LINK_SOURCE_CHANGED');
        const row = await database.get(`INSERT INTO collaboration_native_link_mutation_receipts(operation_id,document_id,workspace_id,organization_id,path,
          representation,lifecycle_generation,schema_version,actor_user_id,actor_id,actor_type,actor_session_id,request_id,request_hash,authorized_prepared_proof,
          before_sequence,before_state_proof,before_state_vector,after_sequence,after_state_proof,after_state_vector,after_state_snapshot,inverse_recipes,persisted_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24) RETURNING *`,
        [prepared.operationId, prepared.source.documentId, prepared.source.workspaceId, prepared.source.organizationId, prepared.source.path,
          prepared.source.representation, prepared.source.lifecycleGeneration, prepared.source.schemaVersion, binding.actorUserId, binding.actorId, binding.actorType,
          binding.actorSessionId, binding.requestId, binding.requestHash, binding.authorizedPreparedProof, prepared.before.documentSequence,
          prepared.before.stateProof, vector(prepared.before.stateVector), changed.document_sequence, prepared.after.stateProof,
          Buffer.from(candidate.stateVector), Buffer.from(candidate.afterStateSnapshot), JSON.stringify(prepared.inverseRecipes), changed.persisted_at]) as ReceiptRow | undefined;
        if (!row) return fail('NATIVE_LINK_COMMIT_UNCONFIRMED');
        const receipt = receiptFrom(row);
        return { disposition: 'applied' as const, receipt, currentObservation: { ...receipt.after } };
      },
      recoverCommitted: async () => {
        const database = await dependencies.openConnection();
        let discard: Error | undefined;
        try {
          const lease = getWorkspaceFileLifecycleLeases()?.get(workspace.workspaceId);
          if (!lease?.active || !await lease.verify()) return fail('NATIVE_LINK_COMMIT_UNCONFIRMED');
          await validateAuthority();
          await database.run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const prior = await confirmedRetry(database, prepared, binding);
          if (!prior) return fail('NATIVE_LINK_COMMIT_UNCONFIRMED');
          await database.run('COMMIT');
          if (!lease.active || !await lease.verify()) return fail('NATIVE_LINK_COMMIT_UNCONFIRMED');
          return { disposition: 'commit-recovered' as const, ...prior };
        } catch (error) {
          try { await database.run('ROLLBACK'); }
          catch (rollbackError) { discard = new Error('Discarding unresolved native link receipt verification.', { cause: rollbackError }); }
          throw error;
        } finally { await database.close(discard); }
      },
    });
  }, dependencies.openConnection);
}
