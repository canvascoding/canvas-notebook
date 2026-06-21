import 'server-only';

import { NextResponse } from 'next/server';

import { isAdminUser, type AdminUserCandidate } from '@/app/lib/admin-auth';
import { auth } from '@/app/lib/auth';
import {
  getOrganizationPermissionForUser,
  openOrganizationBootstrapDatabase,
  type OrganizationPermissionSnapshot,
  type OrganizationPermissionState,
} from '@/app/lib/organization/bootstrap';

export type OrganizationPermissionKey = Exclude<keyof OrganizationPermissionSnapshot, 'role' | 'status'>;

export type OrganizationPermissionGuardResult =
  | {
      ok: true;
      session: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
      state: OrganizationPermissionState;
      permission: OrganizationPermissionSnapshot;
    }
  | {
      ok: false;
      response: NextResponse;
    };

type PermissionGuardOptions = {
  errorMessage?: string;
  legacyAdminFallback?: boolean;
};

type PermissionUserCandidate = AdminUserCandidate & {
  id?: string | null;
};

const LEGACY_ADMIN_PERMISSION: OrganizationPermissionSnapshot = {
  role: 'admin',
  status: 'active',
  canWriteTeamWorkspace: true,
  canCreatePublicLinks: true,
  canCreateTeamAutomations: true,
  canSharePluginsAndSkills: true,
  canExport: true,
  canDeleteTeamFiles: true,
  canDeleteStudioAssets: true,
  canManageBackups: true,
  canMigrateDatabase: true,
  canEnableKnowledge: true,
  canRecoverWorkspaces: true,
};

export class OrganizationPermissionError extends Error {
  readonly status = 403;
  readonly code = 'ORGANIZATION_PERMISSION_DENIED';

  constructor(
    public readonly permission: OrganizationPermissionKey,
    message = `Missing organization permission: ${permission}`,
  ) {
    super(message);
    this.name = 'OrganizationPermissionError';
  }
}

function forbiddenResponse(permission: OrganizationPermissionKey, message?: string): NextResponse {
  return NextResponse.json(
    {
      success: false,
      code: 'ORGANIZATION_PERMISSION_DENIED',
      permission,
      error: message || `Missing organization permission: ${permission}`,
    },
    { status: 403 },
  );
}

export function hasOrganizationPermission(
  permission: OrganizationPermissionSnapshot | null | undefined,
  key: OrganizationPermissionKey,
): boolean {
  return permission?.status === 'active' && permission?.[key] === true;
}

export function assertOrganizationPermission(
  permission: OrganizationPermissionSnapshot | null | undefined,
  key: OrganizationPermissionKey,
  message?: string,
): asserts permission is OrganizationPermissionSnapshot {
  if (!hasOrganizationPermission(permission, key)) {
    throw new OrganizationPermissionError(key, message);
  }
}

export function readOrganizationPermissionForUser(userId: string): OrganizationPermissionState {
  const sqlite = openOrganizationBootstrapDatabase();
  try {
    return getOrganizationPermissionForUser(sqlite, userId);
  } finally {
    sqlite.close();
  }
}

function readPermissionUserCandidate(userId: string): PermissionUserCandidate | null {
  const sqlite = openOrganizationBootstrapDatabase();
  try {
    const candidate = sqlite.prepare(`
      SELECT id, email, role
      FROM user
      WHERE id = ?
      LIMIT 1
    `).get(userId) as PermissionUserCandidate | undefined;
    return candidate ?? null;
  } finally {
    sqlite.close();
  }
}

function warnLegacyAdminFallback(userId: string, key: OrganizationPermissionKey, databaseProvider: string): void {
  console.warn('[OrganizationPermission] Legacy admin fallback granted organization permission.', {
    userId,
    permission: key,
    databaseProvider,
  });
}

export function assertUserOrganizationPermission(
  userId: string,
  key: OrganizationPermissionKey,
  message?: string,
  user?: PermissionUserCandidate | null,
): OrganizationPermissionState {
  const state = readOrganizationPermissionForUser(userId);
  if (!state.configured) {
    const candidate = user ?? readPermissionUserCandidate(userId);
    if (isAdminUser(candidate)) {
      warnLegacyAdminFallback(userId, key, state.databaseProvider);
      return legacyFallbackState();
    }
  }

  assertOrganizationPermission(state.permission, key, message);
  return state;
}

function legacyFallbackState(): OrganizationPermissionState {
  return {
    configured: false,
    organizationId: null,
    ownerUserId: null,
    teamFeaturesEnabled: false,
    databaseProvider: process.env.CANVAS_DATABASE_PROVIDER?.trim().toLowerCase() || 'sqlite',
    permission: LEGACY_ADMIN_PERMISSION,
  };
}

export async function requireOrganizationPermission(
  request: { headers: Headers },
  key: OrganizationPermissionKey,
  options: PermissionGuardOptions = {},
): Promise<OrganizationPermissionGuardResult> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const state = readOrganizationPermissionForUser(session.user.id);
  if (!state.configured && options.legacyAdminFallback !== false && isAdminUser(session.user)) {
    warnLegacyAdminFallback(session.user.id, key, state.databaseProvider);

    return {
      ok: true,
      session,
      state: legacyFallbackState(),
      permission: LEGACY_ADMIN_PERMISSION,
    };
  }

  const permission = state.permission;
  if (!permission || permission[key] !== true) {
    return {
      ok: false,
      response: forbiddenResponse(key, options.errorMessage),
    };
  }

  return {
    ok: true,
    session,
    state,
    permission,
  };
}

export function isOrganizationAdminLike(permission: OrganizationPermissionSnapshot | null | undefined): boolean {
  return permission?.status === 'active' && (permission?.role === 'owner' || permission?.role === 'admin');
}
