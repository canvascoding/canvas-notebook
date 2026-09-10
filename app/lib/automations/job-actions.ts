import 'server-only';

import { assertCanAccessAutomationJob } from './policy';
import { updateAutomationJob, type AutomationStoreTransaction } from './store';
import type { AutomationJobRecord, UpdateAutomationJobInput } from './types';
import { AutomationMutationError } from './mutation-errors';
import { resolveBoundComposioContext } from '@/app/lib/composio/composio-context';
import { prepareGatewayTriggerUpdate } from '@/app/lib/composio/composio-gateway';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';

/** Shared user action for the editor, internal tools, and chat widgets. */
export async function updateAutomationJobForUser(jobId: string, payload: unknown, userId: string, options: {
  expectedRevision?: number;
  expectedUpdatedAt?: string;
  onUpdated?: (job: AutomationJobRecord, tx: AutomationStoreTransaction) => Promise<void>;
} = {}): Promise<AutomationJobRecord> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AutomationMutationError('Invalid automation update.', 400, 'INVALID_AUTOMATION_UPDATE');
  }
  const input = payload as UpdateAutomationJobInput;
  if ('scope' in input || 'workspaceId' in input) {
    throw new AutomationMutationError('Automation scope and workspace cannot be changed after creation.', 400, 'INVALID_AUTOMATION_SCOPE');
  }
  if (input.status !== undefined && input.status !== 'active' && input.status !== 'paused') {
    throw new AutomationMutationError('Invalid automation status.', 400, 'INVALID_AUTOMATION_STATUS');
  }
  if (options.expectedRevision !== undefined && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1)) {
    throw new AutomationMutationError('Invalid automation revision.', 400, 'INVALID_AUTOMATION_REVISION');
  }
  let changed = false;
  let updateTrigger: Awaited<ReturnType<typeof prepareGatewayTriggerUpdate>> | undefined;
  const updated = await updateAutomationJob(jobId, input, {
    actorUserId: userId, expectedRevision: options.expectedRevision, expectedUpdatedAt: options.expectedUpdatedAt, skipUnchangedStatus: true,
    authorize: async (existing) => {
      try { await assertCanAccessAutomationJob(userId, existing); }
      catch { throw new AutomationMutationError('Automation not found.', 404, 'AUTOMATION_UNAVAILABLE'); }
      if (existing.deletedAt) throw new AutomationMutationError('Automation not found.', 404, 'AUTOMATION_UNAVAILABLE');
      if (input.status === 'active' && existing.integrityStatus !== 'valid') {
        throw new AutomationMutationError('Resolve the automation configuration before activating it.', 409, 'AUTOMATION_QUARANTINED');
      }
      const responsible = existing.responsibleUserId || existing.ownerUserId || existing.createdByUserId;
      if (existing.composioTriggerId && input.status !== undefined && responsible !== userId) {
        throw new AutomationMutationError('Only the user responsible for this automation can change its private Composio trigger.', 409, 'PRIVATE_COMPOSIO_CONNECTION');
      }
      if (existing.composioTriggerId && input.status !== undefined && input.status !== existing.status) {
        const context = await resolveBoundComposioContext({ userId: responsible,
          workspaceId: existing.workspaceId, profileId: existing.composioProfileId, composioUserId: existing.composioUserId });
        updateTrigger = await prepareGatewayTriggerUpdate(context);
      }
    },
    beforeCommit: async (next, existing, tx) => {
      // Store validation and the revision fence have completed under the row lock.
      // Persist the chat event in this transaction before touching the provider.
      await options.onUpdated?.(next, tx);
      if (existing.composioTriggerId && input.status !== undefined && next.status !== existing.status) {
        if (!updateTrigger) throw new Error('Composio status update was not prepared.');
        await updateTrigger(existing.composioTriggerId, { status: next.status });
      }
      changed = true;
    },
  });
  if (!updated) throw new AutomationMutationError('Automation not found.', 404, 'AUTOMATION_UNAVAILABLE');
  if (changed) await recordAuditEvent({
    organizationId: updated.organizationId, workspaceId: updated.workspaceId, userId, agentId: updated.agentId,
    source: 'automations', eventType: 'automation', entityType: 'automation_job', entityId: updated.id,
    action: 'automation_job.update', status: 'success', summary: `Automation job ${updated.id} updated.`,
    metadata: { scope: updated.scope, jobScope: updated.jobScope, status: updated.status,
      revision: updated.revision, changedFields: Object.keys(input).filter((key) => input[key as keyof UpdateAutomationJobInput] !== undefined) },
  });
  return updated;
}
