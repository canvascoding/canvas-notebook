import 'server-only';

import { createHash } from 'node:crypto';
import { IntegrationConnectionError, isIntegrationConnectionError, type IntegrationConnectionActor, type IntegrationConnectionBackendBinding,
  type SharedIntegrationConnectionOwnership } from '@/app/lib/integration-tools/connections/contracts';
import { getManagedControlPlaneBaseUrl } from '@/app/lib/managed/control-plane-url';
import { getComposioForContext, getComposioModeForContext, getLocalComposioApiKeyForContext } from './composio-client';
import type { ResolvedComposioContext } from './composio-context';
import { inspectSharedComposioProfile, type SharedComposioProfile } from './composio-shared-profiles';
import { ManagedComposioProtocolError, requestManagedComposio } from './managed-composio-client';
import { classifyComposioFailure, ComposioProviderError } from './composio-provider-error';

const HIDDEN = new Set(['gemini', 'google_veo', 'nano_banana', 'openai', 'anthropic', 'google']);
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};

export function assertSharedComposioToolkit(value: string): string {
  const toolkit = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(toolkit) || HIDDEN.has(toolkit)) {
    throw new IntegrationConnectionError('provider_denied', 'The selected Composio app is unavailable.', 403);
  }
  return toolkit;
}

export function sharedComposioProfileManagementContext(actor: IntegrationConnectionActor, profile: SharedComposioProfile): ResolvedComposioContext {
  return Object.freeze({ kind: 'resolved_composio_context' as const, userId: actor.userId, workspaceId: actor.workspaceId || '',
    profileId: profile.id, profileName: profile.name, profileSource: 'connection_binding' as const, composioUserId: profile.composioUserId,
    profileOwnership: Object.freeze(profile.ownership), providerMode: profile.providerMode, cacheRevision: `${profile.profileRevision}:manage:${actor.userId}`,
    storageScope: Object.freeze({ secretScope: 'organization' as const, organizationId: profile.ownership.organizationId }) });
}

export async function withSharedComposioSignal<T>(mutation: boolean, callback: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), mutation ? 30_000 : 15_000);
  try { return await callback(controller.signal); }
  catch (error) {
    if (isIntegrationConnectionError(error)) throw error;
    if (error instanceof ManagedComposioProtocolError) throw new IntegrationConnectionError(error.code, error.message, error.status);
    const failure = classifyComposioFailure({ error, mutation, timeout: controller.signal.aborted });
    throw new IntegrationConnectionError(failure.code === 'COMPOSIO_OUTCOME_UNKNOWN' ? 'outcome_unknown'
      : ['COMPOSIO_AUTH_REQUIRED', 'COMPOSIO_CREDENTIALS_OR_SCOPE'].includes(failure.code) ? 'provider_denied' : 'provider_unavailable',
    failure.code === 'COMPOSIO_OUTCOME_UNKNOWN' ? 'The operation outcome is unknown. Check Composio before repeating it.'
      : 'The Composio connection could not be verified. Review its setup.', 503);
  } finally { clearTimeout(timer); }
}

export async function requireSharedManagedComposioCapabilities(context: ResolvedComposioContext, signal?: AbortSignal): Promise<string> {
  let capabilities: RecordValue;
  try { capabilities = record(await requestManagedComposio('/capabilities', { signal, bindingProtocolErrors: true }, context)); }
  catch (error) {
    if (error instanceof ComposioProviderError && error.upstreamStatus === 404) throw new IntegrationConnectionError('provider_unavailable', 'Update the Control Plane to use shared Composio connections.', 503);
    throw error;
  }
  if (capabilities.sharedBindingProtocolVersion !== 2 || capabilities.exactConnectionManagement !== true || capabilities.oauthAccountBinding !== true
    || typeof capabilities.credentialRevision !== 'string' || !capabilities.credentialRevision) {
    throw new IntegrationConnectionError('provider_unavailable', 'Update the Control Plane to use shared Composio connections.', 503);
  }
  return capabilities.credentialRevision;
}

export async function sharedComposioCredentialRevision(context: ResolvedComposioContext, signal?: AbortSignal): Promise<string> {
  const mode = await getComposioModeForContext(context);
  if (mode === 'disabled') throw new IntegrationConnectionError('setup_required', context.providerMode === 'local'
    ? 'Add the Composio key to the owning organization in Settings → Secrets.' : 'Managed Composio is unavailable for this shared connection.', 409);
  const identity = mode === 'local' ? await getLocalComposioApiKeyForContext(context)
    : [getManagedControlPlaneBaseUrl(), process.env.CANVAS_INSTANCE_TOKEN, await requireSharedManagedComposioCapabilities(context, signal)];
  return createHash('sha256').update(JSON.stringify([mode, context.profileId, context.composioUserId, context.profileOwnership, identity])).digest('hex');
}

