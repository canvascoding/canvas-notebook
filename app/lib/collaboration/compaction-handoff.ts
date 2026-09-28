import 'server-only';

import { captureCollaborationCompactionRequest } from './compaction-contract';
import { createCollaborationAdmissionHandoffService } from './room-admission-handoff';
import { CollaborationAdmissionError, type CollaborationAdmissionRequest } from './room-admission-contract';
import { captureCollaborationAdmissionAbortReason, type CollaborationAdmissionAbortReason } from './room-admission-outcome';
import { compactCollaborationStateInAdmissionHandoff, lockCollaborationCompactionAdmission,
  prepareCollaborationCompactionAdmission } from './persistence';

/**
 * Internal coordinator adapter for an already reserved and proven compaction.
 * It does not enable distributed admission or dispatch owner drains. The caller
 * must supply fresh authorization, dedicated SQL sessions and workspace locks.
 * Completed retries return the historic outcome, never a synthetic current Y.Doc.
 */
export function createCollaborationCompactionHandoffService(
  options: Parameters<typeof createCollaborationAdmissionHandoffService>[0],
) {
  const handoff = createCollaborationAdmissionHandoffService(options);
  return {
    abort(input: CollaborationAdmissionRequest, authorization: {
      authorize: (request: CollaborationAdmissionRequest) => Promise<void>;
    }, reasonCode: CollaborationAdmissionAbortReason = 'user_cancelled') {
      const { request } = captureCollaborationCompactionRequest(input);
      const reason = captureCollaborationAdmissionAbortReason(reasonCode);
      return handoff.abort(request, {
        authorize: authorization.authorize,
        prepare: async (database) => {
          const locked = await lockCollaborationCompactionAdmission(database, request);
          if (reason === 'precondition_failed' && !locked.hasPendingOperations) {
            throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
          }
        },
      }, reason);
    },
    execute(input: CollaborationAdmissionRequest, authorization: {
      authorize: (request: CollaborationAdmissionRequest) => Promise<void>;
    }) {
      const { request, document } = captureCollaborationCompactionRequest(input);
      return handoff.execute(request, {
        authorize: authorization.authorize,
        prepare: async (database) => {
          await prepareCollaborationCompactionAdmission(database, request);
          await authorization.authorize(request);
        },
        mutate: async (database) => {
          const { state, backupId } = await compactCollaborationStateInAdmissionHandoff(database, {
            documentId: document.documentId, expectedLifecycleGeneration: document.lifecycleGeneration,
          });
          return { documentId: state.documentId, backupId,
            lifecycleGeneration: String(state.lifecycleGeneration), documentSequence: String(state.documentSequence) };
        },
      });
    },
  };
}
