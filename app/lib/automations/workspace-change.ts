import 'server-only';

import { resolveExecutableAgentRuntime } from '@/app/lib/agent-runtime-policy/provider-runtime';
import { getAgentProfile } from '@/app/lib/agents/registry';
import { getChannelDeliveryReadiness } from '@/app/lib/channels/availability';
import { WEB_CHANNEL_ID } from '@/app/lib/channels/constants';
import { resolveComposioContext } from '@/app/lib/composio/composio-context';
import { getGatewayStatus } from '@/app/lib/composio/composio-gateway';
import { findOwnedPiSessionForRuntime, isPiSessionInWorkspace } from '@/app/lib/pi/session-runtime-access';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import { loadSkillsFromDisk } from '@/app/lib/skills/skill-loader';
import { readEnabledSkillsForScope } from '@/app/lib/skills/skill-settings';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import {
  resolveAutomationScopeForWorkspaceChange,
  type AutomationPolicyUser,
  type ResolvedAutomationScope,
} from './policy';
import {
  AutomationWorkspaceChangeConflictError,
  getAutomationJob,
  hasInFlightAutomationRun,
  moveAutomationJobToWorkspace,
} from './store';
import type {
  AutomationJobRecord,
  AutomationWorkspaceChangeIssue,
  AutomationWorkspaceChangePreview,
} from './types';

type PreparedAutomationWorkspaceChange = {
  preview: AutomationWorkspaceChangePreview;
  target: ResolvedAutomationScope;
  responsibleUserId: string;
};

function issue(
  code: AutomationWorkspaceChangeIssue['code'],
  severity: AutomationWorkspaceChangeIssue['severity'],
  message: string,
  details: Pick<AutomationWorkspaceChangeIssue, 'field' | 'value'> = {},
): AutomationWorkspaceChangeIssue {
  return { code, severity, message, ...details };
}

async function resolveExecutionWorkspace(
  job: AutomationJobRecord,
  target: ResolvedAutomationScope,
  actorUserId: string,
): Promise<{ workspace: WorkspaceContext; responsibleUserId: string }> {
  if (target.scope === 'personal') {
    return { workspace: target.workspace, responsibleUserId: actorUserId };
  }

  const responsibleUserId = job.responsibleUserId || job.createdByUserId;
  if (responsibleUserId === actorUserId) {
    return { workspace: target.workspace, responsibleUserId };
  }

  const workspace = await resolveAgentSessionWorkspaceForUser({
    userId: responsibleUserId,
    workspaceId: target.workspaceId,
    permissions: ['canRead', 'canWrite', 'canRunAgent'],
  });
  return { workspace, responsibleUserId };
}

async function sourceWorkspaceSummary(job: AutomationJobRecord, actorUserId: string) {
  if (!job.workspaceId) {
    return {
      id: 'personal',
      type: job.workspaceType,
      name: 'Personal Workspace',
    };
  }
  try {
    const workspace = await resolveAgentSessionWorkspaceForUser({
      userId: actorUserId,
      workspaceId: job.workspaceId,
      permissions: ['canRead'],
    });
    return {
      id: workspace.workspaceId,
      type: workspace.workspaceType,
      name: workspace.displayName || workspace.workspaceId,
    };
  } catch {
    return {
      id: job.workspaceId,
      type: job.workspaceType,
      name: job.workspaceId,
    };
  }
}

