import 'server-only';

import crypto from 'node:crypto';
import type * as YTypes from 'yjs';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import {
  archivePersistedCollaborationStatePathScopes,
  lockFileCollaborationPaths,
  movePersistedCollaborationStatePathScope,
  reactivatePersistedCollaborationStatePathScope,
  withFileCollaborationTransaction,
} from '@/app/lib/files/collaboration-repository';
import { composeCanvasMarkdownDocument } from '@/app/lib/markdown/obsidian-metadata';
import { analyzeMarkdownRichMode } from '@/app/lib/markdown/rich-markdown-codec';
import { isRichTextCollaborationRepresentation, type CollaborationRepresentation, type RichTextCollaborationRepresentation, type TextCollaborationRepresentation } from './types';
import {
  createPlainTextYDoc,
  createRichMarkdownYDoc,
  convertRichMarkdownYDoc,
  richMarkdownFromYDoc,
  validateRichMarkdownYDoc,
} from './markdown-state';
import {
  getCollaborationRoomConnectionCount,
  withCollaborationRoomLifecycleLock,
} from './runtime-state';
import { Y } from './server-runtime';
import { assertCurrentCollaborationProjectionIdentity } from './projection-identity';
import { mergeCollaborationPersistenceUpdates } from './persistence-merge';
import { assertCollaborationRoomOwnerFence, type CollaborationRoomOwnerFence } from './room-owner';
import { executeLifecycleTransaction } from './lifecycle-transaction';
import { claimCollaborationAdmissionMutation, requireCollaborationAdmissionMutationRequest,
  withCollaborationAdmissionMutation } from './room-admission-handoff';
import { captureCollaborationCompactionRequest } from './compaction-contract';
import { captureCollaborationAdmissionWriterScope, CollaborationAdmissionError, type CollaborationAdmissionRequest } from './room-admission-contract';
import { assertCollaborationAdmissionOpen, lockCollaborationAdmissionWorkspace } from './room-admission';

export interface PersistedCollaborationState {
  documentId: string;
  workspaceId: string;
  organizationId: string | null;
  path: string;
  representation: TextCollaborationRepresentation;
  lifecycleGeneration: number;
  schemaVersion: number;
  yjsState: Uint8Array;
  stateVector: Uint8Array;
  documentSequence: number;
  persistedAt: number;
  checkpointedAt: number | null;
  checkpointSequence: number;
  canonicalHash: string | null;
  serializedHash: string | null;
  newlineStyle: 'lf' | 'crlf';
  hasBom: boolean;
  degraded: boolean;
  status: 'active' | 'archived';
}

export type SafeMarkdownNormalizationCheckpoint = {
  /** Projects only an already committed state, with restart-safe receipts. */
  materialize: (input: {
    state: PersistedCollaborationState;
  }) => Promise<PersistedCollaborationState>;
};

type StateRow = {
  room_owner_epoch: number;
  room_owner_token: string | null;
  room_owner_backend_pid: number | null;
  room_owner_backend_start: string | null;
  document_id: string;
  workspace_id: string;
  organization_id: string | null;
  path: string;
  representation: TextCollaborationRepresentation;
  lifecycle_generation: number;
  schema_version: number;
  yjs_state: Buffer | Uint8Array;
  state_vector: Buffer | Uint8Array;
  document_sequence: number;
  persisted_at: number;
  checkpointed_at: number | null;
  checkpoint_sequence: number;
  canonical_hash: string | null;
  serialized_hash: string | null;
  newline_style: 'lf' | 'crlf';
  has_bom: number | boolean;
  degraded: number | boolean;
  status: 'active' | 'archived';
};

