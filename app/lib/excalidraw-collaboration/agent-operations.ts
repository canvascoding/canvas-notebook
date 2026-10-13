import 'server-only';

import crypto from 'node:crypto';

import { collaborationUserColors } from '@/app/lib/collaboration/identity';
import { removeDocumentPresenceEntry, upsertDocumentPresenceEntry } from '@/app/lib/collaboration/presence';
import { openDb, type SqlConnection } from '@/app/lib/db';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { ExcalidrawElementRecord } from './protocol';
import { validateExcalidrawElement } from './scene';
import {
  applyExcalidrawScenePatchInTransaction,
  getExcalidrawScenePatchResultInTransaction,
  loadExcalidrawSceneInTransaction,
  withExcalidrawSceneTransaction,
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
  requestFingerprint: string | null;
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
  request_fingerprint: string | null;
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
    requestFingerprint: row.request_fingerprint ?? null,
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

export class ExcalidrawIdempotencyConflictError extends Error {
  readonly code = 'EXCALIDRAW_IDEMPOTENCY_CONFLICT';

  constructor() {
    super('The Excalidraw idempotency key was already used with a different request.');
    this.name = 'ExcalidrawIdempotencyConflictError';
  }
}

function validateActions(actions: ExcalidrawAgentSceneAction[]): void {
  if (!Array.isArray(actions) || !actions.length || actions.length > 500) {
    throw new Error('Excalidraw agent patch requires 1 to 500 actions.');
  }
  const ids = new Set<string>();
  for (const action of actions) {
    if (!action || !['create', 'update', 'delete'].includes(action.type)) throw new Error('Invalid Excalidraw agent action.');
    const id = targetId(action);
    if (typeof id !== 'string' || !id || ids.has(id)) throw new Error('Excalidraw agent action requires a unique element target.');
    ids.add(id);
    if (action.type !== 'create' && (
      !Number.isSafeInteger(action.expectedVersion) || action.expectedVersion < 1
      || !Number.isSafeInteger(action.expectedVersionNonce) || action.expectedVersionNonce < 0
    )) throw new Error('Excalidraw updates and deletes require the observed element version and versionNonce.');
    if (action.type !== 'delete') {
      const element = validateExcalidrawElement(action.element);
      if (element.id !== id) throw new Error(`Excalidraw update id ${element.id} does not match target ${id}.`);
    }
  }
}

function canonicalRequest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRequest);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalRequest(child)]));
  }
  return value;
}

