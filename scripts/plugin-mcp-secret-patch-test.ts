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
  const find = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'savePluginMcpServer') handlers.push(node);
    ts.forEachChild(node, find);
  };
  find(parsed);
  assert.equal(handlers.length, 1);
  const handler = ts.transpileModule(handlers[0].getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const script = new vm.Script(`${handler}\nsavePluginMcpServer();`);
  const server = { url: 'https://plugin.example.test/mcp', auth: 'none', bearerTokenEnv: 'MCP_PLUGIN_TOKEN', connectionId: 'plugin-connection', futurePlugin: { keep: true } };
  const draft = { ...toMcpServerDraft('plugin', server), bearerTokenValue: 'fixture-plugin-new' };
  const rawContent = JSON.stringify({ mcpServers: { plugin: server } });
  const run = async (options: { draft?: McpServerDraft; rawContent?: string; failEnv?: boolean; failConfig?: boolean; malformedEnv?: boolean } = {}) => {
    let state: SetupState = { connector: { name: 'plugin' }, pluginName: 'fixture-plugin', draft: options.draft || draft, originalName: 'plugin', rawContent: options.rawContent ?? rawContent, isSaving: false, error: null };
    const requests: Request[] = [];
    const values = new Map([['UNRELATED_SECRET', 'fixture-unrelated'], ['MCP_PLUGIN_TOKEN', 'fixture-old']]);
    const events: Array<{ type: string; detail: { secretScope: string } }> = [];
    const empty = { ...state, connector: null, isSaving: false };
    const context = vm.createContext({
      mcpSetupState: state,
      setMcpSetupState: (update: ((current: SetupState) => SetupState) | SetupState) => { state = typeof update === 'function' ? update(state) : update; },
      EMPTY_PLUGIN_MCP_SETUP_STATE: empty,
      collectMcpEnvEntries, updateMcpConfigRawServer, McpAuthorizationError, Error,
      t: () => 'Localized save error',
      storeByName: new Map(),
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
          if (options.malformedEnv) return new Response('invalid-json', { status: 503 });
          if (options.failEnv) return Response.json({ success: false, code: 'master_key_missing', error: 'Safe restore message' }, { status: 503 });
          for (const patch of body.patches) values.set(patch.key, patch.value);
          return Response.json({ success: true });
        }
        assert.equal(url, '/api/integrations/mcp-config'); assert.equal(init.method, 'PUT');
        if (options.failConfig) return Response.json({ success: false, code: 'decryption_failed', error: 'Safe config error' }, { status: 503 });
        const next = JSON.parse(body.rawContent).mcpServers.plugin;
        assert.deepEqual(next, server);
        assert.equal(body.rawContent.includes('fixture-plugin-new'), false);
        return Response.json({ success: true });
      },
    });
    await script.runInContext(context);
    return { state, requests, values, events, empty };
  };

  const success = await run();
  assert.deepEqual(success.requests.map(request => request.method), ['PATCH', 'PUT']);
  assert.equal(success.values.get('UNRELATED_SECRET'), 'fixture-unrelated');
  assert.equal(success.values.get('MCP_PLUGIN_TOKEN'), 'fixture-plugin-new');
  assert.equal(success.events.length, 1); assert.equal(success.events[0].detail.secretScope, 'user');
  assert.equal(success.state, success.empty, 'successful save closes/reset the actual setup state');
  for (const invalid of [{ draft: { ...draft, name: '' } }, { draft: { ...draft, url: '' } }, { rawContent: '{' }]) {
    const result = await run(invalid);
    assert.equal(result.requests.length, 0, 'local validation happens before any credential write');
    assert.equal(result.events.length, 0); assert.equal(result.state.isSaving, false); assert.ok(result.state.error);
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
  assert.equal(failedConfig.values.get('UNRELATED_SECRET'), 'fixture-unrelated');
  console.log('Plugin MCP save: actual callback validates before writes, patches only personal credentials, preserves unrelated secrets/config metadata, keeps token out of JSON, and retains safe failures.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
