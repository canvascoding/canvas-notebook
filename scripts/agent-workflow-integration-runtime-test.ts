import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';
import { startIntegrationToolBrowserProvider, BROWSER_MCP_TOOL } from './fixtures/integration-tool-browser-provider';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { IntegrationProviderPage, IntegrationToolPage, IntegrationToolSchema } from '../app/lib/integration-tools/contracts';
import type { AgentWorkflowPackageConfiguration } from '../app/lib/agents/workflow-contracts';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft } from '../app/lib/capabilities/packages/contracts';
import type { AgentExtensionConfigurationInput } from '../app/lib/capabilities/extensions/contracts';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-workflow-integration-'));
  const database = await createPiTestDatabase(), raw = await database.openDb();
  const composio = await createComposioProviderFixture(), mcp = await startIntegrationToolBrowserProvider();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const instanceId = `workflow-integration-${randomUUID()}`;
  const payload = { sub: instanceId, instanceId, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'managed', status: 'active',
    protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'workflow-fixture-license', hostingMode: 'cloud', edition: 'team',
    licenseClass: 'commercial', licenseEnvironment: 'production', seatLimit: 10, nonBillable: false, entitlementsVersion: 1,
    deploymentMode: 'managed-team', databaseProvider: 'postgres', vectorProvider: 'pgvector', postgresRequired: true,
    capabilities: { teamWorkspace: true, multiUser: true, vectorSearch: true }, features: { teamWorkspace: true, multiUser: true },
    quotas: { users: 10 }, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const encoded = [JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) }), JSON.stringify(payload)]
    .map(value => Buffer.from(value).toString('base64url')).join('.');
  const certificate = `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), privateKey).toString('base64url')}`;
  const env = { DATA: root, CANVAS_DATA_ROOT: root, DATABASE_URL: 'postgresql://127.0.0.1:1/isolated_workflow_fixture',
    CANVAS_ORGANIZATION_ID: 'workflow-integration-org', CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
    CANVAS_INSTANCE_ID: instanceId, CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_INSTANCE_TOKEN: '',
    CANVAS_LICENSE_CERT: certificate, CANVAS_LICENSE_PUBLIC_KEY: publicPem, CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS: fingerprint,
    CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', COMPOSIO_BASE_URL: composio.baseUrl, COMPOSIO_API_KEY: '',
    CANVAS_MCP_DIRECT_ENABLED: 'true', MCP_ALLOW_PRIVATE_NETWORK: 'true', MCP_ALLOW_INSECURE_HTTP: 'true', MCP_ALLOW_STDIO: 'false',
    INTEGRATIONS_ENV_MASTER_KEY: randomUUID() + randomUUID(), AUTH_SECRET: randomUUID() + randomUUID(), QMD_ENABLED: 'false',
    BASE_URL: 'http://localhost:3000', BETTER_AUTH_BASE_URL: 'http://localhost:3000' };
  const oldEnvironment = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const modules = new Map<string, unknown>();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return database;
    if (modules.has(name)) return modules.get(name);
    return original(name, parent, isMain);
  };
  let closeMcp: (() => Promise<void>) | undefined;
  try {
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) modules.set(name, await import(name));
    const org = 'workflow-integration-org';
    for (const id of ['owner', 'alice', 'bob']) {
      await raw.run('INSERT INTO "user" (id,name,email,role,email_verified,banned,created_at,updated_at) VALUES($1,$1,$2,$3,1,0,1,1)', [id, `${id}@workflow-integration.example.test`, id === 'owner' ? 'admin' : 'user']);
    }
    await raw.run("INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES($1,'owner','team',1,1,1)", [org]);
    for (const id of ['owner', 'alice', 'bob']) {
      await raw.run("INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES($1,$2,$3,'active',$4,1,1)", [org, id, id === 'owner' ? 'owner' : 'member', Number(id === 'owner')]);
      await raw.run("INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',$6,$6,$6,$6)", [`seat-${id}`, org, `${id}@workflow-integration.example.test`, id, id === 'owner' ? 'owner' : 'member', Date.now()]);
      await raw.run("INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES($1,$2,'personal',$3,$4,$3,'active',1,1)", [`personal-${id}`, org, id, `workspaces/${id}/files`]);
    }
    await raw.run("INSERT INTO canvas_workspaces(id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES('workflow-team',$1,'team','workspaces/workflow-team/files','Workflow team','active',1,1)", [org]);
    const { getLicenseStatus } = await import('../app/lib/license');
    const license = await getLicenseStatus(); assert(license.licensed); assert.equal(license.edition, 'team');
    const { assertUserSeatAccess } = await import('../app/lib/license/seat-limit');
    assert.equal((await assertUserSeatAccess({ userId: 'alice' })).mode, 'team');
    const owner = { userId: 'owner', workspaceId: 'personal-owner' }, alice = { userId: 'alice', workspaceId: 'personal-alice' }, bob = { userId: 'bob', workspaceId: 'personal-bob' };
    const { patchUnifiedEnvEntries } = await import('../app/lib/secrets/unified-env-store');
    await patchUnifiedEnvEntries([{ key: 'COMPOSIO_API_KEY', value: 'inert-shared-workflow-key' }], { secretScope: 'organization', organizationId: org });
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'inert-personal-workflow-key' }], { secretScope: 'legacy' });
    const { createSharedComposioProfile } = await import('../app/lib/composio/composio-shared-profiles');
    const sharedProfile = await createSharedComposioProfile({ actor: owner, ownership: { type: 'organization', organizationId: org }, name: 'Shared design', providerMode: 'local' });
    composio.accounts.set(sharedProfile.composioUserId, [{ id: 'SHARED_CANVA_A', toolkit: 'canva', status: 'ACTIVE' },
      { id: 'SHARED_CANVA_B', toolkit: 'canva', status: 'ACTIVE' }, { id: 'SHARED_SLACK', toolkit: 'slack', status: 'ACTIVE' }]);
    const connections = await import('../app/lib/integration-tools/connections/store');
    const grants = [{ targetType: 'user' as const, targetId: 'owner', canUse: true, canManage: true, allowedToolNames: null },
      { targetType: 'user' as const, targetId: 'alice', canUse: true, canManage: false, allowedToolNames: null },
      { targetType: 'user' as const, targetId: 'bob', canUse: true, canManage: false, allowedToolNames: null }];
    const createComposio = (toolkit: string, account: string, names: string[]) => connections.createSharedIntegrationConnection(owner, {
      ownership: { type: 'organization', organizationId: org }, displayName: `Shared ${toolkit} ${account.endsWith('_B') ? 'B' : 'A'}`, grants, allowedToolNames: names,
      backend: { source: 'composio', profileId: sharedProfile.id, toolkit, mode: 'local', accountBinding: 'account', connectedAccountId: account } });
    const canvaA = await createComposio('canva', 'SHARED_CANVA_A', ['ASSET_LOOKUP', 'DESIGN_CREATE', 'MISSING_REQUIRED_TOOL']);
    const canvaB = await createComposio('canva', 'SHARED_CANVA_B', ['ASSET_LOOKUP', 'DESIGN_CREATE', 'MISSING_REQUIRED_TOOL']);
    const slack = await createComposio('slack', 'SHARED_SLACK', ['CHANNEL_POST']);
    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const sharedMcp = await createSharedMcpConnection(owner, { ownership: { type: 'team', organizationId: org, workspaceId: 'workflow-team' },
      displayName: 'Fixed team design MCP', allowedToolNames: [BROWSER_MCP_TOOL], grants, config: { url: mcp.mcpUrl, auth: 'none' }, secrets: [] });
    closeMcp = (await import('../app/lib/mcp/manager')).closeAllMcpServers;
    const registry = await import('../app/lib/plugins/canvas-plugin-registry');
    const resources = await import('../app/lib/capabilities/resources/actions');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const agents = await import('../app/lib/agents/registry');
    const agentActions = await import('../app/lib/agents/management-actions');
    const workflow = await import('../app/lib/agents/workflow-configuration');
    const source = path.join(root, 'source', 'workflow-integration');
    const childRoot = 'skills/workflow-assets';
    await fs.mkdir(path.join(source, '.canvas-plugin'), { recursive: true }); await fs.mkdir(path.join(source, childRoot, 'agents'), { recursive: true });
    const childWorkflow = { version: 1, integrationCapabilities: [
      { id: 'assets', application: 'canva', required: true, alternatives: [{ source: 'composio', toolkit: 'canva', requiredTools: ['ASSET_LOOKUP'] },
        { source: 'mcp', connector: 'design-alternative', requiredTools: [BROWSER_MCP_TOOL] }] },
      { id: 'notify', application: 'slack', required: true, alternatives: [{ source: 'composio', toolkit: 'slack', requiredTools: ['CHANNEL_POST'] }] },
    ] };
    await fs.writeFile(path.join(source, '.canvas-plugin/plugin.json'), JSON.stringify({ name: 'workflow-integration', version: '1.0.0', description: 'Actual pinned integration workflow', skills: 'skills',
      connectors: { mcp: [{ name: 'design', required: false }, { name: 'design-alternative', required: false }] }, workflow: { version: 1, integrationCapabilities: [
        { id: 'design', application: 'canva', required: true, skillRefs: ['workflow-assets'], alternatives: [{ source: 'mcp', connector: 'design', requiredTools: [BROWSER_MCP_TOOL] }] },
      ] } }));
    await fs.writeFile(path.join(source, childRoot, 'SKILL.md'), '---\nname: workflow-assets\ndescription: Use the configured design and notification workflow.\nmetadata:\n  version: "1.0.0"\n---\n\nImmutable version-one context.\n');
    await fs.writeFile(path.join(source, childRoot, 'agents/canvas.yaml'), YAML.stringify({ workflow: childWorkflow }));
    const installed = await registry.installCanvasPluginFromPath(source, { scope: { scopeType: 'organization', organizationId: org }, installedBy: 'owner', enable: true });
    assert(installed.success && installed.plugin?.resourceId, installed.error || 'Actual plugin install failed.');
    const configured = await resources.configureCapabilityResource(owner, installed.plugin.resourceId, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      ownership: { type: 'organization' }, accessMode: 'restricted', grants: [{ targetType: 'user', targetId: 'owner', canUse: true, canEdit: true, canManage: true },
        { targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false },
        { targetType: 'user', targetId: 'bob', canUse: true, canEdit: false, canManage: false }] });
    const ref = configured.metadata.resourceRef;
    assert.equal(configured.access.canRead, true, 'Actual configured resource authority must be readable.');
    assert.equal((await resources.inspectCapabilityResource(owner, ref)).access.canRead, true, 'Fresh resource inspection must remain readable.');
    const { loadCapabilityCandidatesForResourceActor } = await import('../app/lib/capabilities/resources/read');
    const { assertCapabilityCandidateAccess } = await import('../app/lib/capabilities/resources/catalog-access');
    const diagnosticCandidates = await loadCapabilityCandidatesForResourceActor(owner);
    const diagnosticPlugin = diagnosticCandidates.find(candidate => candidate.resourceMetadata?.resourceRef === ref && candidate.ref.resourceType === 'plugin')!;
    assert(diagnosticPlugin);
    await assertCapabilityCandidateAccess(owner, diagnosticPlugin, 'canRead');
    const edit = (descriptor: CapabilityPackageDescriptor) => ({ operation: 'edit' as const, resourceRef: ref,
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
      expectedPackageRevision: descriptor.state?.packageRevision ?? 0, expectedPublishedRevisionRef: descriptor.state?.currentPublishedRevisionRef ?? null });
    const publish = (draft: CapabilityPackageDraft, descriptor: CapabilityPackageDescriptor) => ({ draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision,
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
      expectedPackageRevision: descriptor.state?.packageRevision ?? 0, expectedPublishedRevisionRef: descriptor.state?.currentPublishedRevisionRef ?? null });
    const inspected = await packages.inspectCapabilityPackage(owner, ref), draft = await packages.createCapabilityPackageDraftAction(owner, edit(inspected));
    const v1 = await packages.publishCapabilityPackageDraftAction(owner, publish(draft, inspected));
    const enabledTools = ['read', 'mcp', 'COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'composio_execute', 'email_read_message', 'email_list_mailboxes', 'email_create_outbox_draft'];
    const createAgent = async (id: string) => {
      await agentActions.createManagedAgent(owner, { agentId: id, name: id, scopeType: 'organization', enabledTools });
      for (const userId of ['alice', 'bob']) {
        const profile = (await agents.getAgentProfile(id))!;
        await agentActions.setManagedAgentGrant({ actor: owner, agentId: id, expectedRevision: profile.revision, targetType: 'user', targetId: userId, canUse: true, canEdit: false, canManage: false });
      }
    };
    for (const id of ['workflow-main', 'workflow-empty', 'workflow-missing']) await createAgent(id);
    const sharedTarget = (source: 'mcp' | 'composio', connection: typeof canvaA) => ({ kind: 'shared' as const, source,
      connectionRef: connection.resource.connectionRef, bindingRevision: connection.resource.bindingRevision });
    const basePackage: AgentWorkflowPackageConfiguration = { resourceRef: ref, publishedRevisionRef: v1.published.revisionRef, checksum: v1.published.checksum,
      skillSelection: { kind: 'plugin' }, declarations: [
        { declarationPath: '.canvas-plugin/plugin.json', capabilities: [{ capabilityId: 'design', selection: { mode: 'fixed', alternativeKey: 'mcp:design',
          target: { ...sharedTarget('mcp', sharedMcp), mcpMapping: { kind: 'manager_confirmation' } }, toolCap: [BROWSER_MCP_TOOL] } }] },
        { declarationPath: `${childRoot}/agents/canvas.yaml`, capabilities: [
          { capabilityId: 'assets', selection: { mode: 'selectable', allowedChoices: [
            { choiceId: 'canva-a', alternativeKey: 'composio:canva', target: sharedTarget('composio', canvaA), toolCap: ['ASSET_LOOKUP'] },
            { choiceId: 'canva-b', alternativeKey: 'composio:canva', target: sharedTarget('composio', canvaB), toolCap: ['ASSET_LOOKUP'] },
          ], defaultChoiceId: 'canva-a', personalPolicy: { sources: ['composio'], alternativeKeys: ['composio:canva'], toolCap: ['ASSET_LOOKUP'] } } },
          { capabilityId: 'notify', selection: { mode: 'fixed', alternativeKey: 'composio:slack', target: sharedTarget('composio', slack), toolCap: ['CHANNEL_POST'] } },
        ] },
      ] };
    const extensionConfiguration = (packagesInput: AgentWorkflowPackageConfiguration[]): AgentExtensionConfigurationInput => ({
      version: 1, origin: 'agent_configuration', mode: 'fixed',
      selections: packagesInput.map(pkg => ({ selection: { kind: 'plugin', package: { resourceRef: pkg.resourceRef,
        publishedRevisionRef: pkg.publishedRevisionRef, checksum: pkg.checksum }, skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: null })),
      workflow: { version: 1, packages: packagesInput }, standalone: [],
    });
    const configure = async (id: string, packagesInput: AgentWorkflowPackageConfiguration[]) => {
      const current = (await agents.getAgentProfile(id))!;
      return workflow.updateManagedAgentConfiguration({ actor: owner, agentId: id, expectedRevision: current.revision,
        expectedWorkflowRevision: current.workflowRevision ?? 0, extensions: extensionConfiguration(packagesInput) });
    };
    await configure('workflow-main', [basePackage]); await configure('workflow-empty', []);
    const beforeExcluded = await workflow.readManagedAgentWorkflow(owner, 'workflow-main');
    assert.equal(beforeExcluded.workflowVersion, 2);
    const excludedRequirement = structuredClone(basePackage);
    const excludedSelection = excludedRequirement.declarations[0].capabilities[0].selection;
    assert(excludedSelection.mode === 'fixed'); excludedSelection.toolCap = [];
    // V2 validates the private wrapper's requiredTools subset before the write transaction.
    await assert.rejects(() => configure('workflow-main', [excludedRequirement]), { code: 'AGENT_WORKFLOW_CORRUPT' });
    assert.equal((await agents.getAgentProfile('workflow-main'))!.revision, beforeExcluded.agent.revision);
    const currentAgent = (await agents.getAgentProfile('workflow-main'))!;
    await assert.rejects(() => workflow.updateManagedAgentConfiguration({ actor: alice, agentId: currentAgent.agentId, expectedRevision: currentAgent.revision,
      expectedWorkflowRevision: currentAgent.workflowRevision!, extensions: extensionConfiguration([]) }), { code: 'AGENT_ACCESS_DENIED' });
    assert.equal((await agents.getAgentProfile('workflow-main'))!.revision, currentAgent.revision);
    const { piSessions } = await import('../app/lib/db/schema');
    for (const id of ['workflow-main', 'workflow-empty', 'workflow-missing']) await database.db.insert(piSessions).values({ sessionId: `${id}-session`, userId: 'alice', agentId: id,
      workspaceId: 'personal-alice', workspaceType: 'personal', organizationId: org, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    await database.db.insert(piSessions).values({ sessionId: 'workflow-main-bob-session', userId: 'bob', agentId: 'workflow-main',
      workspaceId: 'personal-bob', workspaceType: 'personal', organizationId: org, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
    const fresh = (id = 'workflow-main') => resolveAgentExecutionContextForStoredSession({ userId: 'alice', agentId: id, sessionId: `${id}-session` });
    const { serverPreferencesPath } = await import('../app/lib/terminal-policy');
    await fs.mkdir(path.dirname(serverPreferencesPath()), { recursive: true }); await fs.writeFile(serverPreferencesPath(), JSON.stringify({ settings: { integrationToolGatewayEnabled: true } }));
    const { getPiTools } = await import('../app/lib/pi/tool-registry');
    const { isIntegrationGatewayTool } = await import('../app/lib/pi/integration-tool-gateway');
    const { getProgressiveGatewayCapabilityNames } = await import('../app/lib/pi/progressive-tool-gateway');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { resolveIntegrationRuntimePolicy } = await import('../app/lib/integration-tools/runtime-policy');
    const { resolveIntegrationAuthorizationContext } = await import('../app/lib/integration-tools/context');
    const { attachAgentWorkflowRuntimeProjection, assertAgentWorkflowRuntimeReady } = await import('../app/lib/agents/workflow-runtime');
    const { UNRESTRICTED_INTEGRATION_POLICY } = await import('../app/lib/integration-tools/policy');
    const counts = () => [composio.calls.length, mcp.calls().requests, composio.calls.filter(call => call.path.includes('/tools/execute/')).length, mcp.calls().executions.length];
    const beforeContext = counts();
    const initialContext = await fresh();
    assert.equal(initialContext.skillPackageBindings?.[0].publishedRevisionRef, v1.published.revisionRef);
    const initialAuthorization = await resolveIntegrationAuthorizationContext({ actorUserId: 'alice', sessionId: 'workflow-main-session',
      agentId: 'workflow-main', policyRevision: 'workflow-authorization-fixture' });
    assert.deepEqual(initialAuthorization.executionContext.skillReadRoots, []);
    assert.deepEqual(initialAuthorization.executionContext.skillPackageBindings, []);
    const initialAuthorizationPolicy = await resolveIntegrationRuntimePolicy({ executionContext: initialAuthorization.executionContext, ceiling: UNRESTRICTED_INTEGRATION_POLICY });
    const initialFullPolicy = await resolveIntegrationRuntimePolicy({ executionContext: initialContext, ceiling: UNRESTRICTED_INTEGRATION_POLICY });
    assert(initialAuthorizationPolicy.workflowProjection);
    assert.deepEqual(initialAuthorizationPolicy.policy, initialFullPolicy.policy);
    assert.equal(initialAuthorizationPolicy.policyRevision, initialFullPolicy.policyRevision,
      'Empty prompt roots retain the fresh WF1 package, connection and preference fingerprint.');
    for (const options of [{ planningMode: true }, { workspaceEmailAutomation: { userId: 'alice', workspaceId: 'personal-alice', agentId: 'workflow-main',
      eventId: 'fixture-event', mailboxId: 'fixture-mailbox', providerMessageId: 'fixture-message', providerThreadId: null, folder: 'INBOX', automationJobId: 'fixture-job', automationRunId: 'fixture-run' } }]) {
      await getPiTools('alice', 'workflow-main', 'workflow-main-session', { executionContext: initialContext, strictAuthorization: true, ...options });
    }
    assert.deepEqual(counts(), beforeContext, 'Fresh context, planning and email-event registry construction perform zero provider metadata or SDK requests.');
    const tools = await getPiTools('alice', 'workflow-main', 'workflow-main-session', { executionContext: initialContext, strictAuthorization: true, metadataOnlyExternal: true });
    assert.deepEqual(counts(), beforeContext);
    assert(!tools.some(tool => tool.name === 'mcp' || tool.name.startsWith('mcp_') || tool.name.startsWith('COMPOSIO_') || tool.name === 'composio_execute'));
    const nativeNames = getProgressiveGatewayCapabilityNames(tools); assert(nativeNames.includes('email_read_message')); assert(nativeNames.includes('email_create_outbox_draft'));
    const gateway = tools.find(isIntegrationGatewayTool)!; assert(gateway, 'An explicit workflow uses the central gateway.');
    const invoke = async (request: unknown, selectedGateway = gateway, id = 'workflow-main') => {
      const context: AgentExecutionContext = { ...await fresh(id), agentTurnId: 'workflow-integration-turn' };
      return runWithAgentExecutionContext(context, () => selectedGateway.execute('workflow-integration-fixture', request as never));
    };
    const details = <T,>(result: { details: unknown }): T => {
      const data = result.details as Record<string, unknown>; assert.equal(data.integrationError, undefined, JSON.stringify(data.integrationError)); return data as T;
    };
    const discover = async () => details<IntegrationProviderPage>(await invoke({ action: 'list', target: 'providers' }));
    const catalogue = await discover(); assert.equal(catalogue.providers.length, 3);
    assert(!JSON.stringify(catalogue).includes('SHARED_CANVA_A')); assert(!catalogue.providers.some(provider => provider.application === 'github'));
    const issued = new Map<string, IntegrationToolSchema>();
    for (const provider of catalogue.providers) {
      const list = details<IntegrationToolPage>(await invoke({ action: 'list', target: 'tools', providerRef: provider.providerRef }));
      const expected = provider.source === 'mcp' ? BROWSER_MCP_TOOL : provider.application === 'canva' ? 'ASSET_LOOKUP' : 'CHANNEL_POST';
      assert.deepEqual(list.tools.map(tool => tool.name), [expected], 'Each exact provider has its own permitted tools.');
      const schema = details<IntegrationToolSchema>(await invoke({ action: 'describe', toolRef: list.tools[0].toolRef })); issued.set(expected, schema);
      const argumentsValue = expected === BROWSER_MCP_TOOL ? { design_query: 'Workflow fixed MCP' } : expected === 'ASSET_LOOKUP' ? { folder_id: 'Workflow assets' } : { channel: 'designs', message: 'Workflow notification' };
      details(await invoke({ action: 'call', toolRef: schema.toolRef, schemaRef: schema.schemaRef, arguments: argumentsValue }));
    }
    assert(composio.calls.filter(call => call.path === '/api/v3.1/tools').every(call => ['ASSET_LOOKUP', 'CHANNEL_POST'].includes(call.toolNames || '')),
      'Provider finite pagination receives exact per-provider caps; requiredTools never broadens them.');
    const mainOptions = await workflow.inspectManagedAgentWorkflow(alice, 'workflow-main');
    const assets = mainOptions.packages[0].declarations.flatMap(declaration => declaration.capabilities).find(capability => capability.capabilityId === 'assets')!;
    const oldRuntime = await resolveIntegrationRuntimePolicy({ executionContext: await fresh(), ceiling: UNRESTRICTED_INTEGRATION_POLICY });
    const oldSchema = issued.get('ASSET_LOOKUP')!;
    await workflow.setManagedAgentWorkflowChoice({ actor: alice, agentId: 'workflow-main', capabilityKey: assets.capabilityKey,
      expectedWorkflowRevision: mainOptions.workflowRevision, expectedPreferenceRevision: mainOptions.preferenceRevision, choiceId: 'canva-b' });
    await assert.rejects(() => workflow.setManagedAgentWorkflowChoice({ actor: alice, agentId: 'workflow-main', capabilityKey: assets.capabilityKey,
      expectedWorkflowRevision: mainOptions.workflowRevision, expectedPreferenceRevision: mainOptions.preferenceRevision, choiceId: 'canva-a' }), { code: 'AGENT_WORKFLOW_CHOICE_REVISION_CONFLICT' });
    const newRuntime = await resolveIntegrationRuntimePolicy({ executionContext: await fresh(), ceiling: UNRESTRICTED_INTEGRATION_POLICY }); assert.notEqual(newRuntime.policyRevision, oldRuntime.policyRevision);
    const beforeStale = counts();
    const stale = (await invoke({ action: 'call', toolRef: oldSchema.toolRef, schemaRef: oldSchema.schemaRef, arguments: { folder_id: 'Stale' } })).details as { integrationError: { code: string } };
    assert(stale.integrationError); assert.deepEqual(counts(), beforeStale, 'A stale selected provider/schema is rejected before any required-provider readiness probe.');
    const updatedCatalogue = await discover(); const selectedCanva = updatedCatalogue.providers.find(provider => provider.application === 'canva')!;
    const updatedTools = details<IntegrationToolPage>(await invoke({ action: 'list', target: 'tools', providerRef: selectedCanva.providerRef }));
    let selectedSchema = details<IntegrationToolSchema>(await invoke({ action: 'describe', toolRef: updatedTools.tools[0].toolRef }));
    details(await invoke({ action: 'call', toolRef: selectedSchema.toolRef, schemaRef: selectedSchema.schemaRef, arguments: { folder_id: 'Second exact account' } }));
    assert.equal(composio.calls.filter(call => call.path.includes('/tools/execute/')).at(-1)!.body.connected_account_id, 'SHARED_CANVA_B');
    const { createComposioProfile, setComposioWorkspaceProfileOverride } = await import('../app/lib/composio/composio-profiles');
    const firstPersonal = await createComposioProfile({ ownerUserId: 'alice', name: 'User selected design' });
    const otherPersonal = await createComposioProfile({ ownerUserId: 'alice', name: 'Unrelated personal default' });
    composio.accounts.set(firstPersonal.composioUserId, [{ id: 'PERSONAL_EXACT_A', toolkit: 'canva', status: 'ACTIVE' }, { id: 'PERSONAL_EXACT_B', toolkit: 'canva', status: 'ACTIVE' }]);
    composio.accounts.set(otherPersonal.composioUserId, [{ id: 'PERSONAL_DEFAULT', toolkit: 'canva', status: 'ACTIVE' }]);
    const { createIntegrationProviderRef } = await import('../app/lib/integration-tools/references');
    const personalRef = createIntegrationProviderRef({ source: 'composio', profileId: firstPersonal.id, toolkit: 'canva', scope: { type: 'user', ownerUserId: 'alice', resourceId: `profile:${firstPersonal.id}:canva` } });
    const { listPersonalWorkflowProviderAccountChoices } = await import('../app/lib/integration-tools/workflow-personal-bindings');
    const personalChoices = await listPersonalWorkflowProviderAccountChoices({ actor: alice, providerRef: personalRef });
    const choiceState = await workflow.inspectManagedAgentWorkflow(alice, 'workflow-main');
    await workflow.setManagedAgentWorkflowChoice({ actor: alice, agentId: 'workflow-main', capabilityKey: assets.capabilityKey,
      expectedWorkflowRevision: choiceState.workflowRevision, expectedPreferenceRevision: choiceState.preferenceRevision,
      personalSelection: { alternativeKey: 'composio:canva', target: { kind: 'personal', source: 'composio', ownerUserId: 'alice', providerRef: personalRef, accountSelectionRef: personalChoices.accounts[1].accountSelectionRef } } });
    const personalCatalogue = await discover(); const personalCanva = personalCatalogue.providers.find(provider => provider.application === 'canva')!;
    assert(personalCanva.providerRef.includes(':personal:'));
    const personalTools = details<IntegrationToolPage>(await invoke({ action: 'list', target: 'tools', providerRef: personalCanva.providerRef }));
    selectedSchema = details<IntegrationToolSchema>(await invoke({ action: 'describe', toolRef: personalTools.tools[0].toolRef }));
    await setComposioWorkspaceProfileOverride({ userId: 'alice', workspaceId: 'personal-alice', profileId: otherPersonal.id });
    details(await invoke({ action: 'call', toolRef: selectedSchema.toolRef, schemaRef: selectedSchema.schemaRef, arguments: { folder_id: 'Explicit personal account' } }));
    assert.equal(composio.calls.filter(call => call.path.includes('/tools/execute/')).at(-1)!.body.connected_account_id, 'PERSONAL_EXACT_B');
    assert((await discover()).providers.some(provider => provider.source === 'mcp' && provider.providerRef === catalogue.providers.find(provider => provider.source === 'mcp')!.providerRef),
      'The fixed team MCP is unaffected by another personal Composio default.');
    const bobPersonal = await createComposioProfile({ ownerUserId: 'bob', name: 'Bob selected design' });
    const bobDefault = await createComposioProfile({ ownerUserId: 'bob', name: 'Bob unrelated default' });
    assert.notEqual(bobPersonal.id, firstPersonal.id); assert.notEqual(bobPersonal.composioUserId, firstPersonal.composioUserId);
    composio.accounts.set(bobPersonal.composioUserId, [{ id: 'PERSONAL_BOB_EXACT_A', toolkit: 'canva', status: 'ACTIVE' },
      { id: 'PERSONAL_BOB_EXACT_B', toolkit: 'canva', status: 'ACTIVE' }]);
    composio.accounts.set(bobDefault.composioUserId, [{ id: 'PERSONAL_BOB_DEFAULT', toolkit: 'canva', status: 'ACTIVE' }]);
    const bobRef = createIntegrationProviderRef({ source: 'composio', profileId: bobPersonal.id, toolkit: 'canva',
      scope: { type: 'user', ownerUserId: 'bob', resourceId: `profile:${bobPersonal.id}:canva` } });
    const bobChoices = await listPersonalWorkflowProviderAccountChoices({ actor: bob, providerRef: bobRef });
    const bobState = await workflow.inspectManagedAgentWorkflow(bob, 'workflow-main');
    const bobAssets = bobState.packages[0].declarations.flatMap(declaration => declaration.capabilities).find(capability => capability.capabilityId === 'assets')!;
    assert.equal(bobState.packages[0].publishedRevisionRef, v1.published.revisionRef);
    await workflow.setManagedAgentWorkflowChoice({ actor: bob, agentId: 'workflow-main', capabilityKey: bobAssets.capabilityKey,
      expectedWorkflowRevision: bobState.workflowRevision, expectedPreferenceRevision: bobState.preferenceRevision,
      personalSelection: { alternativeKey: 'composio:canva', target: { kind: 'personal', source: 'composio', ownerUserId: 'bob',
        providerRef: bobRef, accountSelectionRef: bobChoices.accounts[1].accountSelectionRef } } });
    const freshBob = () => resolveAgentExecutionContextForStoredSession({ userId: 'bob', agentId: 'workflow-main', sessionId: 'workflow-main-bob-session' });
    const bobContext = await freshBob();
    assert.equal(bobContext.skillPackageBindings?.[0].publishedRevisionRef, v1.published.revisionRef);
    assert.equal(bobContext.skillPackageBindings?.[0].checksum, initialContext.skillPackageBindings?.[0].checksum);
    const beforeBobTools = counts();
    const bobTools = await getPiTools('bob', 'workflow-main', 'workflow-main-bob-session', { executionContext: bobContext, strictAuthorization: true, metadataOnlyExternal: true });
    assert.deepEqual(counts(), beforeBobTools, 'Bob normal session/tool construction does not borrow or probe Alice accounts.');
    const bobGateway = bobTools.find(isIntegrationGatewayTool); assert(bobGateway);
    const invokeBob = async (request: unknown) => runWithAgentExecutionContext({ ...await freshBob(), agentTurnId: 'workflow-bob-turn' },
      () => bobGateway.execute('workflow-bob-fixture', request as never));
    const bobCatalogue = details<IntegrationProviderPage>(await invokeBob({ action: 'list', target: 'providers' }));
    const bobCanva = bobCatalogue.providers.find(provider => provider.application === 'canva'); assert(bobCanva);
    assert.notEqual(bobCanva.providerRef, personalCanva.providerRef);
    const bobToolPage = details<IntegrationToolPage>(await invokeBob({ action: 'list', target: 'tools', providerRef: bobCanva.providerRef }));
    const bobSchema = details<IntegrationToolSchema>(await invokeBob({ action: 'describe', toolRef: bobToolPage.tools[0].toolRef }));
    await setComposioWorkspaceProfileOverride({ userId: 'bob', workspaceId: 'personal-bob', profileId: bobDefault.id });
    details(await invokeBob({ action: 'call', toolRef: bobSchema.toolRef, schemaRef: bobSchema.schemaRef, arguments: { folder_id: 'Bob exact personal account' } }));
    const bobExecution = composio.calls.filter(call => call.path.includes('/tools/execute/')).at(-1)!;
    assert.equal(bobExecution.body.connected_account_id, 'PERSONAL_BOB_EXACT_B');
    assert.equal(bobExecution.body.user_id, bobPersonal.composioUserId);
    details(await invoke({ action: 'call', toolRef: selectedSchema.toolRef, schemaRef: selectedSchema.schemaRef, arguments: { folder_id: 'Alice exact personal account after Bob' } }));
    const aliceExecution = composio.calls.filter(call => call.path.includes('/tools/execute/')).at(-1)!;
    assert.equal(aliceExecution.body.connected_account_id, 'PERSONAL_EXACT_B',
      'One immutable organization package keeps two independently confirmed personal accounts.');
    assert.equal(aliceExecution.body.user_id, firstPersonal.composioUserId);
    const beforeCrossUser = counts();
    const crossUser = (await invokeBob({ action: 'call', toolRef: selectedSchema.toolRef, schemaRef: selectedSchema.schemaRef,
      arguments: { folder_id: 'Never borrow Alice receipt' } })).details as { integrationError: unknown };
    assert(crossUser.integrationError); assert.deepEqual(counts(), beforeCrossUser, 'Alice schema/account receipt cannot execute in Bob normal session.');
    const beforeAccountChange = counts().slice(2);
    composio.accounts.set(firstPersonal.composioUserId, [{ id: 'PERSONAL_EXACT_A', toolkit: 'canva', status: 'ACTIVE' }]);
    const missingAccount = (await invoke({ action: 'call', toolRef: selectedSchema.toolRef, schemaRef: selectedSchema.schemaRef, arguments: { folder_id: 'No replacement account' } })).details as { integrationError: unknown };
    assert(missingAccount.integrationError); assert.deepEqual(counts().slice(2), beforeAccountChange);
    composio.accounts.set(firstPersonal.composioUserId, [{ id: 'PERSONAL_EXACT_A', toolkit: 'canva', status: 'ACTIVE' }, { id: 'PERSONAL_EXACT_B', toolkit: 'canva', status: 'ACTIVE' }]);
    composio.versions.set('ASSET_LOOKUP', '20261006_99');
    const changedSchema = (await invoke({ action: 'call', toolRef: selectedSchema.toolRef, schemaRef: selectedSchema.schemaRef, arguments: { folder_id: 'No stale schema' } })).details as { integrationError: unknown };
    assert(changedSchema.integrationError); assert.deepEqual(counts().slice(2), beforeAccountChange); composio.versions.delete('ASSET_LOOKUP');
    const currentPackage = await packages.inspectCapabilityPackage(owner, ref);
    let v2Draft = await packages.createCapabilityPackageDraftAction(owner, edit(currentPackage));
    const missingWorkflow = structuredClone(childWorkflow); missingWorkflow.integrationCapabilities[0].alternatives[0].requiredTools = ['ASSET_LOOKUP', 'MISSING_REQUIRED_TOOL'];
    v2Draft = (await packages.writeCapabilityPackageDraftFileAction(owner, v2Draft.draftRef, { expectedDraftRevision: v2Draft.draftRevision,
      path: `${childRoot}/agents/canvas.yaml`, encoding: 'base64', content: Buffer.from(YAML.stringify({ workflow: missingWorkflow })).toString('base64') })).draft;
    const v2 = await packages.publishCapabilityPackageDraftAction(owner, publish(v2Draft, currentPackage));
    assert.equal((await fresh()).skillPackageBindings?.[0].publishedRevisionRef, v1.published.revisionRef, 'A new package HEAD preserves the explicitly selected immutable v1.');
    const pinnedAuthorization = await resolveIntegrationAuthorizationContext({ actorUserId: 'alice', sessionId: 'workflow-main-session',
      agentId: 'workflow-main', policyRevision: 'workflow-authorization-fixture' });
    assert.deepEqual(pinnedAuthorization.executionContext.skillReadRoots, []);
    assert.deepEqual(pinnedAuthorization.executionContext.skillPackageBindings, []);
    const pinnedAuthorizationPolicy = await resolveIntegrationRuntimePolicy({ executionContext: pinnedAuthorization.executionContext, ceiling: UNRESTRICTED_INTEGRATION_POLICY });
    const pinnedFullPolicy = await resolveIntegrationRuntimePolicy({ executionContext: await fresh(), ceiling: UNRESTRICTED_INTEGRATION_POLICY });
    assert.deepEqual(pinnedAuthorizationPolicy.policy, pinnedFullPolicy.policy);
    assert.equal(pinnedAuthorizationPolicy.policyRevision, pinnedFullPolicy.policyRevision,
      'Authorization still resolves the explicit immutable V1 package after a different V2 becomes HEAD.');
    details(await invoke({ action: 'call', toolRef: selectedSchema.toolRef, schemaRef: selectedSchema.schemaRef, arguments: { folder_id: 'Pinned v1' } }));
    const missingPackage = structuredClone(basePackage); missingPackage.publishedRevisionRef = v2.published.revisionRef; missingPackage.checksum = v2.published.checksum;
    const missingSelection = missingPackage.declarations[1].capabilities[0].selection; assert(missingSelection.mode === 'selectable');
    missingSelection.allowedChoices = missingSelection.allowedChoices.map(choice => ({ ...choice, toolCap: ['ASSET_LOOKUP', 'MISSING_REQUIRED_TOOL'] }));
    missingSelection.personalPolicy!.toolCap = ['ASSET_LOOKUP', 'MISSING_REQUIRED_TOOL'];
    await configure('workflow-missing', [missingPackage]);
    const missingContext = await fresh('workflow-missing');
    const missingTools = await getPiTools('alice', 'workflow-missing', 'workflow-missing-session', { executionContext: missingContext, strictAuthorization: true, metadataOnlyExternal: true });
    const missingGateway = missingTools.find(isIntegrationGatewayTool)!; assert(missingGateway);
    const missingPage = details<IntegrationProviderPage>(await invoke({ action: 'list', target: 'providers' }, missingGateway, 'workflow-missing'));
    const missingMcp = missingPage.providers.find(provider => provider.source === 'mcp')!;
    const missingMcpTools = details<IntegrationToolPage>(await invoke({ action: 'list', target: 'tools', providerRef: missingMcp.providerRef }, missingGateway, 'workflow-missing'));
    const missingSchema = details<IntegrationToolSchema>(await invoke({ action: 'describe', toolRef: missingMcpTools.tools[0].toolRef }, missingGateway, 'workflow-missing'));
    const missingAuthorization = await resolveIntegrationAuthorizationContext({ actorUserId: 'alice', sessionId: 'workflow-missing-session',
      agentId: 'workflow-missing', policyRevision: 'workflow-authorization-fixture' });
    assert.deepEqual(missingAuthorization.executionContext.skillReadRoots, []);
    assert.deepEqual(missingAuthorization.executionContext.skillPackageBindings, []);
    const missingAuthorizationPolicy = await resolveIntegrationRuntimePolicy({ executionContext: missingAuthorization.executionContext, ceiling: UNRESTRICTED_INTEGRATION_POLICY });
    assert(missingAuthorizationPolicy.workflowProjection);
    const missingAuthorizationIntegration = { ...missingAuthorization.integrationContext, sessionId: missingAuthorization.executionContext.sessionId,
      policyRevision: missingAuthorizationPolicy.policyRevision };
    attachAgentWorkflowRuntimeProjection(missingAuthorizationIntegration, missingAuthorizationPolicy.workflowProjection);
    const beforeAuthorizationMissing = counts().slice(2);
    await assert.rejects(assertAgentWorkflowRuntimeReady({ context: missingAuthorizationIntegration, policy: missingAuthorizationPolicy.policy,
      projection: missingAuthorizationPolicy.workflowProjection }), { code: 'provider_denied' });
    assert.deepEqual(counts().slice(2), beforeAuthorizationMissing,
      'Empty roots cannot bypass a required missing tool or dispatch any business call.');
    const beforeMissing = counts().slice(2);
    const missingCall = (await invoke({ action: 'call', toolRef: missingSchema.toolRef, schemaRef: missingSchema.schemaRef, arguments: { design_query: 'Missing other required capability' } }, missingGateway, 'workflow-missing')).details as { integrationError: { code: string } };
    assert(missingCall.integrationError); assert.deepEqual(counts().slice(2), beforeMissing, 'A missing required tool on Canva closes the unrelated MCP business call too.');
    const emptyContext = await fresh('workflow-empty');
    const emptyTools = await getPiTools('alice', 'workflow-empty', 'workflow-empty-session', { executionContext: emptyContext, strictAuthorization: true, metadataOnlyExternal: true });
    const emptyGateway = emptyTools.find(isIntegrationGatewayTool)!; assert(emptyGateway);
    const { publishMcpServerDefinition } = await import('../app/lib/mcp/server-definitions');
    const { createPersonalMcpConnection } = await import('../app/lib/mcp/personal-connections');
    const definition = await publishMcpServerDefinition(org, 'Approved personal direct MCP', { url: mcp.mcpUrl, auth: 'none', directTools: [BROWSER_MCP_TOOL] });
    await createPersonalMcpConnection('alice', definition.id, 'Former direct design tool');
    const { buildDirectMcpTools } = await import('../app/lib/mcp/direct-tools');
    const direct = await buildDirectMcpTools({ userId: 'alice' }); assert.equal(direct.tools.length, 1);
    await fs.writeFile(serverPreferencesPath(), JSON.stringify({ settings: { integrationToolGatewayEnabled: false } }));
    const beforeEmpty = counts();
    const emptyResult = await invoke({ action: 'list', target: 'providers' }, emptyGateway, 'workflow-empty');
    assert.deepEqual(details<IntegrationProviderPage>(emptyResult).providers, [], 'A complete V2 empty selection has no executable providers.');
    const { createMcpProxyTool } = await import('../app/lib/mcp/proxy-tool');
    const { createComposioExecuteTool } = await import('../app/lib/composio/composio-tools');
    const proxy = createMcpProxyTool('alice'), legacy = createComposioExecuteTool();
    const legacyMcp = await runWithAgentExecutionContext(emptyContext, () => proxy.execute('blocked-legacy', { server: 'fixed', tool: BROWSER_MCP_TOOL, arguments: { design_query: 'blocked' } } as never));
    const legacyComposio = await runWithAgentExecutionContext(emptyContext, () => legacy.execute('blocked-legacy', { action: 'ASSET_LOOKUP', params: { folder_id: 'blocked' } } as never));
    const directDenied = await runWithAgentExecutionContext(emptyContext, () => direct.tools[0].execute('blocked-direct', { design_query: 'blocked' }));
    assert((legacyMcp.details as { error?: unknown }).error); assert(legacyComposio.content.some(content => content.type === 'text' && content.text.includes('error')));
    assert((directDenied.details as { error?: unknown }).error);
    assert.deepEqual(counts(), beforeEmpty, 'Empty workflow denies both legacy wrappers and a cached direct MCP tool with zero provider requests even when the old gateway flag is off.');
    await fs.writeFile(serverPreferencesPath(), JSON.stringify({ settings: { integrationToolGatewayEnabled: true } }));
    const connectionRecord = (await connections.getIntegrationConnectionRecord(slack.resource.connectionRef))!;
    await connections.mutateSharedIntegrationConnection(owner, slack.resource.connectionRef, { expectedMetadataRevision: connectionRecord.resource.metadataRevision,
      expectedGrantsRevision: connectionRecord.resource.grantsRevision, expectedBindingRevision: connectionRecord.resource.bindingRevision, grants: grants.filter(grant => grant.targetId !== 'alice') });
    const revokedAuthorization = await resolveIntegrationAuthorizationContext({ actorUserId: 'alice', sessionId: 'workflow-main-session',
      agentId: 'workflow-main', policyRevision: 'workflow-authorization-fixture' });
    const revokedAuthorizationPolicy = await resolveIntegrationRuntimePolicy({ executionContext: revokedAuthorization.executionContext, ceiling: UNRESTRICTED_INTEGRATION_POLICY });
    assert(revokedAuthorizationPolicy.workflowProjection);
    const revokedAuthorizationIntegration = { ...revokedAuthorization.integrationContext, sessionId: revokedAuthorization.executionContext.sessionId,
      policyRevision: revokedAuthorizationPolicy.policyRevision };
    attachAgentWorkflowRuntimeProjection(revokedAuthorizationIntegration, revokedAuthorizationPolicy.workflowProjection);
    const beforeAuthorizationRevoke = counts().slice(2);
    await assert.rejects(assertAgentWorkflowRuntimeReady({ context: revokedAuthorizationIntegration, policy: revokedAuthorizationPolicy.policy,
      projection: revokedAuthorizationPolicy.workflowProjection }), { code: 'provider_denied' });
    assert.deepEqual(counts().slice(2), beforeAuthorizationRevoke,
      'Authorization-only readiness retains the current required second-connection revoke with zero business calls.');
    const beforeRevoke = counts().slice(2);
    const revoked = (await invoke({ action: 'call', toolRef: selectedSchema.toolRef, schemaRef: selectedSchema.schemaRef, arguments: { folder_id: 'Revoked required Slack' } })).details as { integrationError: { code: string } };
    assert(revoked.integrationError); assert.deepEqual(counts().slice(2), beforeRevoke, 'Revoke of a required second capability blocks business dispatch on the first.');
    console.log('agent-workflow-integration-runtime-test: PASS (signed Team license/actual seats + PGlite ACL/session/package/configuration, real central runtime policy/getPiTools/gateway/SDK/MCP, Alice and Bob exact distinct personal accounts on the same immutable package and cross-user receipt refusal, shared/personal default stability, provider matrices, required readiness, pinned v1/head v2, canUse-only denial, planning/email zero SDK, empty workflow/legacy gates, current required revoke)');
  } finally {
    try { await closeMcp?.(); } finally {
      loader._load = original; await mcp.close(); await composio.close(); await raw.close(); await database.close();
      const unlock = async (directory: string): Promise<void> => { const stat = await fs.lstat(directory); if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await fs.chmod(directory, 0o700); for (const name of await fs.readdir(directory)) await unlock(path.join(directory, name));
      } };
      await unlock(root); await fs.rm(root, { recursive: true, force: true });
      for (const [key, value] of Object.entries(oldEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