function requestFingerprint(input: {
  workspaceId: string;
  documentId: string;
  lifecycleGeneration: number;
  observedSceneSequence: number;
  initiatedByUserId: string;
  actorId: string;
  actions: ExcalidrawAgentSceneAction[];
}): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalRequest({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    lifecycleGeneration: input.lifecycleGeneration,
    observedSceneSequence: input.observedSceneSequence,
    initiatedByUserId: input.initiatedByUserId,
    actorId: input.actorId,
    actions: input.actions,
  }))).digest('hex');
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
  validateActions(input.actions);
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
  const database = await openDb();
  try {
    const row = await database.get(
      'SELECT * FROM collaboration_excalidraw_agent_operations WHERE operation_id = $1 LIMIT 1',
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
  if (!input.workspace.permissions.canRead) return null;
  const operation = await loadOperation(input.operationId);
  if (!operation || operation.workspaceId !== input.workspace.workspaceId) return null;
  if (operation.initiatedByUserId !== input.userId && !input.workspace.permissions.canManageWorkspace) return null;
  return operation;
}

async function updateOperation(database: SqlConnection, input: {
  operation: ExcalidrawAgentOperation;
  expectedStatuses: ExcalidrawAgentOperationStatus[];
  status: ExcalidrawAgentOperationStatus;
  result?: Record<string, unknown> | null;
  reviewReason?: string | null;
}): Promise<ExcalidrawAgentOperation> {
  const placeholders = input.expectedStatuses.map((_, index) => `$${index + 7}`).join(', ');
  const row = await database.get(
    `UPDATE collaboration_excalidraw_agent_operations
     SET status = $1, result_json = CAST($2 AS jsonb), review_reason = $3,
         cas_version = cas_version + 1, updated_at = $4
     WHERE operation_id = $5 AND cas_version = $6 AND status IN (${placeholders})
     RETURNING *`,
    [input.status, JSON.stringify(input.result ?? null), input.reviewReason ?? null,
      Date.now(), input.operation.operationId, input.operation.casVersion, ...input.expectedStatuses],
  ) as OperationRow | undefined;
  if (!row) throw new Error('Excalidraw agent operation changed concurrently.');
  return mapOperation(row);
}

async function lockedOperation(database: SqlConnection, operationId: string): Promise<ExcalidrawAgentOperation> {
  const row = await database.get(
    'SELECT * FROM collaboration_excalidraw_agent_operations WHERE operation_id = $1 FOR UPDATE',
    [operationId],
  ) as OperationRow | undefined;
  if (!row) throw new Error('Excalidraw agent operation was not found.');
  return mapOperation(row);
}

function assertWritableOperationContext(
  workspace: WorkspaceContext,
  state: PersistedExcalidrawScene | null,
  lifecycleGeneration: number,
): asserts state is PersistedExcalidrawScene {
  if (!workspace.permissions.canWrite) throw new Error('Workspace write access is required for Excalidraw agent operations.');
  if (!state || state.workspaceId !== workspace.workspaceId || state.status !== 'active') {
    throw new Error('Excalidraw collaboration scene is unavailable.');
  }
  if (state.lifecycleGeneration !== lifecycleGeneration) throw new Error('Excalidraw lifecycle changed before the operation could be applied.');
}

function assertReviewActor(operation: ExcalidrawAgentOperation, workspace: WorkspaceContext, userId: string): void {
  if (!userId || operation.workspaceId !== workspace.workspaceId
    || (operation.initiatedByUserId !== userId && !workspace.permissions.canManageWorkspace)) {
    throw new Error('Excalidraw agent operation was not found.');
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
  transaction: SqlConnection,
  operation: ExcalidrawAgentOperation,
  state: PersistedExcalidrawScene,
  elements: ExcalidrawElementRecord[],
  messageSuffix: string,
): Promise<AppliedExcalidrawPatch> {
  return applyExcalidrawScenePatchInTransaction(transaction, {
    documentId: operation.documentId,
    lifecycleGeneration: operation.lifecycleGeneration,
    baseSequence: state.sceneSequence,
    messageId: `${operation.operationId}:${messageSuffix}:${operation.casVersion}`,
    elements,
    actorType: 'agent',
    actorId: operation.actorId,
    initiatedByUserId: operation.initiatedByUserId,
    operationId: operation.operationId,
  });
}

type OperationOutcome = { operation: ExcalidrawAgentOperation; applied?: AppliedExcalidrawPatch };

/** Routes revalidate the session and return fresh workspace permissions after all scene/operation locks. */
export type ExcalidrawAgentReviewInput = {
  operationId: string;
  workspace: WorkspaceContext;
  userId: string;
  beforeApply?: (operation: ExcalidrawAgentOperation) => Promise<WorkspaceContext | void>;
};

function publishCommittedOutcome(outcome: OperationOutcome): ExcalidrawAgentOperation {
  if (outcome.applied && !outcome.applied.duplicate) {
    publishExcalidrawAgentPatch(outcome.operation.documentId, outcome.operation.operationId, outcome.applied, {
      actorId: outcome.operation.actorId,
      initiatedByUserId: outcome.operation.initiatedByUserId,
    });
  }
  return outcome.operation;
}

async function finishAppliedOperation(
  transaction: SqlConnection,
  operation: ExcalidrawAgentOperation,
  applied: AppliedExcalidrawPatch,
): Promise<OperationOutcome> {
  return {
    operation: await updateOperation(transaction, {
      operation,
      expectedStatuses: [operation.status],
      status: 'applied',
      result: {
        sceneSequence: applied.state.sceneSequence,
        elementIds: applied.acceptedElements.map((element) => element.id),
      },
    }),
    applied,
  };
}

export async function createExcalidrawAgentOperation(input: {
  workspace: WorkspaceContext;
  documentId: string;
  lifecycleGeneration?: number;
  observedSceneSequence: number;
  actions: ExcalidrawAgentSceneAction[];
  initiatedByUserId: string;
  actorId: string;
  idempotencyKey: string;
  beforeApply?: () => Promise<void>;
}): Promise<ExcalidrawAgentOperation> {
  if (!input.workspace.permissions.canWrite) throw new Error('Workspace write access is required for Excalidraw agent operations.');
  if (!input.initiatedByUserId || !input.actorId || !input.idempotencyKey || input.idempotencyKey.length > 500) {
    throw new Error('Excalidraw agent operation identity and idempotency key are required.');
  }
  if (!Number.isSafeInteger(input.observedSceneSequence) || input.observedSceneSequence < 0
    || (input.lifecycleGeneration !== undefined && (!Number.isSafeInteger(input.lifecycleGeneration) || input.lifecycleGeneration < 1))) {
    throw new Error('Excalidraw agent scene sequence and lifecycle generation are invalid.');
  }
  validateActions(input.actions);
  let removePresence: (() => void) | undefined;
  try {
    const outcome = await withExcalidrawSceneTransaction(input.documentId, async (transaction): Promise<OperationOutcome> => {
      const state = await loadExcalidrawSceneInTransaction(transaction, input.documentId, false, true);
      const generation = input.lifecycleGeneration ?? state?.lifecycleGeneration ?? 0;
      assertWritableOperationContext(input.workspace, state, generation);
      if (input.observedSceneSequence > state.sceneSequence) throw new Error('Agent observedSceneSequence is newer than the authoritative scene.');
      // Permissions can be revoked while waiting for the scene lock. Query authority only after that wait.
      await input.beforeApply?.();
      const requestedFingerprint = requestFingerprint({ ...input, workspaceId: input.workspace.workspaceId, lifecycleGeneration: generation });
      let row = await transaction.get(
        `SELECT * FROM collaboration_excalidraw_agent_operations
         WHERE document_id = $1 AND initiated_by_user_id = $2 AND actor_id = $3 AND idempotency_key = $4 FOR UPDATE`,
        [input.documentId, input.initiatedByUserId, input.actorId, input.idempotencyKey],
      ) as OperationRow | undefined;
      if (!row) {
        const now = Date.now();
        row = await transaction.get(
          `INSERT INTO collaboration_excalidraw_agent_operations (
             operation_id, document_id, workspace_id, lifecycle_generation,
             observed_scene_sequence, initiated_by_user_id, actor_id, idempotency_key,
             request_fingerprint, status, patch_json, result_json, cas_version, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'preparing', CAST($10 AS jsonb), NULL, 0, $11, $11)
           RETURNING *`,
          [`excal-agent-${crypto.randomUUID()}`, input.documentId, input.workspace.workspaceId, generation,
            input.observedSceneSequence, input.initiatedByUserId, input.actorId, input.idempotencyKey,
            requestedFingerprint, JSON.stringify(input.actions), now],
        ) as OperationRow | undefined;
      }
      if (!row) throw new Error('Could not create Excalidraw agent operation.');
      const operation = mapOperation(row);
      const storedFingerprint = operation.requestFingerprint ?? requestFingerprint(operation);
      if (storedFingerprint !== requestedFingerprint) throw new ExcalidrawIdempotencyConflictError();
      if (!operation.requestFingerprint) {
        await transaction.run('UPDATE collaboration_excalidraw_agent_operations SET request_fingerprint = $1 WHERE operation_id = $2',
          [storedFingerprint, operation.operationId]);
        operation.requestFingerprint = storedFingerprint;
      }
      assertWritableOperationContext(input.workspace, state, operation.lifecycleGeneration);
      if (operation.status !== 'preparing') return { operation };
      removePresence = presence({ operationId: operation.operationId, state,
        initiatedByUserId: operation.initiatedByUserId, actorId: operation.actorId });
      // A legacy preparing row may have committed its scene before its status. Never apply twice.
      const durableApply = await getExcalidrawScenePatchResultInTransaction(transaction, operation.documentId,
        `${operation.operationId}:apply:${operation.casVersion}`);
      if (durableApply) return finishAppliedOperation(transaction, operation, durableApply);
      const prepared = preparePatch({ state, actions: operation.actions });
      if (prepared.conflicts.length) {
        return { operation: await updateOperation(transaction, {
          operation, expectedStatuses: ['preparing'], status: 'needs_review',
          reviewReason: prepared.conflicts.join('; '),
          result: { reviewTargets: prepared.currentTargets, activeHumanConnections: getExcalidrawConnectionCount(operation.documentId) },
        }) };
      }
      const applied = await applyPreparedAgentPatch(transaction, operation, state, prepared.elements, 'apply');
      return finishAppliedOperation(transaction, operation, applied);
    });
    return publishCommittedOutcome(outcome);
  } finally {
    removePresence?.();
  }
}

export async function acceptExcalidrawAgentOperation(input: ExcalidrawAgentReviewInput): Promise<ExcalidrawAgentOperation> {
  const candidate = await getExcalidrawAgentOperation(input);
  if (!candidate) throw new Error('Excalidraw agent operation was not found.');
  const outcome = await withExcalidrawSceneTransaction(candidate.documentId, async (transaction): Promise<OperationOutcome> => {
    const state = await loadExcalidrawSceneInTransaction(transaction, candidate.documentId, false, true);
    const operation = await lockedOperation(transaction, input.operationId);
    const currentWorkspace = await input.beforeApply?.(operation) ?? input.workspace;
    assertReviewActor(operation, currentWorkspace, input.userId);
    assertWritableOperationContext(currentWorkspace, state, operation.lifecycleGeneration);
    if (operation.status === 'applied') return { operation };
    if (operation.status !== 'needs_review') throw new Error(`Excalidraw agent operation cannot be accepted from ${operation.status}.`);
    // Recover legacy split-commit acceptance without mistaking its own patch for new human intervention.
    const durableApply = await getExcalidrawScenePatchResultInTransaction(transaction, operation.documentId,
      `${operation.operationId}:accept:${operation.casVersion}`);
    if (durableApply) return finishAppliedOperation(transaction, operation, durableApply);
    const reviewTargets = (operation.result?.reviewTargets || {}) as Record<string, TargetFingerprint>;
    const prepared = preparePatch({ state, actions: operation.actions, reviewTargets });
    if (prepared.conflicts.length) {
      return { operation: await updateOperation(transaction, {
        operation, expectedStatuses: ['needs_review'], status: 'needs_review',
        reviewReason: prepared.conflicts.join('; '), result: { reviewTargets: prepared.currentTargets },
      }) };
    }
    return finishAppliedOperation(transaction, operation,
      await applyPreparedAgentPatch(transaction, operation, state, prepared.elements, 'accept'));
  });
  return publishCommittedOutcome(outcome);
}

async function transitionReviewedOperation(input: ExcalidrawAgentReviewInput, status: 'rejected' | 'cancelled'): Promise<ExcalidrawAgentOperation> {
  const candidate = await getExcalidrawAgentOperation(input);
  if (!candidate) throw new Error('Excalidraw agent operation was not found.');
  return withExcalidrawSceneTransaction(candidate.documentId, async (transaction) => {
    const state = await loadExcalidrawSceneInTransaction(transaction, candidate.documentId, false, true);
    const operation = await lockedOperation(transaction, input.operationId);
    const currentWorkspace = await input.beforeApply?.(operation) ?? input.workspace;
    assertReviewActor(operation, currentWorkspace, input.userId);
    assertWritableOperationContext(currentWorkspace, state, operation.lifecycleGeneration);
    if (operation.status === status) return operation;
    return updateOperation(transaction, {
      operation, expectedStatuses: status === 'rejected' ? ['needs_review'] : ['preparing', 'needs_review'], status,
    });
  });
}

export async function rejectExcalidrawAgentOperation(input: ExcalidrawAgentReviewInput): Promise<ExcalidrawAgentOperation> {
  return transitionReviewedOperation(input, 'rejected');
}

export async function cancelExcalidrawAgentOperation(input: ExcalidrawAgentReviewInput): Promise<ExcalidrawAgentOperation> {
  return transitionReviewedOperation(input, 'cancelled');
}

export async function listExcalidrawAgentOperations(input: {
  documentId: string;
  workspace: WorkspaceContext;
  userId: string;
  pendingOnly?: boolean;
}): Promise<ExcalidrawAgentOperation[]> {
  if (!input.workspace.permissions.canRead) return [];
  const database = await openDb();
  try {
    const rows = await database.all(
      `SELECT * FROM collaboration_excalidraw_agent_operations
       WHERE document_id = $1 AND workspace_id = $2
         AND ($3 = TRUE OR initiated_by_user_id = $4)
         AND ($5 = FALSE OR status = 'needs_review')
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
