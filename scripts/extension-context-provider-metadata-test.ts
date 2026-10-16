import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AgentManagementActor } from '../app/lib/agents/management-actions';
import type { AgentExtensionConfigurationInput } from '../app/lib/capabilities/extensions/contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

// Actual SQL actor/workspace/target/source ACLs, configuration writer, private
// choices and real MCP files. Model metadata alone is controlled; no external
// provider, account, status, tool or business request is permitted.
async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const previousLoad = loader._load;
  loader._load = (name, parent, isMain) => name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat'
    ? { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => {}, isContextOverflow: () => false }
    : previousLoad(name, parent, isMain);
  let stage = 'services';
  try {
    const { owner, alice, organizationId } = fixture;
    const management = await import('../app/lib/agents/management-actions');
    const workflows = await import('../app/lib/agents/workflow-configuration');
    const sources = await import('../app/lib/integration-tools/connections/store');
    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const metadata = await import('../app/lib/agents/extension-context-provider-metadata');
    const { resolveVerifiedAgentActorContextOnConnection } = await import('../app/lib/agents/actor-context');
    const { createStandaloneExtensionSlotRef } = await import('../app/lib/capabilities/extensions/standalone-reference');
    const { attachAgentWorkflowRuntimeProjection, resolveAgentWorkflowRuntimeProjection } = await import('../app/lib/agents/workflow-runtime');
    const { resolveAgentExecutionContextForSession } = await import('../app/lib/pi/session-workspace-context');
    const { piSessions } = await import('../app/lib/db/schema');
    const { renderEffectiveExtensionContext } = await import('../app/lib/capabilities/extensions/context-prompt');
    const { buildPiSpecialAgentRegistrationMetadata } = await import('../app/lib/pi/tool-registry');
    const { resolveOrganizationDataRoot } = await import('../app/lib/runtime-data-paths');
    const ownerActor: AgentManagementActor = { ...owner, source: 'api' }, aliceActor: AgentManagementActor = { ...alice, source: 'api' };
    const sourceActor = { ...owner, organizationId };
    const createSource = (label: string, users: string[]) => createSharedMcpConnection(sourceActor, {
      ownership: { type: 'organization', organizationId }, displayName: label, accessMode: 'restricted', allowedToolNames: ['READ', 'EXTRA'],
      grants: users.map(targetId => ({ targetType: 'user' as const, targetId, canUse: true, canManage: false, allowedToolNames: ['READ'] })),
      config: { url: 'https://provider-metadata.example.test/mcp', auth: 'none', transport: 'http', enabled: true },
    });
    const a = await createSource('Private unselected A', [owner.userId]);
    const b = await createSource('Chosen B', [owner.userId, alice.userId]);
    const foreign = await createSource('Not in the central choices', [owner.userId]);
    const selection = (source: typeof a) => ({ kind: 'mcp' as const, source: 'mcp' as const,
      target: { kind: 'shared' as const, connectionRef: source.resource.connectionRef, bindingRevision: source.resource.bindingRevision } });
    const slotId = 'metadata-exact-choice';
    const configuration: AgentExtensionConfigurationInput = { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null,
      standalone: [{ mode: 'selectable', configurationId: slotId, source: 'mcp', requirement: 'required', allowedChoices: [
        { choiceId: 'a', selection: selection(a), toolCap: ['READ', 'EXTRA'] }, { choiceId: 'b', selection: selection(b), toolCap: ['READ', 'EXTRA'] },
      ] }] };
    stage = 'genuine missing-choice template';
    const created = await management.createManagedAgent(ownerActor, { name: `Provider context ${randomUUID()}`, scopeType: 'organization',
      enabledTools: ['mcp'], extensions: configuration,
      grants: [{ targetType: 'user', targetId: alice.userId, canUse: true, canEdit: false, canManage: false }] });
    const agentId = created.agent.agentId;
    const slotRef = createStandaloneExtensionSlotRef({ configurationId: slotId, source: 'mcp' });
    const parity = async (result: Awaited<ReturnType<typeof metadata.buildAgentExtensionProviderContextOnConnection>>) => {
      const sessionId = `provider-context-${randomUUID()}`;
      await fixture.database.db.insert(piSessions).values({ sessionId, userId: alice.userId, agentId, workspaceId: alice.workspaceId,
        workspaceType: 'personal', organizationId, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
      const context = await resolveAgentExecutionContextForSession({ userId: alice.userId, sessionId, agentId });
      const actual = await resolveAgentWorkflowRuntimeProjection(context);
      assert(actual);
      assert.deepEqual(result.projection.standaloneSelections, actual.standaloneSelections);
      assert.deepEqual(result.projection.policy, actual.policy);
      assert.deepEqual(result.projection.selectedProviders, actual.selectedProviders);
      const registration = await buildPiSpecialAgentRegistrationMetadata({ kind: 'special', userId: alice.userId,
        effectiveEnabledTools: ['mcp'], extensionMode: 'fixed', workspacePermissions: null });
      const render = (projection: typeof actual) => renderEffectiveExtensionContext({ fingerprint: 'same-actual-source-comparison',
        mode: 'fixed', packages: [], skills: [], workflowProjection: projection }, registration.manifest, '',
      { integrationPolicyCeiling: registration.integrationPolicyCeiling ?? undefined });
      assert.deepEqual(render(result.projection), render(actual), 'Configuration and actual runtime must render identical context and byte budget.');
    };
    const compile = async (actorInput: AgentManagementActor, inspect?: (database: import('../app/lib/db').SqlConnection,
      batch: import('../app/lib/integration-tools/connections/store').IntegrationConnectionBindingBatch) => Promise<void>) => {
      const database = await fixture.database.openDb();
      await database.run('BEGIN');
      try {
        const snapshot = await workflows.readManagedAgentWorkflowOnConnection(database, agentId);
        const prefs = workflows.readAgentWorkflowPreferenceSnapshot(await database.get(
          'SELECT preferences_json,revision FROM agent_user_preferences WHERE agent_id=$1 AND user_id=$2',
          [agentId, actorInput.userId]) as Record<string, unknown> | undefined);
        snapshot.choices = prefs.choices; snapshot.preferenceRevision = prefs.revision;
        const actor = await resolveVerifiedAgentActorContextOnConnection(actorInput, database, { lock: true });
        const refs = metadata.collectAgentExtensionContextSharedReferences(snapshot);
        assert.deepEqual(new Set(refs), new Set([a.resource.connectionRef, b.resource.connectionRef]));
        const batch = await sources.lockIntegrationConnectionBindingsOnConnection(database, { ...actorInput, organizationId }, refs);
        await inspect?.(database, batch);
        return await metadata.buildAgentExtensionProviderContextOnConnection({ database, actor, snapshot, batch, purpose: 'read', packages: [] });
      } finally { await database.run('ROLLBACK'); await database.close(); }
    };
    const template = await compile(aliceActor);
    assert(template.projection.unavailable); assert.deepEqual(template.projection.selectedProviders, []);
    assert.equal(template.projection.standaloneSelections[0].state, 'missing');
    assert.deepEqual(template.requiredProviders, []);
    await parity(template);

    stage = 'actual Use-only preference B without Use on unselected A';
    const before = await workflows.readManagedAgentWorkflow(aliceActor, agentId);
    await workflows.setManagedAgentWorkflowChoice({ actor: aliceActor, agentId, capabilityKey: slotRef,
      expectedWorkflowRevision: before.workflowRevision, expectedPreferenceRevision: before.preferenceRevision, choiceId: 'b' });
    const result = await compile(aliceActor, async (database, batch) => {
      await assert.rejects(sources.narrowIntegrationConnectionBindingBatchOnConnection(database, structuredClone(batch), []));
      const anotherLease = await fixture.database.openDb();
      try { await assert.rejects(sources.narrowIntegrationConnectionBindingBatchOnConnection(anotherLease, batch, [])); }
      finally { await anotherLease.close(); }
      await assert.rejects(sources.narrowIntegrationConnectionBindingBatchOnConnection(database, batch, [foreign.resource.connectionRef]));
      const onlyB = await sources.narrowIntegrationConnectionBindingBatchOnConnection(database, batch, [b.resource.connectionRef]);
      assert.deepEqual(onlyB.connectionRefs, [b.resource.connectionRef]);
    });
    assert.equal(result.projection.unavailable, false);
    assert.equal(result.projection.selectedProviders.length, 1);
    const descriptor = result.projection.selectedProviders[0];
    assert.equal(descriptor.displayName, 'Chosen B');
    for (const field of ['state', 'authorized', 'requiresAuth', 'health'] as const) assert.equal(descriptor[field], 'unknown');
    assert.equal(descriptor.canExecute, false);
    assert.equal(result.projection.policy.providerToolRules?.length, 1);
    assert.deepEqual(result.projection.policy.providerToolRules?.[0].allowedToolNames, ['READ']);
    assert.deepEqual(result.requiredProviders, [{ source: 'mcp', providerRef: descriptor.providerRef }]);
    assert.equal(result.projection.standaloneSelections[0].origin, 'user');
    await parity(result);
    const completedLease = await fixture.database.openDb();
    try {
      await completedLease.run('BEGIN');
      const oldBatch = await sources.lockIntegrationConnectionBindingsOnConnection(completedLease, sourceActor, [b.resource.connectionRef]);
      await completedLease.run('COMMIT');
      await assert.rejects(sources.narrowIntegrationConnectionBindingBatchOnConnection(completedLease, oldBatch, [b.resource.connectionRef]),
        'A genuine batch cannot outlive its original SQL transaction.');
    } finally { await completedLease.close(); }
    assert.throws(() => attachAgentWorkflowRuntimeProjection({ actorUserId: alice.userId, organizationId, workspaceId: alice.workspaceId,
      agentId, sessionId: null, policyRevision: 'metadata-cannot-execute' }, result.projection));
    const json = JSON.stringify(result);
    const privateProviderOrigin = new URL('https://provider-metadata.example.test/mcp').origin;
    for (const [url] of json.matchAll(/https?:\/\/[^"\\\s]+/gu)) {
      assert.notEqual(new URL(url).origin, privateProviderOrigin, 'Public metadata must not contain a private provider URL.');
    }
    assert(!json.includes('connectionId')); assert(!json.includes('backend'));

    stage = 'actual missing required package skips selected standalone metadata exactly like runtime';
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const packageName = `provider-context-${randomUUID().slice(0, 8)}`;
    const archive = await fixture.registry.addPackage('application', 'plugin', packageName, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name: packageName, version: '1.0.0', description: 'Required source metadata fixture', skills: './skills',
        connectors: { mcp: [{ name: 'required-reader', required: false, configPath: 'mcp.json' }] },
        workflow: { version: 1, integrationCapabilities: [{ id: 'required-reader', application: 'reader', required: true,
          alternatives: [{ source: 'mcp', connector: 'required-reader', requiredTools: ['READ'] }] }] } }),
      'mcp.json': JSON.stringify({ url: 'https://provider-metadata.example.test/mcp', auth: 'none', transport: 'http' }),
      'skills/metadata-brief/SKILL.md': '---\nname: metadata-brief\ndescription: Prepare precise metadata evidence\n---\n\nRead exact metadata.\n',
    }, plugins.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: packageName, version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' },
      grants: [owner, alice].map(actor => ({ targetType: 'user' as const, targetId: actor.userId, canUse: true, canEdit: false, canManage: false })) });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const missingPackage = await management.createManagedAgent(ownerActor, { name: 'Missing package choice preserves standalone summary',
      scopeType: 'organization', enabledTools: ['read', 'mcp'],
      extensions: { version: 1, origin: 'agent_configuration', mode: 'fixed',
        selections: [{ selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: null }],
        workflow: { version: 1, packages: [{ ...pin, skillSelection: { kind: 'plugin' }, declarations: [{ declarationPath: '.canvas-plugin/plugin.json',
          capabilities: [{ capabilityId: 'required-reader', selection: { mode: 'selectable', allowedChoices: [] } }] }] }] },
        standalone: [{ mode: 'fixed', entry: { selection: selection(b), requirement: 'optional', toolCap: ['READ'] } }] },
      grants: [{ targetType: 'user', targetId: alice.userId, canUse: true, canEdit: false, canManage: false }] });
    const packageService = await import('../app/lib/agents/extension-context-package-metadata');
    const sourceSnapshot = await workflows.readManagedAgentWorkflow(aliceActor, missingPackage.agent.agentId);
    const preparedSources = await packageService.prepareAgentExtensionContextPackageSources(aliceActor, sourceSnapshot);
    const packageLease = await fixture.database.openDb();
    await packageLease.run('BEGIN');
    const { packageMetadata, packageProjected } = await (async () => {
      try {
        const batch = await sources.lockIntegrationConnectionBindingsOnConnection(packageLease, { ...aliceActor, organizationId },
          metadata.collectAgentExtensionContextSharedReferences(sourceSnapshot));
        return await packageService.withAgentExtensionContextPackageSources(packageLease, aliceActor, preparedSources, async () => {
          const snapshot = await workflows.readManagedAgentWorkflowOnConnection(packageLease, missingPackage.agent.agentId);
          const actor = await resolveVerifiedAgentActorContextOnConnection(aliceActor, packageLease, { lock: true });
          const packageMetadata = await packageService.buildAgentExtensionPackageContextOnConnection({ database: packageLease, actor: aliceActor, snapshot });
          const packageProjected = await metadata.buildAgentExtensionProviderContextOnConnection({ database: packageLease, actor, snapshot, batch,
            purpose: 'read', packages: packageMetadata.configurations });
          return { packageMetadata, packageProjected };
        });
      } finally { await packageLease.run('ROLLBACK'); await packageLease.close(); }
    })();
    assert(packageProjected.projection.unavailable);
    assert.equal(packageProjected.projection.standaloneSelections[0].state, 'selected');
    assert.equal(packageProjected.projection.standaloneSelections[0].providerRef, undefined);
    const packageSession = `provider-missing-package-${randomUUID()}`;
    await fixture.database.db.insert(piSessions).values({ sessionId: packageSession, userId: alice.userId, agentId: missingPackage.agent.agentId,
      workspaceId: alice.workspaceId, workspaceType: 'personal', organizationId, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const packageContext = await resolveAgentExecutionContextForSession({ userId: alice.userId, sessionId: packageSession, agentId: missingPackage.agent.agentId });
    const actualPackageProjection = await resolveAgentWorkflowRuntimeProjection(packageContext);
    assert(actualPackageProjection);
    assert.deepEqual(packageProjected.projection.standaloneSelections, actualPackageProjection.standaloneSelections);
    const packageRegistration = await buildPiSpecialAgentRegistrationMetadata({ kind: 'special', userId: alice.userId,
      effectiveEnabledTools: ['read', 'mcp'], extensionMode: 'fixed', workspacePermissions: null });
    const renderPackage = (projection: typeof actualPackageProjection) => renderEffectiveExtensionContext({ fingerprint: 'same-missing-package',
      mode: 'fixed', packages: packageMetadata.packages, skills: packageMetadata.skills, workflowProjection: projection }, packageRegistration.manifest, '',
    { integrationPolicyCeiling: packageRegistration.integrationPolicyCeiling ?? undefined });
    assert.deepEqual(renderPackage(packageProjected.projection), renderPackage(actualPackageProjection));

    stage = 'disabled backend remains unknown metadata until actual runtime readiness';
    assert(b.backend.source === 'mcp');
    const file = path.join(resolveOrganizationDataRoot(organizationId), 'mcp', 'shared', b.backend.connectionId, 'config.json');
    const raw = await fs.readFile(file, 'utf8');
    const config = JSON.parse(raw);
    for (const connection of Object.values(config.mcpServers) as Array<Record<string, unknown>>) connection.enabled = false;
    await fs.writeFile(file, JSON.stringify(config));
    const disabled = await compile(aliceActor);
    assert.equal(disabled.projection.unavailable, false);
    assert.equal(disabled.projection.selectedProviders[0].health, 'unknown');
    assert.equal(disabled.projection.selectedProviders[0].canExecute, false);
    await parity(disabled);
    await fs.writeFile(file, raw);

    stage = 'fresh source ACL revocation';
    await sources.mutateSharedIntegrationConnection(sourceActor, b.resource.connectionRef, {
      expectedMetadataRevision: b.resource.metadataRevision, expectedGrantsRevision: b.resource.grantsRevision, expectedBindingRevision: b.resource.bindingRevision,
      grants: [{ targetType: 'user', targetId: owner.userId, canUse: true, canManage: false, allowedToolNames: ['READ'] }],
    });
    const revoked = await compile(aliceActor);
    assert(revoked.projection.unavailable); assert.deepEqual(revoked.projection.selectedProviders, []);
    assert.equal(revoked.projection.standaloneSelections[0].state, 'unavailable');
    await parity(revoked);
    assert.equal(fixture.providerRequests(), 0);
    console.log('PASS provider context: real SQL/choices/ACL, genuine batch narrowing, exact backend/caps, unknown health and no runtime authority; zero provider requests');
  } catch (error) { console.error(`Provider context stage: ${stage}`); throw error; }
  finally { loader._load = previousLoad; await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
