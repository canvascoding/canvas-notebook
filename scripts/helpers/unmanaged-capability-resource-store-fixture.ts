import type { CapabilityResourceAccessEntry, CapabilityResourceActor, CapabilityResourceStorageBinding } from '../../app/lib/capabilities/resources/contracts';
import { createCapabilityReference } from '../../app/lib/capabilities/reference';
import type { CapabilityCandidate } from '../../app/lib/capabilities/types';

export function legacyInstalledPluginCandidate(actorUserId: string, record: Record<string, unknown>): CapabilityCandidate {
  const scopeType = record.scopeType === 'organization' ? 'organization' : record.scopeType === 'system' ? 'system' : 'user';
  return {
    ref: createCapabilityReference({ resourceType: 'plugin', scopeType, name: String(record.name),
      resourceId: record.scopeType === 'legacy' ? undefined : typeof record.resourceId === 'string' ? record.resourceId : undefined,
      version: typeof record.version === 'string' ? record.version : 'unversioned', revision: 1, checksum: 'fixture-checksum',
      sourceType: 'standalone', organizationId: scopeType === 'organization' ? String(record.organizationId) : null,
      ownerUserId: scopeType === 'user' ? typeof record.ownerUserId === 'string' ? record.ownerUserId : actorUserId : null,
      sourcePluginId: null }),
    description: '', enabled: true, runtimePath: null,
  };
}

/**
 * Explicit legacy-fixture seam only. The resource-access/store tests exercise
 * the actual PostgreSQL ACLs; older namespace/OAuth fixtures have no grants.
 */
export function unmanagedCapabilityResourceStoreFixture(organizationId: () => string | null) {
  return {
    listCapabilityResourceRecordsForActor: async () => [],
    getCapabilityResourceAccess: async (actor: CapabilityResourceActor, storage: CapabilityResourceStorageBinding): Promise<CapabilityResourceAccessEntry> => {
      const own = storage.scopeType === 'user' && storage.ownerUserId === actor.userId;
      const readable = own || storage.scopeType === 'system'
        || (storage.scopeType === 'organization' && storage.organizationId === organizationId());
      return {
        metadata: {
          resourceRef: storage.resourceId, legacyResourceId: storage.resourceId, resourceType: storage.resourceType,
          sourceType: storage.sourceType, sourcePluginId: storage.sourcePluginId,
          ownership: storage.scopeType === 'system' ? { type: 'system' } : storage.scopeType === 'organization'
            ? { type: 'organization', organizationId: storage.organizationId! }
            : { type: 'user', ownerUserId: storage.ownerUserId!, organizationId: null },
          displayName: null, description: null, responsibleUserId: null, createdByUserId: null, updatedByUserId: null,
          metadataRevision: 0, grantsRevision: 0, accessMode: 'inherit', status: 'active', createdAt: null, updatedAt: null,
        },
        access: { canRead: readable, canUse: readable, canEdit: own && !storage.sourcePluginId, canManage: own && !storage.sourcePluginId },
      };
    },
  };
}
