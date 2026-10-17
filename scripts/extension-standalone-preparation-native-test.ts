import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { Pool } from 'pg';

import type { AgentManagementActor } from '../app/lib/agents/management-actions';
import type { StandaloneExtensionInput } from '../app/lib/capabilities/extensions/contracts';
import type { IntegrationConnectionResource } from '../app/lib/integration-tools/connections/contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';
import { startIntegrationToolBrowserProvider } from './fixtures/integration-tool-browser-provider';

async function expectStandalonePublicCode(operation: () => unknown | Promise<unknown>, expected: string) {
  try { await operation(); }
  catch (error) {
    assert.equal(error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined, expected);
    return;
  }
  assert.fail(`Expected ${expected}.`);
}

async function assertStandaloneFixtureCleanup(maintenanceUrl: string, databaseName: string, dataRoot: string) {
  assert.match(databaseName, /^canvas_connection_test_[a-f0-9]{32}$/u);
  assert(path.basename(dataRoot).startsWith('canvas-store-application-'));
  const observer = new Pool({connectionString: maintenanceUrl, max: 1});
  try {
    assert.equal((await observer.query('SELECT COUNT(*)::integer AS count FROM pg_database WHERE datname=$1', [databaseName])).rows[0].count, 0);
    await assert.rejects(fs.stat(dataRoot), {code: 'ENOENT'});
  } finally { await observer.end(); }
  console.log('CLEANUP standalone preparation: exact owned nonce database absent; exact owned DATA absent.');
}

