import 'server-only';

import crypto from 'node:crypto';

import { openDb, type SqlConnection } from '@/app/lib/db';
import {
  lockFileCollaborationPaths,
  moveExcalidrawCollaborationStatePathScope,
  withFileCollaborationTransaction,
} from '@/app/lib/files/collaboration-repository';
import {
  canonicalSceneHash,
  mergeExcalidrawElements,
  sharedExcalidrawAppState,
  validateExcalidrawElements,
  validateExcalidrawSceneAssetReferences,
  validateExcalidrawSceneReferences,
} from './scene';
import type {
  ExcalidrawAssetMetadata,
  ExcalidrawElementRecord,
  ExcalidrawSharedAppState,
} from './protocol';
import { EXCALIDRAW_PORTABLE_MAX_BYTES } from './limits';

export { EXCALIDRAW_PORTABLE_MAX_BYTES } from './limits';

const EXCALIDRAW_VERSION = '0.18.1';
const MAX_SEQUENCE_LAG = 2_000;

type JsonValue = string | Record<string, unknown> | unknown[] | null;

type StateRow = {
  document_id: string;
  workspace_id: string;
  organization_id: string | null;
  path: string;
  lifecycle_generation: number;
  excalidraw_version: string;
  scene_schema_version: number;
  elements_json: JsonValue;
  shared_app_state_json: JsonValue;
  assets_json: JsonValue;
  scene_sequence: number;
  checkpoint_sequence: number;
  checkpoint_revision_id: string | null;
  checkpoint_content_hash: string | null;
  canonical_hash: string;
  persisted_at: number;
  checkpointed_at: number | null;
  degraded_reason: string | null;
  status: 'active' | 'archived';
};

export type PersistedExcalidrawScene = {
  documentId: string;
  workspaceId: string;
  organizationId: string | null;
  path: string;
  lifecycleGeneration: number;
  excalidrawVersion: string;
  sceneSchemaVersion: number;
  elements: ExcalidrawElementRecord[];
  appState: ExcalidrawSharedAppState;
  assets: ExcalidrawAssetMetadata[];
  sceneSequence: number;
  checkpointSequence: number;
  checkpointRevisionId: string | null;
  checkpointContentHash: string | null;
  canonicalHash: string;
  persistedAt: number;
  checkpointedAt: number | null;
  degradedReason: string | null;
  status: 'active' | 'archived';
};

export type AppliedExcalidrawPatch = {
  state: PersistedExcalidrawScene;
  acceptedElements: ExcalidrawElementRecord[];
  acceptedAppState: ExcalidrawSharedAppState;
  duplicate: boolean;
};

export class ExcalidrawSceneResyncError extends Error {
  readonly code = 'EXCALIDRAW_RESYNC_REQUIRED';

  constructor(readonly currentSequence: number, message: string) {
    super(message);
    this.name = 'ExcalidrawSceneResyncError';
  }
}

