import 'server-only';

import { authorizeIntegrationConnection, inspectSharedIntegrationConnection, isAuthorizedIntegrationConnection, publishIntegrationConnectionBinding,
  revalidateAuthorizedIntegrationConnection, withAuthorizedIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import { IntegrationConnectionError, type IntegrationConnectionActor, type IntegrationConnectionRevisions } from '@/app/lib/integration-tools/connections/contracts';
import type { SqlConnection } from '@/app/lib/db';
import type { ResolvedComposioContext } from './composio-context';
import { resolveAuthorizedComposioConnectionContext, revalidateComposioConnectionContext } from './composio-shared-context';
import { getComposioForContext, getLocalComposioApiKeyForContext } from './composio-client';
import { listSharedComposioAppAccounts, readExactSharedComposioAccount, readSharedComposioToolkit,
  requireSharedManagedComposioCapabilities, sharedComposioCredentialRevision, withSharedComposioSignal,
  type SharedComposioAccount } from './composio-shared-backend';
import { createSharedComposioAccountReference, readSharedComposioAccountReference } from './composio-shared-account-reference';
import { bindSharedComposioOAuthPendingAccount, consumeSharedComposioOAuthFlowState, createSharedComposioOAuthFlowState,
  resolveSharedComposioOAuthReturnPath } from './composio-shared-oauth-state';
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

export type PreparedSharedComposioOAuthProviderStart = Readonly<{
  context: ResolvedComposioContext;
  credentialRevision: string;
  noAuth: boolean;
}>;
export type SharedComposioOAuthProviderOptions = { assertAuthorization?: () => Promise<void>; database?: SqlConnection };
const preparedOAuthProviders = new WeakMap<PreparedSharedComposioOAuthProviderStart, {
  client: Awaited<ReturnType<typeof pinLocalMutationClient>>;
  used: boolean;
}>();

/** Call from the existing held connection-management transaction; preparation creates no provider account. */
export async function prepareSharedComposioOAuthProviderStart(context: ResolvedComposioContext,
  database: SqlConnection): Promise<PreparedSharedComposioOAuthProviderStart> {
  const authorization = context.sharedBinding?.authorization;
  if (!isAuthorizedIntegrationConnection(authorization) || authorization.operation !== 'manage'
    || !authorization.access.canManage || authorization.backend.source !== 'composio') {
    throw new IntegrationConnectionError('invalid_request', 'A current managed app connection is required.');
  }
  const current = await revalidateComposioConnectionContext(context, 'manage', undefined, database);
  await lockProfile(current, database);
  const credentialRevision = await sharedComposioCredentialRevision(current);
  const client = await pinLocalMutationClient(current);
  const app = await readSharedComposioToolkit(current, backend(current).toolkit);
  await assertMutationCredential(current, credentialRevision, client);
  await revalidateComposioConnectionContext(current, 'manage', undefined, database);
  const prepared = Object.freeze({ context: current, credentialRevision, noAuth: app.noAuth });
  preparedOAuthProviders.set(prepared, { client, used: false });
  return prepared;
}

/** The caller must durably record its desktop start intent before this one-use provider mutation. */
export async function linkPreparedSharedComposioOAuthProvider(prepared: PreparedSharedComposioOAuthProviderStart,
  callbackUrl: string, options: SharedComposioOAuthProviderOptions = {}): Promise<{ redirectUrl: string; pendingAccountId: string }> {
  const receipt = preparedOAuthProviders.get(prepared);
  if (!receipt || receipt.used || prepared.noAuth) {
    throw new IntegrationConnectionError('invalid_request', 'A fresh authentication-required app preparation is required.');
  }
  let callback: URL;
  try {
    if (typeof callbackUrl !== 'string' || !callbackUrl || callbackUrl.length > 8192 || callbackUrl !== callbackUrl.trim()
      || /[\x00-\x1f\x7f]/u.test(callbackUrl)) throw new Error('invalid_callback');
    callback = new URL(callbackUrl);
    if (!['https:', 'http:'].includes(callback.protocol) || callback.username || callback.password) throw new Error('invalid_callback');
  } catch { throw new IntegrationConnectionError('invalid_request', 'The app authentication callback is invalid.'); }
  receipt.used = true;
  const { context, credentialRevision } = prepared;
  const binding = backend(context), client = receipt.client;
  const linked = await withSharedComposioSignal(true, async signal => {
    if (binding.mode === 'managed') {
      await requireSharedManagedComposioCapabilities(context, signal);
      await assertMutationCredential(context, credentialRevision, client);
      await revalidateComposioConnectionContext(context, 'manage', undefined, options.database);
      await options.assertAuthorization?.();
      return requestManagedComposio<{ redirectUrl: unknown; pendingAccountId: unknown }>(`/connect/${encodeURIComponent(binding.toolkit)}`,
        { method: 'POST', signal, bindingProtocolErrors: true, body: { returnUrl: callback.href } }, context);
    }
    await assertMutationCredential(context, credentialRevision, client);
    await revalidateComposioConnectionContext(context, 'manage', undefined, options.database);
    await options.assertAuthorization?.();
    const session = await client!.getClient().toolRouter.session.create({ user_id: context.composioUserId }, { signal, maxRetries: 0 });
    if (!session || typeof session !== 'object' || Array.isArray(session)
      || typeof session.session_id !== 'string' || !session.session_id || session.session_id.length > 512
      || session.session_id !== session.session_id.trim() || /[\x00-\x1f\x7f]/u.test(session.session_id)) {
      throw new IntegrationConnectionError('provider_unavailable', 'The provider authentication session could not be verified.', 503);
    }
    await assertMutationCredential(context, credentialRevision, client);
    await revalidateComposioConnectionContext(context, 'manage', undefined, options.database);
    await options.assertAuthorization?.();
    const result = await client!.getClient().toolRouter.session.link(session.session_id,
      { toolkit: binding.toolkit, callback_url: callback.href }, { signal, maxRetries: 0 });
    return { redirectUrl: result.redirect_url, pendingAccountId: result.connected_account_id };
  });
  await assertMutationCredential(context, credentialRevision, client);
  await revalidateComposioConnectionContext(context, 'manage', undefined, options.database);
  await options.assertAuthorization?.();
  if (!linked || typeof linked !== 'object' || Array.isArray(linked)
    || typeof linked.pendingAccountId !== 'string' || !linked.pendingAccountId || linked.pendingAccountId.length > 256
    || linked.pendingAccountId !== linked.pendingAccountId.trim() || /[\x00-\x1f\x7f]/u.test(linked.pendingAccountId)) {
    throw new IntegrationConnectionError('provider_unavailable', 'The OAuth account could not be verified.', 503);
  }
  try {
    if (typeof linked.redirectUrl !== 'string' || !linked.redirectUrl || linked.redirectUrl.length > 8192
      || linked.redirectUrl !== linked.redirectUrl.trim() || /[\x00-\x1f\x7f]/u.test(linked.redirectUrl)) throw new Error('invalid_redirect');
    const redirect = new URL(linked.redirectUrl);
    if (!['https:', 'http:'].includes(redirect.protocol) || redirect.username || redirect.password) throw new Error('invalid_redirect');
  } catch { throw new IntegrationConnectionError('provider_unavailable', 'The provider authentication address could not be verified.', 503); }
  return { redirectUrl: linked.redirectUrl, pendingAccountId: linked.pendingAccountId };
}

/** Verify the captured account through the existing local/managed backend, without publishing a binding. */
export async function verifySharedComposioOAuthAccount(context: ResolvedComposioContext, accountId: string,
  expectedCredentialRevision: string, database: SqlConnection,
  options: SharedComposioOAuthProviderOptions = {}): Promise<SharedComposioAccount> {
  const authorization = context.sharedBinding?.authorization;
  if (!isAuthorizedIntegrationConnection(authorization) || authorization.operation !== 'manage'
    || !authorization.access.canManage || authorization.backend.source !== 'composio') {
    throw new IntegrationConnectionError('invalid_request', 'A current managed app connection is required.');
  }
  if (typeof accountId !== 'string' || !accountId || accountId.length > 256 || accountId !== accountId.trim()
    || /[\x00-\x1f\x7f]/u.test(accountId) || typeof expectedCredentialRevision !== 'string'
    || !/^[a-f0-9]{64}$/u.test(expectedCredentialRevision)) {
    throw new IntegrationConnectionError('invalid_request', 'The captured app account is invalid.');
  }
  await options.assertAuthorization?.();
  const current = await revalidateComposioConnectionContext(context, 'manage', undefined, database);
  await lockProfile(current, database);
  if (expectedCredentialRevision !== await sharedComposioCredentialRevision(current)) {
    throw new IntegrationConnectionError('binding_changed', 'The provider configuration changed during OAuth.', 409);
  }
  await options.assertAuthorization?.();
  const account = await readExactSharedComposioAccount(current, accountId);
  if (expectedCredentialRevision !== await sharedComposioCredentialRevision(current)) {
    throw new IntegrationConnectionError('binding_changed', 'The provider configuration changed during OAuth.', 409);
  }
  await revalidateComposioConnectionContext(current, 'manage', undefined, database);
  await options.assertAuthorization?.();
  if (account.id !== accountId || account.toolkit !== backend(current).toolkit || account.status !== 'ACTIVE' || account.isDisabled) {
    throw new IntegrationConnectionError('auth_required', 'The selected OAuth account is not active. Complete setup again.', 409);
  }
  return account;
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
    const context = await resolveAuthorizedComposioConnectionContext(auth, database);
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
  input: { revisions: IntegrationConnectionRevisions; returnPath?: string | null; returnLocale?: 'de' | 'en'; catalogReturnPath?: string }) {
  return withAuthorizedIntegrationConnection(actor, connectionRef, 'manage', input.revisions, async (auth, database) => {
    const context = await resolveAuthorizedComposioConnectionContext(auth, database);
    const binding = backend(context);
    const returnPath = resolveSharedComposioOAuthReturnPath(context, input);
    const prepared = await prepareSharedComposioOAuthProviderStart(context, database);
    if (prepared.noAuth) {
      if (prepared.credentialRevision !== await sharedComposioCredentialRevision(prepared.context)) throw new IntegrationConnectionError('binding_changed', 'The provider configuration changed.', 409);
      await publishIntegrationConnectionBinding(actor, connectionRef, input.revisions, { ...binding, accountBinding: 'no_auth', connectedAccountId: null });
      return { redirectUrl: null, noAuth: true };
    }
    const flow = await createSharedComposioOAuthFlowState({ context: prepared.context, credentialRevision: prepared.credentialRevision, returnPath,
      returnLocale: input.returnLocale, catalogReturnPath: input.catalogReturnPath }, database);
    const linked = await linkPreparedSharedComposioOAuthProvider(prepared, flow.callbackUrl, { database });
    await bindSharedComposioOAuthPendingAccount(flow.state, linked.pendingAccountId, database);
    return { redirectUrl: linked.redirectUrl, flowId: flow.state, expiresAt: new Date(flow.expiresAt).toISOString() };
  });
}

export async function completeSharedComposioOAuthFlow(state: string, providerError?: string | null) {
  const flow = await consumeSharedComposioOAuthFlowState(state);
  const returnPath = await withAuthorizedIntegrationConnection(flow.actor, flow.connectionRef, 'manage', flow.revisions, async (auth, database) => {
    const context = await resolveAuthorizedComposioConnectionContext(auth, database);
    const binding = backend(context);
    if (!flow.returnPath) throw new IntegrationConnectionError('invalid_request', 'The shared sign-in return path is invalid.');
    const returnPath = resolveSharedComposioOAuthReturnPath(context, { returnPath: flow.returnPath });
    await lockProfile(context, database);
    if (auth.authorizationRevision !== flow.authorizationRevision || context.profileId !== flow.profileId
      || auth.resource.ownership.type !== flow.ownership.type || auth.resource.ownership.organizationId !== flow.ownership.organizationId
      || (auth.resource.ownership.type === 'team' ? auth.resource.ownership.workspaceId : null) !== (flow.ownership.type === 'team' ? flow.ownership.workspaceId : null)
      || context.composioUserId !== flow.composioUserId || context.sharedBinding!.profileRevision !== flow.profileRevision
      || binding.toolkit !== flow.toolkit || binding.mode !== flow.providerMode || flow.credentialRevision !== await sharedComposioCredentialRevision(context)) {
      throw new IntegrationConnectionError('binding_changed', 'The shared OAuth scope or configuration changed. Start setup again.', 409);
    }
    if (providerError) return returnPath;
    const account = await readExactSharedComposioAccount(context, flow.pendingAccountId);
    if (account.status !== 'ACTIVE' || account.isDisabled) throw new IntegrationConnectionError('auth_required', 'The selected OAuth account is not active. Complete setup again.', 409);
    if (flow.credentialRevision !== await sharedComposioCredentialRevision(context)) throw new IntegrationConnectionError('binding_changed', 'The provider configuration changed during OAuth.', 409);
    await publishIntegrationConnectionBinding(flow.actor, flow.connectionRef, flow.revisions, { ...binding, accountBinding: 'account', connectedAccountId: flow.pendingAccountId });
    return returnPath;
  });
  return { returnPath, toolkit: flow.toolkit, connectionRef: flow.connectionRef,
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
    const context = await resolveAuthorizedComposioConnectionContext(auth, database);
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
