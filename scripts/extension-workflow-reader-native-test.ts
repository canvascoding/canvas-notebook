import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { Pool } from 'pg';

import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { AgentProfile } from '../app/lib/agents/registry';
import type { StoredAgentWorkflowPackage } from '../app/lib/agents/workflow-contracts';
import type { IntegrationExecutionContext } from '../app/lib/integration-tools/contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import { BROWSER_MCP_TOOL, startIntegrationToolBrowserProvider } from './fixtures/integration-tool-browser-provider';

async function expectWorkflowReaderCode(operation: () => unknown | Promise<unknown>, expected: string) {
  try { await operation(); }
  catch (error) {
    assert.equal(error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined, expected);
    return;
  }
  assert.fail(`Expected ${expected}.`);
}

async function assertWorkflowReaderCleanup(maintenanceUrl: string, databaseName: string, dataRoot: string) {
  assert.match(databaseName, /^canvas_connection_test_[a-f0-9]{32}$/u);
  assert(path.basename(dataRoot).startsWith('canvas-store-application-'));
  const observer = new Pool({connectionString: maintenanceUrl, max: 1});
  try {
    assert.equal((await observer.query('SELECT COUNT(*)::integer AS count FROM pg_database WHERE datname=$1', [databaseName])).rows[0].count, 0);
    await assert.rejects(fs.stat(dataRoot), {code: 'ENOENT'});
  } finally { await observer.end(); }
  console.log('CLEANUP extension workflow reader: exact own database absent; exact own DATA absent.');
}

