import 'server-only';

import { createHash } from 'node:crypto';
import { getComposio, getComposioMode } from '@/app/lib/composio/composio-client';
import {
  resolveBoundComposioContext,
  resolveComposioContext,
  type ResolvedComposioContext,
} from '@/app/lib/composio/composio-context';
import { listComposioProfiles } from '@/app/lib/composio/composio-profiles';
import { classifyComposioFailure, ComposioProviderError } from '@/app/lib/composio/composio-provider-error';
import { resolveComposioToolkitAccess } from '@/app/lib/composio/composio-toolkit-access';
import { requestManagedComposio } from '@/app/lib/composio/managed-composio-client';
import type {
  IntegrationExecutionContext,
  IntegrationPolicy,
  IntegrationProviderDescriptor,
  IntegrationProviderError,
  IntegrationSourceSnapshot,
} from '../contracts';
import { createIntegrationProviderRef } from '../references';
import { integrationConnectionActorFromContext } from '../connections/contracts';
import { revalidateIntegrationProviderAuthorization } from '../connections/provider-authorization';
import { createSharedIntegrationPolicyDescriptor } from '../connections/provider-policy';
import { isIntegrationProviderVisible } from '../policy';

// Keep the same native-provider exclusions as the existing Composio catalogue.
const HIDDEN_TOOLKITS = new Set(['gemini', 'google_veo', 'nano_banana', 'openai', 'anthropic', 'google']);
const CATALOGUE_TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;

type RecordValue = Record<string, unknown>;
type Collection = { items: RecordValue[]; complete: boolean; errors: IntegrationProviderError[] };
type ProfileAccounts = Collection & { context: ResolvedComposioContext; configured: boolean };

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toolkitSlug(value: unknown): string {
  const slug = string(value);
  return slug && slug.length <= 128 && !HIDDEN_TOOLKITS.has(slug.toLowerCase()) ? slug : '';
}

export function isComposioIntegrationApplicationVisible(value: string): boolean {
  return toolkitSlug(value) === value;
}

async function sharedProviders(context: IntegrationExecutionContext, policy?: IntegrationPolicy): Promise<IntegrationSourceSnapshot> {
  const { listSharedIntegrationConnections, authorizeIntegrationConnection } = await import('../connections/store');
  const actor = integrationConnectionActorFromContext(context);
  const connections = await listSharedIntegrationConnections(actor, 'composio');
  const providers: IntegrationProviderDescriptor[] = [];
  const providerErrors: IntegrationProviderError[] = [];
  const revisions: unknown[] = [];
  const { resolveSharedComposioIntegrationProvider } = await import('./composio-runtime');
  for (const { resource } of connections) {
    if (resource.status !== 'active' || !resource.application || !isComposioIntegrationApplicationVisible(resource.application)) continue;
    try {
      const authorization = await authorizeIntegrationConnection(actor, resource.connectionRef, 'inspect');
      if (policy && !isIntegrationProviderVisible(context, policy, await createSharedIntegrationPolicyDescriptor(context, authorization))) continue;
      const resolved = await resolveSharedComposioIntegrationProvider(context, authorization);
      await revalidateIntegrationProviderAuthorization(context, resolved.provider);
      providers.push(resolved.provider);
      revisions.push([resource.connectionRef, authorization.authorizationRevision, resolved.bindingRevision]);
    } catch {
      providerErrors.push({ source: 'composio', code: 'COMPOSIO_SHARED_STATUS_UNAVAILABLE',
        message: 'A shared Composio connection could not be checked.', retryable: true });
    }
  }
  return { source: 'composio', providers, providerErrors, complete: providerErrors.length === 0,
    revision: createHash('sha256').update(JSON.stringify([revisions, providerErrors])).digest('base64url') };
}

async function mergeSharedProviders(personal: IntegrationSourceSnapshot, shared: Promise<IntegrationSourceSnapshot>): Promise<IntegrationSourceSnapshot> {
  const additions = await shared;
  return { source: 'composio', providers: [...personal.providers, ...additions.providers].sort((a,b) => a.providerRef.localeCompare(b.providerRef)),
    complete: personal.complete && additions.complete, providerErrors: [...personal.providerErrors, ...additions.providerErrors],
    revision: createHash('sha256').update(JSON.stringify([personal.revision, additions.revision])).digest('base64url') };
}

