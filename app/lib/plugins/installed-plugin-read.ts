import 'server-only';

import { createCapabilityResourceId } from '@/app/lib/capabilities/reference';
import { getCanvasPlugin, type CanvasPluginInstallRecord } from '@/app/lib/plugins/canvas-plugin-registry';

type InstalledPluginReadScope =
  | { scopeType: 'user'; userId: string }
  | { scopeType: 'organization'; organizationId: string };

// Callers authorize membership, assignments and workspace access before reading.
// This lookup preserves the exact storage identity, including legacy personal IDs
// synthesized by the effective capability catalog.
export async function readExactInstalledPlugin(input: {
  name: string;
  resourceId?: string;
  scope: InstalledPluginReadScope;
}): Promise<CanvasPluginInstallRecord | null> {
  const plugin = await getCanvasPlugin(input.name, input.scope);
  if (!plugin || plugin.name !== input.name) return null;

  if (input.scope.scopeType === 'organization') {
    return plugin.scopeType === 'organization'
      && plugin.organizationId === input.scope.organizationId
      && Boolean(input.resourceId)
      && plugin.resourceId === input.resourceId
      ? plugin : null;
  }

  if (plugin.scopeType === 'organization'
    || (plugin.ownerUserId && plugin.ownerUserId !== input.scope.userId)) return null;
  const resourceId = (plugin.scopeType !== 'legacy' && plugin.resourceId) || createCapabilityResourceId({
    resourceType: 'plugin',
    scopeType: plugin.scopeType === 'system' ? 'system' : 'user',
    ownerUserId: plugin.scopeType === 'system' ? null : input.scope.userId,
    sourceType: 'standalone',
    name: plugin.name,
  });
  return !input.resourceId || input.resourceId === resourceId ? plugin : null;
}
