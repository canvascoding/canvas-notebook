import 'server-only';

import { randomUUID } from 'node:crypto';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { getDatabaseProvider } from '@/app/lib/db/provider';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import {
  applyPersistedAgentTextOperation,
  revertAgentOperation,
  type AgentTextTarget,
} from './agent-operations';

const MAX_SAGA_DOCUMENTS = 16;

export type AgentSagaStatus =
  | 'preparing'
  | 'running'
  | 'completed'
  | 'needs_review'
  | 'partially_applied'
  | 'compensation_review'
  | 'compensated'
  | 'failed';

export type AgentSagaDocumentStatus =
  | 'pending'
  | 'applying'
  | 'applied'
  | 'needs_review'
  | 'compensation_required'
  | 'compensating'
  | 'compensation_review'
  | 'compensated'
  | 'skipped'
  | 'failed';

type SagaRow = {
  saga_id: string;
  workspace_id: string;
  organization_id: string | null;
  initiated_by_user_id: string;
  actor_id: string;
  idempotency_key: string;
  requested_atomicity: 'saga' | 'all_or_nothing';
  status: AgentSagaStatus;
  correlation_id: string | null;
  causation_id: string | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
};

type SagaDocumentRow = {
  saga_id: string;
  document_id: string;
  ordinal: number;
  operation_id: string | null;
  compensation_operation_id: string | null;
  status: AgentSagaDocumentStatus;
  error_code: string | null;
  updated_at: number;
};

export interface AgentTextSagaView {
  sagaId: string;
  workspaceId: string;
  initiatedByUserId: string;
  actorId: string;
  requestedAtomicity: 'saga' | 'all_or_nothing';
  status: AgentSagaStatus;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
  documents: Array<{
    documentId: string;
    ordinal: number;
    operationId: string | null;
    compensationOperationId: string | null;
    status: AgentSagaDocumentStatus;
    errorCode: string | null;
  }>;
}

export interface AgentTextSagaDocumentInput {
  documentId: string;
  targets: AgentTextTarget[];
  independentGroups?: boolean;
  expectedCanonicalHash?: string | null;
}

function view(row: SagaRow, documents: SagaDocumentRow[]): AgentTextSagaView {
  return {
    sagaId: row.saga_id,
    workspaceId: row.workspace_id,
    initiatedByUserId: row.initiated_by_user_id,
    actorId: row.actor_id,
    requestedAtomicity: row.requested_atomicity,
    status: row.status,
    errorCode: row.error_code,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    documents: documents.map((document) => ({
      documentId: document.document_id,
      ordinal: Number(document.ordinal),
      operationId: document.operation_id,
      compensationOperationId: document.compensation_operation_id,
      status: document.status,
      errorCode: document.error_code,
    })),
  };
}

function changes(value: unknown): number {
  return Number((value as { changes?: number } | null)?.changes || 0);
}

async function readSaga(database: SqlConnection, sagaId: string): Promise<AgentTextSagaView | null> {
  const row = await database.get(
    'SELECT * FROM collaboration_agent_sagas WHERE saga_id = ?',
    [sagaId],
  ) as SagaRow | undefined;
  if (!row) return null;
  const documents = await database.all(
    'SELECT * FROM collaboration_agent_saga_documents WHERE saga_id = ? ORDER BY ordinal ASC',
    [sagaId],
  ) as SagaDocumentRow[];
  return view(row, documents);
}

async function updateSaga(sagaId: string, status: AgentSagaStatus, errorCode: string | null): Promise<void> {
  const database = await openDb();
  try {
    await database.run(
      'UPDATE collaboration_agent_sagas SET status = ?, error_code = ?, updated_at = ? WHERE saga_id = ?',
      [status, errorCode, Date.now(), sagaId],
    );
  } finally {
    await database.close();
  }
}

async function updateSagaDocument(input: {
  sagaId: string;
  documentId: string;
  status: AgentSagaDocumentStatus;
  operationId?: string | null;
  compensationOperationId?: string | null;
  errorCode?: string | null;
}): Promise<void> {
  const database = await openDb();
  try {
    await database.run(
      `UPDATE collaboration_agent_saga_documents
       SET status = ?, operation_id = COALESCE(?, operation_id),
           compensation_operation_id = COALESCE(?, compensation_operation_id),
           error_code = ?, updated_at = ?
       WHERE saga_id = ? AND document_id = ?`,
      [
        input.status,
        input.operationId ?? null,
        input.compensationOperationId ?? null,
        input.errorCode ?? null,
        Date.now(),
        input.sagaId,
        input.documentId,
      ],
    );
  } finally {
    await database.close();
  }
}

async function markAppliedDocumentsForCompensation(sagaId: string): Promise<void> {
  const database = await openDb();
  try {
    await database.run(
      `UPDATE collaboration_agent_saga_documents
       SET status = 'compensation_required', updated_at = ?
       WHERE saga_id = ? AND status = 'applied'`,
      [Date.now(), sagaId],
    );
  } finally {
    await database.close();
  }
}

