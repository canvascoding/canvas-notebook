import 'server-only';

import type { CapabilityResourceActor } from '../resources/contracts';
import { withAuthorizedCapabilityPackageTarget } from '../resources/store';
import { authority, listCapabilityScopeTargetsOnConnection } from '../scope-authority';
import { CapabilityPackageError } from './contracts';
import { resolvedOwnership, storageForOwner } from './store-target';
import { capabilityPackageStoreInstallOptionsSchema, type CapabilityPackageStoreInstallOptions } from './store-install-options-contracts';

/** Reads initial sharing targets under the same current ownership authority as an actual new installation. */
export async function inspectCapabilityPackageStoreInstallOptionsAction(
  actorInput: CapabilityResourceActor, value: unknown,
): Promise<CapabilityPackageStoreInstallOptions> {
  const actor = Object.freeze({ userId: actorInput.userId, workspaceId: actorInput.workspaceId ?? null });
  const input = capabilityPackageStoreInstallOptionsSchema.parse(structuredClone(value));
  const owner = await resolvedOwnership(actor, input.ownership);
  const storage = storageForOwner(input.source.kind, input.source.entryKey, owner);
  return withAuthorizedCapabilityPackageTarget(actor, storage, owner, async (_authorization, database) => {
    const current = await authority(database, actor, true);
    if (!current.valid || !current.contextValid) {
      throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'An active actor and workspace are required.', 403);
    }
    const organizationId = owner.organizationId;
    const activeOrganization = organizationId && current.memberships.get(organizationId)?.status === 'active';
    const targets = activeOrganization
      ? await listCapabilityScopeTargetsOnConnection(database, organizationId, actor.userId)
      : { users: [], workspaces: [], projects: [] };
    let ownershipLabel = owner.type === 'user' ? 'Personal' : 'Organization';
    if (owner.type === 'team') {
      const team = await database.get("SELECT display_name FROM canvas_workspaces WHERE id=$1 AND organization_id=$2 AND type='team' AND status='active'",
        [owner.workspaceId, owner.organizationId]) as { display_name: string } | undefined;
      if (!team) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The selected team is unavailable.', 403);
      ownershipLabel = String(team.display_name).slice(0, 256);
    }
    return { schemaVersion: 1, source: input.source, ownership: owner, ownershipLabel, targets };
  });
}
