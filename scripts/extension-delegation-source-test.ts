import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir, chmod } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { createPiTestDatabase } from './helpers/pi-test-database';

// Real PGlite actor/session/workspace/task/source/ACL and all issued WeakMaps.
// Model metadata and external seat licensing are controlled; no source or ACL
// service is substituted and no network/model/provider business call is made.
async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-extension-delegation-source-'));
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_ORGANIZATION_ID: 'delegated-source-org',
    CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_MCP_DIRECT_ENABLED: 'false',
    BETTER_AUTH_BASE_URL: 'http://localhost:3000' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const database = await createPiTestDatabase();
  const modules = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = modules._load;
  modules._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
      getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false };
    if (name === '@earendil-works/pi-agent-core' || name === '@earendil-works/pi-ai/oauth') return {};
    if (name.includes('license/seat-limit')) return { assertUserSeatAccess: async ({ userId }: { userId: string }) => {
      assert.ok(['owner', 'alice'].includes(userId));
      return { userId, mode: 'team', organizationId: environment.CANVAS_ORGANIZATION_ID };
    } };
    if (name === '@/app/lib/agents/workspace-brand-context') return { getWorkspaceBrandPromptBlock: async () => null };
    if (name === '@/app/lib/pi/live-runtime' || name.endsWith('/pi/live-runtime.ts')) return { requestPiRuntimePromptRefreshForUser: async () => {} };
    return original(name, parent, isMain);
  };
  try {
    const sql = await database.openDb();
    for (const id of ['owner', 'alice']) await sql.run('INSERT INTO "user"(id,name,email,role,email_verified,banned,created_at,updated_at) VALUES ($1,$1,$2,\'member\',1,0,1,1)', [id, `${id}@fixture.test`]);
    await sql.run("INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('delegated-source-org','owner','team',1,1,1)");
    for (const id of ['owner', 'alice']) await sql.run("INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('delegated-source-org',$1,$2,'active',$3,1,1)", [id, id === 'owner' ? 'owner' : 'member', Number(id === 'owner')]);
    await sql.run("INSERT INTO canvas_workspaces(id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('team','delegated-source-org','team','workspaces/team/files','Team','active',1,1)");
    await sql.run("INSERT INTO canvas_workspace_members(organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ('delegated-source-org','team','alice','member','active',1,1,0,1,1)");
    await sql.run("UPDATE agents SET access_policy='restricted',scope_type='organization',organization_id='delegated-source-org',owner_user_id='owner',enabled_tools_json='[]',revision=1 WHERE agent_id='bradley'");
    await sql.run("INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,owner_user_id,enabled_tools_json,revision,created_at,updated_at) VALUES ('worker-general','Worker','special','restricted','organization','delegated-source-org','owner','[]',1,1,1)");
    for (const agent of ['bradley', 'worker-general']) await sql.run("INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,can_use,can_edit,can_manage,created_at,updated_at) VALUES ($1,$2,'delegated-source-org','workspace','team',1,0,0,1,1)", [`grant-${agent}`, agent]);
    const { piSessions } = await import('../app/lib/db/schema');
    const session = (sessionId: string, agentId = 'bradley') => ({ sessionId, userId: 'alice', agentId, workspaceId: 'team',
      workspaceType: 'team' as const, organizationId: 'delegated-source-org', provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    await database.db.insert(piSessions).values(session('parent'));
    const contextApi = await import('../app/lib/integration-tools/context');
    const effectiveApi = await import('../app/lib/capabilities/extensions/effective-context');
    const packageApi = await import('../app/lib/capabilities/packages/runtime-bindings');
    const acceptedApi = await import('../app/lib/capabilities/extensions/accepted-turn-selection');
    const runtime = await import('../app/lib/capabilities/extensions/turn-runtime');
    const sourceApi = await import('../app/lib/capabilities/extensions/delegation-source');
    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const { createSharedIntegrationProviderRef } = await import('../app/lib/integration-tools/connections/provider-authorization');
    const { mutateSharedIntegrationConnection } = await import('../app/lib/integration-tools/connections/store');
    const { createPiDelegation, claimQueuedPiDelegation } = await import('../app/lib/pi/delegation-store');
    const { resolveIntegrationRuntimePolicy } = await import('../app/lib/integration-tools/runtime-policy');
    const { UNRESTRICTED_INTEGRATION_POLICY, isIntegrationProviderOperationAllowed } = await import('../app/lib/integration-tools/policy');
    const owner = { userId: 'owner', organizationId: 'delegated-source-org' };
    const shared = await createSharedMcpConnection(owner, { ownership: { type: 'organization', organizationId: owner.organizationId },
      displayName: 'Parent exact source', accessMode: 'restricted', grants: [{ targetType: 'user', targetId: 'alice', canUse: true,
        canManage: false, allowedToolNames: ['read_fixture', 'other_fixture'] }], allowedToolNames: ['read_fixture', 'other_fixture'],
      config: { url: 'https://fixture.invalid/mcp', transport: 'http', auth: 'none', enabled: true } });
    const parentBase = (await contextApi.resolveIntegrationExecutionContext({ actorUserId: 'alice', sessionId: 'parent', policyRevision: 'fixture' })).executionContext;
    const intake = { ...parentBase, agentTurnId: 'parent-intake' };
    const accepted = await acceptedApi.prepareAcceptedTurnExtensionSelection(intake, { version: 1, origin: 'turn_reference', selections: [{
      selection: { kind: 'mcp', source: 'mcp', target: { kind: 'shared', connectionRef: shared.resource.connectionRef,
        bindingRevision: shared.resource.bindingRevision } }, requirement: 'optional', toolCap: ['read_fixture'] }] });
    const turn: AgentExecutionContext = { ...intake, agentTurnId: 'parent-turn',
      turnExtensions: acceptedApi.readAcceptedTurnExtensionSelection(accepted, intake).publicSelection };
    const parentSelection = await packageApi.getAuthorizedAgentWorkflowPackageSelections(turn);
    turn.turnExtensionSource = await runtime.reissueAcceptedTurnRuntimeSelection(turn, accepted, intake, { packageSelection: parentSelection });
    const parent = await effectiveApi.resolveEffectiveExtensionContext(turn, { packageSelection: parentSelection });
    const source = await sourceApi.captureDelegatedExtensionSource(parent); assert(source);
    assert.equal(sourceApi.readDelegatedExtensionParentContext(source).turnExtensionSource, parent.turnExtensionSource);
    assert.throws(() => sourceApi.readDelegatedExtensionParentContext(structuredClone(source)), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' });
    assert.throws(() => sourceApi.readDelegatedExtensionSource(source, { ...parent, agentTurnId: 'other-parent-turn' }), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' });
    const task = async (id: string, parentContext: AgentExecutionContext, agentId = 'bradley') => {
      const childId = `child-${id}`;
      await createPiDelegation({ id, userId: 'alice', sourceSessionId: 'parent', sourceAgentId: 'bradley',
        sourceAgentTurnId: parentContext.agentTurnId, workerSessionId: childId, workerType: agentId === 'bradley' ? 'ephemeral' : 'managed',
        ...(agentId === 'bradley' ? {} : { targetAgentId: agentId }), goal: 'Read one exact parent source', toolsets: ['mcp', 'composio'] });
      await claimQueuedPiDelegation(id, 'fixture-owner');
      await database.db.insert(piSessions).values({ ...session(childId, agentId), sessionKind: 'delegation_worker',
        parentSessionId: 'parent', delegationDepth: 1, delegationId: id });
      return { ...(await contextApi.resolveIntegrationAuthorizationContext({ actorUserId: 'alice', sessionId: childId,
        agentId, policyRevision: 'fixture-child' })).executionContext, agentTurnId: `turn-${id}` };
    };
    const childBase = await task('first-task', parent);
    assert.throws(() => sourceApi.readDelegatedExtensionPackageSource(source, childBase), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' });
    const child = await runtime.resolveDelegatedExtensionContextSource(source, childBase, { delegationId: 'first-task' });
    assert.notEqual(child.turnExtensionSource, parent.turnExtensionSource);
    assert.notEqual(child.effectiveExtensions, parent.effectiveExtensions);
    assert.equal(child.delegatedExtensionSource, source);
    assert.equal(runtime.readDelegatedTurnRuntimeParentSource(child, 'first-task'), source);
    assert.equal(effectiveApi.isIssuedScopedIntegrationTurn(child), true);
    for (const changed of [{ ...child, delegatedExtensionSource: undefined }, { ...child, delegatedExtensionSource: structuredClone(source) }]) {
      assert.throws(() => effectiveApi.isIssuedScopedIntegrationTurn(changed), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' },
        'Dropping or cloning the parent pointer cannot retain the child source while discarding its parent ceiling.');
      await assert.rejects(contextApi.resolveRuntimeIntegrationExecutionContext({ executionContext: changed, policyRevision: 'dropped-parent' }),
        { code: 'AGENT_EXTENSION_CONTEXT_DENIED' });
    }
    assert.throws(() => runtime.readDelegatedTurnRuntimeParentSource(child, 'different-task'), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' });
    assert.throws(() => runtime.readDelegatedTurnRuntimeParentSource({ ...child, turnExtensionSource: parent.turnExtensionSource }, 'first-task'), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' });
    const childPolicy = await resolveIntegrationRuntimePolicy({ executionContext: child, ceiling: UNRESTRICTED_INTEGRATION_POLICY });
    const ref = createSharedIntegrationProviderRef(shared.resource);
    assert.deepEqual(childPolicy.policy.providerToolRules?.map(rule => [rule.providerRef, rule.allowedToolNames]), [[ref, ['read_fixture']]],
      'Broad worker toolsets cannot expand the original finite parent cap.');
    const freshChild = (await contextApi.resolveRuntimeIntegrationExecutionContext({ executionContext: child, policyRevision: 'current' })).executionContext;
    assert.deepEqual(freshChild.turnExtensions, child.turnExtensions);
    assert.equal(freshChild.delegatedExtensionSource, source);
    assert.equal(runtime.readDelegatedTurnRuntimeParentSource(freshChild, 'first-task'), source);
    await assert.rejects(runtime.resolveDelegatedExtensionContextSource(source, { ...childBase, sessionId: 'missing-child' }, { delegationId: 'first-task' }));
    await assert.rejects(runtime.resolveDelegatedExtensionContextSource(source, childBase, { delegationId: 'wrong-task' }));
    await sql.run("UPDATE canvas_workspace_members SET can_write=0 WHERE user_id='alice'");
    await assert.rejects(runtime.resolveDelegatedExtensionContextSource(source, childBase, { delegationId: 'first-task' }), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' });
    await sql.run("UPDATE canvas_workspace_members SET can_write=1 WHERE user_id='alice'");
    await sql.run("UPDATE pi_delegations SET cancel_requested_at=1 WHERE id='first-task'");
    await assert.rejects(runtime.resolveDelegatedExtensionContextSource(source, childBase, { delegationId: 'first-task' }));
    await sql.run("UPDATE pi_delegations SET cancel_requested_at=NULL WHERE id='first-task'");

    const { readPiRuntimeConfig, writePiRuntimeConfig } = await import('../app/lib/agents/storage');
    const mainRuntime = await readPiRuntimeConfig();
    const fixtureRuntime = { ...mainRuntime, providers: { [mainRuntime.activeProvider]: {
      ...mainRuntime.providers[mainRuntime.activeProvider], model: 'fixture-model', enabledTools: [] } } };
    await writePiRuntimeConfig({ ...fixtureRuntime, providers: { [mainRuntime.activeProvider]: {
      ...fixtureRuntime.providers[mainRuntime.activeProvider], enabledTools: ['__none__'] } } });
    const restrictedSource = await sourceApi.captureDelegatedExtensionSource(parent); assert(restrictedSource);
    assert.deepEqual(sourceApi.readDelegatedExtensionSource(restrictedSource).parentPolicy.allowedSources, []);
    await writePiRuntimeConfig(fixtureRuntime);
    const laterBroadChild = await runtime.resolveDelegatedExtensionContextSource(restrictedSource,
      await task('native-ceiling-task', parent, 'worker-general'), { delegationId: 'native-ceiling-task' });
    const laterPolicy = await resolveIntegrationRuntimePolicy({ executionContext: laterBroadChild, ceiling: UNRESTRICTED_INTEGRATION_POLICY });
    assert.equal(isIntegrationProviderOperationAllowed(laterPolicy.policy, 'mcp', ref, 'call'), false,
      'Broader parent settings after queue capture cannot expand the original native parent ceiling.');

    // Real reader protocol fixtures; future aggregate UI authoring is a separate phase.
    await sql.run("UPDATE agents SET workflow_version=2,workflow_revision=workflow_revision+1 WHERE agent_id='bradley'");
    const emptyParent = await effectiveApi.resolveEffectiveExtensionContext({ ...(await contextApi.resolveIntegrationAuthorizationContext({
      actorUserId: 'alice', sessionId: 'parent', policyRevision: 'empty-fixed' })).executionContext, agentTurnId: 'empty-fixed-parent-turn' });
    const emptySource = await sourceApi.captureDelegatedExtensionSource(emptyParent); assert(emptySource);
    const emptyChildBase = await task('empty-task', emptyParent, 'worker-general');
    const emptyChild = await runtime.resolveDelegatedExtensionContextSource(emptySource, emptyChildBase, { delegationId: 'empty-task' });
    assert.equal(effectiveApi.isIssuedScopedIntegrationTurn(emptyChild), true, 'An empty fixed parent retains finite admission for a general managed child.');
    assert.deepEqual((await resolveIntegrationRuntimePolicy({ executionContext: emptyChild,
      ceiling: UNRESTRICTED_INTEGRATION_POLICY })).policy.providerToolRules, [], 'Empty parent never falls back to generic providers.');
    const { serverPreferencesPath } = await import('../app/lib/terminal-policy');
    const preferencesFile = serverPreferencesPath();
    await mkdir(path.dirname(preferencesFile), { recursive: true });
    await writeFile(preferencesFile, JSON.stringify({ settings: { integrationToolGatewayEnabled: false } }));
    const { getPiTools } = await import('../app/lib/pi/tool-registry');
    const emptyTools = await getPiTools('alice', emptyChild.agentId, emptyChild.sessionId, { executionContext: emptyChild });
    assert(emptyTools.some(tool => tool.name === 'integrations'), 'The actual empty delegated frame receives the finite gateway with the experiment disabled.');
    assert(!emptyTools.some(tool => ['mcp', 'COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'composio_execute'].includes(tool.name)),
      'Finite delegated frames never construct the unrestricted legacy integration entrypoints.');

    const { prepareStandaloneExtensionSelection, getPreparedStandaloneExtensionBinding } = await import('../app/lib/capabilities/extensions/standalone-preparation');
    const { replaceAgentCapabilityBindings } = await import('../app/lib/agents/capability-bindings');
    const { createStandaloneExtensionSlotRef } = await import('../app/lib/capabilities/extensions/standalone-reference');
    const fixedSources = [shared];
    for (let index = 1; index < 6; index++) fixedSources.push(await createSharedMcpConnection(owner, {
      ownership: { type: 'organization', organizationId: owner.organizationId }, displayName: `Fixed source ${index}`,
      accessMode: 'restricted', grants: [{ targetType: 'user', targetId: 'alice', canUse: true, canManage: false, allowedToolNames: ['read_fixture'] }],
      allowedToolNames: ['read_fixture'], config: { url: `https://fixture.invalid/${index}`, transport: 'http', auth: 'none', enabled: true } }));
    const actor = { userId: 'alice', organizationId: owner.organizationId, workspaceId: 'team', sessionId: 'parent', sourceAgentId: 'bradley', source: 'system' as const };
    const configurations = [];
    for (const connection of fixedSources) {
      const proof = await prepareStandaloneExtensionSelection(actor, { selection: { kind: 'mcp', source: 'mcp', target: {
        kind: 'shared', connectionRef: connection.resource.connectionRef, bindingRevision: connection.resource.bindingRevision } },
      requirement: 'optional', toolCap: ['read_fixture'] });
      configurations.push(getPreparedStandaloneExtensionBinding(proof, actor));
    }
    await replaceAgentCapabilityBindings('bradley', configurations.map((configuration, index) => ({ resourceType: 'connection' as const,
      scopeType: 'organization' as const, resourceId: createStandaloneExtensionSlotRef({ configurationId: configuration.configurationId, source: 'mcp' }),
      name: `Fixed slot ${index}`, extensionConfiguration: configuration })),
    undefined, { workflowMutation: true });
    const largeParent = await effectiveApi.resolveEffectiveExtensionContext({ ...(await contextApi.resolveIntegrationAuthorizationContext({
      actorUserId: 'alice', sessionId: 'parent', policyRevision: 'six-fixed' })).executionContext, agentTurnId: 'six-fixed-parent-turn' });
    const largeSource = await sourceApi.captureDelegatedExtensionSource(largeParent); assert(largeSource);
    assert.equal(sourceApi.readDelegatedExtensionSource(largeSource).privateFixedBindings.length, 6);
    assert.equal(sourceApi.readDelegatedExtensionPublicSelection(largeSource).selections.length, 0,
      'Private fixed slots are independent of the five-entry chat intent contract.');
    const largeChild = await runtime.resolveDelegatedExtensionContextSource(largeSource,
      await task('six-fixed-task', largeParent, 'worker-general'), { delegationId: 'six-fixed-task' });
    assert.equal(largeChild.turnExtensions?.selections.length, 0);
    assert.equal(effectiveApi.readEffectiveExtensionContext(largeChild)?.workflowProjection?.policy.providerToolRules?.length, 6);
    assert.equal(effectiveApi.isIssuedScopedIntegrationTurn(largeChild), true);
    const largeTools = await getPiTools('alice', largeChild.agentId, largeChild.sessionId, { executionContext: largeChild });
    assert(largeTools.some(tool => tool.name === 'integrations'));
    assert(!largeTools.some(tool => ['mcp', 'COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'composio_execute'].includes(tool.name)));

    const firstConfiguration = configurations[0]; assert(firstConfiguration.mode === 'fixed');
    const sameSourceSlots = [firstConfiguration, { ...firstConfiguration, configurationId: 'second-parent-use',
      entry: { ...firstConfiguration.entry, toolCap: ['other_fixture'] } }];
    await replaceAgentCapabilityBindings('bradley', sameSourceSlots.map((configuration, index) => ({ resourceType: 'connection' as const,
      scopeType: 'organization' as const, resourceId: createStandaloneExtensionSlotRef({ configurationId: configuration.configurationId, source: 'mcp' }),
      name: `Same source slot ${index}`, extensionConfiguration: configuration })), undefined, { workflowMutation: true });
    const unionParent = await effectiveApi.resolveEffectiveExtensionContext({ ...(await contextApi.resolveIntegrationAuthorizationContext({
      actorUserId: 'alice', sessionId: 'parent', policyRevision: 'union-parent' })).executionContext, agentTurnId: 'union-parent-turn' });
    const unionSource = await sourceApi.captureDelegatedExtensionSource(unionParent); assert(unionSource);
    const unionBindings = sourceApi.readDelegatedExtensionSource(unionSource).privateFixedBindings;
    assert.equal(unionBindings.length, 1);
    assert.deepEqual([...unionBindings[0].entry.toolCap!].sort(), ['other_fixture', 'read_fixture'],
      'Source capture preserves the real aggregate union for repeated exact provider slots.');

    const revoked = await mutateSharedIntegrationConnection(owner, shared.resource.connectionRef, { expectedMetadataRevision: shared.resource.metadataRevision,
      expectedGrantsRevision: shared.resource.grantsRevision, expectedBindingRevision: shared.resource.bindingRevision, grants: [] });
    await assert.rejects(runtime.resolveDelegatedExtensionContextSource(source, childBase, { delegationId: 'first-task' }),
      'An optional parent source cannot disappear after revocation and grant generic child access.');

    const pluginSource = path.join(root, 'fixture-source', 'delegated-package');
    await mkdir(path.join(pluginSource, '.canvas-plugin'), { recursive: true });
    await writeFile(path.join(pluginSource, '.canvas-plugin', 'plugin.json'), JSON.stringify({ name: 'delegated-package',
      version: '1.0.0', description: 'Actual delegated package', skills: './skills' }));
    for (const name of ['delegated-brief', 'delegated-extra']) {
      await mkdir(path.join(pluginSource, 'skills', name), { recursive: true });
      await writeFile(path.join(pluginSource, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Actual delegated source\n---\n\nHeld ${name} bytes.\n`);
    }
    const { installCanvasPluginFromPath } = await import('../app/lib/plugins/canvas-plugin-registry');
    const { configureCapabilityResource } = await import('../app/lib/capabilities/resources/actions');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const installed = await installCanvasPluginFromPath(pluginSource, { scope: { scopeType: 'organization', organizationId: owner.organizationId },
      enable: true, installedBy: 'owner' });
    assert(installed.success && installed.plugin?.resourceId, installed.error || 'Actual plugin installation failed.');
    const packageOwner = { userId: 'owner', workspaceId: 'team' };
    const adopted = await configureCapabilityResource(packageOwner, installed.plugin.resourceId, {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, ownership: { type: 'team', workspaceId: 'team' }, accessMode: 'restricted',
      grants: [{ targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false }] });
    const descriptor = await packages.inspectCapabilityPackage(packageOwner, adopted.metadata.resourceRef);
    const draft = await packages.createCapabilityPackageDraftAction(packageOwner, { operation: 'edit', resourceRef: adopted.metadata.resourceRef,
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
      expectedPackageRevision: descriptor.state?.packageRevision ?? 0, expectedPublishedRevisionRef: descriptor.state?.currentPublishedRevisionRef ?? null });
    const published = await packages.publishCapabilityPackageDraftAction(packageOwner, { draftRef: draft.draftRef,
      expectedDraftRevision: draft.draftRevision, expectedMetadataRevision: descriptor.resource.metadataRevision,
      expectedGrantsRevision: descriptor.resource.grantsRevision, expectedPackageRevision: descriptor.state?.packageRevision ?? 0,
      expectedPublishedRevisionRef: descriptor.state?.currentPublishedRevisionRef ?? null });
    const { setCapabilityPreference } = await import('../app/lib/capabilities/preference-store');
    await setCapabilityPreference({ userId: 'alice', resourceId: installed.plugin.resourceId, enabled: true });
    await sql.run("UPDATE agents SET workflow_version=1,workflow_revision=workflow_revision+1 WHERE agent_id='bradley'");
    await replaceAgentCapabilityBindings('bradley', [{ resourceType: 'plugin', scopeType: 'organization', resourceId: installed.plugin.resourceId,
      name: 'delegated-package', configuration: { version: 1, resourceRef: published.published.resourceRef,
        publishedRevisionRef: published.published.revisionRef, checksum: published.published.checksum,
        skillSelection: { kind: 'skills', relativeRoots: ['skills/delegated-brief'] },
        selectedSkills: [{ name: 'delegated-brief', relativeRoot: 'skills/delegated-brief' }], declarations: [] } }],
    undefined, { workflowMutation: true });
    await sql.run("UPDATE agents SET relevant_skills_json='[\"delegated-brief\"]',revision=revision+1 WHERE agent_id='worker-general'");
    const packageParent = await effectiveApi.resolveEffectiveExtensionContext({ ...(await contextApi.resolveIntegrationAuthorizationContext({
      actorUserId: 'alice', sessionId: 'parent', policyRevision: 'package-parent' })).executionContext, agentTurnId: 'package-parent-turn' });
    const packageSource = await sourceApi.captureDelegatedExtensionSource(packageParent); assert(packageSource);
    assert.equal(sourceApi.readDelegatedExtensionPublicSelection(packageSource).selections.length, 0);
    const packageChild = await runtime.resolveDelegatedExtensionContextSource(packageSource,
      await task('package-task', packageParent, 'worker-general'), { delegationId: 'package-task' });
    const childPackages = effectiveApi.readEffectiveExtensionContext(packageChild); assert(childPackages);
    assert.deepEqual(childPackages.packageSelection.packages.map(pkg => [pkg.resourceRef, pkg.publishedRevisionRef]),
      [[published.published.resourceRef, published.published.revisionRef]], 'A real managed legacy child retains the private parent pin through fresh child use.');
    assert.deepEqual(childPackages.packageSelection.packages[0].selectedSkills.map(skill => skill.name), ['delegated-brief']);
    assert.equal(packageChild.turnExtensions?.selections.length, 0, 'No fake chat selection encodes a fixed parent package.');
    assert(packageChild.skillPackageBindings?.some(binding => binding.publishedRevisionRef === published.published.revisionRef
      && binding.skillName === 'delegated-brief'));
    assert(!packageChild.skillPackageBindings?.some(binding => binding.skillName === 'delegated-extra'));
    await sql.run("UPDATE agents SET relevant_skills_json='[\"delegated-extra\"]',revision=revision+1 WHERE agent_id='worker-general'");
    await assert.rejects(runtime.resolveDelegatedExtensionContextSource(packageSource,
      await task('package-denied-task', packageParent, 'worker-general'), { delegationId: 'package-denied-task' }),
    'The actual child inherited skill ceiling cannot be expanded by a genuine parent package source.');

    await mutateSharedIntegrationConnection(owner, shared.resource.connectionRef, { expectedMetadataRevision: revoked.resource.metadataRevision,
      expectedGrantsRevision: revoked.resource.grantsRevision, expectedBindingRevision: revoked.resource.bindingRevision,
      grants: [{ targetType: 'user', targetId: 'alice', canUse: true, canManage: false, allowedToolNames: ['read_fixture', 'other_fixture'] }] });
    await sql.run("DELETE FROM agent_capability_bindings WHERE agent_id='bradley'");
    await sql.run("UPDATE agents SET workflow_version=NULL,workflow_revision=workflow_revision+1 WHERE agent_id='bradley'");
    await sql.run("INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,owner_user_id,enabled_tools_json,workflow_version,workflow_revision,revision,created_at,updated_at) VALUES ('worker-fixed','Fixed Worker','special','restricted','organization','delegated-source-org','owner','[]',2,1,1,1,1)");
    await sql.run("INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,can_use,can_edit,can_manage,created_at,updated_at) VALUES ('grant-worker-fixed','worker-fixed','delegated-source-org','workspace','team',1,0,0,1,1)");
    const chosenA = configurations[0], chosenB = configurations[1]; assert(chosenA.mode === 'fixed' && chosenB.mode === 'fixed');
    const choices = { version: 1 as const, kind: 'standalone' as const, mode: 'selectable' as const, configurationId: 'actual-child-account-choice',
      source: 'mcp' as const, requirement: 'optional' as const, defaultChoiceId: 'b',
      allowedChoices: [{ choiceId: 'a', selection: chosenA.entry.selection, target: chosenA.entry.target, toolCap: ['read_fixture', 'other_fixture'] },
        { choiceId: 'b', selection: chosenB.entry.selection, target: chosenB.entry.target, toolCap: ['read_fixture'] }] };
    await replaceAgentCapabilityBindings('worker-fixed', [{ resourceType: 'connection', scopeType: 'organization',
      resourceId: createStandaloneExtensionSlotRef({ configurationId: choices.configurationId, source: 'mcp' }), name: 'Actual child account choice',
      extensionConfiguration: choices }], undefined, { workflowMutation: true });
    const allowedAlternativeSource = await sourceApi.captureDelegatedExtensionSource(parent); assert(allowedAlternativeSource);
    const alternativeChild = await runtime.resolveDelegatedExtensionContextSource(allowedAlternativeSource,
      await task('allowed-alternative-task', parent, 'worker-fixed'), { delegationId: 'allowed-alternative-task' });
    const alternativeData = effectiveApi.readEffectiveExtensionContext(alternativeChild); assert(alternativeData);
    assert.deepEqual(alternativeData.workflowProjection?.policy.providerToolRules?.map(rule => [rule.providerRef, rule.allowedToolNames]),
      [[ref, ['read_fixture']]], 'Actual fixed child may choose the exact allowed parent source and must intersect its wider configured cap.');
    const { selectAgentStandaloneExtension } = await import('../app/lib/capabilities/extensions/standalone-runtime');
    assert.deepEqual(selectAgentStandaloneExtension(choices, alternativeData.packageSelection.snapshot, 'alice').choice?.selection,
      chosenB.entry.selection, 'Delegated focus does not change the stored default account.');
    await replaceAgentCapabilityBindings('worker-fixed', [{ resourceType: 'connection', scopeType: 'organization',
      resourceId: createStandaloneExtensionSlotRef({ configurationId: chosenB.configurationId, source: 'mcp' }), name: 'Child source B only',
      extensionConfiguration: chosenB }], undefined, { workflowMutation: true });
    const noOverlapChild = await runtime.resolveDelegatedExtensionContextSource(allowedAlternativeSource,
      await task('no-overlap-task', parent, 'worker-fixed'), { delegationId: 'no-overlap-task' });
    assert.equal(noOverlapChild.turnExtensions?.selections.length, 0);
    assert.deepEqual((await resolveIntegrationRuntimePolicy({ executionContext: noOverlapChild,
      ceiling: UNRESTRICTED_INTEGRATION_POLICY })).policy.providerToolRules, [], 'Disjoint fixed child slots never gain the parent source or their unrelated default.');

    const { PiDelegationDispatcher } = await import('../app/lib/pi/delegation-dispatcher');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const started: Array<import('../app/lib/pi/delegate-task-tool').DelegateTaskRequest> = [];
    const queue = new PiDelegationDispatcher({ maxConcurrency: 1, pollIntervalMs: 60_000, recoverInterrupted: false,
      startDelegatedRunFn: async request => {
        started.push(request);
        if (request.goal !== 'fixture blocker') {
          assert(request.delegatedExtensionSource, 'The SQL reconstructed request receives its actual issued parent source.');
          const realParent = sourceApi.readDelegatedExtensionParentContext(request.delegatedExtensionSource);
          assert.equal(realParent.sessionId, parent.sessionId);
          assert.equal(realParent.agentTurnId, parent.agentTurnId);
          assert.equal(realParent.turnExtensionSource, parent.turnExtensionSource);
        }
        return { delegation_id: request.delegationId, status: request.goal === 'fixture blocker' ? 'accepted' : 'ok', worker_type: 'ephemeral',
          source_agent_id: request.sourceAgentId, session_id: request.workerSessionId!, wait_for_result: false, timeout_seconds: 0 };
      }, deliverCompletionFn: async () => {} });
    const waitFor = async (predicate: () => boolean) => {
      const expires = Date.now() + 5_000;
      while (!predicate()) { assert(Date.now() < expires, 'Actual dispatcher did not reach the expected fixture state.');
        await new Promise(resolve => setTimeout(resolve, 10)); }
    };
    try {
      await queue.initialize(); // Deliberately initialized outside parent AsyncLocalStorage.
      const request = (goal: string) => ({ userId: 'alice', sourceAgentId: 'bradley', sourceSessionId: 'parent', goal,
        toolsets: ['mcp'], waitForResult: false, timeoutSeconds: 0 });
      await queue.enqueue(request('fixture blocker'));
      await waitFor(() => started.length === 1);
      await runWithAgentExecutionContext(parent, () => queue.enqueue(request('actual finite queued source')));
      assert.equal(started.length, 1, 'Finite source task remains queued after the originating turn returns.');
      await started[0].onCompletion?.({ status: 'ok', worker_type: 'ephemeral', source_agent_id: 'bradley',
        session_id: started[0].workerSessionId!, wait_for_result: false, timeout_seconds: 0 });
      await waitFor(() => started.length === 2);
      await waitFor(() => queue.getActiveCount() === 0);
    } finally { queue.stop(); }
    console.log('PASS actual PGlite delegated source: real Parent/Child/task and delayed queue proofs, original cap/native ceiling, clone/task/role/revocation fences, finite flagOFF registry, empty/six-source parents, aggregate cap union, private package pin/skill ceiling, exact fixed-child alternative and disjoint slots.');
  } finally {
    modules._load = original;
    await database.close();
    const unlock = async (directory: string): Promise<void> => {
      await chmod(directory, 0o700);
      for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await unlock(path.join(directory, entry.name));
    };
    await unlock(root);
    await rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
