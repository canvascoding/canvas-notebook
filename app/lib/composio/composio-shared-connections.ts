import 'server-only';

import { authorizeIntegrationConnection, inspectSharedIntegrationConnection, publishIntegrationConnectionBinding,
  revalidateAuthorizedIntegrationConnection, withAuthorizedIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import { IntegrationConnectionError, type IntegrationConnectionActor, type IntegrationConnectionRevisions } from '@/app/lib/integration-tools/connections/contracts';
import type { SqlConnection } from '@/app/lib/db';
import type { ResolvedComposioContext } from './composio-context';
import { resolveAuthorizedComposioConnectionContext } from './composio-shared-context';
import { getComposioForContext, getLocalComposioApiKeyForContext } from './composio-client';
import { listSharedComposioAppAccounts, readExactSharedComposioAccount, readSharedComposioToolkit,
  requireSharedManagedComposioCapabilities, sharedComposioCredentialRevision, withSharedComposioSignal } from './composio-shared-backend';
import { createSharedComposioAccountReference, readSharedComposioAccountReference } from './composio-shared-account-reference';
import { bindSharedComposioOAuthPendingAccount, consumeSharedComposioOAuthFlowState, createSharedComposioOAuthFlowState } from './composio-shared-oauth-state';
import { requestManagedComposio } from './managed-composio-client';

function backend(context: ResolvedComposioContext) {
  const value = context.sharedBinding?.authorization.backend;
  if (!value || value.source !== 'composio') throw new IntegrationConnectionError('invalid_request', 'A shared Composio connection is required.');
  return value;
}

async function lockProfile(context: ResolvedComposioContext, database: SqlConnection): Promise<void> {
  const row = await database.get(`SELECT profile_revision,composio_user_id,provider_mode,status,owner_user_id,organization_id,workspace_id
    FROM composio_connection_profiles WHERE id = $1 FOR SHARE`, [context.profileId]) as Record<string, unknown> | undefined;
  const owner = context.profileOwnership;
  if (!row || !owner || row.owner_user_id !== null || row.status !== 'active' || row.provider_mode !== context.providerMode
    || row.composio_user_id !== context.composioUserId || Number(row.profile_revision) !== context.sharedBinding?.profileRevision
    || row.organization_id !== owner.organizationId || (row.workspace_id || null) !== (owner.type === 'team' ? owner.workspaceId : null)) {
    throw new IntegrationConnectionError('binding_changed', 'The shared Composio profile changed. Reload the connection.', 409);
  }
}

function expected(context: ResolvedComposioContext): IntegrationConnectionRevisions {
  const resource = context.sharedBinding!.authorization.resource;
  return { metadataRevision: resource.metadataRevision, grantsRevision: resource.grantsRevision, bindingRevision: resource.bindingRevision };
}

async function pinLocalMutationClient(context: ResolvedComposioContext) {
  if (context.providerMode !== 'local') return null;
  const client = await getComposioForContext(context);
  if (!client || client.getConfig().apiKey !== await getLocalComposioApiKeyForContext(context)) {
    throw new IntegrationConnectionError('binding_changed', 'The provider configuration changed. Reload the connection.', 409);
  }
  return client;
}

async function assertMutationCredential(context: ResolvedComposioContext, revision: string,
  client: Awaited<ReturnType<typeof pinLocalMutationClient>>) {
  if (revision !== await sharedComposioCredentialRevision(context)
    || context.providerMode === 'local' && (!client || client.getConfig().apiKey !== await getLocalComposioApiKeyForContext(context))) {
    throw new IntegrationConnectionError('binding_changed', 'The provider configuration changed. Reload the connection.', 409);
  }
}

export async function listSharedComposioConnectionAccounts(actor: IntegrationConnectionActor, connectionRef: string) {
  const auth = await authorizeIntegrationConnection(actor, connectionRef, 'manage');
  const context = await resolveAuthorizedComposioConnectionContext(auth);
  const revision = await sharedComposioCredentialRevision(context);
  const accounts = await listSharedComposioAppAccounts(context);
  await revalidateAuthorizedIntegrationConnection(auth, 'manage');
  if (await sharedComposioCredentialRevision(context) !== revision) throw new IntegrationConnectionError('binding_changed', 'The provider configuration changed. Load the accounts again.', 409);
  return { accounts: accounts.map(account => ({ accountRef: createSharedComposioAccountReference({ actorUserId: actor.userId,
    workspaceId: actor.workspaceId || null, connectionRef, profileId: context.profileId, profileRevision: context.sharedBinding!.profileRevision,
    toolkit: backend(context).toolkit, accountId: account.id, credentialRevision: revision, ...expected(context), authorizationRevision: auth.authorizationRevision }),
  label: account.label, status: account.status, selectable: account.status === 'ACTIVE' && !account.isDisabled })), revisions: expected(context) };
}

export async function bindSharedComposioConnectionAccount(actor: IntegrationConnectionActor, connectionRef: string,
  input: { accountRef: string; revisions: IntegrationConnectionRevisions }) {
  const selection = readSharedComposioAccountReference(input.accountRef);
  await withAuthorizedIntegrationConnection(actor, connectionRef, 'manage', input.revisions, async (auth, database) => {
    const context = await resolveAuthorizedComposioConnectionContext(auth);
    const binding = backend(context);
    await lockProfile(context, database);
    if (selection.actorUserId !== actor.userId || selection.workspaceId !== (actor.workspaceId || null) || selection.connectionRef !== connectionRef
      || selection.profileId !== context.profileId || selection.profileRevision !== context.sharedBinding!.profileRevision
      || selection.toolkit !== binding.toolkit || selection.authorizationRevision !== auth.authorizationRevision
      || selection.metadataRevision !== input.revisions.metadataRevision || selection.grantsRevision !== input.revisions.grantsRevision
      || selection.bindingRevision !== input.revisions.bindingRevision
      || selection.credentialRevision !== await sharedComposioCredentialRevision(context)) {
      throw new IntegrationConnectionError('binding_changed', 'The account selection changed. Load the app accounts again.', 409);
    }
    const app = await readSharedComposioToolkit(context, binding.toolkit);
    const account = await readExactSharedComposioAccount(context, selection.accountId);
    if (app.noAuth || account.status !== 'ACTIVE' || account.isDisabled) throw new IntegrationConnectionError('binding_changed', 'The selected account is not active for this app.', 409);
    if (selection.credentialRevision !== await sharedComposioCredentialRevision(context)) throw new IntegrationConnectionError('binding_changed', 'The provider configuration changed.', 409);
    await publishIntegrationConnectionBinding(actor, connectionRef, input.revisions, { ...binding, accountBinding: 'account', connectedAccountId: account.id });
  });
  return inspectSharedIntegrationConnection(actor, connectionRef);
}

export async function connectSharedComposioConnection(actor: IntegrationConnectionActor, connectionRef: string,
  input: { revisions: IntegrationConnectionRevisions; returnPath?: string | null }) {
  return withAuthorizedIntegrationConnection(actor, connectionRef, 'manage', input.revisions, async (auth, database) => {
    const context = await resolveAuthorizedComposioConnectionContext(auth);
    const binding = backend(context);
    await lockProfile(context, database);
    const credentialRevision = await sharedComposioCredentialRevision(context);
    const client = await pinLocalMutationClient(context);
    const app = await readSharedComposioToolkit(context, binding.toolkit);
    if (app.noAuth) {
      if (credentialRevision !== await sharedComposioCredentialRevision(context)) throw new IntegrationConnectionError('binding_changed', 'The provider configuration changed.', 409);
      await publishIntegrationConnectionBinding(actor, connectionRef, input.revisions, { ...binding, accountBinding: 'no_auth', connectedAccountId: null });
      return { redirectUrl: null, noAuth: true };
    }
    const flow = await createSharedComposioOAuthFlowState({ context, credentialRevision, returnPath: input.returnPath }, database);
    const linked = await withSharedComposioSignal(true, async signal => {
      if (binding.mode === 'managed') {
        await requireSharedManagedComposioCapabilities(context, signal);
        await assertMutationCredential(context, credentialRevision, client);
        return requestManagedComposio<{ redirectUrl: string; pendingAccountId: string }>(`/connect/${encodeURIComponent(binding.toolkit)}`,
          { method: 'POST', signal, bindingProtocolErrors: true, body: { returnUrl: flow.callbackUrl } }, context);
      }
      await assertMutationCredential(context, credentialRevision, client);
      const session = await client!.getClient().toolRouter.session.create({ user_id: context.composioUserId }, { signal, maxRetries: 0 });
      await assertMutationCredential(context, credentialRevision, client);
      const result = await client!.getClient().toolRouter.session.link(session.session_id, { toolkit: binding.toolkit, callback_url: flow.callbackUrl }, { signal, maxRetries: 0 });
      return { redirectUrl: result.redirect_url, pendingAccountId: result.connected_account_id };
    });
    if (!linked.redirectUrl || !linked.pendingAccountId || credentialRevision !== await sharedComposioCredentialRevision(context)) {
      throw new IntegrationConnectionError('binding_changed', 'The OAuth setup changed. Start it again.', 409);
    }
    await bindSharedComposioOAuthPendingAccount(flow.state, linked.pendingAccountId, database);
    return { redirectUrl: linked.redirectUrl, flowId: flow.state, expiresAt: new Date(flow.expiresAt).toISOString() };
  });
}

export async function completeSharedComposioOAuthFlow(state: string, providerError?: string | null) {
  const flow = await consumeSharedComposioOAuthFlowState(state);
  await withAuthorizedIntegrationConnection(flow.actor, flow.connectionRef, 'manage', flow.revisions, async (auth, database) => {
    const context = await resolveAuthorizedComposioConnectionContext(auth);
    const binding = backend(context);
    await lockProfile(context, database);
    if (auth.authorizationRevision !== flow.authorizationRevision || context.profileId !== flow.profileId
      || context.composioUserId !== flow.composioUserId || context.sharedBinding!.profileRevision !== flow.profileRevision
      || binding.toolkit !== flow.toolkit || binding.mode !== flow.providerMode || flow.credentialRevision !== await sharedComposioCredentialRevision(context)) {
      throw new IntegrationConnectionError('binding_changed', 'The shared OAuth scope or configuration changed. Start setup again.', 409);
    }
    if (providerError) return;
    const account = await readExactSharedComposioAccount(context, flow.pendingAccountId);
    if (account.status !== 'ACTIVE' || account.isDisabled) throw new IntegrationConnectionError('auth_required', 'The selected OAuth account is not active. Complete setup again.', 409);
    if (flow.credentialRevision !== await sharedComposioCredentialRevision(context)) throw new IntegrationConnectionError('binding_changed', 'The provider configuration changed during OAuth.', 409);
    await publishIntegrationConnectionBinding(flow.actor, flow.connectionRef, flow.revisions, { ...binding, accountBinding: 'account', connectedAccountId: flow.pendingAccountId });
  });
  return { returnPath: flow.returnPath, toolkit: flow.toolkit, connectionRef: flow.connectionRef,
    status: providerError ? providerError === 'access_denied' ? 'cancelled' : 'failed' : 'connected' };
}

export async function getSharedComposioConnectionStatus(actor: IntegrationConnectionActor, connectionRef: string) {
  const auth = await authorizeIntegrationConnection(actor, connectionRef, 'inspect');
  const context = await resolveAuthorizedComposioConnectionContext(auth);
  const binding = backend(context);
  if (binding.accountBinding === 'pending') return { state: 'setup_required' as const, connected: false, application: binding.toolkit, profileName: context.profileName };
  const app = await readSharedComposioToolkit(context, binding.toolkit);
  if (binding.accountBinding === 'no_auth') return { state: app.noAuth ? 'ready' as const : 'auth_required' as const, connected: app.noAuth, application: binding.toolkit, profileName: context.profileName };
  const account = await readExactSharedComposioAccount(context, binding.connectedAccountId!);
  return { state: account.status === 'ACTIVE' && !account.isDisabled ? 'ready' as const : 'auth_required' as const,
    connected: account.status === 'ACTIVE' && !account.isDisabled, application: binding.toolkit, profileName: context.profileName };
}

export async function disconnectSharedComposioConnection(actor: IntegrationConnectionActor, connectionRef: string, revisions: IntegrationConnectionRevisions) {
  await withAuthorizedIntegrationConnection(actor, connectionRef, 'manage', revisions, async (auth, database) => {
    const context = await resolveAuthorizedComposioConnectionContext(auth);
    const binding = backend(context);
    await lockProfile(context, database);
    const credentialRevision = await sharedComposioCredentialRevision(context);
    const client = await pinLocalMutationClient(context);
    if (binding.accountBinding === 'account' && binding.connectedAccountId) {
      await readExactSharedComposioAccount(context, binding.connectedAccountId);
      await withSharedComposioSignal(true, async signal => {
        await assertMutationCredential(context, credentialRevision, client);
        if (binding.mode === 'managed') return requestManagedComposio(`/disconnect/${encodeURIComponent(binding.toolkit)}`, { method: 'DELETE', signal, bindingProtocolErrors: true }, context);
        return client!.getClient().connectedAccounts.delete(binding.connectedAccountId!, {}, { signal, maxRetries: 0 });
      });
    }
    if (credentialRevision !== await sharedComposioCredentialRevision(context)) throw new IntegrationConnectionError('binding_changed', 'The provider configuration changed.', 409);
    await publishIntegrationConnectionBinding(actor, connectionRef, revisions, { ...binding, accountBinding: 'pending', connectedAccountId: null });
  });
  return inspectSharedIntegrationConnection(actor, connectionRef);
}
