import 'server-only';

import { CapabilityResourceError, type CapabilityResourceActor, type CapabilityResourceDescriptor } from '@/app/lib/capabilities/resources/contracts';
import { openDb } from '@/app/lib/db';
import { authority } from '@/app/lib/capabilities/scope-authority';
import type { CanvasSkillStoreRegistry, CanvasSkillStoreScope, CanvasSkillStoreSkill, CanvasSkillStoreSkillWithState, CanvasSkillStoreStats } from './canvas-skill-store';

/** The actor-facing store never returns installation paths, digests or grant inventories. */
export type SafeActorSkillStoreResource = {
  metadata: CapabilityResourceDescriptor['metadata'];
  access: CapabilityResourceDescriptor['access'];
  artifact: Omit<CapabilityResourceDescriptor['artifact'], 'checksum'>;
  activation?: CapabilityResourceDescriptor['activation'];
  ownershipLabel?: string;
  people?: CapabilityResourceDescriptor['people'];
};

function publicStoreUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return `${url.origin}${url.pathname}`;
  } catch { return undefined; }
}

function publicStoreOffering(skill: CanvasSkillStoreSkill): CanvasSkillStoreSkill {
  const versions = Object.fromEntries(Object.entries(skill.versions).map(([key, version]) => [key, {
    version: version.version, downloadUrl: publicStoreUrl(version.downloadUrl) || '', packagePath: version.packagePath,
    checksum: version.checksum, releasedAt: version.releasedAt, minCanvasVersion: version.minCanvasVersion, notes: version.notes,
  }]));
  return { name: skill.name, displayName: skill.displayName, description: skill.description, category: skill.category,
    latestVersion: skill.latestVersion, versions, iconUrl: publicStoreUrl(skill.iconUrl), brandColor: skill.brandColor, license: skill.license,
    publisher: skill.publisher ? { name: skill.publisher.name, url: publicStoreUrl(skill.publisher.url) } : undefined,
    sourcePlugin: skill.sourcePlugin ? { name: skill.sourcePlugin.name, displayName: skill.sourcePlugin.displayName, version: skill.sourcePlugin.version } : undefined };
}

function safeResource(descriptor: CapabilityResourceDescriptor): SafeActorSkillStoreResource {
  const { metadata, access, artifact, activation } = descriptor;
  const ownership = metadata.ownership;
  const result: SafeActorSkillStoreResource = {
    metadata: {
      resourceRef: metadata.resourceRef, legacyResourceId: metadata.legacyResourceId,
      resourceType: metadata.resourceType, sourceType: metadata.sourceType, sourcePluginId: metadata.sourcePluginId,
      ownership: ownership.type === 'team'
        ? { type: 'team', organizationId: ownership.organizationId, workspaceId: ownership.workspaceId }
        : ownership.type === 'organization' ? { type: 'organization', organizationId: ownership.organizationId }
          : ownership.type === 'user' ? { type: 'user', ownerUserId: ownership.ownerUserId, organizationId: ownership.organizationId }
            : { type: 'system' },
      displayName: metadata.displayName, description: metadata.description, responsibleUserId: metadata.responsibleUserId,
      createdByUserId: metadata.createdByUserId, updatedByUserId: metadata.updatedByUserId,
      metadataRevision: metadata.metadataRevision, grantsRevision: metadata.grantsRevision,
      accessMode: metadata.accessMode, status: metadata.status, createdAt: metadata.createdAt, updatedAt: metadata.updatedAt,
    },
    access: { canRead: access.canRead, canUse: access.canUse, canEdit: access.canEdit, canManage: access.canManage },
    artifact: {
      resourceType: artifact.resourceType, resourceId: artifact.resourceId, scopeType: artifact.scopeType, name: artifact.name,
      version: artifact.version, revision: artifact.revision, sourceType: artifact.sourceType, sourcePluginId: artifact.sourcePluginId,
    },
  };
  if (activation) result.activation = {
    effectivePolicy: activation.effectivePolicy, enabled: activation.enabled,
    readiness: activation.readiness, blockedReason: activation.blockedReason,
  };
  if (descriptor.ownershipLabel !== undefined) result.ownershipLabel = descriptor.ownershipLabel;
  if (descriptor.people) {
    result.people = {};
    for (const key of ['owner', 'createdBy', 'updatedBy', 'responsible'] as const) {
      const person = descriptor.people[key];
      if (person) result.people[key] = { userId: person.userId, name: person.name };
    }
  }
  return result;
}

