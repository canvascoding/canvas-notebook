import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

async function main() {
  const source = await fs.readFile('app/components/plugins/PluginsPanel.tsx', 'utf8');
  const parsed = ts.createSourceFile('PluginsPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(['getPreflightKey', 'preflightBlocksPluginWrite', 'installStorePlugin', 'installLocalPlugin', 'setPluginEnabled', 'deletePlugin', 'isAssignedOrganizationPlugin', 'isStorePackageManagedElsewhere', 'isPluginPreferenceLocked', 'storeMatchesInstalledPlugin']);
  const handlers: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) handlers.push(node.getText(parsed));
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.equal(handlers.length, names.size);
  const code = ts.transpileModule(`${handlers.join('\n')}\ninstallStorePlugin('email-plugin', '2.0.0');`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const script = new vm.Script(code);
  const run = async (options: { preflight?: object; assigned?: boolean; workspaceReady?: boolean; connecting?: boolean; canManagePackages?: boolean } = {}) => {
    const writes: Array<{ url: string; headers: unknown }> = [];
    let checks = 0;
    let detailRefreshRevision = 0;
    const preflightByPlugin = options.preflight ? { 'email-plugin@2.0.0': options.preflight } : {};
    const context = vm.createContext({
      storePlugins: [{ name: 'email-plugin', connectors: { email: [{ required: true }] }, installed: { installed: true, enabled: true } }],
      detailStorePlugin: null, preflightByPlugin,
      workspaceReady: options.workspaceReady !== false,
      canManagePackages: options.canManagePackages !== false,
      activeConnectorAction: options.connecting ? 'composio:email' : null,
      selectedPluginDetail: options.assigned ? { source: 'installed', name: 'email-plugin', resourceId: 'organization:email-plugin' } : null,
      selectedInstalledPlugin: options.assigned ? { resourceId: 'organization:email-plugin', scopeType: 'organization' } : null,
      isAssignedOrganizationPlugin: (plugin: { scopeType: string }) => plugin.scopeType === 'organization',
      hasConnectorRecommendations: () => true,
      checkStorePluginPreflight: async () => { checks += 1; },
      setPendingPluginName: () => {}, setError: () => {}, setPreflightByPlugin: () => {},
      setDetailRefreshRevision: (update: (revision: number) => number) => { detailRefreshRevision = update(detailRefreshRevision); },
      activeWorkspaceId: 'workspace-one', activeWorkspaceRef: { current: 'workspace-one' },
      composioHeaders: () => ({ 'Content-Type': 'application/json', 'X-Canvas-Workspace-Id': 'workspace-one' }),
      managementScope: 'user', t: (key: string) => key,
      loadPluginData: async () => { detailRefreshRevision += 1; }, onPluginsChanged: () => {},
      fetch: async (url: string, init: RequestInit) => { writes.push({ url, headers: init.headers }); return Response.json({ success: true }); },
    });
    await script.runInContext(context);
    return { writes, checks, detailRefreshRevision };
  };
  const requiredMissing = { result: { hasRequiredMissing: true, items: [{ required: true, ready: false }] } };
  for (const preflight of [requiredMissing, { isLoading: true }, { error: 'Unavailable' }]) {
    assert.equal((await run({ preflight })).writes.length, 0, 'required, pending or failed readiness cannot write');
  }
  const optionalMissing = { result: { hasRequiredMissing: false, items: [{ required: false, ready: false }] } };
  const allowed = await run({ preflight: optionalMissing });
  assert.equal(allowed.writes.length, 1, 'an optional unconnected recommendation does not block installation');
  assert.equal(allowed.detailRefreshRevision, 1, 'successful installation invalidates the exact off-page detail');
  assert.equal(allowed.writes[0].url, '/api/plugins/store/install');
  assert.equal((allowed.writes[0].headers as Record<string, string>)['X-Canvas-Workspace-Id'], 'workspace-one');
  assert.equal((await run({ preflight: optionalMissing, assigned: true })).writes.length, 0, 'an assigned organization detail cannot write a same-name personal package');
  assert.equal((await run({ preflight: optionalMissing, connecting: true })).writes.length, 0);
  assert.deepEqual(await run(), { writes: [], checks: 1, detailRefreshRevision: 0 }, 'unknown connector readiness checks before attempting installation');
  assert.deepEqual(await run({ workspaceReady: false }), { writes: [], checks: 0, detailRefreshRevision: 0 }, 'an unresolved workspace never starts checks or package writes');
  assert.deepEqual(await run({ canManagePackages: false }), { writes: [], checks: 0, detailRefreshRevision: 0 }, 'a member never starts store preflight or package installation through the actual handler');
  type Installed = { name: string; scopeType?: string; resourceId?: string; effectivePolicy?: string; readiness?: string };
  const personal: Installed = { name: 'document-suite', scopeType: 'user', resourceId: 'user:document-suite' };
  const assigned: Installed = { ...personal, scopeType: 'organization', resourceId: 'organization:document-suite', effectivePolicy: 'optional' };
  const runWriteHandler = async (invocation: string, plugin: Installed, canManagePackages = false) => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    let confirmations = 0;
    const context = vm.createContext({
      plugin, canManagePackages, managementScope: 'user', workspaceReady: true,
      sourcePath: '/fixture-package', t: (key: string) => key,
      capabilityScopeUrl: (url: string) => url,
      setPendingPluginName: () => {}, setError: () => {}, setIsInstalling: () => {}, setSourcePath: () => {},
      loadPluginData: async () => {}, onPluginsChanged: () => {},
      window: { confirm: () => { confirmations += 1; return true; } },
      fetch: async (url: string, init: RequestInit) => {
        requests.push({ url, method: init.method || 'GET', body: init.body ? String(init.body) : undefined });
        return Response.json({ success: true });
      },
    });
    await new vm.Script(ts.transpileModule(`${handlers.join('\n')}\n${invocation}`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText).runInContext(context);
    return { requests, confirmations };
  };
  for (const invocation of ['installLocalPlugin();', 'deletePlugin(plugin);', 'setPluginEnabled(plugin, false);']) {
    const result = await runWriteHandler(invocation, personal);
    assert.equal(result.requests.length, 0, 'member package management handlers refuse writes even when invoked directly');
    assert.equal(result.confirmations, 0, 'read-only remove never opens a confirmation prompt');
  }
  const preference = await runWriteHandler('setPluginEnabled(plugin, true);', assigned);
  assert.equal(preference.requests.length, 1);
  assert.equal(preference.requests[0].url, '/api/skills/preferences');
  assert.equal(preference.requests[0].method, 'PUT');
  assert.deepEqual(JSON.parse(preference.requests[0].body!), { resourceId: assigned.resourceId, enabled: true }, 'optional organization activation preserves exact resource identity');
  for (const locked of [
    { ...assigned, effectivePolicy: 'required' }, { ...assigned, effectivePolicy: 'blocked' },
    { ...assigned, readiness: 'blocked' }, { ...assigned, readiness: 'conflict' }, { ...assigned, resourceId: undefined },
  ]) assert.equal((await runWriteHandler('setPluginEnabled(plugin, false);', locked)).requests.length, 0, 'required, blocked, conflicting or unidentified assignments remain locked');
  assert.equal((await runWriteHandler('deletePlugin(plugin);', assigned, true)).requests.length, 0, 'even an administrator cannot remove an assigned package from the personal view');
  assert.equal((await runWriteHandler('setPluginEnabled(plugin, false);', personal, true)).requests[0].url, '/api/plugins/document-suite/disable', 'authorized administrators retain own-package activation');
  const identityContext: vm.Context = vm.createContext({
    managementScope: 'user',
    isAssignedOrganizationPlugin: (plugin: { scopeType?: string }) => identityContext.managementScope === 'user' && plugin.scopeType === 'organization',
  });
  const match = new vm.Script(ts.transpileModule(`${handlers.join('\n')}\nstoreMatchesInstalledPlugin;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText).runInContext(identityContext) as (store: object, installed: object) => boolean;
  const storeIdentity = (record: object) => ({ installed: { installedPlugin: record } });
  const legacy = { name: 'document-suite' };
  const resolvedPersonal = { ...legacy, scopeType: 'user', resourceId: 'user:document-suite' };
  assert.equal(match(storeIdentity(legacy), resolvedPersonal), true, 'legacy own-scope metadata still supports updates/repair after the effective snapshot generates a personal resource ID');
  assert.equal(match(storeIdentity(resolvedPersonal), legacy), true, 'missing ID on the personal snapshot also keeps its legacy metadata');
  assert.equal(match(storeIdentity(legacy), { name: 'different-plugin', scopeType: 'user' }), false);
  assert.equal(match(storeIdentity(resolvedPersonal), { ...resolvedPersonal, resourceId: 'user:other-resource' }), false, 'two present resource IDs must match exactly');
  const assignedOrganization = { ...legacy, scopeType: 'organization', resourceId: 'organization:document-suite' };
  assert.equal(match(storeIdentity(legacy), assignedOrganization), false, 'same-name legacy personal metadata cannot match assigned organization identity');
  assert.equal(match(storeIdentity({ ...assignedOrganization, resourceId: undefined }), assignedOrganization), false, 'organization ownership never uses a name-only fallback');
  identityContext.managementScope = 'organization';
  assert.equal(match(storeIdentity(legacy), resolvedPersonal), false, 'personal legacy fallback is limited to personal management scope');
  assert.equal(match(storeIdentity(assignedOrganization), assignedOrganization), true, 'exact organization resource identity remains supported');
  console.log('Plugin writes: member management handlers refuse writes, optional exact organization activation is preserved, policy and readiness gates remain enforced.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
