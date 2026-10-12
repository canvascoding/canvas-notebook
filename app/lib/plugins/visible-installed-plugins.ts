import 'server-only';

import { selectVisibleCapabilities } from '@/app/lib/capabilities/visible-capabilities';
import { resolveDataStorageScope } from '@/app/lib/runtime-data-paths';
import type { CapabilityResourceActor } from '@/app/lib/capabilities/resources/contracts';
import { loadCapabilityCandidatesForResourceActor, assertReadableCapabilityCandidate } from '@/app/lib/capabilities/resources/read';
import { readExactInstalledPlugin } from './installed-plugin-read';
import type { CanvasPluginInstallRecord, CanvasPluginStorageScope } from './canvas-plugin-registry';

/** Marketplace metadata uses the same current read rights and namespace as the app list. */
export async function listVisibleInstalledCanvasPlugins(
  scope?: CanvasPluginStorageScope | null,
  actor?: CapabilityResourceActor,
): Promise<CanvasPluginInstallRecord[]> {
  const resolved = resolveDataStorageScope(scope);
  const authority = actor ?? (resolved.scopeType === 'user' && resolved.userId ? { userId: resolved.userId } : null);
  if (!authority || (resolved.scopeType === 'user' && resolved.userId !== authority.userId)) return [];
  const candidates = await loadCapabilityCandidatesForResourceActor(authority);
  const visible = resolved.scopeType === 'organization'
    ? candidates.filter(entry => entry.ref.scopeType === 'organization' && entry.ref.organizationId === resolved.organizationId)
    : selectVisibleCapabilities(candidates);
  const records = await Promise.all(visible.filter(entry => entry.ref.resourceType === 'plugin'
    && entry.resourceAccess?.canRead !== false).map(async entry => {
    const plugin = await readExactInstalledPlugin({ name: entry.ref.name, resourceId: entry.ref.resourceId,
      scope: entry.ref.scopeType === 'organization'
        ? { scopeType: 'organization', organizationId: entry.ref.organizationId! }
        : { scopeType: 'user', userId: entry.ref.scopeType === 'system' ? authority.userId : entry.ref.ownerUserId! } });
    if (!plugin) return null;
    await assertReadableCapabilityCandidate(authority, entry, candidates);
    const shared = entry.ref.scopeType === 'user' && entry.ref.ownerUserId !== authority.userId;
    return { ...plugin, ...(shared ? { installDir: '', manifestPath: '', skillsDir: undefined, sourcePath: undefined,
      skills: plugin.skills.map(skill => ({ ...skill, path: '', directory: '', standaloneDir: undefined })) } : {}),
      resourceId: entry.ref.resourceId, scopeType: entry.ref.scopeType, organizationId: entry.ref.organizationId,
      ownerUserId: entry.ref.ownerUserId, resourceMetadata: entry.resourceMetadata, resourceAccess: entry.resourceAccess,
      description: entry.resourceMetadata?.description ?? plugin.description };
  }));
  return records.filter((record): record is NonNullable<typeof record> => Boolean(record));
}