export async function readSharedComposioToolkit(context: ResolvedComposioContext, slug: string) {
  const toolkit = assertSharedComposioToolkit(slug);
  const mode = await getComposioModeForContext(context);
  await sharedComposioCredentialRevision(context);
  return withSharedComposioSignal(false, async signal => {
    const client = mode === 'local' ? await getComposioForContext(context) : null;
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = record(mode === 'local' ? await client!.getClient().toolkits.list({ search: toolkit, limit: 1000, cursor }, { signal, maxRetries: 0 })
        : await requestManagedComposio('/toolkits', { signal, bindingProtocolErrors: true, query: new URLSearchParams({ search: toolkit, limit: '1000', ...(cursor ? { cursor } : {}) }) }, context));
      const items = result[mode === 'local' ? 'items' : 'toolkits'];
      const app = Array.isArray(items) ? items.map(record).find(item => item.slug === toolkit) : null;
      if (app) return { slug: toolkit, name: typeof app.name === 'string' ? app.name : toolkit, noAuth: (app.no_auth ?? app.noAuth) === true };
      const next = result.next_cursor ?? result.nextCursor;
      if (!next || typeof next !== 'string' || seen.has(next)) break;
      seen.add(next); cursor = next;
    }
    throw new IntegrationConnectionError('provider_denied', 'The selected Composio app could not be verified.', 403);
  });
}

export type SharedComposioAccount = { id: string; toolkit: string; label: string; status: string; isDisabled: boolean };

export async function listSharedComposioAppAccounts(context: ResolvedComposioContext): Promise<SharedComposioAccount[]> {
  const backend = context.sharedBinding?.authorization.backend;
  if (!backend || backend.source !== 'composio') throw new IntegrationConnectionError('invalid_request', 'An authorized app connection is required.');
  const toolkit = assertSharedComposioToolkit(backend.toolkit);
  const mode = await getComposioModeForContext(context);
  await sharedComposioCredentialRevision(context);
  return withSharedComposioSignal(false, async signal => {
    let values: RecordValue[] = [];
    if (mode === 'managed') {
      const result = record(await requestManagedComposio('/connections/accounts', { signal, bindingProtocolErrors: true }, context));
      if (!Array.isArray(result.accounts)) throw new IntegrationConnectionError('provider_unavailable', 'The app accounts could not be verified.', 503);
      values = result.accounts.map(record);
    } else {
      const client = await getComposioForContext(context);
      const seen = new Set<string>();
      let cursor: string | undefined;
      let complete = false;
      for (let page = 0; page < 20; page += 1) {
        const result = await client!.connectedAccounts.list({ userIds: [context.composioUserId], toolkitSlugs: [toolkit], limit: 100, cursor }, { signal });
        values.push(...result.items.map(item => item as unknown as RecordValue));
        if (!result.nextCursor) { complete = result.totalPages <= page + 1; break; }
        if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor)) break;
        seen.add(result.nextCursor); cursor = result.nextCursor;
      }
      if (!complete) throw new IntegrationConnectionError('provider_unavailable', 'The app account list was incomplete.', 503);
    }
    return values.filter(value => record(value.toolkit).slug === toolkit && typeof value.id === 'string').map((value, index) => ({
      id: value.id as string, toolkit, status: typeof value.status === 'string' ? value.status : 'UNKNOWN',
      isDisabled: value.isDisabled === true || value.is_disabled === true,
      label: typeof value.name === 'string' && value.name.trim() ? value.name.trim().replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0,100) : `Account ${index + 1}`,
    }));
  });
}

export async function readExactSharedComposioAccount(context: ResolvedComposioContext, accountId: string): Promise<SharedComposioAccount> {
  const backend = context.sharedBinding?.authorization.backend;
  if (!backend || backend.source !== 'composio') throw new IntegrationConnectionError('invalid_request', 'An authorized app connection is required.');
  if (context.providerMode === 'managed') {
    return withSharedComposioSignal(false, async signal => {
      await requireSharedManagedComposioCapabilities(context, signal);
      const result = record(await requestManagedComposio('/status', { signal, bindingProtocolErrors: true,
        query: new URLSearchParams({ toolkit: backend.toolkit, connectedAccountId: accountId }) }, context));
      const value = Array.isArray(result.connectedAccounts) ? result.connectedAccounts.map(record).find(item => item.id === accountId && record(item.toolkit).slug === backend.toolkit) : null;
      if (!value) throw new IntegrationConnectionError('binding_changed', 'The bound Composio account is unavailable.', 409);
      return { id: accountId, toolkit: backend.toolkit, label: 'Connected account', status: String(value.status || 'UNKNOWN'), isDisabled: value.isDisabled === true };
    });
  }
  const account = (await listSharedComposioAppAccounts(context)).find(item => item.id === accountId);
  if (!account) throw new IntegrationConnectionError('binding_changed', 'The bound Composio account is unavailable.', 409);
  return account;
}

export async function prepareSharedComposioConnectionBackend(actor: IntegrationConnectionActor, input: { profileId: string;
  ownership: SharedIntegrationConnectionOwnership; toolkit: string }): Promise<Extract<IntegrationConnectionBackendBinding, { source: 'composio' }>> {
  const profile = await inspectSharedComposioProfile(actor, input.profileId);
  if (profile.ownership.type !== input.ownership.type || profile.ownership.organizationId !== input.ownership.organizationId
    || profile.ownership.type === 'team' && (input.ownership.type !== 'team' || profile.ownership.workspaceId !== input.ownership.workspaceId)) {
    throw new IntegrationConnectionError('provider_denied', 'The profile belongs to a different scope.', 403);
  }
  const app = await readSharedComposioToolkit(sharedComposioProfileManagementContext(actor, profile), input.toolkit);
  return { source: 'composio', profileId: profile.id, toolkit: app.slug, mode: profile.providerMode,
    accountBinding: app.noAuth ? 'no_auth' : 'pending', connectedAccountId: null };
}