function json<T>(value: JsonValue, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function mapState(row: StateRow): PersistedExcalidrawScene {
  return {
    documentId: row.document_id,
    workspaceId: row.workspace_id,
    organizationId: row.organization_id,
    path: row.path,
    lifecycleGeneration: Number(row.lifecycle_generation),
    excalidrawVersion: row.excalidraw_version,
    sceneSchemaVersion: Number(row.scene_schema_version),
    elements: validateExcalidrawElements(json(row.elements_json, []), 'scene'),
    appState: sharedExcalidrawAppState(json(row.shared_app_state_json, {})),
    assets: json<ExcalidrawAssetMetadata[]>(row.assets_json, []),
    sceneSequence: Number(row.scene_sequence),
    checkpointSequence: Number(row.checkpoint_sequence),
    checkpointRevisionId: row.checkpoint_revision_id,
    checkpointContentHash: row.checkpoint_content_hash ?? null,
    canonicalHash: row.canonical_hash,
    persistedAt: Number(row.persisted_at),
    checkpointedAt: row.checkpointed_at === null ? null : Number(row.checkpointed_at),
    degradedReason: row.degraded_reason,
    status: row.status === 'archived' ? 'archived' : 'active',
  };
}

function initialScene(content: string): {
  elements: ExcalidrawElementRecord[];
  appState: ExcalidrawSharedAppState;
} {
  if (Buffer.byteLength(content, 'utf8') > EXCALIDRAW_PORTABLE_MAX_BYTES) {
    throw Object.assign(new Error('Excalidraw collaboration supports portable files up to 50 MiB.'), {
      code: 'EXCALIDRAW_SCENE_TOO_LARGE', status: 413,
    });
  }
  if (!content.trim()) return { elements: [], appState: { viewBackgroundColor: '#ffffff' } };
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error('The Excalidraw file is not valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The Excalidraw file has an invalid root object.');
  const record = parsed as Record<string, unknown>;
  return {
    elements: validateExcalidrawElements(record.elements ?? [], 'scene'),
    appState: sharedExcalidrawAppState(record.appState),
  };
}

export async function loadExcalidrawScene(documentId: string, includeArchived = false): Promise<PersistedExcalidrawScene | null> {
  const database = await openDb();
  try {
    return await loadExcalidrawSceneInTransaction(database, documentId, includeArchived);
  } finally {
    await database.close();
  }
}

/** Owns the scene advisory lock; callbacks may atomically change scene and domain metadata. */
export async function withExcalidrawSceneTransaction<T>(
  documentId: string,
  callback: (transaction: SqlConnection) => Promise<T>,
): Promise<T> {
  return withFileCollaborationTransaction(async (transaction) => {
    await transaction.run('SELECT pg_advisory_xact_lock(hashtext($1))', [`excalidraw:${documentId}`]);
    return callback(transaction);
  });
}

export async function loadExcalidrawSceneInTransaction(
  transaction: SqlConnection,
  documentId: string,
  includeArchived = false,
  lock = false,
): Promise<PersistedExcalidrawScene | null> {
  const row = await transaction.get(
    `SELECT * FROM collaboration_excalidraw_states
     WHERE document_id = $1 ${includeArchived ? '' : "AND status = 'active'"} LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
    [documentId],
  ) as StateRow | undefined;
  return row ? mapState(row) : null;
}

export async function ensureExcalidrawScene(input: {
  documentId: string;
  workspaceId: string;
  organizationId: string | null;
  path: string;
  initialContent: string;
  initialAssets?: ExcalidrawAssetMetadata[];
}): Promise<PersistedExcalidrawScene> {
  const existing = await loadExcalidrawScene(input.documentId);
  if (existing) {
    if (existing.workspaceId !== input.workspaceId || existing.path !== input.path || existing.status !== 'active') {
      throw new Error('Excalidraw collaboration identity or lifecycle is stale.');
    }
    return existing;
  }
  const scene = initialScene(input.initialContent);
  validateExcalidrawSceneReferences(scene.elements);
  const assets = input.initialAssets ?? [];
  validateExcalidrawSceneAssetReferences(scene.elements, assets);
  const canonicalHash = canonicalSceneHash({ ...scene, assets });
  const now = Date.now();
  const database = await openDb();
  try {
    const row = await database.get(
      `INSERT INTO collaboration_excalidraw_states (
         document_id, workspace_id, organization_id, path, lifecycle_generation,
         excalidraw_version, scene_schema_version, elements_json, shared_app_state_json,
         assets_json, scene_sequence, checkpoint_sequence, canonical_hash, persisted_at, checkpointed_at,
         checkpoint_content_hash
       ) VALUES ($1, $2, $3, $4, 1, $5, 1, CAST($6 AS jsonb), CAST($7 AS jsonb), CAST($8 AS jsonb), 0, 0, $9, $10, $11, $12)
       ON CONFLICT(document_id) DO NOTHING
       RETURNING *`,
      [
        input.documentId,
        input.workspaceId,
        input.organizationId,
        input.path,
        EXCALIDRAW_VERSION,
        JSON.stringify(scene.elements),
        JSON.stringify(scene.appState),
        JSON.stringify(assets),
        canonicalHash,
        now,
        now,
        crypto.createHash('sha256').update(input.initialContent).digest('hex'),
      ],
    ) as StateRow | undefined;
    const state = row ? mapState(row) : await loadExcalidrawScene(input.documentId);
    if (!state || state.workspaceId !== input.workspaceId || state.path !== input.path) {
      throw new Error('Failed to initialize Excalidraw collaboration scene.');
    }
    return state;
  } finally {
    await database.close();
  }
}

function operationResult(value: JsonValue): AppliedExcalidrawPatch | null {
  const parsed = json<AppliedExcalidrawPatch | null>(value, null);
  if (!parsed?.state) return null;
  return {
    ...parsed,
    state: {
      ...parsed.state,
      elements: validateExcalidrawElements(parsed.state.elements, 'scene'),
      appState: sharedExcalidrawAppState(parsed.state.appState),
    },
    duplicate: true,
  };
}

export type ExcalidrawScenePatchInput = {
  documentId: string;
  lifecycleGeneration: number;
  baseSequence: number;
  messageId: string;
  elements: unknown;
  appState?: unknown;
  assets?: ExcalidrawAssetMetadata[];
  actorType: 'user' | 'agent' | 'system';
  actorId: string | null;
  initiatedByUserId?: string | null;
  operationId?: string;
};

export async function getExcalidrawScenePatchResultInTransaction(
  transaction: SqlConnection,
  documentId: string,
  messageId: string,
): Promise<AppliedExcalidrawPatch | null> {
  const row = await transaction.get(
    'SELECT result_json FROM collaboration_excalidraw_operations WHERE document_id = $1 AND message_id = $2 LIMIT 1',
    [documentId, messageId],
  ) as { result_json?: JsonValue } | undefined;
  return row?.result_json ? operationResult(row.result_json) : null;
}

export async function applyExcalidrawScenePatch(input: ExcalidrawScenePatchInput): Promise<AppliedExcalidrawPatch> {
  return withExcalidrawSceneTransaction(input.documentId, (transaction) => applyExcalidrawScenePatchInTransaction(transaction, input));
}

/** Caller must hold the scene advisory lock in an open transaction. Never commits independently. */
export async function applyExcalidrawScenePatchInTransaction(
  database: SqlConnection,
  input: ExcalidrawScenePatchInput,
): Promise<AppliedExcalidrawPatch> {
  const patch = validateExcalidrawElements(input.elements, 'patch');
  const requestedAppState = sharedExcalidrawAppState(input.appState);
  const previousOperation = await database.get(
    'SELECT result_json FROM collaboration_excalidraw_operations WHERE document_id = $1 AND message_id = $2 LIMIT 1',
    [input.documentId, input.messageId],
  ) as { result_json?: JsonValue } | undefined;
  const duplicate = previousOperation?.result_json ? operationResult(previousOperation.result_json) : null;
  const row = await database.get(
    "SELECT * FROM collaboration_excalidraw_states WHERE document_id = $1 AND status = 'active' FOR UPDATE",
    [input.documentId],
  ) as StateRow | undefined;
  if (!row) throw new Error('Excalidraw collaboration scene is unavailable.');
  const current = mapState(row);
  if (current.lifecycleGeneration !== input.lifecycleGeneration) {
    throw new ExcalidrawSceneResyncError(current.sceneSequence, 'The Excalidraw file lifecycle changed.');
  }
  if (duplicate) {
    if (duplicate.state.lifecycleGeneration !== current.lifecycleGeneration) {
      throw new ExcalidrawSceneResyncError(current.sceneSequence, 'The Excalidraw retry belongs to an earlier file lifecycle.');
    }
    return duplicate;
  }
  if (input.baseSequence > current.sceneSequence || current.sceneSequence - input.baseSequence > MAX_SEQUENCE_LAG) {
    throw new ExcalidrawSceneResyncError(current.sceneSequence, 'The Excalidraw scene sequence is too far behind.');
  }
  const merged = mergeExcalidrawElements(current.elements, patch);
  validateExcalidrawSceneReferences(merged.elements);
  const nextAppState = { ...current.appState, ...requestedAppState };
  const appStateChanged = JSON.stringify(nextAppState) !== JSON.stringify(current.appState);
  const nextAssets = input.assets ?? current.assets;
  validateExcalidrawSceneAssetReferences(merged.elements, nextAssets);
  const changed = merged.accepted.length > 0 || appStateChanged || JSON.stringify(nextAssets) !== JSON.stringify(current.assets);
  const nextSequence = changed ? current.sceneSequence + 1 : current.sceneSequence;
  const canonicalHash = canonicalSceneHash({ elements: merged.elements, appState: nextAppState, assets: nextAssets });
  const now = Date.now();
  let state = current;
  if (changed) {
    const updated = await database.get(
      `UPDATE collaboration_excalidraw_states
       SET elements_json = CAST($1 AS jsonb), shared_app_state_json = CAST($2 AS jsonb),
           assets_json = CAST($3 AS jsonb), scene_sequence = $4, canonical_hash = $5,
           persisted_at = $6, degraded_reason = NULL
       WHERE document_id = $7 AND lifecycle_generation = $8 AND scene_sequence = $9 AND status = 'active'
       RETURNING *`,
      [
        JSON.stringify(merged.elements),
        JSON.stringify(nextAppState),
        JSON.stringify(nextAssets),
        nextSequence,
        canonicalHash,
        now,
        input.documentId,
        input.lifecycleGeneration,
        current.sceneSequence,
      ],
    ) as StateRow | undefined;
    if (!updated) throw new ExcalidrawSceneResyncError(current.sceneSequence, 'The Excalidraw scene changed during apply.');
    state = mapState(updated);
  }
  const responseElements = [...new Set(patch.map((element) => element.id))]
    .map((id) => state.elements.find((element) => element.id === id))
    .filter((element): element is ExcalidrawElementRecord => Boolean(element));
  const result: AppliedExcalidrawPatch = {
    state,
    acceptedElements: responseElements,
    acceptedAppState: appStateChanged ? requestedAppState : {},
    duplicate: false,
  };
  const deltaHash = crypto.createHash('sha256').update(JSON.stringify({ elements: responseElements, appState: result.acceptedAppState })).digest('hex');
  await database.run(
    `INSERT INTO collaboration_excalidraw_operations (
       document_id, message_id, lifecycle_generation, base_sequence, applied_sequence,
       actor_type, actor_id, initiated_by_user_id, accepted_delta_json,
       accepted_app_state_json, accepted_delta_hash, result_json, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CAST($9 AS jsonb), CAST($10 AS jsonb), $11, CAST($12 AS jsonb), $13)`,
    [
      input.documentId,
      input.messageId,
      input.lifecycleGeneration,
      input.baseSequence,
      state.sceneSequence,
      input.actorType,
      input.actorId,
      input.initiatedByUserId ?? null,
      JSON.stringify(responseElements),
      JSON.stringify(result.acceptedAppState),
      deltaHash,
      JSON.stringify(result),
      now,
    ],
  );
  if (changed) {
    await database.run('SELECT pg_notify($1, $2)', [
      'canvas_excalidraw_scene',
      JSON.stringify({ documentId: input.documentId, sceneSequence: state.sceneSequence, ...(input.operationId ? { operationId: input.operationId } : {}) }),
    ]);
  }
  return result;
}

export async function markExcalidrawCheckpoint(input: {
  documentId: string;
  sceneSequence: number;
  revisionId: string;
}): Promise<void> {
  const database = await openDb();
  try {
    await database.run(
      `UPDATE collaboration_excalidraw_states
       SET checkpoint_sequence = $1, checkpoint_revision_id = $2, checkpointed_at = $3, degraded_reason = NULL
       WHERE document_id = $4 AND scene_sequence = $5 AND status = 'active'`,
      [input.sceneSequence, input.revisionId, Date.now(), input.documentId, input.sceneSequence],
    );
  } finally {
    await database.close();
  }
}

export async function markExcalidrawSceneDegraded(documentId: string, reason: string): Promise<void> {
  const database = await openDb();
  try {
    await database.run(
      'UPDATE collaboration_excalidraw_states SET degraded_reason = $1 WHERE document_id = $2',
      [reason.slice(0, 500), documentId],
    );
  } finally {
    await database.close();
  }
}

export async function moveExcalidrawScenePaths(input: { workspaceId: string; oldPath: string; newPath: string }): Promise<void> {
  await withFileCollaborationTransaction(async (transaction) => {
    await lockFileCollaborationPaths(transaction, input.workspaceId, [input.oldPath, input.newPath]);
    await moveExcalidrawCollaborationStatePathScope(transaction, input);
  });
}

export async function archiveExcalidrawScenePaths(input: { workspaceId: string; paths: string[] }): Promise<void> {
  if (input.paths.length === 0) return;
  const database = await openDb();
  try {
    await database.run('BEGIN');
    for (const path of input.paths) {
      await database.run(
        `UPDATE collaboration_excalidraw_states
         SET status = 'archived', lifecycle_generation = lifecycle_generation + 1
         WHERE workspace_id = $1
           AND status = 'active'
           AND (path = $2 OR left(path, char_length($3) + 1) = $4 || '/')`,
        [input.workspaceId, path, path, path],
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

export async function reactivateExcalidrawScenePath(input: { workspaceId: string; path: string }): Promise<void> {
  const database = await openDb();
  try {
    await database.run(
      `UPDATE collaboration_excalidraw_states
       SET status = 'active', lifecycle_generation = lifecycle_generation + 1, degraded_reason = NULL
       WHERE workspace_id = $1 AND path = $2 AND status = 'archived'`,
      [input.workspaceId, input.path],
    );
  } finally {
    await database.close();
  }
}
