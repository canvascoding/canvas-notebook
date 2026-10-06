import 'server-only';

import type { ResolvedComposioContext } from './composio-context';

export function managedComposioConnectionContext(context: ResolvedComposioContext) {
  const shared = context.sharedBinding;
  if (!shared || shared.authorization.backend.source !== 'composio') return null;
  const { resource, actor, backend, operation, authorizationRevision } = shared.authorization;
  return { version: 1, connectionRef: resource.connectionRef, actorUserId: actor.userId, agentId: actor.agentId || null,
    sessionId: actor.sessionId || null, executionWorkspaceId: actor.workspaceId || null, ownership: resource.ownership,
    profileId: context.profileId, profileRevision: shared.profileRevision, metadataRevision: resource.metadataRevision,
    grantsRevision: resource.grantsRevision, bindingRevision: resource.bindingRevision, authorizationRevision, operation,
    toolkit: backend.toolkit, accountBinding: backend.accountBinding, connectedAccountId: backend.connectedAccountId };
}
