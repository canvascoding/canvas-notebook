import assert from 'node:assert/strict';
import Module from 'node:module';
import type { ChatExtensionOptionsContext } from '../app/lib/chat/extension-options-context';
import type { PluginExtensionItem } from '../app/lib/plugins/plugin-extension-contracts';
import type { McpServerConfig } from '../app/lib/mcp/config';
import type { McpConnectionHealth } from '../app/lib/mcp/connection-health-types';
import type { StandaloneExtensionSelection } from '../app/lib/capabilities/extensions/contracts';

/** Actual inventory/cache projection, controlled source transports. Proves
 * presentation isolation/revalidation, not a provider's business API uptime. */
async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown }, original = loader._load;
  let revision = 'initial', mode = 'managed', statusCalls = 0, forbidden = 0;
  let profiles = [{ id: 'profile-a', ownerUserId: 'user-a', status: 'active', name: 'Personal profile' }];
  const accountValues: unknown[] = [
    { id: 'active-a', status: 'ACTIVE', toolkit: { slug: 'canva', name: 'Canva' } },
    { id: 'expired-a', status: 'EXPIRED', toolkit: { slug: 'linkedin', name: 'LinkedIn' } },
    { id: 'disabled-a', status: 'ACTIVE', isDisabled: true, toolkit: { slug: 'shopify' } },
    { id: 'hidden-a', status: 'ACTIVE', toolkit: { slug: 'openai' } },
  ];
  type Shared = { resource: { connectionRef: string; application: string; status: string; ownership: { type: 'organization'; organizationId: string } };
    backend: { source: 'composio'; toolkit: string; profileId: string; accountBinding: 'account'; connectedAccountId: string };
    canUse: boolean; canManage: boolean; authorizationRevision: string };
  type Config = McpServerConfig & { connectionId: string; testOAuthAuthorized?: boolean; testOAuthConfigured?: boolean; testOAuthCode?: string };
  let shared: Shared[] = [];
  let statusHold: { promise: Promise<unknown>; resolve: (value: unknown) => void } | null = null;
  const mcpItems: PluginExtensionItem[] = [];
  const configs = new Map<string, Config>();
  const states = new Map<string, Partial<McpConnectionHealth>>();
  let onHealthRead: ((id: string) => void) | undefined;
  let sharedMcpUse = true, sharedMcpConfig: Config | undefined;
  const context = (userId = 'user-a') => ({ actor: { userId, workspaceId: 'workspace-a' }, organizationId: 'org-a',
    allowPersonal: true, contextKey: `ctx-${userId}`, snapshot: { workflowVersion: null } } as unknown as ChatExtensionOptionsContext);
  const resolved = (input: { userId: string; workspaceId?: string; profileId: string }) => ({ userId: input.userId, workspaceId: input.workspaceId,
    profileId: input.profileId, profileName: 'Personal profile', composioUserId: 'private-provider-entity', cacheRevision: revision,
    storageScope: { secretScope: 'user', userId: input.userId } });
  const sharedItem = (binding: Shared) => ({ id: `composio:${binding.backend.toolkit}`, kind: 'integration', name: binding.backend.toolkit,
    displayName: binding.backend.toolkit, description: '', source: 'composio', stock: 'installed', access: { canRead: true, canUse: binding.canUse, canManage: false },
    toolkit: { slug: binding.backend.toolkit, noAuth: false }, connections: [{ connectionRef: binding.resource.connectionRef, displayName: 'Shared',
      ownership: binding.resource.ownership, access: { canRead: true, canUse: binding.canUse, canManage: false }, enabled: true,
      authorization: 'unknown', health: 'unknown' }] });
  const fixtures: Record<string, unknown> = {
    '@/app/lib/composio/composio-profiles': { listExistingComposioProfiles: async (userId: string) => structuredClone(profiles.filter(profile => profile.ownerUserId === userId)) },
    '@/app/lib/composio/composio-context': { resolveBoundComposioContext: async (input: { userId: string; workspaceId?: string; profileId: string }) => {
      if (!profiles.some(profile => profile.id === input.profileId && profile.ownerUserId === input.userId && profile.status === 'active')) throw new Error('Revoked profile');
      return resolved(input);
    } },
    '@/app/lib/composio/composio-client': { getComposioModeForContext: async () => mode,
      getLocalComposioApiKeyForContext: async () => `private-credential-${revision}`, getComposioForContext: async () => ({ connectedAccounts: { list: async () => {
        statusCalls++; return { items: accountValues, totalPages: 1 };
      } } }) },
    '@/app/lib/composio/managed-composio-client': { requestManagedComposio: async (route: string) => {
      assert.equal(route, '/status'); statusCalls++;
      if (statusHold) return statusHold.promise;
      return { configured: true, providerHealthy: true, apiKeyValid: true, connectedAccounts: accountValues };
    } },
    '@/app/lib/composio/composio-shared-context': { resolveAuthorizedComposioConnectionContext: async (authorization: Shared & { actor: { userId: string; workspaceId?: string } }) => ({
      ...resolved({ userId: authorization.actor.userId, workspaceId: authorization.actor.workspaceId, profileId: authorization.backend.profileId }),
      storageScope: { secretScope: 'organization', organizationId: 'org-a' }, sharedBinding: { authorization },
    }) },
    '@/app/lib/integrations/env-config': { readScopedEnvState: async () => ({ revision }) },
    '@/app/lib/managed/control-plane-url': { getManagedControlPlaneBaseUrl: () => 'https://control.example.test' },
    '@/app/lib/integration-tools/connections/store': { authorizeIntegrationConnection: async (actor: { userId: string; workspaceId?: string }, reference: string) => {
      const binding = shared.find(value => value.resource.connectionRef === reference);
      if (!binding) throw new Error('Revoked'); return { ...structuredClone(binding), actor, authorizationRevision: 'grant-current' };
    } },
    '@/app/lib/integration-tools/adapters/composio': { isComposioIntegrationApplicationVisible: (slug: string) => slug !== 'openai' },
    '@/app/lib/agents/extension-options-inventory': { readAgentComposioOptionsCatalogue: async (_context: unknown, _signal: unknown, options: { localOnly?: boolean }) => {
      assert.equal(options.localOnly, true); return { items: shared.map(sharedItem), coverage: { source: 'composio', status: 'complete' } };
    }, readAgentMcpOptionsInventory: async () => ({ items: structuredClone(mcpItems), coverage: { source: 'mcp', status: 'complete' } }),
    readAgentOwnMcpOptionMetadata: async (_context: unknown, reference: string) => ({ serverName: reference, connection: configs.get(reference) }) },
    '@/app/lib/plugins/plugin-extension-icons': { publicPluginExtensionIcon: () => undefined },
    '@/app/lib/mcp/credential-storage': { resolveMcpCredentialScope: (_connection: unknown, scope: unknown) => scope },
    '@/app/lib/mcp/shared-connections': { resolveSharedMcpBackend: (_actor: unknown, reference: string) => {
      if (reference !== 'shared-mcp' || !sharedMcpConfig) { forbidden++; throw new Error('Unexpected shared connection.'); }
      return { serverName: reference, connection: sharedMcpConfig, scope: {},
        authorization: { resource: { status: 'active' }, authorizationRevision: sharedMcpUse ? 'allowed' : 'denied' } };
    } },
    '@/app/lib/mcp/connection-health': { readMcpConnectionHealth: async (connection: { connectionId: string }) => {
      onHealthRead?.(connection.connectionId);
      return { authStatus: 'not_authorized', reachability: 'unknown', lastCheckedAt: null, ...states.get(connection.connectionId) };
    } },
    '@/app/lib/mcp/oauth': { getMcpOAuthStatus: async (name: string) => ({ configured: configs.get(name)?.testOAuthConfigured !== false, authorized: configs.get(name)?.testOAuthAuthorized === true, code: configs.get(name)?.testOAuthCode }) },
    '@/app/lib/mcp/env-runtime': { readMcpAvailableEnvSnapshot: async () => ({ revision, values: { EXISTING_TOKEN: 'private-token' } }) },
    '@/app/lib/mcp/env-references': { expandMcpEnvValue: (value: string, env: Record<string, string>, missing: Set<string>) => value.replace(/\$\{(\w+)\}/gu,
      (_all, key) => { if (!env[key]) missing.add(key); return env[key] ?? ''; }) },
    './extension-options-context': { revalidateChatExtensionOptionsContext: async () => undefined,
      listChatExtensionSharedOptions: async () => structuredClone(shared),
      authorizeChatExtensionSharedOption: async (_context: unknown, reference: string) => {
        assert.equal(reference, 'shared-mcp');
        return { resource: { status: 'active' }, backend: { source: 'mcp', connectionId: 'shared-mcp-id' },
          canUse: sharedMcpUse, canManage: false, allowedToolNames: null, authorizationRevision: sharedMcpUse ? 'allowed' : 'denied' };
      } },
  };
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (parent?.filename.endsWith('/app/lib/chat/extension-options-connection-inventory.ts') && name in fixtures) return fixtures[name];
    return original(name, parent, isMain);
  };
  try {
    const service = await import('../app/lib/chat/extension-options-connection-inventory');
    const { invalidateComposioConnectionObservations } = await import('../app/lib/composio/composio-connection-observation-revision');
    const signal = new AbortController().signal;
    assert.equal((await service.readChatComposioConnectionInventory(context(), signal)).items.length, 0);
    assert.equal(statusCalls, 0, 'Cold local phase must not call any provider.');
    const connected = await service.readChatComposioConnectionInventory(context(), signal, true);
    assert.equal(statusCalls, 1); assert.equal(connected.items.length, 3);
    const canva = connected.items.find(item => item.id === 'composio:canva')!;
    assert(canva.kind === 'integration'); assert.equal(service.isChatConnectionReady(canva.connections[0]!), true);
    for (const item of connected.items) if (item.kind === 'integration' && item.toolkit.slug !== 'canva') assert.equal(service.isChatConnectionReady(item.connections[0]!), false);
    const selection = { kind: 'composio', source: 'composio', toolkit: 'canva', target: { kind: 'personal', profileId: 'profile-a',
      accountBinding: 'account', accountId: 'active-a', connectionRef: 'composio-personal:profile-a:active-a' } } as StandaloneExtensionSelection;
    assert.equal(service.isChatStandaloneSelectionReady(selection, connected.items), true);
    assert.equal(service.isChatStandaloneSelectionReady({ ...selection, toolkit: 'linkedin' } as StandaloneExtensionSelection, connected.items), false);
    await service.readChatComposioConnectionInventory(context(), signal, true);
    await service.readChatComposioConnectionInventory(context(), signal);
    assert.equal(statusCalls, 1, 'Repeated prefixes reuse observations, not provider calls.');
    assert.equal((await service.readChatComposioConnectionInventory(context('other-user'), signal)).items.length, 0);
    assert(!JSON.stringify(connected).includes('private-provider-entity'));
    assert(!JSON.stringify(connected).includes('private-credential'));
    console.log('PASS connected personal accounts, expired/disabled/native filtering, exact MRU account identity, cached prefixes and actor isolation.');

    revision = 'local-key'; mode = 'local';
    await service.readChatComposioConnectionInventory(context(), signal, true);
    assert.equal(statusCalls, 2, 'Mode/credential rotation invalidates observations.');
    profiles = [];
    assert.equal((await service.readChatComposioConnectionInventory(context(), signal)).items.length, 0, 'Revoked profile cache must not remain visible.');
    console.log('PASS current profile ownership and credential revisions gate every cached result.');

    mode = 'managed'; revision = 'shared-old';
    shared = [{ resource: { connectionRef: 'shared-a', application: 'canva', status: 'active', ownership: { type: 'organization', organizationId: 'org-a' } },
      backend: { source: 'composio', toolkit: 'canva', profileId: 'shared-profile', accountBinding: 'account', connectedAccountId: 'active-a' },
      canUse: true, canManage: false, authorizationRevision: 'current' }];
    let resolve!: (value: unknown) => void;
    statusHold = { promise: new Promise(accept => { resolve = accept; }), resolve: value => resolve(value) };
    const pending = service.readChatComposioConnectionInventory(context(), signal, true);
    while (statusCalls < 3) await new Promise<void>(accept => setImmediate(accept));
    revision = 'shared-new'; statusHold.resolve({ configured: true, providerHealthy: true, connectedAccounts: accountValues });
    const changed = await pending; statusHold = null;
    assert(changed.items[0]?.kind === 'integration'); assert.equal(changed.items[0].connections[0]?.authorization, 'unknown');
    const fresh = await service.readChatComposioConnectionInventory(context(), signal, true);
    assert(fresh.items[0]?.kind === 'integration'); assert.equal(service.isChatConnectionReady(fresh.items[0].connections[0]!), true);
    shared = [];
    assert.equal((await service.readChatComposioConnectionInventory(context(), signal)).items.length, 0);
    console.log('PASS shared exact account status, credential rotation during IO, final current-source revalidation and revoked grants.');

    profiles = [{ id: 'profile-lifecycle', ownerUserId: 'user-a', status: 'active', name: 'Lifecycle profile' }];
    revision = 'lifecycle';
    const lifecycle = await service.readChatComposioConnectionInventory(context(), signal, true);
    assert(lifecycle.items.some(item => item.kind === 'integration' && item.connections.some(service.isChatConnectionReady)));
    const beforeInvalidation = statusCalls;
    invalidateComposioConnectionObservations();
    accountValues[0] = { id: 'active-a', status: 'EXPIRED', toolkit: { slug: 'canva', name: 'Canva' } };
    assert.equal((await service.readChatComposioConnectionInventory(context(), signal)).items.length, 0,
      'A connect/disconnect/cache-clear generation immediately withdraws old positives without another provider call.');
    assert.equal(statusCalls, beforeInvalidation);
    const disconnected = await service.readChatComposioConnectionInventory(context(), signal, true);
    assert(!disconnected.items.some(item => item.kind === 'integration' && item.connections.some(service.isChatConnectionReady)),
      'The next connected phase observes the current disconnected account.');
    accountValues[0] = { id: 'active-a', status: 'ACTIVE', toolkit: { slug: 'canva', name: 'Canva' } };
    revision = 'lifecycle-pending';
    let resolveLifecycle!: (value: unknown) => void;
    statusHold = { promise: new Promise(accept => { resolveLifecycle = accept; }), resolve: value => resolveLifecycle(value) };
    const beforeLate = statusCalls, late = service.readChatComposioConnectionInventory(context(), signal, true);
    while (statusCalls <= beforeLate) await new Promise<void>(accept => setImmediate(accept));
    invalidateComposioConnectionObservations();
    statusHold.resolve({ configured: true, providerHealthy: true, connectedAccounts: accountValues });
    assert.equal((await late).items.length, 0, 'An invalidated in-flight positive cannot reappear under the new lifecycle generation.');
    statusHold = null; profiles = [];
    console.log('PASS connection lifecycle invalidation withdraws cached positives immediately and fences late status results.');

    const mcp = (id: string, configuration: Partial<Config>, health?: Partial<McpConnectionHealth>) => {
      const reference = `mcp-personal:${id}`;
      configs.set(reference, { connectionId: id, ownerUserId: 'user-a', url: 'https://mcp.example.test', ...configuration });
      if (health) states.set(id, health);
      mcpItems.push({ id: reference, kind: 'mcp', name: id, displayName: id, description: '', source: 'mcp', stock: 'installed',
        access: { canRead: true, canUse: true, canManage: true }, ownership: { type: 'user', ownerUserId: 'user-a', organizationId: null },
        mcp: { template: false, serverId: id, transport: 'http' }, connections: [{ connectionRef: reference, displayName: id,
          access: { canRead: true, canUse: true, canManage: true }, ownership: { type: 'user', ownerUserId: 'user-a', organizationId: null },
          enabled: configuration.enabled !== false, authorization: 'unknown', health: 'unknown' }] });
    };
    mcp('plain', {}); mcp('credential', { bearerTokenEnv: 'EXISTING_TOKEN' }); mcp('missing', { bearerTokenEnv: 'MISSING_TOKEN' });
    mcp('oauth', { auth: 'oauth' }); mcp('bad-oauth', { auth: 'oauth', testOAuthAuthorized: true, testOAuthConfigured: false });
    mcp('unavailable-oauth', { auth: 'oauth', testOAuthAuthorized: true, testOAuthCode: 'unavailable' });
    mcp('disabled-before-read', { enabled: false });
    const staleEnabled = mcpItems.at(-1)!; if (staleEnabled.kind === 'mcp') staleEnabled.connections[0]!.enabled = true; mcp('down', {}, { reachability: 'unreachable' }); mcp('disabled', { enabled: false });
    const inventory = await service.readChatMcpConnectionInventory(context());
    const ready = inventory.items.filter(item => item.kind === 'mcp' && item.connections.some(service.isChatConnectionReady)).map(item => item.name);
    assert.deepEqual(ready, ['plain', 'credential']);
    assert.equal(forbidden, 0); assert(!JSON.stringify(inventory).includes('private-token'));
    console.log('PASS local MCP credential/OAuth/health/enablement observation without initialization, provider probes or secret serialization.');
    let changedSource = false;
    onHealthRead = id => {
      if (id !== 'credential' || changedSource) return;
      changedSource = true;
      configs.set('mcp-personal:plain', { ...configs.get('mcp-personal:plain')!, enabled: false });
    };
    const changing = await service.readChatMcpConnectionInventory(context());
    const plain = changing.items.find(item => item.name === 'plain');
    assert(plain?.kind === 'mcp'); assert.equal(service.isChatConnectionReady(plain.connections[0]!), false);
    assert.equal(plain.connections[0]?.authorization, 'unknown'); onHealthRead = undefined;
    console.log('PASS MCP config changes during later observations are fenced before publishing readiness.');
    mcpItems.length = 0;
    sharedMcpConfig = { connectionId: 'shared-mcp-id', organizationId: 'org-a', url: 'https://shared.example.test' };
    mcpItems.push({ id: 'shared-mcp', kind: 'mcp', name: 'Shared', displayName: 'Shared', description: '', source: 'mcp', stock: 'installed',
      access: { canRead: true, canUse: true, canManage: false }, mcp: { template: false, transport: 'http' }, connections: [{ connectionRef: 'shared-mcp',
        displayName: 'Shared', ownership: { type: 'organization', organizationId: 'org-a' }, access: { canRead: true, canUse: true, canManage: false },
        authorization: 'unknown', health: 'unknown', enabled: true }] });
    mcp('later-read', {});
    onHealthRead = id => { if (id === 'later-read') sharedMcpUse = false; };
    const revokedUse = await service.readChatMcpConnectionInventory(context());
    const sharedMcp = revokedUse.items.find(item => item.id === 'shared-mcp');
    assert(sharedMcp?.kind === 'mcp'); assert.equal(sharedMcp.connections.some(service.isChatConnectionReady), false);
    onHealthRead = undefined;
    console.log('PASS shared MCP Use revocation during later metadata reads cannot retain a ready connection.');
  } finally { loader._load = original; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
