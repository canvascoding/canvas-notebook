import 'server-only';

import { isAdminUser, type AdminUserCandidate } from '@/app/lib/admin-auth';
import {
  hasOrganizationPermission,
  OrganizationPermissionError,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { agentAccessContextForWorkspace, getAgentAccess, type AgentAccessWorkspace } from '@/app/lib/agents/access';
import { getAgentProfile, normalizeManagedAgentId } from '@/app/lib/agents/registry';

import type {
  AutomationScope,
  AutomationWorkspaceType,
} from './types';

export type AutomationPolicyUser = AdminUserCandidate & { id: string };

export type ResolvedAutomationScope = {
  scope: AutomationScope;
  organizationId: string | null;
  workspaceId: string | null;
  workspaceType: AutomationWorkspaceType;
  ownerUserId: string | null;
  responsibleUserId: string | null;
  serviceActorId: string | null;
  approvedByUserId: string | null;
  lastEditedByUserId: string | null;
  workspace: WorkspaceContext;
};

export type AutomationListAccess = {
  userId: string;
  organizationId: string | null;
  canReadOrganizationAutomations: boolean;
};

export class AutomationPolicyError extends Error {
  readonly status = 403;
  readonly code = 'AUTOMATION_POLICY_DENIED';

  constructor(message: string) {
    super(message);
    this.name = 'AutomationPolicyError';
  }
}

/**
 * Email inbox automations always receive their narrowly scoped email tools at
 * runtime. This check therefore validates the agent identity and its access to
 * the selected workspace, rather than requiring generic email tools that would
 * be unsafe in a normal chat session.
 */
export async function assertEmailAutomationAgentCompatible(input: {
  userId: string;
  agentId: string;
  workspace: AgentAccessWorkspace;
}): Promise<void> {
  const agentId = normalizeManagedAgentId(input.agentId);
  const [profile, access] = await Promise.all([
    getAgentProfile(agentId),
    getAgentAccess(input.userId, agentId, agentAccessContextForWorkspace(input.workspace)),
  ]);
  if (!profile) throw new AutomationPolicyError('The selected email automation agent no longer exists.');
  if (!access.canUse) throw new AutomationPolicyError('The selected agent is not available in this workspace.');
}

function readStringField(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? record[key].trim() : '';
}

function normalizeRequestedScope(input: unknown): AutomationScope | 'team' {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return 'personal';
  }

  const record = input as Record<string, unknown>;
  const scope = readStringField(record, 'scope').toLowerCase();
  if (record.organizationScope === true || scope === 'organization') {
    return 'organization';
  }
  if (
    record.teamAutomation === true ||
    scope === 'team' ||
    scope === 'organization' ||
    readStringField(record, 'workspaceScope').toLowerCase() === 'team' ||
    readStringField(record, 'workspaceScope').toLowerCase() === 'organization' ||
    readStringField(record, 'workspaceType').toLowerCase() === 'organization' ||
    readStringField(record, 'workspaceType').toLowerCase() === 'team'
  ) {
    return 'team';
  }

  return 'personal';
}

export function automationInputRequestsNonPersonalScope(input: unknown): boolean {
  return normalizeRequestedScope(input) !== 'personal';
}

function normalizeWorkspaceId(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const workspaceId = readStringField(input as Record<string, unknown>, 'workspaceId');
  return workspaceId || null;
}

async function isLegacyAdminAllowed(user: AutomationPolicyUser): Promise<boolean> {
  const state = await readOrganizationPermissionForUser(user.id);
  return !state.configured && isAdminUser(user);
}

async function assertCanCreateOrganizationAutomation(user: AutomationPolicyUser): Promise<void> {
  const state = await readOrganizationPermissionForUser(user.id);
  if (!state.configured && isAdminUser(user)) {
    console.warn('[Automations] Legacy admin fallback allowed organization automation on unconfigured organization.', {
      userId: user.id,
    });
    return;
  }

  if (!hasOrganizationPermission(state.permission, 'canCreateTeamAutomations')) {
    throw new OrganizationPermissionError('canCreateTeamAutomations', 'Organization automation permission required.');
  }
}

