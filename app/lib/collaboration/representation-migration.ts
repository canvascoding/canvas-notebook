import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { readFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { readPostgresWorkspaceForActor } from '@/app/lib/workspaces/postgres-runtime';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { materializeCollaborationCheckpoint } from './checkpoint';
import { createCollaborationAdmissionService } from './room-admission';
import { createCollaborationAdmissionHandoffService } from './room-admission-handoff';
import { createCollaborationAdmissionQuiescenceService } from './room-admission-quiescence';
import { CollaborationAdmissionError, type CollaborationAdmissionRequest } from './room-admission-contract';
import { captureRepresentationAdmissionRequest, createRepresentationAdmissionRequest } from './representation-admission-contract';
import { changeCollaborationRepresentationInAdmissionHandoff, prepareCollaborationRepresentationAdmission,
  loadCollaborationState, CollaborationRepresentationMigrationError, type PersistedCollaborationState } from './persistence';
import { collaborationUpdateStateProof } from './state-proof';
import { loadCollaborationProjectionStatus } from './projection-repository';
import { analyzeMarkdownRichMode } from '@/app/lib/markdown/rich-markdown-codec';
import { Y } from './server-runtime';
import { getCollaborationRoomConnectionCount, withCollaborationRoomLifecycleLock } from './runtime-state';
import { richMigrationRuntimeAvailable, richMigrationConnectedClients } from './representation-migration-runtime';
import type { RichMigrationRequest, RichMigrationResult } from './representation-migration-contract';

type Authorization = {
  authorize: (request: CollaborationAdmissionRequest) => Promise<void>;
  /** Only immutable, verified terminal outcomes may resolve at a moved canonical path. */
  authorizeTerminal?: (request: CollaborationAdmissionRequest) => Promise<void>;
};
type MigrationProgress = { status: 'completed'; aborted: boolean } | { status: 'pending'; phase: 'quiescence' | 'handoff' };

/** A narrow domain adapter over the existing durable admission protocol. */
export function createRepresentationMigrationCoordinator(options: {
  openConnection: () => Promise<SqlConnection>;
  withMutationLocks: <T>(workspaceIds: readonly string[], operation: () => Promise<T>) => Promise<T>;
}) {
  const admission = createCollaborationAdmissionService(options);
  const handoff = createCollaborationAdmissionHandoffService(options);
  const quiescence = createCollaborationAdmissionQuiescenceService(options);
  const terminal = async (request: CollaborationAdmissionRequest, authorization: Authorization): Promise<MigrationProgress | null> => {
    const outcome = await handoff.readOutcome(request);
    if (outcome) {
      await (authorization.authorizeTerminal ?? authorization.authorize)(request);
      return { status: 'completed', aborted: outcome.version === 2 };
    }
    const current = await admission.read(request);
    if (current?.status === 'cancelled') {
      await (authorization.authorizeTerminal ?? authorization.authorize)(request);
      return { status: 'completed', aborted: true };
    }
    if (current?.status === 'recovery_required') throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
    if (current?.status === 'committed') {
      const winner = await handoff.readOutcome(request);
      if (!winner) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
      await (authorization.authorizeTerminal ?? authorization.authorize)(request);
      return { status: 'completed', aborted: winner.version === 2 };
    }
    await authorization.authorize(request);
    return null;
  };
  return {
    loadRequest: handoff.loadRequest,
    async advance(input: CollaborationAdmissionRequest, authorization: Authorization, cancel = false, waitForRetainedRoom = false): Promise<MigrationProgress> {
      const { request, document } = captureRepresentationAdmissionRequest(input);
      const previous = await terminal(request, authorization);
      if (previous) return previous;
      if (waitForRetainedRoom && !cancel) return { status: 'pending', phase: 'quiescence' };
      let reservation = await admission.read(request);
      if (!reservation) {
        await authorization.authorize(request);
        reservation = await admission.reserve(request);
      }
      if (!['reserved', 'draining'].includes(reservation.status)) throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
      if (cancel && reservation.status === 'reserved') {
        try { await admission.cancel(request, reservation.revision); return { status: 'completed', aborted: true }; }
        catch (error) { if (!(error instanceof CollaborationAdmissionError) || error.code !== 'ADMISSION_STATE_CHANGED') throw error; }
      }
      try { await quiescence.prove(request, document.documentId); }
      catch (error) {
        if (!(error instanceof CollaborationAdmissionError) || error.code !== 'ADMISSION_CONFLICT') {
          // An unstarted reservation has changed no bytes and can be released by CAS.
          if (reservation.status === 'reserved') await admission.cancel(request, reservation.revision);
          throw error;
        }
        const target = reservation.targets.find(item => item.document.documentId === document.documentId);
        if (!target) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
        if (target.ownerToken === null) return { status: 'pending', phase: 'quiescence' };
        await authorization.authorize(request);
        await admission.startDrain(request, document.documentId);
        return { status: 'pending', phase: 'quiescence' };
      }
      try {
        if (cancel) {
          await handoff.abort(request, { authorize: authorization.authorize, prepare: async () => {} }, 'user_cancelled');
          return { status: 'completed', aborted: true };
        }
        await handoff.execute(request, {
          authorize: authorization.authorize,
          prepare: async database => {
            await prepareCollaborationRepresentationAdmission(database, request);
            await authorization.authorize(request);
          },
          mutate: async database => {
            const result = await changeCollaborationRepresentationInAdmissionHandoff(database);
            return { documentId: result.state.documentId, backupId: result.backupId,
              lifecycleGeneration: String(result.state.lifecycleGeneration), documentSequence: String(result.state.documentSequence) };
          },
        });
        return { status: 'completed', aborted: false };
      } catch (error) {
        if (error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_CONFLICT') return { status: 'pending', phase: 'handoff' };
        if (error instanceof CollaborationRepresentationMigrationError) {
          // Release only through the same proven transaction, never by deleting a reservation.
          await handoff.abort(request, { authorize: authorization.authorize, prepare: async () => {} }, 'precondition_failed');
        }
        const completed = await terminal(request, authorization);
        if (completed) return completed;
        throw error;
      }
    },
  };
}

const withMigrationWorkspaceLocks = <T>(workspaceIds: readonly string[], operation: () => Promise<T>): Promise<T> => {
  const lock = (index: number): Promise<T> => index === workspaceIds.length ? operation()
    : withWorkspaceMutationLock(workspaceIds[index], () => lock(index + 1));
  return lock(0);
};

/** Requests advance one durable operation. Deadlines never cancel a committed switch. */
export async function advanceRichRepresentationMigration(input: {
  workspace: WorkspaceContext; path: string; state: PersistedCollaborationState; migration: RichMigrationRequest; cancel?: boolean;
}): Promise<{ state: PersistedCollaborationState; migration: RichMigrationResult }> {
  const { workspace, migration } = input;
  let state = input.state;
  const result = (status: RichMigrationResult['status'], reason?: string, phase?: RichMigrationResult['phase']) => ({ state,
    migration: { requestId: migration.requestId, status, documentId: state.documentId,
      lifecycleGeneration: state.lifecycleGeneration, ...(reason ? { reason } : {}), ...(phase ? { phase } : {}) } });
  // A lost write grant cannot certify cancellation of a previously accepted request.
  if (!workspace.permissions.canWrite || !workspace.actor) return result('pending', 'permission_denied', 'handoff');
  if (state.documentId !== migration.expectedDocumentId) return result('blocked', 'document_changed');
  if (state.path !== input.path) return result('pending', 'document_changed', 'handoff');
  const coordinator = createRepresentationMigrationCoordinator({ openConnection: openDb, withMutationLocks: withMigrationWorkspaceLocks });
  const authorizeAtPath = async (request: CollaborationAdmissionRequest, terminal: boolean) => {
    if (request.actorId !== workspace.actor!.userId || request.scopes[0]?.workspaceId !== workspace.workspaceId
      || !terminal && request.scopes[0]?.path !== input.path) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
    const fresh = await readPostgresWorkspaceForActor(workspace.actor!, workspace.workspaceId);
    if (!fresh?.permissions.canWrite || (fresh.organizationId ?? null) !== request.scopes[0].organizationId) {
      throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
    }
    const file = await readFileCollaborationState({ workspace: fresh, path: input.path });
    if (file.document?.id !== migration.expectedDocumentId) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  };
  const authorize = (request: CollaborationAdmissionRequest) => authorizeAtPath(request, false);
  const authorizeTerminal = (request: CollaborationAdmissionRequest) => authorizeAtPath(request, true);
  try {
    let rejection: { status: 'blocked' | 'unsupported'; reason: string } | undefined;
    let request = await coordinator.loadRequest(migration.requestId);
    if (request) {
      const captured = captureRepresentationAdmissionRequest(request);
      if (JSON.stringify(captured.migration) !== JSON.stringify(migration)) throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
    } else {
      if (state.representation === 'tiptap_blocks') return result('already_rich');
      if (/\.txt$/iu.test(input.path)) return result('unsupported', 'plain_text_document');
      if (state.lifecycleGeneration !== migration.expectedLifecycleGeneration) return result('blocked', 'lifecycle_stale');
      if (!input.cancel) {
        if (!richMigrationRuntimeAvailable()) rejection = { status: 'blocked', reason: 'runtime_unavailable' };
        else if (state.documentSequence !== migration.documentSequence || collaborationUpdateStateProof(state.yjsState, Y) !== migration.stateProof) rejection = { status: 'blocked', reason: 'state_changed' };
        if (!rejection) {
          const projection = await loadCollaborationProjectionStatus(state);
          if (state.degraded || state.checkpointSequence !== state.documentSequence || !projection.projectionFinalized) rejection = { status: 'blocked', reason: 'checkpoint_stale' };
        }
        if (!rejection && state.representation === 'plain_text') {
          const doc = new Y.Doc();
          try {
            Y.applyUpdate(doc, state.yjsState);
            const analysis = analyzeMarkdownRichMode(doc.getText('content').toString());
            if (analysis.mode === 'source') rejection = { status: 'unsupported', reason: analysis.reason };
          } finally { doc.destroy(); }
        }
        if (!rejection && (richMigrationConnectedClients(state.documentId) ?? 0) > 0) rejection = { status: 'blocked', reason: 'room_active' };
      }
      // Rejections/cancellation record the immutable ID before CAS cancellation.
      // A null historical read cannot exclude a racing first request waiting here.
      request = createRepresentationAdmissionRequest(state, workspace.actor.userId, migration);
    }
    const progress = await withCollaborationRoomLifecycleLock(state.documentId, async () => {
      const database = await openDb();
      let ownerEpoch = 0;
      try { ownerEpoch = Number((await database.get('SELECT room_owner_epoch FROM collaboration_yjs_states WHERE document_id = $1', [state.documentId]) as { room_owner_epoch?: number } | undefined)?.room_owner_epoch ?? 0); }
      finally { await database.close(); }
      // Owner-era retained rooms are drained by their verified owner, even after the last client left.
      const retainedEpochZero = ownerEpoch === 0 && getCollaborationRoomConnectionCount(state.documentId) > 0;
      return coordinator.advance(request!, { authorize, authorizeTerminal }, input.cancel || Boolean(rejection), retainedEpochZero);
    });
    state = await loadCollaborationState(state.documentId) ?? state;
    if (progress.status === 'pending') return result('pending', undefined, progress.phase);
    if (progress.aborted) return result(rejection?.status ?? 'blocked', rejection?.reason ?? (input.cancel ? 'cancelled' : 'precondition_failed'));
    if (state.representation !== 'tiptap_blocks') return result('pending', 'outcome_unconfirmed', 'handoff');
    try {
      const projected = await materializeCollaborationCheckpoint({ state, workspace, actorUserId: workspace.actor.userId, actorType: 'user' });
      state = projected.state;
      const projection = await loadCollaborationProjectionStatus(state);
      if (!projection.projectionFinalized) return result('pending', undefined, 'projection');
    } catch {
      // SQL is authoritative; keep the NEW identity and let the existing journal resume projection.
      state = await loadCollaborationState(state.documentId) ?? state;
      return result('pending', 'checkpoint_failed', 'projection');
    }
    return result('migrated');
  } catch (error) {
    const canonical = await loadCollaborationState(state.documentId).catch(() => null);
    state = canonical ?? state;
    // A failed read/COMMIT/abort response proves neither rollback nor removal of
    // a reservation. Only advance's verified terminal result permits old-writer resume.
    return result('pending', canonical && (error instanceof CollaborationRepresentationMigrationError || error instanceof CollaborationAdmissionError)
      ? error.code : 'outcome_unconfirmed', 'handoff');
  }
}