function bytes(value: Buffer | Uint8Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function mapState(row: StateRow): PersistedCollaborationState {
  return {
    documentId: row.document_id,
    workspaceId: row.workspace_id,
    organizationId: row.organization_id,
    path: row.path,
    representation: row.representation,
    lifecycleGeneration: Number(row.lifecycle_generation),
    schemaVersion: Number(row.schema_version),
    yjsState: bytes(row.yjs_state),
    stateVector: bytes(row.state_vector),
    documentSequence: Number(row.document_sequence),
    persistedAt: Number(row.persisted_at),
    checkpointedAt: row.checkpointed_at === null ? null : Number(row.checkpointed_at),
    checkpointSequence: Number(row.checkpoint_sequence),
    canonicalHash: row.canonical_hash,
    serializedHash: row.serialized_hash,
    newlineStyle: row.newline_style === 'crlf' ? 'crlf' : 'lf',
    hasBom: row.has_bom === true || row.has_bom === 1,
    degraded: row.degraded === true || row.degraded === 1,
    status: row.status === 'archived' ? 'archived' : 'active',
  };
}

function encodingProfile(content: string): { canonical: string; newlineStyle: 'lf' | 'crlf'; hasBom: boolean } {
  const hasBom = content.charCodeAt(0) === 0xfeff;
  const withoutBom = hasBom ? content.slice(1) : content;
  const newlineStyle = /\r\n/u.test(withoutBom) ? 'crlf' : 'lf';
  return { canonical: withoutBom.replace(/\r\n?/gu, '\n'), newlineStyle, hasBom };
}

export function serializeCanonicalText(
  canonical: string,
  profile: Pick<PersistedCollaborationState, 'newlineStyle' | 'hasBom'>,
): string {
  const normalized = canonical.replace(/\r\n?/gu, '\n');
  const withNewlines = profile.newlineStyle === 'crlf' ? normalized.replace(/\n/gu, '\r\n') : normalized;
  return profile.hasBom ? `\uFEFF${withNewlines}` : withNewlines;
}

export function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export class CollaborationStateInactiveError extends Error {
  readonly code = 'COLLABORATION_STATE_INACTIVE';

  constructor(documentId: string) {
    super(`Collaboration state ${documentId} is archived.`);
    this.name = 'CollaborationStateInactiveError';
  }
}

export class CollaborationStateStaleError extends Error {
  readonly code = 'COLLABORATION_STATE_STALE';

  constructor(documentId: string, expectedLifecycleGeneration: number) {
    super(`Collaboration state ${documentId} is no longer at lifecycle generation ${expectedLifecycleGeneration}.`);
    this.name = 'CollaborationStateStaleError';
  }
}

async function loadCollaborationStateRow(
  documentId: string,
  includeArchived: boolean,
): Promise<PersistedCollaborationState | null> {
  const database = await openDb();
  try {
    return await loadCollaborationStateOnConnection(database, documentId, includeArchived);
  } finally {
    await database.close();
  }
}

/** Caller retains its connection/transaction; an optional share lock lasts until its commit. */
export async function loadCollaborationStateOnConnection(
  database: Pick<SqlConnection, 'get'>,
  documentId: string,
  includeArchived = false,
  lock?: 'share',
): Promise<PersistedCollaborationState | null> {
  const row = await database.get(
    `SELECT * FROM collaboration_yjs_states
     WHERE document_id = $1${includeArchived ? '' : " AND status = 'active'"}
     LIMIT 1${lock === 'share' ? ' FOR SHARE' : ''}`, [documentId],
  ) as StateRow | undefined;
  return row ? mapState(row) : null;
}

export async function loadCollaborationState(documentId: string): Promise<PersistedCollaborationState | null> {
  return loadCollaborationStateRow(documentId, false);
}

/**
 * Lifecycle-aware lookup used before initialization. Callers must distinguish
 * an archived row from a document that has never had authoritative Yjs state.
 */
export async function loadCollaborationStateIncludingArchived(
  documentId: string,
): Promise<PersistedCollaborationState | null> {
  return loadCollaborationStateRow(documentId, true);
}

export async function ensureCollaborationState(input: {
  documentId: string;
  workspaceId: string;
  organizationId: string | null;
  path: string;
  representation: TextCollaborationRepresentation;
  initialContent: string;
}): Promise<PersistedCollaborationState> {
  input = { ...input, ...captureCollaborationAdmissionWriterScope(input) };
  const validate = (state: PersistedCollaborationState): PersistedCollaborationState => {
    if (state.status === 'archived') throw new CollaborationStateInactiveError(input.documentId);
    if (state.workspaceId !== input.workspaceId || state.organizationId !== input.organizationId
      || state.path !== input.path || state.representation !== input.representation) {
      throw new Error('Collaboration document identity, lifecycle, or representation does not match the active file.');
    }
    return state;
  };
  const existing = await loadCollaborationStateIncludingArchived(input.documentId);
  // A read of an existing identity neither admits new work nor takes locks
  // needed by its owner to complete a reserved lifecycle transition.
  if (existing) return validate(existing);
  const profile = encodingProfile(input.initialContent);
  const initialDoc = isRichTextCollaborationRepresentation(input.representation)
    ? createRichMarkdownYDoc(profile.canonical, input.representation)
    : createPlainTextYDoc(profile.canonical);
  const update = Y.encodeStateAsUpdate(initialDoc);
  const vector = Y.encodeStateVector(initialDoc);
  const now = Date.now();
  try {
    return await executeLifecycleTransaction({
      openConnection: openDb,
      execute: async (database) => {
        await database.run("SET LOCAL statement_timeout = '5s'");
        await database.run("SET LOCAL lock_timeout = '4s'");
        const query = async (sql: string, values?: unknown[]) =>
          await database.all(sql, values) as Array<Record<string, unknown>>;
        await lockCollaborationAdmissionWorkspace(query, input.workspaceId);
        const current = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id = $1',
          [input.documentId]) as StateRow | undefined;
        if (current) return validate(mapState(current));
        await assertCollaborationAdmissionOpen(query, input);
        const row = await database.get(
          `INSERT INTO collaboration_yjs_states (
            document_id, workspace_id, organization_id, path, representation,
            lifecycle_generation, schema_version, yjs_state, state_vector,
            document_sequence, persisted_at, checkpointed_at, checkpoint_sequence,
            canonical_hash, serialized_hash, newline_style, has_bom, degraded
          ) VALUES ($1, $2, $3, $4, $5, 1, 1, $6, $7, 0, $8, $9, 0, $10, $11, $12, $13, 0)
          ON CONFLICT(document_id) DO NOTHING RETURNING *`,
          [input.documentId, input.workspaceId, input.organizationId, input.path, input.representation,
            Buffer.from(update), Buffer.from(vector), now, now, sha256Text(profile.canonical),
            sha256Text(input.initialContent), profile.newlineStyle, profile.hasBom ? 1 : 0],
        ) as StateRow | undefined;
        const resolved = row ?? await database.get(
          'SELECT * FROM collaboration_yjs_states WHERE document_id = $1', [input.documentId]) as StateRow | undefined;
        if (!resolved) throw new Error('Failed to initialize collaboration state.');
        return validate(mapState(resolved));
      },
      recoverCommitted: async (_state, commitError) => {
        // The prior session is confirmed discarded. Ensure never promises that
        // this caller's initial bytes won: an already initialized matching row
        // is the canonical result, including one committed by a racing ensure.
        const recovered = await loadCollaborationStateIncludingArchived(input.documentId);
        if (!recovered) throw commitError;
        return validate(recovered);
      },
    });
  } finally {
    initialDoc.destroy();
  }
}

export type CollaborationPersistenceIdentity = Pick<PersistedCollaborationState,
  'workspaceId' | 'organizationId' | 'path' | 'schemaVersion'> & { representation: CollaborationRepresentation };

export type CollaborationPersistenceResult = PersistedCollaborationState & {
  persistenceDisposition: 'unchanged' | 'advanced' | 'merged';
  incomingNeedsReconcile: boolean;
};

