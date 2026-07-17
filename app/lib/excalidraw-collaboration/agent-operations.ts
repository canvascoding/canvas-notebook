import 'server-only';

import crypto from 'node:crypto';

import { collaborationUserColors } from '@/app/lib/collaboration/identity';
import { removeDocumentPresenceEntry, upsertDocumentPresenceEntry } from '@/app/lib/collaboration/presence';
import { getDatabaseProvider, openDb } from '@/app/lib/db';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { ExcalidrawElementRecord } from './protocol';
import { validateExcalidrawElement } from './scene';
import {
  applyExcalidrawScenePatch,
  loadExcalidrawScene,
  type AppliedExcalidrawPatch,
  type PersistedExcalidrawScene,
} from './repository';
import { getExcalidrawConnectionCount, publishExcalidrawAgentPatch } from './runtime';

export type ExcalidrawAgentSceneAction =
  | { type: 'create'; element: ExcalidrawElementRecord }
  | {
      type: 'update';
      elementId: string;
      expectedVersion: number;
      expectedVersionNonce: number;
      element: ExcalidrawElementRecord;
    }
  | {
      type: 'delete';
      elementId: string;
      expectedVersion: number;
      expectedVersionNonce: number;
    };

export type ExcalidrawAgentOperationStatus = 'preparing' | 'needs_review' | 'applied' | 'rejected' | 'cancelled' | 'failed';

export type ExcalidrawAgentOperation = {
  operationId: string;
  documentId: string;
  workspaceId: string;
  lifecycleGeneration: number;
  observedSceneSequence: number;
  initiatedByUserId: string;
  actorId: string;
  idempotencyKey: string;
  status: ExcalidrawAgentOperationStatus;
  actions: ExcalidrawAgentSceneAction[];
  result: Record<string, unknown> | null;
  reviewReason: string | null;
  casVersion: number;
  createdAt: number;
  updatedAt: number;
};

type OperationRow = {
  operation_id: string;
  document_id: string;
  workspace_id: string;
  lifecycle_generation: number;
  observed_scene_sequence: number;
  initiated_by_user_id: string;
  actor_id: string;
  idempotency_key: string;
  status: ExcalidrawAgentOperationStatus;
  patch_json: string | ExcalidrawAgentSceneAction[];
  result_json: string | Record<string, unknown> | null;
  review_reason: string | null;
  cas_version: number;
  created_at: number;
  updated_at: number;
};

type TargetFingerprint = { version: number; versionNonce: number; isDeleted: boolean } | null;

