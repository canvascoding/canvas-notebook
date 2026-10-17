import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDurableMessageExecutionFixture } from './helpers/durable-message-execution-fixture';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';
import type { ChatExtensionSearchRequest } from '../app/lib/chat/extension-options-contracts';

/** Actual package bytes, SQL ACLs, current MCP configuration and owned Composio
 * account HTTP. No provider tools/schema/business operation is permitted. */
async function main() {
  const fixture = await createDurableMessageExecutionFixture(), app = fixture.application;
  const provider = await createComposioProviderFixture();
  const originalFetch = globalThis.fetch, network = (await import('undici')).fetch;
  const previousBase = process.env.COMPOSIO_BASE_URL;
  process.env.COMPOSIO_BASE_URL = provider.baseUrl;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.href === 'https://registry.npmjs.org/@composio/core/latest') return Response.json({ version: '0.0.0' });
    if (url.origin !== provider.baseUrl) return originalFetch(input, init);
    assert.equal(url.pathname, '/api/v3.1/connected_accounts');
    assert.equal(init?.method ?? 'GET', 'GET');
    return network(url.href, { ...init, redirect: 'error' } as Parameters<typeof network>[1]) as unknown as Promise<Response>;
  };
  try {
    const options = await import('../app/lib/chat/extension-options');
    const management = await import('../app/lib/agents/management-actions');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const activation = await import('../app/lib/capabilities/packages/activation');
    const personalActivation = await import('../app/lib/capabilities/activation-actions');
    const config = await import('../app/lib/mcp/config');
    const observations = await import('../app/lib/plugins/extension-search-observation');
    const owner = { ...app.owner, source: 'api' as const };
    const general = await management.createManagedAgent(owner, { name: `Readiness ${randomUUID()}`, scopeType: 'user', enabledTools: ['read'],
      extensions: { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' } });
    const target = { kind: 'draft_turn' as const, agentId: general.agent.agentId, workspaceId: owner.workspaceId! };
    const install = async (name: string, source: 'mcp' | 'composio', required = true) => {
      const workflow = { version: 1, integrationCapabilities: [{ id: 'work', application: source === 'mcp' ? 'reader' : 'canva', required,
        alternatives: [source === 'mcp' ? { source, connector: 'reader' } : { source, toolkit: 'canva' }] }] };
      const files: Record<string, string> = {
        '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', description: 'Exact required capability', skills: './skills', workflow,
          connectors: source === 'mcp' ? { mcp: [{ name: 'reader', required, configPath: 'reader.json' }] } : { composio: [{ toolkit: 'canva', required }] } }),
        [`skills/child-${name}/SKILL.md`]: `---\nname: child-${name}\ndescription: Exact ${name} child\n---\nUse the selected source.\n`,
      };
      if (source === 'mcp') files['reader.json'] = JSON.stringify({ url: 'https://reader.readiness.example.test/mcp', transport: 'http', auth: 'none' });
      const archive = await app.registry.addPackage('application', 'plugin', name, '1.0.0', files, plugins.computeCanvasPluginChecksum);
      const installed = await stores.installCapabilityPackageFromStoreAction(app.owner, { source: { kind: 'plugin', registryId: 'store-application',
        entryKey: name, version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' },
        grants: [{ targetType: 'user', targetId: owner.userId, canUse: true, canEdit: false, canManage: false }] });
      const inspect = await packages.inspectCapabilityPackage(app.owner, installed.resource.resourceRef);
      await activation.setCapabilityPackageDefaultActivationAction(app.owner, installed.resource.resourceRef, { expectedMetadataRevision: inspect.resource.metadataRevision,
        expectedGrantsRevision: inspect.resource.grantsRevision, expectedPackageRevision: inspect.state!.packageRevision,
        expectedPublishedRevisionRef: installed.published.revisionRef, expectedDefaultEnabled: false, enabled: true });
      await personalActivation.setPersonalCapabilityActivation({ context: { userId: owner.userId, organizationId: app.organizationId,
        workspaceId: owner.workspaceId, role: 'owner' }, actorUserId: owner.userId, resourceId: inspect.sourceStamp.resourceId, enabled: true });
      return installed;
    };
    const search = async (phase: 'local' | 'connected', name: string, types: ChatExtensionSearchRequest['types'] = ['plugin']) => {
      const observed = await observations.withExtensionObservation(() => options.listChatExtensionOptions(owner,
        { operation: 'search', target, phase, q: name, types, limit: 50 }));
      assert.equal(observed.result.operation, 'search'); if (observed.result.operation !== 'search') throw new Error('Expected search');
      return { ...observed, result: observed.result };
    };
    const sourceCalls = (timing: string) => Number(/package_source;dur=[\d.]+;desc="(\d+) calls/u.exec(timing)?.[1] ?? 0);
    const installed = await install('priority-ready-mcp', 'mcp');
    await config.writeMcpConfigRaw(JSON.stringify({ mcpServers: { reader: { url: 'https://reader.readiness.example.test/mcp', auth: 'none', enabled: true },
      unrelated: { url: 'https://unrelated.readiness.example.test/mcp', auth: 'none', enabled: true } } }), { userId: owner.userId });
    const cold = await search('local', 'priority-ready-mcp');
    assert.equal(cold.result.items[0]?.chatAvailability, 'setup'); assert.equal(sourceCalls(cold.serverTiming), 0);
    const connected = await search('connected', 'priority-ready-mcp');
    const ready = connected.result.items.find(row => row.item.id === installed.resource.resourceRef);
    assert.equal(ready?.chatAvailability, 'ready'); assert.equal(sourceCalls(connected.serverTiming), 1);
    assert(connected.result.items.every(row => row.item.kind === 'plugin'), 'Plugin-only filter retains packages and independently reads their connections.');
    const warm = await search('local', 'priority-ready');
    assert.equal(warm.result.items.find(row => row.item.id === installed.resource.resourceRef)?.chatAvailability, 'ready');
    assert.equal(sourceCalls(warm.serverTiming), 0);
    const child = await search('local', 'child-priority-ready-mcp', ['skill']);
    assert.equal(child.result.items.find(row => row.item.name === 'child-priority-ready-mcp')?.chatAvailability, 'ready');
    assert.equal(sourceCalls(child.serverTiming), 0);
    console.log(`PASS actual required MCP plugin/child readiness and Plugin-only search; cold local ${cold.serverTiming}; connected ${connected.serverTiming}; warm ${warm.serverTiming}.`);

    const changed = await config.readMcpConfig({ userId: owner.userId });
    changed.mcpServers.reader.url = 'https://wrong.readiness.example.test/mcp';
    await config.writeMcpConfigRaw(JSON.stringify(changed), { userId: owner.userId });
    const unrelated = await search('local', 'priority-ready-mcp');
    assert.equal(unrelated.result.items.find(row => row.item.id === installed.resource.resourceRef)?.chatAvailability, 'setup');
    assert.equal(sourceCalls(unrelated.serverTiming), 0, 'Cached declarations do not cache a positive connection decision.');
    const optional = await install('priority-optional-mcp', 'mcp', false);
    const optionalResult = await search('connected', 'priority-optional-mcp');
    assert.equal(optionalResult.result.items.find(row => row.item.id === optional.resource.resourceRef)?.chatAvailability, 'ready');
    console.log('PASS changed/unrelated MCP cannot satisfy exact template; optional missing requirements do not block the plugin.');

    const canva = await install('priority-cold-canva', 'composio');
    await (await import('../app/lib/integrations/env-config')).replaceScopedEnvEntries('integrations',
      [{ key: 'COMPOSIO_API_KEY', value: 'isolated-priority-test-key' }], { secretScope: 'user', userId: owner.userId });
    const profile = await (await import('../app/lib/composio/composio-context')).resolveComposioContext({ userId: owner.userId, workspaceId: owner.workspaceId });
    provider.accounts.set(profile.composioUserId, [{ id: 'priority-canva-account', toolkit: 'canva', status: 'ACTIVE' }]);
    const before = provider.calls.length;
    const coldCanva = await search('local', 'priority-cold-canva');
    assert.equal(coldCanva.result.items.find(row => row.item.id === canva.resource.resourceRef)?.chatAvailability, 'setup');
    assert.equal(provider.calls.length, before); assert.equal(sourceCalls(coldCanva.serverTiming), 0);
    const connectedCanva = await search('connected', 'priority-cold-canva');
    assert.equal(connectedCanva.result.items.find(row => row.item.id === canva.resource.resourceRef)?.chatAvailability, 'ready');
    assert(connectedCanva.result.items.every(row => row.item.kind === 'plugin'));
    const warmCanva = await search('local', 'priority-cold-canva');
    assert.equal(warmCanva.result.items.find(row => row.item.id === canva.resource.resourceRef)?.chatAvailability, 'ready');
    assert.equal(sourceCalls(warmCanva.serverTiming), 0);
    assert.equal(provider.calls.length, before + 1, 'Repeated searches reuse account observations; no toolkit/schema/tool/business requests.');
    assert(provider.calls.every(call => call.path === '/api/v3.1/connected_accounts'));
    assert.equal(app.providerRequests(), 0);
    console.log('PASS actual cold Composio package-only local -> connected promotion, warm metadata reuse and account-only HTTP.');

    const skillName = 'priority-standalone-required';
    const skillArchive = await app.registry.addPackage('application', 'skill', skillName, '1.0.0', {
      'SKILL.md': `---\nname: ${skillName}\ndescription: Standalone required connector\nmetadata:\n  version: "1.0.0"\n---\nUse the required reader.\n`,
      'agents/canvas.yaml': `workflow: ${JSON.stringify({ version: 1, integrationCapabilities: [], mcpConnectors: [{ name: 'reader', required: true }] })}\n`,
    }, plugins.computeCanvasPluginChecksum);
    const standalone = await stores.installCapabilityPackageFromStoreAction(app.owner, { source: { kind: 'skill', registryId: 'store-application',
      entryKey: skillName, version: '1.0.0', checksum: skillArchive.checksum }, ownership: { type: 'organization' },
      grants: [{ targetType: 'user', targetId: owner.userId, canUse: true, canEdit: false, canManage: false }] });
    const inspected = await packages.inspectCapabilityPackage(app.owner, standalone.resource.resourceRef);
    await activation.setCapabilityPackageDefaultActivationAction(app.owner, standalone.resource.resourceRef, { expectedMetadataRevision: inspected.resource.metadataRevision,
      expectedGrantsRevision: inspected.resource.grantsRevision, expectedPackageRevision: inspected.state!.packageRevision,
      expectedPublishedRevisionRef: standalone.published.revisionRef, expectedDefaultEnabled: false, enabled: true });
    await personalActivation.setPersonalCapabilityActivation({ context: { userId: owner.userId, organizationId: app.organizationId,
      workspaceId: owner.workspaceId, role: 'owner' }, actorUserId: owner.userId, resourceId: inspected.sourceStamp.resourceId, enabled: true });
    const skillConnected = await search('connected', skillName, ['skill']);
    assert.equal(skillConnected.result.items.find(row => row.item.id === standalone.resource.resourceRef)?.chatAvailability, 'setup');
    const skillWarm = await search('local', skillName, ['skill']);
    assert.equal(skillWarm.result.items.find(row => row.item.id === standalone.resource.resourceRef)?.chatAvailability, 'setup');
    assert.equal(sourceCalls(skillWarm.serverTiming), 0);
    console.log('PASS actual standalone required MCP connector without an exact capability selector stays setup after descriptor caching.');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBase === undefined) delete process.env.COMPOSIO_BASE_URL; else process.env.COMPOSIO_BASE_URL = previousBase;
    await provider.close(); await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
