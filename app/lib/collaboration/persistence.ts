import 'server-only';

import crypto from 'node:crypto';
import type * as YTypes from 'yjs';

import { getDatabaseProvider, openDb } from '@/app/lib/db';
import type { TextCollaborationRepresentation } from './types';
import {
  createPlainTextYDoc,
  createRichMarkdownYDoc,
  richMarkdownFromYDoc,
  validateRichMarkdownYDoc,
} from './markdown-state';
import { getCollaborationRoomConnectionCount } from './runtime-state';
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

export async function loadCollaborationState(documentId: string): Promise<PersistedCollaborationState | null> {
  assertPostgres();
  const database = await openDb();
  try {
    const row = await database.get(
      "SELECT * FROM collaboration_yjs_states WHERE document_id = ? AND status = 'active' LIMIT 1",
      [documentId],
    ) as StateRow | undefined;
    return row ? mapState(row) : null;
  } finally {
    await database.close();
  }
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
  const existing = await loadCollaborationState(input.documentId);
  if (existing) {
    if (
      existing.status !== 'active'
      || existing.workspaceId !== input.workspaceId
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
        ON CONFLICT(document_id) DO UPDATE SET
          path = excluded.path,
          workspace_id = excluded.workspace_id,
          organization_id = excluded.organization_id
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
    if (!row) throw new Error('Failed to initialize collaboration state.');
    const state = mapState(row);
    if (
      state.status !== 'active'
      || state.workspaceId !== input.workspaceId
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
        WHERE document_id = ? AND status = 'active'
        RETURNING *
      `,
      [Buffer.from(update), Buffer.from(vector), now, documentId],
    ) as StateRow | undefined;
    if (!row) {
      const existing = await database.get(
        'SELECT status FROM collaboration_yjs_states WHERE document_id = ? LIMIT 1',
        [documentId],
      ) as { status?: string } | undefined;
      if (existing?.status === 'archived') throw new CollaborationStateInactiveError(documentId);
      throw new Error('Collaboration state does not exist.');
    }
    return mapState(row);
  } finally {
    await database.close();
  }
}

export async function markCollaborationCheckpoint(input: {
  documentId: string;
  sequence: number;
  canonicalContent: string;
  serializedContent: string;
  degraded?: boolean;
}): Promise<void> {
  assertPostgres();
  const database = await openDb();
  try {
    await database.run(
      `
        UPDATE collaboration_yjs_states
        SET checkpointed_at = ?, checkpoint_sequence = ?, canonical_hash = ?, serialized_hash = ?, degraded = ?
        WHERE document_id = ? AND document_sequence = ?
      `,
      [
        Date.now(),
        input.sequence,
        sha256Text(input.canonicalContent),
        sha256Text(input.serializedContent),
        input.degraded ? 1 : 0,
        input.documentId,
        input.sequence,
      ],
    );
  } finally {
    await database.close();
  }
}

export async function markCollaborationDegraded(documentId: string): Promise<void> {
  if (getDatabaseProvider() !== 'postgres') return;
  const database = await openDb();
  try {
    await database.run('UPDATE collaboration_yjs_states SET degraded = 1 WHERE document_id = ?', [documentId]);
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
export async function compactCollaborationState(input: {
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

/** Quiescent server-side representation migration; never a local editor toggle. */
export async function changeCollaborationRepresentation(input: {
  documentId: string;
  expectedLifecycleGeneration: number;
  representation: TextCollaborationRepresentation;
  schemaVersion: number;
}): Promise<PersistedCollaborationState> {
  assertPostgres();
  if (getCollaborationRoomConnectionCount(input.documentId) > 0) {
    throw new Error('Collaboration representation can only change while the document room is empty.');
  }
  const state = await loadCollaborationState(input.documentId);
  if (!state || state.lifecycleGeneration !== input.expectedLifecycleGeneration) {
    throw new Error('Collaboration lifecycle changed before representation migration.');
  }
  if (state.degraded || state.checkpointSequence < state.documentSequence) {
    throw new Error('A healthy confirmed checkpoint is required before representation migration.');
  }
  const canonicalContent = canonicalContentFromState(state);
  const fresh = createValidatedFreshDocument(input.representation, canonicalContent);
  const update = Y.encodeStateAsUpdate(fresh);
  const vector = Y.encodeStateVector(fresh);
  const now = Date.now();
  const nextSequence = state.documentSequence + 1;
  const database = await openDb();
  try {
    await database.run('BEGIN');
    const applying = await database.get(
      `SELECT COUNT(*) AS count FROM collaboration_agent_operations
       WHERE document_id = ? AND status IN ('applying', 'applied_to_ydoc', 'persisted_yjs')`,
      [state.documentId],
    ) as { count?: number | string } | undefined;
    if (Number(applying?.count || 0) > 0) {
      throw new Error('Representation migration cannot race with an authoritative agent apply.');
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
        nextSequence,
        now,
        now,
        sha256Text(canonicalContent),
        now,
        state.documentId,
        state.lifecycleGeneration,
      ],
    ) as StateRow | undefined;
    if (!row) throw new Error('Collaboration state changed concurrently during representation migration.');
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
