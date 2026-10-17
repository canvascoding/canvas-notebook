import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import Module from 'node:module';
import type { SpecialAgentRuntimeFields } from '../app/lib/agents/effective-runtime-config';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

/** Real SQL profiles/sessions, actual registry/factories/filters. Provider entry points are forbidden-call sentinels, not authority mocks. */
async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load;
  const prohibited: string[] = [];
  const guarded = new Map<string, Set<string>>([
    ['@/app/lib/composio/composio-context', new Set(['resolveComposioContext'])],
    ['@/app/lib/composio/composio-client', new Set(['isComposioConfigured'])],
    ['@/app/lib/mcp/direct-tools', new Set(['buildDirectMcpTools'])],
  ]);
  loader._load = (name, parent, isMain) => {
    const actual = originalLoad(name, parent, isMain);
    const methods = guarded.get(name);
    if (!methods) return actual;
    return new Proxy(actual as object, { get(target, key, receiver) {
      if (typeof key !== 'string' || !methods.has(key)) return Reflect.get(target, key, receiver);
      return () => { prohibited.push(key); throw new Error('Provider discovery is forbidden in this metadata fixture.'); };
    } });
  };
  const previousManaged = process.env.CANVAS_MANAGED_SERVICES_ENABLED;
  const previousControlPlane = process.env.CANVAS_CONTROL_PLANE_URL;
  const previousToken = process.env.CANVAS_INSTANCE_TOKEN;
  try {
    const registry = await import('../app/lib/agents/registry');
    const storage = await import('../app/lib/agents/storage');
    const settings = await import('../app/lib/agents/effective-runtime-config');
    const tools = await import('../app/lib/pi/tool-registry');
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    const { serverPreferencesPath } = await import('../app/lib/terminal-policy');
    const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
    const { buildEffectiveToolManifest } = await import('../app/lib/pi/effective-tool-manifest');
    const { isIntegrationGatewayTool } = await import('../app/lib/pi/integration-tool-gateway');
    const { getProgressiveGatewayCapabilityNames } = await import('../app/lib/pi/progressive-tool-gateway');
    const { createUserScopedTools } = await import('../app/lib/pi/scoped-tools');
    const { resolveMcpConfigPath } = await import('../app/lib/mcp/config');
    const configureGateway = async (enabled: boolean) => {
      const file = serverPreferencesPath();
      await fs.mkdir((await import('node:path')).dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ settings: { integrationToolGatewayEnabled: enabled } }));
    };
    await storage.writePiRuntimeConfig({ ...DEFAULT_PI_CONFIG, activeProvider: 'google',
      runtimeMigrations: { skillToolsDefaultEnabled: true }, providers: {
        ...DEFAULT_PI_CONFIG.providers,
        google: { ...DEFAULT_PI_CONFIG.providers.google, id: 'google', model: 'fixture-model-a', thinking: 'medium', enabledTools: ['read', 'mcp'] },
        openrouter: { ...DEFAULT_PI_CONFIG.providers.openrouter, id: 'openrouter', model: 'fixture-model-b', thinking: 'low', enabledTools: ['write', 'COMPOSIO_SEARCH_TOOLS'] },
      } });
    const cases: Array<{ name: string; fields: SpecialAgentRuntimeFields; provider: string; inherited: string[] }> = [
      { name: 'inherit-active', fields: { enabledTools: null }, provider: 'google', inherited: ['read', 'mcp'] },
      { name: 'inherit-other-provider', fields: { defaultProvider: 'openrouter', defaultModel: 'fixture-override-b', defaultThinking: 'high', enabledTools: null },
        provider: 'openrouter', inherited: ['write', 'COMPOSIO_SEARCH_TOOLS'] },
      { name: 'explicit', fields: { enabledTools: ['read', 'memory', 'COMPOSIO_GET_TOOL_SCHEMAS'] }, provider: 'google',
        inherited: ['read', 'memory', 'COMPOSIO_GET_TOOL_SCHEMAS'] },
      { name: 'defaults', fields: { enabledTools: [] }, provider: 'google', inherited: [] },
      { name: 'legacy-defaults', fields: { enabledTools: ['filesystem', 'terminal', 'web-search'] }, provider: 'google',
        inherited: ['filesystem', 'terminal', 'web-search'] },
      { name: 'none', fields: { enabledTools: ['__none__'] }, provider: 'google', inherited: ['__none__'] },
      { name: 'none-padded-mixed', fields: { enabledTools: ['  __none__  ', 'read', 'mcp'] }, provider: 'google',
        inherited: ['  __none__  ', 'read', 'mcp'] },
      { name: 'browser', fields: { enabledTools: ['browser', 'read'] }, provider: 'google', inherited: ['browser', 'read'] },
    ];
    for (const [index, test] of cases.entries()) {
      const agentId = `registration-${test.name}-${randomUUID().slice(0, 8)}`;
      const profile = await registry.createAgentProfile({ name: test.name, agentId, scopeType: 'user', ownerUserId: fixture.owner.userId,
        organizationId: fixture.organizationId, createdByUserId: fixture.owner.userId, ...test.fields,
        ...(test.fields.defaultProvider ? { defaultProviderInstallationId: `aip_${randomUUID().replaceAll('-', '').slice(0, 24)}` } : {}) });
      // Arrange a genuine stored WF2 header; this test does not claim public Create/Save admission.
      await registry.updateAgentProfile({ agentId, expectedRevision: profile.revision, workflowVersion: 2, workflowRevision: 1 });
      const sessionId = `${agentId}-session`;
      await fixture.sql.run(`INSERT INTO pi_sessions (session_id,user_id,agent_id,provider,model,created_at,updated_at,organization_id,workspace_id,workspace_type)
        VALUES ($1,$2,$3,'fixture','fixture',1,1,$4,$5,'personal')`, [sessionId, fixture.owner.userId, agentId, fixture.organizationId, fixture.owner.workspaceId]);
      const context = await resolveAgentExecutionContextForStoredSession({ userId: fixture.owner.userId, agentId, sessionId });
      const actual = await settings.resolveAgentRuntimeSettings(agentId);
      // The actual registry has already normalized the accepted native-tool
      // fields; prospective callers use that same strict intake contract.
      const prospective = await settings.resolveSpecialAgentRuntimeSettings({ ...test.fields, enabledTools: profile.enabledTools });
      assert.equal(prospective.activeProvider, test.provider);
      assert.deepEqual(prospective.enabledTools, test.inherited.map(value => value.trim()), test.name);
      assert.deepEqual(prospective, { activeProvider: actual.activeProvider, providerConfig: actual.providerConfig,
        thinkingLevel: actual.thinkingLevel, enabledTools: actual.enabledTools, overrideState: actual.overrideState, setupState: actual.setupState });
      assert.equal('agentId' in prospective || 'agent' in prospective, false);
      await configureGateway(index % 2 === 0);
      const agentsBefore = await fixture.sql.all('SELECT * FROM agents ORDER BY id');
      const sessionsBefore = await fixture.sql.all('SELECT session_id FROM pi_sessions ORDER BY session_id');
      const metadata = await tools.buildPiSpecialAgentRegistrationMetadata({ kind: 'special', userId: fixture.owner.userId,
        effectiveEnabledTools: prospective.enabledTools, extensionMode: 'fixed', workspacePermissions: context });
      assert.deepEqual(await fixture.sql.all('SELECT * FROM agents ORDER BY id'), agentsBefore);
      assert.deepEqual(await fixture.sql.all('SELECT session_id FROM pi_sessions ORDER BY session_id'), sessionsBefore);
      assert.equal(metadata.externalRegistration, 'exact_gateway');
      const runtime = await tools.getPiTools(fixture.owner.userId, agentId, sessionId, { executionContext: context,
        strictAuthorization: true, metadataOnlyExternal: true });
      assert.deepEqual(metadata.manifest, buildEffectiveToolManifest(runtime), `${test.name}: actual registration must match, including filtered progressive operations.`);
      assert.deepEqual(metadata.integrationPolicyCeiling, runtime.find(isIntegrationGatewayTool)?.integrationGateway.policyCeiling ?? null);
      assert.deepEqual(metadata.capabilityNames, getProgressiveGatewayCapabilityNames(runtime), 'Metadata names describe actual operations, not all legacy grant aliases.');
      assert(!metadata.capabilityNames.some(name => ['delegate_task', 'agent_manage', 'create_agent', 'inspect_agent', 'update_agent_configuration', 'complete_onboarding_profile'].includes(name)));
      if (test.name.startsWith('none')) {
        assert.deepEqual(runtime, []);
        const noGateway = await tools.getPiTools(fixture.owner.userId, agentId, sessionId, { executionContext: context,
          strictAuthorization: true, planningMode: true });
        assert.deepEqual(noGateway, [], 'Explicit none stays empty without an integration gateway.');
      }
      const noWorkspaceMutations = { canWrite: false, canDelete: false, canShare: false };
      const restrictedMetadata = await tools.buildPiSpecialAgentRegistrationMetadata({ kind: 'special', userId: fixture.owner.userId,
        effectiveEnabledTools: prospective.enabledTools, extensionMode: 'fixed', workspacePermissions: noWorkspaceMutations });
      const restrictedRuntime = await tools.getPiTools(fixture.owner.userId, agentId, sessionId,
        { executionContext: { ...context, ...noWorkspaceMutations }, strictAuthorization: true });
      assert.deepEqual(restrictedMetadata.manifest, buildEffectiveToolManifest(restrictedRuntime));
      assert.equal(restrictedMetadata.capabilityNames.includes('write'), false);
      assert.equal(prohibited.length, 0, 'Neither metadata nor an actual WF2 registration probes providers or direct MCPs.');
    }
    const special = createUserScopedTools(fixture.owner.userId, undefined, undefined, { registrationKind: 'special' });
    assert(!special.some(tool => tool.name === 'delegate_task'));
    assert.throws(() => createUserScopedTools(fixture.owner.userId, 'bradley', undefined, { registrationKind: 'special' }), /registration kind/u);
    assert.throws(() => createUserScopedTools(fixture.owner.userId, 'actual-special', undefined, { registrationKind: 'main' }), /registration kind/u);
    const legacyMainSchemas = await tools.buildPiToolRegistryAsync(fixture.owner.userId, storage.LEGACY_MAIN_AGENT_ID, undefined,
      { allowExternalIntegrations: false });
    assert(legacyMainSchemas.some(tool => tool.name === 'delegate_task'), 'The existing historical Main alias keeps its scoped registration.');
    assert(!legacyMainSchemas.some(tool => tool.name === 'agent_manage'), 'The refactor does not add Main management to a legacy alias caller.');
    const paddedDenial = await tools.buildPiSpecialAgentRegistrationMetadata({ kind: 'special', userId: fixture.owner.userId,
      effectiveEnabledTools: ['  __none__  ', 'read'], extensionMode: 'fixed' });
    assert.deepEqual(paddedDenial.manifest.registeredToolNames, [], 'The shared filter recognizes old padded sentinel values too.');
    await configureGateway(false);
    const beforeProfiles = await fixture.sql.all('SELECT id FROM composio_connection_profiles');
    const legacy = await tools.buildPiSpecialAgentRegistrationMetadata({ kind: 'special', userId: fixture.owner.userId,
      effectiveEnabledTools: ['read', 'mcp'], extensionMode: 'legacy_inherit' });
    assert.equal(legacy.externalRegistration, 'unknown');
    assert(legacy.manifest.registeredToolNames.includes('mcp'));
    assert(!legacy.manifest.registeredToolNames.includes('composio'));
    assert.deepEqual(await fixture.sql.all('SELECT id FROM composio_connection_profiles'), beforeProfiles);
    await assert.rejects(fs.access(resolveMcpConfigPath({ userId: fixture.owner.userId })), { code: 'ENOENT' });
    assert.equal(prohibited.length, 0);
    assert.equal(fixture.providerRequests(), 0);

    // Characterize the separate established infrastructure boundary: an
    // unconfigured managed model can read the CP model catalogue. It is not a
    // Composio account/tool probe and is never claimed as zero network IO.
    // A genuinely cold config is supported by the reader. The public writer
    // correctly rejects intentionally invalid blank configured providers.
    await fs.rm(storage.PI_RUNTIME_CONFIG_PATH);
    process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
    process.env.CANVAS_CONTROL_PLANE_URL = fixture.registry.baseUrl;
    process.env.CANVAS_INSTANCE_TOKEN = 'owned-registration-model-metadata';
    let modelCatalogueReads = 0;
    fixture.setBeforeFetch(async value => {
      assert.equal(new URL(value).pathname, '/v1/managed/models'); modelCatalogueReads++;
    });
    await settings.resolveSpecialAgentRuntimeSettings({ enabledTools: null });
    assert.equal(modelCatalogueReads, 1, 'Existing managed-default resolution performs its bounded catalogue GET against the owned HTTP fixture.');
    assert.equal(prohibited.length, 0);
    assert.equal(fixture.providerRequests(), 0);
    console.log('PASS real special-agent registration parity: actual SQL/session/WF2 + shared factories/filter/manifest, model/provider tool inheritance, native/progressive/source ceilings, defaults/legacy/none with no gateway, workspace restrictions, no Main tools or fake rows; SDK/account/direct-MCP probes0. Existing CP model-metadata GET separately proven1.');
  } finally {
    fixture.setBeforeFetch(undefined);
    loader._load = originalLoad;
    if (previousManaged === undefined) delete process.env.CANVAS_MANAGED_SERVICES_ENABLED; else process.env.CANVAS_MANAGED_SERVICES_ENABLED = previousManaged;
    if (previousControlPlane === undefined) delete process.env.CANVAS_CONTROL_PLANE_URL; else process.env.CANVAS_CONTROL_PLANE_URL = previousControlPlane;
    if (previousToken === undefined) delete process.env.CANVAS_INSTANCE_TOKEN; else process.env.CANVAS_INSTANCE_TOKEN = previousToken;
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
