import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { createPiTestDatabase } from './helpers/pi-test-database';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-extension-root-'));
  const settings = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_ORGANIZATION_ID: 'root-org', CANVAS_DEPLOYMENT_MODE: 'team',
    CANVAS_TEAM_FEATURES_ENABLED: 'true', BETTER_AUTH_BASE_URL: 'http://localhost:3000', QMD_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false' };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]])); Object.assign(process.env, settings);
  const database = await createPiTestDatabase(), raw = await database.openDb();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load; let providerProbes = 0;
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return { getModels: () => [], getProviders: () => [],
      registerBuiltInApiProviders: () => {}, isContextOverflow: () => false };
    if (name === '@/app/lib/pi/live-runtime' || name.endsWith('/pi/live-runtime.ts')) return { requestPiRuntimePromptRefreshForUser: async () => {} };
    if (name === '@/app/lib/plugins/plugin-connection-readiness') return { resolvePluginConnectionReadiness: async () => {
      providerProbes++; throw new Error('Root package metadata must not discover providers.'); } };
    return original(name, parent, isMain);
  };
  try {
    for (const id of ['owner', 'alice']) await raw.run('INSERT INTO "user" (id,name,email,role,email_verified,banned,created_at,updated_at) VALUES ($1,$1,$2,\'member\',1,0,1,1)', [id, `${id}@root.example.test`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('root-org','owner','team',1,1,1)");
    for (const id of ['owner', 'alice']) await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('root-org',$1,$2,'active',1,1,1)", [id, id === 'owner' ? 'owner' : 'member']);
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('root-team','root-org','team','workspaces/root-team/files','Root team','active',1,1)");
    for (const id of ['owner', 'alice']) await raw.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ('root-org','root-team',$1,'member','active',1,1,0,1,1)", [id]);
    const registry = await import('../app/lib/plugins/canvas-plugin-registry');
    const resources = await import('../app/lib/capabilities/resources/actions');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const artifacts = await import('../app/lib/capabilities/packages/artifacts');
    const runtime = await import('../app/lib/capabilities/packages/runtime-bindings');
    const workflow = await import('../app/lib/agents/workflow-configuration');
    const agents = await import('../app/lib/agents/registry');
    const sessions = await import('../app/lib/pi/session-workspace-context');
    const source = path.join(root, 'source', 'root-plugin');
    await fs.mkdir(path.join(source, '.canvas-plugin'), { recursive: true });
    await fs.writeFile(path.join(source, '.canvas-plugin/plugin.json'), JSON.stringify({ name: 'root-plugin', version: '1.0.0',
      description: 'Actual root skill plugin', skills: '.', interface: { displayName: 'Root Workflow', defaultPrompt: ['Use the exact root workflow.'] } }));
    await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: root-step\ndescription: Convert campaign photos into localized captions for a retail launch\nmetadata:\n  version: "1.0.0"\n---\n\nRoot version one.\n');
    const installed = await registry.installCanvasPluginFromPath(source, { scope: { scopeType: 'organization', organizationId: 'root-org' }, enable: true, installedBy: 'owner' });
    assert(installed.success && installed.plugin?.resourceId, installed.error ?? 'Fixture installation failed');
    const wrongChild = path.join(root, 'source', 'ordinary-plugin');
    await fs.mkdir(path.join(wrongChild, '.canvas-plugin'), { recursive: true });
    await fs.mkdir(path.join(wrongChild, 'skills', 'actual-folder'), { recursive: true });
    await fs.writeFile(path.join(wrongChild, '.canvas-plugin/plugin.json'), JSON.stringify({ name: 'ordinary-plugin', version: '1.0.0',
      description: 'Ordinary children keep directory-name checks', skills: './skills' }));
    await fs.writeFile(path.join(wrongChild, 'skills', 'actual-folder', 'SKILL.md'), '---\nname: different-name\ndescription: Mismatched ordinary child\n---\n\nBody.\n');
    const rejected = await registry.installCanvasPluginFromPath(wrongChild, { scope: { scopeType: 'organization', organizationId: 'root-org' }, installedBy: 'owner' });
    assert.equal(rejected.success, false, 'Allowing a manifest root never disables the ordinary child-directory identity check.');
    const legacyRoots = await registry.loadEnabledPluginSkills(['root-step'], { scopeType: 'organization', organizationId: 'root-org' });
    assert(legacyRoots.some(skill => skill.name === 'root-step'), 'The actual prepublication loader accepts a manifest root with an independent skill name.');
    const owner = { userId: 'owner', workspaceId: 'root-team' }, alice = { userId: 'alice', workspaceId: 'root-team' };
    const adopted = await resources.configureCapabilityResource(owner, installed.plugin.resourceId, { expectedMetadataRevision: 0,
      expectedGrantsRevision: 0, ownership: { type: 'team', workspaceId: 'root-team' }, accessMode: 'restricted',
      grants: [{ targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false }] });
    const ref = adopted.metadata.resourceRef, initial = await packages.inspectCapabilityPackage(owner, ref);
    const draft = await packages.createCapabilityPackageDraftAction(owner, { operation: 'edit', resourceRef: ref,
      expectedMetadataRevision: initial.resource.metadataRevision, expectedGrantsRevision: initial.resource.grantsRevision,
      expectedPackageRevision: initial.state?.packageRevision ?? 0, expectedPublishedRevisionRef: initial.state?.currentPublishedRevisionRef ?? null });
    const published = await packages.publishCapabilityPackageDraftAction(owner, { draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision,
      expectedMetadataRevision: initial.resource.metadataRevision, expectedGrantsRevision: initial.resource.grantsRevision,
      expectedPackageRevision: initial.state?.packageRevision ?? 0, expectedPublishedRevisionRef: initial.state?.currentPublishedRevisionRef ?? null });
    await agents.createAgentProfile({ name: 'Root specialist', agentId: 'root-specialist', scopeType: 'user', ownerUserId: 'alice',
      organizationId: 'root-org', createdByUserId: 'alice' });
    const profile = (await agents.getAgentProfile('root-specialist'))!;
    await workflow.updateManagedAgentConfiguration({ actor: alice, agentId: profile.agentId, expectedRevision: profile.revision,
      expectedWorkflowRevision: profile.workflowRevision ?? 0, workflow: { version: 1, packages: [{ resourceRef: ref,
        publishedRevisionRef: published.published.revisionRef, checksum: published.published.checksum, skillSelection: { kind: 'plugin' }, declarations: [] }] } });
    const { piSessions } = await import('../app/lib/db/schema');
    await database.db.insert(piSessions).values({ sessionId: 'root-session', userId: 'alice', agentId: profile.agentId,
      workspaceId: 'root-team', workspaceType: 'team', organizationId: 'root-org', provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const context = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'root-session', agentId: profile.agentId });
    const selection = await runtime.getAuthorizedAgentWorkflowPackageSelections(context);
    const captured = await runtime.captureCapabilityPackageRuntimeBindings(context, { selection });
    assert.equal(captured.selection, selection, 'Capture reuses exactly the actual issued workflow proof.');
    assert.equal(Object.keys(captured).includes('selection'), false, 'Existing context spreads must not serialize private bindings.');
    assert.equal(captured.skillPackageBindings.length, 1);
    assert.equal(captured.skillPackageBindings[0].childRelativeRoot, '');
    assert.equal(captured.skillPackageBindings[0].publishedRevisionRef, published.published.revisionRef);
    const metadata = runtime.getAuthorizedAgentWorkflowPackageMetadata(selection, context);
    assert.equal(metadata[0].title, 'Root Workflow'); assert.equal(metadata[0].skills[0].package?.relativeRoot, '');
    assert.deepEqual(metadata[0].defaultPrompts, ['Use the exact root workflow.']);
    const effectiveContext = await import('../app/lib/capabilities/extensions/effective-context');
    const compiled = await effectiveContext.resolveEffectiveExtensionContext(context, { packageSelection: selection });
    const collected = effectiveContext.readEffectiveExtensionContext(compiled)!;
    assert.equal(collected.packageSelection, selection, 'The compiler consumes the very same private package selection rather than a derived fake snapshot.');
    assert.equal(collected.packages[0].publishedRevisionRef, published.published.revisionRef);
    assert.equal(collected.skills.find(skill => skill.name === 'root-step')?.runtimePath, compiled.skillPackageBindings?.[0].runtimePath);
    assert.deepEqual(Object.keys(compiled.effectiveExtensions!), ['kind', 'fingerprint'], 'Context carries only the opaque handle, never a package snapshot/account binding.');
    assert(Object.isFrozen(compiled.effectiveExtensions));
    assert.throws(() => effectiveContext.readEffectiveExtensionContext(structuredClone(compiled)), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' });
    assert.throws(() => effectiveContext.readEffectiveExtensionContext({ ...compiled, userId: 'owner' }), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' });
    assert(Object.isFrozen(metadata[0].skills[0])); assert(Object.isFrozen(selection.packages[0].selectedSkills));
    const skillMetadata = await runtime.getAuthorizedAgentWorkflowSkillMetadata(selection, context);
    assert.equal(skillMetadata.find(skill => skill.name === 'root-step')?.runtimePath, captured.skillPackageBindings[0].runtimePath);
    const heldMetadata = await runtime.getAuthorizedAgentWorkflowSkillMetadata(selection, context, { bindings: captured.skillPackageBindings });
    assert.equal(heldMetadata.find(skill => skill.name === 'root-step')?.package?.checksum, published.published.checksum);
    const copiedMetadata = await runtime.getAuthorizedAgentWorkflowSkillMetadata(selection, context, { bindings: structuredClone(captured.skillPackageBindings) });
    assert(!copiedMetadata.some(skill => skill.name === 'root-step'), 'Raw copied binding strings cannot authorize inherited metadata or provenance.');
    assert((await runtime.loadCapabilityPackageRuntimeSkills(context)).some(skill => skill.name === 'root-step'), 'An actual root skill need not reuse the plugin name.');
    assert((await runtime.loadCapabilityPackageRuntimeSkills(context, { selection })).some(skill => skill.path === captured.skillPackageBindings[0].runtimePath),
      'Prompt loading can reuse the same issued package source without a second workflow read.');
    const skillLoader = await import('../app/lib/skills/skill-loader');
    const loaded = await skillLoader.loadSkillsFromDisk(['root-step'], { scopeType: 'organization', organizationId: 'root-org', userId: 'alice' });
    assert(loaded.some(skill => skill.name === 'root-step'), 'The verified managed plugin pointer uses the same manifest-backed root skill.');
    assert.throws(() => runtime.getAuthorizedAgentWorkflowPackageMetadata(structuredClone(selection), context), { code: 'PACKAGE_ACCESS_DENIED' });
    await assert.rejects(runtime.captureCapabilityPackageRuntimeBindings({ ...context, sessionId: 'foreign' }, { selection }), { code: 'PACKAGE_ACCESS_DENIED' });
    const child = (await resources.listCapabilityResources(alice)).find(value => value.artifact.resourceType === 'skill' && value.artifact.name === 'root-step')!;
    const childSource = await artifacts.resolveCapabilityPackageArtifact(alice, child.metadata.resourceRef);
    assert.equal(childSource.sourceStamp.relativeRoot, '', 'The actual manifest-backed root child is inspectable without relaxing file paths.');
    const fixedDiscovery = await runtime.getAuthorizedAgentWorkflowDiscoveryPackages(selection, context);
    assert.equal(fixedDiscovery[0].package?.publishedRevisionRef, published.published.revisionRef);
    const preferences = await import('../app/lib/capabilities/preference-store');
    await preferences.setCapabilityPreference({ userId: 'alice', resourceId: installed.plugin.resourceId, enabled: true });
    const { DEFAULT_MANAGED_AGENT_ID } = await import('../app/lib/agents/storage');
    await agents.getAgentProfile(DEFAULT_MANAGED_AGENT_ID);
    const { importSkillPackage } = await import('../app/lib/skills/skill-package-import');
    const unrelated = await importSkillPackage({ kind: 'text', content: '---\nname: unrelated-inherited\ndescription: Review unrelated billing documents\n---\n\nAn unrelated available guide.\n' },
      { scope: { userId: 'alice', organizationId: 'root-org' }, updatedBy: 'alice', enable: true });
    assert(unrelated.success, 'The general fixture contains a real unrelated permitted skill, not a synthetic renderer row.');
    await database.db.insert(piSessions).values({ sessionId: 'root-general', userId: 'alice', agentId: DEFAULT_MANAGED_AGENT_ID,
      workspaceId: 'root-team', workspaceType: 'team', organizationId: 'root-org', provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const general = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'root-general', agentId: DEFAULT_MANAGED_AGENT_ID });
    const discoverySelection = await runtime.getAuthorizedAgentWorkflowPackageSelections(general);
    assert.deepEqual(runtime.getAuthorizedAgentWorkflowPackageMetadata(discoverySelection, general), [], 'General discovery never injects every installed plugin’s instructions.');
    const discovery = await runtime.getAuthorizedAgentWorkflowDiscoveryPackages(discoverySelection, general);
    assert.equal(discovery.find(item => item.resourceRef === ref)?.package?.publishedRevisionRef, published.published.revisionRef);
    await agents.createAgentProfile({ name: 'Limited inherited', agentId: 'root-inherited', scopeType: 'user', ownerUserId: 'alice',
      organizationId: 'root-org', createdByUserId: 'alice', relevantSkills: [] });
    await database.db.insert(piSessions).values({ sessionId: 'root-inherited-session', userId: 'alice', agentId: 'root-inherited',
      workspaceId: 'root-team', workspaceType: 'team', organizationId: 'root-org', provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const inheritedContext = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'root-inherited-session', agentId: 'root-inherited' });
    const inheritedSelection = await runtime.getAuthorizedAgentWorkflowPackageSelections(inheritedContext);
    assert.equal(inheritedSelection.workflowVersion, null);
    assert(!(await runtime.getAuthorizedAgentWorkflowDiscoveryPackages(inheritedSelection, inheritedContext)).some(item => item.resourceRef === ref),
      'A restricted legacy skill selection cannot advertise a whole plugin containing unselected children.');
    const runtimeDiscovery = await import('../app/lib/capabilities/extensions/runtime-discovery');
    const guardedPrompt = await import('../app/lib/capabilities/extensions/runtime-prompt');
    const { createProgressiveGatewayTool } = await import('../app/lib/pi/progressive-tool-gateway');
    const execution = await import('../app/lib/pi/agent-execution-context');
    const fileAccess = await import('../app/lib/pi/agent-file-operations');
    const readTool: AgentTool = { name: 'read', label: 'Read held skill', description: 'Read an authorized fixture skill.',
      parameters: Type.Object({ path: Type.String() }), execute: async (_call, args) => {
        const target = (args as { path: string }).path;
        await fileAccess.assertAgentPathAllowed(target);
        return { content: [{ type: 'text', text: await fs.readFile(target, 'utf8') }], details: { path: target } };
      } };
    const searchOperation: AgentTool = { name: 'search_canvas_extensions', label: 'Find permitted extensions', description: 'Search real local fixture metadata.',
      parameters: Type.Object({ query: Type.String() }), execute: async (_call, args) => ({ content: [],
        details: await runtimeDiscovery.searchRuntimeExtensions(execution.getAgentExecutionContext()!, args) }) };
    const discoveryTool = createProgressiveGatewayTool({ name: 'canvas_extensions', label: 'Extensions',
      description: 'Actual local metadata gateway', operations: ['search_canvas_extensions'] }, [searchOperation]);
    const actualTools = [readTool, discoveryTool];
    const generalCompiled = await effectiveContext.resolveEffectiveExtensionContext(general, { packageSelection: discoverySelection });
    const generalData = effectiveContext.readEffectiveExtensionContext(generalCompiled)!;
    assert(generalData.skills.some(skill => skill.name === 'unrelated-inherited'), 'The issued source really permits the unrelated guide.');
    const generalPrompt = guardedPrompt.appendEffectiveExtensionContextPrompt('Fixture foundation.', generalCompiled, actualTools, 'campaign captions');
    assert(generalPrompt.includes(generalCompiled.effectiveExtensions!.fingerprint));
    assert(!generalPrompt.includes('unrelated-inherited'), 'A general prompt does not dump its full permitted skill index.');
    assert(!generalPrompt.includes(captured.skillPackageBindings[0].runtimePath), 'General implicit plugin discovery does not attach every plugin instruction/path.');
    assert(generalPrompt.includes('search_canvas_extensions'), 'The search recipe refers to an actually registered progressive operation.');
    const taskQuery = { query: 'Create localized captions for campaign photos', types: ['skill'], limit: 8 };
    const natural = await runtimeDiscovery.searchRuntimeExtensions(general, taskQuery);
    const naturalHit = natural.items.find(item => item.kind === 'skill' && item.name === 'root-step');
    assert(naturalHit?.kind === 'skill', 'A task query discovers an actual permitted root skill without the caller knowing its name.');
    assert.equal(naturalHit.skillPath, captured.skillPackageBindings[0].runtimePath, 'Discovery exposes the actual held SKILL.md metadata path.');
    assert.equal('nextAction' in naturalHit, false, 'Metadata discovery does not assume an actual registered file-read operation.');
    const turn = { ...general, turnExtensions: { version: 1 as const, origin: 'turn_reference' as const, selections: [{ requirement: 'required' as const, toolCap: null,
      selection: { kind: 'plugin' as const, package: { resourceRef: ref, publishedRevisionRef: published.published.revisionRef,
        checksum: published.published.checksum }, skillSelection: { kind: 'all' as const } } }] } };
    const turnSelection = await runtime.getAuthorizedAgentWorkflowPackageSelections(turn);
    assert.equal(turnSelection.snapshot.workflowVersion, null, 'An explicit general Turn never manufactures a fixed agent workflow.');
    assert.equal(turnSelection.packages.length, 1);
    assert.deepEqual(turnSelection.packages[0].declarations, [], 'An unconfigured Turn does not manufacture connector bindings.');
    const turnRoots = await runtime.captureCapabilityPackageRuntimeBindings(turn, { selection: turnSelection });
    assert.equal(turnRoots.skillPackageBindings.find(value => value.skillName === 'root-step')?.publishedRevisionRef, published.published.revisionRef);
    const turnCaptured = { ...turn, ...turnRoots };
    assert((await runtime.getAuthorizedCapabilityPackageRuntimeBindings(turnCaptured)).some(value => value.skillName === 'root-step'), 'Fresh file gates retain the same accepted Turn pin.');
    assert.throws(() => runtime.getAuthorizedAgentWorkflowPackageMetadata(discoverySelection, turn), { code: 'PACKAGE_ACCESS_DENIED' }, 'A changed Turn cannot reuse a previous actor-matching source proof.');
    const compiledTurn = await effectiveContext.resolveEffectiveExtensionContext(turn, { packageSelection: turnSelection });
    const turnData = effectiveContext.readEffectiveExtensionContext(compiledTurn)!;
    assert.equal(turnData.packageSelection, turnSelection);
    const prompt = guardedPrompt.appendEffectiveExtensionContextPrompt('Fixture foundation.', compiledTurn, actualTools, 'campaign photos localized captions');
    assert(prompt.startsWith('Fixture foundation.'));
    assert(prompt.includes(`Context fingerprint: ${JSON.stringify(compiledTurn.effectiveExtensions!.fingerprint)}`));
    assert(prompt.includes(captured.skillPackageBindings[0].runtimePath), 'A relevant explicit plugin exposes the exact held Root path through the actual read tool.');
    assert(prompt.includes(published.published.revisionRef));
    assert(!prompt.includes('unrelated-inherited'));
    const noReadPrompt = guardedPrompt.appendEffectiveExtensionContextPrompt('Fixture foundation.', compiledTurn, [discoveryTool], 'campaign captions');
    assert(!noReadPrompt.includes(captured.skillPackageBindings[0].runtimePath), 'Without a registered read tool, source paths never become an executable recipe.');
    assert(noReadPrompt.includes('Skill reading is unavailable'));
    const rejectBeforeRender = new Proxy([] as AgentTool[], { get() { throw new Error('Tool manifest was inspected before its context proof.'); } });
    assert.throws(() => guardedPrompt.appendEffectiveExtensionContextPrompt('', structuredClone(compiledTurn), rejectBeforeRender), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' });
    assert.throws(() => guardedPrompt.appendEffectiveExtensionContextPrompt('', { ...compiledTurn, userId: 'owner' }, rejectBeforeRender), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' });
    const actualRead = await execution.runWithAgentExecutionContext(compiledTurn, () => readTool.execute('fixture-read', { path: captured.skillPackageBindings[0].runtimePath }));
    assert(actualRead.content.some(block => block.type === 'text' && block.text.includes('Root version one.')), 'The actual registered read recipe reaches authorized held bytes.');
    const actualSearch = await execution.runWithAgentExecutionContext(compiledTurn, () => discoveryTool.execute('fixture-discovery', {
      action: 'call', operation: 'search_canvas_extensions', arguments: { query: 'Create localized captions for campaign photos' },
    }));
    const searchDetails = actualSearch.details as typeof natural & { error?: string };
    assert.equal(searchDetails.error, undefined);
    assert(searchDetails.items.some(item => item.kind === 'skill' && item.name === 'root-step'), 'The registered gateway recipe reaches the actual scoped discovery service.');
    await preferences.setCapabilityPreference({ userId: 'alice', resourceId: installed.plugin.resourceId, enabled: false });
    await assert.rejects(runtime.getAuthorizedAgentWorkflowPackageSelections(turn), { code: 'PACKAGE_ACCESS_DENIED' }, 'Referencing a disabled plugin never silently activates it.');
    const disabledSearch = await runtimeDiscovery.searchRuntimeExtensions(general, taskQuery);
    assert(!disabledSearch.items.some(item => item.name === 'root-step'), 'Discovery removes disabled children using the actual current effective policy.');
    await preferences.setCapabilityPreference({ userId: 'alice', resourceId: installed.plugin.resourceId, enabled: true });
    const storage = await import('../app/lib/capabilities/resources/store');
    await storage.mutateCapabilityResource(owner, ref, { expectedMetadataRevision: adopted.metadata.metadataRevision,
      expectedGrantsRevision: adopted.metadata.grantsRevision, grants: [] });
    await assert.rejects(runtime.getAuthorizedAgentWorkflowPackageSelections(context), { code: 'PACKAGE_ACCESS_DENIED' });
    const revokedSearch = await runtimeDiscovery.searchRuntimeExtensions(general, taskQuery);
    assert(!revokedSearch.items.some(item => item.name === 'root-step'), 'A stale context does not retain revoked package ancestry or skill metadata.');
    assert.equal(providerProbes, 0);
    assert.equal(naturalHit.package?.resourceRef, ref, 'An implicitly discovered published plugin child must retain its exact public parent pin.');
    assert.equal(naturalHit.package?.publishedRevisionRef, published.published.revisionRef);
    assert.equal(naturalHit.package?.checksum, published.published.checksum);
    assert.equal(naturalHit.package?.relativeRoot, '');
    console.log('PASS actual root-SKILL runtime: installation/publication/V1, scoped task discovery with exact provenance, same-proof capture/collector, guarded actual read+search prompt recipes, general/no-read exclusions, clone/actor/ACL denial and cleanup; zero provider probes.');
  } finally {
    loader._load = original;
    await database.close();
    async function unlock(directory: string): Promise<void> {
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) { await fs.chmod(directory, 0o700); for (const entry of await fs.readdir(directory)) await unlock(path.join(directory, entry)); }
    }
    await unlock(root);
    await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
