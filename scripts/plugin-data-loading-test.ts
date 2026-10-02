import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

async function main() {
  const source = await fs.readFile('app/components/plugins/PluginsPanel.tsx', 'utf8');
  const parsed = ts.createSourceFile('PluginsPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let loader: ts.Expression | undefined;
  const find = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'loadPluginData' && node.initializer && ts.isCallExpression(node.initializer)) loader = node.initializer.arguments[0];
    ts.forEachChild(node, find);
  };
  find(parsed);
  assert.ok(loader);
  const js = ts.transpileModule(`(${loader.getText(parsed)})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const script = new vm.Script(js);
  const state: Record<string, unknown> = {};
  const context = vm.createContext({
    Promise, URLSearchParams, Error,
    pluginLoadRequestRef: { current: 0 }, PLUGIN_STORE_PAGE_SIZE: 12, storeTab: 'installed', storePage: 1, deferredSearchQuery: '', managementScope: 'user',
    capabilityScopeUrl: (url: string, scope: string) => `${url}?scope=${scope}`,
    t: (key: string) => `localized:${key}`,
    EMPTY_STORE_PAGINATION: {}, EMPTY_STORE_STATS: {},
    ...Object.fromEntries(['IsLoading', 'IsStoreLoading', 'PluginsLoadFailed', 'Error', 'StoreError', 'Plugins', 'StorePlugins', 'StoreMetadata', 'StorePagination', 'StoreStats'].map(key => [`set${key}`, (value: unknown) => { state[key] = value; }])),
  });
  let releaseStore!: () => void;
  const storePending = new Promise<void>(resolve => { releaseStore = resolve; });
  context.fetch = async (url: string) => {
    if (url.startsWith('/api/plugins/store?')) {
      await storePending;
      return Response.json({ success: true, plugins: [{ name: 'catalog-plugin' }] });
    }
    return Response.json({ success: true, plugins: [{ name: 'installed-plugin' }] });
  };
  const load = script.runInContext(context);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal((state.Plugins as Array<{ name: string }>)[0].name, 'installed-plugin');
  assert.equal(state.IsLoading, false, 'installed plugins become usable while the marketplace is still loading');
  assert.equal(state.IsStoreLoading, true);
  releaseStore();
  await load;
  assert.equal(state.IsStoreLoading, false);

  context.fetch = async (url: string) => url.startsWith('/api/plugins/store?')
    ? Response.json({ success: false, error: 'Catalog unavailable' }, { status: 503 })
    : Response.json({ success: true, plugins: [{ name: 'still-usable' }] });
  await script.runInContext(context);
  assert.equal((state.Plugins as Array<{ name: string }>)[0].name, 'still-usable');
  assert.equal(state.StoreError, 'Catalog unavailable');
  assert.equal(state.Error, null);

  let releaseOld!: () => void;
  const oldPending = new Promise<void>(resolve => { releaseOld = resolve; });
  context.fetch = async () => { await oldPending; return Response.json({ success: false, error: 'Obsolete failure' }, { status: 503 }); };
  const obsolete = script.runInContext(context);
  context.fetch = async (url: string) => Response.json({ success: true, plugins: [{ name: url.startsWith('/api/plugins/store?') ? 'new-catalog' : 'new-installed' }] });
  await script.runInContext(context);
  releaseOld();
  await obsolete;
  assert.equal((state.Plugins as Array<{ name: string }>)[0].name, 'new-installed');
  assert.equal(state.Error, null, 'late failures must not overwrite the current scope or search results');
  assert.equal(state.StoreError, null);
  console.log('Plugin loading: installed list is independent of a delayed/failed marketplace and obsolete errors cannot replace current data');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
