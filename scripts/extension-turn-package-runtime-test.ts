import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import { Pool } from 'pg';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { ChatExtensionSelectionInput, ExtensionPackageConnection, StandaloneExtensionSelection } from '../app/lib/capabilities/extensions/contracts';

// Actual store installation/publishing, actor/workspace/session, connection Use
// ACL, accepted source and compiler. Model metadata only is controlled; no tool
// adapter or authority service is replaced. Optional --native forbids fallback.
async function main() {
  const maintenanceUrl = process.env.DATABASE_URL;
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  const databaseName = fixture.native ? (await fixture.sql.get('SELECT current_database() AS name') as { name: string }).name : '';
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const previous = loader._load;
  loader._load = (name, parent, isMain) => name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat'
    ? { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => {}, isContextOverflow: () => false }
    : previous(name, parent, isMain);
  try {
    const { owner, alice, organizationId, sql } = fixture;
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const activation = await import('../app/lib/capabilities/packages/activation');
    const personalActivation = await import('../app/lib/capabilities/activation-actions');
    const mcp = await import('../app/lib/mcp/shared-connections');
    const runtime = await import('../app/lib/capabilities/packages/runtime-bindings');
    const intake = await import('../app/lib/capabilities/extensions/accepted-turn-selection');
    const turnRuntime = await import('../app/lib/capabilities/extensions/turn-runtime');
    const effective = await import('../app/lib/capabilities/extensions/effective-context');
    const providerAuthorization = await import('../app/lib/integration-tools/connections/provider-authorization');
    const connections = await import('../app/lib/integration-tools/connections/store');
    const { piSessions } = await import('../app/lib/db/schema');
    const sourceActor = { ...owner, organizationId };
    const grants = [owner, alice].map(actor => ({ targetType: 'user' as const, targetId: actor.userId,
      canUse: true, canManage: false, allowedToolNames: ['read_fixture', 'source_extra'] }));
    const createSource = (url: string) => mcp.createSharedMcpConnection(sourceActor, {
      ownership: { type: 'organization', organizationId }, displayName: 'Same visible source name', accessMode: 'restricted',
      allowedToolNames: ['read_fixture', 'source_extra', 'never_granted'], grants,
      config: { url, transport: 'http', auth: 'none', enabled: true },
    });
    const a = await createSource('https://fixture.invalid/mcp');
    const b = await createSource('https://fixture.invalid/mcp');
    const wrong = await createSource('https://different.invalid/mcp');
    const name = `turn-workflow-${randomUUID().slice(0, 8)}`;
    const files = {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', description: 'Exact turn-bound design workflow', skills: './skills',
        connectors: { mcp: [{ name: 'design-source', required: false, configPath: 'mcp.json' }] },
        workflow: { version: 1, integrationCapabilities: [{ id: 'design', application: 'design', required: true,
          alternatives: [{ source: 'mcp', connector: 'design-source', requiredTools: ['read_fixture'] }] }] } }),
      'mcp.json': JSON.stringify({ url: 'https://fixture.invalid/mcp', transport: 'http', auth: 'none' }),
      'skills/design-brief/SKILL.md': '---\nname: design-brief\ndescription: Prepare campaign design briefs\n---\n\nRead the exact selected source.\n',
    };
    const archive = await fixture.registry.addPackage('application', 'plugin', name, '1.0.0', files, plugins.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: name, version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' },
      grants: [owner, alice].map(actor => ({ targetType: 'user' as const, targetId: actor.userId, canUse: true, canEdit: false, canManage: false })) });
    const descriptor = await packages.inspectCapabilityPackage(owner, installed.resource.resourceRef);
    await activation.setCapabilityPackageDefaultActivationAction(owner, installed.resource.resourceRef, {
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
      expectedPackageRevision: descriptor.state!.packageRevision, expectedPublishedRevisionRef: installed.published.revisionRef,
      expectedDefaultEnabled: false, enabled: true });
    await personalActivation.setPersonalCapabilityActivation({ context: { userId: alice.userId, organizationId, workspaceId: alice.workspaceId, role: 'member' },
      actorUserId: alice.userId, resourceId: descriptor.sourceStamp.resourceId, enabled: true });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    await sql.run("UPDATE agents SET access_policy='restricted',scope_type='organization',organization_id=$1,owner_user_id='owner',enabled_tools_json='[]',revision=1 WHERE agent_id='bradley'", [organizationId]);
    await sql.run("INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,can_use,can_edit,can_manage,created_at,updated_at) VALUES ('turn-general','bradley',$1,'user','alice',1,0,0,1,1)", [organizationId]);
    await fixture.database.db.insert(piSessions).values({ sessionId: 'package-turn', userId: 'alice', agentId: 'bradley',
      workspaceId: alice.workspaceId, workspaceType: 'personal', organizationId, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const sessions = await import('../app/lib/pi/session-workspace-context');
    const base = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'package-turn', agentId: 'bradley' });
    const publicSource = (value: typeof a): StandaloneExtensionSelection => ({ kind: 'mcp', source: 'mcp', target: {
      kind: 'shared', connectionRef: value.resource.connectionRef, bindingRevision: value.resource.bindingRevision } });
    const entry = { selection: { kind: 'plugin' as const, package: pin, skillSelection: { kind: 'all' as const } },
      requirement: 'optional' as const, toolCap: ['read_fixture'] };
    const input = (source?: typeof a, link = true): ChatExtensionSelectionInput => ({ version: 1, origin: 'turn_reference',
      selections: [entry, ...(source ? [{ selection: publicSource(source), requirement: 'optional' as const, toolCap: ['read_fixture', 'source_extra'] }] : [])],
      ...(source && link ? { packageConnections: [{ package: pin, declarationPath: '.canvas-plugin/plugin.json', capabilityId: 'design',
        alternativeKey: 'mcp:design-source', connectionSelection: publicSource(source) }] } : {}) });
    const compile = async (value: ChatExtensionSelectionInput, activeBase = base) => {
      const intakeContext = { ...activeBase, agentTurnId: randomUUID() };
      const accepted = await intake.prepareAcceptedTurnExtensionSelection(intakeContext, value);
      const context: AgentExecutionContext = { ...activeBase, agentTurnId: randomUUID(),
        turnExtensions: intake.readAcceptedTurnExtensionSelection(accepted, intakeContext).publicSelection };
      const selected = await runtime.getAuthorizedAgentWorkflowPackageSelections(context);
      context.turnExtensionSource = await turnRuntime.reissueAcceptedTurnRuntimeSelection(context, accepted, intakeContext, { packageSelection: selected });
      return effective.resolveEffectiveExtensionContext(context, { packageSelection: selected });
    };
    for (const value of [input(), input(a, false)]) {
      const unbound = effective.readEffectiveExtensionContext(await compile(value))!;
      assert.equal(unbound.workflowProjection?.unavailable, true, 'Unmapped required declarations stay unbound even beside a matching account.');
      assert.deepEqual(unbound.workflowProjection.policy.providerToolRules, []);
      assert.equal(unbound.skills.some(skill => skill.name === 'design-brief'), true, 'Local skill instructions remain available.');
    }
    const exact = await compile(input(a));
    const projection = effective.readEffectiveExtensionContext(exact)!.workflowProjection!;
    assert.equal(projection.unavailable, false);
    assert.deepEqual(projection.policy.providerToolRules?.map(rule => [rule.providerRef, rule.allowedToolNames]),
      [[providerAuthorization.createSharedIntegrationProviderRef(a.resource), ['read_fixture']]]);
    assert.equal(projection.selectedProviders.length, 1);
    const childOnly = input(a, false);
    childOnly.selections[0] = { selection: { kind: 'skill', package: pin, origin: 'plugin_child', relativeRoot: 'skills/design-brief' },
      requirement: 'optional', toolCap: ['read_fixture'] };
    const childUnbound = effective.readEffectiveExtensionContext(await compile(childOnly))!;
    assert.equal(childUnbound.workflowProjection?.unavailable, true, 'An individually selected optional child preserves required parent connections.');
    assert.deepEqual(childUnbound.workflowProjection.policy.providerToolRules, []);
    assert.equal(childUnbound.skills.filter(skill => !skill.core).length, 1);
    const linkedChild = { ...childOnly, packageConnections: input(a).packageConnections };
    const childLinked = effective.readEffectiveExtensionContext(await compile(linkedChild))!;
    assert.equal(childLinked.workflowProjection?.unavailable, false);
    assert.deepEqual(childLinked.workflowProjection.policy.providerToolRules?.map(rule => rule.allowedToolNames), [['read_fixture']],
      'The selected child cap also narrows its required parent connector.');
    await assert.rejects(compile(input(wrong)), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' }, 'Same name with a different endpoint cannot satisfy the held connector.');
    const absent = input(a);
    absent.packageConnections![0].capabilityId = 'not-in-package';
    await assert.rejects(compile(absent), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' });
    const altered: ExtensionPackageConnection = { ...input(a).packageConnections![0], declarationPath: 'skills/absent/agents/canvas.yaml' };
    await assert.rejects(compile({ ...input(a), packageConnections: [altered] }), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' });
    const before = await sql.all('SELECT agent_id,workflow_version,workflow_revision FROM agents');
    await compile(input(b));
    assert.deepEqual(await sql.all('SELECT agent_id,workflow_version,workflow_revision FROM agents'), before, 'A different explicit turn changes no stored agent.');
    const registry = await import('../app/lib/agents/registry');
    const workflow = await import('../app/lib/agents/workflow-configuration');
    const stored = await import('../app/lib/capabilities/extensions/stored-package-contracts');
    const agentId = `turn-specialist-${randomUUID().slice(0, 8)}`;
    await registry.createAgentProfile({ agentId, name: 'Exact turn specialist', scopeType: 'organization',
      organizationId, createdByUserId: 'owner', enabledTools: ['read', 'mcp'] });
    await sql.run('INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,can_use,can_edit,can_manage,created_at,updated_at) VALUES ($1,$2,$3,\'user\',\'alice\',1,0,0,1,1)',
      [`${agentId}-grant`, agentId, organizationId]);
    const profile = (await registry.getAgentProfile(agentId))!;
    const target = (source: typeof a) => ({ kind: 'shared' as const, source: 'mcp' as const,
      connectionRef: source.resource.connectionRef, bindingRevision: source.resource.bindingRevision,
      mcpMapping: { kind: 'manager_confirmation' as const } });
    await workflow.updateManagedAgentConfiguration({ actor: owner, agentId, expectedRevision: profile.revision,
      expectedWorkflowRevision: profile.workflowRevision ?? 0, workflow: { version: 1, packages: [{ ...pin,
        skillSelection: { kind: 'plugin' }, declarations: [{ declarationPath: '.canvas-plugin/plugin.json', capabilities: [{
          capabilityId: 'design', selection: { mode: 'selectable', defaultChoiceId: 'a', allowedChoices: [
            { choiceId: 'a', alternativeKey: 'mcp:design-source', target: target(a), toolCap: ['read_fixture', 'source_extra'] },
            { choiceId: 'b', alternativeKey: 'mcp:design-source', target: target(b), toolCap: ['read_fixture', 'source_extra'] },
          ] } }] }] }] } });
    const v1 = await workflow.readManagedAgentWorkflow(alice, agentId);
    const row = v1.bindings.find(binding => binding.configuration?.resourceRef === pin.resourceRef)!;
    assert(row.configuration);
    const childConfiguration = { ...row.configuration, skillSelection: { kind: 'skills' as const, relativeRoots: ['skills/design-brief'] } };
    const wrapper = stored.parseStoredPackageExtensionBinding({ version: 2, kind: 'package', workflow: childConfiguration,
      selections: [childOnly.selections[0]] });
    // Explicit V2 SQL protocol fixture: public aggregate writing is phase3.
    // The underlying complete V1 configuration was created through its real service.
    await sql.run('UPDATE agent_capability_bindings SET configuration_json=$1 WHERE id=$2', [JSON.stringify(wrapper), row.id]);
    await sql.run('UPDATE agents SET workflow_version=2,workflow_revision=workflow_revision+1 WHERE agent_id=$1', [agentId]);
    await fixture.database.db.insert(piSessions).values({ sessionId: 'fixed-package-turn', userId: 'alice', agentId,
      workspaceId: alice.workspaceId, workspaceType: 'personal', organizationId, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const specialist = await sessions.resolveAgentExecutionContextForSession({ userId: 'alice', sessionId: 'fixed-package-turn', agentId });
    const bytesBefore = await sql.all('SELECT configuration_json FROM agent_capability_bindings WHERE agent_id=$1 ORDER BY id', [agentId]);
    const preferencesBefore = await sql.all('SELECT * FROM agent_user_preferences WHERE agent_id=$1', [agentId]);
    const fixedB = effective.readEffectiveExtensionContext(await compile({ ...linkedChild,
      selections: [childOnly.selections[0], input(b).selections[1]], packageConnections: input(b).packageConnections }, specialist))!;
    assert.equal(fixedB.workflowProjection?.unavailable, false);
    assert.deepEqual(fixedB.workflowProjection.policy.providerToolRules?.map(rule => [rule.providerRef, rule.allowedToolNames]),
      [[providerAuthorization.createSharedIntegrationProviderRef(b.resource), ['read_fixture']]], 'The mapped child turn may select allowed B instead of saved default A.');
    assert.deepEqual(await sql.all('SELECT configuration_json FROM agent_capability_bindings WHERE agent_id=$1 ORDER BY id', [agentId]), bytesBefore);
    assert.deepEqual(await sql.all('SELECT * FROM agent_user_preferences WHERE agent_id=$1', [agentId]), preferencesBefore);
    const fixedAWrapper = structuredClone(wrapper);
    const capability = fixedAWrapper.workflow.declarations[0].capabilities[0];
    assert.equal(capability.selection.mode, 'selectable');
    if (capability.selection.mode === 'selectable') capability.selection = { mode: 'fixed', ...capability.selection.allowedChoices[0] };
    // Strip choice-only field before strict private codec validation.
    if ('choiceId' in capability.selection) delete (capability.selection as { choiceId?: string }).choiceId;
    const fixedA = stored.parseStoredPackageExtensionBinding(fixedAWrapper);
    await sql.run('UPDATE agent_capability_bindings SET configuration_json=$1 WHERE id=$2', [JSON.stringify(fixedA), row.id]);
    await sql.run('UPDATE agents SET workflow_revision=workflow_revision+1 WHERE agent_id=$1', [agentId]);
    await assert.rejects(compile({ ...linkedChild, selections: [childOnly.selections[0], input(b).selections[1]],
      packageConnections: input(b).packageConnections }, specialist), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' }, 'A fixed A capability cannot switch to B.');
    assert.equal(fixture.providerRequests(), 0, 'Only own registry traffic; no provider discovery or business calls.');
    await connections.mutateSharedIntegrationConnection(sourceActor, a.resource.connectionRef, {
      expectedMetadataRevision: a.resource.metadataRevision, expectedGrantsRevision: a.resource.grantsRevision,
      expectedBindingRevision: a.resource.bindingRevision, grants: [] });
    await assert.rejects(effective.resolveEffectiveExtensionContext(exact), 'Fresh Use revocation must close a previously compiled mapping.');
    console.log(`PASS ${fixture.native ? 'native PostgreSQL' : 'PGlite'} actual turn package mapping: held declaration/source, required unbound versus explicit binding, same-name wrong endpoint, missing/foreign declaration, intersected caps, exact alternative source, no stored mutation, fresh revocation; provider/business IO zero.`);
  } finally {
    loader._load = previous;
    await fixture.close();
    await assert.rejects(fs.access(fixture.root), { code: 'ENOENT' });
    if (fixture.native) {
      assert.match(databaseName, /^canvas_connection_test_[a-f0-9]{32}$/u);
      const observer = new Pool({ connectionString: maintenanceUrl, max: 1 });
      try { assert.equal((await observer.query('SELECT COUNT(*)::integer AS count FROM pg_database WHERE datname=$1', [databaseName])).rows[0].count, 0); }
      finally { await observer.end(); }
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
