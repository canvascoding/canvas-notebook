import { createCapabilityReference } from '@/app/lib/capabilities/reference';
import { selectVisibleCapabilities } from '@/app/lib/capabilities/visible-capabilities';
import { resolveDataStorageScope } from '@/app/lib/runtime-data-paths';
import { listCanvasPlugins, type CanvasPluginInstallRecord, type CanvasPluginStorageScope } from './canvas-plugin-registry';
import { resolveActivePluginOrganizationScope } from './plugin-scope-protection';

/** Scoped marketplace metadata must describe the same package as the app list. */
export async function listVisibleInstalledCanvasPlugins(
  scope?: CanvasPluginStorageScope | null,
): Promise<CanvasPluginInstallRecord[]> {
  const resolved = resolveDataStorageScope(scope);
  const [personal, organizationScope] = await Promise.all([
    listCanvasPlugins(scope),
    resolveActivePluginOrganizationScope(scope),
  ]);
  if (!organizationScope) return personal;
  const organization = await listCanvasPlugins(organizationScope);
  const candidates = [...personal, ...organization].map((plugin) => {
    const fromOrganization = organization.includes(plugin);
    const scopeType = fromOrganization ? 'organization' as const
      : plugin.scopeType === 'system' ? 'system' as const : 'user' as const;
    const ref = createCapabilityReference({
      resourceType: 'plugin', scopeType,
      resourceId: plugin.scopeType === 'legacy' ? undefined : plugin.resourceId,
      name: plugin.name, version: plugin.version, revision: plugin.revision || 1,
      checksum: plugin.checksum, sourceType: 'standalone',
      organizationId: scopeType === 'organization' ? organizationScope.organizationId : null,
      ownerUserId: scopeType === 'user' ? resolved.userId : null,
      sourcePluginId: null,
    });
    return { ref, plugin: { ...plugin, resourceId: ref.resourceId, scopeType,
      organizationId: ref.organizationId, ownerUserId: ref.ownerUserId } };
  });
  return selectVisibleCapabilities(candidates).map((entry) => entry.plugin);
}
