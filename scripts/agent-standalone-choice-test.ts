import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { AgentManagementActor } from '../app/lib/agents/management-actions';
import type { StandaloneExtensionInput } from '../app/lib/capabilities/extensions/contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';

async function expectCode(operation: () => unknown | Promise<unknown>, code: string) {
  await assert.rejects(async () => operation(), error => {
    assert.equal(error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined, code);
    return true;
  });
}

async function main() {
  // Real PGlite SQL, persisted configuration, API session, ACL and provider SDK.
  // Only owned-loopback provider metadata is allowed. Native lock scheduling is a separate proof.
  const originalFetch = globalThis.fetch;
  const oldBase = process.env.COMPOSIO_BASE_URL;
  const oldLogging = process.env.COMPOSIO_LOGGING_LEVEL;
  process.env.COMPOSIO_LOGGING_LEVEL = 'silent';
  const fixture = await createCapabilityPackageStoreApplicationFixture();
  const provider = await createComposioProviderFixture();
  const fixtureFetch = globalThis.fetch;
  process.env.COMPOSIO_BASE_URL = provider.baseUrl;
  let blockedRequests = 0, blockedSdkVersionChecks = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== provider.baseUrl) {
      if (url.href === 'https://registry.npmjs.org/@composio/core/latest') {
        blockedSdkVersionChecks++;
        throw new Error('The SDK version lookup is blocked before network access.');
      }
      return fixtureFetch(input, init);
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET' || !['/api/v3.1/toolkits', '/api/v3.1/connected_accounts'].includes(url.pathname)) {
      blockedRequests++;
      throw new Error('Only owned provider metadata GETs are permitted.');
    }
    return originalFetch(input, { ...init, redirect: 'error' });
  };
  try {
    const service = await import('../app/lib/agents/extension-choice');
    const workflow = await import('../app/lib/agents/workflow-configuration');
    const preparation = await import('../app/lib/capabilities/extensions/agent-standalone-configuration');
    const registry = await import('../app/lib/agents/registry');
    const grants = await import('../app/lib/agents/grants');
    const connections = await import('../app/lib/integration-tools/connections/store');
    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const config = await import('../app/lib/mcp/config');
    const personalApi = await import('../app/api/integrations/mcp-connections/route');
    const choiceApi = await import('../app/api/agents/workflow/route');
    const { createStandaloneExtensionSlotRef } = await import('../app/lib/capabilities/extensions/standalone-reference');
    const { resolveOrganizationMcpTemplatesDir } = await import('../app/lib/runtime-data-paths');
    const owner: AgentManagementActor = { ...fixture.owner, organizationId: fixture.organizationId, source: 'api' };
    const alice: AgentManagementActor = { ...fixture.alice, source: 'api' };
    const agent = await registry.createAgentProfile({ agentId: 'exact-standalone-user-choice', name: 'Choose within the central policy',
      scopeType: 'organization', organizationId: fixture.organizationId, accessPolicy: 'restricted', createdByUserId: owner.userId });
    for (const [userId, canEdit] of [[owner.userId, true], [alice.userId, false]] as const) {
      await grants.upsertAgentGrant({ agentId: agent.agentId, organizationId: fixture.organizationId,
        targetType: 'user', targetId: userId, actorUserId: owner.userId, canUse: true, canEdit, canManage: canEdit });
    }
    const makeShared = (name: string) => createSharedMcpConnection(owner, { ownership: { type: 'organization', organizationId: fixture.organizationId },
      displayName: name, accessMode: 'restricted', allowedToolNames: ['READ'],
      grants: [{ targetType: 'agent', targetId: agent.agentId, canUse: true, canManage: false, allowedToolNames: ['READ'] }],
      config: { url: `https://${name.toLowerCase()}.example.test/mcp`, transport: 'http', auth: 'none', enabled: true } });
    const a = await makeShared('Alpha'), b = await makeShared('Beta');
    const definitionId = randomUUID(), otherDefinitionId = randomUUID();
    const definitionsPath = path.join(resolveOrganizationMcpTemplatesDir(fixture.organizationId), 'approved-servers.json');
    assert(definitionsPath.startsWith(`${fixture.root}${path.sep}`));
    const definitions = [definitionId, otherDefinitionId].map((id, index) => ({ version: 1, id, organizationId: fixture.organizationId,
      name: `Approved definition ${index}`, enabled: true, revision: 1,
      config: { url: `https://approved-${index}.example.test/mcp`, transport: 'http', auth: 'none' }, updatedAt: new Date().toISOString() }));
    await fs.mkdir(path.dirname(definitionsPath), { recursive: true });
    await fs.writeFile(definitionsPath, JSON.stringify({ version: 1, definitions }));
    const sharedSelection = (value: typeof a) => ({ kind: 'mcp' as const, source: 'mcp' as const,
      target: { kind: 'shared' as const, connectionRef: value.resource.connectionRef, bindingRevision: value.resource.bindingRevision } });
    const slots = [{ mode: 'selectable', source: 'mcp', configurationId: 'choose-approved-mcp', requirement: 'required',
      defaultChoiceId: 'a', allowedChoices: [{ choiceId: 'a', selection: sharedSelection(a), toolCap: ['READ'] },
        { choiceId: 'b', selection: sharedSelection(b), toolCap: [] }],
      personalPolicy: { source: 'mcp', serverDefinitionIds: [definitionId], toolCap: ['READ'] } },
    { mode: 'selectable', source: 'composio', toolkit: 'canva', configurationId: 'choose-own-canva', requirement: 'optional',
      allowedChoices: [], personalPolicy: { source: 'composio', toolkit: 'canva', toolCap: ['ASSET_LOOKUP'] } }];
    const prepared = await preparation.prepareAgentStandaloneConfigurations(owner, slots);
    const configurations = preparation.getPreparedAgentStandaloneConfigurations(prepared, owner);
    await fixture.sql.run('BEGIN');
    try {
      const batch = await connections.lockIntegrationConnectionBindingsOnConnection(fixture.sql, owner,
        preparation.getPreparedAgentStandaloneSharedReferences(prepared, owner));
      await preparation.authorizePreparedAgentStandaloneConfigurationsOnConnection(prepared, owner, fixture.sql, batch, agent);
      for (const configuration of configurations) {
        assert(configuration.mode === 'selectable');
        const resourceId = createStandaloneExtensionSlotRef({ configurationId: configuration.configurationId, source: configuration.source,
          ...(configuration.source === 'composio' ? { toolkit: configuration.toolkit } : {}) });
        await fixture.sql.run(`INSERT INTO agent_capability_bindings
          (id,agent_id,resource_type,scope_type,resource_id,name,version,requirement,revision,created_at,updated_at,configuration_json)
          VALUES($1,$2,'connection','organization',$3,'Configured slot','v2',$4,1,1,1,$5)`,
        [`binding-${randomUUID()}`, agent.agentId, resourceId, configuration.requirement, JSON.stringify(configuration)]);
      }
      await fixture.sql.run('UPDATE agents SET workflow_version=2,workflow_revision=1 WHERE agent_id=$1', [agent.agentId]);
      await fixture.sql.run('COMMIT');
    } catch (error) {
      await fixture.sql.run('ROLLBACK');
      throw error;
    }
    const mcpKey = createStandaloneExtensionSlotRef({ configurationId: 'choose-approved-mcp', source: 'mcp' });
    const canvaKey = createStandaloneExtensionSlotRef({ configurationId: 'choose-own-canva', source: 'composio', toolkit: 'canva' });
    const base = { actor: alice, agentId: agent.agentId, capabilityKey: mcpKey, expectedWorkflowRevision: 1 };
    const prefs = () => fixture.sql.get('SELECT preferences_json,revision FROM agent_user_preferences WHERE agent_id=$1 AND user_id=$2',
      [agent.agentId, alice.userId]) as Promise<{ preferences_json: string; revision: number } | undefined>;
    await fixture.sql.run(`INSERT INTO agent_user_preferences(agent_id,user_id,preferences_json,revision,created_at,updated_at)
      VALUES($1,$2,$3,1,1,1)`, [agent.agentId, alice.userId, JSON.stringify({ unrelated: { theme: 'kept' } })]);
    await expectCode(() => connections.authorizeIntegrationConnection({ ...alice, organizationId: fixture.organizationId },
      b.resource.connectionRef, 'use'), 'CONNECTION_ACCESS_DENIED');
    const apiResponse = await choiceApi.PATCH(new NextRequest(`http://localhost:3001/api/agents/workflow?workspaceId=${alice.workspaceId}`, {
      method: 'PATCH', headers: fixture.headers(alice.userId), body: JSON.stringify({ agentId: agent.agentId,
        capabilityKey: mcpKey, expectedWorkflowRevision: 1, expectedPreferenceRevision: 1, choiceId: 'b' }),
    }));
    assert.equal(apiResponse.status, 200);
    const apiBody = await apiResponse.json();
    assert.equal(apiBody.data.preferenceRevision, 2);
    assert(!JSON.stringify(apiBody).includes('bindingFingerprint') && !JSON.stringify(apiBody).includes('boundProviderRef'));
    let row = (await prefs())!;
    assert.deepEqual(JSON.parse(row.preferences_json), { unrelated: { theme: 'kept' }, workflowChoices: {
      [mcpKey]: { workflowRevision: 1, choiceId: 'b' } } });
    const unchangedAgent = await fixture.sql.get('SELECT * FROM agents WHERE agent_id=$1', [agent.agentId]);
    const unchangedBindings = await fixture.sql.all('SELECT * FROM agent_capability_bindings WHERE agent_id=$1 ORDER BY id', [agent.agentId]);
    await expectCode(() => service.setManagedAgentStandaloneChoice({ ...base, expectedPreferenceRevision: 1, choiceId: 'a' }), 'AGENT_WORKFLOW_CHOICE_REVISION_CONFLICT');
    await expectCode(() => service.setManagedAgentStandaloneChoice({ ...base, expectedPreferenceRevision: 2,
      expectedWorkflowRevision: 99, choiceId: 'a' }), 'AGENT_WORKFLOW_REVISION_CONFLICT');
    await expectCode(() => service.setManagedAgentStandaloneChoice({ ...base, actor: { ...fixture.actor('bob'), source: 'api' },
      expectedPreferenceRevision: 0, choiceId: 'a' }), 'AGENT_ACCESS_DENIED');
    await expectCode(() => service.setManagedAgentStandaloneChoice({ ...base, expectedPreferenceRevision: 2, choiceId: 'not-allowed' }), 'AGENT_WORKFLOW_CHOICE_DENIED');
    await expectCode(() => service.setManagedAgentStandaloneChoice({ ...base, expectedPreferenceRevision: 2,
      capabilityKey: createStandaloneExtensionSlotRef({ configurationId: 'absent-slot', source: 'mcp' }), choiceId: 'a' }), 'AGENT_WORKFLOW_CHOICE_INVALID');
    await expectCode(() => service.setManagedAgentStandaloneChoice({ ...base, expectedPreferenceRevision: 2, choiceId: 'a',
      personalSelection: {} } as Parameters<typeof service.setManagedAgentStandaloneChoice>[0]), 'AGENT_WORKFLOW_CHOICE_INVALID');
    assert.deepEqual(await prefs(), row);
    await fixture.sql.run('UPDATE integration_connection_grants SET can_use=0 WHERE connection_ref=$1', [a.resource.connectionRef]);
    await expectCode(() => service.setManagedAgentStandaloneChoice({ ...base, expectedPreferenceRevision: 2, choiceId: 'a' }), 'CONNECTION_ACCESS_DENIED');
    assert.deepEqual(await prefs(), row);
    await fixture.sql.run('UPDATE integration_connection_grants SET can_use=1 WHERE connection_ref=$1', [a.resource.connectionRef]);
    await fixture.sql.run('UPDATE integration_connection_resources SET binding_revision=binding_revision+1 WHERE connection_ref=$1', [a.resource.connectionRef]);
    await expectCode(() => service.setManagedAgentStandaloneChoice({ ...base, expectedPreferenceRevision: 2, choiceId: 'a' }), 'AGENT_WORKFLOW_BINDING_CHANGED');
    await fixture.sql.run('UPDATE integration_connection_resources SET binding_revision=$1 WHERE connection_ref=$2', [a.resource.bindingRevision, a.resource.connectionRef]);
    assert.deepEqual(await prefs(), row);

    const connect = async (id: string, label: string, userId = alice.userId) => {
      const response = await personalApi.POST(new NextRequest('http://localhost:3001/api/integrations/mcp-connections', {
        method: 'POST', headers: fixture.headers(userId), body: JSON.stringify({ action: 'connect', definitionId: id, displayName: label }),
      }));
      assert.equal(response.status, 200);
      const data = await response.json();
      const actual = (await config.readMcpConfig({ userId })).mcpServers[data.data.server];
      assert(actual.connectionId && actual.ownerUserId === userId && actual.serverDefinitionId === id);
      return actual;
    };
    const ownMcp = await connect(definitionId, 'My permitted MCP'), otherMcp = await connect(otherDefinitionId, 'Other approved MCP');
    const personalMcp: StandaloneExtensionInput = { selection: { kind: 'mcp', source: 'mcp',
      target: { kind: 'personal', connectionRef: `mcp-personal:${ownMcp.connectionId}` } }, requirement: 'required', toolCap: ['READ'] };
    await expectCode(() => service.setManagedAgentStandaloneChoice({ ...base, expectedPreferenceRevision: 2,
      standaloneSelection: { ...personalMcp, toolCap: [] } }), 'AGENT_WORKFLOW_CHOICE_DENIED');
    await expectCode(() => service.setManagedAgentStandaloneChoice({ ...base, expectedPreferenceRevision: 2,
      standaloneSelection: { ...personalMcp, selection: { kind: 'mcp', source: 'mcp', target: {
        kind: 'personal', connectionRef: `mcp-personal:${otherMcp.connectionId}` } } } }), 'AGENT_WORKFLOW_CHOICE_DENIED');
    await expectCode(() => service.setManagedAgentStandaloneChoice({ ...base, expectedPreferenceRevision: 2,
      standaloneSelection: { ...personalMcp, selection: sharedSelection(b) } }), 'AGENT_WORKFLOW_CHOICE_DENIED');
    const chosenPersonal = await service.setManagedAgentStandaloneChoice({ ...base, expectedPreferenceRevision: 2, standaloneSelection: personalMcp });
    assert.equal(chosenPersonal.preferenceRevision, 3);
    row = (await prefs())!;
    const privateChoice = JSON.parse(row.preferences_json).workflowChoices[mcpKey];
    assert.equal(privateChoice.personalTarget.ownerUserId, alice.userId);
    assert.equal(privateChoice.personalTarget.personalBinding.connectionId, ownMcp.connectionId);
    assert.deepEqual(privateChoice.standaloneSelection, personalMcp.selection);
    assert.equal(privateChoice.choiceId, undefined);
    assert(!row.preferences_json.includes('accountSelectionRef'));
    const unchangedRow = structuredClone(row);
    fixture.setBeforeRead(async query => {
      if (query.includes('FROM agent_user_preferences') && query.endsWith('FOR UPDATE')) {
        await fs.writeFile(definitionsPath, JSON.stringify({ version: 1, definitions: definitions.map(value => value.id === definitionId
          ? { ...value, enabled: false } : value) }));
      }
    });
    try {
      await expectCode(() => service.setManagedAgentStandaloneChoice({ ...base, expectedPreferenceRevision: 3,
        standaloneSelection: personalMcp }), 'binding_changed');
    } finally {
      fixture.setBeforeRead(undefined);
      await fs.writeFile(definitionsPath, JSON.stringify({ version: 1, definitions }));
    }
    assert.deepEqual(await prefs(), unchangedRow, 'A source change before write rolls the preference back.');

    const profiles = await import('../app/lib/composio/composio-profiles');
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    const { createIntegrationProviderRef } = await import('../app/lib/integration-tools/references');
    const { listPersonalWorkflowProviderAccountChoices } = await import('../app/lib/integration-tools/workflow-personal-bindings');
    const { readPersonalComposioAccountReference } = await import('../app/lib/composio/composio-shared-account-reference');
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: `fixture-${randomBytes(24).toString('hex')}` }], { secretScope: 'legacy' });
    await profiles.ensureDefaultComposioProfile(alice.userId);
    const profile = await profiles.createComposioProfile({ ownerUserId: alice.userId, name: 'My exact Canva account' });
    provider.accounts.set(profile.composioUserId, [{ id: 'account-a', toolkit: 'canva', status: 'ACTIVE' },
      { id: 'account-b', toolkit: 'canva', status: 'ACTIVE' }]);
    const providerRef = createIntegrationProviderRef({ source: 'composio', profileId: profile.id, toolkit: 'canva',
      scope: { type: 'user', ownerUserId: alice.userId, resourceId: `profile:${profile.id}:canva` } });
    const choices = await listPersonalWorkflowProviderAccountChoices({ actor: alice, providerRef, exactToolkit: { profileId: profile.id, toolkit: 'canva' } });
    assert.equal(choices.accounts.length, 2);
    const receipt = choices.accounts[1].accountSelectionRef;
    const account = readPersonalComposioAccountReference(receipt);
    const personalCanva: StandaloneExtensionInput = { selection: { kind: 'composio', source: 'composio', toolkit: 'canva', target: {
      kind: 'personal', profileId: profile.id, accountBinding: 'account', accountId: account.accountId,
      connectionRef: `composio-personal:${profile.id}:${account.accountId}` } }, requirement: 'optional',
    toolCap: ['ASSET_LOOKUP'], accountSelectionRef: receipt };
    const canvaBase = { ...base, capabilityKey: canvaKey, expectedPreferenceRevision: 3 };
    const noReceipt = { ...personalCanva }; delete noReceipt.accountSelectionRef;
    const metadataBeforeInvalid = provider.calls.length;
    await expectCode(() => service.setManagedAgentStandaloneChoice({ ...canvaBase, standaloneSelection: noReceipt }), 'AGENT_WORKFLOW_CHOICE_INVALID');
    assert.equal(provider.calls.length, metadataBeforeInvalid, 'Missing exact receipt is rejected before provider metadata.');
    await expectCode(() => service.setManagedAgentStandaloneChoice({ ...canvaBase, standaloneSelection: { ...personalCanva,
      selection: { ...personalCanva.selection, toolkit: 'slack' } } as StandaloneExtensionInput }), 'AGENT_WORKFLOW_CHOICE_DENIED');
    const chosenCanva = await service.setManagedAgentStandaloneChoice({ ...canvaBase, standaloneSelection: personalCanva });
    assert.equal(chosenCanva.preferenceRevision, 4);
    row = (await prefs())!;
    const canvaChoice = JSON.parse(row.preferences_json).workflowChoices[canvaKey];
    assert.equal(canvaChoice.personalTarget.ownerUserId, alice.userId);
    assert.equal(canvaChoice.personalTarget.personalBinding.connectedAccountId, 'account-b');
    assert.deepEqual(canvaChoice.standaloneSelection, personalCanva.selection);
    assert(!row.preferences_json.includes(receipt) && !row.preferences_json.includes('accountSelectionRef'));
    const fresh = await workflow.readManagedAgentWorkflow(alice, agent.agentId);
    assert.equal(fresh.choices[canvaKey].personalTarget?.kind, 'personal');
    const cleared = await service.setManagedAgentStandaloneChoice({ ...base, expectedPreferenceRevision: 4, choiceId: null });
    assert.equal(cleared.preferenceRevision, 5);
    assert.equal(JSON.parse((await prefs())!.preferences_json).workflowChoices[mcpKey], undefined);
    assert(JSON.parse((await prefs())!.preferences_json).workflowChoices[canvaKey]);
    const afterChoices = (await prefs())!;
    fixture.setBeforeRead(async query => {
      if (query.startsWith('SELECT agent_id FROM agents') && query.endsWith('FOR SHARE')) {
        await fixture.sql.run("UPDATE agent_grants SET can_use=0 WHERE agent_id=$1 AND target_type='user' AND target_id=$2", [agent.agentId, alice.userId]);
      }
    });
    try {
      await expectCode(() => service.setManagedAgentStandaloneChoice({ ...base, expectedPreferenceRevision: 5,
        choiceId: 'b' }), 'AGENT_ACCESS_DENIED');
    } finally {
      fixture.setBeforeRead(undefined);
      await fixture.sql.run("UPDATE agent_grants SET can_use=1 WHERE agent_id=$1 AND target_type='user' AND target_id=$2", [agent.agentId, alice.userId]);
    }
    assert.deepEqual(await prefs(), afterChoices, 'Revocation after preflight does not save or fallback.');
    const mcpConfiguration = configurations.find(value => value.configurationId === 'choose-approved-mcp')!;
    assert(mcpConfiguration.mode === 'selectable');
    const fixedConfiguration = { version: 1, kind: 'standalone', mode: 'fixed', configurationId: mcpConfiguration.configurationId,
      entry: { ...mcpConfiguration.allowedChoices[0], requirement: mcpConfiguration.requirement } };
    const { choiceId: _fixedChoiceId, ...fixedEntry } = fixedConfiguration.entry;
    await fixture.sql.run('UPDATE agent_capability_bindings SET configuration_json=$1 WHERE agent_id=$2 AND resource_id=$3',
      [JSON.stringify({ ...fixedConfiguration, entry: fixedEntry }), agent.agentId, mcpKey]);
    try {
      await expectCode(() => service.setManagedAgentStandaloneChoice({ ...base, expectedPreferenceRevision: 5,
        choiceId: 'b' }), 'AGENT_WORKFLOW_CHOICE_DENIED');
    } finally {
      await fixture.sql.run('UPDATE agent_capability_bindings SET configuration_json=$1 WHERE agent_id=$2 AND resource_id=$3',
        [JSON.stringify(mcpConfiguration), agent.agentId, mcpKey]);
    }
    const creatorMcp = await connect(definitionId, 'Creator private MCP', owner.userId);
    const ownPreparation = await import('../app/lib/capabilities/extensions/standalone-preparation');
    const creatorProof = await ownPreparation.prepareStandaloneExtensionSelection(owner, { selection: { kind: 'mcp', source: 'mcp',
      target: { kind: 'personal', connectionRef: `mcp-personal:${creatorMcp.connectionId}` } }, requirement: 'required', toolCap: ['READ'] });
    const creatorBound = ownPreparation.getPreparedStandaloneExtensionBinding(creatorProof, owner);
    assert(creatorBound.mode === 'fixed');
    const creatorConfiguration = { ...mcpConfiguration, defaultChoiceId: 'creator',
      allowedChoices: [{ choiceId: 'creator', selection: creatorBound.entry.selection, target: creatorBound.entry.target, toolCap: ['READ'] }] };
    // A structurally valid corrupted/legacy org row cannot make its creator's personal account usable by Alice.
    await fixture.sql.run('UPDATE agent_capability_bindings SET configuration_json=$1 WHERE agent_id=$2 AND resource_id=$3',
      [JSON.stringify(creatorConfiguration), agent.agentId, mcpKey]);
    try {
      await expectCode(() => service.setManagedAgentStandaloneChoice({ ...base, expectedPreferenceRevision: 5,
        choiceId: 'creator' }), 'AGENT_WORKFLOW_CHOICE_DENIED');
    } finally {
      await fixture.sql.run('UPDATE agent_capability_bindings SET configuration_json=$1 WHERE agent_id=$2 AND resource_id=$3',
        [JSON.stringify(mcpConfiguration), agent.agentId, mcpKey]);
    }
    assert.deepEqual(await prefs(), afterChoices);
    assert.deepEqual(await fixture.sql.get('SELECT * FROM agents WHERE agent_id=$1', [agent.agentId]), unchangedAgent);
    assert.deepEqual(await fixture.sql.all('SELECT * FROM agent_capability_bindings WHERE agent_id=$1 ORDER BY id', [agent.agentId]), unchangedBindings);
    assert.equal(await fixture.sql.get('SELECT preferences_json FROM agent_user_preferences WHERE agent_id=$1 AND user_id=$2',
      [agent.agentId, owner.userId]), undefined);
    assert.equal(fixture.providerRequests(), 0); assert.equal(blockedRequests, 0);
    assert.equal(blockedSdkVersionChecks, 1, 'The real SDK version check is blocked separately; no request reaches NPM.');
    assert(provider.calls.every(call => ['/api/v3.1/toolkits', '/api/v3.1/connected_accounts'].includes(call.path)));
    console.log('PASS standalone user choice: real SQL/API/ACL; target-agent-only shared allowlist, exact revisions/CAS/rollback and late Use revocation, fixed/creator-account denial, permitted own approved MCP, exact second Composio account receipt, receipt-free preferences, unrelated settings and central configuration preserved; provider business calls 0, blocked SDK version lookup 1, allowed external requests 0.');
  } finally {
    globalThis.fetch = fixtureFetch;
    await provider.close();
    await fixture.close();
    if (oldBase === undefined) delete process.env.COMPOSIO_BASE_URL; else process.env.COMPOSIO_BASE_URL = oldBase;
    if (oldLogging === undefined) delete process.env.COMPOSIO_LOGGING_LEVEL; else process.env.COMPOSIO_LOGGING_LEVEL = oldLogging;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
