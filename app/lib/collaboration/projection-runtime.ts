import 'server-only';

import { recordFileGuestVersion } from '@/app/lib/file-guests/versions';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { CollaborationCheckpointSupersededError, materializeCollaborationCheckpoint } from './checkpoint';
import { COLLABORATION_CHECKPOINT_ERROR_CODES } from './checkpoint-errors';
import { logCollaborationDiagnostic } from './diagnostics';
import { loadCollaborationState, type PersistedCollaborationState } from './persistence';
import { hasPendingCollaborationProjection, listPendingCollaborationProjections, loadCollaborationProjectionWorkspace, recordCollaborationProjectionFailure } from './projection-repository';
import { classifyCollaborationProjectionError } from './projection-errors';
import { createCollaborationProjectionScheduler } from './projection-scheduler';

type ProjectionFailure = {
  state: PersistedCollaborationState;
  code: string;
  blocksEditing: boolean;
  permanent?: boolean;
  phase?: string;
  causeCode?: string;
};

class ProjectionAttemptError extends Error {
  constructor(readonly failure: ProjectionFailure, readonly durationMs: number) {
    super(failure.code);
  }
}

/** Background file output. It neither writes nor keeps a writable Yjs replica. */
export function createCollaborationProjectionRuntime(callbacks: {
  onProjected: (result: Awaited<ReturnType<typeof materializeCollaborationCheckpoint>>) => void;
  onFailure: (failure: ProjectionFailure) => void;
}) {
  let disposed = false;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduler = createCollaborationProjectionScheduler({
    shouldRetry: (error) => !(error instanceof ProjectionAttemptError) || !error.failure.permanent,
    async project(request) {
      const observed = await loadCollaborationState(request.documentId);
      if (!observed || observed.status !== 'active' || observed.lifecycleGeneration !== request.lifecycleGeneration || disposed) return;
      return withWorkspaceMutationLock(observed.workspaceId, async () => {
        // A synchronous reviewed operation may have completed this projection while
        // we waited for its workspace lock. Reload before deciding to replace an inode.
        const state = await loadCollaborationState(request.documentId);
        if (!state || state.status !== 'active' || state.workspaceId !== observed.workspaceId
          || state.lifecycleGeneration !== request.lifecycleGeneration || state.degraded || state.projectionError?.permanent || disposed) return;
        if (!await hasPendingCollaborationProjection(state)) return;
        const workspace = await loadCollaborationProjectionWorkspace(state);
        if (!workspace || disposed) return;
        const startedAt = performance.now();
        try {
          const result = await materializeCollaborationCheckpoint({ state, workspace, actorType: 'system' });
          logCollaborationDiagnostic('debug', { event: 'projection_completed', documentId: state.documentId,
            workspaceId: state.workspaceId, generation: state.lifecycleGeneration,
            documentSequence: result.state.documentSequence, checkpointSequence: result.state.checkpointSequence,
            durationMs: Math.round(performance.now() - startedAt),
            lag: Math.max(0, result.state.documentSequence - result.state.checkpointSequence) });
          if (!disposed) callbacks.onProjected(result);
          if (result.state.documentSequence > result.state.checkpointSequence) scheduler.enqueue(result.state);
          try { await recordFileGuestVersion(result.state); }
          catch {
            logCollaborationDiagnostic('warn', { event: 'guest_version_failed', documentId: state.documentId,
              generation: state.lifecycleGeneration, code: 'COLLABORATION_GUEST_VERSION_FAILED' });
          }
        } catch (error) {
          if (error instanceof CollaborationCheckpointSupersededError) {
            logCollaborationDiagnostic('debug', { event: 'projection_superseded', documentId: state.documentId,
              generation: state.lifecycleGeneration, documentSequence: state.documentSequence });
            const latest = await loadCollaborationState(state.documentId);
            if (latest) scheduler.enqueue(latest);
            return;
          }
          const failure = classifyCollaborationProjectionError(error);
          try { await recordCollaborationProjectionFailure(state, failure); }
          catch (statusError) {
            const statusFailure = classifyCollaborationProjectionError(statusError);
            logCollaborationDiagnostic('warn', { event: 'projection_failure_status_failed', documentId: state.documentId,
              generation: state.lifecycleGeneration, code: statusFailure.code, causeCode: statusFailure.causeCode });
          }
          if (failure.permanent) {
            const latest = await loadCollaborationState(state.documentId).catch(() => state);
            if (!latest || latest.status !== 'active' || latest.lifecycleGeneration !== state.lifecycleGeneration
              || latest.documentSequence !== state.documentSequence) {
              if (latest?.status === 'active') scheduler.enqueue(latest);
              logCollaborationDiagnostic('debug', { event: 'projection_superseded', documentId: state.documentId,
                generation: state.lifecycleGeneration, documentSequence: state.documentSequence });
              return;
            }
          }
          throw new ProjectionAttemptError({ state, ...failure }, Math.round(performance.now() - startedAt));
        }
      });
    },
    onError(error, request, attempt) {
      const failure = error instanceof ProjectionAttemptError ? error.failure : null;
      logCollaborationDiagnostic('warn', { event: 'projection_failed', documentId: request.documentId,
        workspaceId: failure?.state.workspaceId, generation: request.lifecycleGeneration,
        documentSequence: failure?.state.documentSequence ?? request.documentSequence,
        checkpointSequence: failure?.state.checkpointSequence,
        durationMs: error instanceof ProjectionAttemptError ? error.durationMs : undefined,
        attempt, code: failure?.code ?? COLLABORATION_CHECKPOINT_ERROR_CODES.failed,
        phase: failure?.phase, causeCode: failure?.causeCode, permanent: failure?.permanent });
      if (failure && !disposed) callbacks.onFailure(failure);
    },
  });

  async function recover() {
    try {
      let cursor = '';
      while (!disposed) {
        const batch = await listPendingCollaborationProjections(cursor);
        if (disposed) return;
        for (const request of batch) scheduler.enqueue(request);
        if (batch.length < 100) break;
        cursor = batch.at(-1)!.documentId;
      }
    } catch {
      logCollaborationDiagnostic('warn', { event: 'projection_recovery_failed', code: 'COLLABORATION_PROJECTION_SCAN_FAILED' });
    } finally {
      if (!disposed) {
        recoveryTimer = setTimeout(() => { void recover(); }, 30_000);
        recoveryTimer.unref?.();
      }
    }
  }
  void recover();
  return {
    enqueue: scheduler.enqueue,
    dispose() {
      disposed = true;
      if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
      scheduler.dispose();
    },
  };
}
