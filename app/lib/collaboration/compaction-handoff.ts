import 'server-only';

import { captureCollaborationCompactionRequest } from './compaction-contract';
import { createCollaborationAdmissionHandoffService } from './room-admission-handoff';
import type { CollaborationAdmissionRequest } from './room-admission-contract';
import { compactCollaborationStateInAdmissionHandoff, prepareCollaborationCompactionAdmission } from './persistence';

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
