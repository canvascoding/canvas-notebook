import assert from 'node:assert/strict';
import {
  IntegrationContractError,
  parseIntegrationRequest,
  type IntegrationExecutionContext,
  type IntegrationProviderDescriptor,
  type IntegrationProviderScope,
  type IntegrationSourceSnapshot,
} from '../app/lib/integration-tools/contracts';
import { createIntegrationProviderRef, createIntegrationToolRef } from '../app/lib/integration-tools/references';
import { UNRESTRICTED_INTEGRATION_POLICY, intersectIntegrationPolicies } from '../app/lib/integration-tools/policy';
import { listIntegrationProviders, searchIntegrationProviders } from '../app/lib/integration-tools/search';

const context: IntegrationExecutionContext = {
  actorUserId: 'alice', organizationId: 'org-a', workspaceId: 'team-a', agentId: 'design-agent', policyRevision: 'policy-1',
};
const policy = UNRESTRICTED_INTEGRATION_POLICY;
const personal = (resourceId: string): IntegrationProviderScope => ({ type: 'user', resourceId, ownerUserId: 'alice' });

function provider(
  source: 'mcp' | 'composio',
  resourceId: string,
  overrides: Partial<IntegrationProviderDescriptor> = {},
): IntegrationProviderDescriptor {
  const scope = overrides.scope || personal(resourceId);
  const providerRef = createIntegrationProviderRef(source === 'mcp'
    ? { source, scope, connectionId: resourceId }
    : { source, scope, profileId: resourceId, toolkit: 'canva' });
  return {
    providerRef, source, scope, application: 'canva', displayName: 'Canva', configured: true,
    requiresAuth: true, authorized: true, health: 'healthy', state: 'ready', canExecute: true,
    checkedAt: '2026-10-06T10:00:00Z', statusSource: 'live',
    pluginRefs: ['design-plugin'], skillRefs: ['design-skill'], capabilityRefs: ['designs'], matchReasons: [],
    nextActions: [{ kind: 'gateway', label: 'Find tools', request: { action: 'list', target: 'tools', providerRef } }],
    ...overrides,
  };
}

function snapshots(providers: IntegrationProviderDescriptor[]): IntegrationSourceSnapshot[] {
  return (['mcp', 'composio'] as const).map((source) => ({
    source, providers: providers.filter((entry) => entry.source === source),
    complete: true, providerErrors: [], revision: `${source}-1`,
  }));
}

function invalidRequest(request: unknown) {
  assert.throws(() => parseIntegrationRequest(request), (error) => error instanceof IntegrationContractError && error.code === 'invalid_request');
}

function invalidCursor(run: () => unknown) {
  assert.throws(run, (error) => error instanceof IntegrationContractError && error.code === 'invalid_cursor');
}

function testRequestsAndReferences() {
  assert.equal(parseIntegrationRequest({ action: 'list', target: 'providers' }).action, 'list');
  assert.equal(parseIntegrationRequest({ version: 1, action: 'call', toolRef: 'tool', schemaRef: 'schema', arguments: {} }).action, 'call');
  for (const request of [
    { action: 'search', target: 'tools', query: 'design' },
    { action: 'describe', providerRef: 'connection' },
    { action: 'call', toolRef: 'tool', arguments: {} },
    { action: 'list', target: 'providers', limit: 51 },
    { action: 'list', target: 'providers', limit: 0 },
    { action: 'list', target: 'providers', source: 'http' },
    { action: 'list', target: 'providers', version: 2 },
    { action: 'list', target: 'providers', userId: 'bob' },
    { action: 'search', target: 'providers', query: '   ' },
    { action: 'call', toolRef: 'tool', schemaRef: 'schema', arguments: [], url: 'https://example.test' },
  ]) invalidRequest(request);

  const identity = { source: 'mcp' as const, scope: personal('conn'), connectionId: 'conn' };
  const ref = createIntegrationProviderRef(identity);
  assert.equal(createIntegrationProviderRef(identity), ref);
  assert.doesNotMatch(ref, /alice|conn/u);
  assert.notEqual(createIntegrationProviderRef({ ...identity, scope: { type: 'user', resourceId: 'conn', ownerUserId: 'bob' } }), ref);
  assert.notEqual(createIntegrationProviderRef({ ...identity, scope: { type: 'organization', resourceId: 'conn', organizationId: 'org-a' } }), ref);
  const profile = { source: 'composio' as const, scope: personal('profile-a'), profileId: 'profile-a', toolkit: 'canva' };
  assert.notEqual(createIntegrationProviderRef(profile), createIntegrationProviderRef({ ...profile, profileId: 'profile-b' }));
  assert.notEqual(createIntegrationProviderRef(profile), createIntegrationProviderRef({ ...profile, toolkit: 'slack' }));
  assert.notEqual(createIntegrationToolRef(ref, 'DESIGNS_LIST'), createIntegrationToolRef(ref, 'designs_list'));
  assert.notEqual(createIntegrationToolRef(ref, 'DESIGNS_LIST'), createIntegrationToolRef(createIntegrationProviderRef(profile), 'DESIGNS_LIST'));
}

