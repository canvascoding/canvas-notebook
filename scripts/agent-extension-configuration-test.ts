import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';
import type { AgentManagementActor, CreateManagedAgentInput } from '../app/lib/agents/management-actions';
import type { AgentExtensionConfigurationInput } from '../app/lib/capabilities/extensions/contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';

// Actual Store ZIP, published versions, SQL actor/target-agent/source ACLs and
// public writers. The fixture supplies its own signed license and real seats;
// only model catalogue and SDK update-check metadata are controlled. Composio SDK metadata uses one
// owned loopback HTTP server; external network and provider business calls fail.
async function main() {
  const maintenanceUrl = process.env.DATABASE_URL;
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  const databaseName = fixture.native ? (await fixture.sql.get('SELECT current_database() AS name') as { name: string }).name : '';
  const provider = await createComposioProviderFixture();
  const savedFetch = globalThis.fetch;
  const providerFetch = globalThis.fetch;
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const previousLoad = loader._load;
  const env = { COMPOSIO_BASE_URL: provider.baseUrl, COMPOSIO_API_KEY: '', COMPOSIO_LOGGING_LEVEL: 'silent' };
  const previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const originalFetch = (await import('undici')).fetch;
  let blockedNetwork = 0, sdkUpdateChecks = 0, stage = 'load services';
  const blockedRequests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.origin === fixture.registry.baseUrl) return providerFetch(input, init);
    if (url.href === 'https://registry.npmjs.org/@composio/core/latest' && method === 'GET') {
      sdkUpdateChecks++; return Response.json({ version: '0.0.0' });
    }
    if (url.origin !== provider.baseUrl || method !== 'GET' || !/^\/api\/v3\.1\/(toolkits|connected_accounts)(?:\/[a-z0-9_-]+)?$/u.test(url.pathname)) {
      blockedNetwork++; blockedRequests.push(`${method} ${url.origin}${url.pathname}`);
      throw new Error('Only owned registry and Composio metadata GETs are permitted.');
    }
    return originalFetch(url.href, { ...init, redirect: 'error' } as Parameters<typeof originalFetch>[1]) as unknown as Promise<Response>;
  };
  loader._load = (name, parent, isMain) => name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat'
    ? { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => {}, isContextOverflow: () => false }
    : previousLoad(name, parent, isMain);
  try {
    const { owner, alice, organizationId, sql } = fixture;
    const ownerActor: AgentManagementActor = { ...owner, source: 'api' };
    const aliceActor: AgentManagementActor = { ...alice, source: 'api' };
    const management = await import('../app/lib/agents/management-actions');
    const workflows = await import('../app/lib/agents/workflow-configuration');
    const registry = await import('../app/lib/agents/registry');
    const pluginRegistry = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const sources = await import('../app/lib/integration-tools/connections/store');
    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const sourceActor = { ...owner, organizationId };
    const createSource = (displayName: string, targetId = alice.userId) => createSharedMcpConnection(sourceActor, {
      ownership: { type: 'organization', organizationId }, displayName, accessMode: 'restricted',
      allowedToolNames: ['read_fixture', 'extra_fixture'], grants: [...new Set([owner.userId, targetId])].map(targetId => ({
        targetType: 'user' as const, targetId, canUse: true, canManage: false, allowedToolNames: ['read_fixture', 'extra_fixture'] })),
      config: { url: 'https://fixture.invalid/mcp', transport: 'http', auth: 'none', enabled: true },
    });
    const packageSource = await createSource('Package mapping');
    const standaloneSource = await createSource('Standalone Use only');
    const selectableSource = await createSource('Selectable shared exact choice');
    const sharedEntry = (source: typeof packageSource) => ({ selection: { kind: 'mcp' as const, source: 'mcp' as const,
      target: { kind: 'shared' as const, connectionRef: source.resource.connectionRef, bindingRevision: source.resource.bindingRevision } },
      requirement: 'optional' as const, toolCap: ['read_fixture'] });
    const empty: AgentExtensionConfigurationInput = { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [] };
    const prefix = `extension-write-${randomUUID().slice(0, 8)}`;
    const absentAgent = async (id: string) => {
      assert.equal(await registry.getAgentProfile(id), null);
      assert.deepEqual(await sql.all('SELECT id FROM agent_capability_bindings WHERE agent_id=$1', [id]), []);
      assert.deepEqual(await sql.all('SELECT id FROM agent_grants WHERE agent_id=$1', [id]), []);
      assert.deepEqual(await sql.all('SELECT user_id FROM agent_members WHERE agent_id=$1', [id]), []);
    };

    stage = 'real Store installation and published package';
    const files = { '.canvas-plugin/plugin.json': JSON.stringify({ name: prefix, version: '1.0.0', description: 'Writer source fixture', skills: './skills',
      connectors: { mcp: [{ name: 'writer-source', required: false, configPath: 'mcp.json' }] }, workflow: { version: 1,
        integrationCapabilities: [{ id: 'reader', application: 'reader', required: true,
          alternatives: [{ source: 'mcp', connector: 'writer-source', requiredTools: ['read_fixture'] }] }] } }),
      'mcp.json': JSON.stringify({ url: 'https://fixture.invalid/mcp', transport: 'http', auth: 'none' }),
      'skills/writer-brief/SKILL.md': '---\nname: writer-brief\ndescription: Prepare a precise design brief\n---\n\nPinned brief instructions.\n',
      'skills/writer-extra/SKILL.md': '---\nname: writer-extra\ndescription: Optional additional work\n---\n\nOptional work.\n' };
    const archive = await fixture.registry.addPackage('application', 'plugin', prefix, '1.0.0', files, pluginRegistry.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: prefix, version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' },
      grants: [owner, alice].map(actor => ({ targetType: 'user' as const, targetId: actor.userId, canUse: true, canEdit: false, canManage: false })) });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const completeWorkflow = { version: 1 as const, packages: [{ ...pin, skillSelection: { kind: 'plugin' as const }, declarations: [{
      declarationPath: '.canvas-plugin/plugin.json', capabilities: [{ capabilityId: 'reader', selection: { mode: 'fixed' as const,
        alternativeKey: 'mcp:writer-source', target: { kind: 'shared' as const, source: 'mcp' as const,
          connectionRef: packageSource.resource.connectionRef, bindingRevision: packageSource.resource.bindingRevision,
          mcpMapping: { kind: 'manager_confirmation' as const } }, toolCap: ['read_fixture', 'extra_fixture'] } }] }] }] };

    stage = 'real personal Composio account B receipt';
    await (await import('../app/lib/integrations/env-config')).replaceScopedEnvEntries('integrations',
      [{ key: 'COMPOSIO_API_KEY', value: 'fixture-only-owner-key' }], { secretScope: 'user', userId: owner.userId });
    const composio = await (await import('../app/lib/composio/composio-context')).resolveComposioContext({ userId: owner.userId, workspaceId: owner.workspaceId });
    provider.accounts.set(composio.composioUserId, [{ id: 'account-a', toolkit: 'canva', status: 'ACTIVE' }, { id: 'account-b', toolkit: 'canva', status: 'ACTIVE' }]);
    const providerRef = (await import('../app/lib/integration-tools/references')).createIntegrationProviderRef({ source: 'composio', profileId: composio.profileId,
      toolkit: 'canva', scope: { type: 'user', ownerUserId: owner.userId, resourceId: `profile:${composio.profileId}:canva` } });
    const choices = await (await import('../app/lib/integration-tools/workflow-personal-bindings')).listPersonalWorkflowProviderAccountChoices({
      actor: ownerActor, providerRef, exactToolkit: { profileId: composio.profileId, toolkit: 'canva' } });
    const readReceipt = (await import('../app/lib/composio/composio-shared-account-reference')).readPersonalComposioAccountReference;
    const accountChoice = (id: string) => { const choice = choices.accounts.find(value => readReceipt(value.accountSelectionRef).accountId === id); assert(choice); return choice.accountSelectionRef; };
    const personalSlot = { mode: 'fixed' as const, entry: { selection: { kind: 'composio' as const, source: 'composio' as const, toolkit: 'canva',
      target: { kind: 'personal' as const, profileId: composio.profileId, accountBinding: 'account' as const, accountId: 'account-b',
        connectionRef: `composio-personal:${composio.profileId}:account-b` } }, requirement: 'optional' as const, toolCap: ['DESIGN_CREATE'],
      accountSelectionRef: accountChoice('account-b') } };
    const configuration: AgentExtensionConfigurationInput = { ...empty, mode: 'fixed', selections: [
      { selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'subset', relativeRoots: [] } }, requirement: 'optional', toolCap: ['read_fixture'] },
      { selection: { kind: 'skill', package: pin, origin: 'plugin_child', relativeRoot: 'skills/writer-brief' }, requirement: 'optional', toolCap: ['read_fixture'] },
    ], workflow: completeWorkflow, standalone: [{ mode: 'fixed', entry: sharedEntry(standaloneSource) }, personalSlot,
      { mode: 'selectable', configurationId: 'shared-reader-choice', source: 'mcp', requirement: 'optional',
        allowedChoices: [{ choiceId: 'exact-shared', selection: sharedEntry(selectableSource).selection, toolCap: ['read_fixture'] }],
        defaultChoiceId: 'exact-shared' }] };

    stage = 'atomic complete four-type create and omitted-org inspect/save';
    const created = await management.createManagedAgent(ownerActor, { agentId: `${prefix}-all`, name: 'All four exact types',
      enabledTools: ['read', 'mcp', 'composio_execute'], extensions: configuration, files: { 'AGENTS.md': 'Exact configured agent.' } });
    assert.equal(created.agent.workflowVersion, 2); assert.equal(created.agent.workflowRevision, 1);
    const snapshot = await workflows.readManagedAgentWorkflow(ownerActor, created.agent.agentId);
    assert.equal(snapshot.bindings.filter(binding => binding.configuration).length, 1);
    assert.equal(snapshot.bindings.filter(binding => binding.standaloneConfiguration).length, 3);
    const selectable = snapshot.bindings.find(binding => binding.standaloneConfiguration?.mode === 'selectable')!.standaloneConfiguration!;
    assert(selectable.mode === 'selectable'); assert.equal(selectable.defaultChoiceId, 'exact-shared');
    const selectableTarget = selectable.allowedChoices[0].selection.target;
    assert.equal(selectableTarget.kind, 'shared'); assert(selectableTarget.kind === 'shared');
    assert.equal(selectableTarget.connectionRef, selectableSource.resource.connectionRef);
    const selectedB = snapshot.bindings.find(binding => binding.standaloneConfiguration?.mode === 'fixed'
      && binding.standaloneConfiguration.entry.selection.kind === 'composio')!.standaloneConfiguration!;
    assert(selectedB.mode === 'fixed' && selectedB.entry.target.kind === 'personal' && selectedB.entry.target.personalBinding.source === 'composio');
    assert.equal(selectedB.entry.target.personalBinding.connectedAccountId, 'account-b');
    assert.doesNotMatch(JSON.stringify(snapshot.bindings), /accountSelectionRef|cmp_personal_account_|fixture-only-owner-key/u);
    const inspected = await management.inspectManagedAgent(ownerActor, created.agent.agentId);
    assert.equal(inspected.extensions.configurationState, 'available'); assert(inspected.extensions.configuration);
    const editable = inspected.extensions.configuration;
    assert.doesNotMatch(JSON.stringify(editable), /connectedAccountId|personalBinding|bindingFingerprint|boundProviderRef|accountSelectionRef/u);
    assert.match(JSON.stringify(editable), /agent-extension-retain:v1:/u);
    const saved = await workflows.updateManagedAgentConfiguration({ actor: ownerActor, agentId: created.agent.agentId,
      expectedRevision: created.agent.revision, expectedWorkflowRevision: 1, extensions: editable });
    assert.equal(saved.agent.workflowVersion, 2);
    const savedSnapshot = await workflows.readManagedAgentWorkflow(ownerActor, created.agent.agentId);
    const savedB = savedSnapshot.bindings.find(binding => binding.standaloneConfiguration?.mode === 'fixed'
      && binding.standaloneConfiguration.entry.selection.kind === 'composio')!.standaloneConfiguration!;
    assert(savedB.mode === 'fixed'); assert.deepEqual(savedB.entry.target, selectedB.entry.target,
      'Saving an unchanged exact B slot must retain the durable private target and binding fingerprint.');
    const beforeCas = await sql.get('SELECT * FROM agents WHERE agent_id=$1', [created.agent.agentId]);
    await assert.rejects(workflows.updateManagedAgentConfiguration({ actor: ownerActor, agentId: created.agent.agentId,
      expectedRevision: created.agent.revision, expectedWorkflowRevision: 1, extensions: editable }));
    assert.deepEqual(await sql.get('SELECT * FROM agents WHERE agent_id=$1', [created.agent.agentId]), beforeCas);
    await assert.rejects(management.createManagedAgent(ownerActor, { name: 'Mismatched account', agentId: `${prefix}-wrong-account`, extensions: {
      ...empty, mode: 'fixed', standalone: [{ ...personalSlot, entry: { ...personalSlot.entry, accountSelectionRef: accountChoice('account-a') } }] } }));
    await absentAgent(`${prefix}-wrong-account`);

    stage = 'shared standalone Use without Manage and target-agent-only grant';
    const access = await sources.authorizeIntegrationConnection(alice, standaloneSource.resource.connectionRef, 'use');
    assert.equal(access.access.canUse, true); assert.equal(access.access.canManage, false);
    const aliceCreated = await management.createManagedAgent(aliceActor, { agentId: `${prefix}-use`, name: 'Use without Manage',
      extensions: { ...empty, mode: 'fixed', standalone: [{ mode: 'fixed', entry: sharedEntry(standaloneSource) }] } });
    assert.equal(aliceCreated.agent.workflowVersion, 2);
    await assert.rejects(management.createManagedAgent(aliceActor, { agentId: `${prefix}-mapping-denied`, name: 'Package mapping needs Manage',
      extensions: { ...configuration, mode: 'fixed', standalone: [] } }), (error: unknown) =>
      typeof error === 'object' && error !== null && Reflect.get(error, 'status') === 403);
    await absentAgent(`${prefix}-mapping-denied`);
    const targetAgent = await management.createManagedAgent(ownerActor, { agentId: `${prefix}-target`, name: 'Target specific grant',
      scopeType: 'organization', extensions: empty, grants: [{ targetType: 'user', targetId: alice.userId, canUse: true, canEdit: true, canManage: false }] });
    const agentOnly = await createSharedMcpConnection(sourceActor, { ownership: { type: 'organization', organizationId },
      displayName: 'Target agent only', accessMode: 'restricted', allowedToolNames: ['read_fixture'],
      grants: [{ targetType: 'agent', targetId: targetAgent.agent.agentId, canUse: true, canManage: false, allowedToolNames: ['read_fixture'] }],
      config: { url: 'https://fixture.invalid/mcp', transport: 'http', auth: 'none', enabled: true } });
    await workflows.updateManagedAgentConfiguration({ actor: aliceActor, agentId: targetAgent.agent.agentId,
      expectedRevision: targetAgent.agent.revision, expectedWorkflowRevision: targetAgent.agent.workflowRevision ?? 0,
      extensions: { ...empty, mode: 'fixed', standalone: [{ mode: 'fixed', entry: sharedEntry(agentOnly) }] } });

    stage = 'actual Edit-only configure GET and successful PATCH without Use';
    const editableOnly = await management.createManagedAgent(ownerActor, { agentId: `${prefix}-edit`, name: 'Edit-only API',
      scopeType: 'organization', extensions: empty, grants: [{ targetType: 'user', targetId: alice.userId,
        canUse: true, canEdit: true, canManage: false }] });
    // Existing persisted grants can hold independent permission bits. This is a
    // real SQL authorization fixture, not a mocked access result.
    await sql.run('UPDATE agent_grants SET can_use=0 WHERE agent_id=$1 AND target_type=$2 AND target_id=$3',
      [editableOnly.agent.agentId, 'user', alice.userId]);
    const route = await import('../app/api/agents/route');
    const apiUrl = `http://localhost:3001/api/agents?workspaceId=${alice.workspaceId}&agentId=${editableOnly.agent.agentId}`;
    assert.equal((await route.GET(new NextRequest(apiUrl, { headers: fixture.headers(alice.userId) }))).status, 403);
    const configureRead = await route.GET(new NextRequest(`${apiUrl}&purpose=configure`, { headers: fixture.headers(alice.userId) }));
    assert.equal(configureRead.status, 200, JSON.stringify(await configureRead.clone().json()));
    assert.equal((await configureRead.json()).data.access.canUse, false);
    const patched = await route.PATCH(new NextRequest(apiUrl, { method: 'PATCH', headers: fixture.headers(alice.userId),
      body: JSON.stringify({ agentId: editableOnly.agent.agentId, expectedRevision: editableOnly.agent.revision,
        expectedWorkflowRevision: editableOnly.agent.workflowRevision, name: 'Edited without Use', extensions: empty }) }));
    assert.equal(patched.status, 200, JSON.stringify(await patched.clone().json()));
    const patchBody = await patched.json();
    assert.equal(patchBody.data.agent.name, 'Edited without Use'); assert.equal(patchBody.data.agent.access.canUse, false);
    assert.equal(patchBody.data.agent.access.canEdit, true); assert.equal(patchBody.data.agent.access.canManage, false);
    assert(patchBody.data.extensions); assert.equal((await registry.getAgentProfile(editableOnly.agent.agentId))?.name, 'Edited without Use');
    assert.equal((await route.GET(new NextRequest(apiUrl, { headers: fixture.headers(alice.userId) }))).status, 403);

    stage = 'V1 pin retained after published head changes';
    const legacy = await management.createManagedAgent(ownerActor, { agentId: `${prefix}-v1`, name: 'V1 held pin',
      extensions: { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' } });
    const v1 = await workflows.updateManagedAgentConfiguration({ actor: ownerActor, agentId: legacy.agent.agentId,
      expectedRevision: legacy.agent.revision, expectedWorkflowRevision: 0, workflow: completeWorkflow });
    const currentPackage = await packages.inspectCapabilityPackage(owner, pin.resourceRef);
    const draft = await packages.createCapabilityPackageDraftAction(owner, { operation: 'edit', resourceRef: pin.resourceRef,
      expectedMetadataRevision: currentPackage.resource.metadataRevision, expectedGrantsRevision: currentPackage.resource.grantsRevision,
      expectedPackageRevision: currentPackage.state!.packageRevision, expectedPublishedRevisionRef: pin.publishedRevisionRef });
    const fileEdit = await packages.writeCapabilityPackageDraftFileAction(owner, draft.draftRef, { expectedDraftRevision: draft.draftRevision,
      path: 'skills/writer-brief/SKILL.md', encoding: 'base64', content: Buffer.from(`${files['skills/writer-brief/SKILL.md']}New head content.\n`).toString('base64') });
    const nextHead = await packages.publishCapabilityPackageDraftAction(owner, { draftRef: draft.draftRef, expectedDraftRevision: fileEdit.draft.draftRevision,
      expectedMetadataRevision: currentPackage.resource.metadataRevision, expectedGrantsRevision: currentPackage.resource.grantsRevision,
      expectedPackageRevision: currentPackage.state!.packageRevision, expectedPublishedRevisionRef: pin.publishedRevisionRef });
    assert.notEqual(nextHead.published.revisionRef, pin.publishedRevisionRef);
    const migrated = await workflows.updateManagedAgentConfiguration({ actor: ownerActor, agentId: legacy.agent.agentId,
      expectedRevision: v1.agent.revision, expectedWorkflowRevision: v1.agent.workflowRevision ?? 1,
      extensions: { ...configuration, mode: 'fixed', standalone: [] } });
    const held = await workflows.readManagedAgentWorkflow(ownerActor, migrated.agent.agentId);
    assert.equal(held.bindings[0].configuration?.publishedRevisionRef, pin.publishedRevisionRef);
    assert.equal(held.bindings[0].configuration?.declarations[0].capabilities[0].required, true);
    assert.deepEqual(held.bindings[0].extensionSelections?.map(entry => entry.selection.kind), ['plugin', 'skill']);

    stage = 'actual late grant revocation before source lock';
    let revoked = false;
    fixture.setBeforeRead(async query => {
      if (!revoked && /integration_connection_resources/u.test(query) && /FOR UPDATE/u.test(query)) {
        revoked = true; fixture.setBeforeRead(undefined);
        // Native PostgreSQL uses the fixture's independent SQL connection;
        // PGlite exposes the same real transaction. Do not nest an application
        // BEGIN/COMMIT in PGlite merely to stage the grant-loss boundary.
        await sql.run('DELETE FROM integration_connection_grants WHERE connection_ref=$1 AND target_type=$2 AND target_id=$3',
          [standaloneSource.resource.connectionRef, 'user', alice.userId]);
      }
    });
    await assert.rejects(management.createManagedAgent(aliceActor, { agentId: `${prefix}-late`, name: 'Must roll back on grant loss',
      extensions: { ...empty, mode: 'fixed', standalone: [{ mode: 'fixed', entry: sharedEntry(standaloneSource) }] } }),
    { code: 'CONNECTION_ACCESS_DENIED', status: 403 });
    fixture.setBeforeRead(undefined); assert.equal(revoked, true); await absentAgent(`${prefix}-late`);
    const remainingGrant = await sql.all('SELECT id FROM integration_connection_grants WHERE connection_ref=$1 AND target_type=$2 AND target_id=$3',
      [standaloneSource.resource.connectionRef, 'user', alice.userId]);
    assert.equal(remainingGrant.length, fixture.native ? 0 : 1,
      'Native revocation commits independently; PGlite tests the same-transaction fresh check and rolls the fixture change back.');

    stage = 'real file initialization failure rolls back SQL and partial files';
    const failedId = `${prefix}-files`;
    const successfulWrites = new Set<string>();
    fixture.setAfterQuery(async (query, parameters) => {
      const table = /INSERT INTO\s+(agent_members|agent_capability_bindings)\s*\(/u.exec(query)?.[1];
      if (table && parameters.includes(failedId)) successfulWrites.add(table);
    });
    await assert.rejects(management.createManagedAgent(ownerActor, { agentId: failedId, name: 'Must roll back files', scopeType: 'organization',
      extensions: { ...empty, mode: 'fixed', standalone: [{ mode: 'fixed', entry: sharedEntry(selectableSource) }] },
      grants: [{ targetType: 'user', targetId: alice.userId, canUse: true, canEdit: false, canManage: false }],
      files: { 'AGENTS.md': 'First file really writes.', 'MEMORY.md': 'x'.repeat(6_145) } }), /MEMORY\.md is too large/u);
    fixture.setAfterQuery(undefined);
    assert.deepEqual([...successfulWrites].sort(), ['agent_capability_bindings', 'agent_members'],
      'Real SQL membership and binding inserts completed before the actual file write failed.');
    await absentAgent(failedId);
    const dataPaths = await import('../app/lib/runtime-data-paths');
    await assert.rejects(fs.access(path.join(dataPaths.resolveOrganizationAgentsDir(organizationId), failedId)), { code: 'ENOENT' });
    const agentDirectory = path.join(dataPaths.resolveUserAgentsDir(owner.userId), failedId);
    await assert.rejects(fs.access(agentDirectory), { code: 'ENOENT' });
    const deniedVariants: Array<[string, AgentManagementActor, Pick<CreateManagedAgentInput, 'scopeType' | 'extensions' | 'relevantConnections'>]> = [
      [`${prefix}-scope`, aliceActor, { scopeType: 'organization', extensions: empty }],
      [`${prefix}-mixed`, ownerActor, { extensions: empty, relevantConnections: [] }],
      [`${prefix}-foreign`, { ...ownerActor, workspaceId: alice.workspaceId }, { extensions: empty }],
    ];
    for (const [id, actor, input] of deniedVariants) {
      await assert.rejects(management.createManagedAgent(actor, { agentId: id, name: 'Denied', ...input })); await absentAgent(id);
    }
    assert.equal(provider.calls.filter(call => call.path.includes('/tools/execute/')).length, 0);
    assert.equal(blockedNetwork, 0, JSON.stringify(blockedRequests));
    assert(sdkUpdateChecks <= 1, 'Only the SDK best-effort version metadata check is controlled.');
    console.log(`PASS ${fixture.native ? 'native PostgreSQL' : 'PGlite'} complete agent extension writer: actual Store/ACL/SQL, all four types, exact B receipt/retention, no Manage standalone, target-agent grant, V1 held pin/parent requirements, stale CAS, late grants and file rollback; provider business IO zero.`);
  } catch (error) { console.error(`Agent extension writer fixture stage: ${stage}`); throw error; }
  finally {
    fixture.setBeforeRead(undefined); fixture.setAfterQuery(undefined); globalThis.fetch = savedFetch; loader._load = previousLoad;
    await provider.close(); await fixture.close();
    for (const [key, value] of Object.entries(previousEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await assert.rejects(fs.access(fixture.root), { code: 'ENOENT' });
    if (fixture.native) {
      const observer = new Pool({ connectionString: maintenanceUrl, max: 1 });
      try { assert.equal((await observer.query('SELECT COUNT(*)::integer AS count FROM pg_database WHERE datname=$1', [databaseName])).rows[0].count, 0); }
      finally { await observer.end(); }
    }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
