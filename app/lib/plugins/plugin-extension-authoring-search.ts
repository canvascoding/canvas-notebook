import 'server-only';

import type { CapabilityResourceActor } from '@/app/lib/capabilities/resources/contracts';
import { readAgentComposioOptionsCatalogue, readAgentMcpOptionsInventory } from '@/app/lib/agents/extension-options-inventory';
import { getPluginExtensionSearchDependencies, searchPluginExtensions } from './plugin-extension-search';
import { resolvePluginExtensionAuthoringContext, revalidatePluginExtensionAuthoringContext,
  listPluginExtensionAuthoringSharedMetadata } from './plugin-extension-authoring-context';
import type { PluginExtensionItem, PluginExtensionQuery, PluginExtensionSearchResponse } from './plugin-extension-contracts';

/** Metadata selection never suggests that a configured account, cached health or a Read grant is executable. */
function metadataOnly(item: PluginExtensionItem): PluginExtensionItem {
  const access = { canRead: item.access.canRead, canUse: false, canManage: false };
  return item.kind === 'integration' || item.kind === 'mcp'
    ? { ...item, access, connections: [] } : { ...item, access };
}

/** One catalogue/ranker/cursor service, with the existing metadata-only provider readers. */
export async function searchPluginExtensionAuthoringMetadata(actor: CapabilityResourceActor, query: PluginExtensionQuery,
  options: { signal?: AbortSignal } = {}): Promise<PluginExtensionSearchResponse> {
  const context = await resolvePluginExtensionAuthoringContext(actor);
  const defaults = await getPluginExtensionSearchDependencies();
  const catalogToolkits = new Set<string>();
  const result = await searchPluginExtensions(actor, query, { ...options, dependencies: {
    ...defaults,
    context: async current => { await revalidatePluginExtensionAuthoringContext(context); return defaults.context(current); },
    composio: async (_current, signal, selected) => readAgentComposioOptionsCatalogue(context, signal,
      { ...selected, onCatalogueMetadata: toolkits => { for (const toolkit of toolkits) catalogToolkits.add(toolkit); } }),
    mcp: async () => readAgentMcpOptionsInventory(context),
    revalidate: async (current, items) => {
      await revalidatePluginExtensionAuthoringContext(context);
      // Remote Store/catalogue IO does not preserve a local resource grant.
      const packageResult = items.some(item => item.kind === 'plugin' || item.kind === 'skill') ? await defaults.packages(current) : null;
      const packages = new Map((packageResult?.items ?? []).map(item => [item.id, item]));
      const mcpResult = items.some(item => item.kind === 'mcp') ? await readAgentMcpOptionsInventory(context) : null;
      const mcps = new Map((mcpResult?.items ?? []).map(item => [item.id, item]));
      const knownToolkits = new Set(items.some(item => item.kind === 'integration')
        ? (await listPluginExtensionAuthoringSharedMetadata(context, 'composio')).map(row => row.resource.application) : []);
      const fresh = items.flatMap(item => {
        if (item.kind === 'mcp') { const actual = mcps.get(item.id); return actual ? [metadataOnly(actual)] : []; }
        if (item.kind === 'integration') return catalogToolkits.has(item.toolkit.slug) || knownToolkits.has(item.toolkit.slug) ? [metadataOnly(item)] : [];
        if ((item.kind === 'plugin' || item.kind === 'skill') && item.package) {
          const actual = packages.get(item.id); return actual ? [metadataOnly(actual)] : [];
        }
        if ((item.kind === 'plugin' || item.kind === 'skill') && item.offering) {
          const installedResourceRefs = item.offering.installedResourceRefs.filter(ref => packages.has(ref));
          return [metadataOnly({ ...item, stock: installedResourceRefs.length ? 'installed' : 'available',
            offering: { ...item.offering, installedResourceRefs } })];
        }
        return [metadataOnly(item)];
      });
      await revalidatePluginExtensionAuthoringContext(context);
      return { items: fresh, coverage: [
        ...(packageResult && !['complete', 'not_configured'].includes(packageResult.coverage.status) ? [packageResult.coverage] : []),
        ...(mcpResult && !['complete', 'not_configured'].includes(mcpResult.coverage.status) ? [mcpResult.coverage] : []),
      ] };
    },
  } });
  await revalidatePluginExtensionAuthoringContext(context);
  return result;
}