function testSearchRankingAndScopes() {
  const mcp = provider('mcp', 'mcp-a');
  const composio = provider('composio', 'profile-a');
  const second = provider('mcp', 'mcp-b');
  const setup = provider('mcp', 'mcp-setup', { canExecute: false, configured: false, state: 'setup_required' });
  const foreign = provider('mcp', 'mcp-foreign', { scope: { type: 'user', resourceId: 'mcp-foreign', ownerUserId: 'bob' } });
  const wrongTeam = provider('mcp', 'mcp-team', { scope: { type: 'workspace', resourceId: 'mcp-team', organizationId: 'org-a', workspaceId: 'team-b' } });
  const shared = provider('mcp', 'mcp-shared', { scope: { type: 'workspace', resourceId: 'mcp-shared', organizationId: 'org-a', workspaceId: 'team-a' } });
  const data = snapshots([composio, setup, foreign, mcp, wrongTeam, second, shared]);
  const request = { action: 'search' as const, target: 'providers' as const, query: 'Canva' };
  const result = searchIntegrationProviders(data, request, context, policy);
  assert.equal(result.providers.length, 5, 'Same-name connections are distinct; foreign user and team are hidden.');
  assert.ok(result.providers.slice(0, 3).every((entry) => entry.source === 'mcp' && entry.canExecute));
  assert.equal(result.providers[3].providerRef, composio.providerRef, 'A ready Composio account precedes an unconfigured MCP candidate.');
  assert.equal(result.providers[4].providerRef, setup.providerRef);
  assert.deepEqual(result.providers[0].matchReasons, ['application_exact']);
  const preferred = searchIntegrationProviders(data, request, context, policy, { preferredSource: 'composio' });
  assert.equal(preferred.providers[0].providerRef, composio.providerRef);
  const confirmed = searchIntegrationProviders(data, request, context, policy, { confirmedProviderRefs: [second.providerRef] });
  assert.equal(confirmed.providers[0].providerRef, second.providerRef);
  const reversed = searchIntegrationProviders([...data].reverse().map((snapshot) => ({ ...snapshot, providers: [...snapshot.providers].reverse() })), request, context, policy);
  assert.deepEqual(reversed.providers.map((entry) => entry.providerRef), result.providers.map((entry) => entry.providerRef));

  const drive = provider('composio', 'profile-drive', { application: 'googledrive', displayName: 'Drive · profile-a', aliases: ['Google Drive'] });
  const arbitrary = provider('mcp', 'mcp-arbitrary', { application: undefined, displayName: 'Gmail mailbox', aliases: ['googlemail'] });
  const applications = snapshots([drive, arbitrary]);
  assert.equal(searchIntegrationProviders(applications, { ...request, query: 'Google Drive' }, context, policy).providers[0]?.providerRef, drive.providerRef);
  assert.deepEqual(searchIntegrationProviders(applications, { ...request, query: 'Google Drive' }, context, policy).providers[0]?.matchReasons, ['application_alias']);
  const gmail = searchIntegrationProviders(applications, { ...request, query: 'Gmail' }, context, policy);
  assert.equal(gmail.providers[0]?.providerRef, arbitrary.providerRef, 'A display name is searchable but does not create app metadata.');
  assert.equal(gmail.providers[0]?.application, undefined);
  assert.equal(searchIntegrationProviders(applications, { ...request, query: 'googlemail' }, context, policy).providers.length, 0, 'Unverified app aliases are not treated as application aliases.');
  assert.equal(searchIntegrationProviders(applications, { ...request, query: 'Google Mail' }, context, policy).providers.length, 0, 'No unconditional Gmail synonym inference.');
  assert.equal(listIntegrationProviders(data, { action: 'list', target: 'providers', pluginRef: 'missing' }, context, policy).providers.length, 0);
  assert.equal(listIntegrationProviders(data, { action: 'list', target: 'providers', capabilityRef: 'designs' }, context, policy).providers.length, 5);
}

