import 'server-only';

import { recordFileGuestVersion } from '@/app/lib/file-guests/versions';
import { CollaborationCheckpointSupersededError, materializeCollaborationCheckpoint } from './checkpoint';
import { CollaborationCheckpointValidationError, COLLABORATION_CHECKPOINT_ERROR_CODES } from './checkpoint-errors';
import { logCollaborationDiagnostic } from './diagnostics';
import { loadCollaborationState, markCollaborationDegraded, type PersistedCollaborationState } from './persistence';
import { hasPendingCollaborationProjection, listPendingCollaborationProjections, loadCollaborationProjectionWorkspace } from './projection-repository';
import { createCollaborationProjectionScheduler } from './projection-scheduler';

type ProjectionFailure = {
  state: PersistedCollaborationState;
  code: string;
  blocksEditing: boolean;
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
    async project(request) {
      const state = await loadCollaborationState(request.documentId);
      if (!state || state.lifecycleGeneration !== request.lifecycleGeneration || disposed) return;
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
        const code = error instanceof CollaborationCheckpointValidationError
          ? error.code : COLLABORATION_CHECKPOINT_ERROR_CODES.failed;
        const blocksEditing = error instanceof CollaborationCheckpointValidationError
          && error.validationCode !== 'roundtrip_unstable';
        // Invalid document schema/identities retain their existing protection.
        // Conversion or filesystem failures never revoke confirmed Yjs data.
        if (blocksEditing) await markCollaborationDegraded(state.documentId, state.lifecycleGeneration);
        throw new ProjectionAttemptError({ state, code, blocksEditing }, Math.round(performance.now() - startedAt));
      }
    },
    onError(error, request, attempt) {
      const failure = error instanceof ProjectionAttemptError ? error.failure : null;
      logCollaborationDiagnostic('warn', { event: 'projection_failed', documentId: request.documentId,
        workspaceId: failure?.state.workspaceId, generation: request.lifecycleGeneration,
        documentSequence: failure?.state.documentSequence ?? request.documentSequence,
        checkpointSequence: failure?.state.checkpointSequence,
        durationMs: error instanceof ProjectionAttemptError ? error.durationMs : undefined,
        attempt, code: failure?.code ?? COLLABORATION_CHECKPOINT_ERROR_CODES.failed });
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
