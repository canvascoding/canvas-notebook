import 'server-only';

import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import type { CapabilityResolutionContext } from '@/app/lib/capabilities/types';
import type { OrganizationPermissionState } from '@/app/lib/organization/bootstrap';
import type { CapabilityDataStorageScope } from '@/app/lib/runtime-data-paths';

export type CapabilityManagementScope = 'user' | 'organization';

export function parseCapabilityManagementScope(value: unknown): CapabilityManagementScope {
  return value === 'organization' ? 'organization' : 'user';
}

export function resolveCapabilityStorageScope(input: {
  requestedScope: unknown;
  userId: string;
  organizationState: OrganizationPermissionState;
}): CapabilityDataStorageScope {
  const scopeType = parseCapabilityManagementScope(input.requestedScope);
  if (scopeType === 'organization') {
    if (
      !input.organizationState.organizationId
      || !input.organizationState.permission
      || input.organizationState.permission.status !== 'active'
    ) {
      throw new Error('Active organization membership required for organization capabilities.');
    }
    return {
      scopeType: 'organization',
      organizationId: input.organizationState.organizationId,
    };
  }
  return {
    scopeType: 'user',
    userId: input.userId,
    organizationId: input.organizationState.organizationId,
  };
}

export async function resolveCapabilityExecutionContextForUser(input: {
  userId: string;
  organizationId: string;
  role?: string | null;
  requestedWorkspaceId?: string | null;
}): Promise<CapabilityResolutionContext> {
  const workspace = await resolveAgentSessionWorkspaceForUser({
    userId: input.userId,
    workspaceId: input.requestedWorkspaceId?.trim() || undefined,
    permissions: ['canRead', 'canRunAgent'],
  });
  if (workspace.organizationId !== input.organizationId) {
    throw new Error('Workspace organization mismatch.');
  }
  return {
    organizationId: input.organizationId,
    userId: input.userId,
    role: input.role,
    workspaceId: workspace.workspaceId,
    projectId: workspace.projectId,
  };
}
