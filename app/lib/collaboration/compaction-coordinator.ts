import 'server-only';

import { captureCollaborationCompactionRequest } from './compaction-contract';
import { createCollaborationCompactionHandoffService } from './compaction-handoff';
import { CollaborationRepresentationMigrationError, prepareCollaborationCompactionAdmission } from './persistence';
import { captureCollaborationAdmissionScopeTargets, createCollaborationAdmissionService } from './room-admission';
import { captureCollaborationAdmissionRequest, CollaborationAdmissionError,
  type CollaborationAdmissionRequest } from './room-admission-contract';
import { createCollaborationAdmissionHandoffService } from './room-admission-handoff';
import type { CollaborationAdmissionOutcome } from './room-admission-outcome';
import { createCollaborationAdmissionQuiescenceService } from './room-admission-quiescence';

type Authorization = {
  /** Bounded permission read; must not acquire collaboration/workspace/path locks. */
  authorize: (request: CollaborationAdmissionRequest) => Promise<void>;
};
type Identity = Readonly<{ requestId: string; requestDigest: string }>;
export type CollaborationCompactionProgress =
  | Readonly<{ status: 'completed'; outcome: CollaborationAdmissionOutcome }>
  | (Identity & Readonly<{ status: 'pending'; phase: 'quiescence' | 'handoff' }>)
  | (Identity & Readonly<{ status: 'cancelled' }>);

function isAdmissionError(error: unknown, code: CollaborationAdmissionError['code']): boolean {
  return error instanceof CollaborationAdmissionError && error.code === code;
}

/**
 * One bounded advancement, with durable admission polling doing the owner work.
 * Call outside workspace/path/room locks. A pending response owns no SQL session
 * or lock; resume the same request, never invent a replacement ID on timeout.
 * No runtime/worker installation and no cancellation on disconnect/deadline.
 */
