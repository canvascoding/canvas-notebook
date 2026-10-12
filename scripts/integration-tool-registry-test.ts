import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AfterToolCallContext } from '@earendil-works/pi-agent-core';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { installMcpAccessMocks } from './fixtures/mcp-test-access';
import { createPiTestDatabase } from './helpers/pi-test-database';

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-integration-registry-'));
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.INTEGRATIONS_ENV_MASTER_KEY = crypto.randomBytes(32).toString('base64url');
  process.env.QMD_ENABLED = 'false';
  process.env.MCP_ALLOW_STDIO = 'true';
  process.env.BASE_URL = 'http://localhost:3000';
  const database = await createPiTestDatabase();
  const { memberships, restore } = installMcpAccessMocks();
  memberships.set('registry-user', { organizationId: 'registry-org', role: 'admin', status: 'active' });
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (name, parent, isMain) => {
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return database;
    return originalLoad(name, parent, isMain);
  };
  let closeConnections: (() => Promise<void>) | undefined;
  try {
    const { user, piSessions } = await import('../app/lib/db/schema');
    const now = new Date();
    await database.db.insert(user).values({ id: 'registry-user', name: 'Registry user', email: 'registry@example.test',
      emailVerified: true, role: 'admin', createdAt: now, updatedAt: now });
    const { setExperimentalFeatures } = await import('../app/lib/server-settings');
    const { writeMcpConfigRaw } = await import('../app/lib/mcp/config');
    const { closeAllMcpServers } = await import('../app/lib/mcp/manager');
    closeConnections = closeAllMcpServers;
    const { patchUnifiedEnvEntries } = await import('../app/lib/secrets/unified-env-store');
    await patchUnifiedEnvEntries([{ key: 'COMPOSIO_API_KEY', value: 'isolated-registry-fixture-key' }, { key: 'COMPOSIO_MODE', value: 'local' }], { secretScope: 'system' });
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    const { writePiRuntimeConfig } = await import('../app/lib/agents/storage');
    const configure = async (enabledTools: string[]) => writePiRuntimeConfig({ ...DEFAULT_PI_CONFIG,
      runtimeMigrations: { skillToolsDefaultEnabled: true },
      providers: { ...DEFAULT_PI_CONFIG.providers, [DEFAULT_PI_CONFIG.activeProvider]: {
        ...DEFAULT_PI_CONFIG.providers[DEFAULT_PI_CONFIG.activeProvider], enabledTools,
      } },
    });
    await configure([]);
    const startsFile = path.join(dataRoot, 'real-stdio-starts.txt');
    await writeMcpConfigRaw(JSON.stringify({ mcpServers: {
      selected: { command: process.execPath, args: ['--import', 'tsx', path.resolve('scripts/fixtures/fake-mcp-server.ts')],
        env: { MCP_START_FILE: startsFile }, directTools: ['echo'], displayName: 'Explicit direct connection' },
    } }), { userId: 'registry-user' });
    const { buildPiToolRegistryAsync, getPiTools, getPiToolMetadata } = await import('../app/lib/pi/tool-registry');
    const { isIntegrationGatewayTool, getIntegrationGatewayErrorOverride } = await import('../app/lib/pi/integration-tool-gateway');
    const { buildEffectiveToolManifest, buildEffectiveToolCapabilitiesPrompt } = await import('../app/lib/pi/effective-tool-manifest');
    const { filterToolsForPlanningMode } = await import('../app/lib/pi/planning-mode');
    const { getPiToolsetsForTool } = await import('../app/lib/pi/toolsets');
    const { isIntegrationOperationAllowed } = await import('../app/lib/integration-tools/policy');
    const { createToolLoopGuard } = await import('../app/lib/pi/tool-loop-guard');

    await setExperimentalFeatures('registry-user', { integrationToolGatewayEnabled: false });
    const legacy = await buildPiToolRegistryAsync('registry-user');
    assert(legacy.some(tool => tool.name === 'mcp'));
    assert(legacy.some(tool => tool.name === 'composio'));
    assert(!legacy.some(tool => tool.name === 'integrations'));
    // Snapshot the complete wire schema: Zod/TypeBox metadata can contain functions that are not transport-serializable.
    const legacySchemas = JSON.parse(JSON.stringify(legacy.map(tool => ({ name: tool.name, schema: tool.parameters }))));
    const direct = legacy.find(tool => tool.name.startsWith('mcp_'));
    assert(direct, 'an explicitly selected real MCP tool uses the existing direct schema');
    const starts = (await fs.readFile(startsFile, 'utf8')).trim().split('\n').length;
    await closeAllMcpServers();

    await setExperimentalFeatures('registry-user', { integrationToolGatewayEnabled: true });
    const unified = await buildPiToolRegistryAsync('registry-user');
    assert.equal(unified.filter(tool => tool.name === 'integrations').length, 1);
    assert(!unified.some(tool => tool.name === 'mcp' || tool.name === 'composio' || tool.name.startsWith('COMPOSIO_') || tool.name === 'composio_execute'));
    const cachedDirect = unified.find(tool => tool.name === direct.name);
    assert.deepEqual(cachedDirect?.parameters, direct.parameters, 'explicit direct MCP schemas survive the migration');
    assert.equal((await fs.readFile(startsFile, 'utf8')).trim().split('\n').length, starts, 'gateway registry construction does not start any MCP process or fetch tool catalogs');
    const manifest = buildEffectiveToolManifest(unified);
    assert.equal(manifest.tools.find(tool => tool.name === 'integrations')?.group, 'Integrations');
    const prompt = buildEffectiveToolCapabilitiesPrompt(manifest);
    assert.match(prompt, /providerRef/);
    assert.match(prompt, /schemaRef/);
    assert.match(prompt, /outcome_unknown/);
    assert.doesNotMatch(prompt, /### MCP gateway|### Connected-app gateway|COMPOSIO_SEARCH_TOOLS/);
    assert(!filterToolsForPlanningMode(unified).some(tool => tool.name === 'integrations' || tool.name === direct.name));
    assert.deepEqual(getPiToolsetsForTool('integrations').sort(), ['composio', 'mcp']);
    const metadata = await getPiToolMetadata();
    for (const name of ['mcp', 'COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'composio_execute', 'COMPOSIO_MANAGE_CONNECTIONS', 'integrations']) {
      assert(metadata.some(tool => tool.name === name), `management retains editable legacy preference ${name}`);
    }

    for (const [enabledTools, source, operations] of [
      [['mcp'], 'mcp', ['list_providers', 'search_providers', 'list_tools', 'search_tools', 'describe', 'call']],
      [['COMPOSIO_SEARCH_TOOLS'], 'composio', ['list_providers', 'search_providers', 'list_tools', 'search_tools']],
      [['COMPOSIO_GET_TOOL_SCHEMAS'], 'composio', ['describe']],
      [['composio_execute'], 'composio', ['call']],
      [['COMPOSIO_MANAGE_CONNECTIONS'], 'composio', ['list_providers', 'search_providers']],
    ] as const) {
      await configure([...enabledTools]);
      const tools = await getPiTools('registry-user');
      const gateway = tools.find(isIntegrationGatewayTool);
      assert(gateway);
      assert.deepEqual(gateway.integrationGateway.policyCeiling.allowedSources, [source]);
      assert.deepEqual(gateway.integrationGateway.policyCeiling.allowedOperations,
        operations.map(operation => `${source}.${operation}`).sort());
      assert(!isIntegrationOperationAllowed(gateway.integrationGateway.policyCeiling, source === 'mcp' ? 'composio' : 'mcp', 'call'));
    }
    await configure([direct.name]);
    const directOnly = await getPiTools('registry-user');
    assert.deepEqual(directOnly.map(tool => tool.name), [direct.name], 'a direct tool selection grants no proxy or app rights');
    for (const configured of [['integrations'], ['composio'], ['__none__'], ['  __none__  '], ['  __none__  ', 'mcp']]) {
      await configure(configured);
      assert.deepEqual((await getPiTools('registry-user')).map(tool => tool.name), [], 'new entrypoint and legacy group labels cannot create additional provider grants');
    }
    await configure([]);
    const automation = await getPiTools('registry-user', 'bradley', undefined, { automationExecution: true });
    assert(automation.some(isIntegrationGatewayTool), 'ordinary automations retain their granted integrations');
    const emailEvent = await getPiTools('registry-user', 'bradley', undefined, { workspaceEmailAutomation: {
      userId: 'registry-user', workspaceId: 'registry-workspace', eventId: 'event-1', mailboxId: 'mailbox-1',
      providerMessageId: 'message-1', providerThreadId: 'thread-1', folder: 'inbox', automationJobId: 'job-1', automationRunId: 'run-1', agentId: 'bradley',
    } });
    assert(!emailEvent.some(isIntegrationGatewayTool), 'untrusted inbox-triggered automations cannot acquire integrations');
    assert(emailEvent.some(tool => tool.name.startsWith('email_')), 'native bound email tools remain available');

    await database.db.insert(piSessions).values([
      { sessionId: 'parent-session', userId: 'registry-user', agentId: 'bradley', provider: 'fixture', model: 'fixture',
        workspaceId: 'registry-workspace', organizationId: 'registry-org', createdAt: now, updatedAt: now },
      { sessionId: 'worker-session', userId: 'registry-user', agentId: 'bradley', provider: 'fixture', model: 'fixture',
        sessionKind: 'delegation_worker', parentSessionId: 'parent-session', delegationDepth: 1,
        workspaceId: 'registry-workspace', organizationId: 'registry-org', createdAt: now, updatedAt: now },
    ]);
    const { createPiDelegation, claimQueuedPiDelegation, completeRunningPiDelegation } = await import('../app/lib/pi/delegation-store');
    const executionContext: AgentExecutionContext = {
      userId: 'registry-user', sessionId: 'worker-session', agentId: 'bradley', workspaceId: 'registry-workspace', workspaceType: 'personal',
      workspaceName: 'Registry workspace', organizationId: 'registry-org', customerId: null, projectId: null,
      workspaceRoot: path.join(dataRoot, 'workspace'), workspaceRootRelativePath: null, canWrite: true, canDelete: true, canShare: true, legacy: true,
    };
    for (const [toolset, expectedOperations] of [
      ['mcp', ['mcp.list_providers', 'mcp.search_providers', 'mcp.list_tools', 'mcp.search_tools', 'mcp.describe', 'mcp.call']],
      ['composio', ['composio.call']], ['file', []],
    ] as const) {
      const id = `registry-worker-${toolset}`;
      await createPiDelegation({ id, userId: 'registry-user', sourceSessionId: 'parent-session', sourceAgentId: 'bradley',
        workerSessionId: 'worker-session', workerType: 'managed', targetAgentId: 'bradley', goal: 'Test a constrained real worker grant', toolsets: [toolset] });
      await claimQueuedPiDelegation(id);
      const workerTools = await getPiTools('registry-user', 'bradley', 'worker-session', { executionContext });
      const gateway = workerTools.find(isIntegrationGatewayTool);
      assert.deepEqual(gateway?.integrationGateway.policyCeiling.allowedOperations ?? [], [...expectedOperations].sort(), 'actual persisted worker toolsets preserve their existing operation ceiling');
      await completeRunningPiDelegation({ id, resultStatus: 'ok', resultText: 'Registry policy checked.' });
      assert(!(await getPiTools('registry-user', 'bradley', 'worker-session', { executionContext })).some(isIntegrationGatewayTool), 'an idle worker cannot retain its previous integration rights');
    }

    const raw = await database.openDb();
    const ephemeralId = 'registry-ephemeral';
    await createPiDelegation({ id: ephemeralId, userId: 'registry-user', sourceSessionId: 'parent-session', sourceAgentId: 'bradley',
      workerSessionId: 'worker-session', workerType: 'ephemeral', goal: 'Execute one approved Composio action', toolsets: ['composio'] });
    await claimQueuedPiDelegation(ephemeralId);
    const ephemeralTools = await getPiTools('registry-user', 'bradley', 'worker-session', { executionContext });
    assert.deepEqual(ephemeralTools.map(tool => tool.name), ['integrations']);
    assert.deepEqual(ephemeralTools.find(isIntegrationGatewayTool)?.integrationGateway.policyCeiling.allowedOperations, ['composio.call']);
    await raw.run('UPDATE pi_delegations SET toolsets_json=$1 WHERE id=$2', ['["composio",null]', ephemeralId]);
    assert.deepEqual(await getPiTools('registry-user', 'bradley', 'worker-session', { executionContext }), [], 'malformed ephemeral toolsets deny every tool');
    await raw.run('UPDATE pi_delegations SET toolsets_json=$1,source_session_id=$2 WHERE id=$3', ['["composio"]', 'foreign-parent', ephemeralId]);
    assert.deepEqual(await getPiTools('registry-user', 'bradley', 'worker-session', { executionContext }), [], 'foreign parent provenance cannot grant ephemeral tools');
    await raw.run('UPDATE pi_delegations SET source_session_id=$1 WHERE id=$2', ['parent-session', ephemeralId]);
    await createPiDelegation({ id: 'registry-ephemeral-ambiguous', userId: 'registry-user', sourceSessionId: 'parent-session', sourceAgentId: 'bradley',
      workerSessionId: 'worker-session', workerType: 'ephemeral', goal: 'Ambiguous active task fixture', toolsets: ['composio'] });
    await claimQueuedPiDelegation('registry-ephemeral-ambiguous');
    assert.deepEqual(await getPiTools('registry-user', 'bradley', 'worker-session', { executionContext }), [], 'ambiguous active ephemeral tasks do not become unrestricted');
    await completeRunningPiDelegation({ id: 'registry-ephemeral-ambiguous', resultStatus: 'ok', resultText: 'Done.' });
    await setExperimentalFeatures('registry-user', { integrationToolGatewayEnabled: false });
    assert.deepEqual(await getPiTools('registry-user', 'bradley', 'worker-session', { executionContext }), [], 'flag-off ephemeral registry keeps its exact legacy rights');
    await setExperimentalFeatures('registry-user', { integrationToolGatewayEnabled: true });
    await completeRunningPiDelegation({ id: ephemeralId, resultStatus: 'ok', resultText: 'Done.' });
    assert.deepEqual(await getPiTools('registry-user', 'bradley', 'worker-session', { executionContext }), [], 'missing active ephemeral provenance denies tools');

    const { buildOnboardingProfileSessionId, isOnboardingProfileToolAvailable, ONBOARDING_PROFILE_TOOL_NAME } = await import('../app/lib/onboarding/profile');
    const { getUserOnboardingState, updateUserOnboardingState } = await import('../app/lib/user-preferences');
    const previousOnboarding = await getUserOnboardingState('registry-user');
    const onboardingSessionId = buildOnboardingProfileSessionId('registry-user');
    await updateUserOnboardingState('registry-user', { step: 'profile', profile: 'pending' });
    await database.db.insert(piSessions).values({ sessionId: onboardingSessionId, userId: 'registry-user', agentId: 'bradley',
      provider: 'fixture', model: 'fixture', workspaceId: executionContext.workspaceId,
      organizationId: executionContext.organizationId, createdAt: now, updatedAt: now });
    const onboardingContext = { ...executionContext, sessionId: onboardingSessionId };
    assert.equal(await isOnboardingProfileToolAvailable({ userId: 'registry-user', agentId: 'bradley', sessionId: onboardingSessionId }), true);
    for (const disabled of [['__none__'], ['  __none__  ', 'mcp']]) {
      await configure(disabled);
      assert.deepEqual(await getPiTools('registry-user', 'bradley', onboardingSessionId, { executionContext: onboardingContext }), [],
        'flag-on explicit denial stays empty even in the real pending-profile onboarding session');
    }
    await setExperimentalFeatures('registry-user', { integrationToolGatewayEnabled: false });
    assert((await getPiTools('registry-user', 'bradley', onboardingSessionId, { executionContext: onboardingContext }))
      .some(tool => tool.name === ONBOARDING_PROFILE_TOOL_NAME), 'flag-off keeps the exact legacy onboarding exception');
    await setExperimentalFeatures('registry-user', { integrationToolGatewayEnabled: true });
    await configure(['mcp']);
    assert((await getPiTools('registry-user', 'bradley', onboardingSessionId, { executionContext: onboardingContext }))
      .some(tool => tool.name === ONBOARDING_PROFILE_TOOL_NAME), 'normally enabled onboarding remains available');
    await updateUserOnboardingState('registry-user', previousOnboarding);
    await configure([]);

    const gateway = unified.find(isIntegrationGatewayTool);
    assert(gateway);
    const result = await gateway.execute('invalid-integration-request', { action: 'invented' } as never);
    const hookContext: AfterToolCallContext = {
      toolCall: { type: 'toolCall', id: 'invalid-integration-request', name: 'integrations', arguments: {} }, args: {}, result, isError: false,
      assistantMessage: { role: 'assistant', content: [], api: 'openai-completions', provider: 'fixture', model: 'fixture',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: Date.now() },
      context: { messages: [], tools: [gateway] },
    };
    assert.deepEqual(getIntegrationGatewayErrorOverride(hookContext), { isError: true });
    const guard = createToolLoopGuard();
    assert.deepEqual(guard.afterToolCall(hookContext), { isError: true }, 'the first structured gateway error is a genuine AgentCore tool error');
    const repeated = guard.afterToolCall(hookContext);
    assert.equal(repeated?.isError, true);
    assert((repeated?.details as { toolLoopGuard?: unknown })?.toolLoopGuard, 'repeated error metadata is preserved');
    guard.afterToolCall(hookContext);
    assert.equal(guard.afterToolCall(hookContext)?.terminate, true, 'the existing loop termination threshold is preserved');
    assert.equal(getIntegrationGatewayErrorOverride({ ...hookContext, toolCall: { ...hookContext.toolCall, name: 'read' } }), undefined, 'provider-style fields in another tool cannot become a gateway error');

    await setExperimentalFeatures('registry-user', { integrationToolGatewayEnabled: false });
    const restoredLegacy = await buildPiToolRegistryAsync('registry-user');
    const restoredSchemas = JSON.parse(JSON.stringify(restoredLegacy.map(tool => ({ name: tool.name, schema: tool.parameters }))));
    assert.deepEqual(restoredSchemas, legacySchemas, 'flag rollback restores the exact previous complete wire schemas');

    // Org-scoped installations cannot rely on a System/local key to keep their
    // editable Composio capabilities in metadata. Exercise the real config gate.
    const previousComposioApiKey = process.env.COMPOSIO_API_KEY;
    const previousManagedServices = process.env.CANVAS_MANAGED_SERVICES_ENABLED;
    try {
      delete process.env.COMPOSIO_API_KEY;
      process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'false';
      await patchUnifiedEnvEntries([{ key: 'COMPOSIO_API_KEY', value: null }], { secretScope: 'system' });
      const { isComposioConfigured } = await import('../app/lib/composio/composio-client');
      assert.equal(await isComposioConfigured(), false, 'the real System/local credential gate is unconfigured');
      assert.equal(await isComposioConfigured({ userId: 'registry-user' }), false, 'this actor has no personal credential fallback');
      const stdioStartsBeforeMetadata = await fs.readFile(startsFile, 'utf8');
      const unconfiguredMetadata = await getPiToolMetadata();
      for (const name of ['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'composio_execute', 'COMPOSIO_MANAGE_CONNECTIONS']) {
        assert(unconfiguredMetadata.some(tool => tool.name === name), `management retains ${name} without a System key`);
      }
      // Cache-only applies solely to the existing explicit MCP schemas. It does
      // not change the ordinary flag-off Composio eligibility or permission path.
      const unconfiguredLegacy = await buildPiToolRegistryAsync('registry-user', undefined, undefined, { metadataOnlyExternal: true });
      assert(unconfiguredLegacy.some(tool => tool.name === 'mcp'), 'ordinary legacy tools remain available');
      assert(!unconfiguredLegacy.some(tool => tool.name === 'composio' || tool.name.startsWith('COMPOSIO_')
        || tool.name === 'composio_execute' || tool.name === 'integrations'), 'metadata cannot add unconfigured runtime Composio executables');
      await configure(['composio_execute']);
      assert.deepEqual((await getPiTools('registry-user', undefined, undefined, { metadataOnlyExternal: true })).map(tool => tool.name), [],
        'an editable Composio preference does not grant execution when the actual credential gate is disabled');
      assert.equal(await fs.readFile(startsFile, 'utf8'), stdioStartsBeforeMetadata, 'the new metadata and runtime checks perform no MCP provider I/O');
    } finally {
      if (previousComposioApiKey === undefined) delete process.env.COMPOSIO_API_KEY;
      else process.env.COMPOSIO_API_KEY = previousComposioApiKey;
      if (previousManagedServices === undefined) delete process.env.CANVAS_MANAGED_SERVICES_ENABLED;
      else process.env.CANVAS_MANAGED_SERVICES_ENABLED = previousManagedServices;
      await patchUnifiedEnvEntries([{ key: 'COMPOSIO_API_KEY', value: 'isolated-registry-fixture-key' }], { secretScope: 'system' });
      await configure([]);
    }
    console.log('integration-tool-registry-test: ok');
  } finally {
    await closeConnections?.().catch(() => undefined);
    internals._load = originalLoad;
    restore();
    await database.close();
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
