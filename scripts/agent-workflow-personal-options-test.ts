import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';
import { startIntegrationToolBrowserProvider, BROWSER_MCP_TOOL } from './fixtures/integration-tool-browser-provider';
import type { IntegrationToolPage, IntegrationToolSchema } from '../app/lib/integration-tools/contracts';
import type { AgentWorkflowPackageConfiguration } from '../app/lib/agents/workflow-contracts';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-workflow-options-'));
  const database = await createPiTestDatabase(), sql = await database.openDb();
  const provider = await createComposioProviderFixture(), mcp = await startIntegrationToolBrowserProvider();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const instanceId = `workflow-options-${randomUUID()}`, organizationId = 'workflow-options-org';
  const claims = { sub: instanceId, instanceId, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'managed', status: 'active',
    protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'options-fixture-license', hostingMode: 'cloud', edition: 'team',
    licenseClass: 'commercial', licenseEnvironment: 'production', seatLimit: 10, nonBillable: false, entitlementsVersion: 1,
    deploymentMode: 'managed-team', databaseProvider: 'postgres', vectorProvider: 'pgvector', postgresRequired: true,
    capabilities: { teamWorkspace: true, multiUser: true, vectorSearch: true }, features: { teamWorkspace: true, multiUser: true }, quotas: { users: 10 },
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const encoded = [JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) }), JSON.stringify(claims)].map(value => Buffer.from(value).toString('base64url')).join('.');
  const env = { DATA: root, CANVAS_DATA_ROOT: root, DATABASE_URL: 'postgresql://127.0.0.1:1/isolated_options_fixture',
    CANVAS_INSTANCE_ID: instanceId, CANVAS_ORGANIZATION_ID: organizationId, CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
    CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_INSTANCE_TOKEN: '', CANVAS_LICENSE_CERT: `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), privateKey).toString('base64url')}`,
    CANVAS_LICENSE_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(), CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS: fingerprint,
    CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', COMPOSIO_BASE_URL: provider.baseUrl, COMPOSIO_API_KEY: '',
    MCP_ALLOW_PRIVATE_NETWORK: 'true', MCP_ALLOW_INSECURE_HTTP: 'true', MCP_ALLOW_STDIO: 'false', CANVAS_MCP_DIRECT_ENABLED: 'true',
    INTEGRATIONS_ENV_MASTER_KEY: randomUUID() + randomUUID(), AUTH_SECRET: randomUUID() + randomUUID(), QMD_ENABLED: 'false',
    BASE_URL: 'http://localhost:3000', BETTER_AUTH_BASE_URL: 'http://localhost:3000' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const modules = new Map<string, unknown>();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown }, original = loader._load;
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return database;
    if (modules.has(name)) return modules.get(name);
    return original(name, parent, isMain);
  };
  let closeMcp: (() => Promise<void>) | undefined;
  try {
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) modules.set(name, await import(name));
    for (const id of ['owner', 'alice', 'bob']) {
      await sql.run('INSERT INTO "user"(id,name,email,role,email_verified,banned,created_at,updated_at) VALUES($1,$1,$2,$3,1,0,1,1)', [id, `${id}@options.example.test`, id === 'owner' ? 'admin' : 'user']);
    }
    await sql.run("INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES($1,'owner','team',1,1,1)", [organizationId]);
    for (const id of ['owner', 'alice', 'bob']) {
      await sql.run("INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES($1,$2,$3,'active',$4,1,1)", [organizationId, id, id === 'owner' ? 'owner' : 'member', Number(id === 'owner')]);
      await sql.run("INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',$6,$6,$6,$6)", [`seat-${id}`, organizationId, `${id}@options.example.test`, id, id === 'owner' ? 'owner' : 'member', Date.now()]);
      await sql.run("INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES($1,$2,'personal',$3,$4,$3,'active',1,1)", [`personal-${id}`, organizationId, id, `workspaces/${id}/files`]);
    }
    const owner = { userId: 'owner', workspaceId: 'personal-owner' }, alice = { userId: 'alice', workspaceId: 'personal-alice' };
    assert.equal((await (await import('../app/lib/license/seat-limit')).assertUserSeatAccess({ userId: 'alice' })).mode, 'team');
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'inert-options-key' }], { secretScope: 'legacy' });
    const { createComposioProfile, ensureDefaultComposioProfile, renameComposioProfile } = await import('../app/lib/composio/composio-profiles');
    const alpha = await createComposioProfile({ ownerUserId: 'alice', name: 'Alpha design' }), beta = await createComposioProfile({ ownerUserId: 'alice', name: 'Beta design' });
    const foreign = await ensureDefaultComposioProfile('bob');
    provider.accounts.set(alpha.composioUserId, [{ id: 'ALPHA_A', toolkit: 'canva', status: 'ACTIVE' }, { id: 'ALPHA_B', toolkit: 'canva', status: 'ACTIVE' },
      { id: 'ALPHA_PENDING', toolkit: 'canva', status: 'INITIATED' }, { id: 'UNDECLARED_SLACK', toolkit: 'slack', status: 'ACTIVE' }]);
    provider.accounts.set(beta.composioUserId, [{ id: 'BETA_A', toolkit: 'canva', status: 'ACTIVE' }]);
    provider.accounts.set(foreign.composioUserId, [{ id: 'FOREIGN_A', toolkit: 'canva', status: 'ACTIVE' }]);
    const definitions = await import('../app/lib/mcp/server-definitions');
    const allowedDefinition = await definitions.publishMcpServerDefinition(organizationId, 'Approved design', { url: mcp.mcpUrl, auth: 'none' });
    const forbiddenDefinition = await definitions.publishMcpServerDefinition(organizationId, 'Unlisted design', { url: mcp.mcpUrl, auth: 'none' });
    const { createPersonalMcpConnection } = await import('../app/lib/mcp/personal-connections');
    const ownMcp = await createPersonalMcpConnection('alice', allowedDefinition.id, 'Alice approved design');
    await createPersonalMcpConnection('alice', forbiddenDefinition.id, 'Alice unlisted design');
    await createPersonalMcpConnection('bob', allowedDefinition.id, 'Bob private design');
    const shared = await (await import('../app/lib/mcp/shared-connections')).createSharedMcpConnection(owner, {
      ownership: { type: 'organization', organizationId }, displayName: 'Fixed central design', config: { url: mcp.mcpUrl, auth: 'none' }, secrets: [],
      grants: [{ targetType: 'user', targetId: 'owner', canUse: true, canManage: true, allowedToolNames: null },
        { targetType: 'user', targetId: 'alice', canUse: true, canManage: false, allowedToolNames: null }], allowedToolNames: [BROWSER_MCP_TOOL] });
    closeMcp = (await import('../app/lib/mcp/manager')).closeAllMcpServers;
    const pluginRoot = path.join(root, 'source', 'workflow-options');
    await fs.mkdir(path.join(pluginRoot, '.canvas-plugin'), { recursive: true });
    await fs.mkdir(path.join(pluginRoot, 'skills', 'workflow-choice'), { recursive: true });
    await fs.writeFile(path.join(pluginRoot, 'skills', 'workflow-choice', 'SKILL.md'), '---\nname: workflow-choice\ndescription: Use the permitted personal design connection.\nmetadata:\n  version: "1.0.0"\n---\n\nUse the configured workflow.\n');
    await fs.writeFile(path.join(pluginRoot, '.canvas-plugin/plugin.json'), JSON.stringify({ name: 'workflow-options', version: '1.0.0', description: 'Controlled user choices',
      connectors: { mcp: [{ name: 'design', required: false }] }, workflow: { version: 1, integrationCapabilities: [
        { id: 'assets', application: 'canva', required: false, alternatives: [{ source: 'composio', toolkit: 'canva', requiredTools: ['ASSET_LOOKUP'] }, { source: 'mcp', connector: 'design', requiredTools: [BROWSER_MCP_TOOL] }] },
        { id: 'fixed', application: 'canva', required: false, alternatives: [{ source: 'mcp', connector: 'design', requiredTools: [BROWSER_MCP_TOOL] }] },
      ] } }));
    const installed = await (await import('../app/lib/plugins/canvas-plugin-registry')).installCanvasPluginFromPath(pluginRoot, {
      scope: { scopeType: 'organization', organizationId }, installedBy: 'owner', enable: true });
    assert(installed.success && installed.plugin?.resourceId, installed.error || 'Actual plugin must install.');
    const resources = await import('../app/lib/capabilities/resources/actions');
    const resource = await resources.configureCapabilityResource(owner, installed.plugin.resourceId, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      ownership: { type: 'organization' }, accessMode: 'restricted', grants: [{ targetType: 'user', targetId: 'owner', canUse: true, canEdit: true, canManage: true },
        { targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false }] });
    const packages = await import('../app/lib/capabilities/packages/actions'), ref = resource.metadata.resourceRef;
    const inspected = await packages.inspectCapabilityPackage(owner, ref);
    const draft = await packages.createCapabilityPackageDraftAction(owner, { operation: 'edit', resourceRef: ref,
      expectedMetadataRevision: inspected.resource.metadataRevision, expectedGrantsRevision: inspected.resource.grantsRevision,
      expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    const published = await packages.publishCapabilityPackageDraftAction(owner, { draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision,
      expectedMetadataRevision: inspected.resource.metadataRevision, expectedGrantsRevision: inspected.resource.grantsRevision,
      expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    const agentActions = await import('../app/lib/agents/management-actions'), agents = await import('../app/lib/agents/registry');
    await agentActions.createManagedAgent(owner, { agentId: 'workflow-options-agent', name: 'Workflow options agent', scopeType: 'organization',
      enabledTools: ['mcp', 'COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'composio_execute'] });
    let profile = (await agents.getAgentProfile('workflow-options-agent'))!;
    await agentActions.setManagedAgentGrant({ actor: owner, agentId: profile.agentId, expectedRevision: profile.revision, targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false });
    profile = (await agents.getAgentProfile(profile.agentId))!;
    const workflow = await import('../app/lib/agents/workflow-configuration');
    const configuredPackage: AgentWorkflowPackageConfiguration = { resourceRef: ref, publishedRevisionRef: published.published.revisionRef, checksum: published.published.checksum,
      skillSelection: { kind: 'plugin' }, declarations: [{ declarationPath: '.canvas-plugin/plugin.json', capabilities: [
        { capabilityId: 'assets', selection: { mode: 'selectable', allowedChoices: [], personalPolicy: { sources: ['composio', 'mcp'],
          alternativeKeys: ['composio:canva', 'mcp:design'], toolCap: ['ASSET_LOOKUP', BROWSER_MCP_TOOL], mcpDefinitionMappings: [{ connector: 'design', serverDefinitionIds: [allowedDefinition.id] }] } } },
        { capabilityId: 'fixed', selection: { mode: 'fixed', alternativeKey: 'mcp:design', toolCap: [BROWSER_MCP_TOOL],
          target: { kind: 'shared', source: 'mcp', connectionRef: shared.resource.connectionRef, bindingRevision: shared.resource.bindingRevision, mcpMapping: { kind: 'manager_confirmation' } } } },
      ] }] };
    await workflow.updateManagedAgentConfiguration({ actor: owner, agentId: profile.agentId, expectedRevision: profile.revision, expectedWorkflowRevision: 0,
      workflow: { version: 1, packages: [configuredPackage] } });
    const { agentWorkflowCapabilityKey } = await import('../app/lib/agents/workflow-contracts');
    const capabilityKey = agentWorkflowCapabilityKey(ref, '.canvas-plugin/plugin.json', 'assets'), fixedKey = agentWorkflowCapabilityKey(ref, '.canvas-plugin/plugin.json', 'fixed');
    const options = await import('../app/lib/agents/workflow-personal-options');
    const request = { agentId: profile.agentId, capabilityKey };
    const counts = () => [provider.calls.length, mcp.calls().requests];
    const beforeMetadata = counts(), metadata = await options.listAgentWorkflowPersonalOptions(alice, request);
    assert.deepEqual(counts(), beforeMetadata, 'Metadata discovery performs no SDK or MCP request.');
    const canvaProviders = metadata.alternatives.find(alternative => alternative.alternativeKey === 'composio:canva')!.providers;
    const alphaOption = canvaProviders.find(option => option.profileLabel === alpha.name)!, betaOption = canvaProviders.find(option => option.profileLabel === beta.name)!;
    assert(alphaOption && betaOption && alphaOption.providerRef !== betaOption.providerRef);
    const mcpOptions = metadata.alternatives.find(alternative => alternative.alternativeKey === 'mcp:design')!.providers;
    assert.equal(mcpOptions.length, 1); assert.equal(mcpOptions[0].label, 'Alice approved design');
    for (const secret of [alpha.id, beta.id, foreign.id, alpha.composioUserId, foreign.composioUserId, ownMcp.connectionId, allowedDefinition.id, mcp.mcpUrl, 'inert-options-key']) assert(!JSON.stringify(metadata).includes(secret));
    const denied = [{ ...request, alternativeKey: 'composio:slack' }, { ...request, alternativeKey: 'composio:github' },
      { ...request, capabilityKey: fixedKey }, { ...request, capabilityKey: 'unknown' }, { ...request, expectedWorkflowRevision: metadata.workflowRevision + 1 },
      { ...request, alternativeKey: 'composio:canva', providerRef: 'composio:v1:foreign' }];
    const beforeDenied = counts();
    for (const input of denied) await assert.rejects(() => options.listAgentWorkflowPersonalOptions(alice, input));
    await assert.rejects(() => options.listAgentWorkflowPersonalOptions({ userId: 'bob', workspaceId: 'personal-bob' }, request), { code: 'AGENT_ACCESS_DENIED' });
    assert.deepEqual(counts(), beforeDenied, 'Capability/source/policy/fixed/foreign/stale discovery denies before provider I/O.');
    const selectedRequest = { ...request, alternativeKey: 'composio:canva', providerRef: alphaOption.providerRef, expectedWorkflowRevision: metadata.workflowRevision };
    const beforeSelected = provider.calls.length, selected = await options.listAgentWorkflowPersonalOptions(alice, selectedRequest);
    const accountOption = selected.alternatives[0].providers[0];
    assert.equal(accountOption.accounts?.length, 3); assert.equal(accountOption.accounts.filter(account => account.selectable).length, 2);
    const selectedCalls = provider.calls.slice(beforeSelected);
    assert.equal(selectedCalls.filter(call => call.path === '/api/v3.1/toolkits').length, 1);
    assert(selectedCalls.filter(call => call.path === '/api/v3.1/connected_accounts').every(call => call.userId === alpha.composioUserId && call.toolkitSlugs === 'canva'));
    assert(selectedCalls.every(call => ['/api/v3.1/toolkits', '/api/v3.1/connected_accounts'].includes(call.path)));
    for (const value of ['ALPHA_A', 'ALPHA_B', 'ALPHA_PENDING', 'UNDECLARED_SLACK', 'FOREIGN_A', alpha.id, alpha.composioUserId, 'inert-options-key']) assert(!JSON.stringify(selected).includes(value));
    const chosenAccount = accountOption.accounts.filter(account => account.selectable)[1].accountSelectionRef;
    const beforeSet = provider.calls.length;
    const saved = await workflow.setManagedAgentWorkflowChoice({ actor: alice, ...request, expectedWorkflowRevision: metadata.workflowRevision,
      expectedPreferenceRevision: metadata.preferenceRevision, personalSelection: { alternativeKey: 'composio:canva', target: { kind: 'personal', source: 'composio', ownerUserId: 'alice',
        providerRef: alphaOption.providerRef, accountSelectionRef: chosenAccount } } });
    assert.equal(saved.preferenceRevision, metadata.preferenceRevision + 1);
    assert(provider.calls.slice(beforeSet).filter(call => call.path === '/api/v3.1/connected_accounts').every(call => call.userId === alpha.composioUserId && call.toolkitSlugs === 'canva'), 'Saving stays on the declared profile/app.');
    const { piSessions } = await import('../app/lib/db/schema');
    await database.db.insert(piSessions).values({ sessionId: 'workflow-options-session', userId: 'alice', agentId: profile.agentId, workspaceId: 'personal-alice', workspaceType: 'personal',
      organizationId, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const execution = await (await import('../app/lib/pi/session-workspace-context')).resolveAgentExecutionContextForStoredSession({ userId: 'alice', sessionId: 'workflow-options-session', agentId: profile.agentId });
    const { UNRESTRICTED_INTEGRATION_POLICY } = await import('../app/lib/integration-tools/policy');
    const policy = await (await import('../app/lib/integration-tools/runtime-policy')).resolveIntegrationRuntimePolicy({ executionContext: execution, ceiling: UNRESTRICTED_INTEGRATION_POLICY });
    const context = { actorUserId: 'alice', organizationId, workspaceId: execution.workspaceId, agentId: execution.agentId, sessionId: execution.sessionId, policyRevision: policy.policyRevision };
    (await import('../app/lib/agents/workflow-runtime')).attachAgentWorkflowRuntimeProjection(context, policy.workflowProjection);
    const dispatcher = new (await import('../app/lib/integration-tools/dispatcher')).IntegrationDispatcher();
    const bound = policy.policy.providerToolRules!.find(rule => rule.source === 'composio')!.providerRef;
    const run = (input: unknown) => dispatcher.execute({ context, policy: policy.policy, request: input, toolCallId: 'actual-own-choice' });
    const tools = await run({ action: 'list', target: 'tools', providerRef: bound }) as IntegrationToolPage;
    const schema = await run({ action: 'describe', toolRef: tools.tools[0].toolRef }) as IntegrationToolSchema;
    await run({ action: 'call', toolRef: schema.toolRef, schemaRef: schema.schemaRef, arguments: { folder_id: 'Chosen account assets' } });
    assert.equal(provider.calls.filter(call => call.path.includes('/tools/execute/')).at(-1)!.body.connected_account_id, 'ALPHA_B');
    provider.rotateOnEndpoint('/api/v3.1/connected_accounts', async () => { await renameComposioProfile({ ownerUserId: 'alice', profileId: alpha.id, name: 'Renamed during discovery' }); });
    await assert.rejects(() => options.listAgentWorkflowPersonalOptions(alice, selectedRequest), error => Boolean(error && typeof error === 'object' && ['AGENT_WORKFLOW_REVISION_CONFLICT', 'AGENT_WORKFLOW_OPTIONS_UNAVAILABLE'].includes(Reflect.get(error, 'code'))));
    provider.rotateOnEndpoint('/api/v3.1/connected_accounts', async () => {
      const current = (await agents.getAgentProfile(profile.agentId))!;
      await agentActions.setManagedAgentGrant({ actor: owner, agentId: profile.agentId, expectedRevision: current.revision, targetType: 'user', targetId: 'alice', canUse: false, canEdit: false, canManage: false });
    });
    await assert.rejects(() => options.listAgentWorkflowPersonalOptions(alice, { ...request, alternativeKey: 'composio:canva', providerRef: betaOption.providerRef }), { code: 'AGENT_ACCESS_DENIED' });
    const afterRevoke = counts();
    await assert.rejects(() => options.listAgentWorkflowPersonalOptions(alice, request), { code: 'AGENT_ACCESS_DENIED' });
    assert.deepEqual(counts(), afterRevoke, 'Fresh revoked use denies even metadata discovery before SDK.');
    await (await import('../app/lib/auth')).ensureAuthReady();
    console.log('agent-workflow-personal-options-test: PASS (actual licensed PGlite actor/grants + published package/config; 0-I/O policy-first discovery; approved own MCP mapping; exact own profile/app sealed multi-account choices; actual setter/dispatcher SDK binding; post-await profile/rights revoke)');
  } finally {
    await closeMcp?.(); loader._load = original; await provider.close(); await mcp.close(); await database.close();
    async function writable(directory: string): Promise<void> {
      await fs.chmod(directory, 0o700);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(directory, entry.name));
    }
    await writable(root); await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
