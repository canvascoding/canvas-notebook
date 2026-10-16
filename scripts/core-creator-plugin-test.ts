import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { createPiTestDatabase } from './helpers/pi-test-database';

function toolDetails(value: unknown): Record<string, unknown> {
  return (value as { details: Record<string, unknown> }).details;
}

/** Bundled Core sources, SQL authority, the real gateway and actual scoped file reads; no provider calls. */
async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-core-creator-'));
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_ORGANIZATION_ID: 'creator-core-org', CANVAS_DEPLOYMENT_MODE: 'team',
    CANVAS_TEAM_FEATURES_ENABLED: 'true', QMD_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false',
    CANVAS_PLUGIN_STORE_REGISTRY_URL: pathToFileURL(path.join(root, 'store.json')).href,
    BASE_URL: 'http://127.0.0.1:3000', BETTER_AUTH_BASE_URL: 'http://127.0.0.1:3000' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const database = await createPiTestDatabase(), raw = await database.openDb();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const original = loader._load, originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw new Error('No provider or network call is permitted in this Core fixture.'); };
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return database;
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return { getModels: () => [], getProviders: () => [],
      registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false };
    if (name === '@/app/lib/pi/live-runtime' || name.endsWith('/pi/live-runtime.ts')) return { requestPiRuntimePromptRefreshForUser: async () => {} };
    return original(name, parent, isMain);
  };
  try {
    await fs.writeFile(path.join(root, 'store.json'), JSON.stringify({ schemaVersion: 1, id: 'core-fixture-store', name: 'Core fixture Store',
      updatedAt: '2026-10-16', skills: [], plugins: [] }));
    for (const id of ['owner', 'reader']) await raw.run('INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at) VALUES ($1,$1,$2,1,\'user\',0,1000,1000)',
      [id, `${id}@core-creator.fixture.invalid`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('creator-core-org','owner','team',1,1000,1000)");
    for (const id of ['owner', 'reader']) {
      await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('creator-core-org',$1,$2,'active',$3,1000,1000)",
        [id, id === 'owner' ? 'owner' : 'member', Number(id === 'owner')]);
      await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,'creator-core-org','personal',$2,$1,$2,'active',1000,1000)", [`personal-${id}`, id]);
    }
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    const storage = await import('../app/lib/agents/storage');
    await storage.writePiRuntimeConfig({ ...DEFAULT_PI_CONFIG, runtimeMigrations: { skillToolsDefaultEnabled: true } });
    const agents = await import('../app/lib/agents/registry');
    const profile = await agents.createAgentProfile({ agentId: 'legacy-plugin-creator', name: 'Existing Creator agent', scopeType: 'user', ownerUserId: 'reader',
      organizationId: 'creator-core-org', createdByUserId: 'reader', relevantSkills: ['create-plugin'], relevantConnections: [],
      enabledTools: ['read', 'search_canvas_extensions'], accessPolicy: 'restricted' });
    // Persist a genuine historical inheritance header, rather than pretending an empty V2 configuration is legacy.
    await agents.updateAgentProfile({ agentId: profile.agentId, expectedRevision: profile.revision,
      workflowVersion: null, workflowRevision: 0, expectedWorkflowRevision: profile.workflowRevision ?? 0 });
    for (const [id, agentId] of [['owner', storage.DEFAULT_MANAGED_AGENT_ID], ['reader', profile.agentId]]) {
      await raw.run(`INSERT INTO pi_sessions (session_id,user_id,agent_id,provider,model,session_kind,organization_id,workspace_id,workspace_type,workspace_name,created_at,updated_at)
        VALUES ($1,$2,$3,'fixture','offline','conversation','creator-core-org',$4,'personal',$2,1000,1000)`, [`creator-${id}`, id, agentId, `personal-${id}`]);
    }
    const registry = await import('../app/lib/plugins/canvas-plugin-registry');
    const resources = await import('../app/lib/capabilities/resources/actions');
    const catalog = await import('../app/lib/capabilities/catalog');
    const { createCapabilityResourceId } = await import('../app/lib/capabilities/reference');
    const coreId = createCapabilityResourceId({ resourceType: 'plugin', scopeType: 'system', sourceType: 'core', name: 'plugin-creator' });
    const creatorId = createCapabilityResourceId({ resourceType: 'skill', scopeType: 'system', sourceType: 'core', name: 'create-plugin' });
    const skillCreatorId = createCapabilityResourceId({ resourceType: 'skill', scopeType: 'system', sourceType: 'core', name: 'skill-creator' });
    const actor = { userId: 'reader', workspaceId: 'personal-reader' }, owner = { userId: 'owner', workspaceId: 'personal-owner' };
    const listed = await resources.listCapabilityResources(actor);
    const plugin = listed.find(value => value.artifact.resourceId === coreId); assert(plugin, 'The real readable catalog must expose the bundled Core plugin.');
    assert.equal(plugin.metadata.ownership.type, 'system'); assert.equal(plugin.activation?.enabled, true);
    assert.deepEqual(plugin.access, { canRead: true, canUse: true, canEdit: false, canManage: false });
    assert.equal(listed.filter(value => value.artifact.name === 'plugin-creator' && value.artifact.resourceType === 'plugin').length, 1);
    assert.equal(listed.filter(value => value.artifact.name === 'create-plugin').length, 1, 'Seed membership must not create a second plugin-child identity for the old Core skill.');
    assert(listed.some(value => value.artifact.resourceId === creatorId));
    assert(listed.some(value => value.artifact.resourceId === skillCreatorId && value.artifact.sourceType === 'core'));
    const visual = listed.find(value => value.artifact.name === 'plugin-visual'); assert(visual);
    assert.equal(visual.artifact.sourceType, 'plugin'); assert.equal(visual.artifact.sourcePluginId, coreId);
    const core = await registry.getCanvasPlugin('plugin-creator', { userId: 'reader' }); assert(core?.core);
    assert.equal(core.sourceType, 'core'); assert(core.enabled);
    assert.equal(core.installDir, path.join(process.cwd(), 'seed_plugins/plugin-creator'));
    assert.deepEqual(core.skills.map(skill => skill.name).sort(), ['create-plugin', 'plugin-visual']);
    assert.equal((await registry.listCanvasPlugins({ userId: 'reader' })).filter(value => value.name === core.name).length, 1);
    const { listPluginWorkspaceCatalog, parsePluginWorkspaceCatalogQuery } = await import('../app/lib/plugins/plugin-workspace-catalog');
    const management = await listPluginWorkspaceCatalog(actor, parsePluginWorkspaceCatalogQuery(new URLSearchParams({ q: '', scope: 'system', limit: '50' })));
    assert.equal(management.items.filter(value => value.name === core.name).length, 1);
    assert.equal(management.items.filter(value => value.name === 'create-plugin').length, 1);
    assert.equal(management.items.find(value => value.name === 'plugin-visual')?.parentResourceRef, plugin.metadata.resourceRef);

    const { writeEnabledSkillsForScope } = await import('../app/lib/skills/skill-settings');
    const { DISABLED_ALL_SKILLS_SENTINEL } = await import('../app/lib/skills/enabled-skills');
    await writeEnabledSkillsForScope([DISABLED_ALL_SKILLS_SENTINEL], { scope: { userId: 'reader' } });
    const preferences = await import('../app/lib/capabilities/preference-store');
    await preferences.setCapabilityPreference({ userId: 'reader', resourceId: coreId, enabled: false });
    const enabled = await catalog.resolveEffectiveCapabilitySnapshot({ ...actor, organizationId: 'creator-core-org', role: 'member' });
    assert.equal(enabled.capabilities.find(value => value.ref.resourceId === coreId)?.effectiveEnabled, true, 'Stored old disable preferences cannot turn off the Core plugin.');
    assert.equal(enabled.capabilities.filter(value => value.ref.name === 'create-plugin').length, 1);

    const sessions = await import('../app/lib/pi/session-workspace-context');
    const context = await sessions.resolveAgentExecutionContextForSession({ userId: 'reader', sessionId: 'creator-reader', agentId: profile.agentId });
    const execution = await import('../app/lib/pi/agent-execution-context');
    const runtime = await import('../app/lib/capabilities/packages/runtime-bindings');
    const effectiveApi = await import('../app/lib/capabilities/extensions/effective-context');
    const fresh = await import('../app/lib/skills/fresh-agent-skill-read-roots');
    const metadata = effectiveApi.readEffectiveExtensionContext(context); assert(metadata);
    assert.equal(metadata.mode, 'legacy_specialized');
    assert.equal(metadata.skills.filter(skill => skill.name === 'create-plugin').length, 1);
    assert(metadata.skills.some(skill => skill.resourceId === skillCreatorId));
    const visualMetadata = metadata.skills.find(skill => skill.name === 'plugin-visual'); assert(visualMetadata?.coreSource);
    assert.equal(visualMetadata.core, false, 'A precise dependency does not become a globally selected Core skill.');
    assert.equal(visualMetadata.origin, 'plugin'); assert.equal(visualMetadata.coreSource.parentResourceId, coreId);
    assert.equal(visualMetadata.coreSource.parentChecksum, core.checksum);
    assert.equal(context.skillPackageBindings?.length, 0, 'Bundled Core content must not pretend to be a published SQL package.');
    assert.equal(context.corePluginSkillBindings?.length, 1);
    assert(context.corePluginSkillBindings);
    const binding = context.corePluginSkillBindings[0];
    assert.equal(binding.runtimePath, visualMetadata.runtimePath);
    const { readExactPackageInventory } = await import('../app/lib/capabilities/packages/io');
    assert.equal(binding.checksum, (await readExactPackageInventory(path.dirname(binding.runtimePath))).checksum);
    assert((await fresh.resolveFreshAgentSkillReadRoots(context)).includes(path.dirname(binding.runtimePath)));
    const { piTools } = await import('../app/lib/pi/core-tools');
    const { wrapToolWithExecutionContext } = await import('../app/lib/pi/tool-runtime-helpers');
    const read = piTools.find(tool => tool.name === 'read'); assert(read);
    const actualRead = wrapToolWithExecutionContext(read, context);
    const visualBody = await fs.readFile(binding.runtimePath, 'utf8');
    assert(JSON.stringify((await actualRead.execute('read-visual', { path: binding.runtimePath })).content).includes(JSON.stringify(visualBody).slice(1, -1)),
      'The actual scoped read opens the complete packaged visual instructions.');
    const creator = metadata.skills.find(skill => skill.name === 'create-plugin'); assert(creator);
    const creatorBody = await fs.readFile(creator.runtimePath, 'utf8');
    assert(JSON.stringify((await actualRead.execute('read-creator', { path: creator.runtimePath })).content).includes(JSON.stringify(creatorBody).slice(1, -1)));
    const forged = { ...context, corePluginSkillBindings: structuredClone(context.corePluginSkillBindings) };
    assert(!(await fresh.resolveFreshAgentSkillReadRoots(forged)).includes(path.dirname(binding.runtimePath)), 'Copied Core checksums and paths cannot reissue an actor-bound receipt.');
    assert(!(await runtime.loadCapabilityPackageRuntimeSkills(forged)).some(skill => skill.name === 'plugin-visual'));
    const wrongActor = { ...context, sessionId: 'foreign-session' };
    assert.equal((await runtime.getAuthorizedCorePluginSkillRuntimeBindings(wrongActor)).length, 0);
    const { appendEffectiveExtensionContextPrompt } = await import('../app/lib/capabilities/extensions/runtime-prompt');
    const prompt = appendEffectiveExtensionContextPrompt('Core fixture', context, [read], 'Create a plugin visual');
    assert(prompt.includes(binding.runtimePath)); assert(prompt.includes(creator.runtimePath));
    assert(!prompt.includes('publishedRevisionRef":"canvas-package-revision:'), 'The Core context must not invent immutable SQL revision identities.');
    const scoped = await import('../app/lib/pi/scoped-tools');
    const progressive = await import('../app/lib/pi/progressive-tool-gateway');
    const { createExtensionDiscoveryTool } = await import('../app/lib/pi/extension-discovery-tool');
    const definition = progressive.PROGRESSIVE_GATEWAY_DEFINITIONS.find(value => value.name === 'canvas_extensions'); assert(definition);
    const gateway = progressive.createProgressiveGatewayTool(definition,
      [...scoped.createUserScopedTools('reader', profile.agentId, 'creator-reader'), createExtensionDiscoveryTool('reader', profile.agentId, 'creator-reader')]);
    const search = await execution.runWithAgentExecutionContext(context, () => gateway.execute('creator-search', {
      action: 'call', operation: 'search_canvas_extensions', arguments: { query: 'creator', types: ['plugin', 'skill'], limit: 20 } }));
    assert.equal(toolDetails(search).error, undefined, JSON.stringify(search));
    const found = (toolDetails(search).extensionDiscovery as { items: Array<{ id: string; name: string; status?: string; coreSource?: unknown; package?: unknown }> }).items;
    assert.equal(found.filter(value => value.name === 'create-plugin').length, 0, 'A returned Core Creator plugin groups its legacy entry in mixed discovery.');
    assert.equal(found.filter(value => value.name === 'plugin-creator').length, 1);
    const foundCore = found.find(value => value.id === coreId); assert(foundCore?.coreSource);
    assert.equal(foundCore.status, 'ready'); assert.equal(foundCore.package, undefined);
    const legacySearch = await execution.runWithAgentExecutionContext(context, () => gateway.execute('legacy-creator-search', {
      action: 'call', operation: 'search_canvas_extensions', arguments: { query: 'create-plugin', types: ['skill'], limit: 20 } }));
    assert.equal((toolDetails(legacySearch).extensionDiscovery as { items: Array<{ id: string }> }).items.filter(value => value.id === creatorId).length, 1,
      'An explicit legacy skill lookup keeps its exact old Core identity.');
    const visualSearch = await execution.runWithAgentExecutionContext(context, () => gateway.execute('visual-search', {
      action: 'call', operation: 'search_canvas_extensions', arguments: { query: 'plugin-visual', types: ['skill'], limit: 20 } }));
    assert.equal((toolDetails(visualSearch).extensionDiscovery as { items: Array<{ name: string }> }).items.filter(value => value.name === 'plugin-visual').length, 1);

    const ownerContext = await sessions.resolveAgentExecutionContextForSession({ userId: 'owner', sessionId: 'creator-owner', agentId: storage.DEFAULT_MANAGED_AGENT_ID });
    const options = await import('../app/lib/agents/extension-options');
    const discovered = await options.listManagedAgentExtensionOptions({ ...owner, source: 'api' }, {
      operation: 'search', target: { kind: 'prospective', scopeType: 'user' }, q: 'plugin-creator', types: ['plugin'], stock: 'installed', scope: 'system', limit: 20,
    });
    assert.equal(discovered.operation, 'search');
    if (discovered.operation !== 'search') throw new Error('Wrong options operation.');
    const exactOption = discovered.items.find(value => value.item.id === coreId); assert(exactOption);
    assert.equal(exactOption.eligibility.action, 'select');
    assert.equal(exactOption.selection?.kind, 'core_plugin');
    if (exactOption.selection?.kind !== 'core_plugin') throw new Error('The Core plugin needs its actual source contract.');
    assert.equal(exactOption.selection.coreSource.checksum, core.checksum);
    assert.equal(exactOption.publishedVersions, undefined, 'Core options never invent SQL package versions.');
    const coreEntry = { selection: exactOption.selection, requirement: 'required' as const, toolCap: null };
    const managementActions = await import('../app/lib/agents/management-actions');
    const explicit = await managementActions.createManagedAgent({ ...owner, source: 'api' }, {
      name: 'Explicit Core Creator', scopeType: 'user', extensions: { version: 1, origin: 'agent_configuration', mode: 'fixed',
        selections: [coreEntry], workflow: null, standalone: [] },
      enabledTools: ['read', 'search_canvas_extensions'],
    });
    await raw.run(`INSERT INTO pi_sessions (session_id,user_id,agent_id,provider,model,session_kind,organization_id,workspace_id,workspace_type,workspace_name,created_at,updated_at)
      VALUES ('creator-fixed','owner',$1,'fixture','offline','conversation','creator-core-org','personal-owner','personal','owner',1000,1000)`, [explicit.agent.agentId]);
    const fixedContext = await sessions.resolveAgentExecutionContextForSession({ userId: 'owner', sessionId: 'creator-fixed', agentId: explicit.agent.agentId });
    const fixedData = effectiveApi.readEffectiveExtensionContext(fixedContext); assert(fixedData);
    assert.equal(fixedData.mode, 'fixed'); assert.equal(fixedData.packages.length, 0);
    assert.equal(fixedData.corePackages?.length, 1);
    assert(fixedData.corePackages);
    assert.deepEqual(fixedData.corePackages[0].coreSource, exactOption.selection.coreSource);
    assert.deepEqual(fixedData.corePackages[0].skills.map(skill => skill.name).sort(), ['create-plugin', 'plugin-visual']);
    assert(fixedData.corePackages[0].skills.every(skill => skill.required), 'The persisted Core requirement reaches both actual member metadata entries.');
    assert.equal(fixedContext.skillPackageBindings?.length, 0);
    const fixedPrompt = appendEffectiveExtensionContextPrompt('Core fixed fixture', fixedContext, [read], 'Create an organizational plugin');
    assert(fixedPrompt.includes(core.checksum)); assert(fixedPrompt.includes(binding.runtimePath));
    const fixedRead = await wrapToolWithExecutionContext(read, fixedContext).execute('fixed-visual-read', { path: binding.runtimePath });
    assert(JSON.stringify(fixedRead.content).includes(JSON.stringify(visualBody).slice(1, -1)));
    const { getPiTools } = await import('../app/lib/pi/tool-registry');
    const { buildEffectiveToolManifest } = await import('../app/lib/pi/effective-tool-manifest');
    const fixedTools = await getPiTools('owner', explicit.agent.agentId, 'creator-fixed', { executionContext: fixedContext });
    const toolManifest = buildEffectiveToolManifest(fixedTools);
    assert.deepEqual([...toolManifest.registeredToolNames].sort(), ['canvas_extensions', 'read']);
    assert.deepEqual(toolManifest.gateways.find(value => value.toolName === 'canvas_extensions')?.allowedOperationNames, ['search_canvas_extensions'],
      'The Core source and its visual dependency add no package mutation or integration operation to the real Agent tool set.');
    const acceptedApi = await import('../app/lib/capabilities/extensions/accepted-turn-selection');
    const turns = await import('../app/lib/capabilities/extensions/turn-runtime');
    const intakeContext = { ...ownerContext, agentTurnId: randomUUID() };
    const coreInput = { version: 1 as const, origin: 'turn_reference' as const, selections: [coreEntry] };
    const accepted = await acceptedApi.prepareAcceptedTurnExtensionSelection(intakeContext, coreInput);
    const turnContext: AgentExecutionContext = { ...ownerContext, agentTurnId: randomUUID(),
      turnExtensions: acceptedApi.readAcceptedTurnExtensionSelection(accepted, intakeContext).publicSelection };
    const turnSelection = await runtime.getAuthorizedAgentWorkflowPackageSelections(turnContext);
    turnContext.turnExtensionSource = await turns.reissueAcceptedTurnRuntimeSelection(turnContext, accepted, intakeContext, { packageSelection: turnSelection });
    const compiledTurn = await effectiveApi.resolveEffectiveExtensionContext(turnContext, { packageSelection: turnSelection });
    const turnData = effectiveApi.readEffectiveExtensionContext(compiledTurn); assert(turnData);
    assert.equal(turnData.corePackages?.length, 1); assert.equal(turnData.packages.length, 0);
    assert(turnData.corePackages);
    assert.deepEqual(turnData.corePackages[0].coreSource, exactOption.selection.coreSource);
    assert.deepEqual(turnData.corePackages[0].skills.map(skill => skill.name).sort(), ['create-plugin', 'plugin-visual']);
    assert.equal(effectiveApi.isIssuedScopedIntegrationTurn(compiledTurn), true);
    assert.deepEqual(turnData.workflowProjection?.selectedProviders, []);
    assert.deepEqual(turnData.workflowProjection?.policy.providerToolRules, [], 'The actual Core-only projection retains an empty provider permission matrix.');
    assert(turnData.workflowProjection);
    const { isIntegrationProviderOperationAllowed } = await import('../app/lib/integration-tools/policy');
    assert.equal(isIntegrationProviderOperationAllowed(turnData.workflowProjection.policy, 'composio', `composio:v1:personal:${'a'.repeat(64)}`, 'call'), false,
      'The real policy evaluator must deny provider calls even though the source-level filter is unrestricted.');
    const turnRead = await wrapToolWithExecutionContext(read, compiledTurn).execute('turn-visual-read', { path: binding.runtimePath });
    assert(JSON.stringify(turnRead.content).includes(JSON.stringify(visualBody).slice(1, -1)));
    await assert.rejects(acceptedApi.prepareAcceptedTurnExtensionSelection(intakeContext, { ...coreInput, selections: [{ ...coreEntry,
      selection: { ...exactOption.selection, coreSource: { ...exactOption.selection.coreSource, checksum: '0'.repeat(64) } } }] }),
    'A stale exact Core source cannot become an accepted turn.');
    const emptyFixed = await managementActions.createManagedAgent({ ...owner, source: 'api' }, {
      name: 'Fixed without selected Core plugin', scopeType: 'user', extensions: { version: 1, origin: 'agent_configuration', mode: 'fixed',
        selections: [], workflow: null, standalone: [] }, enabledTools: ['read', 'search_canvas_extensions'],
    });
    await raw.run(`INSERT INTO pi_sessions (session_id,user_id,agent_id,provider,model,session_kind,organization_id,workspace_id,workspace_type,workspace_name,created_at,updated_at)
      VALUES ('creator-empty-fixed','owner',$1,'fixture','offline','conversation','creator-core-org','personal-owner','personal','owner',1000,1000)`, [emptyFixed.agent.agentId]);
    const emptyContext = await sessions.resolveAgentExecutionContextForSession({ userId: 'owner', sessionId: 'creator-empty-fixed', agentId: emptyFixed.agent.agentId });
    const emptySelection = await runtime.getAuthorizedAgentWorkflowPackageSelections(emptyContext);
    assert(!(await runtime.getAuthorizedAgentWorkflowDiscoveryPackages(emptySelection, emptyContext)).some(plugin => plugin.resourceId === coreId),
      'The fixed runtime discovery mask does not attach an unconfigured Core plugin.');
    const emptyIntake = { ...emptyContext, agentTurnId: randomUUID() };
    const malicious = await acceptedApi.prepareAcceptedTurnExtensionSelection(emptyIntake, coreInput);
    await assert.rejects(runtime.getAuthorizedAgentWorkflowPackageSelections({ ...emptyContext, agentTurnId: randomUUID(),
      turnExtensions: acceptedApi.readAcceptedTurnExtensionSelection(malicious, emptyIntake).publicSelection }),
    error => [403, 409].includes((error as { status?: number }).status ?? 0), 'Accepted syntax and Core Use cannot expand an empty fixed Agent selection.');
    const ownerGateway = progressive.createProgressiveGatewayTool(definition,
      [...scoped.createUserScopedTools('owner', storage.DEFAULT_MANAGED_AGENT_ID, 'creator-owner'),
        createExtensionDiscoveryTool('owner', storage.DEFAULT_MANAGED_AGENT_ID, 'creator-owner')]);
    const ownerCall = (operation: string, args: Record<string, unknown>) => execution.runWithAgentExecutionContext(ownerContext,
      () => ownerGateway.execute(operation, { action: 'call', operation, arguments: args }));
    await fs.mkdir(path.join(ownerContext.workspaceRoot, 'shadow', '.canvas-plugin'), { recursive: true });
    await fs.mkdir(path.join(ownerContext.workspaceRoot, 'shadow', 'skills', 'shadow-context'), { recursive: true });
    await fs.writeFile(path.join(ownerContext.workspaceRoot, 'shadow', '.canvas-plugin/plugin.json'), JSON.stringify({ name: 'plugin-creator', version: '9.0.0', description: 'Attempted Core replacement', skills: 'skills' }));
    await fs.writeFile(path.join(ownerContext.workspaceRoot, 'shadow', 'skills/shadow-context/SKILL.md'), '---\nname: shadow-context\ndescription: Attempted replacement\n---\nSHADOW_CONTENT\n');
    for (const [operation, args] of [
      ['install_canvas_plugin_from_workspace', { workspacePath: 'shadow' }],
      ['update_canvas_plugin_from_workspace', { pluginName: core.name, workspacePath: 'shadow', expectedVersion: core.version, expectedChecksum: core.checksum }],
      ['set_canvas_plugin_enabled', { pluginName: core.name, enabled: false }],
      ['remove_canvas_plugin', { pluginName: core.name }],
      ['create_canvas_package_draft', { operation: 'edit', resourceRef: plugin.metadata.resourceRef, expectedMetadataRevision: 0, expectedGrantsRevision: 0,
        expectedPackageRevision: 0, expectedPublishedRevisionRef: null }],
      ['create_canvas_package_draft', { operation: 'create', kind: 'plugin', targetName: core.name, requestId: randomUUID() }],
    ] as Array<[string, Record<string, unknown>]>) {
      const denied = toolDetails(await ownerCall(operation, args));
      assert.equal(typeof denied.error, 'string', `${operation} must reject mutation of the actual Core definition.`);
      assert.notEqual(denied.code, 'PACKAGE_NOT_FOUND', 'Protection must not pass because the visible Core resource disappeared.');
    }
    for (const replace of [false, true]) {
      const rejected = await registry.installCanvasPluginFromPath(path.join(ownerContext.workspaceRoot, 'shadow'), { scope: { userId: 'owner' }, replace });
      assert.equal(rejected.success, false); assert.equal(rejected.code, 'CAPABILITY_NAMESPACE_PROTECTED');
    }
    await assert.rejects(resources.configureCapabilityResource(owner, plugin.metadata.resourceRef, {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, ownership: { type: 'organization' }, metadata: { displayName: 'Changed Core' } }), { code: 'CAPABILITY_RESOURCE_READ_ONLY' });
    await assert.rejects(resources.updateCapabilityResource(owner, plugin.metadata.resourceRef, {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, metadata: { displayName: 'Changed Core' } }), { code: 'CAPABILITY_RESOURCE_READ_ONLY' });
    assert.equal((await registry.getCanvasPlugin(core.name, { userId: 'owner' }))?.checksum, core.checksum);
    assert.equal((await raw.get('SELECT COUNT(*)::integer AS count FROM capability_resources WHERE legacy_resource_id=$1', [coreId]) as { count: number }).count, 0,
      'Inspecting or rejecting mutation must not adopt the bundled definition into mutable SQL management.');
    assert.equal((await raw.get('SELECT COUNT(*)::integer AS count FROM capability_package_drafts') as { count: number }).count, 0);
    assert.equal((await raw.get('SELECT COUNT(*)::integer AS count FROM capability_package_versions') as { count: number }).count, 0);
    assert.equal(providerCalls, 0);
    console.log('PASS Core Creator plugin: actual catalog/SQL/gateway, old Creator identities, standalone Skill Creator, precise protected visual dependency and real reads, no duplicate discovery, no fake publication, rejected install/replace/disable/edit/remove/configuration; 0 network/provider calls.');
  } finally {
    loader._load = original; globalThis.fetch = originalFetch;
    await raw.close(); await database.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const unlock = async (directory: string): Promise<void> => {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      await fs.chmod(directory, 0o700);
      for (const entry of await fs.readdir(directory)) await unlock(path.join(directory, entry));
    };
    await unlock(root); await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
