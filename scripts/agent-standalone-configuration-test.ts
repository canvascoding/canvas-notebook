import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { AgentManagementActor } from '../app/lib/agents/management-actions';
import type { AgentStandaloneConfigurationInput } from '../app/lib/capabilities/extensions/contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

async function expectCode(operation: () => unknown | Promise<unknown>, code: string) {
  await assert.rejects(async () => operation(), error => {
    assert.equal(error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined, code);
    return true;
  });
}

async function main() {
  // Real PGlite SQL, actor/agent/source ACL, codecs, config API and locked batch.
  // This is service/transaction evidence, not native PostgreSQL lock scheduling.
  const fixture = await createCapabilityPackageStoreApplicationFixture();
  try {
    const service = await import('../app/lib/capabilities/extensions/agent-standalone-configuration');
    const configRoute = await import('../app/api/integrations/mcp-config/route');
    const config = await import('../app/lib/mcp/config');
    const registry = await import('../app/lib/agents/registry');
    const grants = await import('../app/lib/agents/grants');
    const workflow = await import('../app/lib/agents/workflow-configuration');
    const connections = await import('../app/lib/integration-tools/connections/store');
    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const { createStandaloneExtensionSlotRef } = await import('../app/lib/capabilities/extensions/standalone-reference');
    const contracts = await import('../app/lib/capabilities/extensions/contracts');
    const { resolveOrganizationMcpTemplatesDir } = await import('../app/lib/runtime-data-paths');
    const owner: AgentManagementActor = { ...fixture.owner, source: 'api' };
    const alice: AgentManagementActor = { ...fixture.alice, source: 'api' };
    const actorWithOrganization = { ...owner, organizationId: fixture.organizationId };
    const response = await configRoute.PUT(new NextRequest('http://localhost:3001/api/integrations/mcp-config', {
      method: 'PUT', headers: fixture.headers('owner'),
      body: JSON.stringify({ rawContent: JSON.stringify({ mcpServers: {
        'Exact configured account': { url: 'https://mcp.example.test/mcp', transport: 'http', auth: 'none', enabled: true },
      } }) }),
    }));
    assert.equal(response.status, 200);
    const actual = (await config.readMcpConfig({ userId: owner.userId })).mcpServers['Exact configured account'];
    assert(actual.connectionId && actual.ownerUserId === owner.userId);
    const selection = { kind: 'mcp' as const, source: 'mcp' as const,
      target: { kind: 'personal' as const, connectionRef: `mcp-personal:${actual.connectionId}` } };
    const input: AgentStandaloneConfigurationInput[] = [{ mode: 'fixed',
      entry: { selection, requirement: 'required', toolCap: ['READ'] } }];
    const personal = await service.prepareAgentStandaloneConfigurations(owner, input);
    const stored = service.getPreparedAgentStandaloneConfigurations(personal, owner);
    assert.equal(stored.length, 1);
    assert(stored[0].mode === 'fixed' && stored[0].entry.target.kind === 'personal');
    assert.equal(stored[0].entry.target.ownerUserId, owner.userId);
    assert.deepEqual(stored[0].entry.toolCap, ['READ']);
    assert(Object.isFrozen(stored) && Object.isFrozen(stored[0].entry.selection));
    assert(!JSON.stringify(stored).includes('accountSelectionRef'));
    assert(!JSON.stringify(stored).includes('retainedBindingRef'));
    if (input[0].mode === 'fixed') input[0].entry.toolCap = [];
    assert.deepEqual(stored[0].entry.toolCap, ['READ']);
    for (const actor of [alice, actorWithOrganization, { ...owner, projectId: 'different-project' },
      { ...owner, sourceAgentId: 'different-agent' }, { ...owner, sessionId: 'different-session' }]) {
      await expectCode(() => service.getPreparedAgentStandaloneConfigurations(personal, actor), 'AGENT_EXTENSION_CONFIGURATION_DENIED');
    }
    await expectCode(() => service.getPreparedAgentStandaloneConfigurations({ ...personal }, owner), 'AGENT_EXTENSION_CONFIGURATION_DENIED');
    await expectCode(() => service.prepareAgentStandaloneConfigurations(alice, input), 'provider_denied');
    const profile = await registry.createAgentProfile({ agentId: 'standalone-service-owner', name: 'Exact personal setup',
      scopeType: 'user', organizationId: fixture.organizationId, ownerUserId: owner.userId,
      createdByUserId: owner.userId, accessPolicy: 'restricted' });
    const organizationAgent = await registry.createAgentProfile({ agentId: 'standalone-service-organization', name: 'Shared setup only',
      scopeType: 'organization', organizationId: fixture.organizationId,
      createdByUserId: owner.userId, accessPolicy: 'restricted' });
    await grants.upsertAgentGrant({ agentId: organizationAgent.agentId, organizationId: fixture.organizationId,
      targetType: 'user', targetId: owner.userId, actorUserId: owner.userId,
      canUse: true, canEdit: true, canManage: true });
    await fixture.sql.run('BEGIN');
    try {
      const batch = await connections.lockIntegrationConnectionBindingsOnConnection(fixture.sql, actorWithOrganization, []);
      await service.revalidatePreparedAgentStandalonePersonalConfigurations(personal, owner, { database: fixture.sql });
      assert.equal(await service.authorizePreparedAgentStandaloneConfigurationsOnConnection(personal, owner, fixture.sql, batch, profile), stored);
      await expectCode(() => service.authorizePreparedAgentStandaloneConfigurationsOnConnection(personal, owner, fixture.sql,
        { ...batch }, profile), 'CONNECTION_ACCESS_DENIED');
      await expectCode(() => service.authorizePreparedAgentStandaloneConfigurationsOnConnection(personal, owner, fixture.sql,
        batch, { ...profile, revision: profile.revision + 1 }), 'AGENT_EXTENSION_TARGET_CHANGED');
      await expectCode(() => service.authorizePreparedAgentStandaloneConfigurationsOnConnection(personal, owner, fixture.sql,
        batch, organizationAgent), 'AGENT_WORKFLOW_BINDING_DENIED');
    } finally { await fixture.sql.run('ROLLBACK'); }

    const slotRef = createStandaloneExtensionSlotRef({ configurationId: stored[0].configurationId, source: 'mcp' });
    await fixture.sql.run(`INSERT INTO agent_capability_bindings
      (id,agent_id,resource_type,scope_type,resource_id,name,version,requirement,revision,created_at,updated_at,configuration_json)
      VALUES($1,$2,'connection','user',$3,'Exact connection','v2','required',1,1,1,$4)`,
    [`binding-${randomUUID()}`, profile.agentId, slotRef, JSON.stringify(stored[0])]);
    await fixture.sql.run('UPDATE agents SET workflow_version=2,workflow_revision=1 WHERE agent_id=$1', [profile.agentId]);
    const before = await workflow.readManagedAgentWorkflow(owner, profile.agentId);
    const projected = await service.projectAgentStandaloneConfigurations(owner, before);
    assert.equal(projected.length, 1);
    assert(projected[0].mode === 'fixed');
    assert.match(projected[0].entry.retainedBindingRef!, /^agent-extension-retain:v1:[a-f0-9]{64}$/u);
    assert.equal(projected[0].entry.accountSelectionRef, undefined);
    assert(!JSON.stringify(projected).includes('bindingFingerprint'));
    assert(!JSON.stringify(projected).includes('boundProviderRef'));
    const equivalent = await service.projectAgentStandaloneConfigurations(actorWithOrganization, before);
    assert.deepEqual(projected, equivalent, 'Omitted organization and current resolved organization have one retention namespace.');
    const retained = await service.prepareAgentStandaloneConfigurations(owner, projected, before);
    assert.deepEqual(service.getPreparedAgentStandaloneConfigurations(retained, owner), stored);
    await fixture.sql.run('BEGIN');
    try { await service.revalidatePreparedAgentStandalonePersonalConfigurations(retained, owner, { database: fixture.sql }); }
    finally { await fixture.sql.run('ROLLBACK'); }
    await expectCode(() => service.projectAgentStandaloneConfigurations(alice, before), 'AGENT_EXTENSION_TARGET_CHANGED');
    await expectCode(() => service.prepareAgentStandaloneConfigurations(owner, projected, { ...before }), 'AGENT_EXTENSION_CONFIGURATION_DENIED');
    const changedRef = structuredClone(projected);
    assert(changedRef[0].mode === 'fixed');
    changedRef[0].entry.retainedBindingRef = `agent-extension-retain:v1:${'a'.repeat(64)}`;
    await expectCode(() => service.prepareAgentStandaloneConfigurations(owner, changedRef, before), 'AGENT_EXTENSION_RETENTION_INVALID');
    const changedIdentity = structuredClone(projected);
    assert(changedIdentity[0].mode === 'fixed' && changedIdentity[0].entry.selection.kind === 'mcp');
    changedIdentity[0].entry.selection.target = { kind: 'personal', connectionRef: `mcp-personal:${randomUUID()}` };
    await expectCode(() => service.prepareAgentStandaloneConfigurations(owner, changedIdentity, before), 'AGENT_EXTENSION_RETENTION_INVALID');
    const foreignChoice = structuredClone(projected);
    const fixedForeignChoice = foreignChoice[0];
    assert(fixedForeignChoice.mode === 'fixed');
    await expectCode(() => service.prepareAgentStandaloneConfigurations(owner, [{ mode: 'selectable', configurationId: fixedForeignChoice.configurationId,
      source: 'mcp', requirement: 'required', allowedChoices: [{ choiceId: 'wrong-choice', selection,
        toolCap: null, retainedBindingRef: fixedForeignChoice.entry.retainedBindingRef }] }], before), 'AGENT_EXTENSION_RETENTION_INVALID');
    let exactProfileReads = 0;
    fixture.setBeforeRead(async query => {
      if (!query.startsWith('SELECT * FROM agents WHERE agent_id')) return;
      if (++exactProfileReads === 2) await fixture.sql.run('UPDATE agents SET revision=revision+1 WHERE agent_id=$1', [profile.agentId]);
    });
    try {
      await expectCode(() => service.projectAgentStandaloneConfigurations(owner, before), 'AGENT_EXTENSION_TARGET_CHANGED');
      assert.equal(exactProfileReads, 2, 'The current actor/edit/revision fence is checked again after local source reads.');
    } finally {
      fixture.setBeforeRead(undefined);
      await fixture.sql.run('UPDATE agents SET revision=$1 WHERE agent_id=$2', [before.agent.revision, profile.agentId]);
    }

    const aliceAgent = await registry.createAgentProfile({ agentId: 'standalone-service-alice', name: 'Target-only connection',
      scopeType: 'organization', organizationId: fixture.organizationId,
      createdByUserId: owner.userId, accessPolicy: 'restricted' });
    await grants.upsertAgentGrant({ agentId: aliceAgent.agentId, organizationId: fixture.organizationId,
      targetType: 'user', targetId: alice.userId, actorUserId: owner.userId,
      canUse: true, canEdit: true, canManage: false });
    const shared = await createSharedMcpConnection(actorWithOrganization, { ownership: { type: 'organization', organizationId: fixture.organizationId },
      displayName: 'Only target agent may use this', accessMode: 'restricted', allowedToolNames: ['READ'],
      grants: [{ targetType: 'agent', targetId: aliceAgent.agentId, canUse: true, canManage: false, allowedToolNames: ['READ'] }],
      config: { url: 'https://shared.example.test/mcp', transport: 'http', auth: 'none', enabled: true } });
    const sharedSelection = { kind: 'mcp' as const, source: 'mcp' as const, target: { kind: 'shared' as const,
      connectionRef: shared.resource.connectionRef, bindingRevision: shared.resource.bindingRevision } };
    await expectCode(() => connections.authorizeIntegrationConnection({ ...alice, organizationId: fixture.organizationId },
      shared.resource.connectionRef, 'use'), 'CONNECTION_ACCESS_DENIED');
    const sharedProof = await service.prepareAgentStandaloneConfigurations(alice, [{ mode: 'fixed',
      entry: { selection: sharedSelection, requirement: 'required', toolCap: ['READ', 'EXTRA'] } }]);
    assert.deepEqual(service.getPreparedAgentStandaloneSharedReferences(sharedProof, alice), [shared.resource.connectionRef]);
    await fixture.sql.run('BEGIN');
    try {
      const batch = await connections.lockIntegrationConnectionBindingsOnConnection(fixture.sql,
        { ...alice, organizationId: fixture.organizationId }, [shared.resource.connectionRef]);
      const granted = await service.authorizePreparedAgentStandaloneConfigurationsOnConnection(sharedProof, alice, fixture.sql, batch, aliceAgent);
      assert(granted[0].mode === 'fixed' && granted[0].entry.target.kind === 'shared');
      assert.deepEqual(granted[0].entry.toolCap, ['READ', 'EXTRA'], 'Configured cap is intent; source rights retain their independent execution ceiling.');
    } finally { await fixture.sql.run('ROLLBACK'); }
    await fixture.sql.run(`INSERT INTO canvas_workspaces
      (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at)
      VALUES('personal-alice-alternate',$1,'personal',$2,'personal-alice-alternate','Alternate','active',1,1)`,
    [fixture.organizationId, alice.userId]);
    await fixture.sql.run('BEGIN');
    try {
      const batch = await connections.lockIntegrationConnectionBindingsOnConnection(fixture.sql,
        { ...alice, organizationId: fixture.organizationId, workspaceId: 'personal-alice-alternate' }, [shared.resource.connectionRef]);
      await expectCode(() => service.authorizePreparedAgentStandaloneConfigurationsOnConnection(sharedProof, alice, fixture.sql,
        batch, aliceAgent), 'AGENT_WORKFLOW_BINDING_CHANGED');
    } finally { await fixture.sql.run('ROLLBACK'); }
    await fixture.sql.run('UPDATE integration_connection_grants SET can_use=0 WHERE connection_ref=$1', [shared.resource.connectionRef]);
    await fixture.sql.run('BEGIN');
    try {
      const batch = await connections.lockIntegrationConnectionBindingsOnConnection(fixture.sql,
        { ...alice, organizationId: fixture.organizationId }, [shared.resource.connectionRef]);
      await expectCode(() => service.authorizePreparedAgentStandaloneConfigurationsOnConnection(sharedProof, alice, fixture.sql, batch, aliceAgent), 'CONNECTION_ACCESS_DENIED');
    } finally { await fixture.sql.run('ROLLBACK'); }

    const initialAccount = { selection: { kind: 'composio', source: 'composio', toolkit: 'canva', target: {
      kind: 'personal', profileId: 'profile', accountBinding: 'account', accountId: 'account', connectionRef: 'composio-personal:profile:account' } },
    requirement: 'required', toolCap: null };
    assert.equal(contracts.agentStandaloneEntryInputSchema.safeParse(initialAccount).success, false);
    const retainedAccount = { ...initialAccount, retainedBindingRef: `agent-extension-retain:v1:${'a'.repeat(64)}` };
    assert.equal(contracts.agentStandaloneEntryInputSchema.safeParse(retainedAccount).success, true);
    assert.equal(contracts.standaloneExtensionInputSchema.safeParse(retainedAccount).success, false, 'Agent retention is never chat account admission.');
    assert.equal(contracts.agentStandaloneEntryInputSchema.safeParse({ ...retainedAccount,
      accountSelectionRef: `cmp_personal_account_${'r'.repeat(50)}` }).success, false);

    const definitionId = randomUUID();
    const policy = [{ mode: 'selectable', source: 'mcp', configurationId: 'per-user-approved-mcp',
      requirement: 'optional', allowedChoices: [], personalPolicy: { source: 'mcp',
        serverDefinitionIds: [definitionId], toolCap: [] } }];
    await expectCode(() => service.prepareAgentStandaloneConfigurations(owner, policy), 'AGENT_EXTENSION_POLICY_DENIED');
    const definitionsPath = path.join(resolveOrganizationMcpTemplatesDir(fixture.organizationId), 'approved-servers.json');
    assert(definitionsPath.startsWith(`${fixture.root}${path.sep}`));
    const definition = { version: 1, id: definitionId, organizationId: fixture.organizationId, name: 'Approved fixture',
      enabled: true, revision: 1, config: { url: 'https://approved.example.test/mcp', transport: 'http', auth: 'none' },
      updatedAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(definitionsPath), { recursive: true });
    await fs.writeFile(definitionsPath, JSON.stringify({ version: 1, definitions: [definition] }));
    const preparedPolicy = await service.prepareAgentStandaloneConfigurations(owner, policy);
    await fixture.sql.run('BEGIN');
    try { await service.revalidatePreparedAgentStandalonePersonalConfigurations(preparedPolicy, owner, { database: fixture.sql }); }
    finally { await fixture.sql.run('ROLLBACK'); }
    await fs.writeFile(definitionsPath, JSON.stringify({ version: 1, definitions: [{ ...definition, revision: 2 }] }));
    await fixture.sql.run('BEGIN');
    try { await expectCode(() => service.revalidatePreparedAgentStandalonePersonalConfigurations(preparedPolicy, owner,
      { database: fixture.sql }), 'AGENT_EXTENSION_POLICY_CHANGED'); }
    finally { await fixture.sql.run('ROLLBACK'); }
    await fs.writeFile(definitionsPath, JSON.stringify({ version: 1, definitions: [{ ...definition, enabled: false }] }));
    await expectCode(() => service.prepareAgentStandaloneConfigurations(owner, policy), 'AGENT_EXTENSION_POLICY_DENIED');
    let getterRead = false;
    const accessor = Object.defineProperty({}, 'mode', { enumerable: true, get() { getterRead = true; return 'fixed'; } });
    await assert.rejects(() => service.prepareAgentStandaloneConfigurations(owner, [accessor]));
    assert.equal(getterRead, false);
    assert.equal(fixture.providerRequests(), 0, 'Configuration and retained Inspect do not contact providers.');
    console.log('PASS agent standalone configuration: real SQL actor/ACL, actual API personal identity, exact retention roundtrip, locked target-only shared grant, revoked grant, no provider requests.');
  } finally { await fixture.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