async function runExtensionWorkflowReaderNativeProof() {
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST, '1');
  const maintenance = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(maintenance.hostname, '127.0.0.1'); assert.equal(maintenance.port, '55433'); assert.equal(maintenance.search, '');
  const originalFetch = globalThis.fetch;
  const environment = {COMPOSIO_API_KEY: '', COMPOSIO_BASE_URL: '', MCP_ALLOW_PRIVATE_NETWORK: 'true', MCP_ALLOW_INSECURE_HTTP: 'true'};
  const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  let fixture: Awaited<ReturnType<typeof createCapabilityPackageStoreApplicationFixture>> | undefined;
  let mcp: Awaited<ReturnType<typeof startIntegrationToolBrowserProvider>> | undefined;
  let dataRoot = '', databaseName = '', stage = 'fixture creation', blockedNetworkAttempts = 0;
  try {
    fixture = await createCapabilityPackageStoreApplicationFixture({native: true}); assert.equal(fixture.native, true);
    dataRoot = fixture.root; await fs.chmod(dataRoot, 0o700);
    const databaseIdentity = await fixture.sql.get('SELECT current_database() AS name') as {name: string} | undefined;
    assert(databaseIdentity && typeof databaseIdentity.name === 'string'); databaseName = databaseIdentity.name;
    assert.match(databaseName, /^canvas_connection_test_[a-f0-9]{32}$/u);
    console.log('START extension workflow reader: own native PostgreSQL/DATA; actual legacy API/services; V2 SQL rows are protocol fixtures only.');
    mcp = await startIntegrationToolBrowserProvider();
    const {sql, owner, alice, organizationId} = fixture, bob = fixture.actor('bob');
    const guardedFixtureFetch = globalThis.fetch, registryOrigin = fixture.registry.baseUrl;
    const ownRegistryConfiguration = fixture.registry.registryUrl('application');
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.origin !== registryOrigin || url.username || url.password || url.hash && url.href !== ownRegistryConfiguration || method !== 'GET'
        || !(url.pathname === '/registry/application' || /^\/archives\/application\/plugin\/[a-z0-9-]+\/1\.0\.0\.zip$/u.test(url.pathname))) {
        blockedNetworkAttempts += 1; throw new Error('Only exact owned package registry reads are allowed.');
      }
      return guardedFixtureFetch(input, {...init, redirect: 'error'});
    };
    const route = await import('../app/api/agents/route');
    const workflow = await import('../app/lib/agents/workflow-configuration');
    const mode = await import('../app/lib/agents/workflow-runtime-mode');
    const runtime = await import('../app/lib/capabilities/packages/runtime-bindings');
    const projection = await import('../app/lib/agents/workflow-runtime');
    const {agentWorkflowCapabilityKey} = await import('../app/lib/agents/workflow-contracts');
    const {projectWorkflowProviderAssociations} = await import('../app/lib/integration-tools/workflow-provider-associations');
    const {resolveIntegrationRuntimePolicy} = await import('../app/lib/integration-tools/runtime-policy');
    const {createIntegrationPolicyFromLegacyTools, isIntegrationProviderReferenceAllowed} = await import('../app/lib/integration-tools/policy');
    const {createSharedIntegrationProviderRef} = await import('../app/lib/integration-tools/connections/provider-authorization');
    const agents = await import('../app/lib/agents/registry');
    const slots = await import('../app/lib/capabilities/extensions/standalone-reference');
    const standalone = await import('../app/lib/capabilities/extensions/standalone-preparation');
    const {parseStoredPackageExtensionBinding} = await import('../app/lib/capabilities/extensions/stored-package-contracts');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const activation = await import('../app/lib/capabilities/packages/activation');
    const {setPersonalCapabilityActivation} = await import('../app/lib/capabilities/activation-actions');
    const connections = await import('../app/lib/integration-tools/connections/store');
    const {createSharedMcpConnection} = await import('../app/lib/mcp/shared-connections');
    const {resolveAgentExecutionContextForStoredSession} = await import('../app/lib/pi/session-workspace-context');
    const {piSessions} = await import('../app/lib/db/schema');
    const nonce = randomUUID().replace(/-/gu, '').slice(0, 10), pluginName = `reader-plugin-${nonce}`;
    const briefName = `reader-brief-${nonce}`, assetsName = `reader-assets-${nonce}`;
    const briefRoot = `skills/${briefName}`, assetsRoot = `skills/${assetsName}`;
    const actor = {...owner, organizationId, source: 'api' as const};

    stage = 'actual Store install and current shared MCP';
    const mcpGrants = [{targetType: 'user' as const, targetId: owner.userId, canUse: true, canManage: false, allowedToolNames: null},
      {targetType: 'user' as const, targetId: alice.userId, canUse: true, canManage: false, allowedToolNames: [BROWSER_MCP_TOOL, 'alice-only']}];
    const shared = await createSharedMcpConnection(actor, {ownership: {type: 'organization', organizationId}, displayName: 'Reader actual MCP',
      accessMode: 'restricted', allowedToolNames: [BROWSER_MCP_TOOL, 'package-extra', 'child-extra', 'standalone-extra', 'alice-only'], grants: mcpGrants,
      config: {url: mcp.mcpUrl, transport: 'http', auth: 'none', enabled: true}});
    const files = {'.canvas-plugin/plugin.json': JSON.stringify({name: pluginName, version: '1.0.0', description: 'Native reader source', skills: './skills',
      connectors: {mcp: [{name: 'reader-mcp', required: false}]}, workflow: {version: 1, integrationCapabilities: [{id: 'design', application: 'canva',
        required: false, skillRefs: [briefName], alternatives: [{source: 'mcp', connector: 'reader-mcp', requiredTools: [BROWSER_MCP_TOOL]}]}]}}),
    [`${briefRoot}/SKILL.md`]: `---\nname: ${briefName}\ndescription: Exact brief instructions\nmetadata:\n  version: "1.0.0"\n---\nNative immutable brief.\n`,
    [`${briefRoot}/agents/canvas.yaml`]: `workflow: ${JSON.stringify({version: 1, integrationCapabilities: [{id: 'child-design', application: 'canva',
      required: false, alternatives: [{source: 'mcp', connector: 'reader-mcp', requiredTools: [BROWSER_MCP_TOOL]}]}]})}\n`,
    [`${assetsRoot}/SKILL.md`]: `---\nname: ${assetsName}\ndescription: Exact asset instructions\nmetadata:\n  version: "1.0.0"\n---\nNative immutable assets.\n`};
    const archive = await fixture.registry.addPackage('application', 'plugin', pluginName, '1.0.0', files, plugins.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(owner, {source: {kind: 'plugin', registryId: 'store-application',
      entryKey: pluginName, version: '1.0.0', checksum: archive.checksum}, ownership: {type: 'organization'},
    grants: [owner, alice, bob].map(user => ({targetType: 'user', targetId: user.userId, canUse: true, canEdit: false, canManage: false}))});
    const descriptor = await packages.inspectCapabilityPackage(owner, installed.resource.resourceRef);
    await activation.setCapabilityPackageDefaultActivationAction(owner, installed.resource.resourceRef, {
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
      expectedPackageRevision: descriptor.state!.packageRevision, expectedPublishedRevisionRef: installed.published.revisionRef,
      expectedDefaultEnabled: false, enabled: true});
    await setPersonalCapabilityActivation({context: {userId: alice.userId, organizationId, workspaceId: alice.workspaceId, role: 'member'},
      actorUserId: alice.userId, resourceId: descriptor.sourceStamp.resourceId, enabled: true});
    const pin = {resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum};
    const baseUrl = 'http://localhost:3001/api/agents';
    const createAgent = async (label: string): Promise<AgentProfile> => {
      const response = await route.POST(new NextRequest(`${baseUrl}?workspaceId=${owner.workspaceId}`, {method: 'POST', headers: fixture!.headers('owner'),
        body: JSON.stringify({agentId: `reader-${label}-${nonce}`, name: `Native reader ${label}`, scopeType: 'organization', enabledTools: ['read', 'mcp'],
          grants: [alice, bob].map(user => ({targetType: 'user', targetId: user.userId, canUse: true, canEdit: false, canManage: false}))})}));
      assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.success, true); return body.data.agent as AgentProfile;
    };
    const createContext = async (profile: AgentProfile, userId: string): Promise<AgentExecutionContext> => {
      const sessionId = `reader-session-${profile.agentId}-${userId}`;
      await fixture!.database.db.insert(piSessions).values({sessionId, userId, agentId: profile.agentId, workspaceId: `personal-${userId}`,
        workspaceType: 'personal', organizationId, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date()});
      return resolveAgentExecutionContextForStoredSession({sessionId, userId, agentId: profile.agentId});
    };
    const integrationContext = (context: AgentExecutionContext): IntegrationExecutionContext => ({actorUserId: context.userId, organizationId: context.organizationId,
      workspaceId: context.workspaceId, agentId: context.agentId, sessionId: context.sessionId, policyRevision: 'native-reader-proof'});
    const mcpCeiling = createIntegrationPolicyFromLegacyTools({legacyToolNames: ['mcp']});
    const fixedShared = await standalone.prepareStandaloneExtensionSelection(alice, {selection: {kind: 'mcp', source: 'mcp', target: {
      kind: 'shared', connectionRef: shared.resource.connectionRef, bindingRevision: shared.resource.bindingRevision}}, requirement: 'required',
    toolCap: [BROWSER_MCP_TOOL, 'standalone-extra']});
    const standaloneBinding = standalone.getPreparedStandaloneExtensionBinding(fixedShared, alice);
    const slotRef = slots.createStandaloneExtensionSlotRef({configurationId: standaloneBinding.configurationId, source: 'mcp'});
    const insertStandaloneProtocolRow = async (agentId: string) => {
      await sql.run(`INSERT INTO agent_capability_bindings(id,agent_id,resource_type,scope_type,resource_id,name,version,requirement,revision,created_at,updated_at,configuration_json)
        VALUES($1,$2,'connection','organization',$3,'Exact reader MCP','v2','required',1,$4,$4,$5)`,
      [`reader-binding-${randomUUID()}`, agentId, slotRef, Date.now(), JSON.stringify(standaloneBinding)]);
    };
    const setV2ProtocolHeader = async (agentId: string) => {await sql.run('UPDATE agents SET workflow_version=2,workflow_revision=workflow_revision+1,revision=revision+1 WHERE agent_id=$1', [agentId]);};

    stage = 'actual legacy inheritance versus explicit empty V2';
    const legacyAgent = await createAgent('legacy'), emptyAgent = await createAgent('empty');
    const legacyContext = await createContext(legacyAgent, alice.userId);
    assert.equal(await mode.getRuntimeAgentWorkflowMode(legacyContext), null);
    const inheritedSkills = await runtime.loadCapabilityPackageRuntimeSkills(legacyContext);
    if (!inheritedSkills.some(skill => skill.name === briefName) || !inheritedSkills.some(skill => skill.name === assetsName)) {
      const {loadCapabilityCandidates} = await import('../app/lib/capabilities/catalog');
      const {resolveEffectiveCapabilities} = await import('../app/lib/capabilities/effective-resolver');
      const context = {userId: alice.userId, workspaceId: alice.workspaceId, organizationId};
      const candidates = await loadCapabilityCandidates(context, {resolveConnections: false});
      const snapshot = resolveEffectiveCapabilities({context, candidates: candidates.map(candidate => candidate.ref.resourceType === 'plugin'
        ? {...candidate, connectionRequirementCount: 0} : candidate), policies: []});
      console.error(`FAIL extension workflow reader diagnostic: ${JSON.stringify({inheritedCount: inheritedSkills.length, relevantSkillsNull: legacyAgent.relevantSkills === null,
        sources: [pluginName, briefName, assetsName].map(name => {const candidate = snapshot.capabilities.find(value => value.ref.name === name); return candidate
          ? {present: true, enabled: candidate.enabled, effectiveEnabled: candidate.effectiveEnabled, readiness: candidate.readiness,
            runtimePathPresent: Boolean(candidate.runtimePath), canRead: candidate.resourceAccess?.canRead, canUse: candidate.resourceAccess?.canUse}
          : {present: false};})})}`);
    }
    assert(inheritedSkills.some(skill => skill.name === briefName) && inheritedSkills.some(skill => skill.name === assetsName));
    await setV2ProtocolHeader(emptyAgent.agentId);
    const emptyContext = await createContext(emptyAgent, alice.userId);
    const emptySnapshot = await workflow.readManagedAgentWorkflow(alice, emptyAgent.agentId);
    assert.equal(emptySnapshot.workflowVersion, 2); assert.equal(emptySnapshot.bindings.length, 0);
    assert.equal(await mode.getRuntimeAgentWorkflowMode(emptyContext), 2);
    const emptyRuntimePolicy = await resolveIntegrationRuntimePolicy({executionContext: emptyContext, ceiling: mcpCeiling});
    assert.deepEqual(emptyRuntimePolicy.policy.providerToolRules, [], 'The actual policy consumer recognizes an empty V2 instead of permitting legacy unbound MCP discovery.');
    assert.equal(isIntegrationProviderReferenceAllowed(emptyRuntimePolicy.policy, 'mcp', createSharedIntegrationProviderRef(shared.resource)), false);
    const emptySkills = await runtime.loadCapabilityPackageRuntimeSkills(emptyContext);
    assert(!emptySkills.some(skill => skill.name === briefName || skill.name === assetsName), 'An explicit empty V2 must not inherit optional installed plugin skills.');
    for (const skill of inheritedSkills.filter(value => value.name === 'find-skills')) assert(emptySkills.some(value => value.name === skill.name), 'Core discovery stays available in a fixed empty agent.');

    stage = 'actual V1 workflow API pin and V2 package wrapper';
    const packageAgent = await createAgent('package');
    const declarations = [{declarationPath: '.canvas-plugin/plugin.json', capabilityId: 'design'},
      {declarationPath: `${briefRoot}/agents/canvas.yaml`, capabilityId: 'child-design'}].map(entry => ({declarationPath: entry.declarationPath, capabilities: [{
      capabilityId: entry.capabilityId, selection: {mode: 'fixed', alternativeKey: 'mcp:reader-mcp', toolCap: [BROWSER_MCP_TOOL, 'package-extra', 'child-extra'],
        target: {kind: 'shared', source: 'mcp', connectionRef: shared.resource.connectionRef, bindingRevision: shared.resource.bindingRevision,
          mcpMapping: {kind: 'manager_confirmation'}}}}]}));
    const patch = await route.PATCH(new NextRequest(`${baseUrl}?workspaceId=${owner.workspaceId}`, {method: 'PATCH', headers: fixture.headers('owner'),
      body: JSON.stringify({agentId: packageAgent.agentId, expectedRevision: packageAgent.revision, expectedWorkflowRevision: packageAgent.workflowRevision ?? 0,
        workflow: {version: 1, packages: [{...pin, skillSelection: {kind: 'plugin'}, declarations}]}})}));
    assert.equal(patch.status, 200); assert.equal((await patch.json()).success, true);
    const v1 = await workflow.readManagedAgentWorkflow(alice, packageAgent.agentId);
    assert.equal(v1.workflowVersion, 1); assert(workflow.isManagedAgentWorkflowSnapshot(v1));
    assert(!workflow.isManagedAgentWorkflowSnapshot(JSON.parse(JSON.stringify(v1))), 'Stored JSON is never fresh issued actor authority.');
    const packageRow = v1.bindings.find(binding => binding.configuration?.resourceRef === pin.resourceRef);
    assert(packageRow?.configuration); const originalV1: StoredAgentWorkflowPackage = packageRow.configuration;
    assert.equal(originalV1.publishedRevisionRef, pin.publishedRevisionRef); assert.equal(originalV1.checksum, pin.checksum);
    const packageContext = await createContext(packageAgent, alice.userId);
    assert.equal(await mode.getRuntimeAgentWorkflowMode(packageContext), 1);
    assert.deepEqual((await runtime.getAuthorizedAgentWorkflowPackageSelections(packageContext)).packages[0], originalV1);
    const wrapper = parseStoredPackageExtensionBinding({version: 2, kind: 'package', workflow: originalV1, selections: [{selection: {
      kind: 'plugin', package: pin, skillSelection: {kind: 'subset', relativeRoots: []}}, requirement: 'required', toolCap: [BROWSER_MCP_TOOL, 'package-extra']},
    {selection: {kind: 'skill', package: pin, origin: 'plugin_child', relativeRoot: briefRoot}, requirement: 'optional', toolCap: [BROWSER_MCP_TOOL, 'child-extra']}]});
    await sql.run('UPDATE agent_capability_bindings SET configuration_json=$1 WHERE id=$2', [JSON.stringify(wrapper), packageRow.id]);
    await insertStandaloneProtocolRow(packageAgent.agentId); await setV2ProtocolHeader(packageAgent.agentId);
    const v2 = await workflow.readManagedAgentWorkflow(alice, packageAgent.agentId);
    assert.equal(v2.workflowVersion, 2); assert.deepEqual(v2.bindings.find(binding => binding.id === packageRow.id)?.configuration, originalV1);
    assert.equal(await mode.getRuntimeAgentWorkflowMode(packageContext), 2);
    const selected = await runtime.getAuthorizedAgentWorkflowPackageSelections(packageContext);
    assert.equal(selected.workflowVersion, 2); assert.equal(selected.packages[0]?.publishedRevisionRef, pin.publishedRevisionRef);
    assert.deepEqual(selected.packages[0]?.selectedSkills.map(skill => skill.relativeRoot), [briefRoot], 'Parent subset[] unions the explicitly selected exact child.');
    assert.equal(selected.packages[0]?.declarations[0]?.declarationPath, '.canvas-plugin/plugin.json', 'The parent requirement survives a child mask.');
    const packageCapability = selected.packages[0]?.declarations[0]?.capabilities[0]?.selection;
    assert(packageCapability?.mode === 'fixed'); assert.deepEqual(packageCapability.toolCap, [BROWSER_MCP_TOOL, 'package-extra']);
    const childCapability = selected.packages[0]?.declarations.find(entry => entry.declarationPath === `${briefRoot}/agents/canvas.yaml`)?.capabilities[0]?.selection;
    assert(childCapability?.mode === 'fixed'); assert.deepEqual(childCapability.toolCap, [BROWSER_MCP_TOOL], 'A real child declaration intersects its parent, child and stored-choice caps.');
    const selectedCapture = await runtime.captureCapabilityPackageRuntimeBindings(packageContext, {selection: selected});
    assert(selectedCapture.skillPackageBindings.some(binding => binding.skillName === briefName && binding.publishedRevisionRef === pin.publishedRevisionRef));
    assert(!selectedCapture.skillPackageBindings.some(binding => binding.skillName === assetsName));
    const combined = await projection.resolveAgentWorkflowRuntimeProjection(packageContext, {packageSelection: selected});
    assert(combined); assert.equal(combined.policy.providerToolRules?.length, 1);
    assert.deepEqual(combined.policy.providerToolRules?.[0]?.allowedToolNames, [BROWSER_MCP_TOOL], 'Parent/child/stored cap and standalone cap remain within the current shared user grant.');
    const combinedContext = integrationContext(packageContext);
    projection.attachAgentWorkflowRuntimeProjection(combinedContext, combined);
    const associated = projectWorkflowProviderAssociations(combinedContext, {source: 'mcp', providers: combined.selectedProviders,
      complete: true, providerErrors: [], revision: combined.revision}).providers.find(value => value.providerRef === createSharedIntegrationProviderRef(shared.resource));
    assert(associated);
    assert(associated.pluginRefs.includes(pin.resourceRef), 'The parent binding must actually compile, not disappear as an optional failure behind a same-provider standalone.');
    assert(associated.capabilityRefs?.includes(agentWorkflowCapabilityKey(pin.resourceRef, '.canvas-plugin/plugin.json', 'design')));
    assert(associated.capabilityRefs?.includes(agentWorkflowCapabilityKey(pin.resourceRef, `${briefRoot}/agents/canvas.yaml`, 'child-design')));
    assert(associated.capabilityRefs?.includes(slotRef), 'The same issued provider has both the configured package capability and standalone slot.');

    stage = 'standalone-only actual mode and current source use without manage';
    const standaloneAgent = await createAgent('standalone'); await insertStandaloneProtocolRow(standaloneAgent.agentId); await setV2ProtocolHeader(standaloneAgent.agentId);
    const aliceContext = await createContext(standaloneAgent, alice.userId), bobContext = await createContext(standaloneAgent, bob.userId);
    assert.equal(await mode.getRuntimeAgentWorkflowMode(aliceContext), 2);
    const directSnapshot = await workflow.readManagedAgentWorkflow(alice, standaloneAgent.agentId);
    assert.equal(directSnapshot.access.canUse, true); assert.equal(directSnapshot.access.canManage, false);
    assert.equal((await runtime.getAuthorizedAgentWorkflowPackageSelections(aliceContext)).packages.length, 0);
    const sourceAccess = await connections.authorizeIntegrationConnection(alice, shared.resource.connectionRef, 'use');
    assert.equal(sourceAccess.access.canUse, true); assert.equal(sourceAccess.access.canManage, false);
    const actualProjection = await projection.resolveAgentWorkflowRuntimeProjection(aliceContext); assert(actualProjection);
    assert.equal(actualProjection.unavailable, false);
    assert.deepEqual(actualProjection.policy.providerToolRules?.[0]?.allowedToolNames, [BROWSER_MCP_TOOL]);
    const actualRuntimePolicy = await resolveIntegrationRuntimePolicy({executionContext: aliceContext, ceiling: mcpCeiling});
    assert.deepEqual(actualRuntimePolicy.policy.allowedProviderRefs, actualProjection.policy.allowedProviderRefs);
    assert.equal(isIntegrationProviderReferenceAllowed(actualRuntimePolicy.policy, 'mcp', createSharedIntegrationProviderRef(shared.resource)), true);
    assert.deepEqual(actualRuntimePolicy.policy.providerToolRules?.[0]?.allowedToolNames, [BROWSER_MCP_TOOL], 'The actual V2 policy consumer intersects configured/actor/provider choices with its registered ceiling.');
    const deniedProjection = await projection.resolveAgentWorkflowRuntimeProjection(bobContext); assert(deniedProjection);
    assert.equal(deniedProjection.unavailable, true);
    assert.deepEqual(deniedProjection.policy.providerToolRules, []);
    await expectWorkflowReaderCode(() => projection.assertAgentWorkflowRuntimeReady({context: integrationContext(bobContext),
      policy: deniedProjection.policy, projection: deniedProjection}), 'provider_denied');
    await expectWorkflowReaderCode(() => projection.assertAgentWorkflowRuntimeReady({context: integrationContext(aliceContext),
      policy: actualProjection.policy, projection: JSON.parse(JSON.stringify(actualProjection))}), 'provider_denied');

    stage = 'actual SQL corrupt header and private row rejection';
    const currentHeader = await sql.get('SELECT workflow_version,workflow_revision FROM agents WHERE agent_id=$1', [standaloneAgent.agentId]) as {workflow_version: number; workflow_revision: number};
    for (const changedVersion of [3, null]) {
      await sql.run('UPDATE agents SET workflow_version=$1 WHERE agent_id=$2', [changedVersion, standaloneAgent.agentId]);
      try {
        await expectWorkflowReaderCode(() => workflow.readManagedAgentWorkflow(alice, standaloneAgent.agentId), 'AGENT_WORKFLOW_CORRUPT');
        await expectWorkflowReaderCode(() => mode.getRuntimeAgentWorkflowMode(aliceContext), 'AGENT_WORKFLOW_CORRUPT');
      } finally {await sql.run('UPDATE agents SET workflow_version=$1,workflow_revision=$2 WHERE agent_id=$3', [currentHeader.workflow_version, currentHeader.workflow_revision, standaloneAgent.agentId]);}
    }
    const standaloneRow = await sql.get('SELECT id,configuration_json,resource_id FROM agent_capability_bindings WHERE agent_id=$1', [standaloneAgent.agentId]) as {id: string; configuration_json: string; resource_id: string};
    const withoutVersion = JSON.parse(standaloneRow.configuration_json); delete withoutVersion.version;
    for (const damagedBytes of ['null', '{', JSON.stringify(withoutVersion)]) {
      await sql.run('UPDATE agent_capability_bindings SET configuration_json=$1 WHERE id=$2', [damagedBytes, standaloneRow.id]);
      try {await expectWorkflowReaderCode(() => workflow.readManagedAgentWorkflow(alice, standaloneAgent.agentId), 'AGENT_WORKFLOW_CORRUPT');}
      finally {await sql.run('UPDATE agent_capability_bindings SET configuration_json=$1 WHERE id=$2', [standaloneRow.configuration_json, standaloneRow.id]);}
    }
    await sql.run('UPDATE agent_capability_bindings SET resource_id=$1 WHERE id=$2', [shared.resource.connectionRef, standaloneRow.id]);
    try {await expectWorkflowReaderCode(() => workflow.readManagedAgentWorkflow(alice, standaloneAgent.agentId), 'AGENT_WORKFLOW_CORRUPT');}
    finally {await sql.run('UPDATE agent_capability_bindings SET resource_id=$1 WHERE id=$2', [standaloneRow.resource_id, standaloneRow.id]);}

    stage = 'fresh grant revocation closes existing source projection';
    const revision = {expectedMetadataRevision: shared.resource.metadataRevision, expectedGrantsRevision: shared.resource.grantsRevision,
      expectedBindingRevision: shared.resource.bindingRevision};
    await connections.mutateSharedIntegrationConnection(actor, shared.resource.connectionRef, {...revision, grants: mcpGrants.filter(grant => grant.targetId !== alice.userId)});
    const revokedProjection = await projection.resolveAgentWorkflowRuntimeProjection(aliceContext); assert(revokedProjection);
    assert.equal(revokedProjection.unavailable, true);
    assert.deepEqual(revokedProjection.policy.providerToolRules, []);
    await expectWorkflowReaderCode(() => projection.assertAgentWorkflowRuntimeReady({context: integrationContext(aliceContext),
      policy: revokedProjection.policy, projection: revokedProjection}), 'provider_denied');
    assert.equal(mcp.calls().requests, 0); assert.equal(mcp.calls().executions.length, 0);
    assert.equal(blockedNetworkAttempts, 0); assert.equal(fixture.providerRequests(), 0);
    console.log(`PASS extension workflow reader: actual legacy/V1 API and SQL V2 protocol reader; fixed empty vs inheritance; standalone-only mode; immutable mask/pin; shared user/grant/cap checks; corrupt header/bytes/slot denied; archive reads ${fixture.registry.count('archive')}; MCP/business/external requests 0.`);
    assert(await agents.getAgentProfile(standaloneAgent.agentId));
  } catch (error) {
    const line = error instanceof Error ? error.stack?.match(/extension-workflow-reader-native-test\.ts:(\d+):/u)?.[1] : undefined;
    console.error(`FAIL extension workflow reader at ${stage}; public code ${error && typeof error === 'object' ? String(Reflect.get(error, 'code') ?? 'assertion-or-internal') : 'internal'}; test line ${line ?? 'unavailable'}.`);
    throw new Error('Native workflow reader proof did not pass.');
  } finally {
    const providerClose = await Promise.allSettled([mcp?.close()]);
    try {await fixture?.close();}
    finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(previousEnvironment)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      if (dataRoot && databaseName) await assertWorkflowReaderCleanup(maintenance.toString(), databaseName, dataRoot);
    }
    assert(providerClose.every(result => result.status === 'fulfilled'));
    console.log('CLEANUP extension workflow reader: owned MCP listener closed.');
  }
}

runExtensionWorkflowReaderNativeProof().catch(() => {process.exitCode = 1;});
