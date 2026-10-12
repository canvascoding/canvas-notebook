import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { authority, lockOwnership, lockCapabilityScopeWorkspaceAuthority } from '@/app/lib/capabilities/scope-authority';
import { IntegrationConnectionError, type IntegrationConnectionActor, type SharedIntegrationConnectionOwnership } from './contracts';

/** Profile/setup management does not confer permission to execute any provider action. */
export async function assertSharedIntegrationOwnershipManagement(
  input: IntegrationConnectionActor,
  requestedOwnership: SharedIntegrationConnectionOwnership,
  options: { database?: SqlConnection } = {},
): Promise<void> {
  const actor = { userId: input.userId, workspaceId: input.workspaceId ?? null };
  const owner = structuredClone(requestedOwnership);
  const database = options.database ?? await openDb();
  const ownedTransaction = !options.database;
  try {
    if (ownedTransaction) await database.run('BEGIN');
    let current = await authority(database, actor, true);
    await lockCapabilityScopeWorkspaceAuthority(database, current, owner);
    current = await authority(database, actor, true);
    const configured = await database.get('SELECT organization_id FROM canvas_organization_settings ORDER BY created_at ASC LIMIT 1') as { organization_id: string } | undefined;
    if (!current.valid || !current.contextValid || configured?.organization_id !== owner.organizationId
      || input.organizationId && input.organizationId !== owner.organizationId
      || current.requestedWorkspace && current.requestedWorkspace.organizationId !== owner.organizationId) {
      throw new IntegrationConnectionError('CONNECTION_ACCESS_DENIED', 'The current organization or workspace is unavailable.', 403);
    }
    await lockOwnership(database, owner, current);
    const membership = current.memberships.get(owner.organizationId);
    const administrator = membership?.status === 'active' && ['owner', 'admin'].includes(membership.role);
    const teamManager = owner.type === 'team' && current.workspaces.get(owner.workspaceId)?.canManage === true;
    if (!administrator && !teamManager) {
      throw new IntegrationConnectionError('CONNECTION_MANAGEMENT_REQUIRED', 'Organization or team management permission is required.', 403);
    }
    if (ownedTransaction) await database.run('COMMIT');
  } catch (error) {
    if (ownedTransaction) { try { await database.run('ROLLBACK'); } catch { /* Preserve the original failure. */ } }
    throw error;
  } finally { if (ownedTransaction) await database.close(); }
}
