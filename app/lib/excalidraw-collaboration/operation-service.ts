import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { acceptExcalidrawAgentOperation, cancelExcalidrawAgentOperation, getExcalidrawAgentOperation,
  listExcalidrawAgentOperations, rejectExcalidrawAgentOperation,
  type ExcalidrawAgentOperation } from './agent-operations';
import { materializeExcalidrawCheckpoint } from './checkpoint';
import { loadExcalidrawScene, loadExcalidrawSceneInTransaction, withExcalidrawSceneTransaction,
  type PersistedExcalidrawScene } from './repository';
import { ExcalidrawDocumentError, excalidrawDocumentSnapshot, type ExcalidrawDocumentSnapshot } from './scene-service';
import { assertExcalidrawProviderAvailable } from './provider';

export type ExcalidrawOperationSnapshot = ExcalidrawAgentOperation & {
  sceneSequence: number;
  checkpoint: ExcalidrawDocumentSnapshot['checkpoint'];
  documentUrl: string;
  reviewHint: string | null;
};

type ReadInput = {
  workspace: WorkspaceContext;
  userId: string;
  beforeRead?: () => Promise<WorkspaceContext>;
};

function assertWorkspaceAuthority(current: WorkspaceContext, initial: WorkspaceContext, write = false): void {
  if (current.workspaceId !== initial.workspaceId || current.rootPath !== initial.rootPath
    || (current.organizationId ?? null) !== (initial.organizationId ?? null)
    || current.legacy || (current.status !== undefined && current.status !== 'active')
    || !current.permissions.canRead || write && !current.permissions.canWrite) {
    throw new ExcalidrawDocumentError('EXCALIDRAW_PERMISSION_DENIED', 403,
      'Current workspace access is required for this Excalidraw operation.');
  }
}

function assertUserAuthority(workspace: WorkspaceContext, userId: string): void {
  if (!userId || workspace.actor && workspace.actor.userId !== userId) {
    throw new ExcalidrawDocumentError('EXCALIDRAW_PERMISSION_DENIED', 403,
      'The authenticated Excalidraw actor changed.');
  }
}

function operationNotFound(): never {
  throw new ExcalidrawDocumentError('EXCALIDRAW_OPERATION_NOT_FOUND', 404,
    'The Excalidraw operation is not available in this workspace.');
}

async function assertSceneIdentity(transaction: SqlConnection, state: PersistedExcalidrawScene | null,
  workspace: WorkspaceContext, generation?: number): Promise<void> {
  if (!state || state.workspaceId !== workspace.workspaceId
    || (state.organizationId ?? null) !== (workspace.organizationId ?? null)) {
    throw new ExcalidrawDocumentError('EXCALIDRAW_DOCUMENT_NOT_FOUND', 404,
      'The Excalidraw document is not available in this workspace.');
  }
  if (state.status !== 'active' || generation !== undefined && state.lifecycleGeneration !== generation) {
    throw new ExcalidrawDocumentError('EXCALIDRAW_LIFECYCLE_STALE', 409,
      'The Excalidraw operation belongs to a stale document lifecycle. Read the current scene again.');
  }
  const identity = await transaction.get(`SELECT document.id FROM collaboration_documents document
    JOIN file_collaboration_lineages lineage ON lineage.id = document.lineage_id AND lineage.status = 'active'
    WHERE document.id = $1 AND document.workspace_id = $2 AND document.path = $3
      AND document.provider = 'excalidraw' AND document.status = 'active'`,
  [state.documentId, workspace.workspaceId, state.path]);
  if (!identity) throw new ExcalidrawDocumentError('EXCALIDRAW_LIFECYCLE_STALE', 409,
    'The Excalidraw document identity changed. Read the current scene again.');
}

function operationSnapshot(operation: ExcalidrawAgentOperation, state: PersistedExcalidrawScene): ExcalidrawOperationSnapshot {
  const snapshot = excalidrawDocumentSnapshot(state);
  return { ...operation, sceneSequence: state.sceneSequence, checkpoint: snapshot.checkpoint,
    documentUrl: snapshot.documentUrl, reviewHint: operation.status === 'needs_review'
      ? operation.reviewReason ?? 'Open the document to review the proposed Excalidraw changes.' : null };
}

/** Read persisted status and checkpoint metadata without importing or requiring portable file bytes. */
export async function getExcalidrawOperation(input: ReadInput & { operationId: string }): Promise<ExcalidrawOperationSnapshot> {
  await assertExcalidrawProviderAvailable();
  assertWorkspaceAuthority(input.workspace, input.workspace);
  assertUserAuthority(input.workspace, input.userId);
  if (!input.userId || !input.operationId) operationNotFound();
  return withWorkspaceMutationLock(input.workspace.workspaceId, async () => {
    const candidate = await getExcalidrawAgentOperation(input);
    if (!candidate) operationNotFound();
    return withExcalidrawSceneTransaction(candidate.documentId, async transaction => {
      const workspace = await input.beforeRead?.() ?? input.workspace;
      assertWorkspaceAuthority(workspace, input.workspace);
      assertUserAuthority(workspace, input.userId);
      const operation = await getExcalidrawAgentOperation({ ...input, workspace });
      if (!operation) operationNotFound();
      const state = await loadExcalidrawSceneInTransaction(transaction, operation.documentId, true, true);
      await assertSceneIdentity(transaction, state, workspace, operation.lifecycleGeneration);
      return operationSnapshot(operation, state!);
    });
  });
}

