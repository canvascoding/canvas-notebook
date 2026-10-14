import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Module from 'node:module';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';
import type { AgentManagementActor } from '../app/lib/agents/management-actions';
import type { AgentExtensionConfigurationInput } from '../app/lib/capabilities/extensions/contracts';

// Actual Store ZIP/publication, signed fixture license, PGlite SQL actor,
// workspace/agent/source ACLs and real public writers. Only model catalogue and
// SDK update metadata are controlled; account metadata uses the real SDK against
// one owned loopback provider. Every business/tools/external request fails.
async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  const provider = await createComposioProviderFixture();
  const providerFetch = globalThis.fetch;
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const previousLoad = loader._load;
  const environment = { COMPOSIO_BASE_URL: provider.baseUrl, COMPOSIO_API_KEY: '', COMPOSIO_LOGGING_LEVEL: 'silent',
    CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_CONTROL_PLANE_URL: provider.baseUrl, CANVAS_INSTANCE_TOKEN: '' };
  const saved = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const networkFetch = (await import('undici')).fetch;
  let forbiddenNetwork = 0, stage = 'load services', expectedManagedUser: string | undefined, managedCatalogueReads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.origin === fixture.registry.baseUrl) return providerFetch(input, init);
    if (url.href === 'https://registry.npmjs.org/@composio/core/latest' && method === 'GET') return Response.json({ version: '0.0.0' });
    // Like the pi-ai catalogue above, model metadata is a controlled non-authority boundary.
    // No model execution or resource/actor/source decision is replaced.
    if (url.origin === provider.baseUrl && url.pathname === '/v1/managed/models' && method === 'GET') return Response.json({
      catalogRevision: 'owned-options-model-metadata', defaultModelId: 'owned-options-model', models: [{
        id: 'owned-options-model', name: 'Owned model metadata only', provider: 'openai', input: ['text'], contextWindow: 32_768, maxTokens: 4_096 }] });
    if (url.origin !== provider.baseUrl || method !== 'GET'
      || !/^\/api\/v3\.1\/(toolkits|connected_accounts)(?:\/[a-z0-9_-]+)?$|^\/v1\/managed\/composio\/toolkits$/u.test(url.pathname)) {
      forbiddenNetwork++; throw new Error('Only owned package and explicit account metadata is allowed.');
    }
    if (url.pathname === '/v1/managed/composio/toolkits') {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      assert(expectedManagedUser, 'Managed catalogue IO is allowed only inside the explicit two-profile fixture.');
      assert.equal(headers.get('X-Canvas-Composio-User-Id'), expectedManagedUser, 'An explicit profile must never be replaced by the first/default profile.');
      managedCatalogueReads++;
    }
    return networkFetch(url.href, { ...init, redirect: 'error' } as Parameters<typeof networkFetch>[1]) as unknown as Promise<Response>;
  };
  loader._load = (name, parent, isMain) => name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat'
    ? { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => {}, isContextOverflow: () => false }
    : previousLoad(name, parent, isMain);
  try {
    const { owner, alice, organizationId, sql } = fixture;
    const ownerActor: AgentManagementActor = { ...owner, source: 'api' }, aliceActor: AgentManagementActor = { ...alice, source: 'api' };
    const contexts = await import('../app/lib/agents/extension-options-context');
    const { listAgentExtensionConnectionChoices } = await import('../app/lib/agents/extension-options-connections');
    const { agentExtensionOptionsRequestSchema } = await import('../app/lib/agents/extension-options-contracts');
    const management = await import('../app/lib/agents/management-actions');
    const workflows = await import('../app/lib/agents/workflow-configuration');
    const registry = await import('../app/lib/agents/registry');
    const sourceStore = await import('../app/lib/integration-tools/connections/store');
    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const sourceActor = { ...owner, organizationId };
    const choose = async (context: Awaited<ReturnType<typeof contexts.resolveAgentExtensionOptionsContext>>, input: Record<string, unknown>) => {
      const request = agentExtensionOptionsRequestSchema.parse({ operation: 'connection_choices', target: context.target, ...input });
      assert(request.operation === 'connection_choices');
      return listAgentExtensionConnectionChoices(context, request);
    };
    const errorCode = (code: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === code);
    const source = (displayName: string, grantees = [owner.userId, alice.userId]) => createSharedMcpConnection(sourceActor, {
      ownership: { type: 'organization', organizationId }, displayName, accessMode: 'restricted', allowedToolNames: ['read_fixture', 'extra_fixture'],
      grants: grantees.map(targetId => ({ targetType: 'user' as const, targetId, canUse: true, canManage: false, allowedToolNames: ['read_fixture', 'extra_fixture'] })),
      config: { url: 'https://fixture.invalid/mcp', transport: 'http', auth: 'none', enabled: true },
    });
    const first = await source('First shared source'), second = await source('Second shared source');
    const hidden = await source('Hidden source', [owner.userId]);

    stage = 'prospective actual actor Use without Manage and no fake agent';
    const before = await sql.all('SELECT agent_id FROM agents ORDER BY agent_id');
    const aliceProspective = await contexts.resolveAgentExtensionOptionsContext(aliceActor, { kind: 'prospective', scopeType: 'user' });
    const initial = await choose(aliceProspective, { selector: { kind: 'standalone', source: 'mcp' }, limit: 1 });
    assert.equal(initial.connections.length, 1); assert(initial.pagination.hasNextPage); assert(initial.pagination.nextCursor);
    const next = await choose(aliceProspective, { selector: { kind: 'standalone', source: 'mcp' }, limit: 1, cursor: initial.pagination.nextCursor });
    assert.equal(next.connections.length, 1); assert.notEqual(initial.connections[0].id, next.connections[0].id);
    const all = await choose(aliceProspective, { selector: { kind: 'standalone', source: 'mcp' } });
    assert.deepEqual(new Set(all.connections.map(value => value.selection.target.kind === 'shared' ? value.selection.target.connectionRef : 'personal')),
      new Set([first.resource.connectionRef, second.resource.connectionRef]));
    assert(all.connections.every(value => value.eligibility.action === 'select' && value.health === 'unknown' && !value.mappingRequired));
    assert.deepEqual(await sql.all('SELECT agent_id FROM agents ORDER BY agent_id'), before);
    await assert.rejects(contexts.resolveAgentExtensionOptionsContext(aliceActor, { kind: 'prospective', scopeType: 'organization' }), errorCode('AGENT_ORGANIZATION_ADMIN_REQUIRED'));
    await assert.rejects(choose(aliceProspective, { selector: { kind: 'standalone', source: 'mcp' }, q: 'changed', limit: 1,
      cursor: initial.pagination.nextCursor }), errorCode('AGENT_WORKFLOW_OPTIONS_CURSOR_CHANGED'));
    await assert.rejects(choose(structuredClone(aliceProspective), { selector: { kind: 'standalone', source: 'mcp' } }), errorCode('AGENT_ACCESS_DENIED'));
    assert.equal(provider.calls.length, 0);

    stage = 'actual published package alternative and extra MCP mapping authority';
    const pluginRegistry = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const name = `options-source-${randomUUID().slice(0, 8)}`;
    const archive = await fixture.registry.addPackage('application', 'plugin', name, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', description: 'Exact options fixture', skills: './skills',
        connectors: { mcp: [{ name: 'reader', required: false, configPath: 'mcp.json' }] }, workflow: { version: 1, integrationCapabilities: [{
          id: 'reader', application: 'reader', required: true, alternatives: [{ source: 'mcp', connector: 'reader', requiredTools: ['read_fixture'] }] }] } }),
      'mcp.json': JSON.stringify({ url: 'https://fixture.invalid/mcp', transport: 'http', auth: 'none' }),
      'skills/brief/SKILL.md': '---\nname: brief\ndescription: Prepare precise evidence\n---\n\nExact held brief.\n',
    }, pluginRegistry.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: name, version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' },
      grants: [owner, alice].map(actor => ({ targetType: 'user' as const, targetId: actor.userId, canUse: true, canEdit: false, canManage: false })) });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const packageSelector = { kind: 'package', package: pin, declarationPath: '.canvas-plugin/plugin.json', capabilityId: 'reader', alternativeKey: 'mcp:reader' };
    assert.equal((await choose(aliceProspective, { selector: packageSelector })).connections.length, 0, 'Source Use alone never permits a new package MCP mapping.');
    const ownerProspective = await contexts.resolveAgentExtensionOptionsContext(ownerActor, { kind: 'prospective', scopeType: 'user' });
    const packageChoices = await choose(ownerProspective, { selector: packageSelector });
    assert(packageChoices.connections.length >= 3); assert(packageChoices.connections.every(value => value.mappingRequired));
    await assert.rejects(choose(ownerProspective, { selector: { ...packageSelector, capabilityId: 'invented' } }), errorCode('AGENT_WORKFLOW_ALTERNATIVE_INVALID'));
    await assert.rejects(choose(ownerProspective, { selector: { ...packageSelector, package: { ...pin, checksum: 'f'.repeat(64) } } }), errorCode('AGENT_WORKFLOW_PACKAGE_CHANGED'));
    assert.equal(provider.calls.length, 0);

    stage = 'real persisted target-only grants and Use-only finite slots';
    const empty: AgentExtensionConfigurationInput = { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [] };
    const agent = await management.createManagedAgent(ownerActor, { agentId: `${name}-agent`, name: 'Options target', scopeType: 'organization', extensions: empty,
      grants: [{ targetType: 'user', targetId: alice.userId, canUse: true, canEdit: false, canManage: false }] });
    const targetOnly = await createSharedMcpConnection(sourceActor, { ownership: { type: 'organization', organizationId }, displayName: 'Exact target-only source',
      accessMode: 'restricted', allowedToolNames: ['read_fixture'], grants: [
        { targetType: 'user', targetId: owner.userId, canUse: true, canManage: false, allowedToolNames: ['read_fixture'] },
        { targetType: 'agent', targetId: agent.agent.agentId, canUse: true, canManage: false, allowedToolNames: ['read_fixture'] }],
      config: { url: 'https://fixture.invalid/target', transport: 'http', auth: 'none', enabled: true } });
    const sharedSelection = (value: typeof first) => ({ kind: 'mcp' as const, source: 'mcp' as const,
      target: { kind: 'shared' as const, connectionRef: value.resource.connectionRef, bindingRevision: value.resource.bindingRevision } });
    const configured = await workflows.updateManagedAgentConfiguration({ actor: ownerActor, agentId: agent.agent.agentId,
      expectedRevision: agent.agent.revision, expectedWorkflowRevision: 1, extensions: { ...empty, mode: 'fixed', standalone: [
        { mode: 'selectable', configurationId: 'approved-readers', source: 'mcp', requirement: 'optional', allowedChoices: [
          { choiceId: 'first', selection: sharedSelection(first), toolCap: ['read_fixture'] },
          { choiceId: 'exact-target', selection: sharedSelection(targetOnly), toolCap: ['read_fixture'] }] },
        { mode: 'fixed', entry: { selection: sharedSelection(hidden), requirement: 'optional', toolCap: ['read_fixture'] } },
        { mode: 'selectable', configurationId: 'own-canva', source: 'composio', toolkit: 'canva', requirement: 'optional', allowedChoices: [],
          personalPolicy: { source: 'composio', toolkit: 'canva', toolCap: ['DESIGN_CREATE'] } },
      ] } });
    const configuredWorkflowRevision = configured.agent.workflowRevision;
    assert(typeof configuredWorkflowRevision === 'number' && Number.isSafeInteger(configuredWorkflowRevision) && configuredWorkflowRevision > 0,
      'The real writer must persist a positive workflow revision before issuing user-choice options.');
    const { createStandaloneExtensionSlotRef } = await import('../app/lib/capabilities/extensions/standalone-reference');
    const choiceTarget = (configurationId: string, source: 'mcp' | 'composio' = 'mcp', toolkit?: string) => ({ kind: 'user_choice' as const,
      agentId: agent.agent.agentId, expectedWorkflowRevision: configuredWorkflowRevision, expectedPreferenceRevision: 0,
      capabilityKey: createStandaloneExtensionSlotRef({ configurationId, source, ...(toolkit ? { toolkit } : {}) }) });
    const choiceContext = await contexts.resolveAgentExtensionOptionsContext(aliceActor, choiceTarget('approved-readers'));
    let globalSharedQueries = 0;
    fixture.setBeforeRead(async query => { if (/SELECT connection_ref FROM integration_connection_resources\s+WHERE organization_id=\$1 AND status='active'/u.test(query)) globalSharedQueries++; });
    const allowed = await choose(choiceContext, { selector: { kind: 'slot' } });
    fixture.setBeforeRead(undefined);
    assert.equal(globalSharedQueries, 0, 'Use-only slot discovery never enumerates the global shared catalogue.');
    assert.deepEqual(new Set(allowed.connections.map(value => value.choiceId)), new Set(['first', 'exact-target']));
    assert(allowed.connections.every(value => value.allowedToolNames?.join(',') === 'read_fixture'));
    assert(!JSON.stringify(allowed).includes(hidden.resource.connectionRef)); assert(!JSON.stringify(allowed).includes(second.resource.connectionRef));
    const savedSnapshot = await workflows.readManagedAgentWorkflow(ownerActor, agent.agent.agentId);
    const fixedSlot = savedSnapshot.bindings.find(binding => binding.standaloneConfiguration?.mode === 'fixed')!.standaloneConfiguration!;
    const fixedContext = await contexts.resolveAgentExtensionOptionsContext(aliceActor, choiceTarget(fixedSlot.configurationId));
    await assert.rejects(choose(fixedContext, { selector: { kind: 'slot' } }), errorCode('AGENT_WORKFLOW_CHOICE_DENIED'));
    await assert.rejects(contexts.resolveAgentExtensionOptionsContext(aliceActor, { kind: 'existing', agentId: agent.agent.agentId,
      expectedRevision: configured.agent.revision, expectedWorkflowRevision: configuredWorkflowRevision }), errorCode('AGENT_ACCESS_DENIED'));
    assert.equal(provider.calls.length, 0);

    stage = 'actual package personal-policy mapping and metadata-only required roots';
    const mcpConfig = await import('../app/lib/mcp/config');
    const { resolveOrganizationMcpTemplatesDir } = await import('../app/lib/runtime-data-paths');
    await mcpConfig.writeMcpConfigRaw(JSON.stringify({ mcpServers: { 'Approved member connection': {
      url: 'https://member-options.fixture.invalid/mcp', transport: 'http', auth: 'none', enabled: true,
    } } }), { userId: alice.userId });
    const personalConfig = await mcpConfig.readMcpConfig({ userId: alice.userId });
    const personalConnection = personalConfig.mcpServers['Approved member connection'];
    const definitionId = randomUUID(), definitionPath = path.join(resolveOrganizationMcpTemplatesDir(organizationId), 'approved-servers.json');
    await fs.mkdir(path.dirname(definitionPath), { recursive: true });
    await fs.writeFile(definitionPath, JSON.stringify({ version: 1, definitions: [{ version: 1, id: definitionId, organizationId,
      name: 'Explicit approved definition', enabled: true, revision: 1, updatedAt: new Date().toISOString(),
      config: { url: 'https://member-options.fixture.invalid/mcp', transport: 'http', auth: 'none' } }] }));
    personalConnection.organizationId = organizationId; personalConnection.serverDefinitionId = definitionId;
    await fs.writeFile(mcpConfig.resolveMcpConfigPath({ userId: alice.userId }), JSON.stringify(personalConfig));
    const packageAgent = await management.createManagedAgent(ownerActor, { agentId: `${name}-package`, name: 'Actual package personal choice', scopeType: 'organization',
      grants: [{ targetType: 'user', targetId: alice.userId, canUse: true, canEdit: false, canManage: false }], extensions: { ...empty, mode: 'fixed', selections: [{
        selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } }, requirement: 'required', toolCap: ['read_fixture'] }],
      workflow: { version: 1, packages: [{ ...pin, skillSelection: { kind: 'plugin' }, declarations: [{ declarationPath: '.canvas-plugin/plugin.json', capabilities: [{
        capabilityId: 'reader', selection: { mode: 'selectable', allowedChoices: [{ choiceId: 'central', alternativeKey: 'mcp:reader',
          target: { kind: 'shared', source: 'mcp', connectionRef: first.resource.connectionRef, bindingRevision: first.resource.bindingRevision,
            mcpMapping: { kind: 'manager_confirmation' } }, toolCap: ['read_fixture'] }], personalPolicy: { sources: ['mcp'], alternativeKeys: ['mcp:reader'],
            toolCap: ['read_fixture'], mcpDefinitionMappings: [{ connector: 'reader', serverDefinitionIds: [definitionId] }] } } }] }] }] } } });
    const { agentWorkflowCapabilityKey } = await import('../app/lib/agents/workflow-contracts');
    const packageWorkflowRevision = packageAgent.agent.workflowRevision;
    assert(typeof packageWorkflowRevision === 'number' && Number.isSafeInteger(packageWorkflowRevision) && packageWorkflowRevision > 0,
      'The real package agent must have its persisted workflow revision.');
    const packageTarget = { kind: 'user_choice' as const, agentId: packageAgent.agent.agentId, expectedWorkflowRevision: packageWorkflowRevision,
      expectedPreferenceRevision: 0, capabilityKey: agentWorkflowCapabilityKey(pin.resourceRef, '.canvas-plugin/plugin.json', 'reader') };
    const policyContext = await contexts.resolveAgentExtensionOptionsContext(aliceActor, packageTarget);
    const matching = await choose(policyContext, { selector: { kind: 'slot', alternativeKey: 'mcp:reader' } });
    assert(matching.connections.some(value => value.selection.kind === 'mcp' && value.selection.target.kind === 'personal'
      && value.selection.target.connectionRef === `mcp-personal:${personalConnection.connectionId}`));
    const personalPackageChoice = matching.connections.find(value => value.selection.kind === 'mcp' && value.selection.target.kind === 'personal');
    assert(personalPackageChoice?.packageBinding?.target.kind === 'personal');
    assert.equal(personalPackageChoice.packageBinding.target.ownerUserId, alice.userId);
    assert.equal(personalPackageChoice.packageBinding.alternativeKey, 'mcp:reader');
    // A real readable unrelated Composio plugin must not activate the old global
    // readiness/account path merely to calculate this selected package's roots.
    const unrelatedName = `${name}-unrelated`;
    const unrelated = await fixture.registry.addPackage('application', 'plugin', unrelatedName, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name: unrelatedName, version: '1.0.0', description: 'Unrelated Composio readiness fixture', skills: './skills',
        connectors: { composio: [{ toolkit: 'canva', recommended: true }] } }),
      'skills/unrelated/SKILL.md': '---\nname: unrelated\ndescription: Unrelated available instructions\n---\n\nUnrelated.\n',
    }, pluginRegistry.computeCanvasPluginChecksum);
    await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application', entryKey: unrelatedName,
      version: '1.0.0', checksum: unrelated.checksum }, ownership: { type: 'organization' },
      grants: [owner, alice].map(actor => ({ targetType: 'user' as const, targetId: actor.userId, canUse: true, canEdit: false, canManage: false })) });
    const beforeProfiles = await sql.all('SELECT id FROM composio_connection_profiles ORDER BY id'), beforeProbeCount = provider.calls.length;
    await choose(policyContext, { selector: { kind: 'slot' } });
    assert.deepEqual(await sql.all('SELECT id FROM composio_connection_profiles ORDER BY id'), beforeProfiles);
    assert.equal(provider.calls.length, beforeProbeCount);
    // Arrange the historical strict private package format with a missing
    // mapping. The real SQL reader/ACL/source remains active, not mocked.
    const storedBinding = await sql.get("SELECT id,configuration_json FROM agent_capability_bindings WHERE agent_id=$1 AND resource_type='plugin'", [packageAgent.agent.agentId]) as { id: string; configuration_json: string };
    const historical = JSON.parse(storedBinding.configuration_json);
    assert.equal(historical.kind, 'package');
    delete historical.workflow.declarations[0].capabilities[0].selection.personalPolicy.mcpDefinitionMappings;
    await sql.run('UPDATE agent_capability_bindings SET configuration_json=$1 WHERE id=$2', [JSON.stringify(historical), storedBinding.id]);
    await sql.run('UPDATE agents SET workflow_revision=workflow_revision+1,revision=revision+1 WHERE agent_id=$1', [packageAgent.agent.agentId]);
    const historicalAgent = await registry.getAgentProfile(packageAgent.agent.agentId); assert(historicalAgent);
    const historicalWorkflowRevision = historicalAgent.workflowRevision;
    assert(typeof historicalWorkflowRevision === 'number' && Number.isSafeInteger(historicalWorkflowRevision)
      && historicalWorkflowRevision > packageWorkflowRevision, 'The actual SQL mutation must advance the stored workflow revision.');
    const unmappedContext = await contexts.resolveAgentExtensionOptionsContext(aliceActor, { ...packageTarget, expectedWorkflowRevision: historicalWorkflowRevision });
    const unmapped = await choose(unmappedContext, { selector: { kind: 'slot', alternativeKey: 'mcp:reader' } });
    assert(!unmapped.connections.some(value => value.selection.target.kind === 'personal'), 'Missing package mapping is an empty definition allowlist, never all approved definitions.');

    stage = 'explicit own profile only; exact two-account sealed choices with no automatic selection';
    await (await import('../app/lib/integrations/env-config')).replaceScopedEnvEntries('integrations',
      [{ key: 'COMPOSIO_API_KEY', value: 'isolated-options-fixture-key' }], { secretScope: 'user', userId: alice.userId });
    const composio = await (await import('../app/lib/composio/composio-context')).resolveComposioContext({ userId: alice.userId, workspaceId: alice.workspaceId });
    provider.accounts.set(composio.composioUserId, [{ id: 'exact-a', toolkit: 'canva', status: 'ACTIVE' }, { id: 'exact-b', toolkit: 'canva', status: 'ACTIVE' }]);
    const accountContext = await contexts.resolveAgentExtensionOptionsContext(aliceActor, choiceTarget('own-canva', 'composio', 'canva'));
    const metadata = await choose(accountContext, { selector: { kind: 'slot' } });
    assert.equal(metadata.accounts.length, 0); assert.equal(provider.calls.length, 0); assert.equal(metadata.profiles[0]?.profileId, composio.profileId);
    assert.deepEqual(metadata.personalSelectionPolicy, { requirement: 'optional', toolCap: ['DESIGN_CREATE'] });
    const accountChoices = await choose(accountContext, { selector: { kind: 'slot' }, profileId: composio.profileId });
    assert.deepEqual(new Set(accountChoices.accounts.map(value => value.selection.target.accountId)), new Set(['exact-a', 'exact-b']));
    assert(accountChoices.accounts.every(value => value.selectable && value.selection.target.connectionRef === `composio-personal:${composio.profileId}:${value.selection.target.accountId}`));
    const { readPersonalComposioAccountReference } = await import('../app/lib/composio/composio-shared-account-reference');
    assert.equal(readPersonalComposioAccountReference(accountChoices.accounts.find(value => value.selection.target.accountId === 'exact-b')!.accountSelectionRef).accountId, 'exact-b');
    assert(!('selectedAccount' in accountChoices));
    const calls = provider.calls.length;
    await assert.rejects(choose(accountContext, { selector: { kind: 'slot' }, profileId: 'foreign-profile' }), errorCode('AGENT_WORKFLOW_CHOICE_DENIED'));
    await assert.rejects(choose(accountContext, { selector: { kind: 'slot' }, profileId: composio.profileId, cursor: 'invalid' }), errorCode('AGENT_WORKFLOW_OPTIONS_CURSOR_CHANGED'));
    assert.equal(provider.calls.length, calls, 'Invalid profile/cursor fails before provider IO.');
    assert.doesNotMatch(JSON.stringify(accountChoices), /providerRef|personalBinding|boundProviderRef|bindingFingerprint|composioUserId|isolated-options-fixture-key/u);

    stage = 'actual canonical package choices round-trip through public writers';
    const { previewAgentExtensionConfiguration } = await import('../app/lib/agents/extension-options-preview');
    const { readManagedAgentWorkflow, setManagedAgentWorkflowChoice } = workflows;
    const { agentWorkflowTargetSchema } = await import('../app/lib/agents/workflow-public-contracts');
    const packageConfiguration = (selectedPin: typeof pin, binding: NonNullable<typeof personalPackageChoice.packageBinding>): AgentExtensionConfigurationInput => ({
      ...empty, mode: 'fixed', selections: [{ selection: { kind: 'plugin', package: selectedPin, skillSelection: { kind: 'all' } }, requirement: 'required', toolCap: null }],
      workflow: { version: 1, packages: [{ ...selectedPin, skillSelection: { kind: 'plugin' }, declarations: [{ declarationPath: '.canvas-plugin/plugin.json',
        capabilities: [{ capabilityId: 'reader', selection: { mode: 'fixed', ...binding, toolCap: null } }] }] }] },
    });
    const ownMcpPackageChoices = await choose(aliceProspective, { selector: packageSelector });
    const ownMcpPackage = ownMcpPackageChoices.connections.find(value => value.selection.kind === 'mcp' && value.selection.target.kind === 'personal');
    assert(ownMcpPackage?.packageBinding?.target.kind === 'personal');
    assert(agentWorkflowTargetSchema.safeParse(ownMcpPackage.packageBinding.target).success);
    const beforeMcpAccountReads = provider.calls.filter(value => /^\/api\/v3\.1\/connected_accounts(?:\/|$)|^\/v1\/managed\/composio\/status$/u.test(value.path)).length;
    const ownMcpAgent = await management.createManagedAgent(aliceActor, { agentId: `${name}-own-mcp`, name: 'Options chosen package MCP',
      scopeType: 'user', extensions: packageConfiguration(pin, ownMcpPackage.packageBinding) });
    assert.equal(provider.calls.filter(value => /^\/api\/v3\.1\/connected_accounts(?:\/|$)|^\/v1\/managed\/composio\/status$/u.test(value.path)).length,
      beforeMcpAccountReads, 'Creating the actual MCP-only package agent never loads unrelated Composio accounts, even after a personal profile exists.');
    const ownMcpSnapshot = await readManagedAgentWorkflow(aliceActor, ownMcpAgent.agent.agentId);
    const ownMcpStored = ownMcpSnapshot.bindings.find(value => value.configuration)?.configuration?.declarations[0]?.capabilities[0]?.selection;
    assert(ownMcpStored?.mode === 'fixed' && ownMcpStored.target.kind === 'personal' && ownMcpStored.target.personalBinding?.source === 'mcp');
    assert.equal(ownMcpStored.target.personalBinding.connectionId, personalConnection.connectionId);

    const composioName = `${name}-composio`;
    const composioArchive = await fixture.registry.addPackage('application', 'plugin', composioName, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name: composioName, version: '1.0.0', description: 'Public package account mutation values', skills: './skills',
        connectors: { composio: [{ toolkit: 'canva', required: false }, { toolkit: 'duckduckgo', required: false }] },
        workflow: { version: 1, integrationCapabilities: [{ id: 'reader', application: 'design', required: true, alternatives: [
          { source: 'composio', toolkit: 'canva', requiredTools: ['DESIGN_CREATE'] }, { source: 'composio', toolkit: 'duckduckgo' }] }] } }),
      'skills/options-composio-brief/SKILL.md': '---\nname: options-composio-brief\ndescription: Follow the exactly selected app\n---\n\nExact package account.\n',
    }, pluginRegistry.computeCanvasPluginChecksum);
    const composioInstalled = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: composioName, version: '1.0.0', checksum: composioArchive.checksum }, ownership: { type: 'organization' },
      grants: [owner, alice].map(actor => ({ targetType: 'user' as const, targetId: actor.userId, canUse: true, canEdit: false, canManage: false })) });
    const composioPin = { resourceRef: composioInstalled.resource.resourceRef, publishedRevisionRef: composioInstalled.published.revisionRef,
      checksum: composioInstalled.published.checksum };
    const composioSelector = { ...packageSelector, package: composioPin, alternativeKey: 'composio:canva' };
    const personalOptionsTarget = { kind: 'prospective' as const, scopeType: 'user' as const };
    const freshAliceProspective = await contexts.resolveAgentExtensionOptionsContext(aliceActor, personalOptionsTarget);
    const packageAccounts = await choose(freshAliceProspective, { selector: composioSelector, profileId: composio.profileId });
    const packageB = packageAccounts.accounts.find(value => value.selection.target.accountId === 'exact-b');
    assert(packageB?.packageBinding?.target.kind === 'personal');
    assert.equal(packageB.packageBinding.target.accountSelectionRef, packageB.accountSelectionRef);
    assert.equal(packageB.packageBinding.target.ownerUserId, alice.userId);
    assert(agentWorkflowTargetSchema.safeParse(packageB.packageBinding.target).success);
    const exactBConfiguration = packageConfiguration(composioPin, packageB.packageBinding);
    const exactBAgent = await management.createManagedAgent(aliceActor, { agentId: `${name}-chosen-b`, name: 'Options chosen exact B', scopeType: 'user',
      extensions: exactBConfiguration });
    const exactBSnapshot = await readManagedAgentWorkflow(aliceActor, exactBAgent.agent.agentId);
    const exactBStored = exactBSnapshot.bindings.find(value => value.configuration)?.configuration?.declarations[0]?.capabilities[0]?.selection;
    assert(exactBStored?.mode === 'fixed' && exactBStored.target.kind === 'personal' && exactBStored.target.personalBinding?.source === 'composio');
    assert.equal(exactBStored.target.personalBinding.connectedAccountId, 'exact-b');
    assert.doesNotMatch(JSON.stringify(exactBSnapshot.bindings), /accountSelectionRef|cmp_personal_account_|isolated-options-fixture-key/u);
    const publicB = await management.inspectManagedAgent(aliceActor, exactBAgent.agent.agentId, { purpose: 'configure' });
    assert.equal(publicB.extensions.configurationState, 'available');
    assert.doesNotMatch(JSON.stringify(publicB), /personalBinding|boundProviderRef|bindingFingerprint|composioUserId|isolated-options-fixture-key/u);

    const sharedComposioAgent = await management.createManagedAgent(ownerActor, { agentId: `${name}-package-choice`, name: 'Per-user actual package option',
      scopeType: 'organization', grants: [{ targetType: 'user', targetId: alice.userId, canUse: true, canEdit: false, canManage: false }],
      extensions: { ...empty, mode: 'fixed', selections: [{ selection: { kind: 'plugin', package: composioPin, skillSelection: { kind: 'all' } },
        requirement: 'required', toolCap: null }], workflow: { version: 1, packages: [{ ...composioPin, skillSelection: { kind: 'plugin' },
        declarations: [{ declarationPath: '.canvas-plugin/plugin.json', capabilities: [{ capabilityId: 'reader', selection: { mode: 'selectable', allowedChoices: [],
          personalPolicy: { sources: ['composio'], alternativeKeys: ['composio:canva'], toolCap: ['DESIGN_CREATE'] } } }] }] }] } } });
    const sharedComposioRevision = sharedComposioAgent.agent.workflowRevision;
    assert(typeof sharedComposioRevision === 'number' && sharedComposioRevision > 0);
    const packageChoiceTarget = { kind: 'user_choice' as const, agentId: sharedComposioAgent.agent.agentId,
      capabilityKey: agentWorkflowCapabilityKey(composioPin.resourceRef, '.canvas-plugin/plugin.json', 'reader'),
      expectedWorkflowRevision: sharedComposioRevision, expectedPreferenceRevision: 0 };
    const packageChoiceContext = await contexts.resolveAgentExtensionOptionsContext(aliceActor, packageChoiceTarget);
    const packageOwnAccounts = await choose(packageChoiceContext, { selector: { kind: 'slot', alternativeKey: 'composio:canva' }, profileId: composio.profileId });
    const perUserB = packageOwnAccounts.accounts.find(value => value.selection.target.accountId === 'exact-b');
    assert(perUserB?.packageBinding?.target.kind === 'personal');
    await setManagedAgentWorkflowChoice({ actor: aliceActor, agentId: packageChoiceTarget.agentId, capabilityKey: packageChoiceTarget.capabilityKey,
      expectedWorkflowRevision: packageChoiceTarget.expectedWorkflowRevision, expectedPreferenceRevision: 0, personalSelection: perUserB.packageBinding });
    const perUserSnapshot = await readManagedAgentWorkflow(aliceActor, sharedComposioAgent.agent.agentId);
    const perUserStored = perUserSnapshot.choices[packageChoiceTarget.capabilityKey]?.personalTarget;
    assert(perUserStored?.kind === 'personal' && perUserStored.personalBinding?.source === 'composio');
    assert.equal(perUserStored.personalBinding.connectedAccountId, 'exact-b');
    assert.equal(perUserSnapshot.access.canEdit, false, 'The actual personal package choice needs Use, never central Edit.');

    stage = 'actual no-auth package choice and toolkit-only honest preview';
    const noAuthOptions = await choose(freshAliceProspective, { selector: { ...composioSelector, alternativeKey: 'composio:duckduckgo' }, profileId: composio.profileId });
    assert(noAuthOptions.noAuthSelection?.target.accountBinding === 'no_auth');
    assert(noAuthOptions.noAuthPackageBinding?.target.kind === 'personal');
    assert.equal(noAuthOptions.noAuthPackageBinding.target.accountSelectionRef, undefined);
    const noAuthConfiguration = packageConfiguration(composioPin, noAuthOptions.noAuthPackageBinding);
    const composioToolNames = ['read', 'COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'composio_execute'];
    const accountReadsBeforePreview = provider.calls.filter(value => value.path.startsWith('/api/v3.1/connected_accounts')).length;
    const noAuthPreview = await previewAgentExtensionConfiguration(freshAliceProspective, { operation: 'preview', target: personalOptionsTarget,
      configuration: noAuthConfiguration, enabledTools: composioToolNames });
    assert.equal(noAuthPreview.preview.requirements[0]?.state, 'bound');
    assert(!noAuthPreview.preview.issues.some(value => value.severity === 'error'), JSON.stringify(noAuthPreview.preview.issues));
    assert.equal(noAuthPreview.preview.runtimeReadiness, 'not_checked');
    assert.equal(noAuthPreview.preview.finalSaveValidationRequired, true);
    const realStandaloneNoAuth: AgentExtensionConfigurationInput = { ...empty, mode: 'fixed', standalone: [{ mode: 'fixed', entry: {
      selection: noAuthOptions.noAuthSelection, requirement: 'required', toolCap: null } }] };
    const standaloneNoAuthPreview = await previewAgentExtensionConfiguration(freshAliceProspective, { operation: 'preview', target: personalOptionsTarget,
      configuration: realStandaloneNoAuth, enabledTools: composioToolNames });
    assert(!standaloneNoAuthPreview.preview.issues.some(value => value.severity === 'error'), JSON.stringify(standaloneNoAuthPreview.preview.issues));
    const inventedStandaloneNoAuth: AgentExtensionConfigurationInput = { ...empty, mode: 'fixed', standalone: [{ mode: 'fixed', entry: {
      selection: { ...noAuthOptions.noAuthSelection, toolkit: 'canva' }, requirement: 'required', toolCap: null } }] };
    const inventedNoAuthPreview = await previewAgentExtensionConfiguration(freshAliceProspective, { operation: 'preview', target: personalOptionsTarget,
      configuration: inventedStandaloneNoAuth, enabledTools: composioToolNames });
    assert(inventedNoAuthPreview.preview.issues.some(value => value.severity === 'error'), 'An owned profile cannot turn an authenticated standalone app into no-auth.');
    assert.equal(provider.calls.filter(value => value.path.startsWith('/api/v3.1/connected_accounts')).length, accountReadsBeforePreview,
      'No-auth preview may read toolkit metadata, never account metadata or health.');
    const noAuthAgent = await management.createManagedAgent(aliceActor, { agentId: `${name}-no-auth`, name: 'Options chosen real no-auth package', scopeType: 'user',
      extensions: noAuthConfiguration });
    const noAuthSnapshot = await readManagedAgentWorkflow(aliceActor, noAuthAgent.agent.agentId);
    const noAuthStored = noAuthSnapshot.bindings.find(value => value.configuration)?.configuration?.declarations[0]?.capabilities[0]?.selection;
    assert(noAuthStored?.mode === 'fixed' && noAuthStored.target.kind === 'personal' && noAuthStored.target.personalBinding?.source === 'composio');
    assert.equal(noAuthStored.target.personalBinding.accountBinding, 'no_auth'); assert.equal(noAuthStored.target.personalBinding.connectedAccountId, null);

    const missingReceipt = structuredClone(exactBConfiguration);
    assert(missingReceipt.mode === 'fixed' && missingReceipt.workflow);
    const missingReceiptSelection = missingReceipt.workflow.packages[0].declarations[0].capabilities[0].selection;
    assert(missingReceiptSelection.mode === 'fixed' && missingReceiptSelection.target.kind === 'personal');
    delete missingReceiptSelection.target.accountSelectionRef;
    const missingReceiptPreview = await previewAgentExtensionConfiguration(freshAliceProspective, { operation: 'preview', target: personalOptionsTarget,
      configuration: missingReceipt, enabledTools: composioToolNames });
    assert(missingReceiptPreview.preview.issues.some(value => value.severity === 'error'), 'An authenticated app is never inferred to be no-auth from its missing receipt.');
    const mismatchedSource = packageConfiguration(pin, { alternativeKey: 'mcp:reader', target: { kind: 'shared', source: 'composio',
      connectionRef: first.resource.connectionRef, bindingRevision: first.resource.bindingRevision, mcpMapping: { kind: 'manager_confirmation' } } });
    const mismatchedPreview = await previewAgentExtensionConfiguration(freshAliceProspective, { operation: 'preview', target: personalOptionsTarget,
      configuration: mismatchedSource, enabledTools: ['read', 'mcp'] });
    assert.notEqual(mismatchedPreview.preview.requirements[0]?.state, 'bound');
    assert(mismatchedPreview.preview.issues.some(value => value.severity === 'error'), 'Preview must preserve the writer source check rather than rewriting it from the alternative.');
    assert.doesNotMatch(JSON.stringify(packageAccounts), /personalBinding|boundProviderRef|bindingFingerprint|composioUserId|isolated-options-fixture-key/u);
    assert(accountChoices.accounts.every(value => value.packageBinding === undefined), 'Standalone account choices never carry package workflow mutation metadata.');

    stage = 'V2 package admission never infers the sole active account';
    const originalAccounts = provider.accounts.get(composio.composioUserId)!;
    provider.accounts.set(composio.composioUserId, [{ id: 'exact-b', toolkit: 'canva', status: 'ACTIVE' }]);
    await assert.rejects(management.createManagedAgent(aliceActor, { agentId: `${name}-missing-receipt`, name: 'Missing exact account admission',
      scopeType: 'user', extensions: missingReceipt }), errorCode('AGENT_WORKFLOW_ACCOUNT_SELECTION_REQUIRED'));
    assert.equal(await registry.getAgentProfile(`${name}-missing-receipt`), null, 'A failed complete admission leaves no executable agent.');
    await assert.rejects(setManagedAgentWorkflowChoice({ actor: aliceActor, agentId: packageChoiceTarget.agentId, capabilityKey: packageChoiceTarget.capabilityKey,
      expectedWorkflowRevision: packageChoiceTarget.expectedWorkflowRevision, expectedPreferenceRevision: perUserSnapshot.preferenceRevision,
      personalSelection: { alternativeKey: 'composio:canva', target: { ...perUserB.packageBinding.target, accountSelectionRef: undefined } } }),
    errorCode('AGENT_WORKFLOW_ACCOUNT_SELECTION_REQUIRED'));
    const unchangedChoice = await readManagedAgentWorkflow(aliceActor, sharedComposioAgent.agent.agentId);
    assert.equal(unchangedChoice.preferenceRevision, perUserSnapshot.preferenceRevision, 'Missing receipt cannot commit a partial preference change.');
    provider.accounts.set(composio.composioUserId, originalAccounts);

    stage = 'actual managed toolkit metadata stays bound to the chosen second profile';
    const profilesService = await import('../app/lib/composio/composio-profiles');
    const secondProfile = await profilesService.createComposioProfile({ ownerUserId: alice.userId, name: 'Explicit second options profile' });
    assert.notEqual(secondProfile.id, composio.profileId);
    assert.notEqual(secondProfile.composioUserId, composio.composioUserId);
    const inventory = await import('../app/lib/agents/extension-options-inventory');
    const firstProfilePage = await inventory.readAgentComposioOptionsCatalogue(freshAliceProspective, new AbortController().signal,
      { profileId: composio.profileId });
    assert(firstProfilePage.continuation);
    await assert.rejects(inventory.readAgentComposioOptionsCatalogue(freshAliceProspective, new AbortController().signal,
      { profileId: secondProfile.id, continuation: firstProfilePage.continuation }), errorCode('AGENT_WORKFLOW_OPTIONS_CURSOR_CHANGED'));
    const beforeForeignProfile = provider.calls.length;
    await assert.rejects(inventory.readAgentComposioOptionsCatalogue(freshAliceProspective, new AbortController().signal,
      { profileId: 'foreign-profile' }), errorCode('AGENT_WORKFLOW_CHOICE_DENIED'));
    assert.equal(provider.calls.length, beforeForeignProfile, 'A foreign profile fails before catalogue transport.');
    await (await import('../app/lib/integrations/env-config')).replaceScopedEnvEntries('integrations', [], { secretScope: 'user', userId: alice.userId });
    process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
    process.env.CANVAS_INSTANCE_TOKEN = 'owned-options-fixture-token';
    expectedManagedUser = secondProfile.composioUserId;
    const beforeManagedAccounts = provider.calls.filter(value => value.path.startsWith('/api/v3.1/connected_accounts')).length;
    const secondProfileNoAuth: AgentExtensionConfigurationInput = { ...empty, mode: 'fixed', standalone: [{ mode: 'fixed', entry: {
      selection: { ...noAuthOptions.noAuthSelection, target: { kind: 'personal', profileId: secondProfile.id, accountBinding: 'no_auth' } },
      requirement: 'required', toolCap: null } }] };
    const managedSecondPreview = await previewAgentExtensionConfiguration(freshAliceProspective, { operation: 'preview', target: personalOptionsTarget,
      configuration: secondProfileNoAuth, enabledTools: composioToolNames });
    assert(!managedSecondPreview.preview.issues.some(value => value.severity === 'error'), JSON.stringify(managedSecondPreview.preview.issues));
    assert(managedCatalogueReads > 0, 'The actual managed HTTP transport must receive the chosen profile namespace.');
    assert.equal(provider.calls.filter(value => value.path.startsWith('/api/v3.1/connected_accounts')).length, beforeManagedAccounts);
    expectedManagedUser = undefined;
    process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'false';
    process.env.CANVAS_INSTANCE_TOKEN = '';
    await (await import('../app/lib/integrations/env-config')).replaceScopedEnvEntries('integrations',
      [{ key: 'COMPOSIO_API_KEY', value: 'isolated-options-fixture-key' }], { secretScope: 'user', userId: alice.userId });

    stage = 'late actual profile and agent-Use revocation';
    let profileLists = 0;
    fixture.setBeforeRead(async query => {
      if (/FROM composio_connection_profiles profile/u.test(query) && ++profileLists === 3) {
        await sql.run("UPDATE composio_connection_profiles SET status='archived',updated_at=updated_at+1 WHERE id=$1", [composio.profileId]);
      }
    });
    await assert.rejects(choose(accountContext, { selector: { kind: 'slot' }, profileId: composio.profileId }), errorCode('AGENT_WORKFLOW_BINDING_CHANGED'));
    fixture.setBeforeRead(undefined);
    assert.equal(profileLists, 3, 'The real profile changes only after the post-account read, during the final metadata lease.');
    await sql.run("UPDATE composio_connection_profiles SET status='active',updated_at=updated_at+1 WHERE id=$1", [composio.profileId]);
    provider.rotateOnEndpoint('/api/v3.1/connected_accounts', async () => {
      await sql.run("UPDATE composio_connection_profiles SET status='archived',updated_at=updated_at+1 WHERE id=$1", [composio.profileId]);
    });
    await assert.rejects(choose(accountContext, { selector: { kind: 'slot' }, profileId: composio.profileId }));
    await sql.run("UPDATE composio_connection_profiles SET status='active',updated_at=updated_at+1 WHERE id=$1", [composio.profileId]);
    provider.rotateOnEndpoint('/api/v3.1/connected_accounts', async () => {
      await sql.run("UPDATE agent_grants SET can_use=0 WHERE agent_id=$1 AND target_type='user' AND target_id=$2", [agent.agent.agentId, alice.userId]);
    });
    await assert.rejects(choose(accountContext, { selector: { kind: 'slot' }, profileId: composio.profileId }), errorCode('AGENT_ACCESS_DENIED'));
    await sql.run("UPDATE agent_grants SET can_use=1 WHERE agent_id=$1 AND target_type='user' AND target_id=$2", [agent.agent.agentId, alice.userId]);
    const fresh = await registry.getAgentProfile(agent.agent.agentId); assert(fresh);
    await sourceStore.mutateSharedIntegrationConnection(sourceActor, first.resource.connectionRef, {
      expectedMetadataRevision: first.resource.metadataRevision, expectedGrantsRevision: first.resource.grantsRevision,
      expectedBindingRevision: first.resource.bindingRevision, grants: [{ targetType: 'user', targetId: owner.userId, canUse: true, canManage: false,
        allowedToolNames: ['read_fixture', 'extra_fixture'] }] });
    const afterRevoke = await choose(choiceContext, { selector: { kind: 'slot' } });
    assert.deepEqual(afterRevoke.connections.map(value => value.choiceId), ['exact-target']);
    assert.equal(forbiddenNetwork, 0); assert.equal(fixture.providerRequests(), 0);
    assert(provider.calls.every(call => !/\/tools|\/execute|\/tool_router/u.test(call.path)));
    console.log('PASS actual SQL Agent extension connection options: no fake Agent; prospective/target-only Use and package Manage separation; finite Use-only slots; exact published alternatives; bounded context cursor; no probes before explicit profile; sealed A/B accounts; late actual profile/Agent/source revocation; no business/tool/external IO.');
  } catch (error) {
    console.error(`FAIL Agent extension connection options at ${stage}`); throw error;
  } finally {
    loader._load = previousLoad;
    globalThis.fetch = providerFetch;
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await provider.close(); await fixture.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
