import 'server-only';

import { NextRequest } from 'next/server';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';

export async function requireMigrationExportPermission(request: NextRequest) {
  return requireOrganizationPermission(request, 'canExport', {
    errorMessage: 'Forbidden: export permission required',
  });
}

export async function requireMigrationRestorePermission(request: NextRequest) {
  return requireOrganizationPermission(request, 'canRecoverWorkspaces', {
    errorMessage: 'Forbidden: recovery permission required',
  });
}

export async function requireFullBackupPermission(request: NextRequest) {
  return requireOrganizationPermission(request, 'canManageBackups', {
    errorMessage: 'Forbidden: backup permission required',
  });
}