async function prepareAutomationWorkspaceChange(
  job: AutomationJobRecord,
  targetWorkspaceId: string,
  user: AutomationPolicyUser,
): Promise<PreparedAutomationWorkspaceChange> {
  const target = await resolveAutomationScopeForWorkspaceChange(targetWorkspaceId, user);
  const issues: AutomationWorkspaceChangeIssue[] = [];
  let resetPreferredSkill = false;
  let resetFixedDeliverySession = false;

  if (job.workspaceId === target.workspaceId) {
    issues.push(issue('SAME_WORKSPACE', 'blocker', 'This automation already runs in the selected workspace.'));
  }
  if (job.scope !== target.scope) {
    issues.push(issue(
      'SCOPE_CHANGE',
      'warning',
      target.scope === 'personal'
        ? 'This shared automation will become personal and will only be visible to you.'
        : 'This personal automation will become shared with permitted members of the target workspace.',
    ));
  }
  if (await hasInFlightAutomationRun(job.id)) {
    issues.push(issue(
      'IN_FLIGHT_RUN',
      'blocker',
      'A run is pending, running, or waiting for a retry. Wait until it has finished before changing the workspace.',
    ));
  }

  let executionWorkspace = target.workspace;
  let responsibleUserId = target.scope === 'personal'
    ? user.id
    : job.responsibleUserId || job.createdByUserId;
  try {
    const execution = await resolveExecutionWorkspace(job, target, user.id);
    executionWorkspace = execution.workspace;
    responsibleUserId = execution.responsibleUserId;
  } catch {
    issues.push(issue(
      'EXECUTOR_NO_ACCESS',
      'blocker',
      'The user responsible for this automation cannot read, write, and run the agent in the target workspace.',
    ));
  }

  const agent = await getAgentProfile(job.agentId);
  if (!agent) {
    issues.push(issue(
      'AGENT_UNAVAILABLE',
      'blocker',
      `The configured agent "${job.agentId}" is no longer available.`,
      { field: 'agentId', value: job.agentId },
    ));
  }

  if (job.preferredSkill && job.preferredSkill !== 'auto') {
    try {
      const skillScope = { userId: responsibleUserId };
      const enabledSkills = await readEnabledSkillsForScope(skillScope);
      const skills = await loadSkillsFromDisk(enabledSkills, skillScope);
      const selectedSkill = skills.find((candidate) => candidate.name === job.preferredSkill && candidate.enabled !== false);
      if (!selectedSkill) {
        resetPreferredSkill = true;
        issues.push(issue(
          'SKILL_RESET',
          'change',
          `The preferred skill "${job.preferredSkill}" is not available to the responsible user and will be reset to automatic selection.`,
          { field: 'preferredSkill', value: job.preferredSkill },
        ));
      }
    } catch {
      resetPreferredSkill = true;
      issues.push(issue(
        'SKILL_RESET',
        'change',
        'The preferred skill could not be validated and will be reset to automatic selection.',
        { field: 'preferredSkill', value: job.preferredSkill },
      ));
    }
  }

  if (job.deliverySessionMode === 'fixed_session') {
    const fixedSession = job.deliverySessionId
      ? await findOwnedPiSessionForRuntime({
          sessionId: job.deliverySessionId,
          userId: responsibleUserId,
          agentId: job.agentId,
        })
      : null;
    if (!fixedSession || !isPiSessionInWorkspace(fixedSession, executionWorkspace)) {
      resetFixedDeliverySession = true;
      issues.push(issue(
        'FIXED_SESSION_RESET',
        'change',
        'The fixed delivery session belongs to another workspace and will be replaced with a new session.',
        { field: 'deliverySessionId', value: job.deliverySessionId || undefined },
      ));
    }
  }


  if (agent && !issues.some((entry) => entry.code === 'EXECUTOR_NO_ACCESS')) {
    try {
      if (!executionWorkspace.organizationId) {
        throw new Error('Organization runtime context is missing.');
      }
      await resolveExecutableAgentRuntime({
        organizationId: executionWorkspace.organizationId,
        userId: responsibleUserId,
        workspaceId: executionWorkspace.workspaceId,
        workspaceType: executionWorkspace.workspaceType,
        agentId: job.agentId,
        sessionId: null,
        requestedSelection: null,
        executionMode: job.scope === 'organization'
          ? 'organization_automation' as const
          : 'personal_automation' as const,
        principal: job.scope === 'organization'
          ? {
              type: 'organization_service' as const,
              serviceActorId: job.serviceActorId || `org-service:${executionWorkspace.organizationId}`,
              responsibleUserId,
              credentialSubjectUserId: null,
            }
          : {
              type: 'user' as const,
              userId: responsibleUserId,
              credentialSubjectUserId: responsibleUserId,
            },
      });
    } catch (error) {
      issues.push(issue(
        'RUNTIME_UNAVAILABLE',
        'blocker',
        error instanceof Error
          ? `No executable AI runtime is available in the target workspace: ${error.message}`
          : 'No executable AI runtime is available in the target workspace.',
      ));
    }
  }

  const deliveryChannelId = job.deliveryChannelId || WEB_CHANNEL_ID;
  try {
    const readiness = await getChannelDeliveryReadiness({
      channelId: deliveryChannelId,
      userId: responsibleUserId,
      channelSessionKey: job.deliveryChannelSessionKey,
    });
    if (!readiness.ok) {
      issues.push(issue(
        'DELIVERY_UNAVAILABLE',
        'warning',
        `The delivery channel is currently unavailable: ${readiness.error}`,
        { field: 'deliveryChannelId', value: deliveryChannelId },
      ));
    }
  } catch (error) {
    issues.push(issue(
      'DELIVERY_UNAVAILABLE',
      'warning',
      error instanceof Error ? `The delivery channel could not be validated: ${error.message}` : 'The delivery channel could not be validated.',
      { field: 'deliveryChannelId', value: deliveryChannelId },
    ));
  }

  if (job.composioConnectedAccountId) {
    try {
      const composioContext = await resolveComposioContext({
        userId: responsibleUserId,
        workspaceId: executionWorkspace.workspaceId,
      });
      const status = await getGatewayStatus(composioContext);
      const connected = status.configured
        && status.apiKeyValid
        && status.connectedAccounts.some((account) => account.id === job.composioConnectedAccountId);
      if (!connected) {
        issues.push(issue(
          'COMPOSIO_CONNECTION_UNAVAILABLE',
          'warning',
          'The Composio account used by this trigger is no longer connected for the responsible user.',
          { field: 'composioConnectedAccountId', value: job.composioConnectedAccountId },
        ));
      }
    } catch (error) {
      issues.push(issue(
        'COMPOSIO_CONNECTION_UNAVAILABLE',
        'warning',
        error instanceof Error ? `The Composio connection could not be validated: ${error.message}` : 'The Composio connection could not be validated.',
        { field: 'composioConnectedAccountId', value: job.composioConnectedAccountId },
      ));
    }
  }

  const sourceWorkspace = await sourceWorkspaceSummary(job, user.id);
  const preview: AutomationWorkspaceChangePreview = {
    jobId: job.id,
    sourceWorkspace,
    targetWorkspace: {
      id: target.workspace.workspaceId,
      type: target.workspaceType,
      name: target.workspace.displayName || target.workspace.workspaceId,
    },
    nextScope: target.scope,
    canChange: !issues.some((entry) => entry.severity === 'blocker'),
    issues,
    changes: {
      resetPreferredSkill,
      resetFixedDeliverySession,
    },
  };

  return { preview, target, responsibleUserId };
}

