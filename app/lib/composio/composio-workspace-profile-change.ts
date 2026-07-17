import 'server-only';

import {
  listComposioTriggerJobsForResponsibleWorkspace,
  updateAutomationJob,
  updateComposioAutomationTriggerBinding,
} from '@/app/lib/automations/store';
import type { AutomationJobRecord } from '@/app/lib/automations/types';
import {
  composioContextFromEffectiveProfile,
  resolveBoundComposioContext,
  type ResolvedComposioContext,
} from './composio-context';
import {
  createGatewayTrigger,
  deleteGatewayTrigger,
  getGatewayStatus,
  updateGatewayTrigger,
} from './composio-gateway';
import {
  clearComposioWorkspaceProfileOverride,
  ensureDefaultComposioProfile,
  resolveEffectiveComposioProfile,
  resolveOwnedComposioProfileBinding,
  setComposioWorkspaceProfileOverride,
} from './composio-profiles';

export type ComposioTriggerProfileChangeResult = {
  jobId: string;
  jobName: string;
  toolkitSlug: string;
  status: 'unchanged' | 'migrated' | 'paused_missing_connection' | 'paused_repair_required';
  message?: string;
};

export type ComposioWorkspaceProfileChangeResult = {
  effectiveContext: ResolvedComposioContext;
  triggerChanges: ComposioTriggerProfileChangeResult[];
};

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function triggerIdentity(value: unknown): { triggerId: string; connectedAccountId: string } {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    triggerId: stringValue(record.triggerId) || stringValue(record.trigger_id) || stringValue(record.id),
    connectedAccountId: stringValue(record.connectedAccountId) || stringValue(record.connected_account_id),
  };
}

async function resolveJobBindingContext(job: AutomationJobRecord): Promise<ResolvedComposioContext> {
  const responsibleUserId = job.responsibleUserId || job.ownerUserId || job.createdByUserId;
  return resolveBoundComposioContext({
    userId: responsibleUserId,
    workspaceId: job.workspaceId,
    profileId: job.composioProfileId,
    composioUserId: job.composioUserId,
  });
}

async function pauseBoundTrigger(job: AutomationJobRecord, actorUserId: string): Promise<void> {
  if (job.composioTriggerId) {
    const oldContext = await resolveJobBindingContext(job);
    await updateGatewayTrigger(job.composioTriggerId, { status: 'paused' }, oldContext);
  }
  await updateAutomationJob(job.id, { status: 'paused' }, { actorUserId });
}

async function migrateTrigger(input: {
  job: AutomationJobRecord;
  targetContext: ResolvedComposioContext;
  targetConnectedAccountId: string;
  actorUserId: string;
}): Promise<ComposioTriggerProfileChangeResult> {
  const { job, targetContext, targetConnectedAccountId, actorUserId } = input;
  const toolkitSlug = job.composioToolkitSlug || '';
  if (!job.composioTriggerId || !job.composioTriggerSlug || !toolkitSlug) {
    await updateAutomationJob(job.id, { status: 'paused' }, { actorUserId });
    return {
      jobId: job.id,
      jobName: job.name,
      toolkitSlug,
      status: 'paused_repair_required',
      message: 'The existing trigger binding is incomplete and must be repaired.',
    };
  }

  let oldContext: ResolvedComposioContext;
  try {
    oldContext = await resolveJobBindingContext(job);
  } catch (error) {
    await updateAutomationJob(job.id, { status: 'paused' }, { actorUserId });
    return {
      jobId: job.id,
      jobName: job.name,
      toolkitSlug,
      status: 'paused_repair_required',
      message: error instanceof Error ? error.message : 'The previous trigger profile is unavailable.',
    };
  }

  let newTriggerId = '';
  let newConnectedAccountId = '';
  let oldTriggerPaused = false;
  let bindingUpdated = false;
  try {
    const created = await createGatewayTrigger({
      triggerSlug: job.composioTriggerSlug,
      toolkitSlug,
      connectedAccountId: targetConnectedAccountId,
      triggerConfig: job.webhookTriggerConfig || {},
    }, targetContext);
    const createdIdentity = triggerIdentity(created.trigger);
    newTriggerId = createdIdentity.triggerId;
    newConnectedAccountId = createdIdentity.connectedAccountId || targetConnectedAccountId;
    if (!newTriggerId || !newConnectedAccountId) {
      throw new Error('Composio did not return a complete replacement trigger binding.');
    }

    await updateGatewayTrigger(newTriggerId, { status: 'paused' }, targetContext);
    await updateGatewayTrigger(job.composioTriggerId, { status: 'paused' }, oldContext);
    oldTriggerPaused = true;

    const rebound = await updateComposioAutomationTriggerBinding({
      jobId: job.id,
      actorUserId,
      status: 'paused',
      triggerId: newTriggerId,
      connectedAccountId: newConnectedAccountId,
      profileId: targetContext.profileId,
      composioUserId: targetContext.composioUserId,
    });
    if (!rebound) throw new Error('The replacement trigger could not be saved.');
    bindingUpdated = true;

    if (job.status === 'active') {
      await updateGatewayTrigger(newTriggerId, { status: 'active' }, targetContext);
      await updateAutomationJob(job.id, { status: 'active' }, { actorUserId });
    }

    await deleteGatewayTrigger(job.composioTriggerId, oldContext).catch((error) => {
      console.warn('[Composio] The old paused trigger could not be deleted after migration:', error);
    });
    return {
      jobId: job.id,
      jobName: job.name,
      toolkitSlug,
      status: 'migrated',
    };
  } catch (error) {
    if (!bindingUpdated && newTriggerId) {
      await deleteGatewayTrigger(newTriggerId, targetContext).catch(() => undefined);
    }
    if (!bindingUpdated && oldTriggerPaused && job.status === 'active') {
      await updateGatewayTrigger(job.composioTriggerId, { status: 'active' }, oldContext).catch(() => undefined);
    }
    await updateAutomationJob(job.id, { status: bindingUpdated ? 'paused' : job.status }, { actorUserId });
    return {
      jobId: job.id,
      jobName: job.name,
      toolkitSlug,
      status: 'paused_repair_required',
      message: error instanceof Error ? error.message : 'The trigger could not be migrated safely.',
    };
  }
}

