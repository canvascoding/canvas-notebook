import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { AgentWorkflowConfiguration } from '../app/lib/agents/workflow-contracts';
import type { SqlConnection } from '../app/lib/db';
import { createSharedConnectionTestDatabase } from './helpers/shared-connection-test-database';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-workflow-configuration-'));
  const env = { DATA: root, CANVAS_DATA_ROOT: root, INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'),
    QMD_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false', BASE_URL: 'http://localhost:3001', CANVAS_ORGANIZATION_ID: 'org-workflow',
    CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_INSTANCE_TOKEN: '', CANVAS_LICENSE_CERT: '' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const database = await createSharedConnectionTestDatabase(), raw = await database.openDb();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load, actualModules = new Map<string, unknown>();
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    if (actualModules.has(name)) return actualModules.get(name);
    return original(name, parent, isMain);
  };
  let locker: SqlConnection | undefined;
  try {
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) actualModules.set(name, await import(name));
    for (const id of ['owner', 'runner', 'stranger']) await raw.run('INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at) VALUES($1,$1,$2,1,\'user\',0,1000,1000)', [id, `${id}@workflow.example.test`]);
    await raw.run("INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES('org-workflow','owner','team',1,1000,1000)");
    for (const id of ['owner', 'runner', 'stranger']) {
      await raw.run("INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES('org-workflow',$1,$2,'active',$3,1000,1000)", [id, id === 'owner' ? 'owner' : 'member', Number(id === 'owner')]);
      await raw.run("INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES($1,'org-workflow','personal',$2,$1,$2,'active',1000,1000)", [`personal-${id}`, id]);
    }
    const registry = await import('../app/lib/agents/registry'), grants = await import('../app/lib/agents/grants');
    const workflow = await import('../app/lib/agents/workflow-configuration'), management = await import('../app/lib/agents/management-actions');
    const connections = await import('../app/lib/integration-tools/connections/store');
    const profiles = await import('../app/lib/composio/composio-shared-profiles');
    const pluginRegistry = await import('../app/lib/plugins/canvas-plugin-registry');
    const resources = await import('../app/lib/capabilities/resources/actions'), packages = await import('../app/lib/capabilities/packages/actions');
    const owner = { userId: 'owner', organizationId: 'org-workflow', workspaceId: 'personal-owner', source: 'api' as const };
    const runner = { userId: 'runner', organizationId: 'org-workflow', workspaceId: 'personal-runner', source: 'api' as const };
    const packageActor = { userId: owner.userId, workspaceId: owner.workspaceId };
    const pluginRoot = path.join(root, 'fixture-plugin');
    await fs.mkdir(path.join(pluginRoot, '.canvas-plugin'), { recursive: true });
    for (const name of ['workflow-design', 'workflow-extra']) {
      await fs.mkdir(path.join(pluginRoot, 'skills', name, 'agents'), { recursive: true });
      await fs.writeFile(path.join(pluginRoot, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Workflow fixture\nmetadata:\n  version: "1.0.0"\n---\nExact version one.\n`);
    }
    await fs.writeFile(path.join(pluginRoot, 'skills', 'workflow-design', 'agents', 'canvas.yaml'),
      'workflow:\n  version: 1\n  integrationCapabilities:\n    - id: designs\n      application: canva\n      alternatives:\n        - source: composio\n          toolkit: canva\n          requiredTools: [WRITE]\n');
    await fs.writeFile(path.join(pluginRoot, '.canvas-plugin', 'plugin.json'), JSON.stringify({ name: 'workflow-package', version: '1.0.0', description: 'Workflow fixture', skills: 'skills',
      workflow: { version: 1, integrationCapabilities: [{ id: 'designs', application: 'canva', alternatives: [{ source: 'composio', toolkit: 'canva', requiredTools: ['WRITE'] }] }] } }));
    const installed = await pluginRegistry.installCanvasPluginFromPath(pluginRoot, { scope: { scopeType: 'organization', organizationId: 'org-workflow' }, enable: true });
    assert(installed.success && installed.plugin?.resourceId, JSON.stringify(installed.validation?.errors));
    const governed = await resources.configureCapabilityResource(owner, installed.plugin.resourceId, { expectedMetadataRevision: 0, expectedGrantsRevision: 0, ownership: { type: 'organization' }, accessMode: 'inherit' });
    const packageRef = governed.metadata.resourceRef;
    assert.equal(governed.access.canRead, true, 'The real configured owner must retain resource read authority.');
    const resourceStore = await import('../app/lib/capabilities/resources/store');
    const resourceRecord = await resourceStore.findCapabilityResourceRecord(packageRef); assert(resourceRecord);
    assert.equal((await resourceStore.getCapabilityResourceAccess({ userId: owner.userId, workspaceId: owner.workspaceId }, resourceRecord.storage)).access.canRead, true);
    const descriptor = await packages.inspectCapabilityPackage(packageActor, packageRef);
    const draft = await packages.createCapabilityPackageDraftAction(packageActor, { operation: 'edit', resourceRef: packageRef,
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision, expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    const first = await packages.publishCapabilityPackageDraftAction(packageActor, { draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision,
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision, expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    const legacyAgent = await registry.createAgentProfile({ agentId: 'workflow-legacy-agent', name: 'Legacy Configuration', scopeType: 'organization', organizationId: 'org-workflow', accessPolicy: 'restricted', createdByUserId: 'owner' });
    await grants.upsertAgentGrant({ agentId: legacyAgent.agentId, organizationId: 'org-workflow', targetType: 'user', targetId: 'owner', actorUserId: 'owner', canUse: true, canEdit: true, canManage: true });
    const legacyBefore = await raw.get('SELECT * FROM agents WHERE agent_id=$1', [legacyAgent.agentId]);
    await assert.rejects(() => workflow.updateManagedAgentConfiguration({ actor: owner, agentId: legacyAgent.agentId, expectedRevision: legacyAgent.revision,
      name: 'Invalid Combined Name', enabledTools: ['read'], capabilities: [], relevantSkills: [], relevantConnections: ['Existing connector'],
      defaultProviderInstallationId: 'aip_000000000000000000000000', defaultProvider: 'invalid', defaultModel: 'invalid', defaultThinking: 'low', expectedCatalogRevision: 999 }));
    assert.deepEqual(await raw.get('SELECT * FROM agents WHERE agent_id=$1', [legacyAgent.agentId]), legacyBefore);
    assert.deepEqual(await raw.all('SELECT * FROM agent_capability_bindings WHERE agent_id=$1', [legacyAgent.agentId]), []);
    const legacySaved = await workflow.updateManagedAgentConfiguration({ actor: owner, agentId: legacyAgent.agentId, expectedRevision: legacyAgent.revision,
      name: 'Atomic Legacy Name', enabledTools: ['read'], capabilities: [], relevantSkills: [], relevantConnections: ['Existing connector'] });
    assert.equal(legacySaved.agent.name, 'Atomic Legacy Name'); assert.deepEqual(legacySaved.agent.enabledTools, ['read']);
    assert.deepEqual((await workflow.readManagedAgentWorkflow(owner, legacyAgent.agentId)).bindings.map(binding => [binding.name, binding.configuration]), [['Existing connector', null]]);
    const noWorkflowChild = await workflow.updateManagedAgentConfiguration({ actor: owner, agentId: legacyAgent.agentId, expectedRevision: legacySaved.agent.revision,
      expectedWorkflowRevision: 0, workflow: { version: 1, packages: [{ resourceRef: packageRef, publishedRevisionRef: first.published.revisionRef,
        checksum: first.published.checksum, skillSelection: { kind: 'skills', relativeRoots: ['skills/workflow-extra'] }, declarations: [] }] } });
    const childSnapshot = await workflow.readManagedAgentWorkflow(owner, legacyAgent.agentId);
    assert.equal(noWorkflowChild.workflow.workflowVersion, 1); assert.deepEqual(childSnapshot.bindings[0].configuration!.selectedSkills, [{ name: 'workflow-extra', relativeRoot: 'skills/workflow-extra' }]);
    assert.deepEqual(childSnapshot.bindings[0].configuration!.declarations, [], 'A child without workflow metadata must not inherit parent requirements.');
    let agent = await registry.createAgentProfile({ agentId: 'workflow-agent', name: 'Workflow Agent', scopeType: 'organization', organizationId: 'org-workflow', accessPolicy: 'restricted', createdByUserId: 'owner' });
    await grants.upsertAgentGrant({ agentId: agent.agentId, organizationId: 'org-workflow', targetType: 'user', targetId: 'owner', actorUserId: 'owner', canUse: true, canEdit: true, canManage: true });
    await grants.upsertAgentGrant({ agentId: agent.agentId, organizationId: 'org-workflow', targetType: 'user', targetId: 'runner', actorUserId: 'owner', canUse: true, canEdit: false, canManage: false });
    const sharedProfile = await profiles.createSharedComposioProfile({ actor: owner, ownership: { type: 'organization', organizationId: 'org-workflow' }, name: 'Workflow profile', providerMode: 'local' });
    const makeConnection = (name: string) => connections.createSharedIntegrationConnection(owner, { ownership: { type: 'organization', organizationId: 'org-workflow' }, displayName: name,
      backend: { source: 'composio', profileId: sharedProfile.id, toolkit: 'canva', mode: 'local', accountBinding: 'pending', connectedAccountId: null }, accessMode: 'restricted', allowedToolNames: ['WRITE', 'READ'],
      grants: [{ targetType: 'agent', targetId: agent.agentId, canUse: true, canManage: false, allowedToolNames: ['WRITE'] }] });
    const a = await makeConnection('Connection A'), b = await makeConnection('Connection B');
    const target = (record: typeof a) => ({ kind: 'shared' as const, source: 'composio' as const, connectionRef: record.resource.connectionRef, bindingRevision: record.resource.bindingRevision });
    const makeConfiguration = (selectable = true): AgentWorkflowConfiguration => ({ version: 1, packages: [{ resourceRef: packageRef,
      publishedRevisionRef: first.published.revisionRef, checksum: first.published.checksum, skillSelection: { kind: 'skills', relativeRoots: ['skills/workflow-design'] },
      declarations: [{ declarationPath: 'skills/workflow-design/agents/canvas.yaml', capabilities: [{ capabilityId: 'designs', selection: selectable ? { mode: 'selectable', defaultChoiceId: 'a',
        allowedChoices: [{ choiceId: 'a', alternativeKey: 'composio:canva', target: target(a), toolCap: ['WRITE'] }, { choiceId: 'b', alternativeKey: 'composio:canva', target: target(b), toolCap: ['WRITE'] }] }
        : { mode: 'fixed', alternativeKey: 'composio:canva', target: target(a), toolCap: ['WRITE'] } }] }] }] });
    const saved = await workflow.updateManagedAgentConfiguration({ actor: owner, agentId: agent.agentId, expectedRevision: agent.revision, expectedWorkflowRevision: 0,
      name: 'Configured Workflow', workflow: makeConfiguration() }); agent = saved.agent;
    const snapshot = await workflow.readManagedAgentWorkflow(runner, agent.agentId);
    assert.equal(snapshot.access.canUse, true); assert.equal(snapshot.access.canEdit, false); assert(workflow.isManagedAgentWorkflowSnapshot(snapshot)); assert(!workflow.isManagedAgentWorkflowSnapshot(JSON.parse(JSON.stringify(snapshot))));
    assert.deepEqual(snapshot.bindings[0].configuration!.selectedSkills, [{ name: 'workflow-design', relativeRoot: 'skills/workflow-design' }]);
    assert.equal(snapshot.bindings[0].configuration!.declarations.length, 1, 'Direct child selection must not imply parent requirements with the same capability id.');
    const publicBindings = await management.inspectManagedAgent(owner, agent.agentId);
    assert(!JSON.stringify(publicBindings.bindings).includes('configuration')); assert(!JSON.stringify(saved.workflow).includes(sharedProfile.id));
    const key = saved.workflow.packages[0].declarations[0].capabilities[0].capabilityKey;
    await raw.run('INSERT INTO agent_user_preferences(agent_id,user_id,preferences_json,revision,created_at,updated_at) VALUES($1,$2,$3,1,1000,1000)', [agent.agentId, 'runner', JSON.stringify({ unrelated: { remains: true } })]);
    const ownChoice = await workflow.setManagedAgentWorkflowChoice({ actor: runner, agentId: agent.agentId, capabilityKey: key, expectedWorkflowRevision: 1, expectedPreferenceRevision: 1, choiceId: 'b' });
    assert.equal(ownChoice.preferenceRevision, 2);
    const visibleChoices = ownChoice.packages[0].declarations[0].capabilities[0].choices;
    assert.equal(visibleChoices.find(choice => choice.choiceId === 'a')!.label, 'Connection A');
    assert.equal(visibleChoices.find(choice => choice.choiceId === 'b')!.connectionRef, b.resource.connectionRef);
    assert.equal(visibleChoices.find(choice => choice.choiceId === 'b')!.status, 'setup_required', 'Metadata access must not invent ready authentication for a pending account.');
    assert(!JSON.stringify(visibleChoices).includes(sharedProfile.id), 'Use-only metadata choices must not expose the provider profile.');
    await assert.rejects(() => connections.inspectSharedIntegrationConnection({ userId: runner.userId, workspaceId: runner.workspaceId }, b.resource.connectionRef), { code: 'CONNECTION_ACCESS_DENIED' });
    await raw.run('UPDATE integration_connection_grants SET can_use=0 WHERE connection_ref=$1 AND target_agent_id=$2', [b.resource.connectionRef, agent.agentId]);
    const revokedChoices = await workflow.inspectManagedAgentWorkflow(runner, agent.agentId);
    const revokedOption = revokedChoices.packages[0].declarations[0].capabilities[0].choices.find(choice => choice.choiceId === 'b')!;
    assert.deepEqual(revokedOption, { choiceId: 'b', kind: 'shared', label: 'Unavailable connection', availability: 'unavailable', status: 'unavailable' });
    assert.equal(revokedChoices.packages[0].declarations[0].capabilities[0].selectedChoiceId, 'b', 'The explicit unavailable choice must remain selected and must not silently switch.');
    await raw.run('UPDATE integration_connection_grants SET can_use=1 WHERE connection_ref=$1 AND target_agent_id=$2', [b.resource.connectionRef, agent.agentId]);
    const afterChoice = await workflow.readManagedAgentWorkflow(runner, agent.agentId);
    const config = afterChoice.bindings[0].configuration!, declaration = config.declarations[0], capability = declaration.capabilities[0];
    assert.equal(workflow.getSelectedAgentWorkflowCapability(afterChoice, config, declaration, capability)!.target.kind, 'shared');
    assert.equal((workflow.getSelectedAgentWorkflowCapability(afterChoice, config, declaration, capability)!.target as { connectionRef: string }).connectionRef, b.resource.connectionRef);
    const pref = await raw.get('SELECT preferences_json FROM agent_user_preferences WHERE agent_id=$1 AND user_id=$2', [agent.agentId, 'runner']) as { preferences_json: string };
    assert.deepEqual(JSON.parse(pref.preferences_json).unrelated, { remains: true });
    const choiceBeforeOmittedInput = await raw.get('SELECT * FROM agent_user_preferences WHERE agent_id=$1 AND user_id=$2', [agent.agentId, 'runner']);
    await assert.rejects(() => workflow.setManagedAgentWorkflowChoice({ actor: runner, agentId: agent.agentId, capabilityKey: key,
      expectedWorkflowRevision: 1, expectedPreferenceRevision: 2 }), { code: 'AGENT_WORKFLOW_CHOICE_INVALID', status: 400 });
    assert.deepEqual(await raw.get('SELECT * FROM agent_user_preferences WHERE agent_id=$1 AND user_id=$2', [agent.agentId, 'runner']), choiceBeforeOmittedInput,
      'An omitted selection must not implicitly clear the saved choice or increment its revision.');
    await assert.rejects(() => workflow.setManagedAgentWorkflowChoice({ actor: runner, agentId: agent.agentId, capabilityKey: key, expectedWorkflowRevision: 1, expectedPreferenceRevision: 1, choiceId: 'a' }), { code: 'AGENT_WORKFLOW_CHOICE_REVISION_CONFLICT' });
    await assert.rejects(() => workflow.updateManagedAgentConfiguration({ actor: runner, agentId: agent.agentId, expectedRevision: agent.revision, workflow: makeConfiguration(), expectedWorkflowRevision: 1 }), { code: 'AGENT_ACCESS_DENIED' });
    await assert.rejects(() => management.updateManagedAgentCapabilities({ actor: owner, agentId: agent.agentId, expectedRevision: agent.revision, relevantSkills: [] }), { code: 'AGENT_WORKFLOW_UPDATE_REQUIRED' });
    await assert.rejects(() => workflow.updateManagedAgentConfiguration({ actor: owner, agentId: agent.agentId, expectedRevision: agent.revision, expectedWorkflowRevision: 1, workflow: null, relevantSkills: [] }), { code: 'AGENT_WORKFLOW_INVALID' });
    const rawSnapshot = () => raw.all('SELECT * FROM agents WHERE agent_id=$1', [agent.agentId]);
    const baseline = await rawSnapshot();
    await assert.rejects(() => workflow.updateManagedAgentConfiguration({ actor: owner, agentId: agent.agentId, expectedRevision: agent.revision, name: 'Must not persist',
      defaultProviderInstallationId: 'aip_000000000000000000000000', defaultProvider: 'invalid', defaultModel: 'invalid', defaultThinking: 'low', expectedCatalogRevision: 999 }));
    assert.deepEqual(await rawSnapshot(), baseline, 'Invalid model defaults must roll back name/native tools/profile changes.');
    const downgraded = makeConfiguration(); downgraded.packages[0].declarations[0].capabilities[0].required = false;
    await assert.rejects(() => workflow.updateManagedAgentConfiguration({ actor: owner, agentId: agent.agentId, expectedRevision: agent.revision, expectedWorkflowRevision: 1, workflow: downgraded }), { code: 'AGENT_WORKFLOW_REQUIRED_BINDING' });
    await raw.run("CREATE FUNCTION workflow_reject_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture binding rollback'; END $$");
    await raw.run('CREATE TRIGGER workflow_reject_binding BEFORE INSERT ON agent_capability_bindings FOR EACH ROW EXECUTE FUNCTION workflow_reject_binding()');
    const oldBindings = await raw.all('SELECT * FROM agent_capability_bindings WHERE agent_id=$1', [agent.agentId]);
    await assert.rejects(() => workflow.updateManagedAgentConfiguration({ actor: owner, agentId: agent.agentId, expectedRevision: agent.revision, expectedWorkflowRevision: 1, name: 'Rollback', workflow: makeConfiguration() }));
    assert.deepEqual(await rawSnapshot(), baseline); assert.deepEqual(await raw.all('SELECT * FROM agent_capability_bindings WHERE agent_id=$1', [agent.agentId]), oldBindings);
    await raw.run('DROP TRIGGER workflow_reject_binding ON agent_capability_bindings'); await raw.run('DROP FUNCTION workflow_reject_binding()');
    const originalConfiguration = (oldBindings[0] as { configuration_json: string }).configuration_json;
    const corrupt = JSON.parse(originalConfiguration); corrupt.declarations[0].capabilities[0].selection.defaultChoiceId = 'not-allowed';
    await raw.run('UPDATE agent_capability_bindings SET configuration_json=$1 WHERE agent_id=$2', [JSON.stringify(corrupt), agent.agentId]);
    await assert.rejects(() => workflow.readManagedAgentWorkflow(runner, agent.agentId), { code: 'AGENT_WORKFLOW_CORRUPT' });
    await raw.run('UPDATE agent_capability_bindings SET configuration_json=$1 WHERE agent_id=$2', [originalConfiguration, agent.agentId]);
    if (database.native) {
      locker = await database.openDb(); await locker.run('BEGIN');
      await locker.get('SELECT connection_ref FROM integration_connection_resources WHERE connection_ref=$1 FOR UPDATE', [a.resource.connectionRef]);
      const write = workflow.updateManagedAgentConfiguration({ actor: owner, agentId: agent.agentId, expectedRevision: agent.revision, expectedWorkflowRevision: 1, workflow: makeConfiguration() });
      const deadline = Date.now() + 15_000; let waiting = false;
      while (Date.now() < deadline) {
        const wait = await raw.get("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND query LIKE '%integration_connection_resources%' LIMIT 1");
        if (wait) { waiting = true; break; } await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert(waiting, 'Actual writer must first wait on the connection row, before locking the agent.');
      await locker.run('DELETE FROM integration_connection_grants WHERE connection_ref=$1 AND target_agent_id=$2', [a.resource.connectionRef, agent.agentId]);
      await locker.run('COMMIT'); await locker.close(); locker = undefined;
      await assert.rejects(() => write, { code: 'CONNECTION_ACCESS_DENIED' }); assert.deepEqual(await rawSnapshot(), baseline);
    }
    await raw.run('UPDATE agents SET workflow_version=NULL WHERE agent_id=$1', [agent.agentId]);
    const corruptHeaderBefore = await rawSnapshot();
    const corruptHeaderBindings = await raw.all('SELECT * FROM agent_capability_bindings WHERE agent_id=$1', [agent.agentId]);
    await assert.rejects(() => management.updateManagedAgentCapabilities({ actor: owner, agentId: agent.agentId, expectedRevision: agent.revision,
      capabilities: [], relevantSkills: [], relevantConnections: [] }), { code: 'AGENT_WORKFLOW_UPDATE_REQUIRED' });
    assert.deepEqual(await rawSnapshot(), corruptHeaderBefore, 'The retained legacy tool must not alter a corrupt workflow header/profile.');
    assert.deepEqual(await raw.all('SELECT * FROM agent_capability_bindings WHERE agent_id=$1', [agent.agentId]), corruptHeaderBindings, 'The retained legacy tool must not erase private workflow bindings.');
    await raw.run('UPDATE agents SET workflow_version=9 WHERE agent_id=$1', [agent.agentId]);
    await assert.rejects(() => workflow.readManagedAgentWorkflow(runner, agent.agentId), { code: 'AGENT_WORKFLOW_CORRUPT' });
    await raw.run('UPDATE agents SET workflow_version=1,workflow_revision=2 WHERE agent_id=$1', [agent.agentId]);
    const stale = await workflow.readManagedAgentWorkflow(runner, agent.agentId);
    assert.equal(workflow.getSelectedAgentWorkflowCapability(stale, stale.bindings[0].configuration!, stale.bindings[0].configuration!.declarations[0], stale.bindings[0].configuration!.declarations[0].capabilities[0]), null,
      'An explicit stale user choice must not fall back to the admin default.');
    const cleared = await workflow.updateManagedAgentConfiguration({ actor: owner, agentId: agent.agentId, expectedRevision: agent.revision, expectedWorkflowRevision: 2, workflow: null });
    assert.equal(cleared.workflow.workflowVersion, null); assert.equal(cleared.workflow.workflowRevision, 3);
    const empty = await workflow.updateManagedAgentConfiguration({ actor: owner, agentId: agent.agentId, expectedRevision: cleared.agent.revision, expectedWorkflowRevision: 3, workflow: { version: 1, packages: [] } });
    assert.equal(empty.workflow.workflowVersion, 1); assert.deepEqual(empty.workflow.packages, []);
    if (database.native) {
      const agents = await Promise.all(Array.from({ length: 8 }, (_, index) => registry.createAgentProfile({ agentId: `pressure-${index}`, name: `Pressure ${index}`, scopeType: 'organization', organizationId: 'org-workflow', createdByUserId: 'owner' })));
      await Promise.race([Promise.all(agents.map(profile => workflow.updateManagedAgentConfiguration({ actor: owner, agentId: profile.agentId, expectedRevision: profile.revision, name: `Updated ${profile.name}` }))),
        new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Eight-client writer pressure timed out.')), 15_000); timer.unref(); })]);
    }
    console.log(`PASS ${database.native ? 'native PostgreSQL' : 'PGlite PostgreSQL'} workflow configuration: real package pin/child subset, agent-granted connections, atomic model/binding rollback, protected fixed configuration, own selection CAS/unrelated preferences, stale choice fail-closed and explicit clear/empty semantics${database.native ? ', connection-before-agent revocation and eight-client pressure' : ''}.`);
  } finally {
    if (locker) { await locker.run('ROLLBACK'); await locker.close(); }
    loader._load = original; await raw.close(); await database.close();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    const unlock = async (directory: string): Promise<void> => { const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      await fs.chmod(directory, 0o700); for (const name of await fs.readdir(directory)) await unlock(path.join(directory, name)); };
    await unlock(root); await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
