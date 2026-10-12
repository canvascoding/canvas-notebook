import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import { isAuthorizedIntegrationConnection, revalidateAuthorizedIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import { IntegrationConnectionError, type AuthorizedIntegrationConnection, type IntegrationConnectionOperation } from '@/app/lib/integration-tools/connections/contracts';
import type { ResolvedComposioContext } from './composio-context';
import { readAuthorizedSharedComposioProfile } from './composio-shared-profiles';

export async function resolveAuthorizedComposioConnectionContext(authorized: AuthorizedIntegrationConnection,
  database?: SqlConnection): Promise<ResolvedComposioContext> {
  if (!isAuthorizedIntegrationConnection(authorized) || authorized.backend.source !== 'composio') throw new IntegrationConnectionError('connection_not_found', 'The Composio connection was not found.', 404);
  const profile = await readAuthorizedSharedComposioProfile(authorized, database);
  return Object.freeze({ kind: 'resolved_composio_context' as const, userId: authorized.actor.userId,
    workspaceId: authorized.actor.workspaceId || (profile.ownership.type === 'team' ? profile.ownership.workspaceId : ''),
    profileId: profile.id, profileName: profile.name, profileSource: 'connection_binding' as const,
    composioUserId: profile.composioUserId, providerMode: profile.providerMode, profileOwnership: Object.freeze(profile.ownership),
    cacheRevision: `${profile.profileRevision}:${authorized.resource.bindingRevision}:${authorized.resource.grantsRevision}:${authorized.authorizationRevision}`,
    storageScope: Object.freeze({ secretScope: 'organization' as const, organizationId: profile.ownership.organizationId }),
    sharedBinding: Object.freeze({ authorization: authorized, profileRevision: profile.profileRevision }) });
}

export async function revalidateComposioConnectionContext(context: ResolvedComposioContext, operation?: IntegrationConnectionOperation,
  toolName?: string, database?: SqlConnection): Promise<ResolvedComposioContext> {
  if (!context.sharedBinding) return context;
  const previous = context.sharedBinding.authorization;
  const authorized = await revalidateAuthorizedIntegrationConnection(previous, operation, toolName);
  const fresh = await resolveAuthorizedComposioConnectionContext(authorized, database);
  if (fresh.profileId !== context.profileId || fresh.composioUserId !== context.composioUserId
    || fresh.providerMode !== context.providerMode || fresh.sharedBinding!.profileRevision !== context.sharedBinding.profileRevision) {
    throw new IntegrationConnectionError('binding_changed', 'The shared Composio profile changed. Reload the connection.', 409);
  }
  return fresh;
}