export async function persistCollaborationYDoc(
  documentId: string,
  expectedLifecycleGeneration: number,
  doc: YTypes.Doc,
  expectedIdentity?: CollaborationPersistenceIdentity,
  ownerFence?: CollaborationRoomOwnerFence,
): Promise<CollaborationPersistenceResult> {
  // Capture before yielding: the room can receive more edits while we wait for
  // a connection/row lock. Never encode the mutable room again inside this save.
  const update = Y.encodeStateAsUpdate(doc);
  const identity = expectedIdentity ? { ...expectedIdentity } : undefined;
  const fence = ownerFence ? { ...ownerFence, scope: { ...ownerFence.scope } } : undefined;
  const database = await openDb();
  let transactionOpen = false;
  let commitStarted = false;
  let discard: Error | undefined;
  try {
    // No workspace/room mutex here: projection may own the workspace while
    // waiting for file I/O, and direct disconnect already owns the room mutex.
    transactionOpen = true;
    await database.run('BEGIN');
    const current = await database.get(
      'SELECT * FROM collaboration_yjs_states WHERE document_id = $1 FOR UPDATE',
      [documentId],
    ) as StateRow | undefined;
    if (!current) throw new Error('Collaboration state does not exist.');
    if (current.status === 'archived') throw new CollaborationStateInactiveError(documentId);
    if (current.status !== 'active'
      || Number(current.lifecycle_generation) !== expectedLifecycleGeneration
      || (identity && (
        current.workspace_id !== identity.workspaceId
        || current.organization_id !== identity.organizationId
        || current.path !== identity.path
        || current.representation !== identity.representation
        || Number(current.schema_version) !== identity.schemaVersion
      ))) {
      throw new CollaborationStateStaleError(documentId, expectedLifecycleGeneration);
    }
    await assertCollaborationRoomOwnerFence(database, current, fence);
    const merged = mergeCollaborationPersistenceUpdates(bytes(current.yjs_state), update);
    let row = current;
    if (merged.disposition !== 'unchanged') {
      const changed = await database.get(
        `
          UPDATE collaboration_yjs_states
          SET yjs_state = $1, state_vector = $2, document_sequence = document_sequence + 1,
              persisted_at = $3, degraded = 0
          WHERE document_id = $4 AND status = 'active' AND lifecycle_generation = $5
            AND document_sequence = $6
          RETURNING *
        `,
        [Buffer.from(merged.update), Buffer.from(merged.stateVector), Date.now(), documentId,
          expectedLifecycleGeneration, current.document_sequence],
      ) as StateRow | undefined;
      if (!changed) throw new CollaborationStateStaleError(documentId, expectedLifecycleGeneration);
      row = changed;
    }
    // No-op stores do not clear degradation: it may describe an invalid
    // document structure, not a transient persistence failure.
    commitStarted = true;
    await database.run('COMMIT');
    transactionOpen = false;
    return { ...mapState(row), persistenceDisposition: merged.disposition,
      incomingNeedsReconcile: merged.incomingNeedsReconcile };
  } catch (error) {
    // Even an indeterminate COMMIT is safe to retry: the containment check sees
    // an already committed update as a no-op. Never acknowledge a failed reply.
    if (commitStarted) {
      discard = new Error('Discarding connection after an unconfirmed collaboration persistence commit.', { cause: error });
    }
    if (transactionOpen) {
      try { await database.run('ROLLBACK'); }
      catch (rollbackError) {
        discard = new Error('Discarding unresolved collaboration persistence transaction.', { cause: rollbackError });
        throw new AggregateError([error, rollbackError], 'Collaboration persistence and rollback failed.');
      }
    }
    throw error;
  } finally {
    await database.close(discard);
  }
}

export async function markCollaborationCheckpoint(input: {
  documentId: string;
  workspaceId: string;
  path: string;
  lifecycleGeneration: number;
  schemaVersion: number;
  sequence: number;
  canonicalContent: string;
  serializedContent: string;
  degraded?: boolean;
}): Promise<PersistedCollaborationState | null> {
  const database = await openDb();
  try {
    const row = await database.get(
      `
        UPDATE collaboration_yjs_states
        SET checkpointed_at = $1, checkpoint_sequence = $2, canonical_hash = $3, serialized_hash = $4, degraded = $5
        WHERE document_id = $6
          AND workspace_id = $7
          AND path = $8
          AND status = 'active'
          AND lifecycle_generation = $9
          AND schema_version = $10
          AND document_sequence = $11
          AND checkpoint_sequence <= $12
        RETURNING *
      `,
      [
        Date.now(),
        input.sequence,
        sha256Text(input.canonicalContent),
        sha256Text(input.serializedContent),
        input.degraded ? 1 : 0,
        input.documentId,
        input.workspaceId,
        input.path,
        input.lifecycleGeneration,
        input.schemaVersion,
        input.sequence,
        input.sequence,
      ],
    ) as StateRow | undefined;
    return row ? mapState(row) : null;
  } finally {
    await database.close();
  }
}

export type CompensatableCheckpointMaterialization<T> = {
  canonicalContent: string;
  serializedContent: string;
  result: T;
  rollback: () => Promise<void>;
};

/** No file compensation is safe until an unresolved DB transaction is gone. */
class CheckpointTransactionRollbackError extends AggregateError {
  constructor(errors: unknown[], readonly connectionDiscarded: boolean) {
    super(errors, 'Collaboration checkpoint transaction rollback failed; projection recovery is deferred.');
    this.name = 'CheckpointTransactionRollbackError';
  }
}

/**
 * Couples an external checkpoint projection with its database confirmation.
 * The caller keeps the workspace lifecycle fence throughout, and releases any
 * database row lock before rejecting confirmation and running compensation.
 */
export async function confirmCheckpointMaterialization<T, R>(input: {
  materialize: () => Promise<CompensatableCheckpointMaterialization<T>>;
  confirm: (materialized: CompensatableCheckpointMaterialization<T>) => Promise<R>;
}): Promise<R> {
  const materialized = await input.materialize();
  try {
    return await input.confirm(materialized);
  } catch (confirmationError) {
    if (confirmationError instanceof CheckpointTransactionRollbackError) throw confirmationError;
    try {
      await materialized.rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [confirmationError, rollbackError],
        'Collaboration checkpoint confirmation and file rollback both failed.',
      );
    }
    throw confirmationError;
  }
}

export type CheckpointCommitRecoveryDecision =
  | 'committed'
  | 'superseded'
  | 'rollback'
  | 'degraded';

export function checkpointCommitRecoveryDecision(input: {
  expectedSequence: number;
  expectedCanonicalHash: string;
  expectedSerializedHash: string;
  checkpointSequence: number;
  canonicalHash: string | null;
  serializedHash: string | null;
}): CheckpointCommitRecoveryDecision {
  if (input.checkpointSequence > input.expectedSequence) return 'superseded';
  if (input.checkpointSequence < input.expectedSequence) return 'rollback';
  return input.canonicalHash === input.expectedCanonicalHash
    && input.serializedHash === input.expectedSerializedHash
    ? 'committed'
    : 'degraded';
}

async function recoverIndeterminateCheckpointCommit<T>(input: {
  documentId: string;
  expectedState: PersistedCollaborationState;
  sequence: number;
  canonicalHash: string;
  serializedHash: string;
  materialized: CompensatableCheckpointMaterialization<T>;
}): Promise<{ decision: CheckpointCommitRecoveryDecision; state: PersistedCollaborationState | null }> {
  const recoveryDatabase = await openDb();
  try {
    // Autocommit waits for the discarded connection's transaction to finish,
    // then releases this short row lock before any compensating file I/O.
    const row = await recoveryDatabase.get(
      'SELECT * FROM collaboration_yjs_states WHERE document_id = $1 FOR UPDATE',
      [input.documentId],
    ) as StateRow | undefined;
    if (!row) {
      // The identity no longer exists; the old path may have been reused.
      return { decision: 'superseded', state: null };
    }
    const state = mapState(row);
    if (state.workspaceId !== input.expectedState.workspaceId || state.path !== input.expectedState.path
      || state.status !== 'active' || state.lifecycleGeneration !== input.expectedState.lifecycleGeneration
      || state.schemaVersion !== input.expectedState.schemaVersion || state.representation !== input.expectedState.representation) {
      // Never compensate through a path that now belongs to another lifecycle.
      return { decision: 'superseded', state };
    }
    const decision = checkpointCommitRecoveryDecision({
      expectedSequence: input.sequence,
      expectedCanonicalHash: input.canonicalHash,
      expectedSerializedHash: input.serializedHash,
      checkpointSequence: state.checkpointSequence,
      canonicalHash: state.canonicalHash,
      serializedHash: state.serializedHash,
    });
    if (decision === 'rollback') {
      await input.materialized.rollback();
    } else if (decision === 'degraded') {
      await recoveryDatabase.run(
        'UPDATE collaboration_yjs_states SET degraded = 1 WHERE document_id = $1 AND lifecycle_generation = $2',
        [input.documentId, input.expectedState.lifecycleGeneration],
      );
    }
    return { decision, state };
  } finally {
    await recoveryDatabase.close();
  }
}