export function createCollaborationCompactionCoordinator(options:
  Parameters<typeof createCollaborationCompactionHandoffService>[0] & {
    /** Deployment readiness for NEW reservations; does not disable recovery. */
    assertCanStartAdmission: (request: CollaborationAdmissionRequest) => Promise<void>;
  }) {
  const admission = createCollaborationAdmissionService(options);
  const quiescence = createCollaborationAdmissionQuiescenceService(options);
  const compaction = createCollaborationCompactionHandoffService(options);
  // Trusted historical reads share the existing validator, never mutation rights.
  const history = createCollaborationAdmissionHandoffService(options);
  const completed = (outcome: CollaborationAdmissionOutcome): CollaborationCompactionProgress =>
    Object.freeze({ status: 'completed', outcome });

  const preflight = async (request: CollaborationAdmissionRequest, authorization: Authorization) => {
    const captured = captureCollaborationAdmissionRequest(request);
    await options.withMutationLocks(captured.workspaceIds, async () => {
      const database = await options.openConnection();
      try {
        await database.run('BEGIN');
        await database.run("SET LOCAL statement_timeout = '5s'");
        await database.run("SET LOCAL lock_timeout = '4s'");
        await prepareCollaborationCompactionAdmission(database, request);
        // Same contract as handoff.prepare: reauthorize after domain locks but
        // before taking document-state locks; never call an arbitrary agent task.
        await authorization.authorize(request);
        const [target] = await captureCollaborationAdmissionScopeTargets(database, captured);
        const row = await database.get(`SELECT degraded, checkpoint_sequence FROM collaboration_yjs_states
          WHERE document_id = $1 FOR UPDATE`, [target.document.documentId]) as Record<string, unknown> | undefined;
        const rawCheckpoint = row?.checkpoint_sequence;
        const checkpoint = typeof rawCheckpoint === 'number'
          || (typeof rawCheckpoint === 'string' && rawCheckpoint === String(Number(rawCheckpoint)))
          ? Number(rawCheckpoint) : Number.NaN;
        // PostgreSQL bigint values arrive as strings; do not coerce null,
        // empty text or arbitrary falsy values into a healthy zero state.
        if (!row || (row.degraded !== 0 && row.degraded !== false && row.degraded !== '0')
          || !Number.isSafeInteger(checkpoint) || checkpoint < target.documentSequence) {
          throw new CollaborationRepresentationMigrationError(
            'Compaction requires a healthy confirmed file checkpoint.', 'checkpoint_stale');
        }
        if (target.documentSequence >= Number.MAX_SAFE_INTEGER
          || target.document.lifecycleGeneration >= Number.MAX_SAFE_INTEGER) {
          throw new CollaborationRepresentationMigrationError('Compaction counters cannot advance safely.', 'state_changed');
        }
      } finally {
        // Read-only preflight has no COMMIT ambiguity and releases every lock
        // before reservation. Scope and domain preconditions are checked again later.
        await database.close(new Error('Discarding read-only compaction preflight session.'));
      }
    });
  };

  const advanceCaptured = async (request: CollaborationAdmissionRequest,
    authorization: Authorization): Promise<CollaborationCompactionProgress> => {
    const captured = captureCollaborationAdmissionRequest(request);
    const identity = Object.freeze({ requestId: request.requestId, requestDigest: captured.requestDigest });
    const readTerminal = async (): Promise<CollaborationCompactionProgress | null> => {
      // Rights may have changed while waiting on another coordinator or owner.
      await authorization.authorize(request);
      const outcome = await history.readOutcome(request);
      if (outcome) return completed(outcome);
      const current = await admission.read(request);
      if (current?.status === 'cancelled') return Object.freeze({ status: 'cancelled', ...identity });
      if (current?.status === 'recovery_required') throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
      // A COMMIT can fall between these two reads; retrieve its exact result.
      if (current?.status === 'committed') {
        const committed = await history.readOutcome(request);
        if (!committed) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
        return completed(committed);
      }
      return null;
    };
    const pending = async (phase: 'quiescence' | 'handoff'): Promise<CollaborationCompactionProgress> => {
      const terminal = await readTerminal();
      if (terminal) return terminal;
      const current = await admission.read(request);
      if (!current) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
      if (!['reserved', 'draining'].includes(current.status)) {
        return recoverOrThrow(new CollaborationAdmissionError('ADMISSION_STATE_CHANGED'));
      }
      return Object.freeze({ status: 'pending', phase, ...identity });
    };
    const recoverOrThrow = async (error: unknown): Promise<CollaborationCompactionProgress> => {
      // Only a recognized terminalization race can be reconciled here. In
      // particular, never bypass a lower layer's failed/uncertain session close
      // by opening a fresh connection and declaring its operation successful.
      if (!isAdmissionError(error, 'ADMISSION_STATE_CHANGED')
        && !isAdmissionError(error, 'ADMISSION_REQUEST_CHANGED')) throw error;
      const terminal = await readTerminal();
      if (terminal) return terminal;
      throw error;
    };

    const previous = await readTerminal();
    if (previous) return previous;
    let reservation = await admission.read(request);
    if (!reservation) {
      await options.assertCanStartAdmission(request);
      await preflight(request, authorization);
      await authorization.authorize(request);
      await options.assertCanStartAdmission(request);
      reservation = await admission.reserve(request);
    }
    if (!['reserved', 'draining'].includes(reservation.status)) {
      return recoverOrThrow(new CollaborationAdmissionError('ADMISSION_STATE_CHANGED'));
    }

    const document = request.expectedDocuments[0];
    try {
      // Prove before dispatch: a normal unload may already have released the
      // original owner, even though its token is retained in the reservation.
      await quiescence.prove(request, document.documentId);
    } catch (error) {
      if (!isAdmissionError(error, 'ADMISSION_CONFLICT')) return recoverOrThrow(error);
      const target = reservation.targets.find((item) => item.document.documentId === document.documentId);
      if (!target) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
      if (target.ownerToken === null) return pending('quiescence');
      await authorization.authorize(request);
      try {
        await admission.startDrain(request, document.documentId);
      } catch (drainError) {
        if (!isAdmissionError(drainError, 'ADMISSION_STATE_CHANGED')) return recoverOrThrow(drainError);
        // Another coordinator may have proven normal release or completed the
        // same request. Only another exact proof/terminal read may settle this.
      }
      try {
        await quiescence.prove(request, document.documentId);
      } catch (retryError) {
        if (isAdmissionError(retryError, 'ADMISSION_CONFLICT')) return pending('quiescence');
        return recoverOrThrow(retryError);
      }
    }

    try {
      return completed(await compaction.execute(request, authorization));
    } catch (error) {
      if (error instanceof CollaborationRepresentationMigrationError && error.code === 'agent_operation_pending') {
        // Narrow domain policy: releasing the proven reservation lets those
        // pending reviews proceed. The abort rechecks this cause under locks.
        try { return completed(await compaction.abort(request, authorization, 'precondition_failed')); }
        catch (abortError) {
          if (isAdmissionError(abortError, 'ADMISSION_CONFLICT')
            || isAdmissionError(abortError, 'ADMISSION_STATE_CHANGED')) return pending('handoff');
          return recoverOrThrow(abortError);
        }
      }
      if (isAdmissionError(error, 'ADMISSION_CONFLICT')) return pending('handoff');
      return recoverOrThrow(error);
    }
  };

  return {
    advance(input: CollaborationAdmissionRequest, authorization: Authorization) {
      const { request } = captureCollaborationCompactionRequest(input);
      return advanceCaptured(request, authorization);
    },
    async resume(requestId: string, authorization: Authorization): Promise<CollaborationCompactionProgress> {
      const input = await history.loadRequest(requestId);
      if (!input || input.requestId !== requestId) throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
      const { request } = captureCollaborationCompactionRequest(input);
      return advanceCaptured(request, authorization);
    },
  };
}
