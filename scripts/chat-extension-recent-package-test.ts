import assert from 'node:assert/strict';
import Module from 'node:module';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import { nativeExtensionPluginFiles, createNativeExtensionWorkflow } from './helpers/chat-extension-native-fixture';
import type { AgentExtensionPackageVersionSource } from '../app/lib/agents/extension-package-options';
import type { ChatBodyV1 } from '../app/lib/chat/chat-body-contracts';
import type { ChatExtensionOptionsResponse } from '../app/lib/chat/extension-options-contracts';
import type { McpServerConfig } from '../app/lib/mcp/config';
import type { SqlConnection } from '../app/lib/db';

/** Actual package bytes, ACLs, configuration, Scope/Template and Search/Recent readers.
 * Only owned SQL transport, encrypted OAuth metadata and an accepted-receipt DB
 * fixture are supplied here. This is not an OAuth, Admission or Send acceptance. */
async function main() {
  const app = await createCapabilityPackageStoreApplicationFixture();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load, originalNow = Date.now;
  let sourceReads = 0, afterIcon: (() => Promise<void>) | undefined;
  const wrappers = new WeakMap<object, object>();
  loader._load = (name, parent, main) => {
    const exports = originalLoad(name, parent, main);
    if (!exports || typeof exports !== 'object') return exports;
    const value = exports as Record<string, unknown>;
    if (typeof value.readAgentExtensionPackageVersion !== 'function' && typeof value.presentChatExtensionIcon !== 'function') return exports;
    const existing = wrappers.get(value); if (existing) return existing;
    const wrapped = new Proxy(value, { get(target, key, receiver) {
      const real = Reflect.get(target, key, receiver);
      if (key === 'readAgentExtensionPackageVersion') return async (...args: unknown[]) => {
        sourceReads++; return (real as (...input: unknown[]) => Promise<AgentExtensionPackageVersionSource>)(...args);
      };
      if (key === 'presentChatExtensionIcon') return async (...args: unknown[]) => {
        const result = await (real as (...input: unknown[]) => Promise<unknown>)(...args);
        if (afterIcon) { const action = afterIcon; afterIcon = undefined; await action(); }
        return result;
      };
      return real;
    } });
    wrappers.set(value, wrapped); return wrapped;
  };
  const sql = async <T>(operation: (database: SqlConnection) => T | Promise<T>): Promise<T> => {
    const database = await app.database.openDb(); try { return await operation(database); } finally { await database.close(); }
  };
  try {
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const activation = await import('../app/lib/capabilities/packages/activation');
    const management = await import('../app/lib/agents/management-actions');
    const contexts = await import('../app/lib/chat/extension-options-context');
    const reader = await import('../app/lib/chat/extension-options');
    const recentReader = await import('../app/lib/chat/extension-options-recents');
    const { parseChatBody, deriveChatBodySelection } = await import('../app/lib/chat/chat-body-contracts');
    const readiness = await import('../app/lib/chat/extension-options-package-readiness');
    const sourceApi = await import('../app/lib/agents/extension-package-options');
    const mcp = await import('../app/lib/mcp/config');
    const definitions = await import('../app/lib/mcp/server-definitions');
    const personal = await import('../app/lib/mcp/personal-connections');
    const credentials = await import('../app/lib/mcp/credential-storage');
    const lifecycle = await import('../app/lib/mcp/oauth-lifecycle');
    const identity = await import('../app/lib/mcp/connection-identity');
    const oauth = await import('../app/lib/mcp/oauth');
    const schema = (await import('../app/lib/chat/extension-options-contracts')).chatExtensionOptionsRequestSchema;
    const name = 'native-recent-package-regression', connector = 'native-recent-mcp', childRoot = 'skills/native-recent-child';
    const configuration = { url: 'https://203.0.113.74/owned-reader/mcp', auth: 'oauth', transport: 'http' };
    const files = nativeExtensionPluginFiles({ name, childRoot, connector, mcpConfiguration: configuration });
    const workflow = { version: 1 as const, integrationCapabilities: [...createNativeExtensionWorkflow(connector).integrationCapabilities,
      { id: 'optional-connection', application: 'optional_mcp', required: false,
        alternatives: [{ source: 'mcp' as const, connector, requiredTools: ['echo'] }] }] };
    files[`${childRoot}/agents/canvas.yaml`] = `workflow: ${JSON.stringify(workflow)}\n`;
    const archive = await app.registry.addPackage('application', 'plugin', name, '1.0.0', files, plugins.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(app.owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: name, version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'user' },
      grants: [{ targetType: 'user', targetId: app.alice.userId, canUse: true, canEdit: false, canManage: false }] });
    const inspected = await packages.inspectCapabilityPackage(app.owner, installed.resource.resourceRef);
    await activation.setCapabilityPackageDefaultActivationAction(app.owner, installed.resource.resourceRef, {
      expectedMetadataRevision: inspected.resource.metadataRevision, expectedGrantsRevision: inspected.resource.grantsRevision,
      expectedPackageRevision: inspected.state!.packageRevision, expectedPublishedRevisionRef: installed.published.revisionRef,
      expectedDefaultEnabled: false, enabled: true });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const definition = await definitions.publishMcpServerDefinition(app.organizationId, 'Owned recent MCP', { ...configuration, enabled: true });
    const connection = await personal.createPersonalMcpConnection(app.owner.userId, definition.id, 'Owned exact package reader');
    const solo = await personal.createPersonalMcpConnection(app.owner.userId, definition.id, 'Owned solo reader');
    const owner = { ...app.owner, source: 'api' as const };
    const credentialScope = { userId: owner.userId, organizationId: app.organizationId };
    const seedCredential = async (entry: typeof connection, userId = owner.userId) => {
      const config = mcp.parseAndValidateMcpConfig((await mcp.readMcpConfigState({ userId })).rawContent).mcpServers[entry.server];
      const scope = credentials.resolveMcpCredentialScope(config as McpServerConfig & { connectionId: string }, { userId });
      const generation = await lifecycle.readMcpOAuthLifecycle(entry.connectionId, scope);
      await credentials.writeMcpCredentialJson(`connections/${entry.connectionId}/tokens.json`, { connectionId: entry.connectionId,
        authVersion: config.authVersion || 1, lifecycleGeneration: generation.generation, serverName: entry.server, serverUrl: config.url,
        issuer: 'https://203.0.113.74', resource: config.url, configHash: identity.hashMcpAuthConfig(config), clientId: 'synthetic-owned-reader',
        tokenType: 'Bearer', accessToken: 'synthetic-reader-only', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), updatedAt: new Date().toISOString() }, scope);
      assert.equal((await oauth.getMcpOAuthStatus(entry.server, undefined, scope)).authorized, true);
    };
    await seedCredential(connection); await seedCredential(solo);
    const agent = await management.createManagedAgent(owner, { name: 'Owned exact MRU reader', scopeType: 'user', enabledTools: ['read', 'mcp'],
      extensions: { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' } });
    const target = { kind: 'draft_turn' as const, agentId: agent.agent.agentId, workspaceId: owner.workspaceId! };
    const context = await contexts.resolveChatExtensionOptionsContext(owner, target);
    assert.equal(context.snapshot.workflowVersion, null, 'The original native fixture also uses a legacy workflow snapshot.');
    const body = parseChatBody({ version: 1, parts: [{ type: 'extension_reference', occurrenceId: 'one', bundleId: 'plugin' },
      { type: 'extension_reference', occurrenceId: 'two', bundleId: 'solo' }], bundles: [
      { id: 'plugin', caption: name, primary: { selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: null },
        supporting: [{ selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${connection.connectionId}` } }, requirement: 'optional', toolCap: null }],
        packageConnections: [{ package: pin, declarationPath: `${childRoot}/agents/canvas.yaml`, capabilityId: 'native-connection',
          alternativeKey: `mcp:${connector}`, connectionSelection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${connection.connectionId}` } } }] },
      { id: 'solo', caption: 'Owned solo reader', primary: { selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${solo.connectionId}` } },
        requirement: 'optional', toolCap: null }, supporting: [], packageConnections: [] }] });
    const session = 'owned-recent-package-session', clientMessageId = 'owned-synthetic-recent-receipt';
    const row = await sql(database => database.get(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,created_at,updated_at,
      organization_id,workspace_id,workspace_type,workspace_name,workspace_root_relative_path)
      VALUES($1,$2,$3,'fixture','fixture',$4,$4,$5,$6,'personal','Owner',$6) RETURNING id`,
    [session, owner.userId, agent.agent.agentId, Date.now(), app.organizationId, owner.workspaceId])) as { id: number };
    const payloadFor = (value: ChatBodyV1) => JSON.stringify({ identity: { userId: owner.userId, workspaceId: owner.workspaceId,
      agentId: agent.agent.agentId, sessionId: session }, body: value, extensionSelection: { publicSelection: deriveChatBodySelection(value) } });
    await sql(database => database.run(`INSERT INTO pi_message_delivery_receipts(pi_session_db_id,client_message_id,payload_hash,runtime_token,state,
      created_at,updated_at,payload_version,private_payload,execution_phase,execution_revision)
      VALUES($1,$2,'fixture','unclaimed','accepted',$3,$3,1,$4,'succeeded',1)`, [row.id, clientMessageId, Date.now(), payloadFor(body)]));
    const writeBody = async (value: ChatBodyV1) => sql(database => database.run('UPDATE pi_message_delivery_receipts SET private_payload=$1 WHERE client_message_id=$2',
      [payloadFor(parseChatBody(value)), clientMessageId]));
    const local = async () => {
      const value = await reader.listChatExtensionOptions(owner, { operation: 'search', target, phase: 'local', q: '', limit: 50 });
      assert(value.operation === 'search'); return value;
    };
    const pluginRecent = (result: Extract<ChatExtensionOptionsResponse, { operation: 'search' }>) => result.recents.find(recent => recent.bodyBundle.id === 'plugin');
    const assertReady = (result: Extract<ChatExtensionOptionsResponse, { operation: 'search' }>) => {
      assert.equal(pluginRecent(result)?.chatAvailability, 'ready', 'An exact revalidated Plugin Recent must remain usable while the descriptor cache is cold/expired.');
      const exact = result.items.find(item => JSON.stringify(item.selection) === JSON.stringify(body.bundles[0]!.primary.selection));
      assert(exact); assert.equal(exact.chatAvailability, 'ready', 'The same complete default selection must agree, without overriding an eligibility denial.');
      assert.equal(result.recents.find(recent => recent.bodyBundle.id === 'solo')?.chatAvailability, 'ready');
      assert.doesNotMatch(JSON.stringify(result), /rootPath|runtimePath|accessToken|configHash|synthetic-reader-only/u);
    };
    assert.equal(readiness.getChatPackageReadinessDescriptor(pin), undefined);
    sourceReads = 0;
    assertReady(await local());
    assert.equal(sourceReads, 2, 'One initial exact package read is shared; a separate complete final read still verifies current authority and bytes.');
    const filters = schema.parse({ operation: 'search', target, phase: 'local', q: '', limit: 50 }); assert(filters.operation === 'search');
    const raw = await recentReader.readChatExtensionRecents(context, { limit: 50, cursor: null }, new AbortController().signal, filters);
    assert(raw.items.some(item => item.bodyBundle.id === 'plugin' && item.eligibility.action === 'select'));
    assertReady(await local());
    const advanced = originalNow() + 61_000; Date.now = () => advanced;
    try { assert.equal(readiness.getChatPackageReadinessDescriptor(pin), undefined); assertReady(await local()); }
    finally { Date.now = originalNow; }
    console.log('PASS actual Package Recent and complete default selection: cold, warm and expired descriptor cache; independent final Source check.');

    const missing = structuredClone(body); missing.bundles[0]!.supporting = []; missing.bundles[0]!.packageConnections = [];
    await writeBody(missing); assert.equal(pluginRecent(await local()), undefined); await writeBody(body);
    const capped = structuredClone(body); capped.bundles[0]!.supporting[0]!.toolCap = [];
    await writeBody(capped); assert.equal(pluginRecent(await local()), undefined); await writeBody(body);
    const primaryCapped = structuredClone(body); primaryCapped.bundles[0]!.primary.toolCap = [];
    await writeBody(primaryCapped); assert.equal(pluginRecent(await local()), undefined); await writeBody(body);
    const badRoot = structuredClone(body); const selected = badRoot.bundles[0]!.primary.selection; assert(selected.kind === 'plugin');
    selected.skillSelection = { kind: 'subset', relativeRoots: ['skills/absent'] };
    await writeBody(badRoot); assert.equal(pluginRecent(await local()), undefined); await writeBody(body);
    console.log('PASS actual required mapping, selected roots, supporting cap and package cap remain mandatory.');

    const stalePin = structuredClone(body), stalePrimary = stalePin.bundles[0]!.primary.selection; assert(stalePrimary.kind === 'plugin');
    stalePrimary.package.checksum = 'f'.repeat(64); stalePin.bundles[0]!.packageConnections[0]!.package.checksum = stalePrimary.package.checksum;
    await writeBody(stalePin); assert.equal(pluginRecent(await local()), undefined); await writeBody(body);
    const subset = structuredClone(body), subsetPrimary = subset.bundles[0]!.primary.selection; assert(subsetPrimary.kind === 'plugin');
    subsetPrimary.skillSelection = { kind: 'subset', relativeRoots: [childRoot] };
    await writeBody(subset); const subsetRecent = pluginRecent(await local()); assert.equal(subsetRecent?.chatAvailability, 'ready');
    assert.deepEqual(subsetRecent?.bodyBundle.primary.selection, subsetPrimary); await writeBody(body);
    console.log('PASS exact immutable pin/checksum and selected child subset survive only their own fresh source proof.');

    const optional = structuredClone(body), optionalBundle = optional.bundles[0]!, soloEntry = optional.bundles[1]!.primary;
    assert(soloEntry.selection.kind === 'mcp'); optionalBundle.supporting.push({ ...soloEntry, selection: soloEntry.selection });
    optionalBundle.packageConnections.push({ ...optionalBundle.packageConnections[0]!, capabilityId: 'optional-connection', connectionSelection: soloEntry.selection });
    await writeBody(optional); assert.equal(pluginRecent(await local())?.chatAvailability, 'ready');
    await credentials.removeMcpCredentialJson(`connections/${solo.connectionId}/tokens.json`, credentialScope);
    const optionalUnavailable = await local(); assert.equal(pluginRecent(optionalUnavailable)?.chatAvailability, 'setup');
    assert.equal(optionalUnavailable.items.find(item => JSON.stringify(item.selection) === JSON.stringify(body.bundles[0]!.primary.selection))?.chatAvailability, 'ready',
      'An unavailable historical optional binding does not disable the default package without that optional binding.');
    await seedCredential(solo); await writeBody(body);
    console.log('PASS an exact optional binding remains required for MRU replay, while the independent default package remains usable.');

    const changeConnection = async (mutate: (value: McpServerConfig) => void) => {
      const state = await mcp.readMcpConfigState({ userId: owner.userId }), config = mcp.parseAndValidateMcpConfig(state.rawContent);
      mutate(config.mcpServers[connection.server]!);
      await mcp.writeMcpConfigRaw(JSON.stringify(config), { userId: owner.userId }, { expectedRaw: state.rawContent });
    };
    await credentials.removeMcpCredentialJson(`connections/${connection.connectionId}/tokens.json`, credentialScope);
    assert.notEqual(pluginRecent(await local())?.chatAvailability, 'ready'); await seedCredential(connection);
    await changeConnection(config => { config.url = 'https://203.0.113.75/different/mcp'; }); await seedCredential(connection);
    assert.equal(pluginRecent(await local()), undefined);
    await changeConnection(config => { config.url = configuration.url; }); await seedCredential(connection);
    await changeConnection(config => { config.enabled = false; }); assert.equal(pluginRecent(await local()), undefined);
    await changeConnection(config => { config.enabled = true; }); await seedCredential(connection);
    assertReady(await local());
    console.log('PASS actual credential loss, published-template mismatch and connection disablement cannot be promoted to ready.');

    const archiveResource = (status: 'active' | 'archived') => sql(database => database.run('UPDATE capability_resources SET status=$1 WHERE resource_ref=$2', [status, pin.resourceRef]));
    afterIcon = () => archiveResource('archived').then(() => undefined);
    assert.equal(pluginRecent(await local()), undefined, 'Source revocation after initial eligibility/icon must fail the separate final Source proof.');
    assert.equal(afterIcon, undefined); await archiveResource('active'); assertReady(await local());
    console.log('PASS source revocation during presentation is rejected by the independent fresh final phase.');

    const aliceConnection = await personal.createPersonalMcpConnection(app.alice.userId, definition.id, 'Alice exact package reader');
    await seedCredential(aliceConnection, app.alice.userId);
    const aliceAgent = await management.createManagedAgent({ ...app.alice, source: 'api' }, { name: 'Shared package ACL reader', scopeType: 'user', enabledTools: ['read', 'mcp'],
      extensions: { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' } });
    const aliceContext = await contexts.resolveChatExtensionOptionsContext({ ...app.alice, source: 'api' }, { ...target, agentId: aliceAgent.agent.agentId, workspaceId: app.alice.workspaceId! });
    const aliceSource = await sourceApi.readAgentExtensionPackageVersion(app.alice, pin, { allowPersonalPackages: true });
    assert.equal(aliceSource.metadata.checksum, pin.checksum);
    const aliceBody = structuredClone(body); aliceBody.parts = [aliceBody.parts[0]!]; aliceBody.bundles = [aliceBody.bundles[0]!];
    const aliceMcp = { kind: 'mcp' as const, source: 'mcp' as const,
      target: { kind: 'personal' as const, connectionRef: `mcp-personal:${aliceConnection.connectionId}` } };
    aliceBody.bundles[0]!.supporting[0]!.selection = aliceMcp; aliceBody.bundles[0]!.packageConnections[0]!.connectionSelection = aliceMcp;
    const aliceSession = 'owned-alice-recent-session', now = Date.now();
    const aliceRow = await sql(database => database.get(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,created_at,updated_at,
      organization_id,workspace_id,workspace_type,workspace_name,workspace_root_relative_path)
      VALUES($1,$2,$3,'fixture','fixture',$4,$4,$5,$6,'personal','Alice',$6) RETURNING id`,
    [aliceSession, app.alice.userId, aliceAgent.agent.agentId, now, app.organizationId, app.alice.workspaceId])) as { id: number };
    await sql(database => database.run(`INSERT INTO pi_message_delivery_receipts(pi_session_db_id,client_message_id,payload_hash,runtime_token,state,
      created_at,updated_at,payload_version,private_payload,execution_phase,execution_revision)
      VALUES($1,'alice-synthetic-recent','fixture','unclaimed','accepted',$2,$2,1,$3,'succeeded',1)`, [aliceRow.id, now,
      JSON.stringify({ identity: { userId: app.alice.userId, workspaceId: app.alice.workspaceId, agentId: aliceAgent.agent.agentId, sessionId: aliceSession },
        body: parseChatBody(aliceBody), extensionSelection: { publicSelection: deriveChatBodySelection(aliceBody) } })]));
    const aliceTarget = { ...target, agentId: aliceAgent.agent.agentId, workspaceId: app.alice.workspaceId! };
    const aliceFilters = schema.parse({ operation: 'search', target: aliceTarget, phase: 'local', q: '', limit: 50 }); assert(aliceFilters.operation === 'search');
    const aliceRecents = () => recentReader.readChatExtensionRecents(aliceContext, { limit: 50, cursor: null }, new AbortController().signal, aliceFilters);
    assert.equal((await aliceRecents()).items.length, 1);
    afterIcon = () => sql(database => database.run('UPDATE capability_resource_grants SET can_use=0 WHERE resource_ref=$1 AND target_id=$2',
      [pin.resourceRef, app.alice.userId])).then(() => undefined);
    assert.equal((await aliceRecents()).items.length, 0, 'The actual reader must discard a grant revoked after initial presentation.');
    assert.equal(afterIcon, undefined);
    const { chatPackageSelectionEligibility } = await import('../app/lib/chat/extension-options-eligibility');
    await assert.rejects(sourceApi.readAgentExtensionPackageVersion(app.alice, pin, { allowPersonalPackages: true }), { code: 'CAPABILITY_RESOURCE_NOT_FOUND' });
    const exactPrimary = body.bundles[0]!.primary.selection; assert(exactPrimary.kind === 'plugin');
    await assert.rejects(chatPackageSelectionEligibility(aliceContext, exactPrimary), { code: 'CAPABILITY_RESOURCE_NOT_FOUND' });
    console.log('PASS actual cross-user Package Use grant loss remains authoritative despite a warm immutable descriptor.');
    assert.equal(app.providerRequests(), 0, 'This local Search/Recent regression performs no external provider calls.');
  } finally {
    Date.now = originalNow; loader._load = originalLoad; await app.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