async function resolveAutomationScopeForWorkspace(
  workspace: WorkspaceContext,
  requestedScope: AutomationScope | 'team',
  user: AutomationPolicyUser,
): Promise<ResolvedAutomationScope> {
  if (workspace.workspaceType === 'personal') {
    if (requestedScope !== 'personal') {
      throw new AutomationPolicyError('Organization automations require a team workspace.');
    }
    if (workspace.ownerUserId && workspace.ownerUserId !== user.id) {
      throw new AutomationPolicyError('Personal automations can only run in the owner personal workspace.');
    }

    return {
      scope: 'personal',
      organizationId: workspace.organizationId ?? null,
      workspaceId: workspace.workspaceId,
      workspaceType: 'personal',
      ownerUserId: user.id,
      responsibleUserId: user.id,
      serviceActorId: null,
      approvedByUserId: null,
      lastEditedByUserId: user.id,
      workspace,
    };
  }

  if (workspace.workspaceType !== 'organization' && workspace.workspaceType !== 'team') {
    throw new AutomationPolicyError('Automations are only supported in personal and shared organization workspaces.');
  }

  if (requestedScope === 'personal') {
    throw new AutomationPolicyError('Personal automations require a personal workspace. Please select a personal workspace before creating a personal automation.');
  }

  await assertCanCreateOrganizationAutomation(user);
  if (!workspace.organizationId) {
    throw new AutomationPolicyError('Organization automations require a configured organization workspace.');
  }

  return {
    scope: 'organization',
    organizationId: workspace.organizationId,
    workspaceId: workspace.workspaceId,
    workspaceType: workspace.workspaceType,
    ownerUserId: null,
    responsibleUserId: user.id,
    serviceActorId: `org-service:${workspace.organizationId}`,
    approvedByUserId: user.id,
    lastEditedByUserId: user.id,
    workspace,
  };
}

export async function getAutomationListAccess(userId: string): Promise<AutomationListAccess> {
  const state = await readOrganizationPermissionForUser(userId);
  // Organization automations expose shared prompts, schedules, and run history;
  // keep read visibility aligned with the team-automation authoring permission.
  const canReadOrganizationAutomations = Boolean(
    state.organizationId &&
    hasOrganizationPermission(state.permission, 'canCreateTeamAutomations'),
  );

  return {
    userId,
    organizationId: state.organizationId,
    canReadOrganizationAutomations,
  };
}

export async function resolveAutomationScopeForCreate(input: unknown, user: AutomationPolicyUser): Promise<ResolvedAutomationScope> {
  const requestedScope = normalizeRequestedScope(input);
  const workspaceId = normalizeWorkspaceId(input);
  const workspace = await resolveAgentSessionWorkspaceForUser({
    userId: user.id,
    workspaceId,
    permissions: ['canRead', 'canWrite', 'canRunAgent'],
  });

  return resolveAutomationScopeForWorkspace(workspace, requestedScope, user);
}

export async function resolveAutomationScopeForWorkspaceChange(
  workspaceId: string,
  user: AutomationPolicyUser,
): Promise<ResolvedAutomationScope> {
  const workspace = await resolveAgentSessionWorkspaceForUser({
    userId: user.id,
    workspaceId,
    permissions: ['canRead', 'canWrite', 'canRunAgent'],
  });
  const requestedScope: AutomationScope = workspace.workspaceType === 'personal' ? 'personal' : 'organization';
  return resolveAutomationScopeForWorkspace(workspace, requestedScope, user);
}

export async function canAccessAutomationJob(
  userId: string,
  job: {
    scope?: string | null;
    createdByUserId: string;
    ownerUserId?: string | null;
    responsibleUserId?: string | null;
    organizationId?: string | null;
    workspaceId?: string | null;
  },
): Promise<boolean> {
  const scope = job.scope === 'organization' ? 'organization' : 'personal';
  if (scope === 'personal') {
    return (job.ownerUserId || job.createdByUserId) === userId;
  }

  const state = await readOrganizationPermissionForUser(userId);
  if (!(
    job.organizationId &&
    state.organizationId === job.organizationId &&
    hasOrganizationPermission(state.permission, 'canCreateTeamAutomations') &&
    job.workspaceId
  )) {
    return false;
  }

  try {
    await resolveAgentSessionWorkspaceForUser({
      userId,
      workspaceId: job.workspaceId,
      permissions: ['canRead'],
    });
    return true;
  } catch {
    return false;
  }
}

export async function assertCanAccessAutomationJob(
  userId: string,
  job: Parameters<typeof canAccessAutomationJob>[1],
): Promise<void> {
  if (!(await canAccessAutomationJob(userId, job))) {
    throw new AutomationPolicyError('Automation job is not accessible for this user.');
  }
}

export async function resolveAutomationRunWorkspace(job: {
  createdByUserId: string;
  ownerUserId?: string | null;
  responsibleUserId?: string | null;
  workspaceId?: string | null;
}): Promise<WorkspaceContext> {
  return resolveAgentSessionWorkspaceForUser({
    userId: job.responsibleUserId || job.ownerUserId || job.createdByUserId,
    workspaceId: job.workspaceId || null,
    permissions: ['canRead', 'canWrite', 'canRunAgent'],
  });
}

export async function shouldUseLegacyAutomationAdminFallback(user: AutomationPolicyUser): Promise<boolean> {
  return isLegacyAdminAllowed(user);
}