/**
 * Serializes file projection with path/lifecycle mutations, but never holds a
 * Yjs row lock during file I/O. Newer Yjs snapshots may persist while an older
 * verified snapshot is projected; the confirmed sequence describes that file,
 * not any changes that arrived meanwhile.
 */
export async function withCollaborationCheckpointFence<T>(input: {
  documentId: string;
  workspaceId: string;
  path: string;
  representation: TextCollaborationRepresentation;
  lifecycleGeneration: number;
  schemaVersion: number;
  sequence: number;
  stateVector: Uint8Array;
  materialize: (
    state: PersistedCollaborationState,
  ) => Promise<CompensatableCheckpointMaterialization<T>>;
  /** Persist a restart-safe projection receipt in the checkpoint transaction. */
  confirmProjection?: (transaction: SqlConnection, state: PersistedCollaborationState, result: T) => Promise<void>;
}): Promise<{ result: T; state: PersistedCollaborationState } | null> {
  return withWorkspaceMutationLock(input.workspaceId, async () => {
    const database = await openDb();
    let databaseClosed = false;
    let transactionOpen = false;
    const closeDatabase = async (error?: Error) => {
      databaseClosed = true;
      transactionOpen = false;
      await database.close(error);
    };
    const rollbackTransaction = async (operationError: unknown) => {
      try {
        await database.run('ROLLBACK');
        transactionOpen = false;
      } catch (rollbackError) {
        const errors = [operationError, rollbackError];
        let connectionDiscarded = false;
        try {
          await closeDatabase(new Error('Discarding unresolved collaboration checkpoint transaction.', { cause: rollbackError }));
          connectionDiscarded = true;
        } catch (discardError) { errors.push(discardError); }
        throw new CheckpointTransactionRollbackError(errors, connectionDiscarded);
      }
    };
    try {
      const lockedRow = await database.get(
        `
          SELECT * FROM collaboration_yjs_states
          WHERE document_id = $1
            AND workspace_id = $2
            AND path = $3
            AND representation = $4
            AND status = 'active'
            AND lifecycle_generation = $5
            AND schema_version = $6
            AND document_sequence = $7
            AND checkpoint_sequence <= $8
        `,
        [
          input.documentId,
          input.workspaceId,
          input.path,
          input.representation,
          input.lifecycleGeneration,
          input.schemaVersion,
          input.sequence,
          input.sequence,
        ],
      ) as StateRow | undefined;
      if (!lockedRow) {
        return null;
      }
      const lockedState = mapState(lockedRow);
      if (!Buffer.from(lockedState.stateVector).equals(Buffer.from(input.stateVector))) {
        return null;
      }

      await assertCurrentCollaborationProjectionIdentity(lockedState, database);

      const materialized = await input.materialize(lockedState);
      const expectedCanonicalHash = sha256Text(materialized.canonicalContent);
      const expectedSerializedHash = sha256Text(materialized.serializedContent);
      const checkpointedRow = await confirmCheckpointMaterialization({
        materialize: async () => materialized,
        confirm: async () => {
          try {
            transactionOpen = true;
            await database.run('BEGIN');
            await assertCurrentCollaborationProjectionIdentity(lockedState, database);
            const row = await database.get(
              `
                UPDATE collaboration_yjs_states
                SET checkpointed_at = $1, checkpoint_sequence = $2, canonical_hash = $3, serialized_hash = $4,
                    degraded = CASE WHEN document_sequence = $6 THEN 0 ELSE degraded END
                WHERE document_id = $5
                  AND document_sequence >= $6
                  AND checkpoint_sequence <= $7
                  AND workspace_id = $8 AND path = $9 AND representation = $10
                  AND status = 'active' AND lifecycle_generation = $11 AND schema_version = $12
                RETURNING *
              `,
              [
                Date.now(),
                input.sequence,
                expectedCanonicalHash,
                expectedSerializedHash,
                input.documentId,
                input.sequence,
                input.sequence,
                input.workspaceId,
                input.path,
                input.representation,
                input.lifecycleGeneration,
                input.schemaVersion,
              ],
            ) as StateRow | undefined;
            if (!row) {
              throw new Error('Collaboration checkpoint identity changed before confirmation.');
            }
            await input.confirmProjection?.(database, mapState(row), materialized.result);
            return row;
          } catch (error) {
            // Release any short CAS row lock before compensating through file I/O.
            if (transactionOpen) {
              await rollbackTransaction(error);
            }
            throw error;
          }
        },
      });
      try {
        await database.run('COMMIT');
        transactionOpen = false;
        return { result: materialized.result, state: mapState(checkpointedRow) };
      } catch (commitError) {
        let cleanupError: CheckpointTransactionRollbackError | undefined;
        try { await rollbackTransaction(commitError); }
        catch (error) {
          if (!(error instanceof CheckpointTransactionRollbackError) || !error.connectionDiscarded) throw error;
          cleanupError = error;
        }
        if (!databaseClosed) await closeDatabase();
        let recovery: Awaited<ReturnType<typeof recoverIndeterminateCheckpointCommit<T>>>;
        try {
          recovery = await recoverIndeterminateCheckpointCommit({
            documentId: input.documentId,
            expectedState: lockedState,
            sequence: input.sequence,
            canonicalHash: expectedCanonicalHash,
            serializedHash: expectedSerializedHash,
            materialized,
          });
        } catch (recoveryError) {
          throw new AggregateError(
            [cleanupError ?? commitError, recoveryError],
            'Collaboration checkpoint commit failed and its durable outcome could not be recovered.',
          );
        }
        if (recovery.decision === 'committed') {
          return { result: materialized.result, state: recovery.state! };
        }
        if (recovery.decision === 'superseded') return null;
        if (recovery.decision === 'degraded') {
          throw new AggregateError(
            [commitError],
            'Collaboration checkpoint commit outcome conflicts with its persisted hashes.',
          );
        }
        throw commitError;
      }
    } catch (error) {
      if (transactionOpen) {
        await rollbackTransaction(error);
      }
      throw error;
    } finally {
      if (!databaseClosed) await closeDatabase();
    }
  });
}

