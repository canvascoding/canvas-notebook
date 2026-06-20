import 'server-only';

import { isAdminUser, type AdminUserCandidate } from '@/app/lib/admin-auth';
import {
  hasOrganizationPermission,
  OrganizationPermissionError,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

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
    readStringField(record, 'workspaceScope').toLowerCase() === 'team' ||
    readStringField(record, 'workspaceType').toLowerCase() === 'team'
  ) {
    return 'team';
  }

  return 'personal';
}

export function automationInputRequestsOrganizationScope(input: unknown): boolean {
  return normalizeRequestedScope(input) !== 'personal';
}

function normalizeWorkspaceId(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const workspaceId = readStringField(input as Record<string, unknown>, 'workspaceId');
  return workspaceId || null;
}

function isLegacyAdminAllowed(user: AutomationPolicyUser): boolean {
  const state = readOrganizationPermissionForUser(user.id);
  return !state.configured && isAdminUser(user);
}

function assertCanCreateOrganizationAutomation(user: AutomationPolicyUser): void {
  const state = readOrganizationPermissionForUser(user.id);
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

export function getAutomationListAccess(userId: string): AutomationListAccess {
  const state = readOrganizationPermissionForUser(userId);
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

  if (workspace.workspaceType !== 'team') {
    throw new AutomationPolicyError('Automations are only supported in personal and team workspaces.');
  }

  assertCanCreateOrganizationAutomation(user);
  if (!workspace.organizationId) {
    throw new AutomationPolicyError('Organization automations require a configured organization workspace.');
  }

  return {
    scope: 'organization',
    organizationId: workspace.organizationId,
    workspaceId: workspace.workspaceId,
    workspaceType: 'team',
    ownerUserId: null,
    responsibleUserId: user.id,
    serviceActorId: workspace.organizationId ? `org-service:${workspace.organizationId}` : null,
    approvedByUserId: user.id,
    lastEditedByUserId: user.id,
    workspace,
  };
}

export function canAccessAutomationJob(
  userId: string,
  job: {
    scope?: string | null;
    createdByUserId: string;
    ownerUserId?: string | null;
    responsibleUserId?: string | null;
    organizationId?: string | null;
  },
): boolean {
  const scope = job.scope === 'organization' ? 'organization' : 'personal';
  if (scope === 'personal') {
    return (job.ownerUserId || job.createdByUserId) === userId;
  }

  const state = readOrganizationPermissionForUser(userId);
  return Boolean(
    job.organizationId &&
    state.organizationId === job.organizationId &&
    hasOrganizationPermission(state.permission, 'canCreateTeamAutomations'),
  );
}

export function assertCanAccessAutomationJob(
  userId: string,
  job: Parameters<typeof canAccessAutomationJob>[1],
): void {
  if (!canAccessAutomationJob(userId, job)) {
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

export function shouldUseLegacyAutomationAdminFallback(user: AutomationPolicyUser): boolean {
  return isLegacyAdminAllowed(user);
}
