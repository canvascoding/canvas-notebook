import 'server-only';

import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import type { CapabilityResourceActor, CapabilityResourceOwnerScope, CapabilityResourceStorageBinding } from '../resources/contracts';
import { CapabilityPackageError } from './contracts';
import { capabilityPackageLegacyStorageBinding } from './artifacts';

export async function resolvedOwnership(actor: CapabilityResourceActor,
  choice: { type: 'user' | 'organization' } | { type: 'team'; workspaceId: string }): Promise<Exclude<CapabilityResourceOwnerScope, { type: 'system' }>> {
  const organization = await readOrganizationPermissionForUser(actor.userId);
  if (choice.type === 'user') return { type: 'user', ownerUserId: actor.userId, organizationId: organization.organizationId ?? null };
  if (!organization.organizationId || !organization.configured || organization.permission?.status !== 'active') {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'An active organization is required.', 403);
  }
  return choice.type === 'team' ? { type: 'team', organizationId: organization.organizationId, workspaceId: choice.workspaceId }
    : { type: 'organization', organizationId: organization.organizationId };
}
export function storageForOwner(kind: 'skill' | 'plugin', name: string, owner: Exclude<CapabilityResourceOwnerScope, { type: 'system' }>): CapabilityResourceStorageBinding {
  return capabilityPackageLegacyStorageBinding(kind, name, owner.type === 'user'
    ? { scopeType: 'user', userId: owner.ownerUserId } : { scopeType: 'organization', organizationId: owner.organizationId });
}
