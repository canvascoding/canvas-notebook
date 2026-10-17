import 'server-only';

import { createHash } from 'node:crypto';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { getComposioMode, getLocalComposioApiKey } from '@/app/lib/composio/composio-client';
import { resolveBoundComposioContext, type ResolvedComposioContext } from '@/app/lib/composio/composio-context';
import { readOwnedComposioProfileOnConnection } from '@/app/lib/composio/composio-profiles';
import { loadLocalComposioToolkitCatalogue, loadManagedComposioToolkitCatalogue } from '@/app/lib/integration-tools/adapters/composio';
import { resolveVerifiedAgentActorContextOnConnection } from './actor-context';
import { revalidateAgentExtensionOptionsContext, type AgentExtensionOptionsContext } from './extension-options-context';
import { AgentWorkflowError } from './workflow-contracts';

/** Opaque metadata preparation, never an account selection or an execution authorization. */
export type PreparedAgentExtensionPreviewProviderMetadata = Readonly<{ kind: 'prepared_agent_extension_preview_provider_metadata' }>;
const preparations = new WeakMap<PreparedAgentExtensionPreviewProviderMetadata, {
  context: AgentExtensionOptionsContext;
  mode: Awaited<ReturnType<typeof getComposioMode>>;
  profiles: ReadonlyMap<string, { context: ResolvedComposioContext; workspaceStamp: string }>;
}>();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const workspaceRow = (database: SqlConnection, workspaceId: string) => database.get(
  'SELECT id,organization_id,type,owner_user_id,project_id,status,is_default,updated_at FROM canvas_workspaces WHERE id=$1', [workspaceId]);
function changed(): never { throw new AgentWorkflowError('AGENT_EXTENSION_ACCOUNT_CHANGED', 'The exact selected profile or source changed. Reload its preview.', 409); }

/** Resolve only requested existing bindings before BEGIN, including the real legacy default workspace path. */
export async function prepareAgentExtensionPreviewProviderMetadata(context: AgentExtensionOptionsContext,
  profileIds: readonly string[]): Promise<PreparedAgentExtensionPreviewProviderMetadata> {
  await revalidateAgentExtensionOptionsContext(context);
  const mode = await getComposioMode({ secretScope: 'user', userId: context.actor.userId });
  const contexts = new Map<string, ResolvedComposioContext>();
  if (mode === 'managed') for (const profileId of new Set(profileIds)) {
    // An unavailable choice is reported by its actual per-selection preview;
    // it cannot cause another profile or a default account to be substituted.
    try { contexts.set(profileId, await resolveBoundComposioContext({ userId: context.actor.userId,
      workspaceId: context.actor.workspaceId, profileId })); } catch { /* No fallback. */ }
  }
  const profiles = new Map<string, { context: ResolvedComposioContext; workspaceStamp: string }>();
  if (contexts.size) {
    const database = await openDb();
    try {
      for (const [id, bound] of contexts) {
        const row = await workspaceRow(database, bound.workspaceId);
        if (row) profiles.set(id, { context: bound, workspaceStamp: digest(row) });
      }
    } finally { await database.close(); }
  }
  await revalidateAgentExtensionOptionsContext(context);
  const prepared = Object.freeze({ kind: 'prepared_agent_extension_preview_provider_metadata' as const });
  preparations.set(prepared, { context, mode, profiles });
  return prepared;
}

/** Toolkit-only lookup on the held lease: no defaults, profile writes, account/status/tool/business requests. */
export async function readAgentExtensionPreviewNoAuthMetadataOnConnection(database: SqlConnection,
  context: AgentExtensionOptionsContext, prepared: PreparedAgentExtensionPreviewProviderMetadata,
  profileId: string, toolkit: string): Promise<{ noAuth: boolean; stamp: string }> {
  const preparation = preparations.get(prepared);
  if (!preparation || preparation.context !== context) changed();
  await revalidateAgentExtensionOptionsContext(context, { database });
  const scope = { secretScope: 'user' as const, userId: context.actor.userId };
  const mode = await getComposioMode(scope);
  if (mode !== preparation.mode) changed();
  const profile = await readOwnedComposioProfileOnConnection(database, context.actor.userId, profileId);
  if (!profile) changed();
  const preparedProfile = preparation.profiles.get(profileId), bound = preparedProfile?.context;
  const assertBound = async () => {
    const current = await readOwnedComposioProfileOnConnection(database, context.actor.userId, profileId);
    if (!current || digest(current) !== digest(profile)) changed();
    if (mode !== 'managed') return;
    if (!bound || bound.userId !== context.actor.userId || bound.profileId !== profile.id
      || bound.profileName !== profile.name || bound.composioUserId !== profile.composioUserId
      || bound.cacheRevision !== `${profile.id}:${profile.updatedAt.getTime()}:binding`
      || context.actor.workspaceId && context.actor.workspaceId !== bound.workspaceId) changed();
    // Reuse actual workspace/organization ACL policy on this connection. Do not
    // call the bootstrap/default-selecting session workspace resolver here.
    await resolveVerifiedAgentActorContextOnConnection({ userId: context.actor.userId,
      organizationId: context.organizationId, workspaceId: bound.workspaceId }, database);
    const row = await workspaceRow(database, bound.workspaceId);
    if (!row || digest(row) !== preparedProfile!.workspaceStamp) changed();
  };
  await assertBound();
  const credentialStamp = mode === 'local' ? digest(await getLocalComposioApiKey(scope)) : null;
  const signal = AbortSignal.timeout(10_000);
  const catalogue = mode === 'local' ? await loadLocalComposioToolkitCatalogue(scope, signal, { search: toolkit })
    : mode === 'managed' && bound ? await loadManagedComposioToolkitCatalogue(bound, signal, { search: toolkit }) : null;
  await assertBound();
  if (await getComposioMode(scope) !== mode || mode === 'local' && digest(await getLocalComposioApiKey(scope)) !== credentialStamp) changed();
  await revalidateAgentExtensionOptionsContext(context, { database });
  const item = catalogue?.items.find(item => item.slug === toolkit);
  return { noAuth: Boolean(item && (item.noAuth ?? item.isNoAuth ?? item.no_auth) === true),
    stamp: digest([mode, profile, bound ?? null, credentialStamp, item ?? null]) };
}
