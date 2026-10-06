import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { createComposioProviderFixture as createProvider } from './helpers/composio-provider-fixture';
import type { IntegrationExecutionContext, IntegrationPolicy, IntegrationProviderPage, IntegrationToolPage, IntegrationToolSchema } from '../app/lib/integration-tools/contracts';


async function createActualManagedProxy(apiKey: () => string) {
  const root = process.env.CANVAS_CONTROL_PLANE_TEST_ROOT;
  if (!root) throw new Error('CANVAS_CONTROL_PLANE_TEST_ROOT is required for the actual Managed Composio integration test.');
  const cp = path.resolve(root, 'apps/api');
  const url = (file: string) => pathToFileURL(path.join(cp, file)).href;
  mock.module(url('src/db/connection.ts'), { namedExports: { db: { insert: () => ({ values: async () => {} }) },
    closeDatabaseConnection: async () => {}, assertDatabaseTimeZone: async () => {} } });
  const secrets = await import(url('src/services/managedSecrets.ts'));
  mock.module(url('src/services/managedSecrets.ts'), { namedExports: { ...secrets,
    getManagedProviderSecret: async () => apiKey(), validateManagedInstanceToken: async (token: string, scope: string) => {
      assert.equal(scope, 'composio:tools');
      return token === 'fixture-instance-token' ? { vmId: 'composio-runtime', organizationId: 'runtime-org' } : null;
    } } });
  const organizations = await import(url('src/services/organizations.ts'));
  mock.module(url('src/services/organizations.ts'), { namedExports: { ...organizations, getVmOrganizationId: async () => 'runtime-org' } });
  const fastifyPath = pathToFileURL(path.resolve(cp, '../../node_modules/fastify/fastify.js')).href;
  const { default: Fastify } = await import(fastifyPath);
  const { default: routes } = await import(url('src/routes/managedServices.ts'));
  const app = Fastify();
  let beforeExecute: (() => Promise<void>) | null = null;
  app.addHook('onRequest', async (request: { url: string }) => {
    if (request.url.endsWith('/composio/execute') && beforeExecute) {
      const callback = beforeExecute; beforeExecute = null; await callback();
    }
  });
  await app.register(routes, { prefix: '/v1' });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  return { baseUrl, close: () => app.close(), beforeNextExecute: (callback: () => Promise<void>) => { beforeExecute = callback; } };
}

