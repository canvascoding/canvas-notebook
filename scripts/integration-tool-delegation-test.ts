import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { IntegrationProviderPage, IntegrationToolPage, IntegrationToolSchema } from '../app/lib/integration-tools/contracts';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-delegated-integration-'));
  const provider = await createComposioProviderFixture();
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, COMPOSIO_BASE_URL: provider.baseUrl,
    CANVAS_INSTANCE_ID: 'delegation-fixture', CANVAS_MANAGED_SERVICES_ENABLED: 'false',
    CANVAS_ORGANIZATION_ID: 'delegation-org', CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
    BETTER_AUTH_BASE_URL: 'http://localhost:3000' };
  const previous = Object.fromEntries([...Object.keys(environment), 'COMPOSIO_API_KEY'].map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  delete process.env.COMPOSIO_API_KEY;
  const database = await createPiTestDatabase();
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    // Registry construction does not run an LLM. These ESM-only model packages
    // need CJS import shims; authorization, registry, dispatcher and Composio SDK remain real.
    if (name === '@earendil-works/pi-agent-core' || name === '@earendil-works/pi-ai/oauth') return {};
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
      getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false,
    };
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    if (name.includes('license/seat-limit')) return { assertUserSeatAccess: async ({ userId }: { userId: string }) => {
      assert.ok(['owner', 'alice', 'bob'].includes(userId));
      return { userId, mode: 'team', organizationId: environment.CANVAS_ORGANIZATION_ID };
    } };
    if (name === '@/app/lib/skills/effective-skill-read-roots') return {
      resolveEffectiveSkillReadRoots: async () => [], resolvePersonalSkillReadRoots: async () => [],
    };
    if (name === '@/app/lib/agents/workspace-brand-context') return { getWorkspaceBrandPromptBlock: async () => null };
    return originalLoad(name, parent, isMain);
  };
  try {
    const raw = await database.openDb();
    for (const id of ['owner', 'alice', 'bob']) await raw.run(
      'INSERT INTO "user" (id,name,email,role,email_verified,created_at,updated_at) VALUES ($1,$1,$2,\'member\',1,1,1)', [id, `${id}@example.test`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('delegation-org','owner','team',1,1,1)");
    for (const id of ['alice', 'bob']) {
      await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,created_at,updated_at) VALUES ('delegation-org',$1,'member','active',1,1)", [id]);
    }
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('team-a','delegation-org','team','workspaces/team-a/files','Team A','active',1,1)");
    for (const id of ['alice', 'bob']) await raw.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ('delegation-org','team-a',$1,'member','active',1,0,0,1,1)", [id]);
    await raw.run("INSERT INTO agents (agent_id,name,type,access_policy,scope_type,organization_id,owner_user_id,enabled_tools_json,revision,created_at,updated_at) VALUES ('worker','Worker','special','restricted','organization','delegation-org','owner','[\"composio_execute\"]',1,1,1)");
    await raw.run("INSERT INTO agent_grants (id,agent_id,organization_id,target_type,target_id,can_use,can_edit,can_manage,created_at,updated_at) VALUES ('worker-grant','worker','delegation-org','workspace','team-a',1,0,0,1,1)");
    const { piSessions, piDelegations } = await import('../app/lib/db/schema');
    const { DEFAULT_AGENT_ID } = await import('../app/lib/channels/constants');
    const { getAgentProfile } = await import('../app/lib/agents/registry');
    await getAgentProfile(DEFAULT_AGENT_ID);
    const now = new Date();
    const session = (sessionId: string, agentId = DEFAULT_AGENT_ID, userId = 'alice') => ({ sessionId, userId, agentId,
      workspaceId: 'team-a', workspaceType: 'team', organizationId: 'delegation-org', provider: 'fixture', model: 'fixture', createdAt: now, updatedAt: now });
    await database.db.insert(piSessions).values([session('parent'), session('finite-parent'), session('other-parent'), session('foreign-parent', DEFAULT_AGENT_ID, 'bob')]);
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'fixture-only-private-key' }], { secretScope: 'legacy' });
    const { serverPreferencesPath } = await import('../app/lib/terminal-policy');
    const prefsPath = serverPreferencesPath();
    await mkdir(path.dirname(prefsPath), { recursive: true });
    const setFlag = (enabled: boolean) => writeFile(prefsPath, JSON.stringify({ settings: { integrationToolGatewayEnabled: enabled } }));
    await setFlag(true);
    const { resolveComposioContext } = await import('../app/lib/composio/composio-context');
    const account = await resolveComposioContext({ userId: 'alice', workspaceId: 'team-a' });
    const accountRows = () => [{ id: 'approved-canva-account', toolkit: 'canva', status: 'ACTIVE' }];
    provider.accounts.set(account.composioUserId, accountRows());
    const { IntegrationDispatcher } = await import('../app/lib/integration-tools/dispatcher');
    const { listComposioIntegrationProviders } = await import('../app/lib/integration-tools/adapters/composio');
    const { createIntegrationGatewayTool } = await import('../app/lib/pi/integration-tool-gateway');
    const { resolveIntegrationExecutionContext, resolveRuntimeIntegrationExecutionContext } = await import('../app/lib/integration-tools/context');
    const { resolveIntegrationRuntimePolicy } = await import('../app/lib/integration-tools/runtime-policy');
    const { captureDelegatedIntegrationBindings, prepareDelegatedIntegrationBindings, prepareIntegrationBindingsForDelegatedRuntime } = await import('../app/lib/integration-tools/delegation');
    const { createPiDelegation, claimQueuedPiDelegation } = await import('../app/lib/pi/delegation-store');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { UNRESTRICTED_INTEGRATION_POLICY } = await import('../app/lib/integration-tools/policy');
    const { readPrivateDelegatedIntegrationSnapshot } = await import('../app/lib/integration-tools/delegation-contracts');
    let clock = 1_000;
    const dispatcher = new IntegrationDispatcher({ now: () => clock, catalogAdapters: { composio: listComposioIntegrationProviders,
      mcp: async () => ({ source: 'mcp', providers: [], complete: true, providerErrors: [], revision: 'empty' }) } });
    const factories = async (sessionId: string, turnId: string) => {
      const initial = await resolveIntegrationExecutionContext({ actorUserId: 'alice', sessionId, policyRevision: 'fixture-initial' });
      const context = { ...initial.executionContext, agentTurnId: turnId };
      return { context, tool: createIntegrationGatewayTool({ userId: 'alice', sessionId, agentId: context.agentId, executionContext: context }, {
        dispatcher, prepareDelegation: input => prepareDelegatedIntegrationBindings({ ...input, dispatcher }),
      }) };
    };
    const details = (result: AgentToolResult<unknown>) => result.details as Record<string, unknown>;
    const errorCode = (result: AgentToolResult<unknown>) => (details(result).integrationError as { error?: { code: string } } | undefined)?.error?.code;
    const posts = () => provider.calls.filter(call => call.path.includes('/tools/execute/'));
    const invoke = (factory: Awaited<ReturnType<typeof factories>>, request: unknown) => runWithAgentExecutionContext(factory.context,
      () => factory.tool.execute(`fixture-${provider.calls.length}`, request as never));
    const parent = await factories('parent', 'parent-issued-turn');
    assert.equal(provider.calls.length, 0, 'Constructor and context resolution do not preload providers.');
    const providers = details(await invoke(parent, { action: 'search', target: 'providers', query: 'Canva' })) as unknown as IntegrationProviderPage;
    const selectedProvider = providers.providers.find(item => item.application === 'canva')!;
    assert.ok(selectedProvider);
    const list = details(await invoke(parent, { action: 'list', target: 'tools', providerRef: selectedProvider.providerRef })) as unknown as IntegrationToolPage;
    const tool = list.tools.find(item => item.name === 'DESIGN_CREATE')!;
    const described = details(await invoke(parent, { action: 'describe', toolRef: tool.toolRef })) as unknown as IntegrationToolSchema;
    assert.ok(described.schemaRef);
    const selection = { toolRef: described.toolRef, schemaRef: described.schemaRef };
    const capture = () => runWithAgentExecutionContext(parent.context, () => captureDelegatedIntegrationBindings({
      actorUserId: 'alice', sourceSessionId: 'parent', sourceAgentId: DEFAULT_AGENT_ID, selections: [selection], dispatcher }));
    const snapshot = (await capture())!;
    assert.equal(snapshot.parent.agentTurnId, 'parent-issued-turn');
    assert.ok(!JSON.stringify(snapshot).includes('fixture-only-private-key'));
    assert.ok(!JSON.stringify(snapshot).includes(account.composioUserId));
    // Real receipt intake + issued parent/child source. The only external
    // boundaries are fixture licensing/model metadata and the local SDK HTTP server.
    const { listPersonalWorkflowProviderAccountChoices } = await import('../app/lib/integration-tools/workflow-personal-bindings');
    const { prepareAcceptedTurnExtensionSelection, readAcceptedTurnExtensionSelection } = await import('../app/lib/capabilities/extensions/accepted-turn-selection');
    const { getAuthorizedAgentWorkflowPackageSelections } = await import('../app/lib/capabilities/packages/runtime-bindings');
    const { resolveEffectiveExtensionContext } = await import('../app/lib/capabilities/extensions/effective-context');
    const { reissueAcceptedTurnRuntimeSelection, resolveDelegatedExtensionContextSource } = await import('../app/lib/capabilities/extensions/turn-runtime');
    const { captureDelegatedExtensionSource } = await import('../app/lib/capabilities/extensions/delegation-source');
    const finiteBase = (await factories('finite-parent', 'finite-parent-turn')).context;
    const choices = await listPersonalWorkflowProviderAccountChoices({ actor: { userId: 'alice', sessionId: 'finite-parent',
      source: 'system', sourceAgentId: DEFAULT_AGENT_ID, organizationId: 'delegation-org', workspaceId: 'team-a' },
      providerRef: selectedProvider.providerRef, exactToolkit: { profileId: account.profileId, toolkit: 'canva' } });
    const accepted = await prepareAcceptedTurnExtensionSelection(finiteBase, { version: 1, origin: 'turn_reference', selections: [{
      selection: { kind: 'composio', source: 'composio', toolkit: 'canva', target: { kind: 'personal', profileId: account.profileId,
        accountBinding: 'account', accountId: 'approved-canva-account', connectionRef: `composio-personal:${account.profileId}:approved-canva-account` } },
      requirement: 'optional', toolCap: ['DESIGN_CREATE'], accountSelectionRef: choices.accounts[0].accountSelectionRef,
    }] });
    const finiteTurn = { ...finiteBase, turnExtensions: readAcceptedTurnExtensionSelection(accepted, finiteBase).publicSelection };
    const finitePackages = await getAuthorizedAgentWorkflowPackageSelections(finiteTurn);
    const finiteIssued = { ...finiteTurn, turnExtensionSource: await reissueAcceptedTurnRuntimeSelection(finiteTurn, accepted, finiteBase,
      { packageSelection: finitePackages }) };
    const finiteParentContext = await resolveEffectiveExtensionContext(finiteIssued, { packageSelection: finitePackages });
    const finiteParentTool = createIntegrationGatewayTool({ userId: 'alice', sessionId: 'finite-parent', agentId: DEFAULT_AGENT_ID,
      executionContext: finiteParentContext }, { dispatcher });
    const finiteInvoke = (request: unknown) => runWithAgentExecutionContext(finiteParentContext,
      () => finiteParentTool.execute('finite-parent', request as never));
    const finiteProviderPage = details(await finiteInvoke({ action: 'list', target: 'providers' })) as unknown as IntegrationProviderPage;
    const finiteProvider = finiteProviderPage.providers[0]; assert(finiteProvider);
    const finiteToolPage = details(await finiteInvoke({ action: 'list', target: 'tools', providerRef: finiteProvider.providerRef })) as unknown as IntegrationToolPage;
    const finiteDescription = details(await finiteInvoke({ action: 'describe', toolRef: finiteToolPage.tools[0].toolRef })) as unknown as IntegrationToolSchema;
    await setFlag(false);
    const finiteSnapshot = await runWithAgentExecutionContext(finiteParentContext, () => captureDelegatedIntegrationBindings({ actorUserId: 'alice',
      sourceSessionId: 'finite-parent', sourceAgentId: DEFAULT_AGENT_ID, dispatcher,
      selections: [{ toolRef: finiteDescription.toolRef, schemaRef: finiteDescription.schemaRef }] }));
    assert(finiteSnapshot, 'An issued finite turn can approve its exact schema with the experiment off.');
    const finiteSource = await captureDelegatedExtensionSource(finiteParentContext); assert(finiteSource);
    await database.db.insert(piSessions).values({ ...session('finite-child'), sessionKind: 'delegation_worker',
      parentSessionId: 'finite-parent', delegationDepth: 1 });
    await createPiDelegation({ id: 'finite-handoff', userId: 'alice', sourceSessionId: 'finite-parent', sourceAgentId: DEFAULT_AGENT_ID,
      sourceAgentTurnId: 'finite-parent-turn', workerSessionId: 'finite-child', workerType: 'ephemeral',
      goal: 'Use exact finite handoff', toolsets: ['composio'], integrationBindingSnapshot: finiteSnapshot });
    await claimQueuedPiDelegation('finite-handoff', 'fixture-runner');
    const finiteChildBase = (await factories('finite-child', 'finite-child-turn')).context;
    const finiteChildContext = await resolveDelegatedExtensionContextSource(finiteSource, finiteChildBase, { delegationId: 'finite-handoff' });
    const finiteSchemas = await prepareIntegrationBindingsForDelegatedRuntime({ executionContext: finiteChildContext, dispatcher });
    assert.equal(finiteSchemas.length, 1);
    const finiteChildTool = createIntegrationGatewayTool({ userId: 'alice', sessionId: 'finite-child', agentId: DEFAULT_AGENT_ID,
      executionContext: finiteChildContext }, { dispatcher, prepareDelegation: input => prepareDelegatedIntegrationBindings({ ...input, dispatcher }) });
    const beforeFinitePost = posts().length;
    const finiteResult = await runWithAgentExecutionContext(finiteChildContext, () => finiteChildTool.execute('finite-child', {
      action: 'call', toolRef: finiteSchemas[0].toolRef, schemaRef: finiteSchemas[0].schemaRef, arguments: { title: 'Finite handoff' } }));
    assert.equal(errorCode(finiteResult), undefined);
    assert.equal(posts().length, beforeFinitePost + 1);
    assert.equal(posts().at(-1)!.body.connected_account_id, 'approved-canva-account');
    await setFlag(true);
    assert.throws(() => readPrivateDelegatedIntegrationSnapshot({ ...snapshot, binding: { apiKey: 'SECRET' } }));
    await assert.rejects(captureDelegatedIntegrationBindings({ actorUserId: 'alice', sourceSessionId: 'other-parent',
      sourceAgentId: DEFAULT_AGENT_ID, selections: [selection], dispatcher }));
    await assert.rejects(captureDelegatedIntegrationBindings({ actorUserId: 'bob', sourceSessionId: 'foreign-parent',
      sourceAgentId: DEFAULT_AGENT_ID, selections: [selection], dispatcher }));
    await assert.rejects(captureDelegatedIntegrationBindings({ actorUserId: 'alice', sourceSessionId: 'parent',
      sourceAgentId: DEFAULT_AGENT_ID, selections: [{ ...selection, schemaRef: 'schema:v1:invented' }], dispatcher }));
    await assert.rejects(captureDelegatedIntegrationBindings({ actorUserId: 'alice', sourceSessionId: 'parent',
      sourceAgentId: DEFAULT_AGENT_ID, selections: [{ ...selection, toolName: 'DESIGN_CREATE' } as never], dispatcher }));
    clock += 15 * 60_000 + 1;
    await assert.rejects(capture(), 'Expired public references cannot create a new approved snapshot.');
    const task = async (id: string, type: 'managed' | 'ephemeral', boundSnapshot = snapshot) => {
      const childId = `child-${id}`;
      await database.db.insert(piSessions).values({ ...session(childId, type === 'managed' ? 'worker' : DEFAULT_AGENT_ID),
        sessionKind: 'delegation_worker', parentSessionId: 'parent', delegationDepth: 1 });
      await createPiDelegation({ id, userId: 'alice', sourceSessionId: 'parent', sourceAgentId: DEFAULT_AGENT_ID,
        sourceAgentTurnId: boundSnapshot.parent.agentTurnId,
        workerSessionId: childId, workerType: type, targetAgentId: type === 'managed' ? 'worker' : undefined,
        goal: 'Create one approved design', context: '{"slug":"ANOTHER_TOOL"}', toolsets: ['composio'], integrationBindingSnapshot: boundSnapshot });
      await claimQueuedPiDelegation(id, 'fixture-runner');
      const factory = await factories(childId, `turn-${id}`);
      const prepared = await prepareIntegrationBindingsForDelegatedRuntime({ executionContext: factory.context, dispatcher });
      assert.equal(prepared.length, 1);
      assert.notEqual(prepared[0].schemaRef, described.schemaRef);
      return { id, childId, factory, schema: prepared[0] };
    };
    const managed = await task('managed', 'managed');
    const ephemeral = await task('ephemeral', 'ephemeral');
    const { getPiTools } = await import('../app/lib/pi/tool-registry');
    const { isIntegrationGatewayTool } = await import('../app/lib/pi/integration-tool-gateway');
    const { composioIntegrationToolAdapter } = await import('../app/lib/integration-tools/adapters/composio-runtime');
    const { mcpIntegrationToolAdapter } = await import('../app/lib/integration-tools/adapters/mcp-runtime');
    const { integrationDispatcher } = await import('../app/lib/integration-tools/dispatcher');
    // getPiTools uses the actual singleton dispatcher, so seed with the same
    // actual adapters and execute the tool that the worker model really receives.
    assert.equal(composioIntegrationToolAdapter.source, 'composio');
    assert.equal(mcpIntegrationToolAdapter.source, 'mcp');
    for (const child of [managed, ephemeral]) {
      const bindings = await prepareIntegrationBindingsForDelegatedRuntime({ executionContext: child.factory.context, dispatcher: integrationDispatcher });
      const tools = await getPiTools('alice', child.factory.context.agentId, child.childId, { executionContext: child.factory.context });
      const registered = tools.find(item => item.name === 'integrations');
      assert.ok(registered && isIntegrationGatewayTool(registered), `${child.id} model receives the actual integration gateway`);
      assert.deepEqual(registered.integrationGateway.policyCeiling.allowedOperations, ['composio.call']);
      const before = posts().length;
      const result = await runWithAgentExecutionContext(child.factory.context, () => registered.execute(`registry-${child.id}`, {
        action: 'call', toolRef: bindings[0].toolRef, schemaRef: bindings[0].schemaRef, arguments: { title: 'Registry approved design' },
      }));
      assert.equal(errorCode(result), undefined);
      assert.equal(posts().length, before + 1);
      assert.equal(posts().at(-1)!.body.connected_account_id, 'approved-canva-account');
    }
    assert.notEqual(managed.schema.schemaRef, ephemeral.schema.schemaRef, 'Child session/task/agent policy gives distinct authority.');
    const call = (child: typeof managed, args: Record<string, unknown> = { title: 'Approved design' }, schemaRef = child.schema.schemaRef) =>
      invoke(child.factory, { action: 'call', toolRef: child.schema.toolRef, schemaRef, arguments: args });
    const beforeDiscovery = provider.calls.length;
    const deniedCatalogue = details(await invoke(managed.factory, { action: 'list', target: 'providers' })) as unknown as IntegrationProviderPage;
    assert.deepEqual(deniedCatalogue.providers, []);
    assert.deepEqual(deniedCatalogue.nextActions, []);
    for (const request of [{ action: 'search', target: 'tools', providerRef: selectedProvider.providerRef, query: 'design' },
      { action: 'describe', toolRef: managed.schema.toolRef }]) assert.equal(errorCode(await invoke(managed.factory, request)), 'tool_denied');
    assert.equal(provider.calls.length, beforeDiscovery, 'No remote discovery for execute-only worker requests.');
    for (const child of [managed, ephemeral]) {
      const before = posts().length;
      assert.equal(errorCode(await call(child)), undefined);
      assert.equal(posts().length, before + 1);
      assert.deepEqual(posts().at(-1)!.body, { user_id: account.composioUserId, connected_account_id: 'approved-canva-account',
        version: '20261006_00', arguments: { title: 'Approved design' } });
    }
    const beforeFailures = posts().length;
    assert.equal(errorCode(await call(managed, { title: 17 })), 'invalid_arguments');
    assert.equal(errorCode(await call(managed, { title: 'wrong child' }, ephemeral.schema.schemaRef)), 'schema_changed');
    const otherTool = list.tools.find(item => item.name === 'ASSET_LOOKUP')!;
    assert.equal(errorCode(await invoke(managed.factory, { action: 'call', toolRef: otherTool.toolRef,
      schemaRef: managed.schema.schemaRef, arguments: { folder_id: 'private' } })), 'tool_not_found');
    assert.equal(posts().length, beforeFailures);
    provider.versions.set('DESIGN_CREATE', '20261006_01');
    const stale = await call(managed);
    assert.equal(errorCode(stale), 'schema_changed');
    assert.deepEqual((details(stale).integrationError as { nextActions: unknown[] }).nextActions, []);
    provider.versions.delete('DESIGN_CREATE');
    provider.accounts.set(account.composioUserId, [{ id: 'other-canva-account', toolkit: 'canva', status: 'ACTIVE' }]);
    assert.equal(errorCode(await call(managed)), 'binding_changed');
    provider.accounts.set(account.composioUserId, accountRows());
    await raw.run("UPDATE pi_delegations SET cancel_requested_at=1 WHERE id='managed'");
    assert.equal(errorCode(await call(managed)), 'tool_denied');
    await raw.run("UPDATE pi_delegations SET cancel_requested_at=NULL WHERE id='managed'");
    await database.db.insert(piDelegations).values({ id: 'ambiguous', userId: 'alice', sourceSessionId: 'parent', sourceAgentId: DEFAULT_AGENT_ID,
      workerSessionId: ephemeral.childId, workerType: 'ephemeral', goal: 'ambiguous', toolsetsJson: '["composio"]',
      status: 'running', createdAt: now, updatedAt: now });
    assert.equal(errorCode(await call(ephemeral)), 'tool_denied');
    await raw.run("DELETE FROM pi_delegations WHERE id='ambiguous'");
    assert.equal(posts().length, beforeFailures);
    const lateChange = (change: () => Promise<void>, read = 6) => {
      let count = 0;
      const gate = async () => { count += 1; if (count === read) await change(); else provider.rotateOnRead(gate); };
      provider.rotateOnRead(gate);
      return () => count;
    };
    const lateGrant = lateChange(() => raw.run("UPDATE agent_grants SET can_use=0 WHERE id='worker-grant'").then(() => {}));
    const revoked = await call(managed);
    assert.equal(errorCode(revoked), 'provider_denied');
    assert.equal(lateGrant(), 6, 'Revocation reached the final adapter schema await before the SDK POST.');
    await raw.run("UPDATE agent_grants SET can_use=1 WHERE id='worker-grant'");
    const lateTask = lateChange(() => raw.run("UPDATE pi_delegations SET status='completed' WHERE id='managed'").then(() => {}));
    assert.equal(errorCode(await call(managed)), 'tool_denied');
    assert.equal(lateTask(), 6);
    await raw.run("UPDATE pi_delegations SET status='running' WHERE id='managed'");
    const lateFlag = lateChange(() => setFlag(false));
    assert.equal(errorCode(await call(managed)), 'tool_denied');
    assert.equal(lateFlag(), 6);
    await setFlag(true);
    assert.equal(posts().length, beforeFailures, 'Actual final metadata revocations caused zero SDK execution POSTs.');
    const { readPiRuntimeConfig, writePiRuntimeConfig } = await import('../app/lib/agents/storage');
    const originalConfig = await readPiRuntimeConfig();
    const config = { ...originalConfig, providers: { ...originalConfig.providers,
      [originalConfig.activeProvider]: { ...originalConfig.providers[originalConfig.activeProvider], model: 'fixture-model' } } };
    const revokeParent = async () => {
      await writePiRuntimeConfig({ ...config, providers: { ...config.providers, [config.activeProvider]: {
        ...config.providers[config.activeProvider], enabledTools: ['composio_execute'],
      } } });
    };
    const lateParent = lateChange(revokeParent);
    assert.equal(errorCode(await call(managed)), 'schema_changed');
    assert.equal(lateParent(), 6);
    await writePiRuntimeConfig(config);
    assert.equal(posts().length, beforeFailures, 'Parent describe revocation also blocks an otherwise authorized child.');
    provider.setUnknown(true);
    assert.equal(errorCode(await call(managed)), 'outcome_unknown');
    provider.setUnknown(false);
    const afterChildUnknown = posts().length;
    await assert.rejects(capture(), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'outcome_unknown');
    const childUnknownHost = globalThis as typeof globalThis & { __canvasIntegrationUncertainTurnsV1?: Map<string, unknown> };
    childUnknownHost.__canvasIntegrationUncertainTurnsV1!.clear();
    const queuedAfterChildUnknown = await factories(ephemeral.childId, 'queued-after-child-unknown');
    assert.equal(errorCode(await invoke(queuedAfterChildUnknown, { action: 'call', toolRef: ephemeral.schema.toolRef,
      schemaRef: ephemeral.schema.schemaRef, arguments: { title: 'Sibling fallback' } })), 'outcome_unknown');
    assert.equal(posts().length, afterChildUnknown, 'A child uncertainty must also lock its originating parent turn durably.');
    const directParent = await factories('parent', 'direct-parent-turn');
    const reloaded = details(await invoke(directParent, { action: 'list', target: 'tools', providerRef: selectedProvider.providerRef })) as unknown as IntegrationToolPage;
    const reloadedSchema = details(await invoke(directParent, { action: 'describe', toolRef: reloaded.tools[0].toolRef })) as unknown as IntegrationToolSchema;
    const directSnapshot = await runWithAgentExecutionContext(directParent.context, () => captureDelegatedIntegrationBindings({ actorUserId: 'alice',
      sourceSessionId: 'parent', sourceAgentId: DEFAULT_AGENT_ID, selections: [{ toolRef: reloadedSchema.toolRef, schemaRef: reloadedSchema.schemaRef }], dispatcher }));
    const directChild = await task('direct-parent-queued', 'ephemeral', directSnapshot!);
    provider.setUnknown(true);
    const unknown = await invoke(directParent, { action: 'call', toolRef: reloadedSchema.toolRef, schemaRef: reloadedSchema.schemaRef, arguments: { title: 'Unknown design' } });
    provider.setUnknown(false);
    assert.equal(errorCode(unknown), 'outcome_unknown');
    const { readIntegrationGatewayErrorCode } = await import('../app/lib/integration-tools/agent-errors');
    assert.equal(readIntegrationGatewayErrorCode('integrations', unknown.details), 'outcome_unknown');
    assert.equal(readIntegrationGatewayErrorCode('integrations', { integrationError: {
      version: 1, error: { code: 'outcome_unknown', message: 'FAKE provider message' } } }), undefined);
    const afterUnknown = posts().length;
    await assert.rejects(runWithAgentExecutionContext(directParent.context, () => captureDelegatedIntegrationBindings({ actorUserId: 'alice',
      sourceSessionId: 'parent', sourceAgentId: DEFAULT_AGENT_ID, selections: [{ toolRef: reloadedSchema.toolRef, schemaRef: reloadedSchema.schemaRef }], dispatcher })),
    (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'outcome_unknown');
    assert.equal(errorCode(await call(directChild)), 'outcome_unknown', 'An already queued handoff cannot bypass the originating turn uncertainty lock.');
    assert.equal(posts().length, afterUnknown);
    const { isPersistedIntegrationTurnUncertain } = await import('../app/lib/integration-tools/uncertain-turn-store');
    assert.equal(await isPersistedIntegrationTurnUncertain(directParent.context), true);
    const uncertaintyHost = globalThis as typeof globalThis & { __canvasIntegrationUncertainTurnsV1?: Map<string, unknown> };
    uncertaintyHost.__canvasIntegrationUncertainTurnsV1!.clear();
    const resumed = await factories(directChild.childId, 'resumed-child-turn');
    assert.equal(errorCode(await invoke(resumed, { action: 'call', toolRef: directChild.schema.toolRef,
      schemaRef: directChild.schema.schemaRef, arguments: { title: 'Restart fallback' } })), 'outcome_unknown');
    assert.equal(posts().length, afterUnknown, 'Durable parent uncertainty survives in-memory cache eviction/restart.');
    const newHuman = { ...parent.context, agentTurnId: 'new-explicit-human-turn' };
    const renewed = await runWithAgentExecutionContext(newHuman, () => captureDelegatedIntegrationBindings({ actorUserId: 'alice', sourceSessionId: 'parent',
      sourceAgentId: DEFAULT_AGENT_ID, selections: [{ toolRef: reloadedSchema.toolRef, schemaRef: reloadedSchema.schemaRef }], dispatcher }));
    assert.equal(renewed!.parent.agentTurnId, 'new-explicit-human-turn');
    const mainTools = await getPiTools('alice', DEFAULT_AGENT_ID, 'parent', { executionContext: newHuman });
    const mainGateway = mainTools.find(item => item.name === 'integrations')!;
    const globalList = details(await runWithAgentExecutionContext(newHuman, () => mainGateway.execute('parent-global-list', {
      action: 'list', target: 'tools', providerRef: selectedProvider.providerRef,
    }))) as unknown as IntegrationToolPage;
    const globalSchema = details(await runWithAgentExecutionContext(newHuman, () => mainGateway.execute('parent-global-schema', {
      action: 'describe', toolRef: globalList.tools.find(item => item.name === 'DESIGN_CREATE')!.toolRef,
    }))) as unknown as IntegrationToolSchema;
    const { PiDelegationDispatcher } = await import('../app/lib/pi/delegation-dispatcher');
    const { createDelegateTaskTool } = await import('../app/lib/pi/delegate-task-tool');
    let startedRequest: Parameters<NonNullable<import('../app/lib/pi/delegation-dispatcher').DelegationDispatcherOptions['startDelegatedRunFn']>>[0] | undefined;
    let announceStarted!: () => void;
    const startedQueue = new Promise<void>(resolve => { announceStarted = resolve; });
    const queue = new PiDelegationDispatcher({ maxConcurrency: 1, recoverInterrupted: false, pollIntervalMs: 60_000,
      deliverCompletionFn: async () => {}, startDelegatedRunFn: async request => {
        startedRequest = request; announceStarted();
        return { status: 'accepted', worker_type: 'ephemeral', source_agent_id: request.sourceAgentId,
          session_id: request.workerSessionId!, wait_for_result: false, timeout_seconds: 0 };
      } });
    try {
      const delegate = createDelegateTaskTool({ userId: 'alice', sourceAgentId: DEFAULT_AGENT_ID, sourceSessionId: 'parent',
        startDelegatedRunFn: request => queue.enqueue(request) });
      const queued = await runWithAgentExecutionContext(newHuman, () => delegate.execute('queue-handoff', {
        goal: 'Run one explicitly approved design action', toolsets: ['composio'],
        integration_bindings: [{ toolRef: globalSchema.toolRef, schemaRef: globalSchema.schemaRef }],
        context: '{"sourceAgentTurnId":"MODEL-INJECTION","userId":"bob"}',
        sourceAgentTurnId: 'MODEL-INJECTION',
      }));
      assert.equal(details(queued).status, 'accepted');
      await startedQueue;
      const queueRow = await database.db.query.piDelegations.findFirst({ where: (table, { eq }) => eq(table.id, details(queued).delegation_id as string) });
      assert.equal(queueRow!.sourceAgentTurnId, 'new-explicit-human-turn');
      assert.equal(queueRow!.userId, 'alice');
      assert.equal(readPrivateDelegatedIntegrationSnapshot(queueRow!.integrationBindingsJson).parent.agentTurnId, 'new-explicit-human-turn');
      assert.equal(startedRequest!.hasIntegrationBindings, true);
      await startedRequest!.onCompletion!({ status: 'error', worker_type: 'ephemeral', source_agent_id: DEFAULT_AGENT_ID,
        session_id: startedRequest!.workerSessionId!, wait_for_result: false, timeout_seconds: 0, error: 'Fixture worker stopped after admission check.' });
      for (let tries = 0; queue.getActiveCount() && tries < 100; tries += 1) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(queue.getActiveCount(), 0);
    } finally { queue.stop(); }
    const childContext = await resolveRuntimeIntegrationExecutionContext({ executionContext: ephemeral.factory.context, policyRevision: 'probe' });
    const childPolicy = await resolveIntegrationRuntimePolicy({ executionContext: childContext.executionContext, ceiling: UNRESTRICTED_INTEGRATION_POLICY });
    assert.equal(childPolicy.policy.allowedOperations?.includes('composio.call'), true);
    assert.equal(childPolicy.policy.allowedOperations?.includes('composio.describe'), false);
    await provider.close();
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await raw.run('ALTER TABLE pi_delegations DROP COLUMN integration_bindings_json');
    await raw.run('ALTER TABLE pi_delegations DROP COLUMN source_agent_turn_identity');
    await runPostgresMigrations(database.getPostgresRuntimeQueryable() as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const migrated = await raw.all("SELECT integration_bindings_json,source_agent_turn_identity FROM pi_delegations WHERE id='managed'");
    assert.equal((migrated[0] as { integration_bindings_json: unknown }).integration_bindings_json, null);
    assert.equal((migrated[0] as { source_agent_turn_identity: unknown }).source_agent_turn_identity, null);
    console.log('PASS actual PG + Composio SDK delegated handoff: managed/ephemeral execute-only, exact account/version/session/task, bounded snapshots, cache expiry, forbidden discovery, late revocations, parent uncertainty and additive migration.');
  } finally {
    internals._load = originalLoad;
    await provider.close().catch(() => {});
    await database.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
