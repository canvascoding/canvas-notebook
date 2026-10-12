import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';
import { startIntegrationToolBrowserProvider, BROWSER_MCP_TOOL } from './fixtures/integration-tool-browser-provider';
import type { IntegrationExecutionContext, IntegrationPolicy, IntegrationProviderPage, IntegrationToolPage, IntegrationToolSchema } from '../app/lib/integration-tools/contracts';

async function main() {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-workflow-personal-'));
  const database = await createPiTestDatabase();
  const provider = await createComposioProviderFixture();
  const mcp = await startIntegrationToolBrowserProvider();
  const environment = { DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, COMPOSIO_BASE_URL: provider.baseUrl,
    CANVAS_INSTANCE_ID: 'workflow-personal-fixture', CANVAS_ORGANIZATION_ID: 'workflow-personal-org',
    CANVAS_MANAGED_SERVICES_ENABLED: 'false', MCP_ALLOW_PRIVATE_NETWORK: 'true', MCP_ALLOW_INSECURE_HTTP: 'true',
    MCP_ALLOW_STDIO: 'false', AUTH_SECRET: randomUUID() + randomUUID(), INTEGRATIONS_ENV_MASTER_KEY: randomUUID() + randomUUID(),
    BASE_URL: 'http://localhost:3000', BETTER_AUTH_BASE_URL: 'http://localhost:3000' };
  const previousEnvironment = Object.fromEntries([...Object.keys(environment), 'COMPOSIO_API_KEY'].map(key => [key, process.env[key]]));
  Object.assign(process.env, environment); delete process.env.COMPOSIO_API_KEY;
  const actualModules = new Map<string, unknown>();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load;
  let borrowed = 0;
  const fixtureDatabase = { ...database, openDb: async () => { borrowed += 1; return database.openDb(); } };
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return fixtureDatabase;
    if (actualModules.has(name)) return actualModules.get(name);
    return originalLoad(name, parent, isMain);
  };
  let closeMcp: (() => Promise<void>) | undefined;
  try {
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) {
      actualModules.set(name, await import(name));
    }
    const sql = await database.openDb();
    for (const id of ['alice', 'bob']) await sql.run('INSERT INTO "user" (id,name,email,role,email_verified,banned,created_at,updated_at) VALUES ($1,$1,$2,$3,1,0,1,1)', [id, `${id}@workflow.example.test`, id === 'alice' ? 'admin' : 'user']);
    const organizationId = 'workflow-personal-org';
    await sql.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ($1,'alice','team',1,1,1)", [organizationId]);
    for (const id of ['alice', 'bob']) {
      await sql.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ($1,$2,$3,'active',1,1,1)", [organizationId, id, id === 'alice' ? 'owner' : 'member']);
      await sql.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,$2,'personal',$3,$4,$3,'active',1,1)", [`personal-${id}`, organizationId, id, `workspaces/${id}/files`]);
    }
    await sql.run("INSERT INTO agents (agent_id,name,type,access_policy,scope_type,organization_id,owner_user_id,enabled_tools_json,revision,created_at,updated_at) VALUES ('personal-workflow-agent','Personal workflow','special','restricted','user',$1,'alice','[]',1,1,1)", [organizationId]);
    const { piSessions } = await import('../app/lib/db/schema');
    await database.db.insert(piSessions).values({ sessionId: 'personal-workflow-session', userId: 'alice', agentId: 'personal-workflow-agent',
      workspaceId: 'personal-alice', workspaceType: 'personal', organizationId, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
    const execution = await resolveAgentExecutionContextForStoredSession({ userId: 'alice', sessionId: 'personal-workflow-session', agentId: 'personal-workflow-agent' });
    const actor = { userId: execution.userId, organizationId, workspaceId: execution.workspaceId,
      sessionId: execution.sessionId, sourceAgentId: execution.agentId };
    const context: IntegrationExecutionContext = { actorUserId: actor.userId, organizationId, workspaceId: actor.workspaceId,
      sessionId: actor.sessionId, agentId: actor.sourceAgentId, policyRevision: 'personal-workflow-policy-1' };
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    const setKey = (value: string) => replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value }], { secretScope: 'legacy' });
    await setKey('inert-personal-workflow-key');
    const { createComposioProfile, ensureDefaultComposioProfile, setComposioWorkspaceProfileOverride } = await import('../app/lib/composio/composio-profiles');
    const profile = await createComposioProfile({ ownerUserId: 'alice', name: 'Design accounts' });
    const secondProfile = await createComposioProfile({ ownerUserId: 'alice', name: 'Another default' });
    const foreignProfile = await ensureDefaultComposioProfile('bob');
    const activeAccounts = [{ id: 'EXACT_ACCOUNT_A', toolkit: 'canva', status: 'ACTIVE' }, { id: 'EXACT_ACCOUNT_B', toolkit: 'canva', status: 'ACTIVE' },
      { id: 'PENDING_ACCOUNT', toolkit: 'canva', status: 'INITIATED' }, { id: 'SLACK_SIBLING', toolkit: 'slack', status: 'ACTIVE' }];
    provider.accounts.set(profile.composioUserId, activeAccounts);
    provider.accounts.set(secondProfile.composioUserId, [{ id: 'DEFAULT_OTHER_ACCOUNT', toolkit: 'canva', status: 'ACTIVE' }]);
    provider.accounts.set(foreignProfile.composioUserId, [{ id: 'FOREIGN_ACCOUNT', toolkit: 'canva', status: 'ACTIVE' }]);
    const { listComposioIntegrationProviders } = await import('../app/lib/integration-tools/adapters/composio');
    const baseCatalog = await listComposioIntegrationProviders(context);
    const canva = baseCatalog.providers.find(item => item.application === 'canva' && item.connection?.displayName === profile.name)!;
    const noAuth = baseCatalog.providers.find(item => item.application === 'duckduckgo' && item.connection?.displayName === profile.name)!;
    assert(canva && noAuth); assert.equal(canva.canExecute, false, 'Legacy ambiguous accounts remain unavailable.');
    const personal = await import('../app/lib/integration-tools/workflow-personal-bindings');
    const provenance = await import('../app/lib/integration-tools/workflow-personal-provenance');
    const counts = () => [provider.calls.length, mcp.calls().requests, provider.calls.filter(call => call.path.includes('/tools/execute/')).length];
    await assert.rejects(() => personal.preparePersonalWorkflowProviderTarget({ actor, providerRef: canva.providerRef }), { code: 'binding_changed' });
    const choices = await personal.listPersonalWorkflowProviderAccountChoices({ actor, providerRef: canva.providerRef });
    assert.equal(choices.accounts.length, 3); assert.equal(choices.accounts.filter(choice => choice.selectable).length, 2);
    for (const value of ['EXACT_ACCOUNT_A', 'EXACT_ACCOUNT_B', 'PENDING_ACCOUNT', 'SLACK_SIBLING', profile.composioUserId, 'inert-personal-workflow-key']) assert(!JSON.stringify(choices).includes(value));
    const prepared = await Promise.all(choices.accounts.filter(choice => choice.selectable).map(choice => personal.preparePersonalWorkflowProviderTarget({ actor, providerRef: canva.providerRef, accountSelectionRef: choice.accountSelectionRef })));
    const targets = prepared.map(personal.getPreparedPersonalWorkflowProviderTarget);
    assert.notEqual(targets[0].boundProviderRef, targets[1].boundProviderRef, 'Different accounts have different matrix identities.');
    assert.equal(targets[0].binding.source, 'composio');
    assert(!personal.isPreparedPersonalWorkflowProviderTarget(structuredClone(prepared[0])), 'Serialized preparation is not authority.');
    await assert.rejects(() => personal.preparePersonalWorkflowProviderTarget({ actor, providerRef: canva.providerRef, accountSelectionRef: 'EXACT_ACCOUNT_A' }), { code: 'binding_changed' });
    const tampered = choices.accounts[0].accountSelectionRef.slice(0, -2) + 'AA';
    await assert.rejects(() => personal.preparePersonalWorkflowProviderTarget({ actor, providerRef: canva.providerRef, accountSelectionRef: tampered }), { code: 'binding_changed' });
    await assert.rejects(() => personal.preparePersonalWorkflowProviderTarget({ actor: { userId: 'bob', organizationId, workspaceId: 'personal-bob' }, providerRef: canva.providerRef, accountSelectionRef: choices.accounts[0].accountSelectionRef }));
    const { readPersonalComposioAccountReference } = await import('../app/lib/composio/composio-shared-account-reference');
    const now = Date.now;
    try { Date.now = () => now() + 6 * 60_000; assert.throws(() => readPersonalComposioAccountReference(choices.accounts[0].accountSelectionRef), { code: 'binding_changed' }); }
    finally { Date.now = now; }
    const beforeCommit = counts(), leasesBeforeCommit = borrowed;
    await sql.run('BEGIN');
    try { for (const proof of prepared) await personal.revalidatePreparedPersonalWorkflowProviderTarget(proof, { database: sql }); }
    finally { await sql.run('ROLLBACK'); }
    assert.deepEqual(counts(), beforeCommit, 'Final configuration revalidation performs no provider I/O.');
    assert.equal(borrowed, leasesBeforeCommit, 'The supplied configuration transaction borrows no nested connection.');
    const staticBefore = counts();
    const staticProofs = await Promise.all(targets.map(target => personal.verifyStoredPersonalWorkflowProviderTarget({ actor, target }, { checkProviderReadiness: false })));
    assert.deepEqual(counts(), staticBefore, 'Runtime policy and planning metadata use static authority only.');
    personal.attachPersonalWorkflowProviderTargets(context, [...staticProofs, staticProofs[0]]);
    assert.equal(provenance.getAttachedPersonalWorkflowProviderDescriptor(context, targets[0].boundProviderRef)?.canExecute, false);
    const cloned = structuredClone(context);
    assert.equal(provenance.getAttachedPersonalWorkflowProviderDescriptor(cloned, targets[0].boundProviderRef), null);
    personal.transferPersonalWorkflowProviderTargets(context, cloned);
    assert(provenance.getAttachedPersonalWorkflowProviderDescriptor(cloned, targets[0].boundProviderRef));
    for (const changedContext of [{ ...context, policyRevision: 'other' }, { ...context, agentId: 'other' }, { ...context, sessionId: 'other' }, { ...context, actorUserId: 'bob' }]) {
      personal.transferPersonalWorkflowProviderTargets(context, changedContext);
      assert.equal(provenance.getAttachedPersonalWorkflowProviderDescriptor(changedContext, targets[0].boundProviderRef), null);
    }
    const { UNRESTRICTED_INTEGRATION_POLICY } = await import('../app/lib/integration-tools/policy');
    const policy: IntegrationPolicy = { ...UNRESTRICTED_INTEGRATION_POLICY, providerToolRules: targets.map((target, index) => ({ source: 'composio', providerRef: target.boundProviderRef,
      allowedToolNames: [index === 0 ? 'DESIGN_CREATE' : 'ASSET_LOOKUP'], allowedOperations: null })) };
    const { IntegrationDispatcher } = await import('../app/lib/integration-tools/dispatcher');
    const dispatcher = new IntegrationDispatcher();
    const run = (request: unknown, selectedPolicy = policy, selectedContext = context) => dispatcher.execute({ context: selectedContext, policy: selectedPolicy, request, toolCallId: 'personal-workflow-fixture' });
    const beforeCatalogue = counts();
    const visible = await run({ action: 'list', target: 'providers' }) as IntegrationProviderPage;
    assert.deepEqual(visible.providers.map(item => item.providerRef).sort(), targets.map(target => target.boundProviderRef).sort());
    assert.deepEqual(counts(), beforeCatalogue, 'Bound-only discovery does not contact unrelated provider apps or profiles.');
    const schemas: IntegrationToolSchema[] = [];
    for (let index = 0; index < targets.length; index += 1) {
      const tools = await run({ action: 'list', target: 'tools', providerRef: targets[index].boundProviderRef }) as IntegrationToolPage;
      assert.deepEqual(tools.tools.map(item => item.name), policy.providerToolRules![index].allowedToolNames);
      const schema = await run({ action: 'describe', toolRef: tools.tools[0].toolRef }) as IntegrationToolSchema; schemas.push(schema);
      await run({ action: 'call', toolRef: schema.toolRef, schemaRef: schema.schemaRef, arguments: index === 0 ? { title: 'Exact account design' } : { folder_id: 'Exact account folder' } });
      const executed = provider.calls.filter(call => call.path.includes('/tools/execute/')).at(-1)!;
      const binding = targets[index].binding;
      assert.equal(executed.body.connected_account_id, binding.source === 'composio' ? binding.connectedAccountId : undefined);
      assert.equal(executed.body.version, '20261006_00');
    }
    const beforeExcluded = counts();
    for (const request of [{ action: 'list', target: 'tools', providerRef: targets[0].boundProviderRef }, { action: 'describe', toolRef: schemas[0].toolRef },
      { action: 'call', toolRef: schemas[0].toolRef, schemaRef: schemas[0].schemaRef, arguments: { title: 'Blocked' } }]) {
      await assert.rejects(() => run(request, { ...policy, allowedApplications: ['slack'] }), { code: 'provider_denied' });
    }
    await assert.rejects(() => run({ action: 'list', target: 'tools', providerRef: targets[0].boundProviderRef }, policy, structuredClone(context)), { code: 'provider_denied' });
    assert.deepEqual(counts(), beforeExcluded, 'Global app ceilings and missing private context proof deny before any SDK request.');
    await setComposioWorkspaceProfileOverride({ userId: 'alice', workspaceId: 'personal-alice', profileId: secondProfile.id });
    await run({ action: 'call', toolRef: schemas[0].toolRef, schemaRef: schemas[0].schemaRef, arguments: { title: 'Default changed' } });
    assert.equal(provider.calls.filter(call => call.path.includes('/tools/execute/')).at(-1)!.body.connected_account_id, 'EXACT_ACCOUNT_A');
    provider.accounts.set(profile.composioUserId, activeAccounts.filter(account => account.id !== 'EXACT_ACCOUNT_A'));
    const beforeMissing = counts()[2];
    await assert.rejects(() => run({ action: 'call', toolRef: schemas[0].toolRef, schemaRef: schemas[0].schemaRef, arguments: { title: 'No replacement' } }), { code: 'binding_changed' });
    assert.equal(counts()[2], beforeMissing); provider.accounts.set(profile.composioUserId, activeAccounts);
    const noAuthProof = await personal.preparePersonalWorkflowProviderTarget({ actor, providerRef: noAuth.providerRef });
    const noAuthTarget = personal.getPreparedPersonalWorkflowProviderTarget(noAuthProof);
    assert(noAuthTarget.binding.source === 'composio'); assert.equal(noAuthTarget.binding.accountBinding, 'no_auth'); assert.equal(noAuthTarget.binding.connectedAccountId, null);
    const beforeRotation = counts()[2]; await setKey('inert-rotated-workflow-key');
    await assert.rejects(() => personal.revalidatePreparedPersonalWorkflowProviderTarget(prepared[0], { database: sql }), { code: 'binding_changed' });
    await assert.rejects(() => personal.verifyStoredPersonalWorkflowProviderTarget({ actor, target: targets[0] }), { code: 'binding_changed' });
    assert.equal(counts()[2], beforeRotation); await setKey('inert-personal-workflow-key');

    const { publishMcpServerDefinition } = await import('../app/lib/mcp/server-definitions');
    const { createPersonalMcpConnection } = await import('../app/lib/mcp/personal-connections');
    const definition = await publishMcpServerDefinition(organizationId, 'Approved design MCP', { url: mcp.mcpUrl, auth: 'none' });
    const connection = await createPersonalMcpConnection('alice', definition.id, 'Personal design MCP');
    closeMcp = (await import('../app/lib/mcp/manager')).closeAllMcpServers;
    const { listMcpIntegrationProviders } = await import('../app/lib/integration-tools/adapters/mcp');
    const mcpProvider = (await listMcpIntegrationProviders(context)).providers.find(item => item.scope.resourceId === connection.connectionId)!;
    assert(mcpProvider);
    const beforeMcpPrepare = counts();
    const mcpProof = await personal.preparePersonalWorkflowProviderTarget({ actor, providerRef: mcpProvider.providerRef });
    const mcpTarget = personal.getPreparedPersonalWorkflowProviderTarget(mcpProof);
    assert(mcpTarget.binding.source === 'mcp'); assert.equal(mcpTarget.binding.serverDefinitionId, definition.id);
    await personal.revalidatePreparedPersonalWorkflowProviderTarget(mcpProof, { database: sql });
    const mcpStatic = await personal.verifyStoredPersonalWorkflowProviderTarget({ actor, target: mcpTarget }, { checkProviderReadiness: false });
    assert.deepEqual(counts(), beforeMcpPrepare, 'MCP configuration and static metadata never start the server.');
    const mcpContext = { ...context, policyRevision: 'mcp-personal-workflow' };
    personal.attachPersonalWorkflowProviderTargets(mcpContext, [mcpStatic]);
    assert.equal(provenance.getAttachedPersonalWorkflowProviderDescriptor(mcpContext, mcpTarget.boundProviderRef)?.application, undefined, 'Logical app labels do not establish MCP application identity.');
    const mcpPolicy: IntegrationPolicy = { ...UNRESTRICTED_INTEGRATION_POLICY, providerToolRules: [{ source: 'mcp', providerRef: mcpTarget.boundProviderRef, allowedToolNames: [BROWSER_MCP_TOOL], allowedOperations: null }] };
    const mcpRun = (request: unknown) => run(request, mcpPolicy, mcpContext);
    const mcpTools = await mcpRun({ action: 'list', target: 'tools', providerRef: mcpTarget.boundProviderRef }) as IntegrationToolPage;
    const mcpSchema = await mcpRun({ action: 'describe', toolRef: mcpTools.tools[0].toolRef }) as IntegrationToolSchema;
    await mcpRun({ action: 'call', toolRef: mcpSchema.toolRef, schemaRef: mcpSchema.schemaRef, arguments: { design_query: 'Actual personal MCP' } });
    assert.equal(mcp.calls().executions.length, 1);
    await publishMcpServerDefinition(organizationId, 'Approved design MCP', { url: mcp.mcpUrl, auth: 'none' }, definition.id);
    const beforeDefinitionChange = mcp.calls().executions.length;
    await assert.rejects(() => personal.revalidatePreparedPersonalWorkflowProviderTarget(mcpProof, { database: sql }), { code: 'binding_changed' });
    await assert.rejects(() => mcpRun({ action: 'call', toolRef: mcpSchema.toolRef, schemaRef: mcpSchema.schemaRef, arguments: { design_query: 'Changed definition' } }), { code: 'binding_changed' });
    assert.equal(mcp.calls().executions.length, beforeDefinitionChange, 'A new approved-definition revision requires reselection.');
    console.log('workflow-personal-bindings-test: PASS (actual PGlite actor/session rights, real Composio SDK exact account/version, sealed chooser tamper/expiry/foreign denial, separate bound identities, static zero-I/O/private context proof, same-DB final checks, default-profile stability, real approved MCP binding/revision guards)');
  } finally {
    try { await closeMcp?.(); } finally {
      loader._load = originalLoad; await mcp.close(); await provider.close(); await database.close(); await rm(dataRoot, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previousEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