export async function getAgentTextSaga(input: {
  sagaId: string;
  workspace: WorkspaceContext;
  userId: string;
}): Promise<AgentTextSagaView | null> {
  if (getDatabaseProvider() !== 'postgres' || !input.workspace.permissions.canRead) return null;
  const database = await openDb();
  try {
    const result = await readSaga(database, input.sagaId);
    if (!result || result.workspaceId !== input.workspace.workspaceId) return null;
    if (result.initiatedByUserId !== input.userId && !input.workspace.permissions.canManageWorkspace) return null;
    return result;
  } finally {
    await database.close();
  }
}

/**
 * Applies cross-document work as a saga. A requested distributed
 * all-or-nothing operation is deliberately refused before the first mutation.
 */
export async function applyPersistedAgentTextSaga(input: {
  workspace: WorkspaceContext;
  initiatedByUserId: string;
  actorId: string;
  actorDisplayName: string;
  idempotencyKey: string;
  runGeneration: number;
  documents: AgentTextSagaDocumentInput[];
  requestedAtomicity?: 'saga' | 'all_or_nothing';
  correlationId?: string;
  causationId?: string;
}): Promise<AgentTextSagaView> {
  if (getDatabaseProvider() !== 'postgres') throw new Error('Agent collaboration sagas require Postgres.');
  if (!input.workspace.permissions.canWrite || !input.workspace.permissions.canRunAgent) {
    throw new Error('Workspace agent write permission is required.');
  }
  if (input.documents.length < 2 || input.documents.length > MAX_SAGA_DOCUMENTS) {
    throw new Error(`A collaboration saga requires 2-${MAX_SAGA_DOCUMENTS} documents.`);
  }
  if (new Set(input.documents.map((document) => document.documentId)).size !== input.documents.length) {
    throw new Error('A collaboration saga may include each document only once.');
  }

  const database = await openDb();
  let saga: AgentTextSagaView;
  try {
    const existing = await database.get(
      `SELECT saga_id FROM collaboration_agent_sagas
       WHERE workspace_id = ? AND initiated_by_user_id = ? AND idempotency_key = ?`,
      [input.workspace.workspaceId, input.initiatedByUserId, input.idempotencyKey],
    ) as { saga_id: string } | undefined;
    if (existing) {
      const existingSaga = await readSaga(database, existing.saga_id);
      if (!existingSaga) throw new Error('Existing collaboration saga could not be loaded.');
      return existingSaga;
    }

    const now = Date.now();
    const sagaId = randomUUID();
    const requestedAtomicity = input.requestedAtomicity || 'saga';
    const inserted = await database.run(
      `INSERT INTO collaboration_agent_sagas (
         saga_id, workspace_id, organization_id, initiated_by_user_id, actor_id,
         idempotency_key, requested_atomicity, status, correlation_id,
         causation_id, error_code, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, initiated_by_user_id, idempotency_key) DO NOTHING`,
      [
        sagaId,
        input.workspace.workspaceId,
        input.workspace.organizationId || null,
        input.initiatedByUserId,
        input.actorId,
        input.idempotencyKey,
        requestedAtomicity,
        requestedAtomicity === 'all_or_nothing' ? 'needs_review' : 'preparing',
        input.correlationId || sagaId,
        input.causationId || null,
        requestedAtomicity === 'all_or_nothing' ? 'distributed_atomicity_unsupported' : null,
        now,
        now,
      ],
    );
    if (changes(inserted) === 0) {
      const raced = await database.get(
        `SELECT saga_id FROM collaboration_agent_sagas
         WHERE workspace_id = ? AND initiated_by_user_id = ? AND idempotency_key = ?`,
        [input.workspace.workspaceId, input.initiatedByUserId, input.idempotencyKey],
      ) as { saga_id: string } | undefined;
      const racedSaga = raced ? await readSaga(database, raced.saga_id) : null;
      if (!racedSaga) throw new Error('Concurrent collaboration saga could not be loaded.');
      return racedSaga;
    }
    for (let ordinal = 0; ordinal < input.documents.length; ordinal += 1) {
      await database.run(
        `INSERT INTO collaboration_agent_saga_documents (
           saga_id, document_id, ordinal, status, error_code, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          sagaId,
          input.documents[ordinal].documentId,
          ordinal,
          requestedAtomicity === 'all_or_nothing' ? 'needs_review' : 'pending',
          requestedAtomicity === 'all_or_nothing' ? 'distributed_atomicity_unsupported' : null,
          now,
        ],
      );
    }
    const created = await readSaga(database, sagaId);
    if (!created) throw new Error('Collaboration saga could not be created.');
    saga = created;
  } finally {
    await database.close();
  }

  if (saga.requestedAtomicity === 'all_or_nothing') return saga;
  await updateSaga(saga.sagaId, 'running', null);

  let appliedAny = false;
  for (let ordinal = 0; ordinal < input.documents.length; ordinal += 1) {
    const document = input.documents[ordinal];
    await updateSagaDocument({ sagaId: saga.sagaId, documentId: document.documentId, status: 'applying' });
    try {
      const result = await applyPersistedAgentTextOperation({
        documentId: document.documentId,
        workspace: input.workspace,
        initiatedByUserId: input.initiatedByUserId,
        actorId: input.actorId,
        actorDisplayName: input.actorDisplayName,
        idempotencyKey: `saga:${saga.sagaId}:${document.documentId}`,
        runGeneration: input.runGeneration,
        targets: document.targets,
        independentGroups: document.independentGroups,
        explicitUserRequest: true,
        correlationId: input.correlationId || saga.sagaId,
        causationId: input.causationId || saga.sagaId,
        triggerDepth: 1,
        expectedCanonicalHash: document.expectedCanonicalHash,
      });
      const fullyApplied = result.operationStatus === 'checkpointed_file';
      const mutated = result.appliedTargetIds.length > 0;
      appliedAny ||= mutated;
      await updateSagaDocument({
        sagaId: saga.sagaId,
        documentId: document.documentId,
        status: fullyApplied ? 'applied' : mutated ? 'compensation_required' : 'needs_review',
        operationId: result.operationId,
        errorCode: fullyApplied ? null : mutated ? 'document_partially_applied' : 'document_needs_review',
      });
      if (!fullyApplied) {
        await markAppliedDocumentsForCompensation(saga.sagaId);
        for (const remaining of input.documents.slice(ordinal + 1)) {
          await updateSagaDocument({
            sagaId: saga.sagaId,
            documentId: remaining.documentId,
            status: 'skipped',
            errorCode: 'earlier_document_requires_review',
          });
        }
        await updateSaga(saga.sagaId, appliedAny ? 'partially_applied' : 'needs_review', 'document_needs_review');
        return (await getAgentTextSaga({ sagaId: saga.sagaId, workspace: input.workspace, userId: input.initiatedByUserId }))!;
      }
    } catch {
      await updateSagaDocument({
        sagaId: saga.sagaId,
        documentId: document.documentId,
        status: 'failed',
        errorCode: 'document_apply_failed',
      });
      await markAppliedDocumentsForCompensation(saga.sagaId);
      for (const remaining of input.documents.slice(ordinal + 1)) {
        await updateSagaDocument({
          sagaId: saga.sagaId,
          documentId: remaining.documentId,
          status: 'skipped',
          errorCode: 'earlier_document_failed',
        });
      }
      await updateSaga(saga.sagaId, appliedAny ? 'partially_applied' : 'failed', 'document_apply_failed');
      return (await getAgentTextSaga({ sagaId: saga.sagaId, workspace: input.workspace, userId: input.initiatedByUserId }))!;
    }
  }

  await updateSaga(saga.sagaId, 'completed', null);
  return (await getAgentTextSaga({ sagaId: saga.sagaId, workspace: input.workspace, userId: input.initiatedByUserId }))!;
}

/** Explicitly compensates the documents that were already changed by a saga. */
export async function compensateAgentTextSaga(input: {
  sagaId: string;
  workspace: WorkspaceContext;
  userId: string;
  idempotencyKey: string;
}): Promise<AgentTextSagaView> {
  const saga = await getAgentTextSaga(input);
  if (!saga) throw new Error('Collaboration saga was not found.');
  if (!input.workspace.permissions.canWrite) throw new Error('Workspace write permission is required.');

  for (const document of saga.documents) {
    if (!['applied', 'compensation_required', 'compensation_review'].includes(document.status) || !document.operationId) continue;
    await updateSagaDocument({ sagaId: saga.sagaId, documentId: document.documentId, status: 'compensating' });
    try {
      const result = await revertAgentOperation({
        operationId: document.operationId,
        workspace: input.workspace,
        userId: input.userId,
        idempotencyKey: `saga-compensate:${saga.sagaId}:${document.documentId}:${input.idempotencyKey}`,
        requestedMode: 'direct_apply',
      });
      const compensated = result.durability === 'checkpointed_file'
        && ['checkpointed_file', 'reverted'].includes(result.operationStatus);
      await updateSagaDocument({
        sagaId: saga.sagaId,
        documentId: document.documentId,
        status: compensated ? 'compensated' : 'compensation_review',
        compensationOperationId: result.operationId,
        errorCode: compensated ? null : 'compensation_needs_review',
      });
    } catch {
      await updateSagaDocument({
        sagaId: saga.sagaId,
        documentId: document.documentId,
        status: 'compensation_review',
        errorCode: 'compensation_failed',
      });
    }
  }

  const current = await getAgentTextSaga({ sagaId: saga.sagaId, workspace: input.workspace, userId: input.userId });
  if (!current) throw new Error('Collaboration saga could not be reloaded.');
  const compensationPending = current.documents.some((document) => (
    ['applied', 'compensation_required', 'compensating', 'compensation_review'].includes(document.status)
  ));
  await updateSaga(
    saga.sagaId,
    compensationPending ? 'compensation_review' : 'compensated',
    compensationPending ? 'compensation_needs_review' : null,
  );
  return (await getAgentTextSaga({ sagaId: saga.sagaId, workspace: input.workspace, userId: input.userId }))!;
}
