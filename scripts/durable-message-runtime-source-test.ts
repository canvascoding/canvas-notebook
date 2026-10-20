import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import type { SqlConnection } from '../app/lib/db';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { OwnedAcceptedChatMessage } from '../app/lib/pi/durable-message-admission';
import type { ChatExtensionSelectionInput } from '../app/lib/capabilities/extensions/contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';

/** Real SQL provenance, Store pins, current actor/source/policy services and SDK
 * metadata transport. Failure traps forbid receipt/intake renewal; none issues
 * successful authority or substitutes source verification. No execution claim. */
async function main(): Promise<void> {
  const originalNow = Date.now, originalFetch = globalThis.fetch;
  const fixture = await createCapabilityPackageStoreApplicationFixture();
  const envKeys = ['COMPOSIO_API_KEY', 'COMPOSIO_BASE_URL', 'COMPOSIO_LOGGING_LEVEL'] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load, wrapped = new Map<string, unknown>();
  let forbidIntake = false, intakeCalls = 0, stage = 'actual source fixture';
  let composio: Awaited<ReturnType<typeof createComposioProviderFixture>> | undefined;
  loader._load = (name, parent, isMain) => {
    const trapNames = /(?:^|\/)accepted-turn-selection(?:\.ts)?$/u.test(name) ? ['prepareAcceptedTurnExtensionSelection']
      : /(?:^|\/)standalone-preparation(?:\.ts)?$/u.test(name) ? ['prepareStandaloneExtensionSelection']
        : /(?:^|\/)composio-shared-account-reference(?:\.ts)?$/u.test(name)
          ? ['createPersonalComposioAccountReference', 'readPersonalComposioAccountReference'] : [];
    if (!trapNames.length) return originalLoad(name, parent, isMain);
    if (!wrapped.has(name)) {
      const actual = originalLoad(name, parent, isMain) as Record<string, unknown>;
      wrapped.set(name, new Proxy(actual, { get(target, property, receiver) {
        if (typeof property !== 'string' || !trapNames.includes(property)) return Reflect.get(target, property, receiver);
        return (...args: unknown[]) => {
          intakeCalls++;
          if (forbidIntake) throw new Error('Recovery must not renew or reopen original intake/account receipts.');
          return (target[property] as (...values: unknown[]) => unknown)(...args);
        };
      } }));
    }
    return wrapped.get(name);
  };
  const sql = async <T>(callback: (database: SqlConnection) => T | Promise<T>): Promise<T> => {
    const database = await fixture.database.openDb();
    try { return await callback(database); } finally { await database.close(); }
  };
  const denied = (error: unknown) => {
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    const storedSessionDenial = error instanceof Error && [
      'Workspace not found or inaccessible.', 'The originating agent session is unavailable in this workspace.',
      'Agent access is no longer available in this workspace.',
    ].includes(error.message);
    assert(storedSessionDenial || ['AGENT_EXTENSION_CONTEXT_DENIED', 'AGENT_ACTOR_CONTEXT_DENIED', 'AGENT_ACCESS_DENIED',
      'AGENT_WORKFLOW_SOURCE_UNAVAILABLE', 'CAPABILITY_RESOURCE_ACCESS_DENIED', 'PACKAGE_ACCESS_DENIED', 'MCP_ACCESS_DENIED', 'MCP_CONNECTION_DISABLED', 'provider_denied', 'binding_changed'].includes(String(code)),
    `Expected an actual authority denial, received ${String(code)}: ${error instanceof Error ? error.message : typeof error}.`);
    return true;
  };
  try {
    const service = await import('../app/lib/pi/durable-message-admission');
    const turn = await import('../app/lib/capabilities/extensions/turn-runtime');
    const runtime = await import('../app/lib/capabilities/packages/runtime-bindings');
    const effective = await import('../app/lib/capabilities/extensions/effective-context');
    const intake = await import('../app/lib/capabilities/extensions/accepted-turn-selection');
    const management = await import('../app/lib/agents/management-actions');
    const sessions = await import('../app/lib/pi/session-workspace-context');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const resourceStore = await import('../app/lib/capabilities/resources/store');
    const activation = await import('../app/lib/capabilities/packages/activation');
    const personalActivation = await import('../app/lib/capabilities/activation-actions');
    const policies = await import('../app/lib/capabilities/management-actions');
    const permissionService = await import('../app/lib/organization/permissions');
    const mcp = await import('../app/lib/mcp/config');
    const profiles = await import('../app/lib/composio/composio-profiles');
    const receipts = await import('../app/lib/composio/composio-shared-account-reference');
    const { createIntegrationProviderRef } = await import('../app/lib/integration-tools/references');
    const { listPersonalWorkflowProviderAccountChoices } = await import('../app/lib/integration-tools/workflow-personal-bindings');
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    const { owner, alice, organizationId } = fixture, actor = { ...owner, source: 'api' as const };
    await fixture.releaseSetupConnection();
    const agent = await management.createManagedAgent(actor, { name: `Durable source ${randomUUID()}`, scopeType: 'organization',
      enabledTools: ['read', 'mcp'], extensions: { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' },
      grants: [{ targetType: 'user', targetId: alice.userId, canUse: true, canEdit: false, canManage: false }] });
    const sessionId = `source-reissue-${randomUUID()}`;
    await sql(database => database.run(`INSERT INTO pi_sessions
      (session_id,user_id,agent_id,provider,model,organization_id,workspace_id,workspace_type,created_at,updated_at)
      VALUES ($1,$2,$3,'fixture','fixture',$4,$5,'personal',1,1)`,
    [sessionId, alice.userId, agent.agent.agentId, organizationId, alice.workspaceId]));
    const base = await sessions.resolveAgentExecutionContextForStoredSession({ userId: alice.userId, sessionId, agentId: agent.agent.agentId });
    const name = `durable-reissue-${randomUUID().slice(0, 8)}`;
    const skill = (body: string) => `---\nname: held-source\ndescription: Exact held source\n---\n\n${body}\n`;
    const archive = await fixture.registry.addPackage('application', 'plugin', name, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', skills: './skills', description: 'Immutable replay source' }),
      'skills/held-source/SKILL.md': skill('Original immutable source version one.'),
    }, plugins.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: name, version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' },
      grants: [owner, alice].map(value => ({ targetType: 'user' as const, targetId: value.userId, canUse: true, canEdit: false, canManage: false })) });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const descriptor = await packages.inspectCapabilityPackage(owner, pin.resourceRef);
    await activation.setCapabilityPackageDefaultActivationAction(owner, pin.resourceRef, {
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
      expectedPackageRevision: descriptor.state!.packageRevision, expectedPublishedRevisionRef: pin.publishedRevisionRef,
      expectedDefaultEnabled: false, enabled: true });
    await personalActivation.setPersonalCapabilityActivation({ context: { userId: alice.userId, organizationId,
      workspaceId: alice.workspaceId, role: 'member' }, actorUserId: alice.userId, resourceId: descriptor.sourceStamp.resourceId, enabled: true });
    const definitions = await import('../app/lib/mcp/server-definitions');
    const personalConnections = await import('../app/lib/mcp/personal-connections');
    const definition = await definitions.publishMcpServerDefinition(organizationId, 'Approved replay MCP',
      { url: 'https://203.0.113.10/mcp', transport: 'http', auth: 'none', enabled: true });
    const personalConnection = await personalConnections.createPersonalMcpConnection(alice.userId, definition.id, 'Exact replay MCP');
    const mcpName = personalConnection.server;
    const mcpConfig = await mcp.readMcpConfig({ userId: alice.userId });
    const connectionId = mcpConfig.mcpServers[mcpName]?.connectionId; assert(connectionId);
    composio = await createComposioProviderFixture();
    const fixtureFetch = globalThis.fetch, composioOrigin = composio.baseUrl;
    let forbidProviderReads = false;
    globalThis.fetch = async (request, init) => {
      const url = new URL(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url);
      if (url.origin === composioOrigin) {
        assert(!forbidProviderReads, 'Runtime source recovery uses local metadata; no provider readiness/account probe.');
        assert.equal((init?.method ?? (request instanceof Request ? request.method : 'GET')).toUpperCase(), 'GET');
        assert(['/api/v3.1/toolkits', '/api/v3.1/connected_accounts'].includes(url.pathname));
        return originalFetch(request, { ...init, redirect: 'error' });
      }
      if (url.origin === fixture.registry.baseUrl) return fixtureFetch(request, init);
      throw new Error('No external network, provider tool, discovery, schema or business call is permitted.');
    };
    process.env.COMPOSIO_API_KEY = ''; process.env.COMPOSIO_BASE_URL = composioOrigin; process.env.COMPOSIO_LOGGING_LEVEL = 'silent';
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: `fixture-${randomBytes(24).toString('hex')}` }],
      { secretScope: 'user', userId: alice.userId });
    await profiles.ensureDefaultComposioProfile(alice.userId);
    const profile = await profiles.createComposioProfile({ ownerUserId: alice.userId, name: 'Exact replay account' });
    composio.accounts.set(profile.composioUserId, [{ id: 'reissue-account-a', toolkit: 'canva', status: 'ACTIVE' },
      { id: 'reissue-account-b', toolkit: 'canva', status: 'ACTIVE' }]);
    const providerRef = createIntegrationProviderRef({ source: 'composio', profileId: profile.id, toolkit: 'canva',
      scope: { type: 'user', ownerUserId: alice.userId, resourceId: `profile:${profile.id}:canva` } });
    const choices = await listPersonalWorkflowProviderAccountChoices({ actor: alice, providerRef, exactToolkit: { profileId: profile.id, toolkit: 'canva' } });
    assert.equal(choices.accounts.length, 2);
    const selected = choices.accounts[1], account = receipts.readPersonalComposioAccountReference(selected.accountSelectionRef);
    const selection: ChatExtensionSelectionInput = { version: 1, origin: 'turn_reference', selections: [
      { selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: null },
      { selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${connectionId}` } }, requirement: 'optional', toolCap: null },
      { selection: { kind: 'composio', source: 'composio', toolkit: 'canva', target: { kind: 'personal', profileId: profile.id,
        accountBinding: 'account', accountId: account.accountId, connectionRef: `composio-personal:${profile.id}:${account.accountId}` } },
      requirement: 'optional', toolCap: null, accountSelectionRef: selected.accountSelectionRef },
    ] };
    const identity = { userId: alice.userId, sessionId, clientMessageId: 'exact-runtime-source',
      expectedAgentId: agent.agent.agentId, expectedWorkspaceId: alice.workspaceId! };
    const input = { ...identity, message: { role: 'user' as const, content: 'Use the selected exact sources.', timestamp: 100 }, selection };
    const prepared = await service.prepareChatMessageAdmission(input); assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') throw new Error('Expected genuine preparation.');
    const owned = await service.commitPreparedChatMessageAdmission(prepared.admission);
    const stored = service.readOwnedAcceptedChatMessageData(owned, base).payload;
    assert(stored.extensionSelection); assert.doesNotMatch(JSON.stringify(stored), /accountSelectionRef|cmp_personal_account_/u);
    const context: AgentExecutionContext = { ...base, agentTurnId: stored.serverMessageId, turnExtensions: stored.extensionSelection.publicSelection };
    const sourcePackages = await runtime.getAuthorizedAgentWorkflowPackageSelections(context);
    const emptyPrepared = await service.prepareChatMessageAdmission({ ...identity, clientMessageId: 'no-explicit-extensions',
      message: { role: 'user', content: 'Keep this local message.', timestamp: 101 } });
    assert.equal(emptyPrepared.kind, 'prepared');
    if (emptyPrepared.kind !== 'prepared') throw new Error('Expected actual empty selection preparation.');
    const emptyOwned = await service.commitPreparedChatMessageAdmission(emptyPrepared.admission);
    const emptyPayload = service.readOwnedAcceptedChatMessageData(emptyOwned, base).payload;
    assert.equal(emptyPayload.extensionSelection, null);
    const emptyContext = { ...base, agentTurnId: emptyPayload.serverMessageId };
    const emptyPackages = await runtime.getAuthorizedAgentWorkflowPackageSelections(emptyContext);
    const sharedMcp = await import('../app/lib/mcp/shared-connections');
    const connectionStore = await import('../app/lib/integration-tools/connections/store');
    const sharedPublication = await import('../app/lib/mcp/shared-publication');
    const mcpStorage = await import('../app/lib/mcp/storage');
    const sharedDefinition = await definitions.publishMcpServerDefinition(organizationId, 'Approved shared replay MCP',
      { url: 'https://203.0.113.11/mcp', transport: 'http', auth: 'none', enabled: true });
    const sharedActor = { ...owner, organizationId };
    const shared = await sharedMcp.createSharedMcpConnection(sharedActor, {
      ownership: { type: 'organization', organizationId }, displayName: 'Actual shared replay MCP', accessMode: 'restricted',
      definitionId: sharedDefinition.id, allowedToolNames: ['read_fixture'],
      grants: [{ targetType: 'user', targetId: alice.userId, canUse: true, canManage: false, allowedToolNames: null }],
    });
    const sharedPrepared = await service.prepareChatMessageAdmission({ ...identity, clientMessageId: 'shared-source',
      message: { role: 'user', content: 'Keep the exact shared source.', timestamp: 102 },
      selection: { version: 1, origin: 'turn_reference', selections: [{ selection: { kind: 'mcp', source: 'mcp',
        target: { kind: 'shared', connectionRef: shared.resource.connectionRef, bindingRevision: shared.resource.bindingRevision } },
      requirement: 'optional', toolCap: ['read_fixture'] }] } });
    assert.equal(sharedPrepared.kind, 'prepared');
    if (sharedPrepared.kind !== 'prepared') throw new Error('Expected genuine shared source preparation.');
    const sharedOwned = await service.commitPreparedChatMessageAdmission(sharedPrepared.admission);
    const sharedPayload = service.readOwnedAcceptedChatMessageData(sharedOwned, base).payload;
    assert(sharedPayload.extensionSelection);
    const sharedContext = { ...base, agentTurnId: sharedPayload.serverMessageId, turnExtensions: sharedPayload.extensionSelection.publicSelection };
    const sharedPackages = await runtime.getAuthorizedAgentWorkflowPackageSelections(sharedContext);
    const sharedProfiles = await import('../app/lib/composio/composio-shared-profiles');
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: `fixture-${randomBytes(24).toString('hex')}` }],
      { secretScope: 'organization', organizationId });
    const sharedProfile = await sharedProfiles.createSharedComposioProfile({ actor: sharedActor,
      ownership: { type: 'organization', organizationId }, name: 'Actual shared replay profile', providerMode: 'local' });
    const sharedComposio = await connectionStore.createSharedIntegrationConnection(sharedActor, {
      ownership: { type: 'organization', organizationId }, displayName: 'Actual shared public search', accessMode: 'restricted',
      grants: [{ targetType: 'user', targetId: alice.userId, canUse: true, canManage: false, allowedToolNames: null }],
      allowedToolNames: ['PUBLIC_FIND'], backend: { source: 'composio', profileId: sharedProfile.id, toolkit: 'duckduckgo',
        mode: 'local', accountBinding: 'no_auth', connectedAccountId: null },
    });
    const sharedComposioPrepared = await service.prepareChatMessageAdmission({ ...identity, clientMessageId: 'shared-composio-source',
      message: { role: 'user', content: 'Keep this exact no-auth source.', timestamp: 103 },
      selection: { version: 1, origin: 'turn_reference', selections: [{ selection: { kind: 'composio', source: 'composio', toolkit: 'duckduckgo',
        target: { kind: 'shared', connectionRef: sharedComposio.resource.connectionRef, bindingRevision: sharedComposio.resource.bindingRevision } },
      requirement: 'optional', toolCap: ['PUBLIC_FIND'] }] } });
    assert.equal(sharedComposioPrepared.kind, 'prepared');
    if (sharedComposioPrepared.kind !== 'prepared') throw new Error('Expected genuine shared Composio preparation.');
    const sharedComposioOwned = await service.commitPreparedChatMessageAdmission(sharedComposioPrepared.admission);
    const sharedComposioPayload = service.readOwnedAcceptedChatMessageData(sharedComposioOwned, base).payload;
    assert(sharedComposioPayload.extensionSelection);
    const sharedComposioContext = { ...base, agentTurnId: sharedComposioPayload.serverMessageId,
      turnExtensions: sharedComposioPayload.extensionSelection.publicSelection };
    const sharedComposioPackages = await runtime.getAuthorizedAgentWorkflowPackageSelections(sharedComposioContext);
    const originalIntake = await intake.prepareAcceptedTurnExtensionSelection({ ...base, agentTurnId: randomUUID() },
      { version: 1, origin: 'turn_reference', selections: [selection.selections[0]] });

    stage = 'fresh SQL provenance after actual receipt expiry';
    Date.now = () => originalNow() + 6 * 60_000;
    assert.throws(() => receipts.readPersonalComposioAccountReference(selected.accountSelectionRef), { code: 'binding_changed' });
    const callsAtRecovery = composio.calls.length, intakeAtRecovery = intakeCalls;
    forbidIntake = true; forbidProviderReads = true;
    const emptyFresh = await service.readOwnedAcceptedChatMessage({ ...identity, clientMessageId: 'no-explicit-extensions' }); assert(emptyFresh);
    assert.equal(await turn.reissueOwnedChatMessageRuntimeSelection(emptyContext, emptyFresh, { packageSelection: emptyPackages }), null);
    stage = 'null selection rejects a receipt change during its final actor read';
    let emptyReceiptReads = 0, changedDuringFinalActor = false;
    fixture.setAfterRead(async (query, params) => {
      if (query.includes('FROM pi_message_delivery_receipts') && params.includes('no-explicit-extensions')) {
        emptyReceiptReads++; return;
      }
      if (changedDuringFinalActor || emptyReceiptReads !== 2 || !/FROM\s+canvas_workspaces/iu.test(query)) return;
      changedDuringFinalActor = true;
      const changed = await sql(database => database.run(`UPDATE pi_message_delivery_receipts
        SET execution_phase='running',execution_revision=2 WHERE client_message_id='no-explicit-extensions'
        AND pi_session_db_id=(SELECT id FROM pi_sessions WHERE session_id=$1)`, [sessionId])) as { changes: number };
      assert.equal(changed.changes, 1, 'The receipt change occurs during the actual final actor await.');
    });
    try {
      await assert.rejects(turn.reissueOwnedChatMessageRuntimeSelection(emptyContext, emptyFresh, { packageSelection: emptyPackages }), denied);
      assert(changedDuringFinalActor, 'The real SQL mutation must not happen before the reissue call.');
      assert(emptyReceiptReads >= 3, 'A final genuine receipt read must follow the last actor await.');
    } finally {
      fixture.setAfterRead(undefined);
      await sql(database => database.run(`UPDATE pi_message_delivery_receipts SET execution_phase='queued',execution_revision=1
        WHERE client_message_id='no-explicit-extensions' AND pi_session_db_id=(SELECT id FROM pi_sessions WHERE session_id=$1)`, [sessionId]));
    }
    stage = 'fresh SQL provenance after actual receipt expiry';
    const fresh = await service.readOwnedAcceptedChatMessage(identity); assert(fresh);
    assert.notEqual(fresh, owned, 'Recovery uses a newly issued actual SQL handle.');
    const reissue = (handle: OwnedAcceptedChatMessage = fresh, activeContext = context, packageSelection = sourcePackages) =>
      turn.reissueOwnedChatMessageRuntimeSelection(activeContext, handle, { packageSelection });
    const issued = await reissue(); assert(issued);
    const held = { ...context, turnExtensionSource: issued };
    const bound = turn.readAcceptedTurnRuntimeSelection(issued, held, sourcePackages);
    assert.deepEqual(bound.publicSelection, stored.extensionSelection.publicSelection);
    assert.equal(bound.privateFixedBindings.length, 2);
    const mcpBinding = bound.privateFixedBindings.find(value => value.entry.target.source === 'mcp')!.entry.target;
    const accountBinding = bound.privateFixedBindings.find(value => value.entry.target.source === 'composio')!.entry.target;
    assert(mcpBinding.kind === 'personal' && mcpBinding.personalBinding.source === 'mcp');
    assert.equal(mcpBinding.personalBinding.connectionId, connectionId);
    assert(accountBinding.kind === 'personal' && accountBinding.personalBinding.source === 'composio');
    assert.equal(accountBinding.personalBinding.connectedAccountId, account.accountId);
    assert.notEqual(accountBinding.personalBinding.connectedAccountId, 'reissue-account-a');
    assert(await reissue(owned), 'The original genuine commit-owned handle also rechecks its SQL row.');
    assert.equal(intakeCalls, intakeAtRecovery); assert.equal(composio.calls.length, callsAtRecovery);

    stage = 'shared MCP current Use metadata independent of its SQL binding revision';
    const sharedFresh = await service.readOwnedAcceptedChatMessage({ ...identity, clientMessageId: 'shared-source' }); assert(sharedFresh);
    const reissueShared = () => turn.reissueOwnedChatMessageRuntimeSelection(sharedContext, sharedFresh, { packageSelection: sharedPackages });
    assert(await reissueShared());
    const managementAuthority = await connectionStore.authorizeIntegrationConnection(sharedActor, shared.resource.connectionRef, 'manage');
    const sharedScope = sharedMcp.sharedMcpScope(managementAuthority);
    const sharedConfig = await mcp.readMcpConfig(sharedScope);
    const assertUnchangedSharedSql = async () => {
      const currentShared = await connectionStore.getIntegrationConnectionRecord(shared.resource.connectionRef); assert(currentShared);
      assert.equal(currentShared.resource.bindingRevision, shared.resource.bindingRevision,
        'This local source mutation must not be rejected merely by the old SQL binding-revision fence.');
    };
    await mcp.writeMcpConfigRaw(JSON.stringify({ ...sharedConfig, mcpServers: { connection: {
      ...sharedConfig.mcpServers.connection, enabled: false } } }), sharedScope);
    try { await assertUnchangedSharedSql(); await assert.rejects(reissueShared(), denied); }
    finally { await mcp.writeMcpConfigRaw(JSON.stringify(sharedConfig), sharedScope); }
    assert(await reissueShared());
    await definitions.setMcpServerDefinitionEnabled(organizationId, sharedDefinition.id, false);
    try { await assertUnchangedSharedSql(); await assert.rejects(reissueShared(), denied); }
    finally { await definitions.setMcpServerDefinitionEnabled(organizationId, sharedDefinition.id, true); }
    assert(await reissueShared());
    const publication = await mcpStorage.readMcpTextFileIfExists('published-binding.json', sharedScope); assert(publication.content);
    await sharedPublication.stageSharedMcpBindingPublication(managementAuthority);
    try {
      await assertUnchangedSharedSql();
      const staged = await mcpStorage.readMcpTextFileIfExists('published-binding.json', sharedScope);
      assert.notEqual(staged.content, publication.content);
      await assert.rejects(reissueShared(), denied);
    } finally { await mcpStorage.writeMcpTextFileAtomic('published-binding.json', publication.content, sharedScope); }
    assert(await reissueShared());
    stage = 'Shared Use revocation during the second genuine package fence';
    let sharedReceiptReads = 0, secondPackageEntered = false, sharedUseRevoked = false;
    fixture.setAfterQuery(async query => {
      if (sharedReceiptReads === 2 && query.trim() === 'BEGIN ISOLATION LEVEL SERIALIZABLE') secondPackageEntered = true;
    });
    fixture.setAfterRead(async (query, params) => {
      if (query.includes('FROM pi_message_delivery_receipts') && params.includes('shared-source')) {
        sharedReceiptReads++; return;
      }
      if (sharedUseRevoked || !secondPackageEntered || sharedReceiptReads !== 2
        || query.trim() !== 'SELECT txid_current()::text AS transaction_id') return;
      sharedUseRevoked = true;
      // PGlite deterministically schedules a real source ACL mutation on its
      // genuine package transaction; this is not a native concurrency claim.
      const changed = await sql(database => database.run(`UPDATE integration_connection_grants SET can_use=0
        WHERE connection_ref=$1 AND target_type='user' AND target_id=$2`, [shared.resource.connectionRef, alice.userId])) as { changes: number };
      assert.equal(changed.changes, 1);
    });
    try {
      await assert.rejects(reissueShared(), { code: 'CONNECTION_ACCESS_DENIED', status: 403 });
      assert(secondPackageEntered && sharedUseRevoked, 'The real ACL mutation must happen inside the second package fence after the second SQL receipt read.');
      assert.equal((await sql(database => database.get(`SELECT can_use FROM integration_connection_grants
        WHERE connection_ref=$1 AND target_type='user' AND target_id=$2`, [shared.resource.connectionRef, alice.userId])) as { can_use: number }).can_use, 0);
    } finally {
      fixture.setAfterQuery(undefined); fixture.setAfterRead(undefined);
      await sql(database => database.run(`UPDATE integration_connection_grants SET can_use=1
        WHERE connection_ref=$1 AND target_type='user' AND target_id=$2`, [shared.resource.connectionRef, alice.userId]));
    }
    assert(await reissueShared(), 'An actual grant restore must succeed after the isolated late revocation.');

    stage = 'Shared Composio actual SQL profile mode/status drift';
    const sharedComposioFresh = await service.readOwnedAcceptedChatMessage({ ...identity, clientMessageId: 'shared-composio-source' }); assert(sharedComposioFresh);
    const reissueSharedComposio = () => turn.reissueOwnedChatMessageRuntimeSelection(sharedComposioContext, sharedComposioFresh,
      { packageSelection: sharedComposioPackages });
    assert(await reissueSharedComposio());
    await assert.rejects(sharedProfiles.mutateSharedComposioProfile({ actor: sharedActor, profileId: sharedProfile.id,
      expectedProfileRevision: sharedProfile.profileRevision, status: 'archived' }), { code: 'profile_in_use', status: 409 });
    // Public owner archive is blocked above. These are explicit genuine SQL
    // drift injections, not a claim that the public archive API allowed it.
    for (const [mode, status] of [['managed', 'active'], ['local', 'archived']]) {
      await sql(database => database.run('UPDATE composio_connection_profiles SET provider_mode=$1,status=$2 WHERE id=$3',
        [mode, status, sharedProfile.id]));
      try {
        const currentShared = await connectionStore.getIntegrationConnectionRecord(sharedComposio.resource.connectionRef); assert(currentShared);
        assert.equal(currentShared.resource.bindingRevision, sharedComposio.resource.bindingRevision);
        await assert.rejects(reissueSharedComposio(), { code: 'binding_changed', status: 409 });
      } finally {
        await sql(database => database.run("UPDATE composio_connection_profiles SET provider_mode='local',status='active' WHERE id=$1", [sharedProfile.id]));
      }
      assert(await reissueSharedComposio(), 'Restoring the actual profile must recover source metadata without provider calls.');
    }

    stage = 'forged provenance and exact turn/scope fences';
    for (const invalid of [{ kind: 'owned_accepted_chat_message' }, { ...fresh }, structuredClone(fresh), prepared.admission,
      originalIntake, stored, stored.extensionSelection, structuredClone(stored.extensionSelection)]) {
      await assert.rejects(reissue(invalid as OwnedAcceptedChatMessage), denied);
    }
    for (const foreign of [
      { userId: owner.userId }, { sessionId: `foreign-${randomUUID()}` }, { agentId: 'bradley' }, { workspaceId: owner.workspaceId! },
      { organizationId: 'foreign-org' }, { agentTurnId: randomUUID() }, { agentTurnId: undefined }, { turnExtensions: undefined },
      { turnExtensions: { ...context.turnExtensions!, selections: [] } },
    ]) await assert.rejects(reissue(fresh, { ...context, ...foreign }), denied);
    assert.throws(() => turn.readAcceptedTurnRuntimeSelection(structuredClone(issued), held, sourcePackages), denied);

    stage = 'exact held pin survives a genuinely published newer HEAD';
    const current = await packages.inspectCapabilityPackage(owner, pin.resourceRef);
    let draft = await packages.createCapabilityPackageDraftAction(owner, { operation: 'edit', resourceRef: pin.resourceRef,
      expectedMetadataRevision: current.resource.metadataRevision, expectedGrantsRevision: current.resource.grantsRevision,
      expectedPackageRevision: current.state!.packageRevision, expectedPublishedRevisionRef: current.state!.currentPublishedRevisionRef });
    const write = await packages.writeCapabilityPackageDraftFileAction(owner, draft.draftRef, { expectedDraftRevision: draft.draftRevision,
      path: 'skills/held-source/SKILL.md', encoding: 'base64', content: Buffer.from(skill('New immutable source version two.')).toString('base64') });
    draft = write.draft;
    const newer = await packages.publishCapabilityPackageDraftAction(owner, { draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision,
      expectedMetadataRevision: current.resource.metadataRevision, expectedGrantsRevision: current.resource.grantsRevision,
      expectedPackageRevision: current.state!.packageRevision, expectedPublishedRevisionRef: current.state!.currentPublishedRevisionRef });
    assert.notEqual(newer.published.revisionRef, pin.publishedRevisionRef);
    const afterHead = await reissue(); assert(afterHead);
    const restored = await effective.resolveEffectiveExtensionContext({ ...context, turnExtensionSource: afterHead }, { packageSelection: sourcePackages });
    const metadata = effective.readEffectiveExtensionContext(restored)!;
    const heldPackage = metadata.packages.find(value => value.resourceRef === pin.resourceRef); assert(heldPackage);
    assert.equal(heldPackage.publishedRevisionRef, pin.publishedRevisionRef); assert.equal(heldPackage.checksum, pin.checksum);
    const heldSkill = heldPackage.skills.find(value => value.name === 'held-source'); assert(heldSkill);
    assert.match(await fs.readFile(heldSkill.runtimePath, 'utf8'), /Original immutable source version one/u);

    stage = 'fresh source/actor revocation against genuine prior package proof';
    await mcp.writeMcpConfigRaw(JSON.stringify({ ...mcpConfig, mcpServers: { ...mcpConfig.mcpServers,
      [mcpName]: { ...mcpConfig.mcpServers[mcpName], enabled: false } } }), { userId: alice.userId });
    try { await assert.rejects(reissue(), denied); }
    finally { await mcp.writeMcpConfigRaw(JSON.stringify(mcpConfig), { userId: alice.userId }); }
    assert(await reissue());
    await sql(database => database.run('UPDATE "user" SET banned=1 WHERE id=$1', [alice.userId]));
    try { await assert.rejects(reissue(), denied); }
    finally { await sql(database => database.run('UPDATE "user" SET banned=0 WHERE id=$1', [alice.userId])); }
    await sql(database => database.run("UPDATE pi_sessions SET archived_at=1 WHERE session_id=$1", [sessionId]));
    try { await assert.rejects(reissue(), denied); }
    finally { await sql(database => database.run('UPDATE pi_sessions SET archived_at=NULL WHERE session_id=$1', [sessionId])); }
    await sql(database => database.run("UPDATE canvas_workspaces SET status='archived' WHERE id=$1", [alice.workspaceId]));
    try { await assert.rejects(reissue(), denied); }
    finally { await sql(database => database.run("UPDATE canvas_workspaces SET status='active' WHERE id=$1", [alice.workspaceId])); }

    stage = 'current package policy and Use grant';
    const permissionState = await permissionService.readOrganizationPermissionForUser(owner.userId);
    assert(permissionState.permission);
    const policy = await policies.setOrganizationCapabilityPolicy({ organizationId, actorUserId: owner.userId, permission: permissionState.permission,
      resourceType: 'plugin', resourceId: descriptor.sourceStamp.resourceId, targetType: 'user', targetId: alice.userId, effect: 'blocked' });
    try { await assert.rejects(reissue(), denied); }
    finally { await policies.removeOrganizationCapabilityPolicy({ organizationId, actorUserId: owner.userId, permission: permissionState.permission,
      policyId: policy.id, expectedRevision: policy.revision }); }
    const latest = await packages.inspectCapabilityPackage(owner, pin.resourceRef);
    const revoked = await resourceStore.mutateCapabilityResource(owner, pin.resourceRef, { expectedMetadataRevision: latest.resource.metadataRevision,
      expectedGrantsRevision: latest.resource.grantsRevision, grants: [{ targetType: 'user', targetId: owner.userId, canUse: true, canEdit: false, canManage: false }] });
    try { await assert.rejects(reissue(), denied); }
    finally { await resourceStore.mutateCapabilityResource(owner, pin.resourceRef, { expectedMetadataRevision: revoked.metadata.metadataRevision,
      expectedGrantsRevision: revoked.metadata.grantsRevision, grants: [owner, alice].map(value => ({ targetType: 'user', targetId: value.userId,
        canUse: true, canEdit: false, canManage: false })) }); }
    const agentInspect = await management.inspectManagedAgent(actor, agent.agent.agentId);
    const removed = await management.removeManagedAgentGrant({ actor, agentId: agent.agent.agentId, expectedRevision: agentInspect.agent.revision,
      targetType: 'user', targetId: alice.userId });
    try { await assert.rejects(reissue(), denied); }
    finally { await management.setManagedAgentGrant({ actor, agentId: agent.agent.agentId, expectedRevision: removed.agent.revision,
      targetType: 'user', targetId: alice.userId, canUse: true, canEdit: false, canManage: false }); }

    stage = 'independent stale phase/revision handles and fresh source-only provenance';
    const currentPackages = await runtime.getAuthorizedAgentWorkflowPackageSelections(context);
    assert(await reissue(fresh, context, currentPackages), 'Restored grants and fresh package proof must succeed before isolated receipt mutations.');
    const mutateExecution = (phase: string, revision: number) => sql(database => database.run(`UPDATE pi_message_delivery_receipts
      SET execution_phase=$1,execution_revision=$2 WHERE client_message_id=$3
      AND pi_session_db_id=(SELECT id FROM pi_sessions WHERE session_id=$4)`, [phase, revision, identity.clientMessageId, sessionId]));
    await mutateExecution('running', 1);
    await assert.rejects(reissue(fresh, context, currentPackages), denied);
    await mutateExecution('queued', 1);
    assert(await reissue(fresh, context, currentPackages));
    await mutateExecution('queued', 2);
    await assert.rejects(reissue(fresh, context, currentPackages), denied);
    await mutateExecution('running', 2);
    const currentOwned = await service.readOwnedAcceptedChatMessage(identity); assert(currentOwned);
    assert(await reissue(currentOwned, context, currentPackages), 'Fresh provenance at the current phase is source metadata, not an execution claim.');
    await profiles.archiveComposioProfile({ ownerUserId: alice.userId, profileId: profile.id });
    await assert.rejects(reissue(currentOwned, context, currentPackages), denied);
    assert.equal(intakeCalls, intakeAtRecovery); assert.equal(composio.calls.length, callsAtRecovery);
    assert.equal(fixture.providerRequests(), 0);
    assert.equal((await sql(database => database.all('SELECT id FROM pi_messages WHERE pi_session_db_id=(SELECT id FROM pi_sessions WHERE session_id=$1)', [sessionId]))).length, 0);
    console.log('PASS durable message runtime source (actual PGlite): fresh owned SQL after receipt expiry, exact Plugin/MCP/Composio account, no intake/probe renewal, forged provenance/scope/stale-revision rejection, old pin across new HEAD, fresh actor/source/policy/Use revocation, unchanged-SQL shared MCP disabled/definition/publication rejection, late null-selection receipt race and second-package-fence Shared Use revocation, unchanged-binding Shared Composio SQL profile drift; metadata only, no queue/runtime execution or restart claim.');
  } catch (error) { console.error(`Durable runtime source stage: ${stage}`); throw error; }
  finally {
    Date.now = originalNow; fixture.setAfterQuery(undefined); fixture.setAfterRead(undefined); loader._load = originalLoad;
    try { await composio?.close(); }
    finally {
      try { await fixture.close(); }
      finally { for (const [key, value] of previousEnv) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
