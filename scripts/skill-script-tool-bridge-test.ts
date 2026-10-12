import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { SkillScriptDeclaration, SkillScriptToolRequirement } from '../app/lib/skills/script-runtime/contracts';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { startIntegrationToolBrowserProvider, BROWSER_MCP_TOOL, BROWSER_COMPOSIO_TOOL } from './fixtures/integration-tool-browser-provider';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-script-bridge-'));
  const provider = await startIntegrationToolBrowserProvider();
  const env = { DATA: root, CANVAS_DATA_ROOT: root, COMPOSIO_BASE_URL: provider.baseUrl, COMPOSIO_API_KEY: 'inert-script-provider-fixture',
    CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false', QMD_ENABLED: 'false',
    MCP_ALLOW_PRIVATE_NETWORK: 'true', MCP_ALLOW_INSECURE_HTTP: 'true', MCP_ALLOW_STDIO: 'false',
    BASE_URL: 'http://localhost:3000', BETTER_AUTH_BASE_URL: 'http://localhost:3000' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const database = await createPiTestDatabase(), raw = await database.openDb();
  const piCore = await import('@earendil-works/pi-agent-core');
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  loader._load = (name, parent, isMain) => {
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    if (name === '@earendil-works/pi-agent-core') return piCore;
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
      getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false,
    };
    return original(name, parent, isMain);
  };
  let closeMcp: (() => Promise<void>) | undefined;
  try {
    await raw.run("INSERT INTO \"user\" (id,name,email,role,email_verified,banned,created_at,updated_at) VALUES ('actor','Actor','actor@bridge.example.test','admin',1,0,1,1)");
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('bridge-org','actor','team',1,1,1)");
    await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('bridge-org','actor','owner','active',1,1,1)");
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ('bridge-workspace','bridge-org','personal','actor','workspaces/actor/files','Actor','active',1,1)");
    const names = ['mcp', 'COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'composio_execute', 'read', 'email_read_message', 'email_list_mailboxes', 'email_create_outbox_draft', 'email_update_outbox_draft'];
    await raw.run("INSERT INTO agents (agent_id,name,type,access_policy,scope_type,organization_id,owner_user_id,enabled_tools_json,revision,created_at,updated_at) VALUES ('bridge-agent','Bridge','special','restricted','organization','bridge-org','actor',$1,1,1,1)", [JSON.stringify(names)]);
    await raw.run("INSERT INTO agent_grants (id,agent_id,organization_id,target_type,target_id,can_use,can_edit,can_manage,created_at,updated_at) VALUES ('bridge-grant','bridge-agent','bridge-org','user','actor',1,0,0,1,1)");
    const { piSessions, emailAccounts, emailDrafts } = await import('../app/lib/db/schema');
    await database.db.insert(piSessions).values({ sessionId: 'bridge-session', userId: 'actor', agentId: 'bridge-agent', workspaceId: 'bridge-workspace',
      workspaceType: 'personal', organizationId: 'bridge-org', provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    await database.db.insert(emailAccounts).values({ id: 'native-account', userId: 'actor', provider: 'smtp_imap', authType: 'smtp_imap',
      emailAddress: 'actor@bridge.example.test', policyJson: JSON.stringify({ readFrom: [], sendTo: [] }), secretRef: 'fixture-not-read', createdAt: new Date(), updatedAt: new Date() });
    const { serverPreferencesPath } = await import('../app/lib/terminal-policy');
    await fs.mkdir(path.dirname(serverPreferencesPath()), { recursive: true });
    await fs.writeFile(serverPreferencesPath(), JSON.stringify({ settings: { integrationToolGatewayEnabled: true } }));
    const { writeMcpConfigRaw } = await import('../app/lib/mcp/config');
    await writeMcpConfigRaw(JSON.stringify({ mcpServers: { script_design: { type: 'http', url: provider.mcpUrl, enabled: true, displayName: 'Script MCP' } } }), { userId: 'actor' });
    closeMcp = (await import('../app/lib/mcp/manager')).closeAllMcpServers;
    const { ensureDefaultComposioProfile } = await import('../app/lib/composio/composio-profiles');
    await ensureDefaultComposioProfile('actor');
    const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
    const { getPiTools } = await import('../app/lib/pi/tool-registry');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { isIntegrationGatewayTool } = await import('../app/lib/pi/integration-tool-gateway');
    const { isProgressiveGatewayTool } = await import('../app/lib/pi/progressive-tool-gateway');
    const { createSkillScriptToolBridge } = await import('../app/lib/skills/script-runtime/tool-bridge');
    const context: AgentExecutionContext = { ...await resolveAgentExecutionContextForStoredSession({ userId: 'actor', sessionId: 'bridge-session', agentId: 'bridge-agent' }), agentTurnId: 'bridge-turn' };
    const revalidate = async () => ({ ...await resolveAgentExecutionContextForStoredSession({ userId: 'actor', sessionId: 'bridge-session', agentId: 'bridge-agent' }), agentTurnId: context.agentTurnId });
    const loadTools = (current: AgentExecutionContext) => getPiTools('actor', 'bridge-agent', 'bridge-session', { executionContext: current, strictAuthorization: true });
    const selectedTools = await loadTools(context), gateway = selectedTools.find(isIntegrationGatewayTool)!;
    assert(gateway, 'The actual filtered integration gateway is assigned to the actual actor.');
    const invoke = async (request: unknown) => {
      const result = await runWithAgentExecutionContext(context, () => gateway.execute('fixture', request as never));
      const details = result.details as Record<string, unknown>; assert.equal(details.integrationError, undefined, JSON.stringify(details.integrationError)); return details;
    };
    const page = await invoke({ action: 'list', target: 'providers' });
    const providers = page.providers as Array<{ providerRef: string; source: string }>;
    const bindings: Array<{ alias: string; toolRef: string; schemaRef: string }> = [];
    for (const [source, toolName] of [['mcp', BROWSER_MCP_TOOL], ['composio', BROWSER_COMPOSIO_TOOL]] as const) {
      const providerRef = providers.find(candidate => candidate.source === source)?.providerRef;
      assert(providerRef, `The actual ${source} connection is present.`);
      const toolPage = await invoke({ action: 'list', target: 'tools', providerRef });
      const toolRef = (toolPage.tools as Array<{ name: string; toolRef: string }>).find(tool => tool.name === toolName)!.toolRef;
      const schema = await invoke({ action: 'describe', toolRef });
      bindings.push({ alias: source, toolRef, schemaRef: schema.schemaRef as string });
    }
    const tools: SkillScriptToolRequirement[] = [
      { alias: 'draft', kind: 'native', toolName: 'email_create_outbox_draft' },
      { alias: 'mcp', kind: 'integration', source: 'mcp', toolName: BROWSER_MCP_TOOL },
      { alias: 'composio', kind: 'integration', source: 'composio', application: 'canva', toolName: BROWSER_COMPOSIO_TOOL },
    ];
    const entry: SkillScriptDeclaration = { id: 'bridge', path: 'scripts/main.js', runtime: { kind: 'node' }, argumentsSchema: { type: 'object' }, tools, outputs: [] };
    const stopped: string[] = [];
    const create = (changes: Partial<Parameters<typeof createSkillScriptToolBridge>[0]> = {}) => createSkillScriptToolBridge({ entry, scriptRef: 'fixture-script', context,
      selectedBindings: bindings, loadTools, revalidate, onTerminate: reason => stopped.push(reason), ...changes });
    const bridge = create();
    const countBefore = provider.calls().executions.length;
    await bridge.prepare(); assert.equal(provider.calls().executions.length, countBefore, 'Readiness executes no provider business operation.');
    let id = 0;
    const describe = async (alias: string) => {
      const response = await bridge.handle({ version: 1, id: ++id, action: 'describe', alias });
      assert.equal(response.ok, true, JSON.stringify(response));
      return (response.data as { schemaHandle: string }).schemaHandle;
    };
    const nativeSchema = await describe('draft');
    const native = await bridge.handle({ version: 1, id: ++id, action: 'call', alias: 'draft', schemaHandle: nativeSchema,
      arguments: { mailboxId: 'account:native-account', to: ['review@bridge.example.test'], subject: 'Review this script draft', bodyMarkdown: 'Generated by the bounded script bridge.' } });
    assert.equal(native.ok, true, JSON.stringify(native));
    const stored = await database.db.select().from(emailDrafts);
    assert.equal(stored.length, 1); assert.equal(stored[0].outboxStatus, 'awaiting_review'); assert.equal(stored[0].sentAt, null);
    assert.equal((bridge.results[0].result.details as { uiIntent: { view: string } }).uiIntent.view, 'review-draft', 'The native Outbox review UI survives in the host result.');
    assert(!JSON.stringify(native).includes('fixture-not-read'), 'Native account credentials are never serialized into the FD result.');
    for (const source of ['mcp', 'composio']) {
      const schemaHandle = await describe(source);
      const args = source === 'mcp' ? { design_query: 'script-query' } : { query: 'script-query' };
      const response = await bridge.handle({ version: 1, id: ++id, action: 'call', alias: source, schemaHandle, arguments: args });
      assert.equal(response.ok, true, JSON.stringify(response));
    }
    assert.equal(provider.calls().executions.length, countBefore + 2);
    assert(provider.calls().executions.every(call => call.exactBinding && call.successful));
    assert.equal(bridge.results.length, 3); bridge.close();
    assert.throws(() => create({ entry: { ...entry, tools: [{ alias: 'escape', kind: 'native', toolName: 'bash' }] }, selectedBindings: [] }), { code: 'SCRIPT_TOOL_DENIED' });
    assert.throws(() => create({ entry: { ...entry, tools: [{ alias: 'escape', kind: 'native', toolName: 'mcp_unverified' }] }, selectedBindings: [] }), { code: 'SCRIPT_TOOL_DENIED' });
    for (const alias of ['read-input', '1input', 'read.input']) {
      const compatible = create({ entry: { ...entry, tools: [{ alias, kind: 'native', toolName: 'email_create_outbox_draft' }] }, selectedBindings: [] });
      await compatible.prepare(); compatible.close();
    }
    assert.throws(() => create({ selectedBindings: [] }), { code: 'SCRIPT_TOOL_DENIED' });
    const mismatched = create({ entry: { ...entry, tools: [{ alias: 'composio', kind: 'integration', source: 'composio', application: 'slack', toolName: BROWSER_COMPOSIO_TOOL }] }, selectedBindings: [bindings[1]] });
    await assert.rejects(mismatched.prepare(), { code: 'SCRIPT_TOOL_DENIED' });
    assert.equal(provider.calls().executions.length, countBefore + 2);
    const denied = create();
    await raw.run("UPDATE agents SET enabled_tools_json='[\"__none__\"]',revision=revision+1 WHERE agent_id='bridge-agent'");
    await assert.rejects(denied.prepare(), { code: 'SCRIPT_TOOL_DENIED' });
    await raw.run("UPDATE agents SET enabled_tools_json=$1,revision=revision+1 WHERE agent_id='bridge-agent'", [JSON.stringify(names)]);
    const replay = create({ entry: { ...entry, tools: [] }, selectedBindings: [] });
    await replay.handle({ version: 1, id: 1, action: 'describe', alias: 'undeclared' });
    const duplicated = await replay.handle({ version: 1, id: 1, action: 'describe', alias: 'undeclared' });
    assert.equal(duplicated.error?.code, 'SCRIPT_PROTOCOL_INVALID'); assert.equal(duplicated.terminate, true);
    const oversized = create({ entry: { ...entry, tools: [] }, selectedBindings: [] });
    assert.equal((await oversized.handle({ version: 1, id: 1, action: 'call', alias: 'none', arguments: { payload: 'x'.repeat(70_000) } })).error?.code, 'SCRIPT_LIMIT_EXCEEDED');
    const nativeOnly = { ...entry, tools: [tools[0]] };
    const output = create({ entry: nativeOnly, selectedBindings: [], loadTools: async current => (await loadTools(current)).map(tool => tool.name !== 'email_create_outbox_draft'
      && (!isProgressiveGatewayTool(tool) || !tool.progressiveGateway.operations.some(operation => operation.name === 'email_create_outbox_draft')) ? tool : {
      ...tool, execute: async (...args: Parameters<typeof tool.execute>) => {
        const actual = await tool.execute(...args);
        return { ...actual, content: [...actual.content, { type: 'text' as const, text: 'x'.repeat(70_000) }] };
      },
    }) });
    const outputSchema = await output.handle({ version: 1, id: 1, action: 'describe', alias: 'draft' });
    const draftArgs = { mailboxId: 'account:native-account', to: ['review@bridge.example.test'], subject: 'Bounded output', bodyMarkdown: 'Review this result.' };
    const outputResult = await output.handle({ version: 1, id: 2, action: 'call', alias: 'draft', schemaHandle: (outputSchema.data as { schemaHandle: string }).schemaHandle, arguments: draftArgs });
    assert.equal(outputResult.error?.outcome, 'completed'); assert.equal(outputResult.terminate, true);
    assert.equal((await database.db.select().from(emailDrafts)).length, 2, 'The large known result is one actual native Outbox mutation.');
    assert.equal(output.results[0].result.content[0].type, 'text');
    const uncertain = create({ entry: nativeOnly, selectedBindings: [] });
    const uncertainSchema = await uncertain.handle({ version: 1, id: 1, action: 'describe', alias: 'draft' });
    const findDraft = database.db.query.emailDrafts.findFirst.bind(database.db.query.emailDrafts);
    let loseDraftResponse = true;
    Object.defineProperty(database.db.query.emailDrafts, 'findFirst', { configurable: true, writable: true, value: async (...args: Parameters<typeof findDraft>) => {
      if (loseDraftResponse) { loseDraftResponse = false; throw new Error('SECRET native DB connection lost after the actual insert'); }
      return findDraft(...args);
    } });
    const unknown = await uncertain.handle({ version: 1, id: 2, action: 'call', alias: 'draft', schemaHandle: (uncertainSchema.data as { schemaHandle: string }).schemaHandle,
      arguments: { ...draftArgs, subject: 'Unconfirmed actual native insert', bodyMarkdown: 'Review manually.' } });
    Object.defineProperty(database.db.query.emailDrafts, 'findFirst', { configurable: true, writable: true, value: findDraft });
    assert.equal(unknown.error?.outcome, 'unknown'); assert.equal(unknown.terminate, true); assert(!JSON.stringify(unknown).includes('SECRET'));
    assert.equal((await database.db.select().from(emailDrafts)).length, 3, 'The lost DB response follows a real native mutation; no authorization/service was mocked.');
    assert.equal((await raw.all('SELECT * FROM integration_turn_outcomes')).length, 1, 'Native uncertainty is durable in the existing source-neutral turn store.');
    await assert.rejects(create().prepare(), { code: 'SCRIPT_OUTCOME_UNKNOWN' });
    assert.equal(provider.calls().executions.length, countBefore + 2, 'Uncertain native dispatch prevents fallback to MCP or Composio.');
    const readTurn = 'native-read-failure';
    const readBridge = create({ entry: { ...entry, tools: [{ alias: 'file', kind: 'native', toolName: 'read' },
      { alias: 'message', kind: 'native', toolName: 'email_read_message' }, { alias: 'mailboxes', kind: 'native', toolName: 'email_list_mailboxes' }] }, selectedBindings: [],
      context: { ...context, agentTurnId: readTurn }, revalidate: async () => ({ ...await revalidate(), agentTurnId: readTurn }) });
    await readBridge.prepare();
    const noWriteBefore = (await database.db.select().from(emailDrafts)).length;
    let readId = 0;
    for (const [alias, args] of [['file', { path: 'not-existing-script-input.txt' }], ['message', { mailboxId: 'account:native-account' }]] as const) {
      const schema = await readBridge.handle({ version: 1, id: ++readId, action: 'describe', alias });
      assert.equal(schema.ok, true, JSON.stringify(schema));
      const failure = await readBridge.handle({ version: 1, id: ++readId, action: 'call', alias, schemaHandle: (schema.data as { schemaHandle: string }).schemaHandle, arguments: args });
      assert.equal(failure.ok, false); assert.equal(failure.error?.code, 'SCRIPT_EXECUTION_FAILED', JSON.stringify(failure));
      assert.equal(failure.error?.outcome, 'completed'); assert.equal(failure.terminate, undefined); assert.match(failure.error!.message, /read operation failed/u);
    }
    const mailboxesSchema = await readBridge.handle({ version: 1, id: ++readId, action: 'describe', alias: 'mailboxes' });
    const continued = await readBridge.handle({ version: 1, id: ++readId, action: 'call', alias: 'mailboxes', schemaHandle: (mailboxesSchema.data as { schemaHandle: string }).schemaHandle, arguments: {} });
    assert.equal(continued.ok, true, JSON.stringify(continued));
    assert.equal((await database.db.select().from(emailDrafts)).length, noWriteBefore, 'Known native file/email read failures and continuation create no Outbox mutation.');
    assert.equal((await raw.all('SELECT * FROM integration_turn_outcomes WHERE agent_turn_id=$1', [readTurn])).length, 0, 'Known read failures do not create an uncertain mutation barrier.');
    readBridge.close();
    const wrapNativeTransport = (load: typeof loadTools, response: (result: AgentToolResult<unknown>) => Promise<AgentToolResult<unknown>>) => async (current: AgentExecutionContext): Promise<AgentTool[]> =>
      (await load(current)).map(tool => tool.name !== 'email_create_outbox_draft'
        && (!isProgressiveGatewayTool(tool) || !tool.progressiveGateway.operations.some(operation => operation.name === 'email_create_outbox_draft')) ? tool
        : { ...tool, execute: async (...args: Parameters<typeof tool.execute>) => response(await tool.execute(...args)) });
    const turnBridge = (turn: string, changes: Partial<Parameters<typeof createSkillScriptToolBridge>[0]> = {}) => create({ entry: nativeOnly, selectedBindings: [],
      context: { ...context, agentTurnId: turn }, revalidate: async () => ({ ...await revalidate(), agentTurnId: turn }), ...changes });
    const nativeHandle = async (target: ReturnType<typeof create>) => {
      const schema = await target.handle({ version: 1, id: 1, action: 'describe', alias: 'draft' });
      assert.equal(schema.ok, true, JSON.stringify(schema));
      return (schema.data as { schemaHandle: string }).schemaHandle;
    };
    for (const mode of ['abort', 'deadline'] as const) {
      let entered!: () => void, release!: () => void;
      const dispatched = new Promise<void>(resolve => { entered = resolve; });
      const delayed = new Promise<void>(resolve => { release = resolve; });
      const controller = new AbortController(), turn = `native-${mode}`;
      const pendingBridge = turnBridge(turn, { signal: controller.signal,
        loadTools: wrapNativeTransport(loadTools, async actual => { entered(); await delayed; return actual; }) });
      const schemaHandle = await nativeHandle(pendingBridge);
      const before = (await database.db.select().from(emailDrafts)).length;
      if (mode === 'deadline') mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const pendingCall = pendingBridge.handle({ version: 1, id: 2, action: 'call', alias: 'draft', schemaHandle,
          arguments: { ...draftArgs, subject: `Actual native ${mode} response lost` } });
        await dispatched;
        if (mode === 'abort') controller.abort(); else mock.timers.tick(30_001);
        const response = await pendingCall;
        assert.equal(response.error?.outcome, 'unknown', JSON.stringify(response));
        assert.equal(response.terminate, true);
        assert.equal((await database.db.select().from(emailDrafts)).length, before + 1, 'Timeout/abort follows exactly one actual native mutation.');
        assert.equal((await raw.all('SELECT * FROM integration_turn_outcomes WHERE agent_turn_id=$1', [turn])).length, 1);
        await assert.rejects(turnBridge(turn).prepare(), { code: 'SCRIPT_OUTCOME_UNKNOWN' });
      } finally { if (mode === 'deadline') mock.timers.reset(); release(); pendingBridge.close(); }
    }
    const persistenceTurn = 'native-persistence-failure';
    const transaction = database.db.transaction.bind(database.db);
    let failPersistence = false;
    Object.defineProperty(database.db, 'transaction', { configurable: true, writable: true, value: (...args: Parameters<typeof transaction>) => {
      if (failPersistence) return Promise.reject(new Error('SECRET outcome store unavailable after business dispatch'));
      return transaction(...args);
    } });
    try {
      const failureBridge = turnBridge(persistenceTurn, { loadTools: wrapNativeTransport(loadTools, async () => {
        failPersistence = true; throw new Error('SECRET native response lost after real Outbox insert');
      }) });
      const schemaHandle = await nativeHandle(failureBridge);
      const response = await failureBridge.handle({ version: 1, id: 2, action: 'call', alias: 'draft', schemaHandle, arguments: draftArgs });
      assert.equal(response.error?.outcome, 'unknown'); assert.equal(response.terminate, true);
      assert.match(response.error!.message, /durable status could not be confirmed/u); assert(!JSON.stringify(response).includes('SECRET'));
      assert.equal(stopped.at(-1), 'SCRIPT_OUTCOME_UNKNOWN');
      assert.equal((await raw.all('SELECT * FROM integration_turn_outcomes WHERE agent_turn_id=$1', [persistenceTurn])).length, 0);
      failPersistence = false;
      await assert.rejects(turnBridge(persistenceTurn).prepare(), { code: 'SCRIPT_OUTCOME_UNKNOWN' });
    } finally { Object.defineProperty(database.db, 'transaction', { configurable: true, writable: true, value: transaction }); }
    const { DEFAULT_AGENT_ID } = await import('../app/lib/channels/constants');
    const { getAgentProfile } = await import('../app/lib/agents/registry');
    const { createPiDelegation, claimQueuedPiDelegation } = await import('../app/lib/pi/delegation-store');
    await getAgentProfile(DEFAULT_AGENT_ID);
    await database.db.insert(piSessions).values({ sessionId: 'native-parent', userId: 'actor', agentId: DEFAULT_AGENT_ID,
      workspaceId: 'bridge-workspace', workspaceType: 'personal', organizationId: 'bridge-org', provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    await database.db.insert(piSessions).values({ sessionId: 'native-worker', userId: 'actor', agentId: 'bridge-agent',
      workspaceId: 'bridge-workspace', workspaceType: 'personal', organizationId: 'bridge-org', sessionKind: 'delegation_worker', parentSessionId: 'native-parent',
      delegationDepth: 1, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    await createPiDelegation({ id: 'native-task', userId: 'actor', sourceSessionId: 'native-parent', sourceAgentId: DEFAULT_AGENT_ID,
      sourceAgentTurnId: 'native-parent-turn', workerSessionId: 'native-worker', targetAgentId: 'bridge-agent', workerType: 'managed', goal: 'Prepare a draft for human review', toolsets: ['email'] });
    await claimQueuedPiDelegation('native-task', 'bridge-fixture');
    const workerRevalidate = async () => ({ ...await resolveAgentExecutionContextForStoredSession({ userId: 'actor', sessionId: 'native-worker', agentId: 'bridge-agent' }), agentTurnId: 'native-worker-turn' });
    const workerLoad = (current: AgentExecutionContext) => getPiTools(current.userId, current.agentId!, current.sessionId, { executionContext: current, strictAuthorization: true });
    const worker = create({ entry: nativeOnly, selectedBindings: [], context: await workerRevalidate(), revalidate: workerRevalidate,
      loadTools: wrapNativeTransport(workerLoad, async () => { throw new Error('SECRET delegated native response lost after the actual mutation'); }) });
    await worker.prepare();
    const workerSchema = await nativeHandle(worker);
    const workerResult = await worker.handle({ version: 1, id: 2, action: 'call', alias: 'draft', schemaHandle: workerSchema, arguments: draftArgs });
    assert.equal(workerResult.error?.outcome, 'unknown'); assert.equal(workerResult.terminate, true);
    assert.equal((await raw.all("SELECT * FROM integration_turn_outcomes WHERE agent_turn_id IN ('native-worker-turn','native-parent-turn')")).length, 2,
      'Actual task provenance persists uncertainty for both worker and issuing parent turns.');
    const parentContext = { ...await resolveAgentExecutionContextForStoredSession({ userId: 'actor', sessionId: 'native-parent', agentId: DEFAULT_AGENT_ID }), agentTurnId: 'native-parent-turn' };
    const parentBridge = create({ entry: { ...entry, tools: [] }, selectedBindings: [], context: parentContext,
      revalidate: async () => ({ ...await resolveAgentExecutionContextForStoredSession({ userId: 'actor', sessionId: 'native-parent', agentId: DEFAULT_AGENT_ID }), agentTurnId: 'native-parent-turn' }), loadTools: workerLoad });
    await assert.rejects(parentBridge.prepare(), { code: 'SCRIPT_OUTCOME_UNKNOWN' });
    assert.equal(provider.calls().executions.length, countBefore + 2, 'Native lifecycle/worker failures execute no integration alternative.');
    console.log('PASS script bridge: actual SQL agent/context and Native Outbox review, real MCP/Composio SDK wrappers/exact accounts, declaration/selection/rights, alias contract, frame budgets, known read failures/continuation, completion overflow, abort/deadline, durable uncertainty/persistence failure and worker-parent barrier.');
  } finally {
    await closeMcp?.(); loader._load = original; await database.close(); await provider.close(); await fs.rm(root, { recursive: true, force: true });
    for (const key of Object.keys(env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
