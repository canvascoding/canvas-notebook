import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { AgentManagementActor } from '../app/lib/agents/management-actions';
import type { AgentProfile } from '../app/lib/agents/registry';
import type { AgentExtensionConfigurationInput } from '../app/lib/capabilities/extensions/contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

async function expectCode(operation: () => unknown | Promise<unknown>, code: string) {
  await assert.rejects(async () => operation(), error => {
    assert.equal(error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined, code);
    return true;
  });
}

async function main() {
  // Real SQL, actual Email row, source/agent/workspace authority, Store ZIP,
  // locked configuration writer and public API. No provider or model calls.
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  let stage = 'load actual services';
  try {
    const { sql, owner, alice, organizationId } = fixture;
    const ownerActor: AgentManagementActor = { ...owner, source: 'api' };
    const aliceActor: AgentManagementActor = { ...alice, source: 'api' };
    const ownerSource = { ...owner, organizationId };
    const aliceSource = { ...alice, organizationId };
    const registry = await import('../app/lib/agents/registry');
    const workflows = await import('../app/lib/agents/workflow-configuration');
    const management = await import('../app/lib/agents/management-actions');
    const connections = await import('../app/lib/integration-tools/connections/store');
    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const route = await import('../app/api/agents/route');
    const { piSessions } = await import('../app/lib/db/schema');
    const emailId = registry.EMAIL_MANAGED_AGENT_ID;
    let email = await registry.ensureEmailAgent();
    assert.equal(email.scopeType, 'system');
    assert.equal(email.organizationId, null);
    assert.equal(email.ownerUserId, null);
    assert.equal(email.workflowVersion, null);
    const empty: AgentExtensionConfigurationInput = { version: 1, origin: 'agent_configuration', mode: 'fixed',
      selections: [], workflow: null, standalone: [] };
    const sharedSource = async (name: string, targetType: 'user' | 'agent', targetId: string, accessMode: 'restricted' | 'inherit' = 'restricted') =>
      createSharedMcpConnection(ownerSource, { ownership: { type: 'organization', organizationId }, displayName: name,
        allowedToolNames: ['READ'], accessMode,
        grants: [{ targetType, targetId, canUse: true, canManage: false, allowedToolNames: ['READ', 'OTHER'] }],
        config: { url: 'https://fixture.invalid/mcp', transport: 'http', auth: 'none', enabled: true } });
    const source = await sharedSource('Email scope migration source', 'user', owner.userId);
    const sharedEntry = (resource: typeof source) => ({ selection: { kind: 'mcp' as const, source: 'mcp' as const,
      target: { kind: 'shared' as const, connectionRef: resource.resource.connectionRef, bindingRevision: resource.resource.bindingRevision } },
      requirement: 'required' as const, toolCap: ['READ'] });
    const update = async (extensions: AgentExtensionConfigurationInput) => {
      const current = await registry.getAgentProfile(emailId);
      assert(current);
      const response = await route.PATCH(new NextRequest(`http://localhost:3001/api/agents?workspaceId=${owner.workspaceId}`, {
        method: 'PATCH', headers: fixture.headers(owner.userId), body: JSON.stringify({ agentId: emailId,
          expectedRevision: current.revision, expectedWorkflowRevision: current.workflowRevision ?? 0, extensions }),
      }));
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify({ status: response.status, code: result.code, stage }));
      assert.equal(result.success, true);
      email = await registry.getAgentProfile(emailId) as AgentProfile;
      return result;
    };
    const state = async () => ({ agent: await sql.get('SELECT revision,workflow_version,workflow_revision FROM agents WHERE agent_id=$1', [emailId]),
      bindings: await sql.all('SELECT resource_id,configuration_json FROM agent_capability_bindings WHERE agent_id=$1 ORDER BY resource_id', [emailId]) });

    stage = 'actual V1 private package compatibility and ordinary safe summary';
    const pluginRegistry = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const name = `email-scope-${randomUUID().slice(0, 8)}`;
    const files = { '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', description: 'Owned email scope test', skills: './skills' }),
      'skills/email-scope-brief/SKILL.md': '---\nname: email-scope-brief\ndescription: Explain an exact summary\n---\n\nBounded fixture instructions.\n' };
    const archive = await fixture.registry.addPackage('application', 'plugin', name, '1.0.0', files, pluginRegistry.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: name, version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'user' }, grants: [] });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const oldWorkflow = { version: 1 as const, packages: [{ ...pin, skillSelection: { kind: 'plugin' as const }, declarations: [] }] };
    await workflows.updateManagedAgentConfiguration({ actor: ownerActor, agentId: emailId,
      expectedRevision: email.revision, expectedWorkflowRevision: 0, workflow: oldWorkflow });
    email = await registry.getAgentProfile(emailId) as AgentProfile;
    assert.equal(email.workflowVersion, 1, 'V1 personal package behavior remains unchanged.');
    const ordinaryV1 = await management.inspectManagedAgent(aliceActor, emailId);
    assert.equal(ordinaryV1.extensions.configuration, null);
    assert.equal(ordinaryV1.extensions.configurationState, 'blocked');
    assert.doesNotMatch(JSON.stringify(ordinaryV1), /retainedBindingRef|accountSelectionRef|configuration_json|personalBinding|boundProviderRef/u);
    const beforeDenied = await state();
    await expectCode(() => workflows.updateManagedAgentConfiguration({ actor: ownerActor, agentId: emailId,
      expectedRevision: email.revision, expectedWorkflowRevision: email.workflowRevision!, extensions: { ...empty, mode: 'fixed',
        workflow: oldWorkflow, selections: [{ selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } },
          requirement: 'optional', toolCap: null }] } }), 'AGENT_ORGANIZATION_CAPABILITY_SCOPE_INVALID');
    assert.deepEqual(await state(), beforeDenied, 'A rejected V2 private package cannot partially mutate V1.');

    stage = 'V2 shared System target rejects fixed and central-choice personal MCP';
    const configRoute = await import('../app/api/integrations/mcp-config/route');
    const config = await import('../app/lib/mcp/config');
    const personalResponse = await configRoute.PUT(new NextRequest('http://localhost:3001/api/integrations/mcp-config', {
      method: 'PUT', headers: fixture.headers(owner.userId), body: JSON.stringify({ rawContent: JSON.stringify({ mcpServers: {
        'Email private source': { url: 'https://private.fixture.invalid/mcp', transport: 'http', auth: 'none', enabled: true },
      } }) }),
    }));
    assert.equal(personalResponse.status, 200);
    const personal = (await config.readMcpConfig({ userId: owner.userId })).mcpServers['Email private source'];
    assert(personal.connectionId);
    const personalSelection = { kind: 'mcp' as const, source: 'mcp' as const,
      target: { kind: 'personal' as const, connectionRef: `mcp-personal:${personal.connectionId}` } };
    for (const standalone of [
      [{ mode: 'fixed' as const, entry: { selection: personalSelection, requirement: 'optional' as const, toolCap: null } }],
      [{ mode: 'selectable' as const, source: 'mcp' as const, configurationId: 'no-creator-account', requirement: 'optional' as const,
        allowedChoices: [{ choiceId: 'creator', selection: personalSelection, toolCap: null }], defaultChoiceId: 'creator' }],
    ]) {
      await expectCode(() => workflows.updateManagedAgentConfiguration({ actor: ownerActor, agentId: emailId,
        expectedRevision: email.revision, expectedWorkflowRevision: email.workflowRevision!, extensions: { ...empty, mode: 'fixed', standalone } }),
      'AGENT_WORKFLOW_BINDING_DENIED');
      assert.deepEqual(await state(), beforeDenied);
    }

    stage = 'genuine V2 migration marker and lifecycle/actor/lease negative matrix';
    await expectCode(() => sharedSource('Premature Email-target grant', 'agent', emailId), 'CONNECTION_TARGET_INVALID');
    await sql.run('BEGIN');
    let heldBatch: Awaited<ReturnType<typeof connections.lockIntegrationConnectionBindingsOnConnection>>;
    let marker: Awaited<ReturnType<typeof connections.prepareEmailV2BindingConfigurationOnConnection>>;
    try {
      heldBatch = await connections.lockIntegrationConnectionBindingsOnConnection(sql, ownerSource, [source.resource.connectionRef]);
      await sql.get('SELECT agent_id FROM agents WHERE agent_id=$1 FOR UPDATE', [emailId]);
      await expectCode(() => connections.authorizeIntegrationConnectionBindingsOnConnection(sql, heldBatch, email, 'configure'), 'CONNECTION_ACCESS_DENIED');
      await expectCode(() => connections.authorizeIntegrationConnectionBindingsOnConnection(sql, heldBatch, email, 'read'), 'CONNECTION_ACCESS_DENIED');
      marker = await connections.prepareEmailV2BindingConfigurationOnConnection(sql, heldBatch, email);
      const [actual] = await connections.authorizeIntegrationConnectionBindingsOnConnection(sql, heldBatch, email, 'configure', { emailV2Configuration: marker });
      assert.equal(actual.canUse, true);
      assert.deepEqual(actual.allowedToolNames, ['READ'], 'V2 admission retains the source ceiling.');
      await expectCode(() => connections.authorizeIntegrationConnectionBindingsOnConnection(sql, heldBatch, email, 'configure',
        { emailV2Configuration: { ...marker } }), 'CONNECTION_ACCESS_DENIED');
      await expectCode(() => connections.authorizeIntegrationConnectionBindingsOnConnection(sql, heldBatch, email, 'read',
        { emailV2Configuration: marker }), 'CONNECTION_ACCESS_DENIED');
      await expectCode(() => connections.prepareEmailV2BindingConfigurationOnConnection(sql, heldBatch,
        { ...email, revision: email.revision + 1 }), 'CONNECTION_ACCESS_DENIED');
      const otherBatch = await connections.lockIntegrationConnectionBindingsOnConnection(sql, ownerSource, [source.resource.connectionRef]);
      await expectCode(() => connections.authorizeIntegrationConnectionBindingsOnConnection(sql, otherBatch, email, 'configure',
        { emailV2Configuration: marker }), 'CONNECTION_ACCESS_DENIED');
      const otherLease = await fixture.openObserverConnection();
      try { await expectCode(() => connections.authorizeIntegrationConnectionBindingsOnConnection(otherLease, heldBatch, email, 'configure',
        { emailV2Configuration: marker }), 'CONNECTION_ACCESS_DENIED'); }
      finally { await otherLease.close(); }
    } finally { await sql.run('ROLLBACK'); }
    for (const end of ['ROLLBACK', 'COMMIT']) {
      await sql.run('BEGIN');
      try {
        await expectCode(() => connections.authorizeIntegrationConnectionBindingsOnConnection(sql, heldBatch!, email, 'configure',
          { emailV2Configuration: marker! }), 'CONNECTION_ACCESS_DENIED');
        await expectCode(() => connections.prepareEmailV2BindingConfigurationOnConnection(sql, heldBatch!, email), 'CONNECTION_ACCESS_DENIED');
        heldBatch = await connections.lockIntegrationConnectionBindingsOnConnection(sql, ownerSource, [source.resource.connectionRef]);
        marker = await connections.prepareEmailV2BindingConfigurationOnConnection(sql, heldBatch, email);
      } finally { await sql.run(end); }
    }
    await expectCode(() => connections.authorizeIntegrationConnectionBindingsOnConnection(sql, heldBatch!, email, 'configure',
      { emailV2Configuration: marker! }), 'CONNECTION_ACCESS_DENIED');
    await sql.run('BEGIN');
    try {
      const memberBatch = await connections.lockIntegrationConnectionBindingsOnConnection(sql, aliceSource, [source.resource.connectionRef]);
      await expectCode(() => connections.prepareEmailV2BindingConfigurationOnConnection(sql, memberBatch, email), 'CONNECTION_ACCESS_DENIED');
      const foreignBatch = await connections.lockIntegrationConnectionBindingsOnConnection(sql, { ...ownerSource, organizationId: 'foreign-org' },
        [source.resource.connectionRef]);
      await expectCode(() => connections.prepareEmailV2BindingConfigurationOnConnection(sql, foreignBatch, email), 'AGENT_ACTOR_CONTEXT_DENIED');
    } finally { await sql.run('ROLLBACK'); }

    stage = 'real API V2 migration then exact Email-target-only grant';
    await update({ ...empty, mode: 'fixed', standalone: [{ mode: 'fixed', entry: sharedEntry(source) }] });
    assert.equal(email.workflowVersion, 2);
    const catalog = await connections.listSharedIntegrationConnectionTargets(ownerSource, source.resource.connectionRef);
    assert(catalog.agents.some(agent => agent.agentId === emailId));
    const targeted = await sharedSource('Exact Email target-only source', 'agent', emailId);
    await update({ ...empty, mode: 'fixed', standalone: [{ mode: 'fixed', entry: sharedEntry(targeted) }] });
    const admin = await management.inspectManagedAgent(ownerActor, emailId);
    assert.equal(admin.extensions.configurationState, 'available');
    assert.equal(admin.extensions.configuration?.mode, 'fixed');
    assert.doesNotMatch(JSON.stringify(admin), /personalBinding|boundProviderRef|backend_connection_id|configuration_json|https:\/\/fixture.invalid/u);
    for (const end of ['COMMIT', 'ROLLBACK']) for (const purpose of ['read', 'configure'] as const) {
      await sql.run('BEGIN');
      let endedBatch: Awaited<ReturnType<typeof connections.lockIntegrationConnectionBindingsOnConnection>>;
      try {
        endedBatch = await connections.lockIntegrationConnectionBindingsOnConnection(sql, ownerSource, [targeted.resource.connectionRef]);
        assert.equal((await connections.authorizeIntegrationConnectionBindingsOnConnection(sql, endedBatch, email, purpose))[0].canUse, true);
      } finally { await sql.run(end); }
      await sql.run('BEGIN');
      try {
        await expectCode(() => connections.authorizeIntegrationConnectionBindingsOnConnection(sql, endedBatch!, email, purpose), 'CONNECTION_ACCESS_DENIED');
      } finally { await sql.run('ROLLBACK'); }
    }
    await sql.run('BEGIN');
    try {
      const batch = await connections.lockIntegrationConnectionBindingsOnConnection(sql, aliceSource, [targeted.resource.connectionRef]);
      const [read] = await connections.authorizeIntegrationConnectionBindingsOnConnection(sql, batch, email, 'read');
      assert.equal(read.canUse, true);
      assert.equal(read.canManage, false);
      assert.deepEqual(read.allowedToolNames, ['READ']);
      await expectCode(() => connections.authorizeIntegrationConnectionBindingsOnConnection(sql, batch, email, 'configure'), 'CONNECTION_ACCESS_DENIED');
    } finally { await sql.run('ROLLBACK'); }
    const summary = await workflows.inspectManagedAgentWorkflow(aliceActor, emailId);
    assert.equal(summary.standalone?.[0].selectedConnection?.availability, 'available');
    assert.equal(summary.standalone?.[0].selectedConnection?.status, 'unknown', 'Metadata never claims live provider health.');
    const publicResponse = await route.GET(new NextRequest(`http://localhost:3001/api/agents?agentId=${emailId}&workspaceId=${alice.workspaceId}`, {
      headers: fixture.headers(alice.userId),
    }));
    assert.equal(publicResponse.status, 200);
    const publicData = await publicResponse.json();
    assert.equal(publicData.data.extensions.configuration, null, 'An ordinary Email member never receives editable retention hints.');
    assert.equal(publicData.data.extensions.readiness[0].readiness, 'available');
    assert.doesNotMatch(JSON.stringify(publicData), /retainedBindingRef|accountSelectionRef|personalBinding|boundProviderRef|backend_connection_id|configuration_json/u);

    stage = 'actual stored Email session Use and revoked/foreign-context negatives';
    const sessionId = `email-scope-session-${randomUUID()}`;
    await fixture.database.db.insert(piSessions).values({ sessionId, userId: alice.userId, agentId: emailId, workspaceId: alice.workspaceId!,
      workspaceType: 'personal', organizationId, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const runtime = { ...aliceSource, agentId: emailId, sessionId, policyRevision: 'email-scope-proof' };
    const actualUse = await connections.authorizeIntegrationConnection(runtime, targeted.resource.connectionRef, 'use', 'READ');
    assert.equal(actualUse.access.canUse, true);
    assert.equal(actualUse.access.canManage, false);
    assert.deepEqual(actualUse.allowedToolNames, ['READ']);
    for (const changed of [{ ...runtime, organizationId: 'foreign-org' }, { ...runtime, sessionId: 'unknown-session' },
      { ...runtime, workspaceId: owner.workspaceId }, { ...runtime, agentId: 'different-agent' }]) {
      await expectCode(() => connections.authorizeIntegrationConnection(changed, targeted.resource.connectionRef, 'use', 'READ'), 'CONNECTION_ACCESS_DENIED');
    }
    await expectCode(() => connections.authorizeIntegrationConnection(runtime, targeted.resource.connectionRef, 'use', 'OTHER'), 'CONNECTION_ACCESS_DENIED');
    const revoked = await connections.mutateSharedIntegrationConnection(ownerSource, targeted.resource.connectionRef, {
      expectedMetadataRevision: targeted.resource.metadataRevision, expectedGrantsRevision: targeted.resource.grantsRevision,
      expectedBindingRevision: targeted.resource.bindingRevision, grants: [],
    });
    assert.equal(revoked.resource.grantsRevision, targeted.resource.grantsRevision + 1);
    await expectCode(() => connections.revalidateAuthorizedIntegrationConnection(actualUse, 'use', 'READ'), 'CONNECTION_ACCESS_DENIED');
    await sql.run('BEGIN');
    try {
      const batch = await connections.lockIntegrationConnectionBindingsOnConnection(sql, aliceSource, [targeted.resource.connectionRef]);
      await expectCode(() => connections.authorizeIntegrationConnectionBindingsOnConnection(sql, batch, email, 'read'), 'CONNECTION_ACCESS_DENIED');
    } finally { await sql.run('ROLLBACK'); }
    const revokedSummary = await management.inspectManagedAgent(aliceActor, emailId);
    assert.equal(revokedSummary.extensions.configuration, null);
    assert.equal(revokedSummary.extensions.readiness[0].readiness, 'blocked');

    stage = 'actual header, current membership and legacy runtime-grant compatibility';
    const nextTarget = await sharedSource('Header-fenced Email grant', 'agent', emailId);
    await sql.run('UPDATE agents SET workflow_version=1 WHERE agent_id=$1', [emailId]);
    await expectCode(() => connections.authorizeIntegrationConnection(runtime, nextTarget.resource.connectionRef, 'use', 'READ'), 'CONNECTION_ACCESS_DENIED');
    await expectCode(() => sharedSource('No target grant for V1 Email', 'agent', emailId), 'CONNECTION_TARGET_INVALID');
    assert(!(await connections.listSharedIntegrationConnectionTargets(ownerSource, source.resource.connectionRef)).agents.some(agent => agent.agentId === emailId));
    const legacyUser = await sharedSource('Unchanged V1 user grant', 'user', alice.userId);
    const legacyInherited = await sharedSource('Unchanged V1 inherit grant', 'user', owner.userId, 'inherit');
    for (const legacy of [legacyUser, legacyInherited]) {
      assert.equal((await connections.authorizeIntegrationConnection(runtime, legacy.resource.connectionRef, 'use', 'READ')).access.canUse, true);
    }
    await sql.run('UPDATE agents SET workflow_version=2 WHERE agent_id=$1', [emailId]);
    await sql.run("UPDATE organization_user_permissions SET status='revoked' WHERE user_id=$1", [alice.userId]);
    await expectCode(() => connections.authorizeIntegrationConnection(runtime, nextTarget.resource.connectionRef, 'use', 'READ'), 'CONNECTION_ACCESS_DENIED');
    await sql.run("UPDATE organization_user_permissions SET status='active' WHERE user_id=$1", [alice.userId]);
    await sql.run(`INSERT INTO canvas_organization_settings
      (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('foreign-org',$1,'team',1,2,2)`, [owner.userId]);
    await sql.run("UPDATE agents SET organization_id='foreign-org' WHERE agent_id=$1", [emailId]);
    await expectCode(() => connections.authorizeIntegrationConnection(runtime, nextTarget.resource.connectionRef, 'use', 'READ'), 'CONNECTION_ACCESS_DENIED');
    await expectCode(() => sharedSource('No foreign Email target', 'agent', emailId), 'CONNECTION_TARGET_INVALID');
    await sql.run('UPDATE agents SET organization_id=NULL WHERE agent_id=$1', [emailId]);
    const arbitrary = await registry.createAgentProfile({ agentId: `arbitrary-system-${randomUUID()}`, name: 'Not the Email target',
      scopeType: 'user', organizationId: null, createdByUserId: owner.userId, accessPolicy: 'restricted' });
    // The public creation contract cannot mint System agents; seed that exact
    // negative precondition directly in this owned database and verify it.
    await sql.run("UPDATE agents SET scope_type='system',workflow_version=2,workflow_revision=1 WHERE agent_id=$1", [arbitrary.agentId]);
    assert.equal((await registry.getAgentProfile(arbitrary.agentId))?.scopeType, 'system');
    await expectCode(() => sharedSource('No arbitrary System target', 'agent', arbitrary.agentId), 'CONNECTION_TARGET_INVALID');
    assert.equal(fixture.providerRequests(), 0, 'No provider discovery, health or business calls occur.');
    console.log(`PASS Email shared V2 scopes (${fixture.native ? 'native PostgreSQL' : 'PGlite'}): real V1 preservation, private-source rejects, TX marker lifecycle, API migration, member summary, actual session Use, current header/ACL revocation.`);
  } catch (error) {
    console.error(`Email scope fixture failed at ${stage}`);
    throw error;
  } finally { await fixture.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