function parseJson<T>(value: string | T | null, fallback: T): T {
  if (value === null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function mapOperation(row: OperationRow): ExcalidrawAgentOperation {
  return {
    operationId: row.operation_id,
    documentId: row.document_id,
    workspaceId: row.workspace_id,
    lifecycleGeneration: Number(row.lifecycle_generation),
    observedSceneSequence: Number(row.observed_scene_sequence),
    initiatedByUserId: row.initiated_by_user_id,
    actorId: row.actor_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    actions: parseJson(row.patch_json, []),
    result: parseJson(row.result_json, null),
    reviewReason: row.review_reason,
    casVersion: Number(row.cas_version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function fingerprint(element: ExcalidrawElementRecord | undefined): TargetFingerprint {
  return element ? {
    version: element.version,
    versionNonce: element.versionNonce,
    isDeleted: element.isDeleted,
  } : null;
}

function sameFingerprint(left: TargetFingerprint, right: TargetFingerprint): boolean {
  return left === null || right === null
    ? left === right
    : left.version === right.version && left.versionNonce === right.versionNonce && left.isDeleted === right.isDeleted;
}

function targetId(action: ExcalidrawAgentSceneAction): string {
  return action.type === 'create' ? action.element.id : action.elementId;
}

function nextNonce(): number {
  return crypto.randomInt(1, 0x7fffffff);
}

function preparePatch(input: {
  state: PersistedExcalidrawScene;
  actions: ExcalidrawAgentSceneAction[];
  reviewTargets?: Record<string, TargetFingerprint>;
}): {
  elements: ExcalidrawElementRecord[];
  conflicts: string[];
  currentTargets: Record<string, TargetFingerprint>;
} {
  if (!input.actions.length || input.actions.length > 500) throw new Error('Excalidraw agent patch requires 1 to 500 actions.');
  const currentById = new Map(input.state.elements.map((element) => [element.id, element]));
  const seen = new Set<string>();
  const elements: ExcalidrawElementRecord[] = [];
  const conflicts: string[] = [];
  const currentTargets: Record<string, TargetFingerprint> = {};
  for (const action of input.actions) {
    const id = targetId(action);
    if (seen.has(id)) throw new Error(`Excalidraw agent patch targets element ${id} more than once.`);
    seen.add(id);
    const current = currentById.get(id);
    currentTargets[id] = fingerprint(current);
    const reviewTarget = input.reviewTargets?.[id];
    if (input.reviewTargets && !sameFingerprint(reviewTarget ?? null, currentTargets[id])) {
      conflicts.push(`${id}: changed again after review was created`);
      continue;
    }
    if (action.type === 'create') {
      if (current && !current.isDeleted) {
        conflicts.push(`${id}: element id already exists`);
        continue;
      }
      const proposed = validateExcalidrawElement(action.element);
      elements.push({ ...proposed, version: Math.max(1, (current?.version ?? 0) + 1), versionNonce: nextNonce(), isDeleted: false });
      continue;
    }
    if (!current) {
      conflicts.push(`${id}: target element no longer exists`);
      continue;
    }
    if (!input.reviewTargets && (
      current.version !== action.expectedVersion
      || current.versionNonce !== action.expectedVersionNonce
    )) {
      conflicts.push(`${id}: user changed the target element`);
      continue;
    }
    if (action.type === 'update') {
      const proposed = validateExcalidrawElement(action.element);
      if (proposed.id !== id) throw new Error(`Excalidraw update id ${proposed.id} does not match target ${id}.`);
      elements.push({ ...proposed, version: current.version + 1, versionNonce: nextNonce(), isDeleted: false });
    } else {
      elements.push({ ...current, version: current.version + 1, versionNonce: nextNonce(), isDeleted: true });
    }
  }
  return { elements, conflicts, currentTargets };
}

async function loadOperation(operationId: string): Promise<ExcalidrawAgentOperation | null> {
  if (getDatabaseProvider() !== 'postgres') return null;
  const database = await openDb();
  try {
    const row = await database.get(
      'SELECT * FROM collaboration_excalidraw_agent_operations WHERE operation_id = ? LIMIT 1',
      [operationId],
    ) as OperationRow | undefined;
    return row ? mapOperation(row) : null;
  } finally {
    await database.close();
  }
}

export async function getExcalidrawAgentOperation(input: {
  operationId: string;
  workspace: WorkspaceContext;
  userId: string;
}): Promise<ExcalidrawAgentOperation | null> {
  const operation = await loadOperation(input.operationId);
  if (!operation || operation.workspaceId !== input.workspace.workspaceId) return null;
  if (operation.initiatedByUserId !== input.userId && !input.workspace.permissions.canManageWorkspace) return null;
  return operation;
}

async function updateOperation(input: {
  operationId: string;
  expectedStatuses: ExcalidrawAgentOperationStatus[];
  status: ExcalidrawAgentOperationStatus;
  result?: Record<string, unknown> | null;
  reviewReason?: string | null;
}): Promise<ExcalidrawAgentOperation> {
  const database = await openDb();
  try {
    const placeholders = input.expectedStatuses.map(() => '?').join(', ');
    const row = await database.get(
      `UPDATE collaboration_excalidraw_agent_operations
       SET status = ?, result_json = CAST(? AS jsonb), review_reason = ?,
           cas_version = cas_version + 1, updated_at = ?
       WHERE operation_id = ? AND status IN (${placeholders})
       RETURNING *`,
      [
        input.status,
        JSON.stringify(input.result ?? null),
        input.reviewReason ?? null,
        Date.now(),
        input.operationId,
        ...input.expectedStatuses,
      ],
    ) as OperationRow | undefined;
    if (!row) {
      const existingRow = await database.get(
        'SELECT * FROM collaboration_excalidraw_agent_operations WHERE operation_id = ? LIMIT 1',
        [input.operationId],
      ) as OperationRow | undefined;
      const existing = existingRow ? mapOperation(existingRow) : null;
      if (existing && existing.status === input.status) return existing;
      throw new Error('Excalidraw agent operation changed concurrently.');
    }
    return mapOperation(row);
  } finally {
    await database.close();
  }
}

function presence(input: {
  operationId: string;
  state: PersistedExcalidrawScene;
  initiatedByUserId: string;
  actorId: string;
}) {
  const colors = collaborationUserColors(input.actorId);
  upsertDocumentPresenceEntry({
    workspaceId: input.state.workspaceId,
    documentId: input.state.documentId,
    path: input.state.path,
    userId: input.actorId,
    sessionId: input.operationId,
    actorType: 'agent',
    initiatedByUserId: input.initiatedByUserId,
    displayName: `KI-Agent ${input.actorId}`.slice(0, 120),
    ...colors,
    activity: 'agent_editing',
    updatedAt: Date.now(),
  });
  return () => removeDocumentPresenceEntry({
    workspaceId: input.state.workspaceId,
    documentId: input.state.documentId,
    userId: input.actorId,
    actorType: 'agent',
  });
}

async function applyPreparedAgentPatch(
  operation: ExcalidrawAgentOperation,
  state: PersistedExcalidrawScene,
  elements: ExcalidrawElementRecord[],
  messageSuffix: string,
): Promise<AppliedExcalidrawPatch> {
  const applied = await applyExcalidrawScenePatch({
    documentId: operation.documentId,
    lifecycleGeneration: operation.lifecycleGeneration,
    baseSequence: state.sceneSequence,
    messageId: `${operation.operationId}:${messageSuffix}:${operation.casVersion}`,
    elements,
    actorType: 'agent',
    actorId: operation.actorId,
    initiatedByUserId: operation.initiatedByUserId,
  });
  publishExcalidrawAgentPatch(operation.documentId, operation.operationId, applied, {
    actorId: operation.actorId,
    initiatedByUserId: operation.initiatedByUserId,
  });
  return applied;
}

export async function createExcalidrawAgentOperation(input: {
  workspace: WorkspaceContext;
  documentId: string;
  observedSceneSequence: number;
  actions: ExcalidrawAgentSceneAction[];
  initiatedByUserId: string;
  actorId: string;
  idempotencyKey: string;
}): Promise<ExcalidrawAgentOperation> {
  if (getDatabaseProvider() !== 'postgres') throw new Error('Excalidraw agent operations require Postgres.');
  if (!input.workspace.permissions.canWrite) throw new Error('Workspace write access is required for Excalidraw agent operations.');
  if (!input.initiatedByUserId || !input.actorId || !input.idempotencyKey || input.idempotencyKey.length > 500) {
    throw new Error('Excalidraw agent operation identity and idempotency key are required.');
  }
  const state = await loadExcalidrawScene(input.documentId);
  if (!state || state.workspaceId !== input.workspace.workspaceId || state.status !== 'active') throw new Error('Excalidraw collaboration scene is unavailable.');
  if (input.observedSceneSequence > state.sceneSequence) throw new Error('Agent observedSceneSequence is newer than the authoritative scene.');
  const existingDatabase = await openDb();
  let operation: ExcalidrawAgentOperation;
  try {
    const existing = await existingDatabase.get(
      'SELECT * FROM collaboration_excalidraw_agent_operations WHERE document_id = ? AND initiated_by_user_id = ? AND idempotency_key = ? LIMIT 1',
      [input.documentId, input.initiatedByUserId, input.idempotencyKey],
    ) as OperationRow | undefined;
    if (existing) return mapOperation(existing);
    const now = Date.now();
    const operationId = `excal-agent-${crypto.randomUUID()}`;
    const row = await existingDatabase.get(
      `INSERT INTO collaboration_excalidraw_agent_operations (
         operation_id, document_id, workspace_id, lifecycle_generation,
         observed_scene_sequence, initiated_by_user_id, actor_id, idempotency_key,
         status, patch_json, result_json, cas_version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', CAST(? AS jsonb), NULL, 0, ?, ?)
       ON CONFLICT (document_id, initiated_by_user_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        operationId,
        input.documentId,
        input.workspace.workspaceId,
        state.lifecycleGeneration,
        input.observedSceneSequence,
        input.initiatedByUserId,
        input.actorId,
        input.idempotencyKey,
        JSON.stringify(input.actions),
        now,
        now,
      ],
    ) as OperationRow | undefined;
    if (!row) {
      const concurrent = await existingDatabase.get(
        'SELECT * FROM collaboration_excalidraw_agent_operations WHERE document_id = ? AND initiated_by_user_id = ? AND idempotency_key = ? LIMIT 1',
        [input.documentId, input.initiatedByUserId, input.idempotencyKey],
      ) as OperationRow | undefined;
      if (!concurrent) throw new Error('Could not create Excalidraw agent operation.');
      return mapOperation(concurrent);
    }
    operation = mapOperation(row);
  } finally {
    await existingDatabase.close();
  }
  const removePresence = presence({
    operationId: operation.operationId,
    state,
    initiatedByUserId: operation.initiatedByUserId,
    actorId: operation.actorId,
  });
  try {
    const prepared = preparePatch({ state, actions: operation.actions });
    if (prepared.conflicts.length) {
      return updateOperation({
        operationId: operation.operationId,
        expectedStatuses: ['preparing'],
        status: 'needs_review',
        reviewReason: prepared.conflicts.join('; '),
        result: {
          reviewTargets: prepared.currentTargets,
          activeHumanConnections: getExcalidrawConnectionCount(operation.documentId),
        },
      });
    }
    const applied = await applyPreparedAgentPatch(operation, state, prepared.elements, 'apply');
    return updateOperation({
      operationId: operation.operationId,
      expectedStatuses: ['preparing'],
      status: 'applied',
      result: {
        sceneSequence: applied.state.sceneSequence,
        elementIds: prepared.elements.map((element) => element.id),
      },
    });
  } catch (error) {
    await updateOperation({
      operationId: operation.operationId,
      expectedStatuses: ['preparing'],
      status: 'failed',
      reviewReason: error instanceof Error ? error.message : 'Excalidraw agent apply failed.',
    }).catch(() => undefined);
    throw error;
  } finally {
    removePresence();
  }
}

export async function acceptExcalidrawAgentOperation(input: {
  operationId: string;
  workspace: WorkspaceContext;
  userId: string;
}): Promise<ExcalidrawAgentOperation> {
  const operation = await getExcalidrawAgentOperation(input);
  if (!operation) throw new Error('Excalidraw agent operation was not found.');
  if (operation.status === 'applied') return operation;
  if (operation.status !== 'needs_review') throw new Error(`Excalidraw agent operation cannot be accepted from ${operation.status}.`);
  const state = await loadExcalidrawScene(operation.documentId);
  if (!state || state.lifecycleGeneration !== operation.lifecycleGeneration) throw new Error('Excalidraw lifecycle changed before review acceptance.');
  const reviewTargets = (operation.result?.reviewTargets || {}) as Record<string, TargetFingerprint>;
  const prepared = preparePatch({ state, actions: operation.actions, reviewTargets });
  if (prepared.conflicts.length) {
    return updateOperation({
      operationId: input.operationId,
      expectedStatuses: ['needs_review'],
      status: 'needs_review',
      reviewReason: prepared.conflicts.join('; '),
      result: { reviewTargets: prepared.currentTargets },
    });
  }
  const applied = await applyPreparedAgentPatch(operation, state, prepared.elements, 'accept');
  return updateOperation({
    operationId: input.operationId,
    expectedStatuses: ['needs_review'],
    status: 'applied',
    result: { sceneSequence: applied.state.sceneSequence, elementIds: prepared.elements.map((element) => element.id) },
  });
}

export async function rejectExcalidrawAgentOperation(input: {
  operationId: string;
  workspace: WorkspaceContext;
  userId: string;
}): Promise<ExcalidrawAgentOperation> {
  const operation = await getExcalidrawAgentOperation(input);
  if (!operation) throw new Error('Excalidraw agent operation was not found.');
  if (operation.status === 'rejected') return operation;
  return updateOperation({ operationId: input.operationId, expectedStatuses: ['needs_review'], status: 'rejected' });
}

export async function cancelExcalidrawAgentOperation(input: {
  operationId: string;
  workspace: WorkspaceContext;
  userId: string;
}): Promise<ExcalidrawAgentOperation> {
  const operation = await getExcalidrawAgentOperation(input);
  if (!operation) throw new Error('Excalidraw agent operation was not found.');
  if (operation.status === 'cancelled') return operation;
  return updateOperation({ operationId: input.operationId, expectedStatuses: ['preparing', 'needs_review'], status: 'cancelled' });
}

export async function listExcalidrawAgentOperations(input: {
  documentId: string;
  workspace: WorkspaceContext;
  userId: string;
  pendingOnly?: boolean;
}): Promise<ExcalidrawAgentOperation[]> {
  if (getDatabaseProvider() !== 'postgres') return [];
  const database = await openDb();
  try {
    const rows = await database.all(
      `SELECT * FROM collaboration_excalidraw_agent_operations
       WHERE document_id = ? AND workspace_id = ?
         AND (? = TRUE OR initiated_by_user_id = ?)
         AND (? = FALSE OR status = 'needs_review')
       ORDER BY updated_at DESC LIMIT 50`,
      [
        input.documentId,
        input.workspace.workspaceId,
        input.workspace.permissions.canManageWorkspace,
        input.userId,
        input.pendingOnly === true,
      ],
    ) as OperationRow[];
    return rows.map(mapOperation);
  } finally {
    await database.close();
  }
}
