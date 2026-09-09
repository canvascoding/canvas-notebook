import 'server-only';

import { openDb } from '@/app/lib/db';
import { createLegacyPersonalWorkspaceContext, resolveWorkspaceActor } from './context';
import { migrateLegacyWorkspaceToPersonalWorkspace } from './legacy-migration';
import type { WorkspaceContext } from './types';

/** Read-only recovery requires the persisted owner, never an asserted role. */
export async function resolveLegacyWorkspaceRecovery(userId: string): Promise<WorkspaceContext | null> {
  const database = await openDb();
  try {
    const owner = await database.get(`
      SELECT o.organization_id, u.id, u.email, u.role
      FROM canvas_organization_settings o
      INNER JOIN "user" u ON u.id = o.owner_user_id
      WHERE u.id = $1 AND (u.banned IS NULL OR u.banned = 0)
        AND o.organization_id = (
          SELECT organization_id FROM canvas_organization_settings ORDER BY created_at ASC LIMIT 1
        )
      LIMIT 1
    `, [userId]) as { organization_id: string; id: string; email: string; role: string } | undefined;
    if (!owner) return null;
    const legacy = createLegacyPersonalWorkspaceContext(resolveWorkspaceActor(owner));
    return {
      ...legacy,
      organizationId: owner.organization_id,
      displayName: 'Legacy workspace recovery',
      permissions: {
        canRead: true, canWrite: false, canDelete: false,
        canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: false,
      },
    };
  } finally {
    await database.close();
  }
}

/** Copy only into the proven owner's persisted personal workspace; retain source/conflicts. */
export async function importLegacyWorkspaceForOwner(userId: string, workspace: WorkspaceContext): Promise<void> {
  if (workspace.legacy || workspace.workspaceType !== 'personal' || workspace.ownerUserId !== userId
    || !workspace.rootRelativePath || !workspace.permissions.canWrite) return;
  const recovery = await resolveLegacyWorkspaceRecovery(userId);
  if (!recovery?.organizationId || recovery.organizationId !== workspace.organizationId) return;
  migrateLegacyWorkspaceToPersonalWorkspace({
    organizationId: recovery.organizationId, userId,
    personalWorkspace: { rootRelativePath: workspace.rootRelativePath },
  });
}
