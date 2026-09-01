import 'server-only';

import crypto from 'node:crypto';
import type * as YTypes from 'yjs';

import { getDatabaseProvider, openDb } from '@/app/lib/db';
import { composeCanvasMarkdownDocument } from '@/app/lib/markdown/obsidian-metadata';
import { analyzeMarkdownRichMode } from '@/app/lib/markdown/rich-markdown-codec';
import type { TextCollaborationRepresentation } from './types';
import {
  createPlainTextYDoc,
  createRichMarkdownYDoc,
  richMarkdownFromYDoc,
  validateRichMarkdownYDoc,
} from './markdown-state';
import {
  getCollaborationRoomConnectionCount,
  withCollaborationRoomLifecycleLock,
} from './runtime-state';
import { Y } from './server-runtime';
import {
  archiveExcalidrawScenePaths,
  moveExcalidrawScenePaths,
  reactivateExcalidrawScenePath,
} from '@/app/lib/excalidraw-collaboration/repository';

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
  write: (input: {
    state: PersistedCollaborationState;
    canonicalContent: string;
  }) => Promise<{
    content: string;
    revisionId: string;
    serializedContent: string;
  }>;
  restore: (input: {
    state: PersistedCollaborationState;
    canonicalContent: string;
  }) => Promise<void>;
  finalize: (input: {
    state: PersistedCollaborationState;
    canonicalContent: string;
    fileWrite: {
      content: string;
      revisionId: string;
      serializedContent: string;
    };
  }) => Promise<void> | void;
};

type StateRow = {
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

function assertPostgres(): void {
  if (getDatabaseProvider() !== 'postgres') {
    throw new Error('Live collaboration requires the Postgres database provider.');
  }
}

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
  assertPostgres();
  const database = await openDb();
  try {
    const row = await database.get(
      `SELECT * FROM collaboration_yjs_states
       WHERE document_id = ?${includeArchived ? '' : " AND status = 'active'"}
       LIMIT 1`,
      [documentId],
    ) as StateRow | undefined;
    return row ? mapState(row) : null;
  } finally {
    await database.close();
  }
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
  assertPostgres();
  const existing = await loadCollaborationStateIncludingArchived(input.documentId);
  if (existing) {
    if (existing.status === 'archived') {
      throw new CollaborationStateInactiveError(input.documentId);
    }
    if (
      existing.workspaceId !== input.workspaceId
      || existing.path !== input.path
      || existing.representation !== input.representation
    ) {
      throw new Error('Collaboration document identity, lifecycle, or representation does not match the active file.');
    }
    return existing;
  }
  const profile = encodingProfile(input.initialContent);
  const initialDoc = input.representation === 'tiptap_xml'
    ? createRichMarkdownYDoc(profile.canonical)
    : createPlainTextYDoc(profile.canonical);
  const update = Y.encodeStateAsUpdate(initialDoc);
  const vector = Y.encodeStateVector(initialDoc);
  const now = Date.now();
  const database = await openDb();
  try {
    const row = await database.get(
      `
        INSERT INTO collaboration_yjs_states (
          document_id, workspace_id, organization_id, path, representation,
          lifecycle_generation, schema_version, yjs_state, state_vector,
          document_sequence, persisted_at, checkpointed_at, checkpoint_sequence,
          canonical_hash, serialized_hash, newline_style, has_bom, degraded
        ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, 0, ?, ?, 0, ?, ?, ?, ?, 0)
        ON CONFLICT(document_id) DO NOTHING
        RETURNING *
      `,
      [
        input.documentId,
        input.workspaceId,
        input.organizationId,
        input.path,
        input.representation,
        Buffer.from(update),
        Buffer.from(vector),
        now,
        now,
        sha256Text(profile.canonical),
        sha256Text(input.initialContent),
        profile.newlineStyle,
        profile.hasBom ? 1 : 0,
      ],
    ) as StateRow | undefined;
    const state = row
      ? mapState(row)
      : await loadCollaborationStateIncludingArchived(input.documentId);
    if (!state) throw new Error('Failed to initialize collaboration state.');
    if (state.status === 'archived') throw new CollaborationStateInactiveError(input.documentId);
    if (
      state.workspaceId !== input.workspaceId
      || state.path !== input.path
      || state.representation !== input.representation
    ) {
      throw new Error('Collaboration document identity or representation does not match the active file.');
    }
    return state;
  } finally {
    initialDoc.destroy();
    await database.close();
  }
}

