import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { hasOrganizationPermission, readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

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

export function automationInputRequiresTeamPermission(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return false;
  }

  const record = input as Record<string, unknown>;
  return record.teamAutomation === true ||
    record.organizationScope === true ||
    stringField(record, 'scope') === 'team' ||
    stringField(record, 'scope') === 'organization' ||
    stringField(record, 'workspaceScope') === 'team' ||
    stringField(record, 'workspaceType') === 'team';
}

export function assertCanCreateRequestedAutomation(input: unknown, userId: string): void {
  if (!automationInputRequiresTeamPermission(input)) {
    return;
  }

  const state = readOrganizationPermissionForUser(userId);
  if (!hasOrganizationPermission(state.permission, 'canCreateTeamAutomations')) {
    const error = new Error('Team automation permission required.') as Error & { status: number; code: string };
    error.status = 403;
    error.code = 'ORGANIZATION_PERMISSION_DENIED';
    throw error;
  }
}