async function runStandalonePreparationNativeProof() {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST, '1', 'Actual PostgreSQL only; no in-memory fallback.');
  const maintenance = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(maintenance.hostname, '127.0.0.1'); assert.equal(maintenance.port, '55433'); assert.equal(maintenance.search, '');
  const isolatedEnvironment = {COMPOSIO_API_KEY: '', COMPOSIO_BASE_URL: '', COMPOSIO_LOGGING_LEVEL: 'silent',
    MCP_ALLOW_PRIVATE_NETWORK: 'true', MCP_ALLOW_INSECURE_HTTP: 'true'};
  const previousEnvironment = Object.fromEntries(Object.keys(isolatedEnvironment).map(key => [key, process.env[key]]));
  Object.assign(process.env, isolatedEnvironment);
  const originalFetch = globalThis.fetch;
  let fixture: Awaited<ReturnType<typeof createCapabilityPackageStoreApplicationFixture>> | undefined;
  let composio: Awaited<ReturnType<typeof createComposioProviderFixture>> | undefined;
  let mcp: Awaited<ReturnType<typeof startIntegrationToolBrowserProvider>> | undefined;
  let databaseName = '', dataRoot = '', blockedNetworkAttempts = 0;
  let stage = 'fixture creation';
  let completed = false;
  try {
    fixture = await createCapabilityPackageStoreApplicationFixture({native: true});
    assert.equal(fixture.native, true); dataRoot = fixture.root; await fs.chmod(dataRoot, 0o700);
    const databaseIdentity = await fixture.sql.get('SELECT current_database() AS name') as {name: string} | undefined;
    assert(databaseIdentity && typeof databaseIdentity.name === 'string'); databaseName = databaseIdentity.name;
    assert.match(databaseName, /^canvas_connection_test_[a-f0-9]{32}$/u);
    console.log('START standalone preparation: own native PostgreSQL/DATA; actual actor/store/config authority; loopback-only metadata fixtures.');
    composio = await createComposioProviderFixture(); mcp = await startIntegrationToolBrowserProvider();
    const providerOrigin = composio.baseUrl, mcpOrigin = mcp.baseUrl;
    process.env.COMPOSIO_BASE_URL = providerOrigin;
    // Only metadata GETs to this exact owned origin reach the real SDK fixture.
    // Neither registry nor any provider business endpoint gets a permissive fallback.
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : undefined;
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
      if (url.origin !== providerOrigin || url.username || url.password || url.hash || method !== 'GET'
        || !['/api/v3.1/toolkits', '/api/v3.1/connected_accounts'].includes(url.pathname)) {
        blockedNetworkAttempts += 1; throw new Error('Only exact owned metadata GETs are allowed.');
      }
      return originalFetch(input, {...init, redirect: 'error'});
    };
    const services = await import('../app/lib/capabilities/extensions/standalone-preparation');
    const config = await import('../app/lib/mcp/config');
    const configRoute = await import('../app/api/integrations/mcp-config/route');
    const store = await import('../app/lib/integration-tools/connections/store');
    const {createSharedMcpConnection} = await import('../app/lib/mcp/shared-connections');
    const {replaceScopedEnvEntries} = await import('../app/lib/integrations/env-config');
    const owner = {...fixture.owner}, alice = {...fixture.alice}, bob = fixture.actor('bob');
    const inputFor = (connectionRef: string): StandaloneExtensionInput => ({selection: {kind: 'mcp', source: 'mcp',
      target: {kind: 'personal', connectionRef}}, requirement: 'required', toolCap: null});
    const revisions = (resource: IntegrationConnectionResource) => ({metadataRevision: resource.metadataRevision,
      grantsRevision: resource.grantsRevision, bindingRevision: resource.bindingRevision});
    const ownerConnectionActor = {...owner, organizationId: fixture.organizationId};

    stage = 'personal MCP API configuration and exact preparation';
    const response = await configRoute.PUT(new NextRequest('http://localhost:3001/api/integrations/mcp-config', {
      method: 'PUT', headers: fixture.headers('owner'), body: JSON.stringify({rawContent: JSON.stringify({mcpServers: {
        'Standalone native MCP': {url: mcp.mcpUrl, transport: 'http', auth: 'none', enabled: true},
      }})}),
    }));
    assert.equal(response.status, 200);
    const currentConfig = await config.readMcpConfig({userId: owner.userId});
    const personal = currentConfig.mcpServers['Standalone native MCP'];
    assert(personal?.connectionId && personal.ownerUserId === owner.userId);
    const personalInput = inputFor(`mcp-personal:${personal.connectionId}`);
    const personalProof = await services.prepareStandaloneExtensionSelection(owner, personalInput);
    const personalBinding = services.getPreparedStandaloneExtensionBinding(personalProof, owner);
    assert(personalBinding.mode === 'fixed' && personalBinding.entry.target.kind === 'personal');
    assert.equal(personalBinding.entry.target.ownerUserId, owner.userId);
    assert(personalBinding.entry.target.personalBinding.source === 'mcp');
    assert.equal(personalBinding.entry.target.personalBinding.connectionId, personal.connectionId);
    assert.equal(personalBinding.entry.target.personalBinding.serverDefinitionId, null);
    assert(Object.isFrozen(personalProof) && Object.isFrozen(personalBinding) && Object.isFrozen(personalBinding.entry));
    await fixture.sql.run('BEGIN');
    try { assert.equal(await services.revalidatePreparedStandaloneExtensionSelection(personalProof, owner, {database: fixture.sql}), personalBinding); }
    finally { await fixture.sql.run('ROLLBACK'); }
    assert.equal(mcp.calls().requests, 0, 'Preparation consumes actual local identity, without starting MCP or business calls.');

    stage = 'proof provenance, actor scopes, denied owner and input capture';
    await expectStandalonePublicCode(() => services.getPreparedStandaloneExtensionBinding(JSON.parse(JSON.stringify(personalProof)), owner), 'provider_denied');
    await expectStandalonePublicCode(() => services.revalidatePreparedStandaloneExtensionSelection({...personalProof}, owner), 'provider_denied');
    for (const actor of [alice, {...owner, workspaceId: alice.workspaceId}, {...owner, organizationId: fixture.organizationId},
      {...owner, projectId: 'different-project'}, {...owner, sourceAgentId: 'different-agent'}, {...owner, sessionId: 'different-session'}] as AgentManagementActor[]) {
      await expectStandalonePublicCode(() => services.getPreparedStandaloneExtensionBinding(personalProof, actor), 'provider_denied');
      await expectStandalonePublicCode(() => services.revalidatePreparedStandaloneExtensionSelection(personalProof, actor), 'provider_denied');
    }
    await expectStandalonePublicCode(() => services.prepareStandaloneExtensionSelection(alice, personalInput), 'provider_denied');
    const mutableInput = structuredClone(personalInput);
    const capturedProof = await services.prepareStandaloneExtensionSelection(owner, mutableInput);
    mutableInput.toolCap = ['not-the-captured-cap'];
    const capturedBinding = services.getPreparedStandaloneExtensionBinding(capturedProof, owner);
    assert(capturedBinding.mode === 'fixed'); assert.equal(capturedBinding.entry.toolCap, null);
    await config.writeMcpConfigRaw(JSON.stringify({mcpServers: {'Standalone native MCP': {...personal, url: `${mcpOrigin}/changed-mcp`}}}), {userId: owner.userId});
    await expectStandalonePublicCode(() => services.revalidatePreparedStandaloneExtensionSelection(personalProof, owner), 'binding_changed');

    stage = 'actual shared MCP use without manage, source and revision fences';
    const grant = {targetType: 'user' as const, targetId: alice.userId, canUse: true, canManage: false, allowedToolNames: null};
    let shared = await createSharedMcpConnection(ownerConnectionActor, {ownership: {type: 'organization', organizationId: fixture.organizationId},
      displayName: 'Standalone shared native MCP', accessMode: 'restricted', grants: [grant],
      config: {url: mcp.mcpUrl, transport: 'http', auth: 'none', enabled: true}});
    const sharedInput = (): StandaloneExtensionInput => ({selection: {kind: 'mcp', source: 'mcp', target: {kind: 'shared',
      connectionRef: shared.resource.connectionRef, bindingRevision: shared.resource.bindingRevision}}, requirement: 'required', toolCap: []});
    const access = await store.authorizeIntegrationConnection(alice, shared.resource.connectionRef, 'use');
    assert.equal(access.access.canUse, true); assert.equal(access.access.canManage, false);
    stage = 'shared preparation validates canonical project context';
    for (const actor of [{...alice, projectId: 'contradictory-project'},
      {userId: alice.userId, organizationId: fixture.organizationId, projectId: 'unavailable-project'}]) {
      await expectStandalonePublicCode(() => services.prepareStandaloneExtensionSelection(actor, sharedInput()), 'AGENT_ACTOR_CONTEXT_DENIED');
    }
    stage = 'actual shared MCP use without manage, source and revision fences';
    let sharedProof = await services.prepareStandaloneExtensionSelection(alice, sharedInput());
    const callerDatabase = fixture.sql;
    await expectStandalonePublicCode(() => services.revalidatePreparedStandaloneExtensionSelection(sharedProof, alice,
      {database: callerDatabase}), 'invalid_request');
    const sharedBinding = await services.revalidatePreparedStandaloneExtensionSelection(sharedProof, alice);
    assert(sharedBinding.mode === 'fixed' && sharedBinding.entry.target.kind === 'shared');
    assert.equal(sharedBinding.entry.target.connectionRef, shared.resource.connectionRef); assert.deepEqual(sharedBinding.entry.toolCap, []);
    await expectStandalonePublicCode(() => services.prepareStandaloneExtensionSelection(bob, sharedInput()), 'CONNECTION_ACCESS_DENIED');
    await expectStandalonePublicCode(() => store.authorizeIntegrationConnection(alice, shared.resource.connectionRef, 'manage'), 'CONNECTION_ACCESS_DENIED');
    await expectStandalonePublicCode(() => services.prepareStandaloneExtensionSelection(alice, {selection: {kind: 'composio', source: 'composio', toolkit: 'canva',
      target: {kind: 'shared', connectionRef: shared.resource.connectionRef, bindingRevision: shared.resource.bindingRevision}}, requirement: 'required', toolCap: null}), 'binding_changed');
    const oldSharedInput = sharedInput();
    shared = await store.publishIntegrationConnectionBinding(ownerConnectionActor, shared.resource.connectionRef, revisions(shared.resource), shared.backend);
    await expectStandalonePublicCode(() => services.revalidatePreparedStandaloneExtensionSelection(sharedProof, alice), 'CONNECTION_BINDING_CHANGED');
    await expectStandalonePublicCode(() => services.prepareStandaloneExtensionSelection(alice, oldSharedInput), 'binding_changed');
    sharedProof = await services.prepareStandaloneExtensionSelection(alice, sharedInput());
    let mutation = await store.mutateSharedIntegrationConnection(ownerConnectionActor, shared.resource.connectionRef, {
      expectedMetadataRevision: shared.resource.metadataRevision, expectedGrantsRevision: shared.resource.grantsRevision,
      expectedBindingRevision: shared.resource.bindingRevision, grants: [{...grant, allowedToolNames: ['canva_find_designs']}],
    });
    await expectStandalonePublicCode(() => services.revalidatePreparedStandaloneExtensionSelection(sharedProof, alice), 'CONNECTION_BINDING_CHANGED');
    shared.resource = mutation.resource; sharedProof = await services.prepareStandaloneExtensionSelection(alice, sharedInput());
    mutation = await store.mutateSharedIntegrationConnection(ownerConnectionActor, shared.resource.connectionRef, {
      expectedMetadataRevision: shared.resource.metadataRevision, expectedGrantsRevision: shared.resource.grantsRevision,
      expectedBindingRevision: shared.resource.bindingRevision, grants: [],
    });
    shared.resource = mutation.resource;
    await expectStandalonePublicCode(() => services.revalidatePreparedStandaloneExtensionSelection(sharedProof, alice), 'CONNECTION_ACCESS_DENIED');
    await expectStandalonePublicCode(() => services.prepareStandaloneExtensionSelection(alice, sharedInput()), 'CONNECTION_ACCESS_DENIED');

    stage = 'actual Composio SDK HTTP intake and sealed current account receipt';
    const fakeKey = `fixture-${randomBytes(24).toString('hex')}`;
    await replaceScopedEnvEntries('integrations', [{key: 'COMPOSIO_API_KEY', value: fakeKey}], {secretScope: 'legacy'});
    const profiles = await import('../app/lib/composio/composio-profiles');
    const {createIntegrationProviderRef} = await import('../app/lib/integration-tools/references');
    const {listPersonalWorkflowProviderAccountChoices} = await import('../app/lib/integration-tools/workflow-personal-bindings');
    const {readPersonalComposioAccountReference} = await import('../app/lib/composio/composio-shared-account-reference');
    await profiles.ensureDefaultComposioProfile(owner.userId);
    const profile = await profiles.createComposioProfile({ownerUserId: owner.userId, name: 'Standalone exact account'});
    composio.accounts.set(profile.composioUserId, [{id: 'standalone-account-one', toolkit: 'canva', status: 'ACTIVE'},
      {id: 'standalone-account-two', toolkit: 'canva', status: 'ACTIVE'}]);
    const providerRef = createIntegrationProviderRef({source: 'composio', profileId: profile.id, toolkit: 'canva',
      scope: {type: 'user', ownerUserId: owner.userId, resourceId: `profile:${profile.id}:canva`}});
    const choices = await listPersonalWorkflowProviderAccountChoices({actor: owner, providerRef, exactToolkit: {profileId: profile.id, toolkit: 'canva'}});
    assert.equal(choices.accounts.length, 2); assert.equal(choices.noAuth, false);
    const choice = choices.accounts[1]!;
    const account = readPersonalComposioAccountReference(choice.accountSelectionRef);
    const composioInput: StandaloneExtensionInput = {selection: {kind: 'composio', source: 'composio', toolkit: 'canva', target: {
      kind: 'personal', profileId: profile.id, accountBinding: 'account', accountId: account.accountId,
      connectionRef: `composio-personal:${profile.id}:${account.accountId}`}}, accountSelectionRef: choice.accountSelectionRef, requirement: 'optional', toolCap: null};
    const composioProof = await services.prepareStandaloneExtensionSelection(owner, composioInput);
    const composioBinding = await services.revalidatePreparedStandaloneExtensionSelection(composioProof, owner);
    assert(composioBinding.mode === 'fixed' && composioBinding.entry.target.kind === 'personal' && composioBinding.entry.target.personalBinding.source === 'composio');
    assert.equal(composioBinding.entry.target.personalBinding.connectedAccountId, account.accountId);
    assert(!JSON.stringify(composioBinding).includes(choice.accountSelectionRef), 'Consumed receipt never survives in accepted private storage.');
    assert(!JSON.stringify(composioProof).includes(account.accountId), 'Issued receipt is opaque server authority.');
    await expectStandalonePublicCode(() => services.prepareStandaloneExtensionSelection(owner, {...composioInput, accountSelectionRef: undefined}), 'invalid_request');
    const sealed = choice.accountSelectionRef;
    await expectStandalonePublicCode(() => services.prepareStandaloneExtensionSelection(owner, {...composioInput,
      accountSelectionRef: `${sealed.slice(0, -2)}${sealed.at(-2) === 'A' ? 'B' : 'A'}${sealed.at(-1)}`}), 'binding_changed');
    await expectStandalonePublicCode(() => services.prepareStandaloneExtensionSelection(alice, composioInput), 'provider_denied');
    const readsBeforeHeld = composio.calls.length;
    await fixture.sql.run('BEGIN');
    try { await services.revalidatePreparedStandaloneExtensionSelection(composioProof, owner, {database: fixture.sql}); }
    finally { await fixture.sql.run('ROLLBACK'); }
    assert.equal(composio.calls.length, readsBeforeHeld, 'Held SQL revalidation performs no provider metadata or business calls.');
    const noAuthProof = await services.prepareStandaloneExtensionSelection(owner, {selection: {kind: 'composio', source: 'composio', toolkit: 'duckduckgo',
      target: {kind: 'personal', profileId: profile.id, accountBinding: 'no_auth'}}, requirement: 'optional', toolCap: []});
    const noAuth = await services.revalidatePreparedStandaloneExtensionSelection(noAuthProof, owner);
    assert(noAuth.mode === 'fixed' && noAuth.entry.target.kind === 'personal' && noAuth.entry.target.personalBinding.source === 'composio');
    assert.equal(noAuth.entry.target.personalBinding.accountBinding, 'no_auth'); assert.equal(noAuth.entry.target.personalBinding.connectedAccountId, null);
    await replaceScopedEnvEntries('integrations', [{key: 'COMPOSIO_API_KEY', value: `fixture-${randomBytes(24).toString('hex')}`}], {secretScope: 'legacy'});
    await expectStandalonePublicCode(() => services.revalidatePreparedStandaloneExtensionSelection(composioProof, owner), 'binding_changed');
    await profiles.archiveComposioProfile({ownerUserId: owner.userId, profileId: profile.id});
    await expectStandalonePublicCode(() => services.revalidatePreparedStandaloneExtensionSelection(noAuthProof, owner), 'binding_changed');

    stage = 'final no-business/no-external-network evidence';
    assert(composio.calls.length > 0 && composio.calls.every(call => ['/api/v3.1/toolkits', '/api/v3.1/connected_accounts'].includes(call.path)));
    assert(composio.calls.some(call => call.path === '/api/v3.1/connected_accounts' && call.userId === profile.composioUserId));
    assert.equal(mcp.calls().executions.length, 0); assert.equal(mcp.calls().requests, 0);
    assert.equal(fixture.providerRequests(), 0);
    console.log(`PASS standalone preparation: actual personal MCP API; shared use/no-manage and caller-transaction rejection; denied owner; exact source/binding/grant changes; opaque/cloned/cross-actor fences; actual SDK HTTP account/no-auth receipts; metadata reads ${composio.calls.length}; blocked SDK network attempts ${blockedNetworkAttempts}; business calls 0; external network requests 0.`);
    completed = true;
  } catch (error) {
    const line = error instanceof Error ? error.stack?.match(/extension-standalone-preparation-native-test\.ts:(\d+):/u)?.[1] : undefined;
    console.error(`FAIL standalone preparation at ${stage}; public code ${error && typeof error === 'object' ? String(Reflect.get(error, 'code') ?? 'assertion-or-internal') : 'internal'}; test line ${line ?? 'unavailable'}.`);
    throw new Error('Standalone preparation native proof did not pass.');
  } finally {
    const closeResults = await Promise.allSettled([composio?.close(), mcp?.close()]);
    try { await fixture?.close(); }
    finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(previousEnvironment)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      if (databaseName && dataRoot) await assertStandaloneFixtureCleanup(maintenance.toString(), databaseName, dataRoot);
    }
    assert(closeResults.every(result => result.status === 'fulfilled'), 'Owned provider cleanup completed.');
    console.log('CLEANUP standalone preparation: both owned provider listeners closed.');
    if (!completed) console.log('OUTCOME standalone preparation: failed; owned cleanup verified.');
  }
}

runStandalonePreparationNativeProof().catch(() => {process.exitCode = 1;});
