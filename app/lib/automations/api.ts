import { NextRequest, NextResponse } from 'next/server';

import { isAdminUser, type AdminUserCandidate } from '@/app/lib/admin-auth';
import { auth } from '@/app/lib/auth';
import {
  hasOrganizationPermission,
  OrganizationPermissionError,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type AutomationPermissionUser = AdminUserCandidate & { id: string };
type RequestedAutomationScope = 'personal' | 'team' | 'organization';

export async function requireAutomationSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      session: null,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  return {
    session,
    response: null,
  };
}

export function applyAutomationRateLimit(
  request: NextRequest,
  keyPrefix: string,
  limit = 60,
  windowMs = 60_000,
) {
  return rateLimit(request, {
    limit,
    windowMs,
    keyPrefix,
  });
}

function stringField(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? record[key].trim().toLowerCase() : '';
}

export function resolveRequestedAutomationScope(input: unknown): RequestedAutomationScope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return 'personal';
  }

  const record = input as Record<string, unknown>;
  // Current automation records are personal-only server-side; these fields are explicit future scope selectors.
  if (record.organizationScope === true || stringField(record, 'scope') === 'organization') {
    return 'organization';
  }
  if (
    record.teamAutomation === true ||
    stringField(record, 'scope') === 'team' ||
    stringField(record, 'workspaceScope') === 'team' ||
    stringField(record, 'workspaceType') === 'team'
  ) {
    return 'team';
  }

  return 'personal';
}

export function automationInputRequiresTeamPermission(input: unknown): boolean {
  return resolveRequestedAutomationScope(input) !== 'personal';
}

export function assertCanCreateRequestedAutomation(input: unknown, user: AutomationPermissionUser): void {
  const scope = resolveRequestedAutomationScope(input);
  if (scope === 'personal') {
    return;
  }

  const state = readOrganizationPermissionForUser(user.id);
  if (!state.configured && isAdminUser(user)) {
    console.warn('[Automations] Legacy admin fallback allowed team automation on unconfigured organization.', {
      userId: user.id,
      requestedScope: scope,
    });
    return;
  }

  if (!hasOrganizationPermission(state.permission, 'canCreateTeamAutomations')) {
    throw new OrganizationPermissionError('canCreateTeamAutomations', 'Team automation permission required.');
  }
}

export function getAutomationRouteErrorStatus(error: unknown, fallbackStatus = 500): number {
  return error instanceof OrganizationPermissionError ? error.status : fallbackStatus;
}
