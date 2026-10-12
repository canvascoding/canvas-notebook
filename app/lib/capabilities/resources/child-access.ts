import type { CapabilityResourceAccessEntry } from './contracts';

/** A bundled skill keeps its identity and metadata while inheriting the source's governed scope. */
export function projectCapabilityPluginChildAccess(
  child: CapabilityResourceAccessEntry,
  parent: CapabilityResourceAccessEntry | null,
): CapabilityResourceAccessEntry {
  if (!parent) return { ...child, access: { canRead: false, canUse: false, canEdit: false, canManage: false } };
  return {
    metadata: { ...child.metadata, ownership: { ...parent.metadata.ownership },
      metadataRevision: parent.metadata.metadataRevision, grantsRevision: parent.metadata.grantsRevision },
    access: { canRead: parent.access.canRead, canUse: parent.access.canUse, canEdit: false, canManage: false },
  };
}