function safeFailure(error: unknown, operation: 'catalogue' | 'accounts' | 'profiles'): IntegrationProviderError {
  const normalized = error instanceof ComposioProviderError ? error : classifyComposioFailure({ error });
  return {
    source: 'composio', code: normalized.code, retryable: normalized.retryable,
    message: operation === 'catalogue' ? 'The Composio app catalogue could not be fully loaded.'
      : operation === 'accounts' ? 'A Composio connection profile could not be fully checked.'
        : 'The Composio connection profiles could not be fully resolved.',
  };
}

function badResponse(): ComposioProviderError {
  return new ComposioProviderError('Composio returned an incomplete catalogue response.', {
    code: 'COMPOSIO_BAD_RESPONSE', retryable: false,
  });
}

/** Preserve successful pages and stop malformed, repeated or unbounded cursors. */
async function collectPages(
  load: (cursor?: string) => Promise<unknown>,
  itemKey: 'items' | 'toolkits',
  operation: 'catalogue' | 'accounts',
  signal: AbortSignal,
): Promise<Collection> {
  const items: RecordValue[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      signal.throwIfAborted();
      const result = record(await load(cursor));
      if (!Array.isArray(result[itemKey])) throw badResponse();
      items.push(...(result[itemKey] as unknown[]).map(record));
      const next = result.nextCursor ?? result.next_cursor;
      if (next === null || next === undefined || next === '') {
        // A provider that advertises more pages must also provide a cursor.
        const totalPages = Number(result.totalPages ?? result.total_pages ?? 1);
        if (Number.isFinite(totalPages) && totalPages > page + 1) throw badResponse();
        return { items, complete: true, errors: [] };
      }
      if (typeof next !== 'string' || cursors.has(next)) throw badResponse();
      cursors.add(next);
      cursor = next;
    }
    throw badResponse();
  } catch (error) {
    return { items, complete: false, errors: [safeFailure(error, operation)] };
  }
}

async function loadLocalCollections(contexts: readonly ResolvedComposioContext[], signal: AbortSignal) {
  const client = await getComposio(contexts[0].storageScope);
  if (!client) throw badResponse();
  // The core SDK's toolkits.get() returns only an array and discards next_cursor.
  // Its public API client retains pagination without creating another credential path.
  const cataloguePromise = collectPages((cursor) => client.getClient().toolkits.list({
    limit: 1000, ...(cursor ? { cursor } : {}),
  }, { signal, maxRetries: 0 }), 'items', 'catalogue', signal);
  const accounts: ProfileAccounts[] = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(2, contexts.length) }, async () => {
    while (index < contexts.length) {
      const context = contexts[index++];
      const collection = await collectPages((cursor) => client.connectedAccounts.list({
        userIds: [context.composioUserId], limit: 100, ...(cursor ? { cursor } : {}),
      }, { signal }), 'items', 'accounts', signal);
      accounts.push({ ...collection, context, configured: true });
    }
  }));
  return { catalogue: await cataloguePromise, accounts };
}

async function loadManagedCollections(contexts: readonly ResolvedComposioContext[], signal: AbortSignal) {
  const cataloguePromise = collectPages((cursor) => requestManagedComposio('/toolkits', {
    signal,
    query: new URLSearchParams({ limit: '1000', ...(cursor ? { cursor } : {}) }),
  }, contexts[0]), 'toolkits', 'catalogue', signal);
  const accounts: ProfileAccounts[] = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(2, contexts.length) }, async () => {
    while (index < contexts.length) {
      const context = contexts[index++];
      try {
        signal.throwIfAborted();
        const status = record(await requestManagedComposio('/status', { signal }, context));
        if (!Array.isArray(status.connectedAccounts)) throw badResponse();
        const healthy = status.providerHealthy !== false && status.apiKeyValid !== false;
        accounts.push({
          context, configured: status.configured !== false, items: status.connectedAccounts.map(record),
          complete: healthy,
          errors: healthy ? [] : [safeFailure(new ComposioProviderError('Profile status is unavailable.', {
            code: status.apiKeyValid === false ? 'COMPOSIO_CREDENTIALS_OR_SCOPE' : 'COMPOSIO_UNAVAILABLE',
            retryable: status.retryable === true,
          }), 'accounts')],
        });
      } catch (error) {
        accounts.push({ context, configured: true, items: [], complete: false, errors: [safeFailure(error, 'accounts')] });
      }
    }
  }));
  return { catalogue: await cataloguePromise, accounts };
}

