import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { SharedMcpAppDescriptor } from '../app/lib/mcp/apps-types';
import type { IntegrationPolicy, IntegrationToolPage, IntegrationToolSchema } from '../app/lib/integration-tools/contracts';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { createSharedMcpAppsProviderFixture } from './helpers/shared-mcp-apps-provider-fixture';

async function expectAppDenied(operation: () => Promise<unknown>, statuses: number[] = [403, 409]) {
  await assert.rejects(operation, (error: unknown) => {
    assert(statuses.includes(Number((error as { status?: unknown }).status)), 'Expected a typed, bounded MCP access denial.');
    return true;
  });
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-shared-mcp-apps-'));
  const database = await createPiTestDatabase();
  const raw = await database.openDb();
  const controlToken = randomUUID();
  const provider = await createSharedMcpAppsProviderFixture({ controlToken });
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_INSTANCE_ID: 'shared-apps-fixture',
    CANVAS_ORGANIZATION_ID: 'apps-org', CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
    CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_MCP_APPS_ENABLED: 'true',
    MCP_ALLOW_INSECURE_HTTP: 'true', MCP_ALLOW_PRIVATE_NETWORK: 'true', MCP_ALLOW_STDIO: 'false',
    INTEGRATIONS_ENV_MASTER_KEY: randomUUID() + randomUUID(), BASE_URL: 'http://localhost:3000' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (name, parent, isMain) => {
    if (name === 'server-only' || name === '@earendil-works/pi-agent-core' || name === '@earendil-works/pi-ai/oauth') return {};
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
      getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false,
    };
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    // Auth transport only: every session used below is an actual current SQL row.
    if (name === '@/app/lib/auth') return { auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get('x-fixture-auth-session');
      const stored = await raw.get('SELECT id,user_id,expires_at FROM "session" WHERE id=$1 AND expires_at>$2', [id, Date.now()]) as
        { id: string; user_id: string; expires_at: number | string } | undefined;
      return stored ? { user: { id: stored.user_id }, session: { id: stored.id, expiresAt: new Date(Number(stored.expires_at)) } } : null;
    } } } };
    // External seat/license service boundary only. All users/membership/workspace,
    // agent/session/connection grants and runtime policy remain real production services.
    if (name.includes('license/seat-limit')) return { assertUserSeatAccess: async ({ userId }: { userId: string }) =>
      ({ userId, mode: 'team', organizationId: 'apps-org' }) };
    return originalLoad(name, parent, isMain);
  };
  try {
    for (const id of ['admin', 'alice', 'bob', 'manager', 'unassigned']) {
      await raw.run('INSERT INTO "user"(id,name,email,role,email_verified,created_at,updated_at) VALUES($1,$1,$2,\'member\',1,1,1)', [id, `${id}@example.test`]);
    }
    await raw.run("INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES('apps-org','admin','team',1,1,1)");
    for (const id of ['admin', 'alice', 'bob', 'manager', 'unassigned']) {
      await raw.run("INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES('apps-org',$1,$2,'active',1,1,1)", [id, id === 'admin' ? 'owner' : 'member']);
      await raw.run("INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES($1,'apps-org','personal',$2,$3,$2,'active',1,1)", [`personal-${id}`, id, `workspaces/personal-${id}/files`]);
    }
    await raw.run("INSERT INTO canvas_workspaces(id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES('apps-team','apps-org','team','workspaces/apps-team/files','Apps team','active',1,1)");
    await raw.run("INSERT INTO canvas_workspace_members(organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES('apps-org','apps-team','alice','member','active',1,1,0,1,1)");
    await raw.run("INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,owner_user_id,created_by_user_id,enabled_tools_json,revision,created_at,updated_at) VALUES('apps-agent','Apps agent','special','restricted','organization','apps-org',NULL,'admin','[\"mcp\"]',1,1,1)");
    await raw.run("INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,can_use,can_edit,can_manage,created_at,updated_at) VALUES('agent-admin','apps-agent','apps-org','user','admin',1,1,1,1,1)");
    for (const id of ['alice', 'bob', 'manager', 'unassigned']) {
      await raw.run("INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,can_use,can_edit,can_manage,created_at,updated_at) VALUES($1,'apps-agent','apps-org','user',$2,1,0,0,1,1)", [`agent-${id}`, id]);
    }
    const { piSessions, piMessages, session: authSessions } = await import('../app/lib/db/schema');
    const now = new Date(), expiresAt = new Date(Date.now() + 60 * 60_000);
    const piIds = new Map<string, number>();
    for (const id of ['alice', 'bob', 'manager', 'unassigned']) {
      const [stored] = await database.db.insert(piSessions).values({ sessionId: `chat-${id}`, userId: id, agentId: 'apps-agent',
        workspaceId: `personal-${id}`, workspaceType: 'personal', organizationId: 'apps-org',
        provider: 'fixture', model: 'fixture', createdAt: now, updatedAt: now }).returning({ id: piSessions.id });
      piIds.set(id, stored.id);
      await database.db.insert(authSessions).values({ id: `auth-${id}`, userId: id, token: randomUUID(), expiresAt,
        createdAt: now, updatedAt: now });
    }
    await database.db.insert(authSessions).values({ id: 'auth-alice-replacement', userId: 'alice', token: randomUUID(), expiresAt,
      createdAt: now, updatedAt: now });
    const { serverPreferencesPath } = await import('../app/lib/terminal-policy');
    await mkdir(path.dirname(serverPreferencesPath()), { recursive: true });
    await writeFile(serverPreferencesPath(), JSON.stringify({ settings: { integrationToolGatewayEnabled: true } }));
    const connections = await import('../app/lib/integration-tools/connections/store');
    const shared = await import('../app/lib/mcp/shared-connections');
    const { createSharedIntegrationProviderRef } = await import('../app/lib/integration-tools/connections/provider-authorization');
    const { createIntegrationGatewayTool } = await import('../app/lib/pi/integration-tool-gateway');
    const { resolveIntegrationExecutionContext } = await import('../app/lib/integration-tools/context');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const host = await import('../app/lib/mcp/apps-host');
    const { requireSharedMcpAppAccess } = await import('../app/lib/mcp/apps-shared-access');
    const manager = await import('../app/lib/mcp/manager');
    const route = await import('../app/api/mcp/apps/route');
    const admin = { userId: 'admin', workspaceId: 'personal-admin', organizationId: 'apps-org' };
    const names = ['app_view', 'app_action', 'model_only', 'missing_tool'];
    const grants = [
      { targetType: 'user' as const, targetId: 'alice', canUse: true, canManage: false, allowedToolNames: names },
      { targetType: 'user' as const, targetId: 'manager', canUse: false, canManage: true, allowedToolNames: names },
      { targetType: 'user' as const, targetId: 'admin', canUse: true, canManage: true, allowedToolNames: names },
    ];
    const orgConnection = await shared.createSharedMcpConnection(admin, {
      ownership: { type: 'organization', organizationId: 'apps-org' }, displayName: 'Same design name',
      allowedToolNames: names, grants, config: { url: provider.url, auth: 'none', headersFromEnv: { Authorization: 'MCP_SLOT_TOKEN' } },
      secrets: [{ name: 'TOKEN', value: 'Bearer fixture-start' }],
    });
    const teamConnection = await shared.createSharedMcpConnection(admin, {
      ownership: { type: 'team', organizationId: 'apps-org', workspaceId: 'apps-team' }, displayName: 'Same design name',
      allowedToolNames: names, grants, config: { url: provider.url, auth: 'none' },
    });
    const chat = (id = 'alice') => ({ userId: id, sessionId: `chat-${id}`, agentId: 'apps-agent' });
    let sequence = 0;
    const saved = async (connection = orgConnection, id = 'alice', ceiling?: IntegrationPolicy) => {
      const initial = await resolveIntegrationExecutionContext({ actorUserId: id, sessionId: `chat-${id}`,
        agentId: 'apps-agent', policyRevision: 'fixture-preflight' });
      const executionContext = { ...initial.executionContext, agentTurnId: `fixture-turn-${++sequence}` };
      const gateway = createIntegrationGatewayTool({ userId: id, sessionId: executionContext.sessionId,
        agentId: executionContext.agentId, executionContext, policyCeiling: ceiling });
      const invoke = (toolCallId: string, request: unknown) => runWithAgentExecutionContext(executionContext,
        () => gateway.execute(toolCallId, request as never));
      const listed = await invoke(`list-${sequence}`, { action: 'list', target: 'tools', providerRef: createSharedIntegrationProviderRef(connection.resource) });
      assert.equal((listed.details as { integrationError?: unknown }).integrationError, undefined, 'Actual gateway tool discovery succeeds.');
      const tools = (listed.details as IntegrationToolPage).tools;
      assert(!tools.some(tool => tool.name === 'app_action'), 'App-only tool never becomes a model tool.');
      const tool = tools.find(item => item.name === 'app_view'); assert(tool);
      const described = await invoke(`describe-${sequence}`, { action: 'describe', toolRef: tool.toolRef });
      assert.equal((described.details as { integrationError?: unknown }).integrationError, undefined);
      const schema = described.details as IntegrationToolSchema;
      const toolCallId = `source-${sequence}`;
      const result = await invoke(toolCallId, { action: 'call', toolRef: schema.toolRef, schemaRef: schema.schemaRef, arguments: {} });
      assert.equal((result.details as { integrationError?: unknown }).integrationError, undefined, 'Actual gateway source invocation succeeds.');
      const app = (result.details as { mcpApp?: SharedMcpAppDescriptor }).mcpApp;
      assert(app?.version === 2, 'Actual MCP adapter produces the v2 descriptor and private saved authority: ' +
        JSON.stringify({ keys: Object.keys(result.details as object), version: app?.version,
          unavailable: (result.details as { mcpAppUnavailable?: { code?: string } }).mcpAppUnavailable?.code }));
      assert.equal(app.connectionRef, connection.resource.connectionRef);
      assert.equal(app.toolCallId, toolCallId);
      const content = JSON.stringify({ role: 'toolResult', toolCallId, toolName: gateway.name, ...result });
      const [row] = await database.db.insert(piMessages).values({ piSessionDbId: piIds.get(id)!, role: 'toolResult',
        content, timestamp: Date.now(), sequence }).returning({ id: piMessages.id });
      return { app, content, messageId: row.id };
    };
    const issue = (app: SharedMcpAppDescriptor, id = 'alice') => host.issueMcpAppTicket({ ...chat(id), app,
      authSessionId: `auth-${id}`, authSessionExpiresAt: expiresAt });
    const ticketValue = (frame: { frameUrl: string }) => new URL(frame.frameUrl).pathname.split('/')[2];
    const call = async (app: SharedMcpAppDescriptor, ticket: string, target = 'app_action', args: Record<string, unknown> = { value: 'allowed' }) => {
      const input = { ...chat(), app, ticket, authSessionId: 'auth-alice' };
      const access = await host.requireSharedMcpAppCallTicket(input, target);
      return manager.callMcpAppTool(access.connectionId, app.toolName, app.resourceUri, target, args, undefined, access.scope,
        { expectedEnvironmentRevision: access.environmentRevision,
          beforeDispatch: async () => { await host.requireSharedMcpAppCallTicket(input, target); } });
    };
    const mutate = async (connection: typeof orgConnection, value: Omit<Parameters<typeof connections.mutateSharedIntegrationConnection>[2],
      'expectedMetadataRevision' | 'expectedGrantsRevision' | 'expectedBindingRevision'>) => {
      const current = (await connections.getIntegrationConnectionRecord(connection.resource.connectionRef))!;
      return connections.mutateSharedIntegrationConnection(admin, current.resource.connectionRef, { ...value,
        expectedMetadataRevision: current.resource.metadataRevision, expectedGrantsRevision: current.resource.grantsRevision,
        expectedBindingRevision: current.resource.bindingRevision });
    };
    const request = (body: Record<string, unknown>, authId = 'auth-alice', origin = 'http://localhost:3000') => new Request('http://localhost:3000/api/mcp/apps', {
      method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-fixture-auth-session': authId }, body: JSON.stringify(body),
    });

    const original = await saved();
    const { mcpIntegrationToolAdapter, verifyMcpIntegrationToolsReady } = await import('../app/lib/integration-tools/adapters/mcp-runtime');
    const readyInitial = await resolveIntegrationExecutionContext({ actorUserId: 'alice', sessionId: 'chat-alice',
      agentId: 'apps-agent', policyRevision: 'actual-readiness-fixture' });
    const readyContext = { ...readyInitial.integrationContext, sessionId: 'chat-alice' };
    const readyProvider = await mcpIntegrationToolAdapter.resolveProvider(readyContext, createSharedIntegrationProviderRef(orgConnection.resource));
    const beforeReadiness = provider.calls.length;
    assert.equal(await verifyMcpIntegrationToolsReady(readyContext, readyProvider, ['app_view', 'app_action']), true,
      'Actual private readiness sees a granted app-only required tool.');
    assert.equal(await verifyMcpIntegrationToolsReady(readyContext, readyProvider, ['missing_tool']), false,
      'A granted but nonexistent required tool fails readiness.');
    await assert.rejects(() => mcpIntegrationToolAdapter.describeTool(readyContext, readyProvider, 'app_action'), { code: 'tool_not_found' });
    assert.equal(provider.calls.length, beforeReadiness, 'Readiness and public app-only describe never execute a business tool.');
    const frame = await issue(original.app); const ticket = ticketValue(frame);
    assert.equal(provider.resourceReads.length, 1);
    for (const mode of ['frame', 'document']) {
      const delivered = await host.deliverMcpAppTicket(new Request(frame.frameUrl, { headers: { host: 'localhost:3000' } }), ticket, mode);
      assert.equal(delivered.status, 200); assert.match(delivered.headers.get('cache-control')!, /no-store/u);
      assert.match(delivered.headers.get('content-security-policy')!, /connect-src 'none'/u);
    }
    const beforeAction = provider.calls.length;
    await call(original.app, ticket);
    assert.equal(provider.calls.length, beforeAction + 1); assert.equal(provider.calls.at(-1)?.name, 'app_action');
    assert.equal((await fetch(`${provider.origin}/__fixture/state`)).status, 404);
    const stateResponse = await fetch(`${provider.origin}/__fixture/state`, { headers: { Authorization: `Bearer ${controlToken}` } });
    assert.equal(stateResponse.status, 200); assert.equal(stateResponse.headers.get('cache-control'), 'no-store');
    const state = await stateResponse.json() as { calls: Array<{ name: string }>; requests: string[]; resourceReads: string[] };
    assert.equal(state.calls.length, provider.calls.length); assert.equal(state.resourceReads.length, provider.resourceReads.length);
    assert(state.calls.every(item => Object.keys(item).join(',') === 'name'), 'Control DTO omits arguments and credentials.');
    const teamOriginal = await saved(teamConnection); await issue(teamOriginal.app);
    assert.notEqual(teamOriginal.app.connectionRef, original.app.connectionRef, 'Same-name Org/Team providers remain exact distinct resources.');
    console.log('PASS shared MCP Apps: real gateway-issued saved result, Org/Team exact references, personal-chat grant, sandbox ticket and app-only target.');

    let baseline = provider.requests.length;
    await expectAppDenied(() => requireSharedMcpAppAccess(chat(), { ...original.app, toolCallId: 'unsaved-result' }), [425]);
    for (const changed of [
      { ...original.app, connectionRef: teamOriginal.app.connectionRef }, { ...original.app, toolName: 'model_only' },
      { ...original.app, resourceUri: 'ui://forged/secret' }, { ...original.app, bindingRevision: '0'.repeat(64) },
    ]) await expectAppDenied(() => requireSharedMcpAppAccess(chat(), changed));
    for (const id of ['bob', 'manager', 'unassigned']) await expectAppDenied(() => requireSharedMcpAppAccess(chat(id), original.app), [425]);
    await expectAppDenied(() => requireSharedMcpAppAccess({ ...chat(), agentId: 'foreign-agent' }, original.app));
    await expectAppDenied(() => host.requireSharedMcpAppCallTicket({ ...chat(), app: original.app, ticket,
      authSessionId: 'auth-alice-replacement' }, 'app_action'));
    await expectAppDenied(() => host.requireSharedMcpAppCallTicket({ ...chat(), app: original.app, ticket: 'x'.repeat(43),
      authSessionId: 'auth-alice' }, 'app_action'));
    assert.equal(provider.requests.length, baseline, 'Invalid saved identity/foreign sessions cannot perform provider metadata I/O.');
    const { stripMcpAppAuthority } = await import('../app/lib/mcp/apps-contracts');
    const publicResult = JSON.stringify(stripMcpAppAuthority(JSON.parse(original.content)));
    assert(!publicResult.includes('mcpAppAuthority')); assert(!publicResult.includes(orgConnection.backend.source === 'mcp' ? orgConnection.backend.connectionId : 'unexpected'));
    const { parsePersistedPiMessage } = await import('../app/lib/pi/message-projection');
    const display = JSON.stringify(parsePersistedPiMessage(original.content, 'display'));
    const model = JSON.stringify(parsePersistedPiMessage(original.content, 'context'));
    assert(display.includes('ui-only-shared-app') && display.includes('image/png') && display.includes('structuredContent'));
    assert(!display.includes('mcpAppAuthority') && !model.includes('ui-only-shared-app') && !model.includes('mcpAppAuthority'));
    console.log('PASS saved authority: unsaved425, forged refs/source/resource/binding, foreign chat/agent and replacement Auth session denied before provider I/O.');

    const forgedMessage = JSON.parse(original.content);
    forgedMessage.details.mcpAppAuthority.context.workspaceId = 'apps-team';
    await raw.run('UPDATE pi_messages SET content=$1 WHERE id=$2', [JSON.stringify(forgedMessage), original.messageId]);
    await expectAppDenied(() => requireSharedMcpAppAccess(chat(), original.app));
    await raw.run('UPDATE pi_messages SET content=$1 WHERE id=$2', [original.content, original.messageId]);
    await (await import('../app/lib/mcp/access')).requireMcpUserAccess({ userId: 'alice' });
    assert(await raw.get('SELECT id FROM "session" WHERE id=$1 AND expires_at>$2', ['auth-alice', Date.now()]));
    const rejectedMessage = JSON.parse(original.content); rejectedMessage.isError = true;
    await raw.run('UPDATE pi_messages SET content=$1 WHERE id=$2', [JSON.stringify(rejectedMessage), original.messageId]);
    await expectAppDenied(() => requireSharedMcpAppAccess(chat(), original.app));
    await raw.run('UPDATE pi_messages SET content=$1 WHERE id=$2', [original.content, original.messageId]);
    const rendered = await route.POST(request({ action: 'render', ...chat(), app: original.app }));
    assert.equal(rendered.status, 200); assert.match(rendered.headers.get('cache-control')!, /no-store/u);
    const renderedBody = await rendered.json() as { data: { frameUrl: string } };
    const routeTicket = ticketValue(renderedBody.data);
    const apiCall = await route.POST(request({ action: 'call', ...chat(), app: original.app, ticket: routeTicket,
      tool: 'app_action', arguments: { value: 'route allowed' } }));
    assert.equal(apiCall.status, 200);
    const beforeRouteDenial = provider.calls.length;
    for (const response of [
      await route.POST(request({ action: 'render', ...chat(), app: original.app }, 'auth-alice', 'https://foreign.invalid')),
      await route.POST(request({ action: 'call', ...chat(), app: original.app, tool: 'app_action', arguments: {} })),
      await route.POST(request({ action: 'call', ...chat(), app: { ...original.app, connectionId: randomUUID() }, ticket,
        tool: 'app_action', arguments: { value: 'forged backend' } })),
      await route.POST(request({ action: 'unknown', ...chat(), app: original.app })),
    ]) assert([400, 403].includes(response.status));
    assert.equal(provider.calls.length, beforeRouteDenial);
    await assert.rejects(() => call(original.app, ticket, 'app_action', { value: 42 } as unknown as Record<string, unknown>), { code: 'invalid_arguments' });
    await assert.rejects(() => call(original.app, ticket, 'model_only'));
    assert.equal(provider.calls.length, beforeRouteDenial, 'Invalid args/model-only app targets are never called.');
    console.log('PASS actual route: current Auth SQL row, strict origin/action/v2 fields/ticket, invalid arguments and model-only target denied.');

    await mutate(orgConnection, { grants: [{ ...grants[0], allowedToolNames: ['app_view'] }, grants[1]] });
    const sourceOnly = await saved(); const sourceFrame = await issue(sourceOnly.app);
    baseline = provider.requests.length;
    await expectAppDenied(() => host.requireSharedMcpAppCallTicket({ ...chat(), app: sourceOnly.app,
      ticket: ticketValue(sourceFrame), authSessionId: 'auth-alice' }, 'app_action'));
    assert.equal(provider.requests.length, baseline, 'Source permission cannot grant target permission.');
    await mutate(orgConnection, { grants: [{ ...grants[0], allowedToolNames: ['app_action'] }, grants[1]] });
    baseline = provider.resourceReads.length;
    await expectAppDenied(() => issue(sourceOnly.app)); assert.equal(provider.resourceReads.length, baseline, 'Target permission cannot grant source HTML.');
    await mutate(orgConnection, { grants: [grants[1]] });
    await expectAppDenied(() => issue(original.app));
    await mutate(orgConnection, { grants: [grants[0], { ...grants[1], canUse: true }, grants[2]] });
    const priorManagerUse = await saved(orgConnection, 'manager');
    await mutate(orgConnection, { grants });
    baseline = provider.requests.length;
    await expectAppDenied(() => issue(priorManagerUse.app, 'manager'));
    assert.equal(provider.requests.length, baseline, 'Manage-only cannot reuse an actual prior own successful invocation after Use withdrawal.');
    await mutate(orgConnection, { grants });
    const { UNRESTRICTED_INTEGRATION_POLICY } = await import('../app/lib/integration-tools/policy');
    const providerRef = createSharedIntegrationProviderRef(orgConnection.resource);
    const policyBound = await saved(orgConnection, 'alice', { ...UNRESTRICTED_INTEGRATION_POLICY,
      providerToolRules: [{ source: 'mcp', providerRef, allowedToolNames: ['app_view'], allowedOperations: null }] });
    const policyFrame = await issue(policyBound.app);
    baseline = provider.requests.length;
    await expectAppDenied(() => host.requireSharedMcpAppCallTicket({ ...chat(), app: policyBound.app,
      ticket: ticketValue(policyFrame), authSessionId: 'auth-alice' }, 'app_action'));
    assert.equal(provider.requests.length, baseline, 'Saved per-provider runtime ceiling never grants an app-only target outside its cap.');
    console.log('PASS independent source/target grants, Manage-only provenance denial and exact per-provider runtime ceiling.');

    await mutate(orgConnection, { grants: [{ targetType: 'agent', targetId: 'apps-agent', canUse: true, canManage: false, allowedToolNames: names }] });
    const bobOriginal = await saved(orgConnection, 'bob'); await issue(bobOriginal.app, 'bob');
    await raw.run("UPDATE pi_sessions SET archived_at=$1 WHERE session_id='chat-bob'", [Date.now()]);
    await expectAppDenied(() => issue(bobOriginal.app, 'bob'));
    await mutate(orgConnection, { grants });
    console.log('PASS actual agent-grant-only execution requires its persisted current PI session.');

    const live = await saved(); const liveFrame = await issue(live.app); const liveTicket = ticketValue(liveFrame);
    const beforeRevokeRead = provider.resourceReads.length;
    let readRevoke = false;
    provider.onList(async () => { readRevoke = true; await mutate(orgConnection, { grants: [] }); });
    await expectAppDenied(() => issue(live.app));
    assert(readRevoke); assert.equal(provider.resourceReads.length, beforeRevokeRead, 'Grant revoked during real tools/list closes HTML dispatch.');
    await mutate(orgConnection, { grants });
    const liveCall = await saved(); const liveCallFrame = await issue(liveCall.app);
    const beforeRevokeCall = provider.calls.length;
    let callRevoke = false;
    provider.onList(async () => { callRevoke = true; await mutate(orgConnection, { grants: [] }); });
    await expectAppDenied(() => call(liveCall.app, ticketValue(liveCallFrame)));
    assert(callRevoke); assert.equal(provider.calls.length, beforeRevokeCall, 'Grant revoked after app metadata closes actual target dispatch.');
    await mutate(orgConnection, { grants });
    const afterBytes = await saved(); const beforeAfterBytes = provider.resourceReads.length;
    let afterBytesRevoke = false;
    provider.onResource(async () => { afterBytesRevoke = true; await mutate(orgConnection, { grants: [] }); });
    await expectAppDenied(() => issue(afterBytes.app));
    assert(afterBytesRevoke); assert.equal(provider.resourceReads.length, beforeAfterBytes + 1, 'In-flight HTML was read but no ticket is issued after fresh grant revoke.');
    await mutate(orgConnection, { grants });
    assert.equal((await host.deliverMcpAppTicket(new Request(liveFrame.frameUrl, { headers: { host: 'localhost:3000' } }), liveTicket, 'document')).status, 404);
    console.log('PASS real HTTP barriers: revoke during list before read/call yields zero dispatch; revoke after HTML yields no ticket; stale ticket404.');

    const changedSource = await saved(); const changedFrame = await issue(changedSource.app);
    provider.setSourceResource('ui://changed/source');
    baseline = provider.resourceReads.length;
    await assert.rejects(() => issue(changedSource.app)); assert.equal(provider.resourceReads.length, baseline);
    provider.setSourceResource(provider.resourceUri);
    provider.setTargetVisible(false); baseline = provider.calls.length;
    await assert.rejects(() => call(changedSource.app, ticketValue(changedFrame))); assert.equal(provider.calls.length, baseline);
    provider.setTargetVisible(true);
    const { sharedMcpScope } = await import('../app/lib/mcp/shared-access');
    const { sharedMcpSecretSlot, writeSharedMcpSecretSlot } = await import('../app/lib/mcp/shared-secrets');
    for (const kind of ['resource', 'tool'] as const) {
      const credentialSource = await saved();
      const credentialFrame = await issue(credentialSource.app);
      const input = { ...chat(), app: credentialSource.app, ticket: ticketValue(credentialFrame), authSessionId: 'auth-alice' };
      const target = kind === 'resource' ? credentialSource.app.toolName : 'app_action';
      const access = await host.requireSharedMcpAppCallTicket(input, target);
      const beforeBinding = (await connections.getIntegrationConnectionRecord(orgConnection.resource.connectionRef))!.resource.bindingRevision;
      const administrator = await connections.authorizeIntegrationConnection(admin, orgConnection.resource.connectionRef, 'manage');
      const administratorScope = sharedMcpScope(administrator);
      const resourceCount: number = provider.resourceReads.length, callCount: number = provider.calls.length;
      let rotated = false;
      const options = { expectedEnvironmentRevision: access.environmentRevision, beforeDispatch: async () => {
        await host.requireSharedMcpAppCallTicket(input, target);
        assert.equal(rotated, false, 'The final credential rotation hook executes once.');
        await writeSharedMcpSecretSlot(administratorScope, sharedMcpSecretSlot(administratorScope, 'TOKEN'), `Bearer fixture-final-${kind}`);
        rotated = true;
      } };
      await assert.rejects(() => kind === 'resource'
        ? manager.readMcpAppResource(access.connectionId, credentialSource.app.toolName, credentialSource.app.resourceUri, access.scope, options)
        : manager.callMcpAppTool(access.connectionId, credentialSource.app.toolName, credentialSource.app.resourceUri,
          'app_action', { value: 'credential race' }, undefined, access.scope, options), { code: 'mcp_environment_binding_changed' });
      assert(rotated, 'Real authorized credential-slot rotation happened after the fresh ticket guard.');
      assert.equal((await connections.getIntegrationConnectionRecord(orgConnection.resource.connectionRef))!.resource.bindingRevision, beforeBinding,
        'This race changes only the credential environment, not the SQL binding stamp.');
      assert.equal(provider.resourceReads.length, resourceCount, 'Credential changed after Root guard: no actual HTML request reaches the provider.');
      assert.equal(provider.calls.length, callCount, 'Credential changed after Root guard: no actual app tool request reaches the provider.');
      await expectAppDenied(() => issue(credentialSource.app));
      assert.equal(provider.resourceReads.length, resourceCount);
      assert.equal(provider.calls.length, callCount);
      const renewed = await saved(); await issue(renewed.app);
    }
    console.log('PASS actual HTTP credential fence: slot rotation after fresh guard, unchanged SQL binding, zero HTML/target dispatch; fresh source restores access.');
    const fresh = await saved(); const freshFrame = await issue(fresh.app); const freshTicket = ticketValue(freshFrame);
    for (const [sql, args, restore, restoreArgs] of [
      ["UPDATE agent_grants SET can_use=0 WHERE id='agent-alice'", [], "UPDATE agent_grants SET can_use=1 WHERE id='agent-alice'", []],
      ["UPDATE canvas_workspaces SET status='archived' WHERE id='personal-alice'", [], "UPDATE canvas_workspaces SET status='active' WHERE id='personal-alice'", []],
      ["UPDATE pi_sessions SET archived_at=$1 WHERE session_id='chat-alice'", [Date.now()], "UPDATE pi_sessions SET archived_at=NULL WHERE session_id='chat-alice'", []],
      ["UPDATE \"session\" SET expires_at=$1 WHERE id='auth-alice'", [0], "UPDATE \"session\" SET expires_at=$1 WHERE id='auth-alice'", [expiresAt.getTime()]],
    ] as const) {
      await raw.run(sql, [...args]); baseline = provider.calls.length;
      assert.equal((await host.deliverMcpAppTicket(new Request(freshFrame.frameUrl, { headers: { host: 'localhost:3000' } }), freshTicket, 'document')).status, 404);
      await expectAppDenied(() => call(fresh.app, freshTicket), [401, 403, 409]); assert.equal(provider.calls.length, baseline);
      await raw.run(restore, [...restoreArgs]);
    }
    const { patchUnifiedEnvEntries } = await import('../app/lib/secrets/unified-env-store');
    await patchUnifiedEnvEntries([{ key: 'SHARED_APP_FIXTURE_REVISION', value: 'changed' }], { secretScope: 'organization', organizationId: 'apps-org' });
    await issue(fresh.app);
    const authorization = await connections.authorizeIntegrationConnection(admin, orgConnection.resource.connectionRef, 'manage');
    const scope = sharedMcpScope(authorization);
    await writeSharedMcpSecretSlot(scope, sharedMcpSecretSlot(scope, 'TOKEN'), 'Bearer fixture-rotated');
    baseline = provider.resourceReads.length;
    await expectAppDenied(() => issue(fresh.app)); assert.equal(provider.resourceReads.length, baseline, 'Exact resource credential slot rotation invalidates saved backend identity; unrelated ENV does not.');
    const binding = await saved(); const record = (await connections.getIntegrationConnectionRecord(orgConnection.resource.connectionRef))!;
    await shared.updateSharedMcpConfiguration(admin, record.resource.connectionRef, {
      metadataRevision: record.resource.metadataRevision, grantsRevision: record.resource.grantsRevision,
      bindingRevision: record.resource.bindingRevision }, { config: { url: provider.url, auth: 'none' } });
    baseline = provider.resourceReads.length;
    await expectAppDenied(() => issue(binding.app)); assert.equal(provider.resourceReads.length, baseline);
    const policyCurrent = await saved();
    await raw.run("UPDATE agents SET enabled_tools_json='[\"__none__\"]',revision=revision+1 WHERE agent_id='apps-agent'");
    baseline = provider.requests.length;
    await expectAppDenied(() => issue(policyCurrent.app)); assert.equal(provider.requests.length, baseline);
    console.log('PASS current source/target visibility, AgentUse/workspace/PI/Auth expiry, ENV/backend binding and agent-policy revisions fence cached apps.');
    const { getAgentProfile } = await import('../app/lib/agents/registry');
    const { updateManagedAgentConfiguration } = await import('../app/lib/agents/workflow-configuration');
    const currentAgent = (await getAgentProfile('apps-agent'))!;
    const reenabled = await updateManagedAgentConfiguration({ actor: admin, agentId: 'apps-agent', expectedRevision: currentAgent.revision,
      expectedWorkflowRevision: currentAgent.workflowRevision ?? 0, enabledTools: ['mcp'] });
    const beforeEmpty = await saved();
    await updateManagedAgentConfiguration({ actor: admin, agentId: 'apps-agent', expectedRevision: reenabled.agent.revision,
      expectedWorkflowRevision: reenabled.agent.workflowRevision ?? 0, workflow: { version: 1, packages: [] } });
    baseline = provider.requests.length;
    await expectAppDenied(() => issue(beforeEmpty.app)); assert.equal(provider.requests.length, baseline,
      'Actual atomic configuration writer empty workflow closes all external Apps before provider metadata.');
    console.log('PASS actual private app-only readiness/nonexistent required tool, public describe separation and empty workflow writer matrix.');
    console.log('PASS shared MCP Apps authority fixture (isolated migrated PostgreSQL + actual gateway/store/runtime/HTTP; external seat service and Auth transport are explicit seams).');
  } finally {
    try { const manager = await import('../app/lib/mcp/manager'); await manager.closeAllMcpServers(); } catch { /* Preserve original fixture failure. */ }
    internals._load = originalLoad;
    await Promise.allSettled([provider.close(), database.close(), rm(root, { recursive: true, force: true })]);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
