import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft } from '../app/lib/capabilities/packages/contracts';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';

// New, isolated actual PostgreSQL/package/runtime fixture. Only the database
// transport and unused model boundary are replaced; ACLs and pins remain real.
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-workflow-runtime-'));
  const settings = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_ORGANIZATION_ID: 'workflow-org', CANVAS_DEPLOYMENT_MODE: 'team',
    CANVAS_TEAM_FEATURES_ENABLED: 'true', BETTER_AUTH_BASE_URL: 'http://localhost:3000', QMD_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false' };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]])); Object.assign(process.env, settings);
  const database = await createPiTestDatabase(), raw = await database.openDb();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load; let providerProbes = 0;
  loader._load = (name, parent, mainModule) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
      getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false,
    };
    if (name === '@/app/lib/pi/live-runtime' || name.endsWith('/pi/live-runtime.ts')) return { requestPiRuntimePromptRefreshForUser: async () => {} };
    if (name === '@/app/lib/plugins/plugin-connection-readiness') return { resolvePluginConnectionReadiness: async () => {
      providerProbes++; throw new Error('Provider discovery must not run while constructing package context.');
    } };
    return original(name, parent, mainModule);
  };
  try {
    for (const id of ['owner', 'alice', 'editor']) await raw.run('INSERT INTO "user" (id,name,email,role,email_verified,banned,created_at,updated_at) VALUES ($1,$1,$2,\'member\',1,0,1,1)', [id, `${id}@workflow.example.test`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('workflow-org','owner','team',1,1,1)");
    for (const id of ['owner', 'alice', 'editor']) await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('workflow-org',$1,$2,'active',$3,1,1)", [id, id === 'owner' ? 'owner' : 'member', Number(id === 'owner')]);
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('workflow-team','workflow-org','team','workspaces/workflow-team/files','Workflow team','active',1,1)");
    for (const id of ['owner', 'alice', 'editor']) await raw.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ('workflow-org','workflow-team',$1,'member','active',1,1,0,1,1)", [id]);
    const registry = await import('../app/lib/plugins/canvas-plugin-registry');
    const resources = await import('../app/lib/capabilities/resources/actions');
    const resourceStore = await import('../app/lib/capabilities/resources/store');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const runtime = await import('../app/lib/capabilities/packages/runtime-bindings');
    const sessions = await import('../app/lib/pi/session-workspace-context');
    const agents = await import('../app/lib/agents/registry');
    const workflow = await import('../app/lib/agents/workflow-configuration');
    const fresh = await import('../app/lib/skills/fresh-agent-skill-read-roots');
    const scripts = await import('../app/lib/skills/script-runtime/authorization');
    const { piSessions } = await import('../app/lib/db/schema');
    const source = path.join(root, 'source', 'workflow-plugin');
    await fs.mkdir(path.join(source, '.canvas-plugin'), { recursive: true });
    await fs.writeFile(path.join(source, '.canvas-plugin/plugin.json'), JSON.stringify({ name: 'workflow-plugin', version: '1.0.0',
      description: 'Pinned workflow package', skills: './skills', connectors: { mcp: [{ name: 'design', required: true }] } }));
    for (const name of ['workflow-first', 'workflow-second']) {
      await fs.mkdir(path.join(source, 'skills', name, 'scripts'), { recursive: true });
      await fs.mkdir(path.join(source, 'skills', name, '.canvas-skill'));
      await fs.writeFile(path.join(source, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Exact workflow version\nmetadata:\n  version: "1.0.0"\n---\n\nversion-one ${name}\n`);
      await fs.writeFile(path.join(source, 'skills', name, 'scripts/main.js'), "process.stdout.write('version-one');\n");
      await fs.writeFile(path.join(source, 'skills', name, '.canvas-skill/runtime.json'), JSON.stringify({ version: 1,
        scripts: [{ id: 'main', runtime: { kind: 'node' }, path: 'scripts/main.js', argumentsSchema: {}, tools: [], outputs: [] }] }));
    }
    const owner = { userId: 'owner', workspaceId: 'workflow-team' }, alice = { userId: 'alice', workspaceId: 'workflow-team' };
    const installed = await registry.installCanvasPluginFromPath(source, { scope: { scopeType: 'organization', organizationId: 'workflow-org' }, enable: true, installedBy: 'owner' });
    assert(installed.success && installed.plugin?.resourceId, installed.error || 'The actual plugin installation failed.');
    const adopted = await resources.configureCapabilityResource(owner, installed.plugin.resourceId, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      ownership: { type: 'team', workspaceId: 'workflow-team' }, accessMode: 'restricted', grants: [{ targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false }] });
    const ref = adopted.metadata.resourceRef;
    const edit = (descriptor: CapabilityPackageDescriptor) => ({ operation: 'edit' as const, resourceRef: ref,
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
      expectedPackageRevision: descriptor.state?.packageRevision ?? 0, expectedPublishedRevisionRef: descriptor.state?.currentPublishedRevisionRef ?? null });
    const publish = (draft: CapabilityPackageDraft, descriptor: CapabilityPackageDescriptor) => ({ draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision,
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
      expectedPackageRevision: descriptor.state?.packageRevision ?? 0, expectedPublishedRevisionRef: descriptor.state?.currentPublishedRevisionRef ?? null });
    const initial = await packages.inspectCapabilityPackage(owner, ref), draft = await packages.createCapabilityPackageDraftAction(owner, edit(initial));
    const v1 = await packages.publishCapabilityPackageDraftAction(owner, publish(draft, initial));
    const preference = await import('../app/lib/capabilities/preference-store');
    await preference.setCapabilityPreference({ userId: 'alice', resourceId: installed.plugin.resourceId, enabled: false });
    const { importSkillPackage } = await import('../app/lib/skills/skill-package-import');
    const legacy = await importSkillPackage({ kind: 'text', content: '---\nname: workflow-legacy\ndescription: Existing personal standalone\n---\n\nLegacy bytes.\n' },
      { scope: { userId: 'alice', organizationId: 'workflow-org' }, updatedBy: 'alice', enable: true });
    assert(legacy.success);
    for (const id of ['workflow-parent', 'workflow-child', 'workflow-newer']) await agents.createAgentProfile({ name: id, agentId: id,
      scopeType: 'user', ownerUserId: 'alice', organizationId: 'workflow-org', createdByUserId: 'alice', relevantSkills: ['workflow-second', 'workflow-legacy'] });
    const configure = async (agentId: string, selected: typeof v1, relativeRoot = 'skills/workflow-first') => {
      const agent = (await agents.getAgentProfile(agentId))!;
      return workflow.updateManagedAgentConfiguration({ actor: alice, agentId, expectedRevision: agent.revision,
        expectedWorkflowRevision: agent.workflowRevision ?? 0, workflow: { version: 1, packages: [{ resourceRef: ref,
          publishedRevisionRef: selected.published.revisionRef, checksum: selected.published.checksum,
          skillSelection: { kind: 'skills', relativeRoots: [relativeRoot] }, declarations: [] }] } });
    };
    for (const [sessionId, agentId] of [['parent-session', 'workflow-parent'], ['child-session', 'workflow-child'], ['newer-session', 'workflow-newer']]) await database.db.insert(piSessions).values({
      sessionId, userId: 'alice', agentId, workspaceId: 'workflow-team', workspaceType: 'team', organizationId: 'workflow-org', provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date(),
    });
    const priorLegacy = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'parent-session', agentId: 'workflow-parent' });
    const legacyRoot = path.dirname(legacy.path);
    assert((await fresh.resolveFreshAgentSkillReadRoots(priorLegacy)).includes(legacyRoot), 'The unchanged legacy agent can use its selected standalone root.');
    await configure('workflow-parent', v1); await configure('workflow-child', v1);
    assert(!(await fresh.resolveFreshAgentSkillReadRoots(priorLegacy)).includes(legacyRoot), 'A stale legacy root is not restored after the agent switches to exact workflow selection.');
    const held = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'parent-session', agentId: 'workflow-parent' });
    assert.equal(held.skillPackageBindings?.length, 1, 'Workflow selection activates its selected skill despite the disabled personal preference.');
    const binding = held.skillPackageBindings![0];
    assert.equal(binding.skillName, 'workflow-first'); assert.equal(binding.publishedRevisionRef, v1.published.revisionRef);
    assert(!held.skillReadRoots!.some(value => value.endsWith('workflow-second')), 'The selected child never activates its sibling.');
    const selection = await runtime.getAuthorizedAgentWorkflowPackageSelections(held);
    assert(runtime.isAuthorizedAgentWorkflowPackageSelections(selection, held));
    assert(!runtime.isAuthorizedAgentWorkflowPackageSelections(structuredClone(selection), held));
    assert.equal(runtime.isAuthorizedAgentWorkflowPackageSelections(selection, { ...held, sessionId: 'foreign-session' }), false);
    assert.equal(providerProbes, 0, 'Initial and fresh runtime context construction performs no provider readiness probes.');
    const { withCapabilityPolicyStore } = await import('../app/lib/capabilities/policy-store');
    const { createCapabilityResourceId } = await import('../app/lib/capabilities/reference');
    const secondId = createCapabilityResourceId({ resourceType: 'skill', scopeType: 'organization', name: 'workflow-second',
      sourceType: 'plugin', organizationId: 'workflow-org', sourcePluginName: 'workflow-plugin' });
    const required = await withCapabilityPolicyStore(store => store.upsertPolicy({ organizationId: 'workflow-org', resourceType: 'skill', resourceId: secondId,
      targetType: 'user', targetId: 'alice', effect: 'required', actorUserId: 'owner', expectedRevision: 0 }));
    const withRequired = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'parent-session', agentId: 'workflow-parent' });
    assert(withRequired.skillPackageBindings!.some(value => value.skillName === 'workflow-second'), 'An explicit organization-required skill remains selected beside the exact workflow child.');
    assert((await runtime.getAuthorizedCapabilityPackageRuntimeBindings(withRequired)).some(value => value.skillName === 'workflow-second'));
    await withCapabilityPolicyStore(store => store.upsertPolicy({ organizationId: 'workflow-org', resourceType: 'skill', resourceId: secondId,
      targetType: 'user', targetId: 'alice', effect: 'optional', actorUserId: 'owner', expectedRevision: required.revision }));
    const v2Base = await packages.inspectCapabilityPackage(owner, ref);
    let v2Draft = await packages.createCapabilityPackageDraftAction(owner, edit(v2Base));
    v2Draft = (await packages.deleteCapabilityPackageDraftFileAction(owner, v2Draft.draftRef, { expectedDraftRevision: v2Draft.draftRevision, path: 'skills/workflow-first/SKILL.md' })).draft;
    v2Draft = (await packages.writeCapabilityPackageDraftFileAction(owner, v2Draft.draftRef, { expectedDraftRevision: v2Draft.draftRevision,
      path: 'skills/workflow-second/scripts/main.js', encoding: 'base64', content: Buffer.from("process.stdout.write('version-two');\n").toString('base64') })).draft;
    const v2 = await packages.publishCapabilityPackageDraftAction(owner, publish(v2Draft, v2Base));
    const pinnedAgain = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'parent-session', agentId: 'workflow-parent' });
    assert.equal(pinnedAgain.skillPackageBindings![0].publishedRevisionRef, v1.published.revisionRef, 'A new context still captures the configured old revision, including a child removed from HEAD.');
    assert.equal((await runtime.getAuthorizedAgentWorkflowPackageSelections(pinnedAgain)).fingerprint, selection.fingerprint,
      'Publishing another HEAD does not change unchanged pinned workflow authority.');
    assert((await fresh.resolveFreshAgentSkillReadRoots(held)).includes(path.dirname(binding.runtimePath)));
    const promptSkills = await runtime.loadCapabilityPackageRuntimeSkills(held);
    assert(promptSkills.some(skill => skill.path === binding.runtimePath));
    const authorizedScripts = await scripts.listAuthorizedSkillScripts(held);
    assert.equal(authorizedScripts.length, 1); assert.equal(authorizedScripts[0].binding.publishedRevisionRef, v1.published.revisionRef);
    assert.match(await fs.readFile(authorizedScripts[0].entryPath, 'utf8'), /version-one/u);
    const sameChild = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'child-session', agentId: 'workflow-child' });
    const reissued = await runtime.reissueCapabilityPackageRuntimeBindings(held, sameChild);
    assert.equal(reissued.skillPackageBindings?.length, 1); assert(runtime.isHeldCapabilityPackageRuntimeBinding(reissued.skillPackageBindings![0], reissued));
    await configure('workflow-newer', v2, 'skills/workflow-second');
    const differentChild = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'newer-session', agentId: 'workflow-newer' });
    assert.equal((await runtime.reissueCapabilityPackageRuntimeBindings(held, differentChild)).skillPackageBindings?.length, 0, 'A target with another child/version receives no substituted receipt.');
    const cloned = JSON.parse(JSON.stringify(held)) as AgentExecutionContext;
    assert.equal((await runtime.getAuthorizedCapabilityPackageRuntimeBindings(cloned)).length, 0, 'JSON copies cannot authorize exact package roots.');
    const blocked = await withCapabilityPolicyStore(store => store.upsertPolicy({ organizationId: 'workflow-org', resourceType: 'skill', resourceId: binding.resourceId,
      targetType: 'user', targetId: 'alice', effect: 'blocked', actorUserId: 'owner', expectedRevision: 0 }));
    await assert.rejects(runtime.getAuthorizedAgentWorkflowPackageSelections(held), { code: 'PACKAGE_ACCESS_DENIED' });
    await withCapabilityPolicyStore(store => store.upsertPolicy({ organizationId: 'workflow-org', resourceType: 'skill', resourceId: binding.resourceId,
      targetType: 'user', targetId: 'alice', effect: 'optional', actorUserId: 'owner', expectedRevision: blocked.revision }));
    const entryPath = path.join(path.dirname(binding.runtimePath), 'scripts/main.js'), bytes = await fs.readFile(entryPath);
    await fs.chmod(entryPath, 0o600); await fs.writeFile(entryPath, 'tampered');
    await assert.rejects(runtime.getAuthorizedAgentWorkflowPackageSelections(held));
    await fs.writeFile(entryPath, bytes); await fs.chmod(entryPath, 0o400);
    await agents.createAgentProfile({ name: 'Editor-only', agentId: 'editor-agent', scopeType: 'organization', organizationId: 'workflow-org', createdByUserId: 'owner', accessPolicy: 'restricted' });
    const grants = await import('../app/lib/agents/grants');
    await grants.upsertAgentGrant({ agentId: 'editor-agent', organizationId: 'workflow-org', targetType: 'user', targetId: 'editor', canUse: false, canEdit: true, canManage: false, actorUserId: 'owner' });
    // Historical SQL rows can carry independent flags even though the current
    // legacy grant form implies canUse from canEdit. Inspect must never be
    // mistaken for an execution receipt by the new package boundary.
    await raw.run('UPDATE agent_grants SET can_use=0 WHERE agent_id=$1 AND target_id=$2', ['editor-agent', 'editor']);
    const editorContext = { ...held, userId: 'editor', agentId: 'editor-agent', sessionId: 'editor-session', skillPackageBindings: [] };
    assert.equal((await workflow.readManagedAgentWorkflow({ userId: 'editor', workspaceId: 'workflow-team' }, 'editor-agent')).access.canEdit, true);
    await assert.rejects(runtime.getAuthorizedAgentWorkflowPackageSelections(editorContext), { code: 'PACKAGE_ACCESS_DENIED' }, 'An inspectable editor-only snapshot grants no runtime use.');
    await raw.run('UPDATE agents SET workflow_version=7 WHERE agent_id=$1', ['workflow-parent']);
    await assert.rejects(runtime.captureCapabilityPackageRuntimeBindings(held), { code: 'AGENT_WORKFLOW_CORRUPT' });
    await raw.run('UPDATE agents SET workflow_version=1 WHERE agent_id=$1', ['workflow-parent']);
    const stored = await raw.get('SELECT configuration_json FROM agent_capability_bindings WHERE agent_id=$1', ['workflow-parent']) as { configuration_json: string };
    await raw.run('UPDATE agent_capability_bindings SET configuration_json=$1 WHERE agent_id=$2', ['{', 'workflow-parent']);
    await assert.rejects(runtime.captureCapabilityPackageRuntimeBindings(held), { code: 'AGENT_WORKFLOW_CORRUPT' });
    await raw.run('UPDATE agent_capability_bindings SET configuration_json=$1 WHERE agent_id=$2', [stored.configuration_json, 'workflow-parent']);
    await resourceStore.mutateCapabilityResource(owner, ref, { expectedMetadataRevision: adopted.metadata.metadataRevision, expectedGrantsRevision: adopted.metadata.grantsRevision, grants: [] });
    await assert.rejects(runtime.getAuthorizedAgentWorkflowPackageSelections(held), { code: 'PACKAGE_ACCESS_DENIED' });
    assert.equal(providerProbes, 0);
    console.log('capability-workflow-runtime-test: PASS (actual PG/package/agent configuration, exact old child pins, prompt/script/readroot parity, private proofs, monotone delegation, policy/ACL/bytes denial and 0 provider discovery)');
  } finally {
    loader._load = original; await raw.close(); await database.close();
    async function unlock(directory: string): Promise<void> { const stat = await fs.lstat(directory); if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) { await fs.chmod(directory, 0o700); for (const entry of await fs.readdir(directory)) await unlock(path.join(directory, entry)); } }
    await unlock(root); await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