export async function persistCollaborationYDoc(
  documentId: string,
  expectedLifecycleGeneration: number,
  doc: YTypes.Doc,
): Promise<PersistedCollaborationState> {
  assertPostgres();
  const update = Y.encodeStateAsUpdate(doc);
  const vector = Y.encodeStateVector(doc);
  const now = Date.now();
  const database = await openDb();
  try {
    const row = await database.get(
      `
        UPDATE collaboration_yjs_states
        SET yjs_state = ?, state_vector = ?, document_sequence = document_sequence + 1,
            persisted_at = ?, degraded = 0
        WHERE document_id = ? AND status = 'active' AND lifecycle_generation = ?
        RETURNING *
      `,
      [Buffer.from(update), Buffer.from(vector), now, documentId, expectedLifecycleGeneration],
    ) as StateRow | undefined;
    if (!row) {
      const existing = await database.get(
        'SELECT status, lifecycle_generation FROM collaboration_yjs_states WHERE document_id = ? LIMIT 1',
        [documentId],
      ) as { status?: string; lifecycle_generation?: number | string } | undefined;
      if (existing?.status === 'archived') throw new CollaborationStateInactiveError(documentId);
      if (
        existing?.status === 'active'
        && Number(existing.lifecycle_generation) !== expectedLifecycleGeneration
      ) {
        throw new CollaborationStateStaleError(documentId, expectedLifecycleGeneration);
      }
      throw new Error('Collaboration state does not exist.');
    }
    return mapState(row);
  } finally {
    await database.close();
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
  assertPostgres();
  const database = await openDb();
  try {
    const row = await database.get(
      `
        UPDATE collaboration_yjs_states
        SET checkpointed_at = ?, checkpoint_sequence = ?, canonical_hash = ?, serialized_hash = ?, degraded = ?
        WHERE document_id = ?
          AND workspace_id = ?
          AND path = ?
          AND status = 'active'
          AND lifecycle_generation = ?
          AND schema_version = ?
          AND document_sequence = ?
          AND checkpoint_sequence <= ?
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

/**
 * Couples an external checkpoint projection with its database confirmation.
 * The compensation runs before the surrounding transaction releases its row
 * lock, so a failed confirmation cannot leave the workspace file ahead of the
 * authoritative checkpoint metadata.
 */
export async function confirmCheckpointMaterialization<T, R>(input: {
  materialize: () => Promise<CompensatableCheckpointMaterialization<T>>;
  confirm: (materialized: CompensatableCheckpointMaterialization<T>) => Promise<R>;
}): Promise<R> {
  const materialized = await input.materialize();
  try {
    return await input.confirm(materialized);
  } catch (confirmationError) {
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

/**
 * Holds the collaboration state row lock across file materialization and
 * checkpoint confirmation. A concurrent Yjs persist or lifecycle update must
 * therefore happen entirely before this fence (and fail the identity check)
 * or after the checkpoint metadata and workspace projection agree.
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
}): Promise<{ result: T; state: PersistedCollaborationState } | null> {
  assertPostgres();
  const database = await openDb();
  let transactionOpen = false;
  try {
    await database.run('BEGIN');
    transactionOpen = true;
    const lockedRow = await database.get(
      `
        SELECT * FROM collaboration_yjs_states
        WHERE document_id = ?
          AND workspace_id = ?
          AND path = ?
          AND representation = ?
          AND status = 'active'
          AND lifecycle_generation = ?
          AND schema_version = ?
          AND document_sequence = ?
          AND checkpoint_sequence <= ?
        FOR UPDATE
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
      await database.run('ROLLBACK');
      transactionOpen = false;
      return null;
    }
    const lockedState = mapState(lockedRow);
    if (!Buffer.from(lockedState.stateVector).equals(Buffer.from(input.stateVector))) {
      await database.run('ROLLBACK');
      transactionOpen = false;
      return null;
    }

    return await confirmCheckpointMaterialization({
      materialize: () => input.materialize(lockedState),
      confirm: async (materialized) => {
        const checkpointedRow = await database.get(
          `
            UPDATE collaboration_yjs_states
            SET checkpointed_at = ?, checkpoint_sequence = ?, canonical_hash = ?, serialized_hash = ?, degraded = 0
            WHERE document_id = ?
              AND document_sequence = ?
              AND checkpoint_sequence <= ?
            RETURNING *
          `,
          [
            Date.now(),
            input.sequence,
            sha256Text(materialized.canonicalContent),
            sha256Text(materialized.serializedContent),
            input.documentId,
            input.sequence,
            input.sequence,
          ],
        ) as StateRow | undefined;
        if (!checkpointedRow) {
          throw new Error('Collaboration checkpoint row changed while its write fence was held.');
        }
        await database.run('COMMIT');
        transactionOpen = false;
        return { result: materialized.result, state: mapState(checkpointedRow) };
      },
    });
  } catch (error) {
    if (transactionOpen) {
      try { await database.run('ROLLBACK'); } catch {}
    }
    throw error;
  } finally {
    await database.close();
  }
}

export async function markCollaborationDegraded(
  documentId: string,
  expectedLifecycleGeneration: number,
): Promise<void> {
  if (getDatabaseProvider() !== 'postgres') return;
  const database = await openDb();
  try {
    await database.run(
      `UPDATE collaboration_yjs_states SET degraded = 1
       WHERE document_id = ? AND lifecycle_generation = ?`,
      [documentId, expectedLifecycleGeneration],
    );
  } finally {
    await database.close();
  }
}

const TERMINAL_AGENT_OPERATION_STATUSES = [
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
    : createRichMarkdownYDoc(canonicalContent);
  if (representation === 'tiptap_xml') {
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
  const placeholders = TERMINAL_AGENT_OPERATION_STATUSES.map(() => '?').join(', ');
  const row = await database.get(
    `SELECT COUNT(*) AS count FROM collaboration_agent_operations
     WHERE document_id = ? AND status NOT IN (${placeholders})`,
    [documentId, ...TERMINAL_AGENT_OPERATION_STATUSES],
  ) as { count?: number | string } | undefined;
  return Number(row?.count || 0);
}

async function writeStateBackup(input: {
  database: Awaited<ReturnType<typeof openDb>>;
  state: PersistedCollaborationState;
  reason: 'compaction' | 'representation_change';
  now: number;
}): Promise<void> {
  await input.database.run(
    `INSERT INTO collaboration_yjs_state_backups (
      backup_id, document_id, lifecycle_generation, schema_version, representation,
      yjs_state, state_vector, document_sequence, reason, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
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

/**
 * Re-encodes a fully checkpointed, idle document with Yjs GC enabled. The
 * lifecycle generation changes so offline clients cannot merge old tombstone
 * histories into the compacted room without an explicit reload/review.
 */
async function compactCollaborationStateWhileLocked(input: {
  documentId: string;
  expectedLifecycleGeneration: number;
}): Promise<PersistedCollaborationState> {
  assertPostgres();
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
  const nextSequence = state.documentSequence + 1;
  const database = await openDb();
  try {
    await database.run('BEGIN');
    if (await pendingAgentOperationCount(database, state.documentId) > 0) {
      throw new Error('Collaboration state cannot be compacted while agent operations or reviews are pending.');
    }
    await writeStateBackup({ database, state, reason: 'compaction', now });
    const row = await database.get(
      `UPDATE collaboration_yjs_states
       SET yjs_state = ?, state_vector = ?, lifecycle_generation = lifecycle_generation + 1,
           document_sequence = ?, checkpoint_sequence = ?, persisted_at = ?, checkpointed_at = ?,
           canonical_hash = ?, compacted_at = ?, compaction_count = compaction_count + 1
       WHERE document_id = ? AND status = 'active' AND lifecycle_generation = ?
         AND degraded = 0 AND checkpoint_sequence >= document_sequence
       RETURNING *`,
      [
        Buffer.from(update),
        Buffer.from(vector),
        nextSequence,
        nextSequence,
        now,
        now,
        sha256Text(canonicalContent),
        now,
        state.documentId,
        state.lifecycleGeneration,
      ],
    ) as StateRow | undefined;
    if (!row) throw new Error('Collaboration state changed concurrently during compaction.');
    await database.run('COMMIT');
    return mapState(row);
  } catch (error) {
    try { await database.run('ROLLBACK'); } catch {}
    throw error;
  } finally {
    fresh.destroy();
    await database.close();
  }
}

export async function compactCollaborationState(input: {
  documentId: string;
  expectedLifecycleGeneration: number;
}): Promise<PersistedCollaborationState> {
  assertPostgres();
  return withCollaborationRoomLifecycleLock(
    input.documentId,
    () => compactCollaborationStateWhileLocked(input),
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
  assertPostgres();
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
    if (input.representation !== 'tiptap_xml') {
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
    fresh = createValidatedFreshDocument(input.representation, canonicalContent);
  } catch (error) {
    throw new CollaborationRepresentationMigrationError(
      error instanceof Error ? error.message : 'The collaboration content cannot use the requested representation.',
      'content_unsupported',
    );
  }
  const update = Y.encodeStateAsUpdate(fresh);
  const vector = Y.encodeStateVector(fresh);
  const now = Date.now();
  const nextSequence = state.documentSequence + 1;
  const database = await openDb();
  let checkpointAttempted = false;
  let checkpointFileWrite: Awaited<ReturnType<SafeMarkdownNormalizationCheckpoint['write']>> | null = null;
  let committed = false;
  try {
    await database.run('BEGIN');
    const applying = await database.get(
      `SELECT COUNT(*) AS count FROM collaboration_agent_operations
       WHERE document_id = ? AND status IN ('applying', 'applied_to_ydoc', 'persisted_yjs')`,
      [state.documentId],
    ) as { count?: number | string } | undefined;
    if (Number(applying?.count || 0) > 0) {
      throw new CollaborationRepresentationMigrationError(
        'Representation migration cannot race with an authoritative agent apply.',
        'agent_operation_pending',
      );
    }
    await database.run(
      `UPDATE collaboration_agent_operations
       SET status = 'expired', error_code = 'lifecycle_representation_changed',
           updated_at = ?, cas_version = cas_version + 1
       WHERE document_id = ? AND status NOT IN (${TERMINAL_AGENT_OPERATION_STATUSES.map(() => '?').join(', ')})`,
      [now, state.documentId, ...TERMINAL_AGENT_OPERATION_STATUSES],
    );
    await writeStateBackup({ database, state, reason: 'representation_change', now });
    const row = await database.get(
      `UPDATE collaboration_yjs_states
       SET representation = ?, schema_version = ?, yjs_state = ?, state_vector = ?,
           lifecycle_generation = lifecycle_generation + 1, document_sequence = ?,
           checkpoint_sequence = ?, persisted_at = ?, checkpointed_at = ?,
           canonical_hash = ?, compacted_at = ?
       WHERE document_id = ? AND status = 'active' AND lifecycle_generation = ?
       RETURNING *`,
      [
        input.representation,
        input.schemaVersion,
        Buffer.from(update),
        Buffer.from(vector),
        nextSequence,
        checkpointRequired ? state.checkpointSequence : nextSequence,
        now,
        checkpointRequired ? state.checkpointedAt : now,
        sha256Text(canonicalContent),
        now,
        state.documentId,
        state.lifecycleGeneration,
      ],
    ) as StateRow | undefined;
    if (!row) {
      throw new CollaborationRepresentationMigrationError(
        'Collaboration state changed concurrently during representation migration.',
        'state_changed',
      );
    }
    let migratedState = mapState(row);
    if (checkpointRequired && input.checkpoint) {
      checkpointAttempted = true;
      checkpointFileWrite = await input.checkpoint.write({
        state: migratedState,
        canonicalContent,
      });
      const checkpointedRow = await database.get(
        `UPDATE collaboration_yjs_states
         SET checkpointed_at = ?, checkpoint_sequence = ?, canonical_hash = ?,
             serialized_hash = ?, degraded = 0
         WHERE document_id = ? AND status = 'active' AND lifecycle_generation = ?
           AND schema_version = ? AND document_sequence = ?
         RETURNING *`,
        [
          now,
          nextSequence,
          sha256Text(canonicalContent),
          sha256Text(checkpointFileWrite.serializedContent),
          state.documentId,
          migratedState.lifecycleGeneration,
          input.schemaVersion,
          nextSequence,
        ],
      ) as StateRow | undefined;
      if (!checkpointedRow) {
        throw new CollaborationRepresentationMigrationError(
          'Collaboration state changed before the normalized checkpoint could be confirmed.',
          'state_changed',
        );
      }
      migratedState = mapState(checkpointedRow);
    }
    await database.run('COMMIT');
    committed = true;
    if (checkpointFileWrite && input.checkpoint) {
      await input.checkpoint.finalize({
        state: migratedState,
        canonicalContent,
        fileWrite: checkpointFileWrite,
      });
    }
    return {
      canonicalContent,
      checkpointRequired,
      state: migratedState,
    };
  } catch (error) {
    if (!committed) {
      try { await database.run('ROLLBACK'); } catch {}
    }
    if (!committed && checkpointAttempted && input.checkpoint) {
      try {
        await input.checkpoint.restore({
          state,
          canonicalContent: currentCanonicalContent,
        });
      } catch (restoreError) {
        await markCollaborationDegraded(state.documentId, state.lifecycleGeneration);
        throw new AggregateError(
          [error, restoreError],
          'Normalized collaboration migration failed and its file checkpoint could not be restored.',
        );
      }
      if (!(error instanceof CollaborationRepresentationMigrationError)) {
        throw new CollaborationRepresentationMigrationError(
          error instanceof Error ? error.message : 'The normalized file checkpoint failed.',
          'checkpoint_failed',
        );
      }
    }
    if (committed) {
      await markCollaborationDegraded(state.documentId, state.lifecycleGeneration + 1);
    }
    throw error;
  } finally {
    fresh.destroy();
    await database.close();
  }
}

export async function changeCollaborationRepresentation(input: {
  documentId: string;
  expectedLifecycleGeneration: number;
  representation: TextCollaborationRepresentation;
  schemaVersion: number;
}): Promise<PersistedCollaborationState> {
  assertPostgres();
  const result = await withCollaborationRoomLifecycleLock(
    input.documentId,
    () => changeCollaborationRepresentationWhileLocked(input),
  );
  return result.state;
}

export async function changeCollaborationRepresentationWithSafeMarkdownNormalization(input: {
  documentId: string;
  expectedLifecycleGeneration: number;
  schemaVersion: number;
  checkpoint: SafeMarkdownNormalizationCheckpoint;
}): Promise<{
  canonicalContent: string;
  checkpointRequired: boolean;
  state: PersistedCollaborationState;
}> {
  assertPostgres();
  return withCollaborationRoomLifecycleLock(
    input.documentId,
    () => changeCollaborationRepresentationWhileLocked({
      ...input,
      representation: 'tiptap_xml',
      normalizeSafeMarkdown: true,
      checkpoint: input.checkpoint,
    }),
  );
}

function escapedLikePath(path: string): string {
  return path.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

export async function movePersistedCollaborationPath(input: {
  workspaceId: string;
  oldPath: string;
  newPath: string;
}): Promise<void> {
  if (getDatabaseProvider() !== 'postgres') return;
  await moveExcalidrawScenePaths(input);
  const database = await openDb();
  try {
    const oldPrefix = `${input.oldPath}/`;
    await database.run(
      `
        UPDATE collaboration_yjs_states
        SET path = CASE
          WHEN path = ? THEN ?
          ELSE ? || SUBSTRING(path FROM ?)
        END
        WHERE workspace_id = ? AND status = 'active'
          AND (path = ? OR path LIKE ? ESCAPE '\\')
      `,
      [
        input.oldPath,
        input.newPath,
        `${input.newPath}/`,
        oldPrefix.length + 1,
        input.workspaceId,
        input.oldPath,
        `${escapedLikePath(oldPrefix)}%`,
      ],
    );
  } finally {
    await database.close();
  }
}

export async function archivePersistedCollaborationPaths(input: {
  workspaceId: string;
  paths: string[];
}): Promise<void> {
  if (getDatabaseProvider() !== 'postgres' || input.paths.length === 0) return;
  await archiveExcalidrawScenePaths(input);
  const database = await openDb();
  try {
    await database.run('BEGIN');
    for (const path of input.paths) {
      const rows = await database.all(
        "SELECT document_id FROM collaboration_yjs_states WHERE workspace_id = ? AND status = 'active' AND (path = ? OR path LIKE ? ESCAPE '\\')",
        [input.workspaceId, path, `${escapedLikePath(`${path}/`)}%`],
      ) as Array<{ document_id: string }>;
      for (const row of rows) {
        await database.run(
          `UPDATE collaboration_agent_operations
           SET status = 'cancelled', cancel_requested_at = ?, error_code = 'document_deleted', updated_at = ?, cas_version = cas_version + 1
           WHERE document_id = ?
             AND status NOT IN ('checkpointed_file', 'cancelled', 'expired', 'superseded', 'failed', 'rejected', 'reverted')`,
          [Date.now(), Date.now(), row.document_id],
        );
      }
      await database.run(
        "UPDATE collaboration_yjs_states SET status = 'archived', lifecycle_generation = lifecycle_generation + 1 WHERE workspace_id = ? AND status = 'active' AND (path = ? OR path LIKE ? ESCAPE '\\')",
        [input.workspaceId, path, `${escapedLikePath(`${path}/`)}%`],
      );
    }
    await database.run('COMMIT');
  } catch (error) {
    try { await database.run('ROLLBACK'); } catch {}
    throw error;
  } finally {
    await database.close();
  }
}

export async function reactivatePersistedCollaborationPath(input: {
  workspaceId: string;
  path: string;
}): Promise<void> {
  if (getDatabaseProvider() !== 'postgres') return;
  await reactivateExcalidrawScenePath(input);
  const database = await openDb();
  try {
    await database.run(
      "UPDATE collaboration_yjs_states SET status = 'active', lifecycle_generation = lifecycle_generation + 1, degraded = 0 WHERE workspace_id = ? AND path = ? AND status = 'archived'",
      [input.workspaceId, input.path],
    );
  } finally {
    await database.close();
  }
}