function providersForProfile(input: {
  profile: ProfileAccounts;
  catalogue: Collection;
  effectiveProfileId: string;
  checkedAt: string;
}): IntegrationProviderDescriptor[] {
  const { profile, catalogue, effectiveProfileId, checkedAt } = input;
  const apps = new Map<string, RecordValue>();
  for (const item of catalogue.items) {
    const slug = toolkitSlug(item.slug);
    if (slug) apps.set(slug, item);
  }
  const accountsByApp = new Map<string, RecordValue[]>();
  for (const account of profile.items) {
    const toolkit = record(account.toolkit);
    const slug = toolkitSlug(toolkit.slug);
    if (!slug) continue;
    const accounts = accountsByApp.get(slug) || [];
    accounts.push(account);
    accountsByApp.set(slug, accounts);
    if (!apps.has(slug)) apps.set(slug, { slug, name: string(toolkit.name) || slug });
  }
  return Array.from(apps, ([slug, app]) => {
    const activeAccounts = new Set((accountsByApp.get(slug) || [])
      .filter((account) => account.status === 'ACTIVE' && account.isDisabled !== true && account.is_disabled !== true)
      .map((account) => string(account.id)).filter(Boolean));
    const active = activeAccounts.size > 0;
    // Provider flags are booleans. A malformed string "false" cannot grant access.
    const noAuth = app.noAuth ?? app.isNoAuth ?? app.no_auth;
    const access = resolveComposioToolkitAccess({ noAuth: noAuth === true }, active);
    const ambiguousAccount = !access.noAuth && activeAccounts.size > 1;
    const scope = { type: 'user' as const, ownerUserId: profile.context.userId,
      resourceId: `profile:${profile.context.profileId}:${slug}` };
    const providerRef = createIntegrationProviderRef({ source: 'composio', scope,
      profileId: profile.context.profileId, toolkit: slug });
    // No-auth apps do not depend on account enumeration. Auth apps fail closed
    // for a profile whose account check was incomplete; other profiles survive.
    const healthy = access.noAuth ? catalogue.complete : profile.complete;
    const canExecute = profile.configured && healthy && access.ready && !ambiguousAccount;
    const meta = record(app.meta);
    return {
      providerRef, source: 'composio' as const, application: slug,
      aliases: [slug, string(app.name) || slug],
      displayName: `${string(app.name) || slug} · ${profile.context.profileName}`,
      description: string(meta.description) || string(app.description) || undefined,
      scope, connection: { displayName: profile.context.profileName, effective: profile.context.profileId === effectiveProfileId },
      state: !profile.configured ? 'setup_required' : !healthy ? 'degraded' : ambiguousAccount ? 'unknown' : canExecute ? 'ready' : 'auth_required',
      configured: profile.configured, requiresAuth: !access.noAuth,
      authorized: access.noAuth || active ? true : profile.complete ? false : 'unknown',
      health: healthy ? 'healthy' : 'unhealthy', canExecute, checkedAt, statusSource: 'provider',
      pluginRefs: [], skillRefs: [], matchReasons: [],
      nextActions: canExecute
        ? [{ kind: 'gateway', label: 'List available tools', request: { action: 'list', target: 'tools', providerRef } }]
        : [{ kind: 'setup', label: ambiguousAccount ? 'Review multiple connected accounts' : 'Review Composio connection',
          href: '/settings?tab=integrations' }],
    } satisfies IntegrationProviderDescriptor;
  });
}

