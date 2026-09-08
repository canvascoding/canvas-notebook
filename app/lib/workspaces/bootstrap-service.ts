import 'server-only';

import { assertUserSeatAccess } from '@/app/lib/license/seat-limit';
import type { OrganizationBootstrapStatus } from '@/app/lib/organization/contracts';
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
  return (await getPostgresWorkspaceState(actor)).status;
}
