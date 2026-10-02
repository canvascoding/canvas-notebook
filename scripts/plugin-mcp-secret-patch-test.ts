import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { McpAuthorizationError } from '../app/lib/desktop/mcp-oauth-client';
import { collectMcpEnvEntries, toMcpServerDraft, updateMcpConfigRawServer, type McpServerDraft } from '../app/components/settings/McpServerDialog';

type SetupState = { connector: { name: string }; pluginName: string; draft: McpServerDraft; originalName?: string; rawContent: string; isSaving: boolean; error: string | null; errorCode?: string };
type Request = { url: string; method: string; body: Record<string, unknown> };

async function main() {
  // Execute the actual component callback with its closure dependencies. This also
  // catches an accidental return to GET-all / PUT without mounting unrelated UI.
  const source = await fs.readFile('app/components/plugins/PluginsPanel.tsx', 'utf8');
  const parsed = ts.createSourceFile('SkillsPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const handlers: ts.FunctionDeclaration[] = [];
  let setupHandler: ts.FunctionDeclaration | undefined;
  let workspaceEffect: ts.Expression | undefined;
  const find = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'savePluginMcpServer') handlers.push(node);
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'openPluginMcpSetup') setupHandler = node;
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'useEffect'
      && node.arguments[1]?.getText(parsed) === '[activeWorkspaceId]' && node.arguments[0]?.getText(parsed).includes('mcpAuthorizationRef')) workspaceEffect = node.arguments[0];
    ts.forEachChild(node, find);
  };
  find(parsed);
  assert.equal(handlers.length, 1);
  const handler = ts.transpileModule(handlers[0].getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const script = new vm.Script(`${handler}\nsavePluginMcpServer();`);
  const server = { url: 'https://plugin.example.test/mcp', auth: 'none', bearerTokenEnv: 'MCP_PLUGIN_TOKEN', connectionId: 'plugin-connection', futurePlugin: { keep: true } };
  const draft = { ...toMcpServerDraft('plugin', server), bearerTokenValue: 'fixture-plugin-new' };
  const rawContent = JSON.stringify({ mcpServers: { plugin: server } });
  const run = async (options: { draft?: McpServerDraft; rawContent?: string; failEnv?: boolean; failConfig?: boolean; malformedEnv?: boolean; obsoleteAt?: 'env' | 'config' | 'refresh'; workspaceRoundTrip?: boolean } = {}) => {
    let state: SetupState = { connector: { name: 'plugin' }, pluginName: 'fixture-plugin', draft: options.draft || draft, originalName: 'plugin', rawContent: options.rawContent ?? rawContent, isSaving: false, error: null };
    const requests: Request[] = [];
    const values = new Map([['UNRELATED_SECRET', 'fixture-unrelated'], ['MCP_PLUGIN_TOKEN', 'fixture-old']]);
    const events: Array<{ type: string; detail: { secretScope: string } }> = [];
    let readinessRefreshes = 0;
    const empty = { ...state, connector: null, isSaving: false };
    const mcpSetupRequestRef = { current: 1 };
    const activeWorkspaceRef = { current: 'workspace-one' };
    let replacement: SetupState | undefined;
    const invalidate = () => {
      mcpSetupRequestRef.current += 1;
      if (options.workspaceRoundTrip) {
        activeWorkspaceRef.current = 'workspace-two';
        mcpSetupRequestRef.current += 1;
        activeWorkspaceRef.current = 'workspace-one';
      }
      replacement = { ...state, connector: { name: 'new-plugin' }, pluginName: 'new-plugin', draft: toMcpServerDraft('new-plugin', { url: 'https://new.example.test/mcp' }), isSaving: false, error: null };
      state = replacement;
    };
    const context = vm.createContext({
      mcpSetupState: state,
      mcpSetupRequestRef, activeWorkspaceRef, activeWorkspaceId: 'workspace-one',
      setMcpSetupState: (update: ((current: SetupState) => SetupState) | SetupState) => { state = typeof update === 'function' ? update(state) : update; },
      EMPTY_PLUGIN_MCP_SETUP_STATE: empty,
      collectMcpEnvEntries, updateMcpConfigRawServer, McpAuthorizationError, Error,
      t: () => 'Localized save error',
      storeByName: new Map(),
      loadPluginData: async () => { readinessRefreshes += 1; if (options.obsoleteAt === 'refresh') invalidate(); },
      checkStorePluginPreflight: () => { throw new Error('Unexpected preflight in fixture'); },
      CustomEvent: class { constructor(readonly type: string, readonly options: { detail: { secretScope: string } }) {} get detail() { return this.options.detail; } },
      window: { dispatchEvent: (event: { type: string; detail: { secretScope: string } }) => { events.push(event); return true; } },
      fetch: async (url: string, init: RequestInit) => {
        assert.equal(init.credentials, 'include');
        assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/json');
        const body = JSON.parse(String(init.body));
        requests.push({ url, method: init.method || 'GET', body });
        if (url === '/api/integrations/env') {
          assert.equal(init.method, 'PATCH');
          assert.deepEqual(body, { scope: 'integrations', secretScope: 'user', patches: [{ key: 'MCP_PLUGIN_TOKEN', value: 'fixture-plugin-new' }] });
          if (options.obsoleteAt === 'env') invalidate();
          if (options.malformedEnv) return new Response('invalid-json', { status: 503 });
          if (options.failEnv) return Response.json({ success: false, code: 'master_key_missing', error: 'Safe restore message' }, { status: 503 });
          for (const patch of body.patches) values.set(patch.key, patch.value);
          return Response.json({ success: true });
        }
        assert.equal(url, '/api/integrations/mcp-config'); assert.equal(init.method, 'PUT');
        if (options.obsoleteAt === 'config') invalidate();
        if (options.failConfig) return Response.json({ success: false, code: 'decryption_failed', error: 'Safe config error' }, { status: 503 });
        const next = JSON.parse(body.rawContent).mcpServers.plugin;
        assert.deepEqual(next, server);
        assert.equal(body.rawContent.includes('fixture-plugin-new'), false);
        return Response.json({ success: true });
      },
    });
    await script.runInContext(context);
    return { state, requests, values, events, empty, readinessRefreshes, replacement };
  };

  const success = await run();
  assert.deepEqual(success.requests.map(request => request.method), ['PATCH', 'PUT']);
  assert.equal(success.values.get('UNRELATED_SECRET'), 'fixture-unrelated');
  assert.equal(success.values.get('MCP_PLUGIN_TOKEN'), 'fixture-plugin-new');
  assert.equal(success.events.length, 1); assert.equal(success.events[0].detail.secretScope, 'user');
  assert.equal(success.state, success.empty, 'successful save closes/reset the actual setup state');
  assert.equal(success.readinessRefreshes, 1, 'successful MCP setup refreshes installed connection readiness');
  for (const invalid of [{ draft: { ...draft, name: '' } }, { draft: { ...draft, url: '' } }, { rawContent: '{' }]) {
    const result = await run(invalid);
    assert.equal(result.requests.length, 0, 'local validation happens before any credential write');
    assert.equal(result.events.length, 0); assert.equal(result.state.isSaving, false); assert.ok(result.state.error);
    assert.equal(result.readinessRefreshes, 0);
    assert.equal(result.values.get('MCP_PLUGIN_TOKEN'), 'fixture-old');
  }
  const failedEnv = await run({ failEnv: true });
  assert.equal(failedEnv.requests.length, 1); assert.equal(failedEnv.events.length, 0);
  assert.equal(failedEnv.state.errorCode, 'master_key_missing'); assert.equal(failedEnv.state.error, 'Safe restore message');
  assert.equal(failedEnv.values.get('MCP_PLUGIN_TOKEN'), 'fixture-old');
  const invalidResponse = await run({ malformedEnv: true });
  assert.equal(invalidResponse.requests.length, 1); assert.equal(invalidResponse.state.errorCode, 'request_failed'); assert.equal(invalidResponse.state.error, 'Localized save error');
  const failedConfig = await run({ failConfig: true });
  assert.equal(failedConfig.state.errorCode, 'decryption_failed'); assert.equal(failedConfig.state.isSaving, false);
  assert.equal(failedConfig.readinessRefreshes, 0, 'failed setup cannot report refreshed connection readiness');
  assert.equal(failedConfig.values.get('UNRELATED_SECRET'), 'fixture-unrelated');

  for (const obsoleteAt of ['env', 'config', 'refresh'] as const) {
    for (const failConfig of [false, true]) {
      const result = await run({ obsoleteAt, failConfig, workspaceRoundTrip: obsoleteAt === 'config' });
      if (!result.replacement) continue;
      assert.equal(result.state, result.replacement, 'old save success/error cannot close or modify a newer MCP setup');
      assert.equal(result.state.isSaving, false);
      assert.equal(result.state.error, null);
      if (obsoleteAt === 'env') assert.equal(result.requests.length, 1, 'obsolete credential save cannot proceed to a config write');
      if (obsoleteAt === 'config') assert.equal(result.readinessRefreshes, 0, 'obsolete save cannot refresh the old plugin preflight');
    }
  }

  assert.ok(setupHandler);
  const setupScript = new vm.Script(`${ts.transpileModule(setupHandler.getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText}\nopenPluginMcpSetup;`);
  for (const workspaceRoundTrip of [false, true]) {
    let loadedState: Record<string, unknown> = {};
    const mcpSetupRequestRef = { current: 0 };
    const activeWorkspaceRef = { current: 'workspace-one' };
    const pendingTemplates = new Map<string, (response: Response) => void>();
    const setupContext = vm.createContext({
      activeWorkspaceId: 'workspace-one', activeWorkspaceRef, mcpSetupRequestRef, managementScope: 'user', Promise,
      composioHeaders: () => ({ 'Content-Type': 'application/json' }),
      t: () => 'Localized template error', Error, toMcpServerDraft,
      parseMcpConfigFile: (raw: string) => JSON.parse(raw),
      createMcpServerDraftFromConnector: (connector: { name: string }, config?: Record<string, unknown>) => toMcpServerDraft(connector.name, config || { url: 'https://fallback.example.test/mcp' }),
      setMcpSetupState: (update: ((current: Record<string, unknown>) => Record<string, unknown>) | Record<string, unknown>) => { loadedState = typeof update === 'function' ? update(loadedState) : update; },
      fetch: async (url: string, init: RequestInit) => {
        if (url === '/api/integrations/mcp-config') return Response.json({ success: true, data: { rawContent: '{"mcpServers":{}}' } });
        assert.equal(url, '/api/plugins/mcp-template');
        const { connector } = JSON.parse(String(init.body));
        return new Promise<Response>(resolve => { pendingTemplates.set(connector, resolve); });
      },
    });
    const open = setupScript.runInContext(setupContext) as (options: { pluginName: string; source: string; connector: { name: string } }) => Promise<void>;
    const original = open({ pluginName: 'first-plugin', source: 'store', connector: { name: 'first' } });
    if (workspaceRoundTrip) {
      activeWorkspaceRef.current = 'workspace-two'; mcpSetupRequestRef.current += 1;
      activeWorkspaceRef.current = 'workspace-one'; mcpSetupRequestRef.current += 1;
    }
    const replacement = open({ pluginName: 'second-plugin', source: 'store', connector: { name: 'second' } });
    pendingTemplates.get('second')!(Response.json({ success: true, template: { config: { url: 'https://second.example.test/mcp' } } }));
    await replacement;
    const current = loadedState;
    assert.equal((current.draft as McpServerDraft).url, 'https://second.example.test/mcp');
    pendingTemplates.get('first')!(Response.json({ success: true, template: { config: { url: 'https://first.example.test/mcp' } } }));
    await original;
    assert.equal(loadedState, current, 'stale setup load cannot replace the newer dialog, including a workspace A→B→A round trip');
  }

  assert.ok(workspaceEffect);
  const effectScript = new vm.Script(ts.transpileModule(`(${workspaceEffect.getText(parsed)})();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText);
  const closedSetup = { open: false, isLoading: false };
  let pendingSetup: object = { open: true, isLoading: true };
  const controller = new AbortController();
  let cancelledFlows = 0;
  const context = vm.createContext({
    mcpSetupRequestRef: { current: 0 },
    connectorFlowRequestRef: { current: 0 },
    mcpAuthorizationRef: { current: { controller, flow: { server: 'plugin' } } },
    setActiveConnectorAction: () => {}, setPreflightByPlugin: () => {},
    setMcpSetupState: (state: object) => { pendingSetup = state; },
    EMPTY_PLUGIN_MCP_SETUP_STATE: closedSetup,
    cancelMcpAuthorization: async () => { cancelledFlows += 1; },
  });
  const cleanup = effectScript.runInContext(context) as () => void;
  assert.equal(context.mcpSetupRequestRef.current, 1, 'workspace change invalidates old setup load/save generations');
  assert.equal(pendingSetup, closedSetup, 'switching workspace closes a pending MCP template dialog instead of trapping it in loading state');
  cleanup();
  assert.equal(context.mcpSetupRequestRef.current, 2, 'unmount invalidates pending setup responses');
  assert.equal(controller.signal.aborted, true, 'workspace cleanup stops the originating OAuth wait');
  assert.equal(cancelledFlows, 1, 'workspace cleanup cancels its own pending OAuth flow');
  console.log('Plugin MCP save: actual callback validates before writes, patches only personal credentials, preserves unrelated secrets/config metadata, keeps token out of JSON, and retains safe failures.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
