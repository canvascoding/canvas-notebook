import assert from 'node:assert/strict';
import Module from 'node:module';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { createPiTestDatabase } from './helpers/pi-test-database';

function details(result: AgentToolResult<unknown>): Record<string, unknown> {
  assert(result.details && typeof result.details === 'object' && !Array.isArray(result.details));
  return result.details as Record<string, unknown>;
}

/** Actual registry/LivePiRuntime/Agent SDK and persisted SQL authority. No model prompt, provider transport or authorization replacement. */
async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-planning-progressive-'));
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, DATABASE_URL: 'postgresql://127.0.0.1:1/isolated_planning_progressive_fixture', NODE_ENV: 'test',
    CANVAS_ORGANIZATION_ID: 'planning-progressive-org', CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
    QMD_ENABLED: 'false', BASE_URL: 'http://127.0.0.1:1', BETTER_AUTH_BASE_URL: 'http://127.0.0.1:1', CANVAS_MCP_DIRECT_ENABLED: 'false',
    CANVAS_PLUGIN_STORE_REGISTRY_URL: pathToFileURL(path.join(root, 'store.json')).href };
  const previousEnv = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const database = await createPiTestDatabase();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoader = loader._load, originalFetch = globalThis.fetch;
  const actualEsm = new Map<string, unknown>();
  let networkCalls = 0, modelCalls = 0;
  globalThis.fetch = async () => { networkCalls += 1; throw new Error('No network transport is permitted in this planning fixture.'); };
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return database;
    if (actualEsm.has(name)) return actualEsm.get(name);
    return originalLoader(name, parent, isMain);
  };
  let dispose: (() => void) | undefined;
  try {
    const offeringChecksum = 'a'.repeat(64);
    await fs.writeFile(path.join(root, 'store.json'), JSON.stringify({ schemaVersion: 1, id: 'planning-store', name: 'Planning Store', updatedAt: '2026-10-07', skills: [],
      plugins: [{ name: 'planning-offering', description: 'Read-only metadata offering', latestVersion: '1.0.0', versions: { '1.0.0': {
        version: '1.0.0', checksum: offeringChecksum, downloadUrl: './never-download.zip' } } }] }));
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) actualEsm.set(name, await import(name));
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    const { writePiRuntimeConfig } = await import('../app/lib/agents/storage');
    await writePiRuntimeConfig({ ...DEFAULT_PI_CONFIG, runtimeMigrations: { skillToolsDefaultEnabled: true } });
    const raw = await database.openDb();
    for (const id of ['owner', 'reader']) await raw.run(
      'INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at) VALUES ($1,$1,$2,1,\'user\',0,1000,1000)', [id, `${id}@planning-progressive.fixture.invalid`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('planning-progressive-org','owner','team',1,1000,1000)");
    for (const id of ['owner', 'reader']) await raw.run(
      "INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('planning-progressive-org',$1,$2,'active',$3,1000,1000)", [id, id === 'owner' ? 'owner' : 'member', Number(id === 'owner')]);
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ('planning-personal','planning-progressive-org','personal','reader','users/reader/workspaces/planning-personal/files','Fixture personal','active',1000,1000)");
    const registry = await import('../app/lib/plugins/canvas-plugin-registry');
    const source = path.join(root, 'source');
    await fs.mkdir(path.join(source, '.canvas-plugin'), { recursive: true }); await fs.mkdir(path.join(source, 'skills', 'planning-context'), { recursive: true });
    await fs.writeFile(path.join(source, '.canvas-plugin/plugin.json'), JSON.stringify({ name: 'planning-package', version: '1.0.0', description: 'Planning package fixture', skills: 'skills' }));
    await fs.writeFile(path.join(source, 'README.md'), 'Planning may inspect these actual package bytes.\n');
    await fs.writeFile(path.join(source, 'skills', 'planning-context', 'SKILL.md'), '---\nname: planning-context\ndescription: Read-only planning context\nmetadata:\n  version: "1.0.0"\n---\n\nNo executable entrypoint or connector.\n');
    const installed = await registry.installCanvasPluginFromPath(source, { scope: { scopeType: 'organization', organizationId: 'planning-progressive-org' }, enable: false, installedBy: 'owner' });
    assert(installed.success && installed.plugin, installed.error || 'Actual fixture installation failed.');
    const legacyRef = installed.plugin.resourceId; assert(typeof legacyRef === 'string' && legacyRef.length > 0);
    const resources = await import('../app/lib/capabilities/resources/actions');
    const resource = await resources.configureCapabilityResource({ userId: 'owner' }, legacyRef, { expectedMetadataRevision: 0, expectedGrantsRevision: 0, accessMode: 'restricted',
      grants: [{ targetType: 'user', targetId: 'reader', canUse: true, canEdit: false, canManage: false }] });
    const packages = await import('../app/lib/capabilities/packages/actions');
    const publishedDraft = await packages.createCapabilityPackageDraftAction({ userId: 'owner' }, { operation: 'edit',
      resourceRef: resource.metadata.resourceRef, expectedMetadataRevision: resource.metadata.metadataRevision,
      expectedGrantsRevision: resource.metadata.grantsRevision, expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    const published = await packages.publishCapabilityPackageDraftAction({ userId: 'owner' }, {
      draftRef: publishedDraft.draftRef, expectedDraftRevision: publishedDraft.draftRevision, expectedMetadataRevision: resource.metadata.metadataRevision,
      expectedGrantsRevision: resource.metadata.grantsRevision, expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    // Set up actual private recovery state before entering Planning, then remove creation authority.
    await raw.run("UPDATE organization_user_permissions SET role='admin',can_share_plugins_and_skills=1 WHERE user_id='reader'");
    const creationKey = randomUUID();
    const privateDraft = await packages.createCapabilityPackageDraftAction({ userId: 'reader', workspaceId: 'planning-personal' }, {
      operation: 'create', kind: 'skill', targetName: 'planning-private-context', requestId: creationKey,
    });
    const privateWritten = await packages.writeCapabilityPackageDraftFileAction({ userId: 'reader', workspaceId: 'planning-personal' }, privateDraft.draftRef, {
      expectedDraftRevision: privateDraft.draftRevision, path: 'SKILL.md', encoding: 'base64',
      content: Buffer.from('---\nname: planning-private-context\ndescription: Private recovery fixture\nmetadata:\n  version: "1.0.0"\n---\nPLANNING_PRIVATE_DRAFT_BODY\n').toString('base64'),
    });
    await raw.run("UPDATE organization_user_permissions SET role='member',can_share_plugins_and_skills=0 WHERE user_id='reader'");
    const recoveryNames = ['list_canvas_package_drafts', 'inspect_canvas_package_draft_status', 'inspect_canvas_package_operation'];
    const sourceReadNames = ['list_canvas_package_versions', 'inspect_canvas_package_workspace_draft'];
    const compositionNames = ['compose_canvas_package_skills', 'import_canvas_package_workspace_draft'];
    const agents = await import('../app/lib/agents/registry');
    const configuredNames = ['inspect_canvas_package', 'list_canvas_package_store', ...recoveryNames, ...sourceReadNames, ...compositionNames,
      'create_canvas_package_draft', 'read', 'email_list_mailboxes', 'mcp', 'composio_execute'];
    const profile = await agents.createAgentProfile({ agentId: 'planning-worker', name: 'Planning worker', scopeType: 'user', ownerUserId: 'reader', organizationId: 'planning-progressive-org',
      createdByUserId: 'reader', enabledTools: configuredNames, relevantSkills: [], relevantConnections: [], accessPolicy: 'restricted' });
    await raw.run(`INSERT INTO pi_sessions (session_id,user_id,agent_id,provider,model,session_kind,organization_id,workspace_id,workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
      VALUES ('planning-session','reader',$1,'anthropic','offline-model','conversation','planning-progressive-org','planning-personal','personal','Fixture personal','users/reader/workspaces/planning-personal/files',1000,1000)`, [profile.agentId]);
    const { resolveAgentExecutionContextForSession } = await import('../app/lib/pi/session-workspace-context');
    const context = await resolveAgentExecutionContextForSession({ userId: 'reader', sessionId: 'planning-session', agentId: profile.agentId });
    await fs.mkdir(context.workspaceRoot, { recursive: true });
    const { createCanvasSkillDraft } = await import('../app/lib/skills/agent-skill-workspace');
    const legacyDraft = await createCanvasSkillDraft({ workspaceRoot: context.workspaceRoot, scope: { userId: 'reader', organizationId: 'planning-progressive-org' },
      skillName: 'planning-legacy-context', description: 'PLANNING_LEGACY_PRIVATE_BODY', draftId: 'planning-legacy-source', version: '1.0.0' });
    const legacySelector = { kind: 'skill', workspaceDraftId: legacyDraft.draftId, packageName: legacyDraft.skillName };
    const { readExactPackageInventory } = await import('../app/lib/capabilities/packages/io');
    const legacyInventory = await readExactPackageInventory(path.join(context.workspaceRoot, legacyDraft.packagePath));
    const { getPiTools, getPiToolMetadata } = await import('../app/lib/pi/tool-registry');
    const { isProgressiveGatewayTool, withAllowedProgressiveGatewayOperations } = await import('../app/lib/pi/progressive-tool-gateway');
    const { PLANNING_MODE_ALLOWED_TOOLS, filterToolsForPlanningMode } = await import('../app/lib/pi/planning-mode');
    const { buildEffectiveToolManifest } = await import('../app/lib/pi/effective-tool-manifest');
    const { getAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const registered = await getPiTools('reader', profile.agentId, 'planning-session', { executionContext: context, planningMode: true });
    const gateway = registered.find(tool => tool.name === 'canvas_extensions');
    assert(gateway && isProgressiveGatewayTool(gateway), 'Actual registry must collapse the configured package read/write operations.');
    assert.deepEqual(gateway.progressiveGateway.operations.map(tool => tool.name).sort(),
      ['create_canvas_package_draft', 'inspect_canvas_package', 'list_canvas_package_store', ...recoveryNames, ...sourceReadNames, ...compositionNames].sort());
    assert.equal(PLANNING_MODE_ALLOWED_TOOLS.has('inspect_canvas_package'), true);
    assert.equal(PLANNING_MODE_ALLOWED_TOOLS.has('list_canvas_package_store'), true);
    assert.equal(PLANNING_MODE_ALLOWED_TOOLS.has('create_canvas_package_draft'), false);
    for (const operation of recoveryNames) assert.equal(PLANNING_MODE_ALLOWED_TOOLS.has(operation), true);
    assert(registered.some(tool => tool.name === 'email_list_mailboxes'), 'Native email remains a native top-level tool before the effective planning filter.');
    assert(!registered.some(tool => ['mcp', 'composio', 'integrations'].includes(tool.name)), 'Planning construction has no external gateway.');
    const { Agent } = await import('@earendil-works/pi-agent-core');
    const { getModels } = await import('@earendil-works/pi-ai/compat');
    const model = getModels('anthropic')[0]; assert(model, 'Use an actual offline SDK model descriptor, without starting a model request.');
    const agent = new Agent({ initialState: { model, tools: registered, messages: [], systemPrompt: 'Planning fixture', thinkingLevel: 'off' },
      streamFn: async () => { modelCalls += 1; throw new Error('No LLM call is permitted.'); } });
    const { refreshBrowserSessionSnapshot } = await import('../app/lib/pi/browser/session-state-service');
    const { LivePiRuntime } = await import('../app/lib/pi/live-runtime');
    const runtime = new LivePiRuntime({ sessionId: 'planning-session', userId: 'reader', agentId: profile.agentId, provider: model.provider, model,
      systemPrompt: 'Planning fixture', tools: registered, initialMessages: [], executionContext: context, workspaceFileTreePromptBlock: '', memoryPromptBlock: '',
      browserSnapshot: await refreshBrowserSessionSnapshot(context), imageNormalizationOptions: { workspaceImageRoot: context.workspaceRoot, allowedImageFileRoots: [context.workspaceRoot] },
      requestOutputTokenCap: 1024, lastProviderInputUsage: null,
      summary: { summaryText: null, summaryUpdatedAt: null, summaryThroughTimestamp: null, summaryThroughSequence: null, summaryRevision: 0 } }, agent);
    dispose = () => runtime.dispose();
    runtime.setPlanningMode(true); await runtime.reloadTools();
    const effective = buildEffectiveToolManifest(agent.state.tools);
    console.log(`actual planning observation: whitelisted package inspect=true storeRead=true; registeredGateway=true effectiveGateway=${effective.registeredToolNames.includes('canvas_extensions')} networkCalls=${networkCalls} modelCalls=${modelCalls}.`);
    assert(effective.registeredToolNames.includes('canvas_extensions'), 'Actual LivePiRuntime Planning must retain the configured read-only package gateway operations.');
    const effectiveGateway = agent.state.tools.find(tool => tool.name === 'canvas_extensions');
    assert(effectiveGateway && isProgressiveGatewayTool(effectiveGateway));
    const expectedOperations = ['inspect_canvas_package', 'list_canvas_package_store', ...recoveryNames, ...sourceReadNames].sort();
    assert.deepEqual(effectiveGateway.progressiveGateway.operations.map(tool => tool.name).sort(), expectedOperations);
    assert.deepEqual(buildEffectiveToolManifest(filterToolsForPlanningMode(agent.state.tools)), effective, 'Applying Planning twice preserves the exact ceiling.');
    const inspectOnly = withAllowedProgressiveGatewayOperations(gateway, ['inspect_canvas_package']); assert(inspectOnly);
    const filteredInspect = filterToolsForPlanningMode([inspectOnly]); assert.equal(filteredInspect.length, 1);
    assert(isProgressiveGatewayTool(filteredInspect[0]));
    assert.deepEqual(filteredInspect[0].progressiveGateway.operations.map(tool => tool.name), ['inspect_canvas_package']);
    const cannotRegrant = withAllowedProgressiveGatewayOperations(filteredInspect[0], configuredNames); assert(cannotRegrant && isProgressiveGatewayTool(cannotRegrant));
    assert.deepEqual(cannotRegrant.progressiveGateway.operations.map(tool => tool.name), ['inspect_canvas_package']);
    const writeOnly = withAllowedProgressiveGatewayOperations(gateway, ['create_canvas_package_draft']); assert(writeOnly);
    assert.deepEqual(filterToolsForPlanningMode([writeOnly]), [], 'A mutation-only gateway disappears rather than exposing an empty callable schema.');
    assert.equal(withAllowedProgressiveGatewayOperations(effectiveGateway, ['read_canvas_package_file']), null, 'The Planning whitelist never grants a user-disabled operation.');
    const manifestGateway = effective.gateways.find(entry => entry.toolName === 'canvas_extensions'); assert(manifestGateway);
    assert.deepEqual([...manifestGateway.allowedOperationNames].sort(), expectedOperations);
    const systemMessage = agent.state.messages.find(message => message.role === 'system'); assert(systemMessage);
    const prompt = typeof systemMessage.content === 'string' ? systemMessage.content : JSON.stringify(systemMessage.content);
    const operationLine = prompt.split('\n').find(line => line.includes('`canvas_extensions`') && line.includes('permitted operations:')); assert(operationLine);
    for (const name of expectedOperations) assert(operationLine.includes(name));
    assert(!operationLine.includes('create_canvas_package_draft'));
    for (const operation of compositionNames) assert(!operationLine.includes(operation));
    const managementMetadata = await getPiToolMetadata();
    for (const name of expectedOperations) assert.equal(managementMetadata.find(entry => entry.name === name)?.planningModeAllowed, true);
    assert.equal(managementMetadata.find(entry => entry.name === 'create_canvas_package_draft')?.planningModeAllowed, false);
    for (const operation of compositionNames) assert.equal(managementMetadata.find(entry => entry.name === operation)?.planningModeAllowed, false);
    assert(!effective.registeredToolNames.some(name => name.startsWith('email_') || /^(?:mcp|composio|COMPOSIO_|integrations|run_canvas_skill_script)/u.test(name)));
    const invoke = (operation: string, args: Record<string, unknown>) =>
      effectiveGateway.execute(`planning-${operation}`, { action: 'call', operation, arguments: args });
    const search = details(await effectiveGateway.execute('planning-search', { action: 'search' }));
    assert.deepEqual((search.operations as Array<{ name: string }>).map(operation => operation.name).sort(), expectedOperations);
    const describe = details(await effectiveGateway.execute('planning-describe', { action: 'describe', operation: 'inspect_canvas_package' }));
    assert.equal(describe.operation, 'inspect_canvas_package');
    assert((describe.schema as { properties: Record<string, unknown> }).properties.resourceRef);
    assert.equal(getAgentExecutionContext(), null, 'The SDK tool caller must not supply ambient authority.');
    const inspected = details(await invoke('inspect_canvas_package', { resourceRef: resource.metadata.resourceRef }));
    assert.equal(getAgentExecutionContext(), null, 'The actual tool wrapper must restore its caller context after execution.');
    assert.equal(inspected.error, undefined, JSON.stringify(inspected));
    assert(JSON.stringify(inspected).includes('planning-package'));
    assert.equal(getAgentExecutionContext(), null);
    const listed = details(await invoke('list_canvas_package_store', { kind: 'plugin', scope: 'organization', q: 'planning-offering' }));
    assert.equal(getAgentExecutionContext(), null);
    assert.equal(listed.error, undefined, JSON.stringify(listed));
    const storeResult = (listed.capabilityPackage as { result: { stores: Array<{ availability: string; offerings: Array<{ entryKey: string; versions: Array<{ checksum: string }> }> }> } }).result;
    assert.equal(storeResult.stores[0].availability, 'available');
    assert.equal(storeResult.stores[0].offerings[0].entryKey, 'planning-offering');
    assert.equal(storeResult.stores[0].offerings[0].versions[0].checksum, offeringChecksum);
    await assert.rejects(fs.stat(path.join(root, 'never-download.zip')), { code: 'ENOENT' });
    const listedDrafts = details(await invoke('list_canvas_package_drafts', { limit: 1 }));
    assert.equal(listedDrafts.error, undefined, JSON.stringify(listedDrafts));
    const draftMetadata = (listedDrafts.capabilityPackage as { result: { drafts: Array<{ draftRef: string; draftRevision: number }> } }).result;
    assert.equal(draftMetadata.drafts.length, 1); assert.equal(draftMetadata.drafts[0].draftRef, privateDraft.draftRef);
    const status = details(await invoke('inspect_canvas_package_draft_status', { draftRef: privateDraft.draftRef }));
    assert.equal(status.error, undefined, JSON.stringify(status));
    assert.equal((status.capabilityPackage as { result: { status: { draftRevision: number } } }).result.status.draftRevision, privateWritten.draft.draftRevision);
    const recovered = details(await invoke('inspect_canvas_package_operation', { requestId: creationKey }));
    assert.equal(recovered.error, undefined, JSON.stringify(recovered));
    const receipt = (recovered.capabilityPackage as { result: { operation: { status: string; draftRef: string; draftRevision: number } } }).result.operation;
    assert.equal(receipt.status, 'draft'); assert.equal(receipt.draftRef, privateDraft.draftRef);
    assert.equal(receipt.draftRevision, privateWritten.draft.draftRevision);
    for (const metadata of [draftMetadata, status, recovered]) {
      assert(!JSON.stringify(metadata).includes(root));
      assert.doesNotMatch(JSON.stringify(metadata), /PLANNING_PRIVATE_DRAFT_BODY|baseSourceStamp|rootPath|sourceStorage|sourceParentStorage|"files"|"content"/u);
    }
    assert.equal(getAgentExecutionContext(), null, 'Recovery calls also restore the actual runtime caller context.');
    const versions = details(await invoke('list_canvas_package_versions', { resourceRef: resource.metadata.resourceRef }));
    assert.equal(versions.error, undefined, JSON.stringify(versions));
    const publishedVersions = (versions.capabilityPackage as { result: { versions: Array<{ revisionRef: string; checksum: string }> } }).result.versions;
    assert.equal(publishedVersions.length, 1);
    assert.equal(publishedVersions[0].revisionRef, published.published.revisionRef);
    assert.equal(publishedVersions[0].checksum, published.published.checksum, 'Planning source discovery returns an actual persisted immutable pin.');
    const workspaceSource = details(await invoke('inspect_canvas_package_workspace_draft', legacySelector));
    assert.equal(workspaceSource.error, undefined, JSON.stringify(workspaceSource));
    const sourceMetadata = (workspaceSource.capabilityPackage as { result: { source: { checksum: string; fileCount: number; totalBytes: number } } }).result;
    assert.equal(sourceMetadata.source.checksum, legacyInventory.checksum);
    assert.equal(sourceMetadata.source.fileCount, legacyInventory.files.length);
    assert.equal(sourceMetadata.source.totalBytes, legacyInventory.totalBytes);
    assert.deepEqual(Object.keys(sourceMetadata), ['source']);
    for (const metadata of [sourceMetadata, versions]) {
      assert(!JSON.stringify(metadata).includes(root));
      assert.doesNotMatch(JSON.stringify(metadata), /PLANNING_LEGACY_PRIVATE_BODY|workspaceRoot|allowedRoots|rootPath|sourceStorage|sourceParentStorage|"files"|"content"/u);
    }
    const sourceSchema = details(await effectiveGateway.execute('planning-source-schema', { action: 'describe', operation: 'inspect_canvas_package_workspace_draft' }));
    assert(!JSON.stringify(sourceSchema).includes('workspaceRoot'), 'Discovery never grants a callable filesystem root.');
    const blockedComposition = await invoke('compose_canvas_package_skills', { draftRef: privateDraft.draftRef,
      expectedDraftRevision: privateWritten.draft.draftRevision, skills: [{ source: { resourceRef: resource.metadata.resourceRef,
        revisionRef: published.published.revisionRef, expectedChecksum: published.published.checksum, childRelativeRoot: 'skills/planning-context' } }] });
    assert.match(String(details(blockedComposition).error), /not available/u, 'Configured composition is removed before any source read or target mutation.');
    const blockedImport = await invoke('import_canvas_package_workspace_draft', { draftRef: privateDraft.draftRef,
      expectedDraftRevision: privateWritten.draft.draftRevision, source: legacySelector, expectedChecksum: legacyInventory.checksum });
    assert.match(String(details(blockedImport).error), /not available/u, 'Configured legacy import is removed before any source copy or target mutation.');
    assert.equal((await readExactPackageInventory(path.join(context.workspaceRoot, legacyDraft.packagePath))).checksum, legacyInventory.checksum);
    for (const operation of ['create_canvas_package_draft', 'publish_canvas_package_draft', 'install_canvas_package_from_store', 'run_canvas_skill_script',
      'mcp', 'composio_execute', 'COMPOSIO_MANAGE_CONNECTIONS', 'email_list_mailboxes']) {
      assert.match(String(details(await invoke(operation, {})).error), /not available/u, `${operation} must be denied before its body executes.`);
    }
    const draftCount = await raw.get('SELECT COUNT(*)::int AS count FROM capability_package_drafts') as { count: number };
    assert.equal(draftCount.count, 1, 'Blocked Planning mutations must not add to the prepared recovery fixture.');
    const unchangedDraft = await raw.get('SELECT draft_revision FROM capability_package_drafts WHERE draft_ref=$1', [privateDraft.draftRef]) as { draft_revision: number };
    assert.equal(unchangedDraft.draft_revision, privateWritten.draft.draftRevision);
    const revoked = await resources.updateCapabilityResource({ userId: 'owner' }, resource.metadata.resourceRef, {
      expectedMetadataRevision: resource.metadata.metadataRevision, expectedGrantsRevision: resource.metadata.grantsRevision, grants: [] });
    assert.equal(revoked.metadata.metadataRevision, resource.metadata.metadataRevision);
    assert.equal(revoked.metadata.grantsRevision, resource.metadata.grantsRevision + 1);
    const denied = details(await invoke('inspect_canvas_package', { resourceRef: resource.metadata.resourceRef }));
    assert.equal(typeof denied.error, 'string', 'A held read operation must recheck the current resource grant.');
    assert.equal(denied.code, 'CAPABILITY_RESOURCE_NOT_FOUND', 'Current authorization must deny the read, without disguising an unrelated snapshot failure as a passing permission check.');
    assert(!JSON.stringify(denied).includes('Planning may inspect these actual package bytes'));
    const deniedVersions = details(await invoke('list_canvas_package_versions', { resourceRef: resource.metadata.resourceRef }));
    assert.equal(deniedVersions.code, 'CAPABILITY_RESOURCE_NOT_FOUND', 'Version discovery rechecks current source Read instead of reusing the earlier pin.');
    assert.doesNotMatch(JSON.stringify(deniedVersions), new RegExp(published.published.revisionRef, 'u'));
    assert.equal(details(await invoke('inspect_canvas_package_operation', { draftRef: privateDraft.draftRef })).error, undefined,
      'Actor-private recovery remains metadata only after unrelated package Read is revoked.');
    const currentProfile = await agents.getAgentProfile(profile.agentId); assert(currentProfile);
    await agents.updateAgentProfile({ agentId: profile.agentId, expectedRevision: currentProfile.revision,
      enabledTools: ['create_canvas_package_draft', 'read', 'email_list_mailboxes'] });
    await runtime.reloadTools();
    const withdrawn = buildEffectiveToolManifest(agent.state.tools);
    assert.deepEqual(withdrawn.registeredToolNames, ['read'], 'Fresh configuration withdrawal does not restore default reads or leave an empty gateway.');
    assert.equal(networkCalls, 0); assert.equal(modelCalls, 0);
    assert(resource.access.canRead);
    console.log('planning-progressive-runtime-test: PASS actual registry/LivePiRuntime/Agent SDK, persisted version and actor-bound legacy source discovery, actor-private draft/status/operation recovery and file-registry Store read, blocked creation/composition/import, current grant revocation, monotone ceilings, prompt/management metadata and fresh configuration withdrawal; 0 network/model/business calls. No native-client or model prompt claim.');
  } finally {
    dispose?.(); loader._load = originalLoader; globalThis.fetch = originalFetch;
    await database.close(); for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const unlock = async (directory: string): Promise<void> => {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      await fs.chmod(directory, 0o700);
      for (const entry of await fs.readdir(directory)) await unlock(path.join(directory, entry));
    };
    await unlock(root);
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