/** Descriptors come from the fresh ACL catalog; names only group visible instances, never authorize them. */
export function projectActorCanvasSkillStoreState(
  registry: CanvasSkillStoreRegistry,
  descriptors: readonly CapabilityResourceDescriptor[],
  scope?: CanvasSkillStoreScope | null,
): { registry: Omit<CanvasSkillStoreRegistry, 'skills'>; skills: CanvasSkillStoreSkillWithState[]; stats: Omit<CanvasSkillStoreStats, 'filteredTotal'> } {
  const byName = new Map<string, SafeActorSkillStoreResource[]>();
  for (const descriptor of descriptors) {
    if (!descriptor.access.canRead || descriptor.metadata.status !== 'active' || descriptor.artifact.resourceType !== 'skill') continue;
    const ownership = descriptor.metadata.ownership;
    if (scope?.scopeType === 'organization' && (descriptor.artifact.scopeType !== 'organization'
      || (ownership.type !== 'organization' && ownership.type !== 'team') || ownership.organizationId !== scope.organizationId)) continue;
    const key = descriptor.artifact.name.trim().toLowerCase();
    const resources = byName.get(key) || [];
    resources.push(safeResource(descriptor));
    byName.set(key, resources);
  }
  const skills = registry.skills.map(skill => {
    const resources = (byName.get(skill.name.trim().toLowerCase()) || []).sort((a, b) => a.metadata.resourceRef.localeCompare(b.metadata.resourceRef));
    const single = resources.length === 1 ? resources[0] : undefined;
    return { ...publicStoreOffering(skill), installed: {
      installed: resources.length > 0, enabled: single?.activation?.enabled === true,
      ...(single ? { version: single.artifact.version,
        managedByOrganization: single.metadata.ownership.type === 'organization' || single.metadata.ownership.type === 'team' } : {}),
      updateAvailable: false, modified: false, restoreAvailable: false,
      comparison: 'unknown' as const, resources,
    } };
  });
  const registryMetadata = { schemaVersion: registry.schemaVersion, id: registry.id, name: registry.name, updatedAt: registry.updatedAt,
    registryUrl: publicStoreUrl(registry.registryUrl) || '', homepage: publicStoreUrl(registry.homepage),
    publisher: registry.publisher ? { name: registry.publisher.name, url: publicStoreUrl(registry.publisher.url) } : undefined };
  return { registry: registryMetadata, skills, stats: {
    total: skills.length, installed: skills.filter(skill => skill.installed.installed).length,
    available: skills.filter(skill => !skill.installed.installed).length, updates: 0,
  } };
}

/** Empty catalogs require the same fresh actor/workspace authority as nonempty ones. */
export async function assertActorCanvasSkillStoreContext(actor: CapabilityResourceActor): Promise<void> {
  const database = await openDb();
  try {
    const current = await authority(database, actor);
    if (!current.valid || !current.contextValid) {
      throw new CapabilityResourceError('SKILL_STORE_ACCESS_DENIED', 'Skill library access is unavailable in this context.', 403);
    }
  } finally { await database.close(); }
}

export async function readActorCanvasSkillStoreState(
  registry: CanvasSkillStoreRegistry,
  actor: CapabilityResourceActor,
  scope?: CanvasSkillStoreScope | null,
): Promise<ReturnType<typeof projectActorCanvasSkillStoreState>> {
  await assertActorCanvasSkillStoreContext(actor);
  // Keep the legacy registry/loader import cycle out of the un-migrated no-actor path.
  const { listCapabilityResources } = await import('@/app/lib/capabilities/resources/actions');
  return projectActorCanvasSkillStoreState(registry, await listCapabilityResources(actor), scope);
}