export async function markCollaborationDegraded(
  documentId: string,
  expectedLifecycleGeneration: number,
): Promise<void> {
  const database = await openDb();
  try {
    await database.run(
      `UPDATE collaboration_yjs_states SET degraded = 1
       WHERE document_id = $1 AND lifecycle_generation = $2`,
      [documentId, expectedLifecycleGeneration],
    );
  } finally {
    await database.close();
  }
}

const TERMINAL_AGENT_OPERATION_STATUSES = [
  'persisted_yjs',
  'checkpointed_file',
  'cancelled',
  'expired',
  'superseded',
  'failed',
  'rejected',
  'reverted',
] as const;

function canonicalContentFromState(state: PersistedCollaborationState): string {
  const doc = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(doc, state.yjsState);
    return state.representation === 'plain_text'
      ? doc.getText('content').toString()
      : richMarkdownFromYDoc(doc);
  } finally {
    doc.destroy();
  }
}

function createValidatedFreshDocument(representation: TextCollaborationRepresentation, canonicalContent: string): YTypes.Doc {
  const fresh = representation === 'plain_text'
    ? createPlainTextYDoc(canonicalContent)
    : createRichMarkdownYDoc(canonicalContent, representation);
  if (isRichTextCollaborationRepresentation(representation)) {
    const validation = validateRichMarkdownYDoc(fresh);
    if (!validation.valid || validation.markdown !== canonicalContent) {
      fresh.destroy();
      throw new Error(`Rich collaboration state failed ${validation.code || 'roundtrip'} validation.`);
    }
  }
  return fresh;
}

export class CollaborationRepresentationMigrationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'room_active'
      | 'lifecycle_stale'
      | 'checkpoint_stale'
      | 'content_unsupported'
      | 'agent_operation_pending'
      | 'state_changed'
      | 'checkpoint_failed',
  ) {
    super(message);
    this.name = 'CollaborationRepresentationMigrationError';
  }
}

async function pendingAgentOperationCount(database: Awaited<ReturnType<typeof openDb>>, documentId: string): Promise<number> {
  const placeholders = TERMINAL_AGENT_OPERATION_STATUSES.map((_, index) => `$${index + 2}`).join(', ');
  const row = await database.get(
    `SELECT COUNT(*) AS count FROM collaboration_agent_operations
     WHERE document_id = $1 AND status NOT IN (${placeholders})`,
    [documentId, ...TERMINAL_AGENT_OPERATION_STATUSES],
  ) as { count?: number | string } | undefined;
  return Number(row?.count || 0);
}

