import 'server-only';

import { NextRequest } from 'next/server';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import {
  readOrganizationPermissionForUser,
  requireOrganizationPermission,
} from '@/app/lib/organization/permissions';

async function requireMigrationAdministrator(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin;

  const state = await readOrganizationPermissionForUser(admin.session.user.id);
  return {
    ok: true as const,
    session: admin.session,
    state,
    role: state.permission?.role ?? 'admin',
  };
}

export async function requireMigrationExportPermission(request: NextRequest) {
  return requireMigrationAdministrator(request);
}

export async function requireMigrationRestorePermission(request: NextRequest) {
  return requireMigrationAdministrator(request);
}

export async function requireFullBackupPermission(request: NextRequest) {
  return requireOrganizationPermission(request, 'canManageBackups', {
    errorMessage: 'Forbidden: backup permission required',
  });
}
