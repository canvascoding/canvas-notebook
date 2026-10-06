import assert from 'node:assert/strict';

import { getIntegrationProviderCatalog, type IntegrationCatalogAdapters } from '../app/lib/integration-tools/catalog';
import type { IntegrationExecutionContext, IntegrationProviderDescriptor, IntegrationSourceSnapshot } from '../app/lib/integration-tools/contracts';
import { intersectIntegrationPolicies, isIntegrationToolAllowed, UNRESTRICTED_INTEGRATION_POLICY } from '../app/lib/integration-tools/policy';
import { createIntegrationProviderRef } from '../app/lib/integration-tools/references';

const context: IntegrationExecutionContext = {
  actorUserId: 'alice', organizationId: 'org-a', workspaceId: 'team-a', agentId: 'designer', policyRevision: 'policy-1',
};

function provider(source: 'mcp' | 'composio', ownerUserId = 'alice'): IntegrationProviderDescriptor {
  const scope = { type: 'user' as const, resourceId: `${source}-design`, ownerUserId };
  return {
    providerRef: createIntegrationProviderRef(source === 'mcp'
      ? { source, scope, connectionId: 'connection-1' }
      : { source, scope, profileId: 'profile-1', toolkit: 'canva' }),
    source, scope, application: 'canva', displayName: 'Canva',
    state: 'ready', configured: true, requiresAuth: false, authorized: true, health: 'healthy', canExecute: true,
    checkedAt: '2026-10-06T10:00:00Z', statusSource: 'provider', pluginRefs: [], skillRefs: [], matchReasons: [], nextActions: [],
  };
}

function snapshot(source: 'mcp' | 'composio', providers: IntegrationProviderDescriptor[]): IntegrationSourceSnapshot {
  return { source, providers, complete: true, providerErrors: [], revision: `${source}-1` };
}

async function main() {
  const calls: string[] = [];
  const adapters: IntegrationCatalogAdapters = {
    mcp: async () => { calls.push('mcp'); return snapshot('mcp', [provider('mcp'), provider('mcp', 'bob')]); },
    composio: async () => { calls.push('composio'); return snapshot('composio', [provider('composio')]); },
  };
  const request = { action: 'search' as const, target: 'providers' as const, query: 'Canva', limit: 1 };
  const page = await getIntegrationProviderCatalog({ context, policy: UNRESTRICTED_INTEGRATION_POLICY, adapters, request });
  assert.equal(page.complete, true);
  assert.equal(page.providers.length, 1);
  assert.equal(page.providers[0].source, 'mcp', 'equally suitable MCP precedes Composio');
  assert.ok(page.nextCursor);
  const next = await getIntegrationProviderCatalog({ context, policy: UNRESTRICTED_INTEGRATION_POLICY, adapters, request: { ...request, cursor: page.nextCursor! } });
  assert.deepEqual(next.providers.map((item) => item.source), ['composio']);
  assert.equal(next.nextCursor, null, 'foreign personal resource was filtered before pagination');
  await assert.rejects(() => getIntegrationProviderCatalog({ context: { ...context, actorUserId: 'bob' }, policy: UNRESTRICTED_INTEGRATION_POLICY, adapters, request: { ...request, cursor: page.nextCursor! } }), { code: 'invalid_cursor' });
  await assert.rejects(() => getIntegrationProviderCatalog({ context: { ...context, workspaceId: 'team-b' }, policy: UNRESTRICTED_INTEGRATION_POLICY, adapters, request: { ...request, cursor: page.nextCursor! } }), { code: 'invalid_cursor' });

  calls.length = 0;
  const composioOnly = intersectIntegrationPolicies(UNRESTRICTED_INTEGRATION_POLICY, { ...UNRESTRICTED_INTEGRATION_POLICY, allowedSources: ['composio'] });
  const selected = await getIntegrationProviderCatalog({ context, policy: composioOnly, adapters, request });
  assert.deepEqual(calls, ['composio'], 'a denied source is never queried');
  assert.deepEqual(selected.providers.map((item) => item.source), ['composio']);
  const denied = intersectIntegrationPolicies(composioOnly, { ...UNRESTRICTED_INTEGRATION_POLICY, allowedSources: [] }, UNRESTRICTED_INTEGRATION_POLICY);
  calls.length = 0;
  assert.equal((await getIntegrationProviderCatalog({ context, policy: denied, adapters, request })).providers.length, 0);
  assert.deepEqual(calls, [], 'a later unrestricted layer cannot restore denied access');

  const readOnly = { ...UNRESTRICTED_INTEGRATION_POLICY, allowedOperations: ['mcp.search_providers', 'mcp.list_tools', 'mcp.describe'] };
  const readPage = await getIntegrationProviderCatalog({ context, policy: readOnly, adapters, request });
  assert.equal(readPage.providers[0].canExecute, false, 'discovery never grants execution');
  assert.equal(isIntegrationToolAllowed(context, readOnly, provider('mcp'), 'create_design', 'call'), false);
  assert.equal(isIntegrationToolAllowed(context, { ...UNRESTRICTED_INTEGRATION_POLICY, allowedToolNames: ['list_designs'] }, provider('mcp'), 'create_design', 'call'), false);

  const partial = await getIntegrationProviderCatalog({ context, policy: UNRESTRICTED_INTEGRATION_POLICY,
    adapters: { ...adapters, composio: async () => { throw new Error('secret-provider-token-should-not-leak'); } }, request });
  assert.equal(partial.providers[0].source, 'mcp');
  assert.equal(partial.complete, false);
  assert.equal(partial.providerErrors.length, 1);
  assert.ok(!JSON.stringify(partial).includes('secret-provider-token'));
  const timedOut = await getIntegrationProviderCatalog({ context, policy: UNRESTRICTED_INTEGRATION_POLICY,
    adapters: { ...adapters, composio: () => new Promise(() => {}) }, request, timeoutMs: 10 });
  assert.equal(timedOut.providers[0].source, 'mcp');
  assert.equal(timedOut.providerErrors[0].code, 'provider_timeout');

  const malformed = await getIntegrationProviderCatalog({ context, policy: UNRESTRICTED_INTEGRATION_POLICY,
    adapters: { ...adapters, composio: async () => snapshot('composio', [provider('mcp')]) }, request });
  assert.equal(malformed.complete, false);
  assert.ok(malformed.providers.every((item) => item.source === 'mcp'));
  await assert.rejects(() => getIntegrationProviderCatalog({ context: { ...context, actorUserId: '' }, policy: UNRESTRICTED_INTEGRATION_POLICY, adapters, request }), /authenticated/i);
  await assert.rejects(() => getIntegrationProviderCatalog({ context, policy: UNRESTRICTED_INTEGRATION_POLICY, adapters, request, timeoutMs: Number.NaN }), /timeout/i);
  console.log('PASS integration catalogue: shared discovery, scope/policy isolation, pagination, partial failures and bounded timeout.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