export async function previewAutomationWorkspaceChange(
  job: AutomationJobRecord,
  targetWorkspaceId: string,
  user: AutomationPolicyUser,
): Promise<AutomationWorkspaceChangePreview> {
  return (await prepareAutomationWorkspaceChange(job, targetWorkspaceId, user)).preview;
}

export async function applyAutomationWorkspaceChange(
  jobId: string,
  targetWorkspaceId: string,
  user: AutomationPolicyUser,
): Promise<{ job: AutomationJobRecord; preview: AutomationWorkspaceChangePreview }> {
  const job = await getAutomationJob(jobId);
  if (!job) throw new Error('Automation job not found.');
  const prepared = await prepareAutomationWorkspaceChange(job, targetWorkspaceId, user);
  if (!prepared.preview.canChange) {
    throw new AutomationWorkspaceChangeConflictError(
      prepared.preview.issues.find((entry) => entry.severity === 'blocker')?.message
        || 'The automation workspace cannot be changed.',
    );
  }
  const moved = await moveAutomationJobToWorkspace(jobId, prepared.target, {
    actorUserId: user.id,
    responsibleUserId: prepared.responsibleUserId,
    resetPreferredSkill: prepared.preview.changes.resetPreferredSkill,
    resetFixedDeliverySession: prepared.preview.changes.resetFixedDeliverySession,
  });
  return { job: moved, preview: prepared.preview };
}