async function writeStateBackup(input: {
  database: Awaited<ReturnType<typeof openDb>>;
  backupId: string;
  state: PersistedCollaborationState;
  reason: 'compaction' | 'representation_change';
  now: number;
}): Promise<void> {
  await input.database.run(
    `INSERT INTO collaboration_yjs_state_backups (
      backup_id, document_id, lifecycle_generation, schema_version, representation,
      yjs_state, state_vector, document_sequence, reason, created_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.backupId,
      input.state.documentId,
      input.state.lifecycleGeneration,
      input.state.schemaVersion,
      input.state.representation,
      Buffer.from(input.state.yjsState),
      Buffer.from(input.state.stateVector),
      input.state.documentSequence,
      input.reason,
      input.now,
      input.now + 7 * 24 * 60 * 60_000,
    ],
  );
}

function isCurrentLifecycleOutcome(current: PersistedCollaborationState, expected: PersistedCollaborationState): boolean {
  const matchesIdentity = current.documentId === expected.documentId && current.status === 'active'
    && current.workspaceId === expected.workspaceId && current.organizationId === expected.organizationId
    && current.path === expected.path && current.lifecycleGeneration === expected.lifecycleGeneration
    && current.representation === expected.representation && current.schemaVersion === expected.schemaVersion
    && current.documentSequence >= expected.documentSequence;
  if (!matchesIdentity) return false;
  if (current.documentSequence === expected.documentSequence) {
    return Buffer.from(current.yjsState).equals(Buffer.from(expected.yjsState))
      && Buffer.from(current.stateVector).equals(Buffer.from(expected.stateVector));
  }
  try {
    // A later row is valid only if it causally contains our committed output,
    // including deletions. This checks temporary copies; it never writes back.
    const proof = mergeCollaborationPersistenceUpdates(current.yjsState, expected.yjsState);
    return proof.disposition === 'unchanged'
      && Buffer.from(proof.stateVector).equals(Buffer.from(current.stateVector));
  } catch {
    return false;
  }
}

/** Positive same-transaction proof, never a text-based no-effect inference. */
async function recoverLifecycleMutation(input: {
  backupId: string;
  reason: 'compaction' | 'representation_change';
  predecessor: PersistedCollaborationState;
  committed: PersistedCollaborationState;
}): Promise<PersistedCollaborationState> {
  return executeLifecycleTransaction({
    openConnection: openDb,
    execute: async (database) => {
      // This fresh transaction waits out the discarded writer, then retains
      // its row lock while reading the receipt and validating current scope.
      const row = await database.get(
        'SELECT * FROM collaboration_yjs_states WHERE document_id = $1 FOR UPDATE',
        [input.committed.documentId],
      ) as StateRow | undefined;
      const receipt = await database.get(
        `SELECT backup_id FROM collaboration_yjs_state_backups
         WHERE backup_id = $1 AND document_id = $2 AND reason = $3
           AND lifecycle_generation = $4 AND schema_version = $5
           AND representation = $6 AND document_sequence = $7
           AND yjs_state = $8 AND state_vector = $9`,
        [input.backupId, input.predecessor.documentId, input.reason,
          input.predecessor.lifecycleGeneration, input.predecessor.schemaVersion,
          input.predecessor.representation, input.predecessor.documentSequence,
          Buffer.from(input.predecessor.yjsState), Buffer.from(input.predecessor.stateVector)],
      );
      if (!row || !receipt) {
        throw new CollaborationRepresentationMigrationError('Lifecycle commit could not be proven; no file projection was attempted.', 'state_changed');
      }
      const current = mapState(row);
      if (!isCurrentLifecycleOutcome(current, input.committed)) {
        throw new CollaborationRepresentationMigrationError('The committed lifecycle was superseded before recovery.', 'state_changed');
      }
      return current;
    },
    // This recovery transaction only READS. Once its connection is discarded,
    // losing its COMMIT reply cannot undo the positive proof already read.
    recoverCommitted: async (verified) => verified,
  });
}

/**
 * Transformations are prepared outside the transaction. Lock and compare the
 * complete input before replacing it: a generation/vector check alone misses
 * stores in the same generation, including deletion-only Yjs updates.
 * The caller must retain this row lock through COMMIT/ROLLBACK.
 */
async function lockUnchangedLifecycleSnapshot(
  database: SqlConnection,
  expected: PersistedCollaborationState,
  admissionAction?: 'compact',
): Promise<PersistedCollaborationState> {
  const row = await database.get(
    'SELECT * FROM collaboration_yjs_states WHERE document_id = $1 FOR UPDATE',
    [expected.documentId],
  ) as StateRow | undefined;
  if (!row) {
    throw new CollaborationRepresentationMigrationError('Collaboration state disappeared before lifecycle mutation.', 'state_changed');
  }
  // Owner-era documents require cross-process drain authority, even after an
  // owner released its token. A process-local empty-room check is not proof.
  // Only the explicit transaction-bound entry may consume this authority. The
  // existing public lifecycle methods remain epoch-zero-only, even in a handoff.
  if (admissionAction) {
    claimCollaborationAdmissionMutation(database, admissionAction, row);
  } else if (Number(row.room_owner_epoch) !== 0 || row.room_owner_token !== null
    || row.room_owner_backend_pid !== null || row.room_owner_backend_start !== null) {
    throw new CollaborationRepresentationMigrationError('Collaboration room ownership must be drained before lifecycle mutation.', 'room_active');
  }
  const current = mapState(row);
  const { yjsState: expectedUpdate, stateVector: expectedVector, ...expectedMetadata } = expected;
  const { yjsState: currentUpdate, stateVector: currentVector, ...currentMetadata } = current;
  const keys = Object.keys(expectedMetadata) as Array<keyof typeof expectedMetadata>;
  if (keys.some((key) => currentMetadata[key] !== expectedMetadata[key])
    || !Buffer.from(currentUpdate).equals(Buffer.from(expectedUpdate))
    || !Buffer.from(currentVector).equals(Buffer.from(expectedVector))) {
    throw new CollaborationRepresentationMigrationError('Collaboration state changed while preparing lifecycle mutation.', 'state_changed');
  }
  return current;
}

/** One SQL rewrite shared by the legacy and guarded transaction owners. */
async function writeCompactedCollaborationState(database: SqlConnection, input: {
  state: PersistedCollaborationState;
  update: Uint8Array;
  vector: Uint8Array;
  canonicalContent: string;
  backupId: string;
  now: number;
  admissionAction?: 'compact';
  assertAdmissionActive?: () => void;
}): Promise<PersistedCollaborationState> {
  input.assertAdmissionActive?.();
  if (await pendingAgentOperationCount(database, input.state.documentId) > 0) {
    throw new CollaborationRepresentationMigrationError(
      'Collaboration state cannot be compacted while agent operations or reviews are pending.', 'agent_operation_pending');
  }
  input.assertAdmissionActive?.();
  const lockedState = await lockUnchangedLifecycleSnapshot(database, input.state, input.admissionAction);
  input.assertAdmissionActive?.();
  const nextSequence = lockedState.documentSequence + 1;
  if (!Number.isSafeInteger(nextSequence) || !Number.isSafeInteger(lockedState.lifecycleGeneration + 1)) {
    throw new CollaborationRepresentationMigrationError('Collaboration counters cannot advance safely.', 'state_changed');
  }
  await writeStateBackup({ database, backupId: input.backupId, state: lockedState, reason: 'compaction', now: input.now });
  input.assertAdmissionActive?.();
  const row = await database.get(
    `UPDATE collaboration_yjs_states
     SET yjs_state = $1, state_vector = $2, lifecycle_generation = lifecycle_generation + 1,
         document_sequence = $3, checkpoint_sequence = $4, persisted_at = $5, checkpointed_at = $6,
         canonical_hash = $7, compacted_at = $8, compaction_count = compaction_count + 1
     WHERE document_id = $9 AND status = 'active' AND lifecycle_generation = $10
       AND document_sequence = $11
       AND degraded = 0 AND checkpoint_sequence >= document_sequence
     RETURNING *`,
    [Buffer.from(input.update), Buffer.from(input.vector), nextSequence, nextSequence,
      input.now, input.now, sha256Text(input.canonicalContent), input.now,
      lockedState.documentId, lockedState.lifecycleGeneration, lockedState.documentSequence],
  ) as StateRow | undefined;
  input.assertAdmissionActive?.();
  if (!row) throw new CollaborationRepresentationMigrationError('Collaboration state changed concurrently during compaction.', 'state_changed');
  return mapState(row);
}

/** Domain locks only; policy decides whether to compact or explicitly abort. */
export async function lockCollaborationCompactionAdmission(
  database: SqlConnection, input: CollaborationAdmissionRequest,
): Promise<{ hasPendingOperations: boolean }> {
  const { document } = captureCollaborationCompactionRequest(input);
  await lockFileCollaborationPaths(database, document.workspaceId, [document.path]);
  const operations = await database.all(
    'SELECT status FROM collaboration_agent_operations WHERE document_id = $1 ORDER BY operation_id FOR UPDATE',
    [document.documentId],
  ) as Array<{ status: string }>;
  return { hasPendingOperations: operations.some((operation) =>
    !(TERMINAL_AGENT_OPERATION_STATUSES as readonly string[]).includes(operation.status)) };
}

/** Called in handoff prepare, before admission/state locks; no transaction nesting. */
export async function prepareCollaborationCompactionAdmission(
  database: SqlConnection, input: CollaborationAdmissionRequest,
): Promise<void> {
  if ((await lockCollaborationCompactionAdmission(database, input)).hasPendingOperations) {
    throw new CollaborationRepresentationMigrationError(
      'Collaboration state cannot be compacted while agent operations or reviews are pending.', 'agent_operation_pending');
  }
}

/** Requires the exact verified handoff connection; never opens or commits a transaction. */
export async function compactCollaborationStateInAdmissionHandoff(database: SqlConnection, input: {
  documentId: string;
  expectedLifecycleGeneration: number;
}): Promise<{ state: PersistedCollaborationState; backupId: string }> {
  return withCollaborationAdmissionMutation(database, 'compact', async (assertAdmissionActive) => {
    const { document } = captureCollaborationCompactionRequest(requireCollaborationAdmissionMutationRequest(database, 'compact'));
    if (input.documentId !== document.documentId || input.expectedLifecycleGeneration !== document.lifecycleGeneration) {
      throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
    }
    const row = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id = $1 FOR UPDATE',
      [document.documentId]) as StateRow | undefined;
    assertAdmissionActive();
    if (!row) throw new CollaborationRepresentationMigrationError('Collaboration state is unavailable.', 'lifecycle_stale');
    const state = mapState(row);
    if (state.status !== 'active' || state.lifecycleGeneration !== document.lifecycleGeneration) {
      throw new CollaborationRepresentationMigrationError('Collaboration lifecycle changed before compaction.', 'lifecycle_stale');
    }
    if (state.degraded || state.checkpointSequence < state.documentSequence) {
      throw new CollaborationRepresentationMigrationError('Compaction requires a healthy confirmed file checkpoint.', 'checkpoint_stale');
    }
    const canonicalContent = canonicalContentFromState(state);
    const fresh = createValidatedFreshDocument(state.representation, canonicalContent);
    const backupId = crypto.randomUUID();
    try {
      const compacted = await writeCompactedCollaborationState(database, {
        state, canonicalContent, backupId, now: Date.now(), admissionAction: 'compact', assertAdmissionActive,
        update: Y.encodeStateAsUpdate(fresh), vector: Y.encodeStateVector(fresh),
      });
      return { state: compacted, backupId };
    } finally {
      fresh.destroy();
    }
  });
}

/**
 * Re-encodes a fully checkpointed, idle document with Yjs GC enabled. The
 * lifecycle generation changes so offline clients cannot merge old tombstone
 * histories into the compacted room without an explicit reload/review.
 */
async function compactCollaborationStateWhileLocked(input: {
  documentId: string;
  expectedLifecycleGeneration: number;
}): Promise<PersistedCollaborationState> {
  if (getCollaborationRoomConnectionCount(input.documentId) > 0) {
    throw new Error('Collaboration state can only be compacted while the document room is empty.');
  }
  const state = await loadCollaborationState(input.documentId);
  if (!state || state.lifecycleGeneration !== input.expectedLifecycleGeneration) {
    throw new Error('Collaboration lifecycle changed before compaction.');
  }
  if (state.degraded || state.checkpointSequence < state.documentSequence) {
    throw new Error('Collaboration state must have a healthy confirmed file checkpoint before compaction.');
  }
  const canonicalContent = canonicalContentFromState(state);
  const fresh = createValidatedFreshDocument(state.representation, canonicalContent);
  const update = Y.encodeStateAsUpdate(fresh);
  const vector = Y.encodeStateVector(fresh);
  const now = Date.now();
  const backupId = crypto.randomUUID();
  try {
    return await executeLifecycleTransaction({
      openConnection: openDb,
      execute: (database) => writeCompactedCollaborationState(database, {
        state, update, vector, canonicalContent, backupId, now,
      }),
      recoverCommitted: (committed) => recoverLifecycleMutation({
        backupId, reason: 'compaction', predecessor: state, committed,
      }),
    });
  } finally {
    fresh.destroy();
  }
}

/** Room admission is locked first; file lifecycle work then shares the workspace fence. */
async function withCollaborationStateWorkspaceLock<T>(documentId: string, operation: () => Promise<T>): Promise<T> {
  const state = await loadCollaborationStateIncludingArchived(documentId);
  if (!state) {
    throw new CollaborationRepresentationMigrationError('Collaboration state is unavailable before lifecycle mutation.', 'lifecycle_stale');
  }
  return withWorkspaceMutationLock(state.workspaceId, operation);
}

export async function compactCollaborationState(input: {
  documentId: string;
  expectedLifecycleGeneration: number;
}): Promise<PersistedCollaborationState> {
  return withCollaborationRoomLifecycleLock(
    input.documentId,
    () => withCollaborationStateWorkspaceLock(input.documentId, () => compactCollaborationStateWhileLocked(input)),
  );
}

/** Quiescent server-side representation migration; never a local editor toggle. */
async function changeCollaborationRepresentationWhileLocked(input: {
  documentId: string;
  expectedLifecycleGeneration: number;
  representation: TextCollaborationRepresentation;
  schemaVersion: number;
  normalizeSafeMarkdown?: boolean;
  checkpoint?: SafeMarkdownNormalizationCheckpoint;
}): Promise<{
  canonicalContent: string;
  checkpointRequired: boolean;
  state: PersistedCollaborationState;
}> {
  if (getCollaborationRoomConnectionCount(input.documentId) > 0) {
    throw new CollaborationRepresentationMigrationError(
      'Collaboration representation can only change while the document room is empty.',
      'room_active',
    );
  }
  const state = await loadCollaborationState(input.documentId);
  if (!state || state.lifecycleGeneration !== input.expectedLifecycleGeneration) {
    throw new CollaborationRepresentationMigrationError(
      'Collaboration lifecycle changed before representation migration.',
      'lifecycle_stale',
    );
  }
  if (state.degraded || state.checkpointSequence < state.documentSequence) {
    throw new CollaborationRepresentationMigrationError(
      'A healthy confirmed checkpoint is required before representation migration.',
      'checkpoint_stale',
    );
  }
  const currentCanonicalContent = canonicalContentFromState(state);
  let canonicalContent = currentCanonicalContent;
  if (input.normalizeSafeMarkdown) {
    if (!isRichTextCollaborationRepresentation(input.representation)) {
      throw new CollaborationRepresentationMigrationError(
        'Safe Markdown normalization is only available for rich-text migration.',
        'content_unsupported',
      );
    }
    const analysis = analyzeMarkdownRichMode(currentCanonicalContent);
    if (analysis.mode === 'normalizable') {
      canonicalContent = composeCanvasMarkdownDocument(
        analysis.prefix,
        analysis.normalizedBody,
      );
    } else if (analysis.mode !== 'rich') {
      throw new CollaborationRepresentationMigrationError(
        'The collaboration content cannot be normalized safely for rich text.',
        'content_unsupported',
      );
    }
  }
  canonicalContent = encodingProfile(canonicalContent).canonical;
  const checkpointRequired = canonicalContent !== currentCanonicalContent;
  let fresh: YTypes.Doc;
  try {
    if (!checkpointRequired && isRichTextCollaborationRepresentation(state.representation)
      && isRichTextCollaborationRepresentation(input.representation)) {
      const source = new Y.Doc();
      try {
        Y.applyUpdate(source, state.yjsState);
        const validation = validateRichMarkdownYDoc(source);
        if (!validation.valid || validation.markdown !== canonicalContent) throw new Error('The existing rich checkpoint is invalid.');
        fresh = convertRichMarkdownYDoc(source, input.representation);
        const converted = validateRichMarkdownYDoc(fresh);
        if (!converted.valid || converted.markdown !== canonicalContent) {
          fresh.destroy();
          throw new Error('The converted rich checkpoint is invalid.');
        }
      } finally { source.destroy(); }
    } else {
      fresh = createValidatedFreshDocument(input.representation, canonicalContent);
    }
  } catch (error) {
    throw new CollaborationRepresentationMigrationError(
      error instanceof Error ? error.message : 'The collaboration content cannot use the requested representation.',
      'content_unsupported',
    );
  }
  const update = Y.encodeStateAsUpdate(fresh);
  const vector = Y.encodeStateVector(fresh);
  const now = Date.now();
  const backupId = crypto.randomUUID();
  let migratedState: PersistedCollaborationState;
  try {
    migratedState = await executeLifecycleTransaction({
      openConnection: openDb,
      execute: async (database) => {
        const applying = await database.get(
          `SELECT COUNT(*) AS count FROM collaboration_agent_operations
           WHERE document_id = $1 AND status IN ('applying', 'applied_to_ydoc')`,
          [state.documentId],
        ) as { count?: number | string } | undefined;
        if (Number(applying?.count || 0) > 0) {
          throw new CollaborationRepresentationMigrationError(
            'Representation migration cannot race with an authoritative agent apply.', 'agent_operation_pending',
          );
        }
        await database.run(
          `UPDATE collaboration_agent_operations
           SET status = 'expired', error_code = 'lifecycle_representation_changed',
               updated_at = $1, cas_version = cas_version + 1
           WHERE document_id = $2 AND status NOT IN (${TERMINAL_AGENT_OPERATION_STATUSES.map((_, index) => `$${index + 3}`).join(', ')})`,
          [now, state.documentId, ...TERMINAL_AGENT_OPERATION_STATUSES],
        );
        // Preserve operation -> state lock order; expiration rolls back with
        // a stale snapshot. No external file work happens in this transaction.
        const lockedState = await lockUnchangedLifecycleSnapshot(database, state);
        const nextSequence = lockedState.documentSequence + 1;
        await writeStateBackup({ database, backupId, state: lockedState, reason: 'representation_change', now });
        const row = await database.get(
          `UPDATE collaboration_yjs_states
           SET representation = $1, schema_version = $2, yjs_state = $3, state_vector = $4,
               lifecycle_generation = lifecycle_generation + 1, document_sequence = $5,
               checkpoint_sequence = $6, persisted_at = $7, checkpointed_at = $8,
               canonical_hash = $9, compacted_at = $10
           WHERE document_id = $11 AND status = 'active' AND lifecycle_generation = $12
             AND document_sequence = $13
           RETURNING *`,
          [
            input.representation, input.schemaVersion, Buffer.from(update), Buffer.from(vector), nextSequence,
            checkpointRequired ? lockedState.checkpointSequence : nextSequence,
            now, checkpointRequired ? lockedState.checkpointedAt : now,
            checkpointRequired ? lockedState.canonicalHash : sha256Text(canonicalContent), now,
            state.documentId, state.lifecycleGeneration, lockedState.documentSequence,
          ],
        ) as StateRow | undefined;
        if (!row) {
          throw new CollaborationRepresentationMigrationError(
            'Collaboration state changed concurrently during representation migration.', 'state_changed',
          );
        }
        return mapState(row);
      },
      recoverCommitted: (committed) => recoverLifecycleMutation({
        backupId, reason: 'representation_change', predecessor: state, committed,
      }),
    });
  } finally {
    fresh.destroy();
  }
  if (checkpointRequired && input.checkpoint) {
    try {
      // SQL is already authoritative. Its sequence gap survives a crash here;
      // the normal projection pipeline records/retries every later file phase.
      const projected = await input.checkpoint.materialize({ state: migratedState });
      if (!isCurrentLifecycleOutcome(projected, migratedState)
        || projected.checkpointSequence < migratedState.documentSequence
        || projected.checkpointSequence > projected.documentSequence) {
        throw new Error('The normalized checkpoint did not confirm the committed lifecycle.');
      }
      migratedState = projected;
    } catch (cause) {
      const error = new CollaborationRepresentationMigrationError(
        'Representation migration is committed; its file projection remains pending.', 'checkpoint_failed',
      );
      error.cause = cause;
      throw error;
    }
  }
  return { canonicalContent: canonicalContentFromState(migratedState), checkpointRequired, state: migratedState };
}

export async function changeCollaborationRepresentation(input: {
  documentId: string;
  expectedLifecycleGeneration: number;
  representation: TextCollaborationRepresentation;
  schemaVersion: number;
}): Promise<PersistedCollaborationState> {
  const result = await withCollaborationRoomLifecycleLock(
    input.documentId,
    () => withCollaborationStateWorkspaceLock(input.documentId, () => changeCollaborationRepresentationWhileLocked(input)),
  );
  return result.state;
}

export async function changeCollaborationRepresentationWithSafeMarkdownNormalization(input: {
  documentId: string;
  expectedLifecycleGeneration: number;
  schemaVersion: number;
  representation?: RichTextCollaborationRepresentation;
  checkpoint: SafeMarkdownNormalizationCheckpoint;
}): Promise<{
  canonicalContent: string;
  checkpointRequired: boolean;
  state: PersistedCollaborationState;
}> {
  return withCollaborationRoomLifecycleLock(
    input.documentId,
    () => withCollaborationStateWorkspaceLock(input.documentId, () => changeCollaborationRepresentationWhileLocked({
      ...input,
      representation: input.representation ?? 'tiptap_xml',
      normalizeSafeMarkdown: true,
      checkpoint: input.checkpoint,
    })),
  );
}

export async function movePersistedCollaborationPath(input: {
  workspaceId: string;
  oldPath: string;
  newPath: string;
}): Promise<void> {
  await withWorkspaceMutationLock(input.workspaceId, () => withFileCollaborationTransaction(async (transaction) => {
    await lockFileCollaborationPaths(transaction, input.workspaceId, [input.oldPath, input.newPath]);
    await movePersistedCollaborationStatePathScope(transaction, input);
  }));
}

export async function archivePersistedCollaborationPaths(input: {
  workspaceId: string;
  paths: string[];
}): Promise<void> {
  if (input.paths.length === 0) return;
  await withWorkspaceMutationLock(input.workspaceId, () => withFileCollaborationTransaction(async (transaction) => {
    await lockFileCollaborationPaths(transaction, input.workspaceId, input.paths);
    await archivePersistedCollaborationStatePathScopes(transaction, {
      ...input,
      nowMs: Date.now(),
    });
  }));
}

export async function reactivatePersistedCollaborationPath(input: {
  workspaceId: string;
  path: string;
}): Promise<void> {
  await withWorkspaceMutationLock(input.workspaceId, () => withFileCollaborationTransaction(async (transaction) => {
    await lockFileCollaborationPaths(transaction, input.workspaceId, [input.path]);
    await reactivatePersistedCollaborationStatePathScope(transaction, input);
  }));
}