export async function changeComposioWorkspaceProfile(input: {
  userId: string;
  workspaceId: string;
  profileId?: string | null;
}): Promise<ComposioWorkspaceProfileChangeResult> {
  const userId = input.userId.trim();
  const profileId = input.profileId?.trim() || null;
  const targetProfile = profileId
    ? await resolveOwnedComposioProfileBinding({ userId, workspaceId: input.workspaceId, profileId })
    : await ensureDefaultComposioProfile(userId).then((profile) => resolveOwnedComposioProfileBinding({
        userId,
        workspaceId: input.workspaceId,
        profileId: profile.id,
      }));
  const targetContext = composioContextFromEffectiveProfile(userId, targetProfile);
  const [jobs, targetStatus] = await Promise.all([
    listComposioTriggerJobsForResponsibleWorkspace({ userId, workspaceId: targetContext.workspaceId }),
    getGatewayStatus(targetContext),
  ]);
  const connectedAccountByToolkit = new Map(
    targetStatus.connectedAccounts
      .filter((account) => account.toolkit.slug)
      .map((account) => [account.toolkit.slug, account.id]),
  );

  const effective = targetProfile.isDefault
    ? await clearComposioWorkspaceProfileOverride({ userId, workspaceId: targetContext.workspaceId })
    : await setComposioWorkspaceProfileOverride({
        userId,
        workspaceId: targetContext.workspaceId,
        profileId: targetProfile.id,
      });
  const effectiveContext = composioContextFromEffectiveProfile(userId, effective);
  const triggerChanges: ComposioTriggerProfileChangeResult[] = [];

  for (const job of jobs) {
    const toolkitSlug = job.composioToolkitSlug || '';
    if (job.composioUserId === effectiveContext.composioUserId) {
      if (job.composioProfileId !== effectiveContext.profileId
        && job.composioTriggerId
        && job.composioConnectedAccountId) {
        await updateComposioAutomationTriggerBinding({
          jobId: job.id,
          actorUserId: userId,
          status: job.status,
          triggerId: job.composioTriggerId,
          connectedAccountId: job.composioConnectedAccountId,
          profileId: effectiveContext.profileId,
          composioUserId: effectiveContext.composioUserId,
        });
      }
      triggerChanges.push({ jobId: job.id, jobName: job.name, toolkitSlug, status: 'unchanged' });
      continue;
    }

    const targetConnectedAccountId = connectedAccountByToolkit.get(toolkitSlug) || '';
    if (!targetConnectedAccountId) {
      try {
        await pauseBoundTrigger(job, userId);
      } catch (error) {
        await updateAutomationJob(job.id, { status: 'paused' }, { actorUserId: userId });
        console.warn('[Composio] Could not pause the provider trigger after a profile change:', error);
      }
      triggerChanges.push({
        jobId: job.id,
        jobName: job.name,
        toolkitSlug,
        status: 'paused_missing_connection',
        message: `Connect ${toolkitSlug || 'the required app'} in the selected profile to repair this automation.`,
      });
      continue;
    }

    triggerChanges.push(await migrateTrigger({
      job,
      targetContext: effectiveContext,
      targetConnectedAccountId,
      actorUserId: userId,
    }));
  }

  return {
    effectiveContext: composioContextFromEffectiveProfile(
      userId,
      await resolveEffectiveComposioProfile({ userId, workspaceId: effectiveContext.workspaceId }),
    ),
    triggerChanges,
  };
}