function testPoliciesAndPartialErrors() {
  const mcp = provider('mcp', 'mcp-a');
  const composio = provider('composio', 'profile-a');
  const data = snapshots([mcp, composio]);
  const request = { action: 'list' as const, target: 'providers' as const };
  for (const restricted of [
    { ...policy, allowedSources: [] }, { ...policy, allowedProviderRefs: [] },
    { ...policy, allowedApplications: [] }, { ...policy, allowedOperations: [] },
  ]) assert.equal(listIntegrationProviders(data, request, context, restricted).providers.length, 0);
  const onlyComposio = { ...policy, allowedSources: ['composio'] as const };
  assert.deepEqual(listIntegrationProviders(data, request, context, onlyComposio).providers.map((entry) => entry.providerRef), [composio.providerRef]);
  assert.equal(listIntegrationProviders(data, request, context, intersectIntegrationPolicies({ ...policy, allowedSources: [] }, policy)).providers.length, 0, 'Later unrestricted filters cannot restore denied sources.');
  const unknown = provider('mcp', 'unknown', { application: undefined });
  assert.equal(listIntegrationProviders(snapshots([unknown]), request, context, { ...policy, allowedApplications: ['canva'] }).providers.length, 0);
  const onlyList = { ...policy, allowedOperations: ['mcp.list_providers'] };
  const listing = listIntegrationProviders(data, request, context, onlyList);
  assert.equal(listing.providers[0]?.canExecute, false);
  assert.deepEqual(listing.providers[0]?.nextActions, []);
  const noTools = listIntegrationProviders(data, request, context, { ...policy, allowedToolNames: [] });
  assert.ok(noTools.providers.every((entry) => entry.canExecute === false));

  data[1] = { ...data[1], complete: false, providerErrors: [
    { source: 'composio', code: 'timeout', message: 'Provider temporarily unavailable.', retryable: true },
    { source: 'composio', providerRef: 'hidden-account', code: 'hidden', message: 'Hidden account detail.', retryable: false },
  ] };
  const partial = listIntegrationProviders(data, request, context, policy);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.providerErrors.map((error) => error.code), ['timeout']);
  const permittedSource = listIntegrationProviders(data, request, context, { ...policy, allowedSources: ['mcp'] });
  assert.equal(permittedSource.complete, true);
  assert.deepEqual(permittedSource.providerErrors, []);
}

function testContextBoundPagination() {
  const data = snapshots([provider('mcp', 'a'), provider('mcp', 'b'), provider('composio', 'c')]);
  const request = { action: 'search' as const, target: 'providers' as const, query: 'canva', limit: 1 };
  const first = searchIntegrationProviders(data, request, context, policy);
  assert.ok(first.nextCursor);
  const next = { ...request, cursor: first.nextCursor };
  const second = searchIntegrationProviders(data, next, context, policy);
  assert.notEqual(first.providers[0]?.providerRef, second.providers[0]?.providerRef);
  assert.ok(second.nextCursor);
  const third = searchIntegrationProviders(data, { ...request, cursor: second.nextCursor }, context, policy);
  assert.equal(third.nextCursor, null);
  assert.equal(new Set([...first.providers, ...second.providers, ...third.providers].map((entry) => entry.providerRef)).size, 3);
  for (const changed of [
    { ...context, actorUserId: 'bob' }, { ...context, organizationId: 'org-b' },
    { ...context, workspaceId: 'team-b' }, { ...context, agentId: 'another-agent' },
    { ...context, policyRevision: 'policy-2' },
  ]) invalidCursor(() => searchIntegrationProviders(data, next, changed, policy));
  invalidCursor(() => searchIntegrationProviders(data, { ...next, query: 'design' }, context, policy));
  invalidCursor(() => searchIntegrationProviders(data, { ...next, limit: 2 }, context, policy));
  invalidCursor(() => searchIntegrationProviders(data, { ...next, source: 'mcp' }, context, policy));
  invalidCursor(() => searchIntegrationProviders(data, next, context, { ...policy, allowedToolNames: [] }));
  invalidCursor(() => searchIntegrationProviders(data, next, context, policy, { preferredSource: 'composio' }));
  invalidCursor(() => searchIntegrationProviders(data.map((entry) => ({ ...entry, revision: 'new' })), next, context, policy));
  invalidCursor(() => searchIntegrationProviders(data.map((entry) => ({ ...entry, providers: entry.providers.map((item) => ({ ...item, canExecute: false })) })), next, context, policy));
  invalidCursor(() => searchIntegrationProviders(data, { ...next, cursor: 'not-json' }, context, policy));
  const forged = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8')) as Record<string, unknown>;
  forged.offset = 2;
  invalidCursor(() => searchIntegrationProviders(data, { ...next, cursor: Buffer.from(JSON.stringify(forged)).toString('base64url') }, context, policy));
}

function testReadyBeforeMetadata() {
  const readyNamedMcp = provider('mcp', 'ready-label', { application: undefined, displayName: 'Canva design server' });
  const unconnectedExactApp = provider('composio', 'exact-unconnected', {
    state: 'auth_required', authorized: false, canExecute: false,
  });
  const request = { action: 'search' as const, target: 'providers' as const, query: 'canva' };
  const data = snapshots([unconnectedExactApp, readyNamedMcp]);
  assert.equal(searchIntegrationProviders(data, request, context, policy).providers[0].providerRef, readyNamedMcp.providerRef,
    'Ready matching providers precede exact application metadata with a missing account.');
  assert.equal(searchIntegrationProviders(data, request, context, policy, { preferredSource: 'composio' }).providers[0].providerRef,
    unconnectedExactApp.providerRef, 'Explicit permitted source preference is preserved.');
}

testRequestsAndReferences();
testSearchRankingAndScopes();
testPoliciesAndPartialErrors();
testContextBoundPagination();
testReadyBeforeMetadata();
console.log('PASS integration contracts, stable scoped identities, deterministic search, allowlists, partial errors and context-bound pagination');
