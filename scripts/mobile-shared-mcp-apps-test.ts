import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { SharedMcpAppDescriptor } from '../app/lib/mcp/apps-types';
import type { MobileMcpActor } from '../app/lib/mobile/mcp-apps-access';
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-shared-apps-'));
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
    const mutate = async (connection: typeof orgConnection, value: Omit<Parameters<typeof connections.mutateSharedIntegrationConnection>[2],
      'expectedMetadataRevision' | 'expectedGrantsRevision' | 'expectedBindingRevision'>) => {
      const current = (await connections.getIntegrationConnectionRecord(connection.resource.connectionRef))!;
      return connections.mutateSharedIntegrationConnection(admin, current.resource.connectionRef, { ...value,
        expectedMetadataRevision: current.resource.metadataRevision, expectedGrantsRevision: current.resource.grantsRevision,
        expectedBindingRevision: current.resource.bindingRevision });
    };
    const tickets = await import('../app/lib/mcp/mobile-app-tickets');
    const access = await import('../app/lib/mobile/mcp-apps-access');
    const calls = await import('../app/lib/mcp/mobile-app-call-service');
    const { mobileMcpAppCallStore } = await import('../app/lib/mcp/mobile-app-call-store');
    const { readMobileMcpRender } = await import('../app/lib/mobile/mcp-apps-contracts');
    const actor = (id = 'alice'): MobileMcpActor => ({ ...chat(id), workspaceId: `personal-${id}`,
      authSessionId: `auth-${id}`, authSessionExpiresAt: expiresAt.getTime() });
    const appSource = (app: SharedMcpAppDescriptor) => ({ toolCallId: app.toolCallId, app });
    const issue = (app: SharedMcpAppDescriptor, id = 'alice') => tickets.issueMobileMcpAppTicket(actor(id), appSource(app));
    const prepare = (app: SharedMcpAppDescriptor, hostChannelId: string, tool = 'app_action') =>
      calls.prepareMobileMcpAppCall(actor(), { ...appSource(app), hostChannelId, requestId: randomUUID(), tool, arguments: { value: 'native-approved' } });
    const deliver = (issued: Awaited<ReturnType<typeof issue>>) => tickets.deliverMobileMcpAppTicket(new Request(issued.host.url,
      { headers: { host: 'localhost:3000' } }), new URL(issued.host.url).pathname.split('/')[2], 'host');

    const original = await saved(); const teamOriginal = await saved(teamConnection);
    const source = await access.readAuthorizedMobileMcpSource(actor(), appSource(original.app));
    const teamSource = await access.readAuthorizedMobileMcpSource(actor(), appSource(teamOriginal.app));
    assert.notEqual(original.app.connectionRef, teamOriginal.app.connectionRef);
    assert.notEqual(source.connectionId, teamSource.connectionId, 'Same display names do not choose the backend.');
    assert.equal(source.scope.shared?.connectionRef, original.app.connectionRef);
    const issued = await issue(original.app); const teamIssued = await issue(teamOriginal.app);
    const hostResponse = await deliver(issued); assert.equal(hostResponse.status, 200);
    const html = await hostResponse.text();
    assert(!html.includes('mcpAppAuthority') && !html.includes(source.connectionId));
    assert.equal((await deliver(teamIssued)).status, 200);
    console.log('PASS native v2 Org/Team exact references, saved gateway authority, original session and bounded private host.');

    let baseline = provider.requests.length;
    await expectAppDenied(() => access.readAuthorizedMobileMcpSource(actor('bob'), appSource(original.app)), [425]);
    await expectAppDenied(() => access.readAuthorizedMobileMcpSource({ ...actor(), workspaceId: 'personal-bob' }, appSource(original.app)));
    await expectAppDenied(() => tickets.requireMobileMcpAppChannel({ ...actor(), authSessionId: 'auth-alice-replacement' }, appSource(original.app), issued.host.channelId));
    await expectAppDenied(() => access.readAuthorizedMobileMcpSource(actor(), { ...appSource(original.app), app: { ...original.app, connectionRef: teamOriginal.app.connectionRef } }));
    assert.throws(() => readMobileMcpRender({ contractVersion: 1, toolCallId: 'forged', app: original.app }));
    assert.equal(provider.requests.length, baseline, 'Forged or replacement contexts cause zero provider I/O.');

    const businessBefore = provider.calls.filter(item => item.name === 'app_action').length;
    const prepared = await prepare(original.app, issued.host.channelId);
    assert.equal(prepared.call?.status, 'prepared'); assert(prepared.approval && prepared.call);
    const publicCall = JSON.stringify(prepared);
    assert(!publicCall.includes(source.connectionId) && !publicCall.includes('mcpAppAuthority') && !publicCall.includes('environmentRevision'));
    assert.equal(provider.calls.filter(item => item.name === 'app_action').length, businessBefore);
    const approved = await calls.decideMobileMcpAppCall(actor(), prepared.call.callId, 'approve', prepared.approval.token);
    assert.equal(approved.call?.status, 'completed');
    assert.equal(provider.calls.filter(item => item.name === 'app_action').length, businessBefore + 1);
    await calls.decideMobileMcpAppCall(actor(), prepared.call.callId, 'approve', prepared.approval.token);
    assert.equal((await calls.readMobileMcpAppCall(actor(), { callId: prepared.call.callId })).call?.status, 'completed');
    assert.equal(provider.calls.filter(item => item.name === 'app_action').length, businessBefore + 1, 'Claim and status never replay.');
    assert.equal((await calls.readMobileMcpAppCall({ ...actor(), authSessionId: 'auth-alice-replacement' }, { callId: prepared.call.callId })).call, null);
    const rejected = await prepare(original.app, issued.host.channelId); assert(rejected.call && rejected.approval);
    assert.equal((await calls.decideMobileMcpAppCall(actor(), rejected.call.callId, 'reject', rejected.approval.token)).call?.status, 'rejected');
    await calls.decideMobileMcpAppCall(actor(), rejected.call.callId, 'approve', rejected.approval.token);
    assert.equal(provider.calls.filter(item => item.name === 'app_action').length, businessBefore + 1);
    console.log('PASS actual shared SDK dispatch + isolated SQL: approval1, rejection0, duplicate0 and public DTO privacy.');

    await mutate(orgConnection, { grants: [{ ...grants[0], allowedToolNames: ['app_view'] }, grants[1], grants[2]] });
    const sourceOnly = await saved(); const sourceOnlyHost = await issue(sourceOnly.app);
    baseline = provider.requests.length;
    await expectAppDenied(() => prepare(sourceOnly.app, sourceOnlyHost.host.channelId));
    assert.equal(provider.requests.length, baseline, 'Source Use cannot grant target Use.');
    await mutate(orgConnection, { grants: [{ ...grants[0], allowedToolNames: ['app_action'] }, grants[1], grants[2]] });
    baseline = provider.requests.length; await expectAppDenied(() => issue(sourceOnly.app));
    assert.equal(provider.requests.length, baseline, 'Target Use cannot grant source HTML.');
    await mutate(orgConnection, { grants: [grants[0], { ...grants[1], canUse: true }, grants[2]] });
    const managerOwn = await saved(orgConnection, 'manager');
    await mutate(orgConnection, { grants }); baseline = provider.requests.length;
    await expectAppDenied(() => issue(managerOwn.app, 'manager'));
    assert.equal(provider.requests.length, baseline, 'Manage-only cannot reopen a prior own successful app.');

    const revocable = await saved(); const revocableHost = await issue(revocable.app);
    const revocableCall = await prepare(revocable.app, revocableHost.host.channelId); assert(revocableCall.call && revocableCall.approval);
    await mutate(orgConnection, { grants: [] }); baseline = provider.calls.length;
    await expectAppDenied(() => calls.decideMobileMcpAppCall(actor(), revocableCall.call!.callId, 'approve', revocableCall.approval!.token));
    assert.equal((await mobileMcpAppCallStore.get(actor(), revocableCall.call.callId))?.status, 'prepared');
    assert.equal(provider.calls.length, baseline); assert.equal((await deliver(revocableHost)).status, 404);
    await mutate(orgConnection, { grants });
    console.log('PASS independent source/target Use, Manage-only, revoke-before-claim and ticket404 without fallback.');

    const live = await saved(); const liveHost = await issue(live.app);
    const beforeLiveCall = provider.calls.length; let revokedDuringMetadata = false;
    provider.onList(async () => { revokedDuringMetadata = true; await mutate(orgConnection, { grants: [] }); });
    await expectAppDenied(() => prepare(live.app, liveHost.host.channelId));
    assert(revokedDuringMetadata); assert.equal(provider.calls.length, beforeLiveCall);
    await mutate(orgConnection, { grants });
    const lateBytes = await saved(); let revokedAfterBytes = false; const beforeBytes = provider.resourceReads.length;
    provider.onResource(async () => { revokedAfterBytes = true; await mutate(orgConnection, { grants: [] }); });
    await expectAppDenied(() => issue(lateBytes.app));
    assert(revokedAfterBytes); assert.equal(provider.resourceReads.length, beforeBytes + 1, 'Returned HTML bytes mint no ticket after revoke.');
    await mutate(orgConnection, { grants });

    const { UNRESTRICTED_INTEGRATION_POLICY } = await import('../app/lib/integration-tools/policy');
    const limited = await saved(orgConnection, 'alice', { ...UNRESTRICTED_INTEGRATION_POLICY, providerToolRules: [{ source: 'mcp',
      providerRef: createSharedIntegrationProviderRef(orgConnection.resource), allowedToolNames: ['app_view'], allowedOperations: null }] });
    const limitedHost = await issue(limited.app); baseline = provider.requests.length;
    await expectAppDenied(() => prepare(limited.app, limitedHost.host.channelId)); assert.equal(provider.requests.length, baseline);
    const fresh = await saved(); const freshHost = await issue(fresh.app);
    await raw.run('UPDATE "session" SET expires_at=$1 WHERE id=$2', [0, 'auth-alice']);
    assert.equal((await deliver(freshHost)).status, 404); baseline = provider.requests.length;
    await expectAppDenied(() => access.readAuthorizedMobileMcpSource(actor(), appSource(fresh.app)), [401]);
    assert.equal(provider.requests.length, baseline);
    await raw.run('UPDATE "session" SET expires_at=$1 WHERE id=$2', [expiresAt.getTime(), 'auth-alice']);
    const { sharedMcpScope } = await import('../app/lib/mcp/shared-access');
    const { sharedMcpSecretSlot, writeSharedMcpSecretSlot } = await import('../app/lib/mcp/shared-secrets');
    const administrator = await connections.authorizeIntegrationConnection(admin, orgConnection.resource.connectionRef, 'manage');
    const adminScope = sharedMcpScope(administrator);
    await writeSharedMcpSecretSlot(adminScope, sharedMcpSecretSlot(adminScope, 'TOKEN'), 'Bearer fixture-rotated-native');
    baseline = provider.requests.length; await expectAppDenied(() => issue(fresh.app)); assert.equal(provider.requests.length, baseline);
    const policyCurrent = await saved();
    await raw.run("UPDATE agents SET enabled_tools_json='[\"__none__\"]',revision=revision+1 WHERE agent_id='apps-agent'");
    baseline = provider.requests.length; await expectAppDenied(() => issue(policyCurrent.app)); assert.equal(provider.requests.length, baseline);
    console.log('PASS metadata/HTML real I/O races, saved policy ceiling, original auth expiry, credential binding and current agent revision.');
    console.log('PASS native Shared MCP Apps v2 (isolated PGlite/current SQL authority + actual gateway/MCP SDK; explicit external-seat/Auth-transport seams; no native/Bearer/device/model acceptance).');
  } finally {
    try { await (await import('../app/lib/mcp/manager')).closeAllMcpServers(); }
    finally {
      internals._load = originalLoad;
      const closure = await Promise.allSettled([provider.close(), database.close(), rm(root, { recursive: true, force: true })]);
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      if (closure.some(result => result.status === 'rejected')) throw new Error('Owned Mobile Shared MCP fixture closure is unconfirmed.');
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
