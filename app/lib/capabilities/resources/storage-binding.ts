import type { CapabilityResourceStorageBinding } from './contracts';

/** Project only installed storage facts; artifact versions and UI metadata are not authority. */
export function capabilityResourceStorageBinding(reference: CapabilityResourceStorageBinding): CapabilityResourceStorageBinding {
  return { resourceType: reference.resourceType, resourceId: reference.resourceId, scopeType: reference.scopeType,
    name: reference.name, sourceType: reference.sourceType, organizationId: reference.organizationId,
    ownerUserId: reference.ownerUserId, sourcePluginId: reference.sourcePluginId };
}