export async function listExcalidrawOperations(input: ReadInput & {
  documentId: string; pendingOnly?: boolean;
}): Promise<ExcalidrawOperationSnapshot[]> {
  await assertExcalidrawProviderAvailable();
  assertWorkspaceAuthority(input.workspace, input.workspace);
  assertUserAuthority(input.workspace, input.userId);
  if (!input.userId || !input.documentId) throw new ExcalidrawDocumentError('INVALID_EXCALIDRAW_REQUEST', 400,
    'Document identity and trusted user are required.');
  return withWorkspaceMutationLock(input.workspace.workspaceId, () => withExcalidrawSceneTransaction(input.documentId,
    async transaction => {
      const workspace = await input.beforeRead?.() ?? input.workspace;
      assertWorkspaceAuthority(workspace, input.workspace);
      assertUserAuthority(workspace, input.userId);
      const state = await loadExcalidrawSceneInTransaction(transaction, input.documentId, true, true);
      await assertSceneIdentity(transaction, state, workspace);
      const operations = await listExcalidrawAgentOperations({ ...input, workspace });
      return operations.filter(operation => operation.lifecycleGeneration === state!.lifecycleGeneration)
        .map(operation => operationSnapshot(operation, state!));
    }));
}

function normalizeReviewError(error: unknown): never {
  if (error && typeof error === 'object' && 'status' in error) throw error;
  const message = error instanceof Error ? error.message : '';
  if (message === 'Excalidraw agent operation was not found.') operationNotFound();
  if (message.startsWith('Workspace write access')) throw new ExcalidrawDocumentError('EXCALIDRAW_PERMISSION_DENIED', 403, message);
  if (message.startsWith('Excalidraw lifecycle changed')) throw new ExcalidrawDocumentError('EXCALIDRAW_LIFECYCLE_STALE', 409, message);
  if (message.startsWith('Excalidraw agent operation cannot be accepted')
    || message === 'Excalidraw agent operation changed concurrently.') {
    throw new ExcalidrawDocumentError('EXCALIDRAW_OPERATION_CONFLICT', 409, message);
  }
  throw error;
}

export type ExcalidrawOperationReviewInput = {
  workspace: WorkspaceContext;
  userId: string;
  operationId: string;
  sessionId?: string | null;
  beforeApply?: (operation: ExcalidrawAgentOperation) => Promise<WorkspaceContext>;
} & ({ decision: 'accept'; expectedCasVersion: number } | { decision: 'reject' | 'cancel' });

export async function reviewExcalidrawOperation(input: ExcalidrawOperationReviewInput): Promise<ExcalidrawOperationSnapshot> {
  await assertExcalidrawProviderAvailable();
  assertWorkspaceAuthority(input.workspace, input.workspace, true);
  assertUserAuthority(input.workspace, input.userId);
  if (!input.userId || !input.operationId) operationNotFound();
  if (!['accept', 'reject', 'cancel'].includes(input.decision)) throw new ExcalidrawDocumentError('INVALID_EXCALIDRAW_REQUEST', 400,
    'Accept, reject or cancel is required.');
  if (input.decision === 'accept' && (!Number.isSafeInteger(input.expectedCasVersion) || input.expectedCasVersion < 0)) {
    throw new ExcalidrawDocumentError('INVALID_EXCALIDRAW_APPROVAL', 400,
      'The displayed expectedCasVersion is required. Reload the current review before accepting.');
  }
  return withWorkspaceMutationLock(input.workspace.workspaceId, async () => {
    let currentWorkspace = input.workspace;
    const beforeApply = async (operation: ExcalidrawAgentOperation) => {
      const workspace = await input.beforeApply?.(operation) ?? input.workspace;
      assertWorkspaceAuthority(workspace, input.workspace, true);
      assertUserAuthority(workspace, input.userId);
      const database = await openDb();
      try {
        const state = await loadExcalidrawScene(operation.documentId, true);
        await assertSceneIdentity(database, state, workspace, operation.lifecycleGeneration);
      } finally { await database.close(); }
      currentWorkspace = workspace;
      return workspace;
    };
    const transition = input.decision === 'accept' ? acceptExcalidrawAgentOperation
      : input.decision === 'reject' ? rejectExcalidrawAgentOperation : cancelExcalidrawAgentOperation;
    let operation: ExcalidrawAgentOperation;
    try { operation = await transition({ ...input, beforeApply }); }
    catch (error) { return normalizeReviewError(error); }
    if (input.decision === 'accept' && operation.status === 'applied') {
      const state = await loadExcalidrawScene(operation.documentId);
      if (state) await materializeExcalidrawCheckpoint({ state, workspace: currentWorkspace,
        actorUserId: input.userId, actorType: 'agent', sourceSessionId: input.sessionId })
        .catch(() => undefined); // Applied scene durability and checkpoint publication are distinct outcomes.
    }
    return getExcalidrawOperation({ workspace: currentWorkspace, userId: input.userId, operationId: operation.operationId });
  });
}
