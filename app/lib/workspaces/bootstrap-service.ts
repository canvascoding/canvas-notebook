import 'server-only';

import { getDatabaseProvider } from '@/app/lib/db/provider';
import { assertUserSeatAccess } from '@/app/lib/license/seat-limit';
import {
  ensureOrganizationBootstrapForUser,
  openOrganizationBootstrapDatabase,
  type OrganizationBootstrapStatus,
} from '@/app/lib/organization/bootstrap';
import { getPostgresWorkspaceState } from './postgres-runtime';
import type { WorkspaceActor } from './types';

/**
 * Provisions the organization membership and default workspace records needed
 * before a user can be targeted by organization-scoped grants.
 */
export async function ensureWorkspaceBootstrapForActor(
  actor: WorkspaceActor,
): Promise<OrganizationBootstrapStatus> {
  await assertUserSeatAccess({ userId: actor.userId });
  if (getDatabaseProvider() === 'postgres') {
    return (await getPostgresWorkspaceState(actor)).status;
  }

  const sqlite = openOrganizationBootstrapDatabase();
  try {
    sqlite.exec('BEGIN IMMEDIATE');
    const status = ensureOrganizationBootstrapForUser(sqlite, actor.userId);
    sqlite.exec('COMMIT');
    return status;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    throw error;
  } finally {
    sqlite.close();
  }
}