function code(expected: string) {
  return (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === expected;
}

async function main() {
  if (process.argv.includes('--require-managed') && !process.env.CANVAS_CONTROL_PLANE_TEST_ROOT) {
    throw new Error('Set CANVAS_CONTROL_PLANE_TEST_ROOT to run the required Managed integration acceptance.');
  }
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-composio-runtime-'));
  const testDb = await createPiTestDatabase();
  const provider = await createProvider();
  const envKeys = ['DATA', 'CANVAS_DATA_ROOT', 'COMPOSIO_BASE_URL', 'COMPOSIO_API_KEY', 'CANVAS_INSTANCE_ID',
    'CANVAS_MANAGED_SERVICES_ENABLED', 'CANVAS_CONTROL_PLANE_URL', 'CANVAS_INSTANCE_TOKEN'] as const;
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { DATA: dataDir, CANVAS_DATA_ROOT: dataDir, COMPOSIO_BASE_URL: provider.baseUrl,
    CANVAS_INSTANCE_ID: 'composio-runtime', CANVAS_MANAGED_SERVICES_ENABLED: 'false' });
  delete process.env.COMPOSIO_API_KEY;
  const workspace = { workspaceId: 'runtime-workspace', workspaceType: 'team', organizationId: 'runtime-org', displayName: 'Runtime', legacy: false };
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return testDb;
    if (request === '@/app/lib/pi/session-workspace-context') return { resolveAgentSessionWorkspaceForUser: async () => workspace };
    return originalLoad(request, parent, isMain);
  };
  let managed: Awaited<ReturnType<typeof createActualManagedProxy>> | null = null;
  try {
    const database = await testDb.openDb();
    for (const userId of ['runtime-user-a', 'runtime-user-b']) await database.run('INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at) VALUES ($1,$1,$2,1,1,1)', [userId, `${userId}@example.test`]);
    await database.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,created_at,updated_at) VALUES ('runtime-org','runtime-user-a',1,1)");
    await database.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,created_at,updated_at) VALUES ('runtime-workspace','runtime-org','team','workspaces/runtime','Runtime',1,1)");
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    const setKey = (value: string | null) => replaceScopedEnvEntries('integrations', value ? [{ key: 'COMPOSIO_API_KEY', value }] : [], { secretScope: 'legacy' });
    await setKey('fixture-local-key');
    const { resolveComposioContext } = await import('../app/lib/composio/composio-context');
    const { createComposioProfile, setComposioWorkspaceProfileOverride } = await import('../app/lib/composio/composio-profiles');
    const { IntegrationDispatcher } = await import('../app/lib/integration-tools/dispatcher');
    const { listComposioIntegrationProviders } = await import('../app/lib/integration-tools/adapters/composio');
    const { composioIntegrationToolAdapter } = await import('../app/lib/integration-tools/adapters/composio-runtime');
    const context: IntegrationExecutionContext = { actorUserId: 'runtime-user-a', organizationId: 'runtime-org', workspaceId: 'runtime-workspace', agentId: 'design-agent', policyRevision: 'policy-1' };
    const policy: IntegrationPolicy = { allowedSources: ['composio'], allowedApplications: null, allowedOperations: null, allowedProviderRefs: null, allowedToolNames: null };
    const dispatcher = new IntegrationDispatcher({ catalogAdapters: { composio: listComposioIntegrationProviders,
      mcp: async () => ({ source: 'mcp', providers: [], complete: true, providerErrors: [], revision: 'fixture-empty' }) } });
    const execute = (request: unknown, selectedContext = context, selectedPolicy = policy) => dispatcher.execute({ request,
      context: selectedContext, policy: selectedPolicy, toolCallId: `fixture-${provider.calls.length}` });
    const defaultA = await resolveComposioContext({ userId: context.actorUserId, workspaceId: context.workspaceId });
    const defaultB = await resolveComposioContext({ userId: 'runtime-user-b', workspaceId: context.workspaceId });
    const design = await createComposioProfile({ ownerUserId: context.actorUserId, name: 'Design accounts' });
    provider.accounts.set(defaultA.composioUserId, [{ id: 'account-canva-a', toolkit: 'canva', status: 'ACTIVE' },
      { id: 'account-slack-a', toolkit: 'slack', status: 'ACTIVE' }, { id: 'account-github-a', toolkit: 'github', status: 'ACTIVE' }]);
    provider.accounts.set(defaultB.composioUserId, [{ id: 'account-canva-b', toolkit: 'canva', status: 'INITIATED' }]);
    provider.accounts.set(design.composioUserId, [{ id: 'account-canva-design', toolkit: 'canva', status: 'ACTIVE' }]);
    const catalogue = await execute({ action: 'search', target: 'providers', query: 'Canva' }) as IntegrationProviderPage;
    assert.equal(catalogue.providers.length, 2);
    const canva = catalogue.providers.find((item) => item.connection?.displayName === defaultA.profileName)!;
    const alternative = catalogue.providers.find((item) => item.connection?.displayName === design.name)!;
    assert.notEqual(canva.providerRef, alternative.providerRef);
    const first = await execute({ action: 'list', target: 'tools', providerRef: canva.providerRef, limit: 1 }) as IntegrationToolPage;
    assert.equal(first.tools.length, 1); assert.ok(first.nextCursor);
    assert.ok(!JSON.stringify(first).includes('input_parameters'));
    const second = await execute({ action: 'list', target: 'tools', providerRef: canva.providerRef, limit: 1, cursor: first.nextCursor! }) as IntegrationToolPage;
    assert.equal(second.tools[0].name, 'ASSET_LOOKUP');
    await assert.rejects(execute({ action: 'list', target: 'tools', providerRef: canva.providerRef, limit: 1, cursor: first.nextCursor! },
      { ...context, agentId: 'other-agent' }), code('invalid_cursor'));
    await assert.rejects(execute({ action: 'list', target: 'tools', providerRef: canva.providerRef, limit: 1, cursor: first.nextCursor! },
      { ...context, policyRevision: 'policy-2' }), code('invalid_cursor'));
    const searched = await execute({ action: 'search', target: 'tools', providerRef: canva.providerRef, query: 'design' }) as IntegrationToolPage;
    assert.deepEqual(searched.tools.map((tool) => tool.name), ['DESIGN_CREATE']);
    const designTool = searched.tools[0];
    const describe = () => execute({ action: 'describe', toolRef: designTool.toolRef }) as Promise<IntegrationToolSchema>;
    const schema = await describe();
    assert.equal(schema.toolVersion, '20261006_00');
    assert.ok(schema.outputSchema);
    const call = (selectedSchema = schema, args: Record<string, unknown> = { title: 'Campaign' }) => execute({ action: 'call',
      toolRef: designTool.toolRef, schemaRef: selectedSchema.schemaRef, arguments: args });
    const executed = await call();
    assert.ok('target' in executed);
    assert.equal(executed.target, 'result');
    const mutationCalls = () => provider.calls.filter((item) => item.path.includes('/tools/execute/'));
    assert.equal(mutationCalls().length, 1);
    assert.deepEqual(mutationCalls()[0].body, { user_id: defaultA.composioUserId, connected_account_id: 'account-canva-a', version: '20261006_00', arguments: { title: 'Campaign' } });
    const lateProvider = await composioIntegrationToolAdapter.resolveProvider(context, canva.providerRef);
    const lateSchema = await composioIntegrationToolAdapter.describeTool(context, lateProvider, 'DESIGN_CREATE');
    const metadataBeforeAuthorityGuard = provider.calls.length;
    let authorityGuards = 0;
    const foreignDenial = Object.assign(new Error('A current runtime grant was revoked.'), { code: 'provider_denied' });
    Object.defineProperty(foreignDenial, Symbol.for('canvas.integration.contract-error.v1'), { value: true });
    await assert.rejects(composioIntegrationToolAdapter.callTool(context, lateProvider, lateSchema, { title: 'Campaign' }, {
      toolCallId: 'late-runtime-denial', beforeDispatch: async () => { authorityGuards += 1; throw foreignDenial; },
    }), code('provider_denied'));
    assert.equal(authorityGuards, 1);
    assert(provider.calls.length > metadataBeforeAuthorityGuard, 'the authority guard runs after actual SDK account and schema reads');
    assert.equal(mutationCalls().length, 1, 'a late runtime denial prevents Composio dispatch without becoming an uncertain mutation');
    await assert.rejects(call(schema, { title: 7 }), code('invalid_arguments'));
    await assert.rejects(execute({ action: 'list', target: 'tools', providerRef: canva.providerRef }, { ...context, actorUserId: 'runtime-user-b' }), code('provider_denied'));
    await setComposioWorkspaceProfileOverride({ userId: context.actorUserId, workspaceId: workspace.workspaceId, profileId: design.id });
    await call();
    assert.equal(mutationCalls().at(-1)!.body.connected_account_id, 'account-canva-a', 'An unrelated default profile change cannot reroute an explicit provider');
    const originalAccounts = provider.accounts.get(defaultA.composioUserId)!;
    provider.accounts.set(defaultA.composioUserId, originalAccounts.map((item) => item.toolkit === 'canva' ? { ...item, id: 'reconnected-account' } : item));
    await assert.rejects(call(), code('binding_changed'));
    provider.accounts.set(defaultA.composioUserId, originalAccounts);
    provider.versions.set('DESIGN_CREATE', '20261006_01');
    await assert.rejects(call(), code('schema_changed'));
    provider.versions.clear();
    provider.inputs.set('DESIGN_CREATE', { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] });
    await assert.rejects(call(), code('schema_changed'));
    provider.inputs.clear();
    provider.accounts.set(defaultA.composioUserId, [...originalAccounts, { id: 'second-active-account', toolkit: 'canva', status: 'ACTIVE' }]);
    const ambiguous = await composioIntegrationToolAdapter.resolveProvider(context, canva.providerRef);
    assert.equal(ambiguous.provider.canExecute, false); assert.equal(ambiguous.provider.state, 'unknown');
    await assert.rejects(call(), code('binding_changed'));
    provider.accounts.set(defaultA.composioUserId, originalAccounts);
    const noToolsBefore = provider.calls.filter((item) => item.path === '/api/v3.1/tools').length;
    const denied = await execute({ action: 'list', target: 'tools', providerRef: canva.providerRef }, context, { ...policy, allowedToolNames: [] }) as IntegrationToolPage;
    assert.deepEqual(denied.tools, []);
    assert.equal(provider.calls.filter((item) => item.path === '/api/v3.1/tools').length, noToolsBefore);
    const limited = await execute({ action: 'list', target: 'tools', providerRef: canva.providerRef }, context,
      { ...policy, allowedToolNames: ['ASSET_LOOKUP'] }) as IntegrationToolPage;
    assert.deepEqual(limited.tools.map((tool) => tool.name), ['ASSET_LOOKUP']);
    assert.equal(provider.calls.filter((item) => item.path === '/api/v3.1/tools').at(-1)!.toolNames, 'ASSET_LOOKUP');
    const beforeCached = provider.calls.filter((item) => item.path === '/api/v3.1/tools').length;
    await execute({ action: 'list', target: 'tools', providerRef: canva.providerRef }, context, { ...policy, allowedToolNames: ['ASSET_LOOKUP'] });
    assert.equal(provider.calls.filter((item) => item.path === '/api/v3.1/tools').length, beforeCached, 'Repeat tool discovery reuses only compact metadata');
    provider.failPage();
    const partial = await execute({ action: 'search', target: 'tools', providerRef: canva.providerRef, query: 'unique-miss' }) as IntegrationToolPage;
    assert.equal(partial.complete, false); assert.ok(partial.providerErrors.length > 0);
    assert.ok(!JSON.stringify(partial).includes('SECRET-UPSTREAM-BODY'));
    const current = await describe();
    provider.rotateOnRead(async () => { await setKey('rotated-local-key'); });
    await assert.rejects(call(current), code('binding_changed'));
    assert.equal(mutationCalls().length, 2, 'Rotating credentials during schema lookup cannot issue a POST with a new credential');
    await setKey('fixture-local-key');

    for (const app of [{ slug: 'slack', tool: 'CHANNEL_POST', account: 'account-slack-a', args: { channel: 'design', message: 'Campaign ready' } },
      { slug: 'github', tool: 'REPO_READ', account: 'account-github-a', args: { owner: 'canvas', repo: 'design' } }]) {
      const appCatalogue = await execute({ action: 'search', target: 'providers', query: app.slug }) as IntegrationProviderPage;
      const appProvider = appCatalogue.providers.find((item) => item.connection?.displayName === defaultA.profileName)!;
      const appTools = await execute({ action: 'list', target: 'tools', providerRef: appProvider.providerRef }) as IntegrationToolPage;
      assert.deepEqual(appTools.tools.map((tool) => tool.name), [app.tool]);
      const appSchema = await execute({ action: 'describe', toolRef: appTools.tools[0].toolRef }) as IntegrationToolSchema;
      await execute({ action: 'call', toolRef: appTools.tools[0].toolRef, schemaRef: appSchema.schemaRef, arguments: app.args });
      assert.equal(mutationCalls().at(-1)!.body.connected_account_id, app.account);
      assert.equal(mutationCalls().at(-1)!.body.user_id, defaultA.composioUserId);
      assert.equal(mutationCalls().at(-1)!.body.version, '20261006_00');
    }
    provider.setUnknown(true);
    const localUnknownSchema = await describe();
    const localUnknownBefore = mutationCalls().length;
    await assert.rejects(call(localUnknownSchema), code('outcome_unknown'));
    assert.equal(mutationCalls().length, localUnknownBefore + 1, 'An unknown local SDK outcome is not retried');
    provider.setUnknown(false);
    await setKey(null);
    Object.assign(process.env, { CANVAS_MANAGED_SERVICES_ENABLED: 'true', CANVAS_CONTROL_PLANE_URL: provider.baseUrl, CANVAS_INSTANCE_TOKEN: 'fixture-instance-token' });
    await assert.rejects(composioIntegrationToolAdapter.resolveProvider(context, canva.providerRef),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'provider_unavailable' && /Update the Control Plane/u.test(error.message));
    provider.setLegacyCapabilityStatus(401);
    await assert.rejects(composioIntegrationToolAdapter.resolveProvider(context, canva.providerRef),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'provider_denied'
        && !/Update the Control Plane|SECRET/u.test(error.message));
    provider.setLegacyCapabilityStatus(503);
    await assert.rejects(composioIntegrationToolAdapter.resolveProvider(context, canva.providerRef),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'provider_unavailable'
        && !/Update the Control Plane|SECRET/u.test(error.message));
    console.log('integration-tool-composio-runtime-test: LOCAL PASS (actual dispatcher/schema workers/SDK, Canva/Slack/GitHub, opaque profiles/accounts/version/cursors/cache, safe legacy Managed errors)');
    if (!process.env.CANVAS_CONTROL_PLANE_TEST_ROOT) {
      console.log('integration-tool-composio-runtime-test: SKIP actual Managed proxy; set CANVAS_CONTROL_PLANE_TEST_ROOT for the mandatory cross-repository acceptance gate.');
      return;
    }

    let managedKey = 'fixture-managed-key';
    managed = await createActualManagedProxy(() => managedKey);
    await setKey(null);
    Object.assign(process.env, { CANVAS_MANAGED_SERVICES_ENABLED: 'true', CANVAS_CONTROL_PLANE_URL: managed.baseUrl, CANVAS_INSTANCE_TOKEN: 'fixture-instance-token' });
    await assert.rejects(call(current), code('binding_changed'));
    const managedSchema = await describe();
    const managedResult = await call(managedSchema);
    assert.ok('target' in managedResult);
    assert.equal(managedResult.target, 'result');
    assert.equal(mutationCalls().at(-1)!.body.connected_account_id, 'account-canva-a');
    assert.equal(mutationCalls().at(-1)!.body.user_id, defaultA.composioUserId);
    assert.equal(mutationCalls().at(-1)!.body.version, '20261006_00');
    const beforeManagedRace = mutationCalls().length;
    managed.beforeNextExecute(async () => { provider.versions.set('DESIGN_CREATE', '20261006_01'); });
    await assert.rejects(call(managedSchema), code('schema_changed'));
    assert.equal(mutationCalls().length, beforeManagedRace, 'The actual proxy rejects a server-side schema race before a mutation');
    provider.versions.clear();
    managed.beforeNextExecute(async () => { managedKey = 'rotated-managed-key'; });
    await assert.rejects(call(managedSchema), code('binding_changed'));
    assert.equal(mutationCalls().length, beforeManagedRace, 'The actual proxy rejects a server-side credential race before a mutation');
    managedKey = 'fixture-managed-key';
    managedKey = 'rotated-managed-key';
    await assert.rejects(call(managedSchema), code('binding_changed'));
    managedKey = 'fixture-managed-key';
    const noAuthCatalogue = await execute({ action: 'search', target: 'providers', query: 'duckduckgo' }) as IntegrationProviderPage;
    const noAuthProvider = noAuthCatalogue.providers.find((item) => item.connection?.displayName === defaultA.profileName)!;
    const noAuthTools = await execute({ action: 'list', target: 'tools', providerRef: noAuthProvider.providerRef }) as IntegrationToolPage;
    const noAuthSchema = await execute({ action: 'describe', toolRef: noAuthTools.tools[0].toolRef }) as IntegrationToolSchema;
    const noAuth = await execute({ action: 'call', toolRef: noAuthTools.tools[0].toolRef, schemaRef: noAuthSchema.schemaRef, arguments: { query: 'Design' } });
    assert.ok('target' in noAuth);
    assert.equal(noAuth.target, 'result'); assert.equal(mutationCalls().at(-1)!.body.connected_account_id, undefined);
    provider.setUnknown(true);
    const unknownSchema = await describe();
    const beforeUnknown = mutationCalls().length;
    await assert.rejects(call(unknownSchema), code('outcome_unknown'));
    assert.equal(mutationCalls().length, beforeUnknown + 1, 'Unknown Managed mutation outcome is never retried');
    provider.setUnknown(false);
    console.log('integration-tool-composio-runtime-test: CROSS-REPOSITORY PASS (actual CP Fastify routes/SDK, exact account/version, credential/schema races, no-auth, safe unknown outcome)');
  } finally {
    if (managed) await managed.close();
    internals._load = originalLoad;
    await provider.close(); await testDb.close(); await rm(dataDir, { recursive: true, force: true });
    mock.restoreAll();
    for (const key of envKeys) { const value = originalEnv[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
