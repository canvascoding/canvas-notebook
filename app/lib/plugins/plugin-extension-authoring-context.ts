import 'server-only';

import { createHash } from 'node:crypto';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { resolveVerifiedAgentActorContextOnConnection } from '@/app/lib/agents/actor-context';
import type { CapabilityResourceActor } from '@/app/lib/capabilities/resources/contracts';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import { authorizeIntegrationConnection, listSharedIntegrationConnections,
  type IntegrationConnectionBindingAuthorization } from '@/app/lib/integration-tools/connections/store';

/** Read/copy metadata context. It is neither a prospective Agent nor an executable binding. */
export type PluginExtensionAuthoringContext = {
  readonly actor: CapabilityResourceActor;
  readonly target: { readonly kind: 'authoring' };
  readonly organizationId: string | null;
  readonly scopeType: 'user';
  readonly allowPersonal: true;
  readonly contextKey: string;
};
const proofKey = Symbol.for('canvas.plugin.extension-authoring-context.v1');
const proofHost = globalThis as typeof globalThis & { [proofKey]?: WeakSet<object> };
const contexts = proofHost[proofKey] ??= new WeakSet<object>();
const denied = () => new CapabilityResourceError('PLUGIN_CATALOG_ACCESS_DENIED', 'A current server-issued metadata context is required.', 403);

export async function resolvePluginExtensionAuthoringContext(input: CapabilityResourceActor,
  options: { database?: SqlConnection } = {}): Promise<PluginExtensionAuthoringContext> {
  const actor = Object.freeze({ userId: input.userId, workspaceId: input.workspaceId ?? null });
  const database = options.database ?? await openDb();
  try {
    const verified = await resolveVerifiedAgentActorContextOnConnection(actor, database);
    const context: PluginExtensionAuthoringContext = Object.freeze({ actor, target: Object.freeze({ kind: 'authoring' as const }),
      organizationId: verified.organizationId, scopeType: 'user', allowPersonal: true,
      contextKey: createHash('sha256').update(JSON.stringify([actor, verified.organizationId,
        verified.organizationRole, verified.context, verified.workspacePermissions])).digest('base64url') });
    contexts.add(context);
    return context;
  } finally { if (!options.database) await database.close(); }
}

export function isPluginExtensionAuthoringContext(value: object): value is PluginExtensionAuthoringContext {
  return contexts.has(value);
}

export async function revalidatePluginExtensionAuthoringContext(context: PluginExtensionAuthoringContext,
  options: { database?: SqlConnection } = {}): Promise<void> {
  if (!contexts.has(context)) throw denied();
  const current = await resolvePluginExtensionAuthoringContext(context.actor, options);
  if (current.contextKey !== context.contextKey) throw denied();
}

export async function authorizePluginExtensionAuthoringSharedMetadata(context: PluginExtensionAuthoringContext,
  reference: string): Promise<IntegrationConnectionBindingAuthorization> {
  await revalidatePluginExtensionAuthoringContext(context);
  const current = await authorizeIntegrationConnection({ ...context.actor, organizationId: context.organizationId }, reference, 'inspect');
  await revalidatePluginExtensionAuthoringContext(context);
  // A projected metadata row is not a server-issued execution authorization.
  return { ...current, canUse: false, canManage: false };
}

export async function listPluginExtensionAuthoringSharedMetadata(context: PluginExtensionAuthoringContext,
  source?: 'mcp' | 'composio'): Promise<IntegrationConnectionBindingAuthorization[]> {
  await revalidatePluginExtensionAuthoringContext(context);
  const rows = await listSharedIntegrationConnections({ ...context.actor, organizationId: context.organizationId }, source);
  const result: IntegrationConnectionBindingAuthorization[] = [];
  for (const row of rows) {
    if (!row.access.canRead || row.resource.status !== 'active') continue;
    // Fresh inspect, never Use/Configure or a target-only Agent grant.
    try { result.push(await authorizePluginExtensionAuthoringSharedMetadata(context, row.resource.connectionRef)); }
    catch (error) { if (!error || typeof error !== 'object' || ![403, 404].includes(Number(Reflect.get(error, 'status')))) throw error; }
  }
  await revalidatePluginExtensionAuthoringContext(context);
  return result;
}
