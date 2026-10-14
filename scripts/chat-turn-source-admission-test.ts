import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SqlConnection } from '../app/lib/db';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture();
  const originalOpen = fixture.database.openDb;
  const originalDrizzle = fixture.database.db;
  try {
    const { sql, owner, alice, organizationId } = fixture;
    const registry = await import('../app/lib/agents/registry');
    await registry.ensureCanvasAgent();
    const packages = await import('../app/lib/capabilities/packages/actions');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const activation = await import('../app/lib/capabilities/packages/activation');
    const preference = await import('../app/lib/capabilities/preference-store');
    const sources = await import('../app/lib/capabilities/packages/runtime-bindings');
    const accepted = await import('../app/lib/capabilities/extensions/accepted-turn-selection');
    const connections = await import('../app/lib/integration-tools/connections/store');
    const standalone = await import('../app/lib/capabilities/extensions/standalone-preparation');
    const mcp = await import('../app/lib/mcp/shared-connections');
    const personalConfig = await import('../app/lib/mcp/config');
    const definitions = await import('../app/lib/mcp/server-definitions');
    const personalConnections = await import('../app/lib/mcp/personal-connections');
    const sessions = await import('../app/lib/pi/session-workspace-context');
    const { piSessions } = await import('../app/lib/db/schema');
    const name = `admission-${randomUUID().slice(0, 8)}`;
    const archive = await fixture.registry.addPackage('application', 'plugin', name, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', description: 'Pinned admission fixture', skills: './skills' }),
      [`skills/${name}-skill/SKILL.md`]: `---\nname: ${name}-skill\ndescription: Actual source admission\n---\n\nUse the exact held source.\n`,
    }, plugins.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(owner, {
      source: { kind: 'plugin', registryId: 'store-application', entryKey: name, version: '1.0.0', checksum: archive.checksum },
      ownership: { type: 'organization' }, grants: [{ targetType: 'user', targetId: alice.userId, canUse: true, canEdit: false, canManage: false }],
    });
    const ref = installed.resource.resourceRef, pin = { resourceRef: ref, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const descriptor = await packages.inspectCapabilityPackage(owner, ref);
    await activation.setCapabilityPackageDefaultActivationAction(owner, ref, {
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
      expectedPackageRevision: descriptor.state!.packageRevision, expectedPublishedRevisionRef: pin.publishedRevisionRef,
      expectedDefaultEnabled: false, enabled: true,
    });
    await preference.setCapabilityPreference({ userId: alice.userId, resourceId: installed.resource.legacyResourceId, enabled: true });
    const agentId = 'admission-use-agent';
    await registry.createAgentProfile({ name: 'Use-only admission Agent', agentId, accessPolicy: 'restricted', scopeType: 'organization',
      organizationId, createdByUserId: owner.userId, relevantSkills: [`${name}-skill`] });
    await sql.run("INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,can_use,can_edit,can_manage,created_at,updated_at) VALUES ('admission-use',$1,$2,'user','alice',1,0,0,1,1)", [agentId, organizationId]);
    await fixture.database.db.insert(piSessions).values({ sessionId: 'admission-session', userId: alice.userId, agentId,
      workspaceId: alice.workspaceId, workspaceType: 'personal', organizationId, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const base = await sessions.resolveAgentExecutionContextForSession({ userId: alice.userId, sessionId: 'admission-session', agentId });
    const shared = await mcp.createSharedMcpConnection({ ...owner, organizationId }, { ownership: { type: 'organization', organizationId },
      displayName: 'Actual turn source', accessMode: 'restricted', allowedToolNames: ['read_fixture'],
      grants: [{ targetType: 'user', targetId: alice.userId, canUse: true, canManage: false, allowedToolNames: ['read_fixture'] }],
      config: { url: 'https://fixture.invalid/mcp', transport: 'http', auth: 'none', enabled: true } });
    const definition = await definitions.publishMcpServerDefinition(organizationId, 'Approved admission source',
      { url: 'https://203.0.113.10/mcp', transport: 'http', auth: 'none', enabled: true });
    const personalCreated = await personalConnections.createPersonalMcpConnection(alice.userId, definition.id, 'Personal admission source');
    const personal = (await personalConfig.readMcpConfig({ userId: alice.userId })).mcpServers[personalCreated.server];
    assert(personal?.connectionId);
    const intakeContext = { ...base, agentTurnId: randomUUID() };
    const handle = await accepted.prepareAcceptedTurnExtensionSelection(intakeContext, { version: 1, origin: 'turn_reference', selections: [
      { selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: null },
      { selection: { kind: 'mcp', source: 'mcp', target: { kind: 'shared', connectionRef: shared.resource.connectionRef,
        bindingRevision: shared.resource.bindingRevision } }, requirement: 'optional', toolCap: ['read_fixture'] },
      { selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${personal.connectionId}` } }, requirement: 'optional', toolCap: null },
    ] });
    const context: AgentExecutionContext = { ...base, agentTurnId: randomUUID(), turnExtensions: accepted.readAcceptedTurnExtensionSelection(handle, intakeContext).publicSelection };
    const selection = await sources.getAuthorizedAgentWorkflowPackageSelections(context);
    const workflowRuntime = await import('../app/lib/agents/workflow-runtime');
    const turnRuntime = await import('../app/lib/capabilities/extensions/turn-runtime');
    context.turnExtensionSource = await turnRuntime.reissueAcceptedTurnRuntimeSelection(context, handle, intakeContext, { packageSelection: selection });
    const projection = await workflowRuntime.resolveAgentWorkflowRuntimeProjection(context, { packageSelection: selection });
    assert(projection);
    const sharedPrepared = await standalone.prepareStandaloneExtensionSelection({ ...alice, organizationId }, {
      selection: { kind: 'mcp', source: 'mcp', target: { kind: 'shared', connectionRef: shared.resource.connectionRef,
        bindingRevision: shared.resource.bindingRevision } }, requirement: 'optional', toolCap: ['read_fixture'],
    });
    assert.equal(selection.snapshot.access.canUse, true); assert.equal(selection.snapshot.access.canEdit, false);
    const stale = async (operation: () => Promise<unknown>) => assert.rejects(operation);
    let checkouts = 0, lifecycle = 0, callbacks = 0, packageLocksAfterShared = 0;
    const borrowed = async (operation: (database: SqlConnection) => Promise<unknown>) => {
      const actual = await originalOpen();
      const sharedLocks = new Set<string>();
      const database: SqlConnection = { ...actual,
        get: async (query, params = []) => {
          if (/FROM integration_connection_resources .*FOR UPDATE/iu.test(query)) sharedLocks.add(String(params[0]));
          if (/pg_advisory_xact_lock/iu.test(query) && String(params[0]).startsWith('capability-resource:')) {
            assert(sharedLocks.has(shared.resource.connectionRef), 'The actual Shared row must be held before the first Package advisory lock.');
            packageLocksAfterShared += 1;
          }
          return actual.get(query, params);
        },
        run: async () => { lifecycle += 1; throw new Error('Borrowed admission must not own transaction lifecycle or SQL writes.'); },
        close: async () => { lifecycle += 1; throw new Error('Borrowed admission must not close the caller lease.'); },
      };
      await actual.run('BEGIN');
      fixture.database.openDb = async () => { checkouts += 1; throw new Error('Nested checkout under held admission sources.'); };
      fixture.database.db = new Proxy(originalDrizzle, { get: () => { checkouts += 1; throw new Error('Global Drizzle under held admission sources.'); } });
      try { return await operation(database); }
      finally { fixture.database.openDb = originalOpen; fixture.database.db = originalDrizzle; await actual.run('ROLLBACK'); await actual.close(); }
    };
    const admit = () => borrowed(database => workflowRuntime.withRevalidatedAgentWorkflowProjectionSourcesOnConnection(database, context, projection,
      { additionalSharedRefs: [shared.resource.connectionRef] },
      () => accepted.withRevalidatedAcceptedTurnExtensionSelectionOnConnection(database, intakeContext, handle,
        () => sources.withRevalidatedAgentWorkflowPackageSelectionOnConnection(database, context, selection, async () => {
        const data = accepted.readAcceptedTurnExtensionSelection(handle, intakeContext);
        callbacks += 1; assert.equal(data.privateFixedBindings.length, 2); return 'accepted';
      }))));
    assert.equal(await admit(), 'accepted'); assert.equal(callbacks, 1);
    // A legitimate newer HEAD is not authority to replace the immutable pin.
    const newer = await fixture.registry.addPackage('application', 'plugin', name, '2.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '2.0.0', description: 'A newer mutable head', skills: './skills' }),
      [`skills/${name}-skill/SKILL.md`]: `---\nname: ${name}-skill\ndescription: Different current head\n---\n\nThe old accepted turn retains version one.\n`,
    }, plugins.computeCanvasPluginChecksum);
    const nextSource = { kind: 'plugin' as const, registryId: 'store-application', entryKey: name, version: '2.0.0', checksum: newer.checksum };
    const review = await stores.inspectCapabilityPackageStoreUpdateAction(owner, ref, { source: nextSource });
    const updated = await stores.updateCapabilityPackageFromStoreAction(owner, ref, { source: nextSource,
      expectedMetadataRevision: review.expectedMetadataRevision, expectedGrantsRevision: review.expectedGrantsRevision,
      expectedPackageRevision: review.expectedPackageRevision, expectedPublishedRevisionRef: review.expectedPublishedRevisionRef,
      expectedLocalChecksum: review.expectedLocalChecksum, replaceLocalChanges: false });
    assert.notEqual(updated.published.revisionRef, pin.publishedRevisionRef);
    assert.equal(await admit(), 'accepted'); assert.equal(callbacks, 2);
    assert.equal(selection.packages[0].publishedRevisionRef, pin.publishedRevisionRef);
    await stale(() => borrowed(db => sources.withRevalidatedAgentWorkflowPackageSelectionOnConnection(db, context, structuredClone(selection), async () => assert.fail('Cloned package source'))));
    await stale(() => borrowed(db => accepted.withRevalidatedAcceptedTurnExtensionSelectionOnConnection(db, intakeContext, { ...handle }, async () => assert.fail('Cloned intake source'))));
    await stale(() => borrowed(db => accepted.withRevalidatedAcceptedTurnExtensionSelectionOnConnection(db, { ...intakeContext, sessionId: 'foreign' }, handle, async () => assert.fail('Foreign session'))));
    await sql.run('UPDATE agents SET revision=revision+1 WHERE agent_id=$1', [agentId]);
    await stale(admit);
    await sql.run('UPDATE agents SET revision=revision-1 WHERE agent_id=$1', [agentId]);
    await sql.run("UPDATE pi_sessions SET archived_at=1 WHERE session_id='admission-session'");
    await stale(admit);
    await sql.run("UPDATE pi_sessions SET archived_at=NULL WHERE session_id='admission-session'");
    await sql.run("UPDATE canvas_workspaces SET status='archived' WHERE id=$1", [alice.workspaceId]);
    await stale(admit);
    await sql.run("UPDATE canvas_workspaces SET status='active' WHERE id=$1", [alice.workspaceId]);
    await sql.run("UPDATE organization_user_permissions SET status='suspended' WHERE user_id=$1", [alice.userId]);
    await stale(admit);
    await sql.run("UPDATE organization_user_permissions SET status='active' WHERE user_id=$1", [alice.userId]);
    await sql.run("UPDATE agent_grants SET can_use=0 WHERE id='admission-use'");
    await stale(admit);
    await sql.run("UPDATE agent_grants SET can_use=1 WHERE id='admission-use'");
    await sql.run('UPDATE capability_resource_grants SET can_use=0 WHERE resource_ref=$1 AND target_id=$2', [ref, alice.userId]);
    await stale(admit);
    await sql.run('UPDATE capability_resource_grants SET can_use=1 WHERE resource_ref=$1 AND target_id=$2', [ref, alice.userId]);
    const { CapabilityPolicyStore } = await import('../app/lib/capabilities/policy-store');
    const policy = await new CapabilityPolicyStore(sql).upsertPolicy({ organizationId, resourceType: 'plugin', resourceId: installed.resource.legacyResourceId,
      targetType: 'user', targetId: alice.userId, effect: 'blocked', actorUserId: owner.userId });
    await stale(admit);
    await sql.run('DELETE FROM capability_policies WHERE id=$1', [policy.id]);
    await sql.run("INSERT INTO ai_workspace_model_policies(organization_id,workspace_id,allow_user_credentials,revision,created_at,updated_at) VALUES($1,$2,0,1,1,1)", [organizationId, alice.workspaceId]);
    await stale(admit);
    await sql.run('DELETE FROM ai_workspace_model_policies WHERE workspace_id=$1', [alice.workspaceId]);
    await sql.run("INSERT INTO agent_user_preferences(agent_id,user_id,preferences_json,revision,created_at,updated_at) VALUES($1,$2,'{}',1,1,1)", [agentId, alice.userId]);
    await stale(admit);
    await sql.run('DELETE FROM agent_user_preferences WHERE agent_id=$1 AND user_id=$2', [agentId, alice.userId]);
    const { resolveSettingsStoragePath } = await import('../app/lib/settings-storage');
    const runtimeFile = resolveSettingsStoragePath('pi-runtime-config.json');
    const runtimeBytes = await fs.readFile(runtimeFile).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    try { await fs.mkdir(path.dirname(runtimeFile), { recursive: true }); await fs.writeFile(runtimeFile, runtimeBytes ? Buffer.concat([runtimeBytes, Buffer.from('\n')]) : '{}'); await stale(admit); }
    finally { if (runtimeBytes) await fs.writeFile(runtimeFile, runtimeBytes); else await fs.rm(runtimeFile); }
    await sql.run('UPDATE integration_connection_resources SET grants_revision=grants_revision+1 WHERE connection_ref=$1', [shared.resource.connectionRef]);
    await stale(admit);
    await sql.run('UPDATE integration_connection_resources SET grants_revision=grants_revision-1 WHERE connection_ref=$1', [shared.resource.connectionRef]);
    const originalConfig = await personalConfig.readMcpConfig({ userId: alice.userId });
    await personalConfig.setMcpServerEnabled(personalCreated.server, false, { userId: alice.userId });
    await stale(admit);
    await personalConfig.writeMcpConfigRaw(JSON.stringify(originalConfig), { userId: alice.userId });
    // Configured sources must be fenced even with no explicit turn selection or Accepted handle.
    const fixedAgent = await registry.createAgentProfile({ agentId: 'configured-admission-agent', name: 'Configured source admission',
      accessPolicy: 'restricted', scopeType: 'user', organizationId, ownerUserId: alice.userId, createdByUserId: alice.userId });
    const configured = await import('../app/lib/capabilities/extensions/agent-standalone-configuration');
    const fixedInput = await configured.prepareAgentStandaloneConfigurations(alice, [
      { mode: 'fixed', entry: { selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal',
        connectionRef: `mcp-personal:${personal.connectionId}` } }, requirement: 'required', toolCap: null } },
      { mode: 'fixed', entry: { selection: { kind: 'mcp', source: 'mcp', target: { kind: 'shared',
        connectionRef: shared.resource.connectionRef, bindingRevision: shared.resource.bindingRevision } }, requirement: 'required', toolCap: ['read_fixture'] } },
    ]);
    const { createStandaloneExtensionSlotRef } = await import('../app/lib/capabilities/extensions/standalone-reference');
    for (const stored of configured.getPreparedAgentStandaloneConfigurations(fixedInput, alice)) {
      const source = stored.mode === 'fixed' ? stored.entry.selection.source : stored.source;
      const slot = createStandaloneExtensionSlotRef({ configurationId: stored.configurationId, source });
      await sql.run(`INSERT INTO agent_capability_bindings(id,agent_id,resource_type,scope_type,resource_id,name,version,requirement,
        revision,created_at,updated_at,configuration_json) VALUES($1,$2,'connection','user',$3,'Actual configured source','v2','required',1,1,1,$4)`,
      [randomUUID(), fixedAgent.agentId, slot, JSON.stringify(stored)]);
    }
    await sql.run('UPDATE agents SET workflow_version=2,workflow_revision=1 WHERE agent_id=$1', [fixedAgent.agentId]);
    await fixture.database.db.insert(piSessions).values({ sessionId: 'configured-admission-session', userId: alice.userId, agentId: fixedAgent.agentId,
      workspaceId: alice.workspaceId, workspaceType: 'personal', organizationId, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const fixedContext = { ...await sessions.resolveAgentExecutionContextForSession({ userId: alice.userId,
      sessionId: 'configured-admission-session', agentId: fixedAgent.agentId }), agentTurnId: randomUUID() };
    const fixedPackages = await sources.getAuthorizedAgentWorkflowPackageSelections(fixedContext);
    const fixedProjection = await workflowRuntime.resolveAgentWorkflowRuntimeProjection(fixedContext, { packageSelection: fixedPackages });
    assert(fixedProjection && !fixedProjection.unavailable);
    assert.equal(fixedProjection.selectedProviders.length, 2);
    let fixedCallbacks = 0;
    const fixedAdmit = () => borrowed(database => workflowRuntime.withRevalidatedAgentWorkflowProjectionSourcesOnConnection(database,
      fixedContext, fixedProjection, {}, () => sources.withRevalidatedAgentWorkflowPackageSelectionOnConnection(database, fixedContext,
        fixedPackages, async () => { fixedCallbacks += 1; return 'configured'; })));
    assert.equal(await fixedAdmit(), 'configured');
    await assert.rejects(borrowed(database => workflowRuntime.withRevalidatedAgentWorkflowProjectionSourcesOnConnection(database,
      fixedContext, { ...fixedProjection }, {}, async () => assert.fail('Copied projection'))));
    for (const mutation of [{ agentTurnId: 'foreign-turn' }, { workspaceRoot: '/foreign-root' }, { canWrite: !fixedContext.canWrite },
      { turnExtensions: { version: 1 as const, origin: 'turn_reference' as const, selections: [] } }]) {
      await assert.rejects(borrowed(database => workflowRuntime.withRevalidatedAgentWorkflowProjectionSourcesOnConnection(database,
        { ...fixedContext, ...mutation }, fixedProjection, {}, async () => assert.fail('Changed projection namespace'))));
    }
    await personalConfig.setMcpServerEnabled(personalCreated.server, false, { userId: alice.userId });
    await stale(fixedAdmit);
    await personalConfig.writeMcpConfigRaw(JSON.stringify(originalConfig), { userId: alice.userId });
    const { resolveMcpConfigPath } = await import('../app/lib/mcp/config');
    const sharedFile = resolveMcpConfigPath(mcp.sharedMcpScope(await connections.authorizeIntegrationConnection({ ...alice, organizationId,
      agentId: fixedAgent.agentId, sessionId: fixedContext.sessionId, policyRevision: 'source-fixture' }, shared.resource.connectionRef, 'inspect')));
    const sharedBytes = await fs.readFile(sharedFile, 'utf8');
    try {
      const changed = JSON.parse(sharedBytes);
      Object.values(changed.mcpServers).forEach(server => { (server as { enabled: boolean }).enabled = false; });
      await fs.writeFile(sharedFile, JSON.stringify(changed));
      await stale(fixedAdmit);
      await fs.writeFile(sharedFile, sharedBytes);
      let callbackEntered = false;
      await assert.rejects(borrowed(database => workflowRuntime.withRevalidatedAgentWorkflowProjectionSourcesOnConnection(database,
        fixedContext, fixedProjection, {}, async () => { callbackEntered = true; await fs.writeFile(sharedFile, JSON.stringify(changed)); })));
      assert.equal(callbackEntered, true, 'A source change during the callback is rejected by the postcheck.');
    } finally { await fs.writeFile(sharedFile, sharedBytes); }
    await sql.run('UPDATE integration_connection_resources SET grants_revision=grants_revision+1 WHERE connection_ref=$1', [shared.resource.connectionRef]);
    await stale(fixedAdmit);
    await sql.run('UPDATE integration_connection_resources SET grants_revision=grants_revision-1 WHERE connection_ref=$1', [shared.resource.connectionRef]);
    const personalFile = resolveMcpConfigPath({ userId: alice.userId });
    const personalBytes = await fs.readFile(personalFile, 'utf8');
    const { hashMcpAuthConfig } = await import('../app/lib/mcp/connection-identity');
    try {
      const changed = JSON.parse(personalBytes), original = changed.mcpServers[personalCreated.server];
      const originalAuthHash = hashMcpAuthConfig(original);
      original.displayName = `Actual renamed personal source ${'界'.repeat(3000)}`;
      assert.equal(hashMcpAuthConfig(original), originalAuthHash, 'A display-only rename preserves actual auth configuration.');
      await fs.writeFile(personalFile, JSON.stringify(changed));
      await stale(fixedAdmit);
      assert.equal(fixedCallbacks, 1, 'Renamed prompt metadata is rejected before the admission callback.');
    } finally { await fs.writeFile(personalFile, personalBytes); }
    try {
      const changed = JSON.parse(personalBytes);
      changed.mcpServers[personalCreated.server].authVersion = (changed.mcpServers[personalCreated.server].authVersion || 1) + 1;
      await fs.writeFile(personalFile, JSON.stringify(changed)); await stale(fixedAdmit);
    } finally { await fs.writeFile(personalFile, personalBytes); }
    const { resolveOrganizationMcpTemplatesDir } = await import('../app/lib/runtime-data-paths');
    const definitionFile = path.join(resolveOrganizationMcpTemplatesDir(organizationId), 'approved-servers.json');
    const definitionBytes = await fs.readFile(definitionFile);
    try { await definitions.setMcpServerDefinitionEnabled(organizationId, definition.id, false); await stale(fixedAdmit); }
    finally { await fs.writeFile(definitionFile, definitionBytes); }
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    await replaceScopedEnvEntries('integrations', [{ key: 'SOURCE_ADMISSION_FIXTURE', value: 'changed-local-owner-revision' }], { userId: alice.userId });
    await stale(fixedAdmit);
    assert.equal(fixedCallbacks, 1);
    // Readiness is not admission authority: a required but unselected personal
    // slot must still allow local chat and skills, with no invented provider.
    const missingPrepared = await configured.prepareAgentStandaloneConfigurations(alice, [{ mode: 'selectable', source: 'mcp',
      configurationId: 'missing-personal-choice', requirement: 'required', allowedChoices: [],
      personalPolicy: { source: 'mcp', serverDefinitionIds: [definition.id], toolCap: null } }]);
    const missingStored = configured.getPreparedAgentStandaloneConfigurations(missingPrepared, alice)[0];
    const missingSlot = createStandaloneExtensionSlotRef({ configurationId: missingStored.configurationId, source: 'mcp' });
    await sql.run('DELETE FROM agent_capability_bindings WHERE agent_id=$1', [fixedAgent.agentId]);
    await sql.run(`INSERT INTO agent_capability_bindings(id,agent_id,resource_type,scope_type,resource_id,name,version,requirement,
      revision,created_at,updated_at,configuration_json) VALUES($1,$2,'connection','user',$3,'Missing choice','v2','required',1,1,1,$4)`,
    [randomUUID(), fixedAgent.agentId, missingSlot, JSON.stringify(missingStored)]);
    await sql.run('UPDATE agents SET revision=revision+1,workflow_revision=workflow_revision+1 WHERE agent_id=$1', [fixedAgent.agentId]);
    const missingPackages = await sources.getAuthorizedAgentWorkflowPackageSelections(fixedContext);
    const missingProjection = await workflowRuntime.resolveAgentWorkflowRuntimeProjection(fixedContext, { packageSelection: missingPackages });
    assert(missingProjection?.unavailable);
    assert.deepEqual(missingProjection.selectedProviders, []);
    assert.equal(await borrowed(database => workflowRuntime.withRevalidatedAgentWorkflowProjectionSourcesOnConnection(database,
      fixedContext, missingProjection, {}, () => sources.withRevalidatedAgentWorkflowPackageSelectionOnConnection(database,
        fixedContext, missingPackages, async () => 'local-chat-remains-available'))), 'local-chat-remains-available');
    await assert.rejects(borrowed(db => standalone.revalidatePreparedStandaloneExtensionSelection(sharedPrepared,
      { ...alice, organizationId }, { database: db })), { code: 'invalid_request' });
    assert.equal(checkouts, 0); assert.equal(lifecycle, 0); assert.equal(callbacks, 2);
    assert(packageLocksAfterShared > 0);
    assert.equal(fixture.providerRequests(), 0);
    assert.equal((await connections.authorizeIntegrationConnection({ ...alice, organizationId }, shared.resource.connectionRef, 'use')).access.canManage, false);
    console.log('PASS actual SQL admission sources: Use-only actor/session, genuine package+accepted+projection handles, global Shared-before-Package order, no-intent fixed Personal/Shared MCP and postcallback backend drift, old pin after new HEAD, config/policy/revision/ACL/session namespaces, zero nested SQL/Drizzle leases, borrowed lifecycle calls or provider IO.');
  } finally { fixture.database.openDb = originalOpen; fixture.database.db = originalDrizzle; await fixture.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
