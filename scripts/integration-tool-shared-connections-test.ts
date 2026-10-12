import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import type { IntegrationExecutionContext, IntegrationProviderPage, IntegrationToolPage, IntegrationToolSchema } from '../app/lib/integration-tools/contracts';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';

async function mcpFixture() {
  let origin = '';
  let requests = 0;
  const calls: string[] = [];
  const headers: string[] = [];
  let nextList: (() => Promise<void>) | null = null;
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'shared-design-fixture', version: '1' }, { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler('tools/list', async () => {
      const change = nextList; nextList = null; await change?.();
      return { tools: ['create_design', 'read_design'].map(name => ({ name, inputSchema: { type: 'object' } })) };
    });
    server.setRequestHandler('tools/call', async request => {
      calls.push(request.params.name);
      return { content: [{ type: 'text', text: 'Shared design created.' }] };
    });
    return server;
  }, { legacy: 'reject' });
  const server = http.createServer(async (request, response) => {
    requests += 1;
    headers.push(String(request.headers.authorization || ''));
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = await handler.fetch(new Request(`${origin}${request.url}`, { method: request.method,
      headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      ...(chunks.length ? { body: Buffer.concat(chunks).toString('utf8') } : {}) }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body) for await (const chunk of result.body) response.write(Buffer.from(chunk));
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url: `${origin}/mcp`, calls, headers, requests: () => requests,
    onList: (change: () => Promise<void>) => { nextList = change; },
    close: async () => { await handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function main() {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-shared-gateway-'));
  const provider = await createComposioProviderFixture();
  const mcp = await mcpFixture();
  const environment = { DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, COMPOSIO_BASE_URL: provider.baseUrl,
    CANVAS_INSTANCE_ID: 'shared-fixture', CANVAS_ORGANIZATION_ID: 'shared-org', CANVAS_DEPLOYMENT_MODE: 'team',
    CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_MANAGED_SERVICES_ENABLED: 'false',
    MCP_ALLOW_INSECURE_HTTP: 'true', MCP_ALLOW_PRIVATE_NETWORK: 'true', MCP_ALLOW_STDIO: 'false',
    INTEGRATIONS_ENV_MASTER_KEY: randomUUID() + randomUUID(), BASE_URL: 'http://localhost:3000' };
  const previousEnvironment = Object.fromEntries([...Object.keys(environment), 'COMPOSIO_API_KEY'].map(key => [key, process.env[key]]));
  Object.assign(process.env, environment); delete process.env.COMPOSIO_API_KEY;
  const database = await createPiTestDatabase();
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (name, parent, isMain) => {
    if (name === 'server-only' || name === '@earendil-works/pi-agent-core' || name === '@earendil-works/pi-ai/oauth') return {};
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
      getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false,
    };
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    // External licensing boundary only. Membership, workspace, session, agent
    // and connection grants are actual PostgreSQL authority, never test doubles.
    if (name.includes('license/seat-limit')) return { assertUserSeatAccess: async ({ userId }: { userId: string }) => ({ userId, mode: 'team', organizationId: 'shared-org' }) };
    return originalLoad(name, parent, isMain);
  };
  try {
    const raw = await database.openDb();
    for (const id of ['admin', 'alice', 'bob', 'external']) {
      await raw.run('INSERT INTO "user" (id,name,email,role,email_verified,created_at,updated_at) VALUES ($1,$1,$2,\'member\',1,1,1)', [id, `${id}@example.test`]);
    }
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('shared-org','admin','team',1,1,1)");
    for (const id of ['admin', 'alice', 'bob', 'external']) {
      await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('shared-org',$1,$2,'active',1,1,1)", [id, id === 'admin' ? 'owner' : id === 'external' ? 'external' : 'member']);
      await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,'shared-org','personal',$2,$3,$2,'active',1,1)", [`personal-${id}`, id, `workspaces/personal-${id}/files`]);
    }
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('marketing-team','shared-org','team','workspaces/marketing-team/files','Marketing','active',1,1)");
    await raw.run("INSERT INTO agents (agent_id,name,type,access_policy,scope_type,organization_id,owner_user_id,enabled_tools_json,revision,created_at,updated_at) VALUES ('shared-design-agent','Designer','special','restricted','organization','shared-org','admin','[\"mcp\",\"COMPOSIO_SEARCH_TOOLS\",\"COMPOSIO_GET_TOOL_SCHEMAS\",\"composio_execute\"]',1,1,1)");
    for (const id of ['alice', 'bob', 'external']) await raw.run("INSERT INTO agent_grants (id,agent_id,organization_id,target_type,target_id,can_use,can_edit,can_manage,created_at,updated_at) VALUES ($1,'shared-design-agent','shared-org','user',$2,1,0,0,1,1)", [`agent-${id}`, id]);
    const { piSessions } = await import('../app/lib/db/schema');
    const now = new Date();
    for (const id of ['alice', 'bob', 'external']) await database.db.insert(piSessions).values({ sessionId: `session-${id}`,
      userId: id, agentId: 'shared-design-agent', workspaceId: `personal-${id}`, workspaceType: 'personal',
      organizationId: 'shared-org', provider: 'fixture', model: 'fixture', createdAt: now, updatedAt: now });
    const { resolveIntegrationExecutionContext, resolveRuntimeIntegrationExecutionContext } = await import('../app/lib/integration-tools/context');
    const executionContexts = new Map<string, AgentExecutionContext>();
    const context = async (id: string): Promise<IntegrationExecutionContext> => {
      const initial = await resolveIntegrationExecutionContext({ actorUserId: id, sessionId: `session-${id}`, policyRevision: 'shared-policy-1' });
      const resolved = await resolveRuntimeIntegrationExecutionContext({ executionContext: initial.executionContext, policyRevision: 'shared-policy-1' });
      executionContexts.set(id, { ...resolved.executionContext, agentTurnId: `shared-human-turn-${id}` });
      return resolved.integrationContext;
    };
    const alice = await context('alice'); const bob = await context('bob'); const external = await context('external');
    const admin = { userId: 'admin', workspaceId: 'personal-admin', organizationId: 'shared-org' };
    const ownership = { type: 'team' as const, organizationId: 'shared-org', workspaceId: 'marketing-team' };
    const { patchUnifiedEnvEntries } = await import('../app/lib/secrets/unified-env-store');
    await patchUnifiedEnvEntries([{ key: 'COMPOSIO_API_KEY', value: 'shared-org-provider-key' }], { secretScope: 'organization', organizationId: 'shared-org' });
    const { createSharedComposioProfile } = await import('../app/lib/composio/composio-shared-profiles');
    const profile = await createSharedComposioProfile({ actor: admin, ownership, name: 'Marketing accounts', providerMode: 'local' });
    provider.accounts.set(profile.composioUserId, [
      { id: 'unselected-canva-account', toolkit: 'canva', status: 'ACTIVE' },
      { id: 'approved-canva-account', toolkit: 'canva', status: 'ACTIVE' },
      { id: 'private-slack-account', toolkit: 'slack', status: 'ACTIVE' },
    ]);
    const store = await import('../app/lib/integration-tools/connections/store');
    const userGrant = (names: string[]) => ({ targetType: 'user' as const, targetId: 'alice', canUse: true, canManage: false, allowedToolNames: names });
    const connection = await store.createSharedIntegrationConnection(admin, { ownership, displayName: 'Canva Marketing',
      allowedToolNames: ['DESIGN_CREATE', 'ASSET_LOOKUP'], grants: [userGrant(['DESIGN_CREATE'])],
      backend: { source: 'composio', profileId: profile.id, toolkit: 'canva', mode: 'local', accountBinding: 'account', connectedAccountId: 'approved-canva-account' } });
    const { IntegrationDispatcher } = await import('../app/lib/integration-tools/dispatcher');
    const { UNRESTRICTED_INTEGRATION_POLICY: policy } = await import('../app/lib/integration-tools/policy');
    const proofs = await import('../app/lib/integration-tools/connections/provider-authorization');
    const dispatcher = new IntegrationDispatcher();
    const invoke = (request: unknown, ctx = alice, beforeToolCall?: () => Promise<void>) => dispatcher.execute({ context: ctx, policy, request, toolCallId: 'shared-fixture', beforeToolCall });
    const providerRef = proofs.createSharedIntegrationProviderRef(connection.resource);
    const pages = await invoke({ action: 'search', target: 'providers', query: 'Canva Marketing' }) as IntegrationProviderPage;
    assert.equal(pages.providers.length, 1);
    const selected = pages.providers[0];
    assert.equal(selected.scope.type, 'workspace');
    assert.equal(selected.canExecute, true, 'Explicit user grant works in a personal workspace outside the owning team.');
    const dto = JSON.stringify(pages);
    for (const privateValue of [profile.composioUserId, profile.id, 'approved-canva-account', 'private-slack-account', 'shared-org-provider-key']) assert(!dto.includes(privateValue));
    const { isIntegrationProviderVisible } = await import('../app/lib/integration-tools/policy');
    assert.equal(isIntegrationProviderVisible(alice, policy, selected), true);
    assert.equal(isIntegrationProviderVisible(alice, policy, structuredClone(selected)), false, 'A serialized descriptor is not a grant.');
    const { integrationConnectionActorFromContext } = await import('../app/lib/integration-tools/connections/contracts');
    const forged = structuredClone(await store.authorizeIntegrationConnection(integrationConnectionActorFromContext(alice), connection.resource.connectionRef, 'inspect'));
    await assert.rejects(() => proofs.attachIntegrationProviderAuthorization(alice, structuredClone(selected), forged), { code: 'provider_denied' });
    const list = await invoke({ action: 'list', target: 'tools', providerRef }) as IntegrationToolPage;
    assert.deepEqual(list.tools.map(tool => tool.name), ['DESIGN_CREATE']);
    const schema = await invoke({ action: 'describe', toolRef: list.tools[0].toolRef }) as IntegrationToolSchema;
    const posts = () => provider.calls.filter(call => call.path.includes('/tools/execute/'));
    await invoke({ action: 'call', toolRef: schema.toolRef, schemaRef: schema.schemaRef, arguments: { title: 'Shared design' } });
    assert.equal(posts().length, 1);
    assert.equal(posts()[0].body.connected_account_id, 'approved-canva-account', 'Exactly selected account wins among multiple active accounts.');
    assert.equal(posts()[0].body.user_id, profile.composioUserId);
    assert.equal(posts()[0].apiKey, 'shared-org-provider-key');
    const handoff = await dispatcher.exportDelegatedComposioSchema({ context: alice, policy,
      selection: { toolRef: schema.toolRef, schemaRef: schema.schemaRef } });
    const beforeBob = provider.calls.length;
    await assert.rejects(() => invoke({ action: 'list', target: 'tools', providerRef }, bob), { code: 'provider_denied' });
    assert.equal(provider.calls.length, beforeBob, 'No-grant access is rejected before any provider discovery.');
    await assert.rejects(() => invoke({ action: 'list', target: 'tools', providerRef }, { ...alice, organizationId: 'foreign-org' }), { code: 'provider_denied' });
    assert.equal(provider.calls.length, beforeBob);
    const manager = { ...alice, actorUserId: 'admin', workspaceId: 'personal-admin', agentId: null, sessionId: null };
    await assert.rejects(() => invoke({ action: 'list', target: 'tools', providerRef }, manager), { code: 'provider_denied' });
    assert.equal(provider.calls.length, beforeBob, 'Management does not grant schema/tool access.');
    for (const [restriction, code] of [
      [{ allowedApplications: ['slack'] }, 'provider_denied'],
      [{ allowedProviderRefs: [] }, 'provider_denied'],
      [{ allowedToolNames: ['OTHER_APP_ACTION'] }, 'tool_denied'],
    ] as const) {
      const restrictedPolicy = { ...policy, ...restriction };
      if (code === 'provider_denied') for (const request of [
        { action: 'list', target: 'providers', source: 'composio' },
        { action: 'search', target: 'providers', source: 'composio', query: 'Canva Marketing' },
      ]) {
        const hidden = await dispatcher.execute({ context: alice, policy: restrictedPolicy, request,
          toolCallId: 'policy-excluded-catalog' }) as IntegrationProviderPage;
        assert.equal(hidden.providers.length, 0);
        assert.equal(hidden.complete, true);
      }
      for (const request of [
        { action: 'list', target: 'tools', providerRef },
        { action: 'search', target: 'tools', providerRef, query: 'design' },
        { action: 'describe', toolRef: schema.toolRef },
        { action: 'call', toolRef: schema.toolRef, schemaRef: schema.schemaRef, arguments: { title: 'Blocked by policy' } },
      ]) await assert.rejects(() => dispatcher.execute({ context: alice, policy: restrictedPolicy, request,
        toolCallId: 'policy-excluded-operation' }), { code });
      await assert.rejects(() => dispatcher.verifyDelegatedComposioSchema({ context: alice, policy: restrictedPolicy,
        binding: handoff, operation: 'call' }), { code });
      assert.equal(provider.calls.length, beforeBob, 'Excluded apps, refs and tool intersections deny metadata/call/handoff before any SDK read.');
    }
    await assert.rejects(() => invoke({ action: 'call', toolRef: schema.toolRef, schemaRef: schema.schemaRef,
      arguments: { title: 'Injected' }, userId: 'admin' }), { code: 'invalid_request' });
    const mutation = async (grants: Parameters<typeof store.mutateSharedIntegrationConnection>[2]['grants']) => {
      const record = (await store.getIntegrationConnectionRecord(connection.resource.connectionRef))!;
      return store.mutateSharedIntegrationConnection(admin, record.resource.connectionRef, {
        expectedMetadataRevision: record.resource.metadataRevision, expectedGrantsRevision: record.resource.grantsRevision,
        expectedBindingRevision: record.resource.bindingRevision, grants });
    };
    let finalReadRevoked = false;
    provider.rotateOnRead(async () => { provider.rotateOnRead(async () => { finalReadRevoked = true; await mutation([]); }); });
    const beforeRace = posts().length;
    await assert.rejects(() => invoke({ action: 'call', toolRef: schema.toolRef, schemaRef: schema.schemaRef, arguments: { title: 'Revoked during final schema read' } }), { code: 'provider_denied' });
    assert(finalReadRevoked, 'Revocation happened in the actual adapter final schema read.');
    assert.equal(posts().length, beforeRace);
    const beforeStale = provider.calls.length;
    await assert.rejects(() => invoke({ action: 'call', toolRef: schema.toolRef, schemaRef: schema.schemaRef, arguments: { title: 'Stale grants' } }), { code: 'provider_denied' });
    assert.equal(provider.calls.length, beforeStale, 'Revoked shared references never route to personal defaults.');
    await mutation([userGrant(['DESIGN_CREATE'])]);
    provider.accounts.set(profile.composioUserId, [{ id: 'unselected-canva-account', toolkit: 'canva', status: 'ACTIVE' }]);
    const unavailable = await invoke({ action: 'search', target: 'providers', query: 'Canva Marketing' }) as IntegrationProviderPage;
    assert.equal(unavailable.providers[0].canExecute, false, 'A missing selected account does not use another active account.');
    const beforeMissing = posts().length;
    const freshList = await invoke({ action: 'list', target: 'tools', providerRef }) as IntegrationToolPage;
    const freshSchema = await invoke({ action: 'describe', toolRef: freshList.tools[0].toolRef }) as IntegrationToolSchema;
    await assert.rejects(() => invoke({ action: 'call', toolRef: freshSchema.toolRef, schemaRef: freshSchema.schemaRef, arguments: { title: 'Missing selected account' } }), { code: 'provider_unavailable' });
    assert.equal(posts().length, beforeMissing);

    provider.accounts.set(profile.composioUserId, [{ id: 'approved-canva-account', toolkit: 'canva', status: 'ACTIVE' }]);
    await mutation([{ targetType: 'agent', targetId: 'shared-design-agent', canUse: true, canManage: false, allowedToolNames: ['DESIGN_CREATE'] }]);
    const bobList = await invoke({ action: 'list', target: 'tools', providerRef }, bob) as IntegrationToolPage;
    assert.deepEqual(bobList.tools.map(tool => tool.name), ['DESIGN_CREATE'], 'An explicit bounded agent connection grant needs no direct user connection grant.');
    const bobSchema = await invoke({ action: 'describe', toolRef: bobList.tools[0].toolRef }, bob) as IntegrationToolSchema;
    const { createIntegrationGatewayTool } = await import('../app/lib/pi/integration-tool-gateway');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const beforeTwoUsers = posts().length;
    for (const id of ['alice', 'bob']) {
      const executionContext = executionContexts.get(id)!;
      const tool = createIntegrationGatewayTool({ userId: id, sessionId: executionContext.sessionId,
        agentId: executionContext.agentId, executionContext }, { dispatcher, isEnabled: () => true });
      const run = (action: unknown) => runWithAgentExecutionContext(executionContext,
        () => tool.execute(`shared-multiuser-${id}`, action as never));
      const allowed = await run({ action: 'list', target: 'tools', providerRef });
      assert.equal((allowed.details as { integrationError?: unknown }).integrationError, undefined);
      const selectedTool = (allowed.details as IntegrationToolPage).tools[0];
      const described = await run({ action: 'describe', toolRef: selectedTool.toolRef });
      assert.equal((described.details as { integrationError?: unknown }).integrationError, undefined);
      const issued = described.details as IntegrationToolSchema;
      const result = await run({ action: 'call', toolRef: issued.toolRef, schemaRef: issued.schemaRef,
        arguments: { title: `MULTIUSER_PRIVATE_ARGUMENT_${id}` } });
      assert.equal((result.details as { integrationError?: unknown }).integrationError, undefined);
    }
    const sharedCalls = posts().slice(beforeTwoUsers);
    assert.equal(sharedCalls.length, 2);
    assert(sharedCalls.every(call => call.body.connected_account_id === 'approved-canva-account'
      && call.body.user_id === profile.composioUserId && call.apiKey === 'shared-org-provider-key'),
    'Two actual users execute the same exact shared account and provider identity.');
    const audits = await raw.all("SELECT user_id,session_id,metadata_json FROM audit_events WHERE action='integrations.call' AND status='success' ORDER BY user_id") as Array<Record<string, unknown>>;
    assert.deepEqual(audits.map(audit => [audit.user_id, audit.session_id]), [['alice', 'session-alice'], ['bob', 'session-bob']]);
    assert(audits.every(audit => JSON.parse(String(audit.metadata_json)).toolCallId === `shared-multiuser-${audit.user_id}`));
    for (const privateValue of [profile.composioUserId, 'approved-canva-account', 'shared-org-provider-key', 'MULTIUSER_PRIVATE_ARGUMENT']) assert(!JSON.stringify(audits).includes(privateValue));
    const beforeUnboundAgent = provider.calls.length;
    await assert.rejects(() => invoke({ action: 'list', target: 'tools', providerRef }, { ...bob, sessionId: null }), { code: 'provider_denied' });
    assert.equal(provider.calls.length, beforeUnboundAgent, 'Model-like agent identity without its persisted session cannot supply an agent grant.');
    await raw.run("UPDATE agent_grants SET can_use=0 WHERE id='agent-bob'");
    await assert.rejects(() => invoke({ action: 'call', toolRef: bobSchema.toolRef, schemaRef: bobSchema.schemaRef, arguments: { title: 'Agent access revoked' } }, bob), { code: 'provider_denied' });
    assert.equal(provider.calls.length, beforeUnboundAgent, 'Revoked current agent access closes cached connection references before SDK discovery.');
    await raw.run("UPDATE agent_grants SET can_use=1 WHERE id='agent-bob'");

    const mutateState = async (ref: string, status: 'active' | 'archived') => {
      const current = (await store.getIntegrationConnectionRecord(ref))!;
      return store.mutateSharedIntegrationConnection(admin, ref, {
        expectedMetadataRevision: current.resource.metadataRevision, expectedGrantsRevision: current.resource.grantsRevision,
        expectedBindingRevision: current.resource.bindingRevision, status });
    };
    await mutateState(connection.resource.connectionRef, 'archived');
    assert.equal((await store.inspectSharedIntegrationConnection(admin, connection.resource.connectionRef)).resource.status, 'archived');
    const beforeArchived = provider.calls.length;
    const archived = await invoke({ action: 'search', target: 'providers', source: 'composio', query: 'Canva Marketing' }, manager) as IntegrationProviderPage;
    assert.equal(archived.providers.length, 0);
    assert.equal(archived.complete, true);
    assert.equal(provider.calls.length, beforeArchived, 'Archived connections stay administratively inspectable without gateway SDK discovery.');
    await mutateState(connection.resource.connectionRef, 'active');

    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const mcpConnection = await createSharedMcpConnection(admin, { ownership, displayName: 'MCP Marketing',
      allowedToolNames: ['create_design', 'read_design'], grants: [userGrant(['create_design']),
        { targetType: 'user', targetId: 'external', canUse: true, canManage: false, allowedToolNames: ['create_design'] }],
      config: { url: mcp.url, auth: 'none', headersFromEnv: { Authorization: 'MCP_SLOT_DESIGN_TOKEN' } },
      secrets: [{ name: 'DESIGN_TOKEN', value: 'Bearer shared-resource-token' }] });
    const mcpRef = proofs.createSharedIntegrationProviderRef(mcpConnection.resource);
    await mutateState(mcpConnection.resource.connectionRef, 'archived');
    const archivedMcp = await invoke({ action: 'search', target: 'providers', source: 'mcp', query: 'MCP Marketing' }, manager) as IntegrationProviderPage;
    assert.equal(archivedMcp.providers.length, 0);
    assert.equal(archivedMcp.complete, true);
    await mutateState(mcpConnection.resource.connectionRef, 'active');
    const beforeMcpCatalog = mcp.requests();
    const mcpPage = await invoke({ action: 'search', target: 'providers', source: 'mcp', query: 'MCP Marketing' }) as IntegrationProviderPage;
    assert.equal(mcpPage.providers.length, 1); assert.equal(mcpPage.providers[0].canExecute, true);
    assert.equal(mcp.requests(), beforeMcpCatalog, 'MCP provider discovery performs no network probe or server start.');
    const mcpList = await invoke({ action: 'list', target: 'tools', providerRef: mcpRef }) as IntegrationToolPage;
    assert.deepEqual(mcpList.tools.map(tool => tool.name), ['create_design']);
    const mcpSchema = await invoke({ action: 'describe', toolRef: mcpList.tools[0].toolRef }) as IntegrationToolSchema;
    await invoke({ action: 'call', toolRef: mcpSchema.toolRef, schemaRef: mcpSchema.schemaRef, arguments: {} });
    assert.deepEqual(mcp.calls, ['create_design']);
    assert(mcp.headers.length > 0 && mcp.headers.every(value => value === 'Bearer shared-resource-token'));
    const extList = await invoke({ action: 'list', target: 'tools', providerRef: mcpRef }, external) as IntegrationToolPage;
    assert.equal(extList.tools.length, 1, 'An explicit external-user grant uses shared MCP without weakening personal MCP ownership.');
    let revoked = false;
    const mcpRecord = (await store.getIntegrationConnectionRecord(mcpConnection.resource.connectionRef))!;
    const beforeMcpRace = mcp.calls.length;
    await assert.rejects(() => invoke({ action: 'call', toolRef: mcpSchema.toolRef, schemaRef: mcpSchema.schemaRef, arguments: {} }, alice, async () => {
      if (revoked) return; revoked = true;
      await store.mutateSharedIntegrationConnection(admin, mcpRecord.resource.connectionRef, {
        expectedMetadataRevision: mcpRecord.resource.metadataRevision, expectedGrantsRevision: mcpRecord.resource.grantsRevision,
        expectedBindingRevision: mcpRecord.resource.bindingRevision, grants: [] });
    }), { code: 'provider_denied' });
    assert(revoked); assert.equal(mcp.calls.length, beforeMcpRace);
    await raw.close();
    console.log('PASS shared gateway: actual PG authority + SDK/HTTP, exact account and resource credentials, team grants from personal workspaces, bounded tools, descriptor provenance, external explicit grants and late revocation.');
  } finally {
    try { const { closeAllMcpServers } = await import('../app/lib/mcp/manager'); await closeAllMcpServers(); } catch { /* Preserve a fixture failure. */ }
    internals._load = originalLoad;
    await Promise.allSettled([database.close(), provider.close(), mcp.close(), rm(dataRoot, { recursive: true, force: true })]);
    for (const [key, value] of Object.entries(previousEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
