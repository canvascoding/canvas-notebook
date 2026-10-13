import 'server-only';

import { CapabilityPackageError } from './contracts';
import type { CapabilityPackageMcpTemplate } from './presentation-contracts';
import type { CapabilityResourceActor } from '@/app/lib/capabilities/resources/contracts';
import type { PluginExtensionItem } from '@/app/lib/plugins/plugin-extension-contracts';

export type CapabilityPackageMcpMatches = { source: CapabilityPackageMcpTemplate['source'];
  matches: Array<{ connectionRef: string; compatibility: 'endpoint' | 'stdio' }>; coverage: 'complete' | 'partial' };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Compatibility concerns the declared endpoint/process, never a display name, credentials or agent permission. */
export function capabilityPackageMcpConfigCompatibility(template: CapabilityPackageMcpTemplate,
  connection: Record<string, unknown>): 'endpoint' | 'stdio' | null {
  const config = template.config;
  if (!config) return null;
  const oauth = (value: Record<string, unknown>) => value.auth === 'oauth' || record(value.oauth);
  const requiresOAuth = template.connector.oauth === true || oauth(config);
  if (requiresOAuth !== oauth(connection)) return null;
  if (typeof config.url === 'string' && !config.command && !connection.command && typeof connection.url === 'string'
    && !template.redactedFields.includes('url')) {
    try {
      const expected = new URL(config.url), actual = new URL(connection.url);
      return ['http:', 'https:'].includes(expected.protocol) && expected.href === actual.href ? 'endpoint' : null;
    } catch { return null; }
  }
  if (typeof config.command === 'string' && !config.url && !connection.url && config.command === connection.command
    && !template.redactedFields.some(field => field === 'command' || field === 'cwd' || field === 'args' || field.startsWith('args.'))
    && !connection.cwd && Array.isArray(config.args ?? []) && Array.isArray(connection.args ?? [])
    && JSON.stringify(config.args ?? []) === JSON.stringify(connection.args ?? [])) return 'stdio';
  return null;
}

type Dependencies = {
  template: (actor: CapabilityResourceActor, ref: string, query: unknown) => Promise<CapabilityPackageMcpTemplate>;
  catalog: (actor: CapabilityResourceActor) => Promise<{ items: PluginExtensionItem[]; coverage: { status: string } }>;
  config: (actor: CapabilityResourceActor, item: Extract<PluginExtensionItem, { kind: 'mcp' }>) => Promise<Record<string, unknown>>;
};
async function defaultDependencies(): Promise<Dependencies> {
  const [{ inspectCapabilityPackageMcpTemplateAction }, { readMcpExtensions }, { requireMcpUserAccess, assertMcpConnectionAccess },
    { resolveSharedMcpBackend }, { revalidateAuthorizedIntegrationConnection }] = await Promise.all([
    import('./presentation-actions'), import('@/app/lib/plugins/plugin-extension-integrations'), import('@/app/lib/mcp/access'),
    import('@/app/lib/mcp/shared-connections'), import('@/app/lib/integration-tools/connections/store'),
  ]);
  return { template: inspectCapabilityPackageMcpTemplateAction, catalog: readMcpExtensions,
    config: async (actor, item) => {
      if (item.mcp.connectionRef) {
        const backend = await resolveSharedMcpBackend(actor, item.mcp.connectionRef, 'inspect');
        await revalidateAuthorizedIntegrationConnection(backend.authorization, 'inspect');
        return backend.connection as unknown as Record<string, unknown>;
      }
      if (!item.mcp.serverId) throw new CapabilityPackageError('PACKAGE_NOT_FOUND', 'The MCP connection is unavailable.', 404);
      const current = await requireMcpUserAccess({ userId: actor.userId });
      if (!current) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'Current MCP access is required.', 403);
      const { connection } = await assertMcpConnectionAccess(item.mcp.serverId, { userId: actor.userId, organizationId: current.organizationId }, { actor: current });
      return connection as unknown as Record<string, unknown>;
    } };
}

/** A safe human-management projection. It reads local configuration, never starts a provider or exports backend secrets. */
export async function inspectCapabilityPackageMcpMatches(actorInput: CapabilityResourceActor, resourceRef: string, query: unknown,
  options: { dependencies?: Dependencies } = {}): Promise<CapabilityPackageMcpMatches> {
  const actor = Object.freeze({ userId: actorInput.userId, workspaceId: actorInput.workspaceId ?? null });
  const dependencies = options.dependencies ?? await defaultDependencies();
  const template = await dependencies.template(actor, resourceRef, query), catalog = await dependencies.catalog(actor);
  const matches: CapabilityPackageMcpMatches['matches'] = [];
  let partial = catalog.coverage.status !== 'complete';
  // Provider definitions are suggestions; only existing currently readable connections can satisfy setup.
  for (const item of catalog.items) {
    if (item.kind !== 'mcp' || item.mcp.template || !item.access.canRead || item.stock !== 'installed') continue;
    try {
      const config = await dependencies.config(actor, item), compatibility = capabilityPackageMcpConfigCompatibility(template, config);
      if (config.enabled !== false && compatibility) matches.push({ connectionRef: item.id, compatibility });
    } catch { partial = true; }
  }
  // Configuration and permissions can change while another candidate is checked.
  // Re-read only the matched rows before publishing their public identities.
  const latest = await dependencies.catalog(actor);
  partial ||= latest.coverage.status !== 'complete';
  const currentItems = new Map(latest.items.filter(item => item.kind === 'mcp' && item.access.canRead && item.stock === 'installed').map(item => [item.id, item]));
  const confirmed: CapabilityPackageMcpMatches['matches'] = [];
  for (const match of matches) {
    const item = currentItems.get(match.connectionRef);
    if (!item || item.kind !== 'mcp' || item.mcp.template) continue;
    try {
      const config = await dependencies.config(actor, item), compatibility = capabilityPackageMcpConfigCompatibility(template, config);
      if (config.enabled !== false && compatibility) confirmed.push({ connectionRef: item.id, compatibility });
    } catch { partial = true; }
  }
  const current = await dependencies.template(actor, resourceRef, query);
  if (JSON.stringify(current.source) !== JSON.stringify(template.source)) throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The MCP template changed. Reload its current version.', 409);
  return { source: current.source, matches: [...new Map(confirmed.map(value => [value.connectionRef, value])).values()], coverage: partial ? 'partial' : 'complete' };
}
