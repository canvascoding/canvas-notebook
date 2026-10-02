import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

async function main() {
  const source = await fs.readFile('app/components/plugins/PluginsPanel.tsx', 'utf8');
  const parsed = ts.createSourceFile('PluginsPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && ['pollComposioConnector', 'refreshPluginConnections'].includes(node.name.text)) {
      functions.set(node.name.text, node.getText(parsed));
    }
    if (ts.isVariableDeclaration(node) && ['checkStorePluginPreflight', 'loadComposioConnectorState'].includes(node.name.getText(parsed))
      && node.initializer && ts.isCallExpression(node.initializer)) {
      const name = node.name.getText(parsed);
      functions.set(name, `const ${name} = ${node.initializer.arguments[0].getText(parsed)};`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.equal(functions.size, 4, 'exercise the actual connection callbacks');
  const factory = new vm.Script(ts.transpileModule(`((activeWorkspaceId, workspaceIdentityToken) => {
    const composioHeaders = () => ({ 'x-canvas-workspace-id': activeWorkspaceId });
    ${[...functions.values()].join('\n')}
    return { pollComposioConnector, refreshPluginConnections, checkStorePluginPreflight, loadComposioConnectorState };
  })`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText);

  function fixture() {
    const token = Symbol('workspace-a');
    const state = { preflight: {} as Record<string, unknown>, connection: { marker: 'current' } as Record<string, unknown>, loads: 0, requests: [] as string[] };
    const context = vm.createContext({
      Promise, Symbol, Error,
      activeWorkspaceRef: { current: 'workspace-a' }, workspaceIdentityRef: { current: token },
      connectorFlowRequestRef: { current: 1 }, preflightRequestRef: { current: {} },
      requiredComposioToolkits: [{ toolkit: 'gmail' }], EMPTY_COMPOSIO_CONNECTOR_STATE: {},
      selectedCatalogPlugin: { name: 'fixture', latestVersion: '1.0.0' }, selectedPluginDetail: { source: 'store' },
      selectedInstalledPlugin: undefined, managementScope: 'user',
      getPreflightKey: (name: string, version?: string) => `${name}@${version || 'latest'}`,
      t: (key: string) => key, setError: () => undefined,
      setPreflightByPlugin: (update: (value: Record<string, unknown>) => Record<string, unknown>) => { state.preflight = update(state.preflight); },
      setComposioConnectorState: (update: Record<string, unknown> | ((value: Record<string, unknown>) => Record<string, unknown>)) => {
        state.connection = typeof update === 'function' ? update(state.connection) : update;
      },
      loadPluginData: async () => { state.loads += 1; },
      window: { setTimeout: (callback: () => void) => callback() },
    });
    context.fetch = async (url: string) => {
      state.requests.push(url);
      return Response.json(url.includes('/preflight')
        ? { success: true, preflight: { marker: 'current', items: [], hasRequiredMissing: false } }
        : url.includes('/toolkits') ? { toolkits: [] }
          : { configured: true, apiKeyValid: true, providerHealthy: true, connectedAccounts: [{ toolkit: { slug: 'gmail' }, status: 'ACTIVE' }] });
    };
    const create = factory.runInContext(context) as (workspace: string, token: symbol) => {
      pollComposioConnector: (toolkit: string, popup: { closed: boolean }, requestId: number, workspace: string) => Promise<string>;
      refreshPluginConnections: () => Promise<void>;
      checkStorePluginPreflight: (name: string, version?: string) => Promise<void>;
      loadComposioConnectorState: () => Promise<void>;
    };
    return { context, state, create, callbacks: create('workspace-a', token) };
  }

  for (const change of ['workspace', 'request'] as const) {
    const { context, state, callbacks } = fixture();
    let release!: (value: unknown) => void;
    let started!: () => void;
    const body = new Promise(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { started = resolve; });
    context.fetch = async () => ({ ok: true, json: () => { started(); return body; } });
    const poll = callbacks.pollComposioConnector('gmail', { closed: false }, 1, 'workspace-a');
    await reading;
    if (change === 'workspace') {
      context.activeWorkspaceRef.current = 'workspace-b';
      context.workspaceIdentityRef.current = Symbol('workspace-b');
    } else context.connectorFlowRequestRef.current = 2;
    release({ connectedAccounts: [{ toolkit: { slug: 'gmail' }, status: 'ACTIVE' }] });
    assert.equal(await poll, 'obsolete', `a late JSON body from an old ${change} is discarded`);
    assert.equal(state.loads, 0, 'obsolete polling cannot start another refresh');
    assert.deepEqual(state.preflight, {});
  }

  {
    const { context, state, callbacks } = fixture();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    context.loadPluginData = async () => { state.loads += 1; await pending; };
    const refresh = callbacks.refreshPluginConnections();
    context.activeWorkspaceRef.current = 'workspace-b';
    context.workspaceIdentityRef.current = Symbol('workspace-b');
    state.preflight = { currentWorkspace: 'ready' };
    release();
    await refresh;
    assert.equal(state.requests.some(url => url.includes('/preflight')), false, 'an old refresh cannot start preflight after its loaders settle');
    assert.deepEqual(state.preflight, { currentWorkspace: 'ready' });
  }

  {
    const { context, state, callbacks } = fixture();
    context.workspaceIdentityRef.current = Symbol('workspace-a-again');
    await callbacks.refreshPluginConnections();
    await callbacks.loadComposioConnectorState();
    await callbacks.checkStorePluginPreflight('fixture', '1.0.0');
    assert.equal(state.loads, 0);
    assert.equal(state.requests.length, 0, 'saved A callbacks cannot restart after A to B to A');
    assert.deepEqual(state.connection, { marker: 'current' });
    assert.deepEqual(state.preflight, {});
  }

  {
    const { context, state, callbacks } = fixture();
    let release!: (value: unknown) => void;
    let started!: () => void;
    const body = new Promise(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { started = resolve; });
    context.fetch = async () => ({ ok: true, json: () => { started(); return body; } });
    const preflight = callbacks.checkStorePluginPreflight('fixture', '1.0.0');
    await reading;
    context.activeWorkspaceRef.current = 'workspace-b';
    context.workspaceIdentityRef.current = Symbol('workspace-b');
    context.activeWorkspaceRef.current = 'workspace-a';
    context.workspaceIdentityRef.current = Symbol('workspace-a-again');
    state.preflight = {};
    release({ success: true, preflight: { marker: 'obsolete' } });
    await preflight;
    assert.deepEqual(state.preflight, {}, 'late A preflight cannot repopulate state after A to B to A, even with the same request ID');
  }

  {
    const { state, callbacks } = fixture();
    assert.equal(await callbacks.pollComposioConnector('gmail', { closed: false }, 1, 'workspace-a'), 'connected');
    assert.equal(state.loads, 1, 'current authentication still refreshes installed and connection state');
    assert.equal(state.requests.filter(url => url.includes('/preflight')).length, 1);
    assert.equal((state.preflight['fixture@1.0.0'] as { result: { marker: string } }).result.marker, 'current');
  }
  console.log('Plugin connector races: late JSON, obsolete refresh, saved callbacks and A to B to A are isolated; current completion still refreshes.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