/** App metadata and exact actor-owned profile bindings only; never fetch tools. */
export async function listComposioIntegrationProviders(context: IntegrationExecutionContext, policy?: IntegrationPolicy): Promise<IntegrationSourceSnapshot> {
  const shared = sharedProviders(context, policy).catch((): IntegrationSourceSnapshot => ({
    source: 'composio', providers: [], complete: false, revision: 'shared_connections_unavailable',
    providerErrors: [{ source: 'composio', code: 'COMPOSIO_SHARED_ACCESS_UNAVAILABLE',
      message: 'Shared Composio connection access could not be checked.', retryable: true }],
  }));
  const restrictedRefs = policy?.providerToolRules == null ? policy?.allowedProviderRefs
    : policy.providerToolRules.filter(rule => rule.source === 'composio'
      && (policy.allowedProviderRefs === null || policy.allowedProviderRefs.includes(rule.providerRef))).map(rule => rule.providerRef);
  if (restrictedRefs && restrictedRefs.filter(ref => ref.startsWith('composio:v1:')).every(ref =>
    /^composio:v1:(?:personal|shared):/u.test(ref))) {
    return mergeSharedProviders({ source: 'composio', providers: [], complete: true, providerErrors: [],
      revision: 'workflow-scoped-personal-metadata' }, shared);
  }
  const providerErrors: IntegrationProviderError[] = [];
  const timerController = new AbortController();
  const timer = setTimeout(() => timerController.abort(), CATALOGUE_TIMEOUT_MS);
  try {
    const effective = await resolveComposioContext({ userId: context.actorUserId, workspaceId: context.workspaceId });
    const mode = await getComposioMode(effective.storageScope);
    if (mode === 'disabled') return await mergeSharedProviders({ source: 'composio', providers: [], complete: true, providerErrors: [], revision: 'disabled' }, shared);
    const profiles = await listComposioProfiles(context.actorUserId);
    const contexts: ResolvedComposioContext[] = [];
    for (const profile of profiles) {
      try {
        timerController.signal.throwIfAborted();
        contexts.push(profile.id === effective.profileId ? effective : await resolveBoundComposioContext({
          userId: context.actorUserId, workspaceId: context.workspaceId, profileId: profile.id,
        }));
      } catch (error) { providerErrors.push(safeFailure(error, 'profiles')); }
    }
    if (contexts.length === 0) return await mergeSharedProviders({ source: 'composio', providers: [], complete: false,
      providerErrors, revision: 'profiles_unavailable' }, shared);
    const { catalogue, accounts } = mode === 'local'
      ? await loadLocalCollections(contexts, timerController.signal)
      : await loadManagedCollections(contexts, timerController.signal);
    const checkedAt = new Date().toISOString();
    const providers = accounts.flatMap((profile) => providersForProfile({ profile, catalogue,
      effectiveProfileId: effective.profileId, checkedAt }))
      .sort((a, b) => a.providerRef.localeCompare(b.providerRef));
    providerErrors.push(...catalogue.errors, ...accounts.flatMap((profile) => profile.errors));
    const revision = createHash('sha256').update(JSON.stringify({
      mode, bindings: contexts.map((item) => [item.profileId, item.cacheRevision]).sort(),
      accounts: accounts.map((profile) => [profile.context.profileId, profile.items.map((item) => [
        string(item.id), string(record(item.toolkit).slug), string(item.status), item.isDisabled === true || item.is_disabled === true,
      ]).sort()]).sort(),
      providers: providers.map(({ checkedAt: _checkedAt, ...provider }) => provider), providerErrors,
    })).digest('base64url');
    return await mergeSharedProviders({ source: 'composio', providers, complete: catalogue.complete && providerErrors.length === 0,
      providerErrors, revision }, shared);
  } catch (error) {
    return await mergeSharedProviders({ source: 'composio', providers: [], complete: false,
      providerErrors: [safeFailure(error, 'profiles')], revision: 'profiles_unavailable' }, shared);
  } finally { clearTimeout(timer); }
}
