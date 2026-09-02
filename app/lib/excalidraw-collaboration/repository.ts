import 'server-only';

import crypto from 'node:crypto';

import { getDatabaseProvider, openDb } from '@/app/lib/db';
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
  validateExcalidrawSceneReferences,
} from './scene';
import type {
  ExcalidrawAssetMetadata,
  ExcalidrawElementRecord,
  ExcalidrawSharedAppState,
} from './protocol';

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

function assertPostgres(): void {
  if (getDatabaseProvider() !== 'postgres') throw new Error('Excalidraw collaboration requires Postgres.');
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
  if (Buffer.byteLength(content, 'utf8') > 10 * 1024 * 1024) throw new Error('Excalidraw collaboration supports portable files up to 10 MiB.');
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
  assertPostgres();
  const database = await openDb();
  try {
    const row = await database.get(
      `SELECT * FROM collaboration_excalidraw_states
       WHERE document_id = ? ${includeArchived ? '' : "AND status = 'active'"} LIMIT 1`,
      [documentId],
    ) as StateRow | undefined;
    return row ? mapState(row) : null;
  } finally {
    await database.close();
  }
}

export async function ensureExcalidrawScene(input: {
  documentId: string;
  workspaceId: string;
  organizationId: string | null;
  path: string;
  initialContent: string;
  initialAssets?: ExcalidrawAssetMetadata[];
}): Promise<PersistedExcalidrawScene> {
  assertPostgres();
  const existing = await loadExcalidrawScene(input.documentId);
  if (existing) {
    if (existing.workspaceId !== input.workspaceId || existing.path !== input.path || existing.status !== 'active') {
      throw new Error('Excalidraw collaboration identity or lifecycle is stale.');
    }
    return existing;
  }
  const scene = initialScene(input.initialContent);
  const assets = input.initialAssets ?? [];
  const canonicalHash = canonicalSceneHash({ ...scene, assets });
  const now = Date.now();
  const database = await openDb();
  try {
    const row = await database.get(
      `INSERT INTO collaboration_excalidraw_states (
         document_id, workspace_id, organization_id, path, lifecycle_generation,
         excalidraw_version, scene_schema_version, elements_json, shared_app_state_json,
         assets_json, scene_sequence, checkpoint_sequence, canonical_hash, persisted_at, checkpointed_at
       ) VALUES (?, ?, ?, ?, 1, ?, 1, CAST(? AS jsonb), CAST(? AS jsonb), CAST(? AS jsonb), 0, 0, ?, ?, ?)
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

export async function applyExcalidrawScenePatch(input: {
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
}): Promise<AppliedExcalidrawPatch> {
  assertPostgres();
  const patch = validateExcalidrawElements(input.elements, 'patch');
  const requestedAppState = sharedExcalidrawAppState(input.appState);
  const database = await openDb();
  try {
    await database.run('BEGIN');
    await database.run('SELECT pg_advisory_xact_lock(hashtext(?))', [`excalidraw:${input.documentId}`]);
    const previousOperation = await database.get(
      'SELECT result_json FROM collaboration_excalidraw_operations WHERE document_id = ? AND message_id = ? LIMIT 1',
      [input.documentId, input.messageId],
    ) as { result_json?: JsonValue } | undefined;
    const duplicate = previousOperation?.result_json ? operationResult(previousOperation.result_json) : null;
    if (duplicate) {
      await database.run('COMMIT');
      return duplicate;
    }
    const row = await database.get(
      "SELECT * FROM collaboration_excalidraw_states WHERE document_id = ? AND status = 'active' FOR UPDATE",
      [input.documentId],
    ) as StateRow | undefined;
    if (!row) throw new Error('Excalidraw collaboration scene is unavailable.');
    const current = mapState(row);
    if (current.lifecycleGeneration !== input.lifecycleGeneration) {
      throw new ExcalidrawSceneResyncError(current.sceneSequence, 'The Excalidraw file lifecycle changed.');
    }
    if (input.baseSequence > current.sceneSequence || current.sceneSequence - input.baseSequence > MAX_SEQUENCE_LAG) {
      throw new ExcalidrawSceneResyncError(current.sceneSequence, 'The Excalidraw scene sequence is too far behind.');
    }
    const merged = mergeExcalidrawElements(current.elements, patch);
    validateExcalidrawSceneReferences(merged.elements);
    const nextAppState = { ...current.appState, ...requestedAppState };
    const appStateChanged = JSON.stringify(nextAppState) !== JSON.stringify(current.appState);
    const nextAssets = input.assets ?? current.assets;
    const changed = merged.accepted.length > 0 || appStateChanged || JSON.stringify(nextAssets) !== JSON.stringify(current.assets);
    const nextSequence = changed ? current.sceneSequence + 1 : current.sceneSequence;
    const canonicalHash = canonicalSceneHash({ elements: merged.elements, appState: nextAppState, assets: nextAssets });
    const now = Date.now();
    let state = current;
    if (changed) {
      const updated = await database.get(
        `UPDATE collaboration_excalidraw_states
         SET elements_json = CAST(? AS jsonb), shared_app_state_json = CAST(? AS jsonb),
             assets_json = CAST(? AS jsonb), scene_sequence = ?, canonical_hash = ?,
             persisted_at = ?, degraded_reason = NULL
         WHERE document_id = ? AND lifecycle_generation = ? AND scene_sequence = ? AND status = 'active'
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
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS jsonb), CAST(? AS jsonb), ?, CAST(? AS jsonb), ?)`,
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
    await database.run('COMMIT');
    return result;
  } catch (error) {
    try { await database.run('ROLLBACK'); } catch {}
    throw error;
  } finally {
    await database.close();
  }
}

export async function markExcalidrawCheckpoint(input: {
  documentId: string;
  sceneSequence: number;
  revisionId: string;
}): Promise<void> {
  assertPostgres();
  const database = await openDb();
  try {
    await database.run(
      `UPDATE collaboration_excalidraw_states
       SET checkpoint_sequence = ?, checkpoint_revision_id = ?, checkpointed_at = ?, degraded_reason = NULL
       WHERE document_id = ? AND scene_sequence = ? AND status = 'active'`,
      [input.sceneSequence, input.revisionId, Date.now(), input.documentId, input.sceneSequence],
    );
  } finally {
    await database.close();
  }
}

export async function markExcalidrawSceneDegraded(documentId: string, reason: string): Promise<void> {
  if (getDatabaseProvider() !== 'postgres') return;
  const database = await openDb();
  try {
    await database.run(
      'UPDATE collaboration_excalidraw_states SET degraded_reason = ? WHERE document_id = ?',
      [reason.slice(0, 500), documentId],
    );
  } finally {
    await database.close();
  }
}

export async function moveExcalidrawScenePaths(input: { workspaceId: string; oldPath: string; newPath: string }): Promise<void> {
  if (getDatabaseProvider() !== 'postgres') return;
  await withFileCollaborationTransaction(async (transaction) => {
    await lockFileCollaborationPaths(transaction, input.workspaceId, [input.oldPath, input.newPath]);
    await moveExcalidrawCollaborationStatePathScope(transaction, input);
  });
}

export async function archiveExcalidrawScenePaths(input: { workspaceId: string; paths: string[] }): Promise<void> {
  if (getDatabaseProvider() !== 'postgres' || input.paths.length === 0) return;
  const database = await openDb();
  try {
    await database.run('BEGIN');
    for (const path of input.paths) {
      await database.run(
        `UPDATE collaboration_excalidraw_states
         SET status = 'archived', lifecycle_generation = lifecycle_generation + 1
         WHERE workspace_id = ?
           AND status = 'active'
           AND (path = ? OR left(path, char_length(?) + 1) = ? || '/')`,
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
  if (getDatabaseProvider() !== 'postgres') return;
  const database = await openDb();
  try {
    await database.run(
      `UPDATE collaboration_excalidraw_states
       SET status = 'active', lifecycle_generation = lifecycle_generation + 1, degraded_reason = NULL
       WHERE workspace_id = ? AND path = ? AND status = 'archived'`,
      [input.workspaceId, input.path],
    );
  } finally {
    await database.close();
  }
}
