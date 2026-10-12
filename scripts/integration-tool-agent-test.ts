import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { AgentToolResult, AfterToolCallContext } from '@earendil-works/pi-agent-core';
import type { IntegrationProviderDescriptor, IntegrationSource, IntegrationToolPage, IntegrationToolSchema } from '../app/lib/integration-tools/contracts';
import type { IntegrationToolAdapter } from '../app/lib/integration-tools/runtime-contracts';
import { createIntegrationPolicyFromLegacyTools, INTEGRATION_LEGACY_CAPABILITY_NAMES, UNRESTRICTED_INTEGRATION_POLICY } from '../app/lib/integration-tools/policy';
import { createPiTestDatabase } from './helpers/pi-test-database';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-integration-agent-'));
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_ORGANIZATION_ID: 'integration-agent-org',
    CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_MCP_DIRECT_ENABLED: 'false',
    BETTER_AUTH_BASE_URL: 'http://localhost:3000' };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const database = await createPiTestDatabase();
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    if (name === '@/app/lib/skills/effective-skill-read-roots') return {
      resolveEffectiveSkillReadRoots: async () => [], resolvePersonalSkillReadRoots: async () => [],
    };
    if (name === '@/app/lib/agents/workspace-brand-context') return { getWorkspaceBrandPromptBlock: async () => null };
    return originalLoad(name, parent, isMain);
  };
  try {
    const raw = await database.openDb();
    for (const userId of ['owner', 'alice', 'bob']) await raw.run(
      'INSERT INTO "user" (id,name,email,role,email_verified,created_at,updated_at) VALUES ($1,$1,$2,\'member\',1,1,1)', [userId, `${userId}@example.test`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('integration-agent-org','owner','team',1,1,1)");
    await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,created_at,updated_at) VALUES ('integration-agent-org','alice','member','active',1,1)");
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('team-a','integration-agent-org','team','workspaces/team-a/files','Team A','active',1,1)");
    await raw.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ('integration-agent-org','team-a','alice','member','active',1,0,0,1,1)");
    await raw.run("INSERT INTO agents (agent_id,name,type,access_policy,scope_type,organization_id,owner_user_id,enabled_tools_json,revision,created_at,updated_at) VALUES ('design-agent','Design agent','special','restricted','organization','integration-agent-org','owner','[]',1,1,1)");
    await raw.run("INSERT INTO agent_grants (id,agent_id,organization_id,target_type,target_id,can_use,can_edit,can_manage,created_at,updated_at) VALUES ('design-grant','design-agent','integration-agent-org','workspace','team-a',1,0,0,1,1)");
    const { piSessions } = await import('../app/lib/db/schema');
    const now = new Date();
    await database.db.insert(piSessions).values({ sessionId: 'agent-session', userId: 'alice', agentId: 'design-agent',
      workspaceId: 'team-a', workspaceType: 'team', organizationId: 'integration-agent-org', provider: 'fixture', model: 'fixture', createdAt: now, updatedAt: now });
    const { resolveIntegrationExecutionContext } = await import('../app/lib/integration-tools/context');
    const { createIntegrationProviderRef } = await import('../app/lib/integration-tools/references');
    const { IntegrationContractError } = await import('../app/lib/integration-tools/contracts');
    const { IntegrationDispatcher } = await import('../app/lib/integration-tools/dispatcher');
    const { createIntegrationGatewayTool, getIntegrationGatewayErrorOverride } = await import('../app/lib/pi/integration-tool-gateway');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const resolved = await resolveIntegrationExecutionContext({ actorUserId: 'alice', sessionId: 'agent-session', policyRevision: 'test' });
    const context = { ...resolved.executionContext, agentTurnId: 'initial-human-turn' };
    const scope = { type: 'user' as const, resourceId: 'fixture-account', ownerUserId: 'alice' };
    const providers = Object.fromEntries((['mcp', 'composio'] as const).map((source) => {
      const providerRef = source === 'mcp'
        ? createIntegrationProviderRef({ source, scope, connectionId: 'actual-fixture-connection' })
        : createIntegrationProviderRef({ source, scope, profileId: 'actual-fixture-profile', toolkit: 'canva' });
      return [source, { providerRef, source, application: 'canva', displayName: `${source} design fixture`, scope,
        connection: { displayName: 'Fixture Account A', effective: true }, configured: true, requiresAuth: false, authorized: true,
        state: 'ready', health: 'healthy', canExecute: true, checkedAt: '2026-10-06T00:00:00Z', statusSource: 'provider',
        pluginRefs: [], skillRefs: [], matchReasons: [], nextActions: [] } satisfies IntegrationProviderDescriptor];
    })) as unknown as Record<IntegrationSource, IntegrationProviderDescriptor>;
    const counts = { catalog: 0, resolve: 0, describe: 0, business: 0 };
    const businessSources: IntegrationSource[] = [];
    const capturedArguments: Array<Record<string, unknown>> = [];
    let beforeDescribe: (() => Promise<void>) | undefined;
    let beforeCatalog: (() => Promise<void>) | undefined;
    let failure: Error | undefined;
    let bindingRevision = 'fixture-binding-1';
    let schemaRevision = 1;
    let enabled = true;
    const nativeContent = [{ type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' }, { type: 'text' as const, text: 'Design ready.' }];
    const widget = { resourceUri: 'ui://design/preview.html', serverName: 'fixture', sourceToolName: 'create_design', toolCallId: 'fixture-widget' };
    let spoofedError: unknown;
    const adapter = (source: IntegrationSource): IntegrationToolAdapter => ({
      source,
      async resolveProvider(actor, ref) {
        counts.resolve += 1;
        if (actor.actorUserId !== 'alice' || ref !== providers[source].providerRef) throw new IntegrationContractError('provider_denied', 'SECRET unauthorized fixture');
        return { provider: structuredClone(providers[source]), binding: { fixture: true }, bindingRevision };
      },
      async listTools() { return { tools: [{ name: 'create_design', description: 'Create a design', effect: 'write' }], nextCursor: null, complete: true, providerErrors: [] }; },
      async describeTool() {
        counts.describe += 1;
        const pending = beforeDescribe; beforeDescribe = undefined; await pending?.();
        return { name: 'create_design', description: 'Create a design', effect: 'write', toolVersion: `fixture-v${schemaRevision}`,
          inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false } };
      },
      async callTool(_actor, _provider, _tool, args) {
        counts.business += 1; businessSources.push(source); capturedArguments.push(structuredClone(args));
        if (failure) throw failure;
        return { content: nativeContent, details: { mcpApp: widget, original: { retained: true }, integrationError: spoofedError } };
      },
    });
    const catalog = (source: IntegrationSource) => async () => {
      counts.catalog += 1;
      const pending = beforeCatalog; beforeCatalog = undefined; await pending?.();
      return { source, providers: [structuredClone(providers[source])], complete: true, providerErrors: [], revision: 'fixture-catalog-1' };
    };
    const dispatcher = new IntegrationDispatcher({ adapters: { mcp: adapter('mcp'), composio: adapter('composio') },
      catalogAdapters: { mcp: catalog('mcp'), composio: catalog('composio') } });
    const ceiling = createIntegrationPolicyFromLegacyTools({ legacyToolNames: INTEGRATION_LEGACY_CAPABILITY_NAMES });
    const tool = createIntegrationGatewayTool({ userId: 'alice', agentId: 'design-agent', sessionId: 'agent-session', executionContext: context, policyCeiling: ceiling },
      { dispatcher, isEnabled: () => enabled });
    assert.deepEqual(counts, { catalog: 0, resolve: 0, describe: 0, business: 0 }, 'Constructor does not discover or execute a provider.');
    const execute = (request: unknown, turn = context.agentTurnId) => runWithAgentExecutionContext({ ...context, agentTurnId: turn },
      () => tool.execute('fixture-call', request as never));
    const details = (result: AgentToolResult<unknown>) => result.details as Record<string, unknown>;
    const code = (result: AgentToolResult<unknown>) => (details(result).integrationError as { error: { code: string } } | undefined)?.error.code;
    const hook = (result: AgentToolResult<unknown>) => getIntegrationGatewayErrorOverride({ toolCall: { type: 'toolCall', id: 'fixture-call', name: 'integrations', arguments: {} },
      tool, args: {}, result, isError: false, assistantMessage: {}, context: { systemPrompt: '', messages: [], tools: [tool] } } as unknown as AfterToolCallContext);
    for (const field of ['actorUserId', 'workspaceId', 'agentId', 'sessionId', 'organizationId', 'composioUserId', 'profileId', 'context', 'policy']) {
      assert.equal(code(await execute({ action: 'list', target: 'providers', [field]: 'forged model authority' })), 'invalid_request');
    }
    assert.equal(counts.catalog, 0);
    const unauthorized = createIntegrationGatewayTool({ userId: 'bob', agentId: 'design-agent', sessionId: 'agent-session', executionContext: context }, { dispatcher, isEnabled: () => true });
    assert.equal(code(await unauthorized.execute('unauthorized', { action: 'list', target: 'providers' })), 'provider_denied');
    const missing = createIntegrationGatewayTool({}, { dispatcher, isEnabled: () => true });
    assert.equal(code(await missing.execute('missing-authority', { action: 'list', target: 'providers' })), 'provider_denied');
    const forgedWorkspace = createIntegrationGatewayTool({ userId: 'alice', agentId: 'design-agent', sessionId: 'agent-session',
      executionContext: { ...context, workspaceId: 'forged-workspace' } }, { dispatcher, isEnabled: () => true });
    assert.equal(code(await forgedWorkspace.execute('forged-workspace', { action: 'list', target: 'providers' })), 'provider_denied');
    assert.equal(counts.catalog, 0);
    const narrowed = tool.integrationGateway.withPolicyCeiling(createIntegrationPolicyFromLegacyTools({ legacyToolNames: ['mcp'] }))
      .integrationGateway.withPolicyCeiling(UNRESTRICTED_INTEGRATION_POLICY);
    const narrowedPage = await runWithAgentExecutionContext(context, () => narrowed.execute('narrowed', { action: 'list', target: 'providers' }));
    assert.deepEqual((details(narrowedPage).providers as IntegrationProviderDescriptor[]).map((item) => item.source), ['mcp']);
    const mutableCeiling = { ...ceiling, allowedSources: ['mcp'] as IntegrationSource[] };
    const immutableTool = createIntegrationGatewayTool({ userId: 'alice', agentId: 'design-agent', sessionId: 'agent-session', executionContext: context, policyCeiling: mutableCeiling }, { dispatcher, isEnabled: () => true });
    mutableCeiling.allowedSources.push('composio');
    const immutablePage = await runWithAgentExecutionContext(context, () => immutableTool.execute('immutable-ceiling', { action: 'list', target: 'providers' }));
    assert.deepEqual((details(immutablePage).providers as IntegrationProviderDescriptor[]).map((item) => item.source), ['mcp']);

    const mutableMatrix = { ...ceiling, providerToolRules: [{ source: 'mcp' as const, providerRef: providers.mcp.providerRef,
      allowedToolNames: ['create_design'], allowedOperations: ['list_providers', 'list_tools', 'describe'] as const }] };
    const immutableMatrix = createIntegrationGatewayTool({ userId: 'alice', agentId: 'design-agent', sessionId: 'agent-session',
      executionContext: context, policyCeiling: mutableMatrix }, { dispatcher, isEnabled: () => true });
    mutableMatrix.providerToolRules[0].allowedToolNames.push('other_design');
    const exposedRule = immutableMatrix.integrationGateway.policyCeiling.providerToolRules![0];
    assert.equal(Reflect.set(exposedRule, 'allowedToolNames', null), false, 'A registered ceiling cannot lose its tool restriction.');
    assert.equal(Reflect.set(exposedRule.allowedToolNames!, '0', 'other_design'), false);
    assert.equal(Reflect.set(exposedRule.allowedOperations!, '3', 'call'), false, 'An exposed operation array cannot grant calls.');
    const matrixTools = await runWithAgentExecutionContext(context, () => immutableMatrix.execute('immutable-matrix-list',
      { action: 'list', target: 'tools', providerRef: providers.mcp.providerRef }));
    const matrixRef = (details(matrixTools) as IntegrationToolPage).tools[0].toolRef;
    const matrixSchema = details(await runWithAgentExecutionContext(context, () => immutableMatrix.execute('immutable-matrix-describe',
      { action: 'describe', toolRef: matrixRef }))) as IntegrationToolSchema;
    const beforeMatrixCall = counts.business;
    assert.equal(code(await runWithAgentExecutionContext(context, () => immutableMatrix.execute('immutable-matrix-call',
      { action: 'call', toolRef: matrixSchema.toolRef, schemaRef: matrixSchema.schemaRef, arguments: { message: 'Blocked' } }))), 'tool_denied');
    assert.equal(counts.business, beforeMatrixCall, 'Nested ceiling mutation attempts cannot enable a business call.');

    const page = await execute({ action: 'list', target: 'providers' });
    assert.equal((details(page).providers as IntegrationProviderDescriptor[]).length, 2);
    const describe = async (source: IntegrationSource = 'mcp', turn = context.agentTurnId) => {
      const tools = await execute({ action: 'list', target: 'tools', providerRef: providers[source].providerRef }, turn);
      assert.equal(code(tools), undefined);
      const toolRef = (details(tools) as IntegrationToolPage).tools[0].toolRef;
      const schema = await execute({ action: 'describe', toolRef }, turn);
      assert.equal(code(schema), undefined);
      return details(schema) as IntegrationToolSchema;
    };
    const call = (schema: IntegrationToolSchema, args = { message: 'SECRET user arguments' }, turn = context.agentTurnId) => execute({ action: 'call', toolRef: schema.toolRef, schemaRef: schema.schemaRef, arguments: args }, turn);
    const initialSchema = await describe();
    const mutableArgs = { message: 'ORIGINAL argument' };
    const mutableRequest = { action: 'call', toolRef: initialSchema.toolRef, schemaRef: initialSchema.schemaRef, arguments: mutableArgs };
    const pendingCall = execute(mutableRequest);
    mutableArgs.message = 'MUTATED argument';
    const native = await pendingCall;
    assert.equal(code(native), undefined);
    assert.equal(capturedArguments.at(-1)?.message, 'ORIGINAL argument');
    assert.deepEqual(native.content, nativeContent);
    assert.deepEqual(details(native).mcpApp, widget);
    assert.deepEqual(details(native).original, { retained: true });
    const beforeInvalid = counts.business;
    const invalid = await call(initialSchema, { message: 7 } as unknown as { message: string });
    assert.equal(code(invalid), 'invalid_arguments');
    assert.equal(counts.business, beforeInvalid);
    assert.equal((details(invalid).integrationError as { nextActions: unknown[] }).nextActions.length, 1);
    assert.deepEqual(hook(invalid), { isError: true });

    beforeDescribe = async () => { await raw.run("UPDATE agent_grants SET can_use=0 WHERE agent_id='design-agent'"); };
    const revoked = await call(initialSchema);
    assert.equal(code(revoked), 'provider_denied');
    assert.equal(counts.business, beforeInvalid, 'Fresh actual agent grant revocation during describe prevents the business call.');
    await raw.run("UPDATE agent_grants SET can_use=1 WHERE agent_id='design-agent'");
    const preferencesSchema = await describe();
    beforeDescribe = async () => { await raw.run("UPDATE agents SET enabled_tools_json='[\"COMPOSIO_SEARCH_TOOLS\"]',revision=revision+1 WHERE agent_id='design-agent'"); };
    const preferencesRevoked = await call(preferencesSchema);
    assert.equal(code(preferencesRevoked), 'schema_changed');
    assert.equal(counts.business, beforeInvalid);
    await raw.run("UPDATE agents SET enabled_tools_json='[]',revision=revision+1 WHERE agent_id='design-agent'");
    beforeCatalog = async () => { await raw.run("UPDATE agent_grants SET can_use=0 WHERE agent_id='design-agent'"); };
    const hiddenMetadata = await execute({ action: 'list', target: 'providers' });
    assert.equal(code(hiddenMetadata), 'provider_denied');
    assert.doesNotMatch(JSON.stringify(hiddenMetadata), /design fixture|Fixture Account A/);
    await raw.run("UPDATE agent_grants SET can_use=1 WHERE agent_id='design-agent'");
    const flagSchema = await describe();
    beforeDescribe = async () => { enabled = false; };
    assert.equal(code(await call(flagSchema)), 'tool_denied');
    assert.equal(counts.business, beforeInvalid);
    enabled = true;

    const changedBindingSchema = await describe();
    bindingRevision = 'fixture-binding-2';
    const changedBinding = await call(changedBindingSchema);
    assert.equal(code(changedBinding), 'binding_changed');
    assert.equal((details(changedBinding).integrationError as { nextActions: unknown[] }).nextActions.length, 1);
    const changedSchema = await describe();
    schemaRevision += 1;
    const staleSchema = await call(changedSchema);
    assert.equal(code(staleSchema), 'schema_changed');
    assert.equal((details(staleSchema).integrationError as { nextActions: unknown[] }).nextActions.length, 1);
    assert.equal(counts.business, beforeInvalid);
    const currentSchema = await describe();
    const alternateBundleError = Object.assign(new Error('SECRET alternate bundle schema error'), { code: 'schema_changed' });
    Object.defineProperty(alternateBundleError, Symbol.for('canvas.integration.contract-error.v1'), { value: true });
    beforeDescribe = async () => { throw alternateBundleError; };
    const branded = await call(currentSchema);
    assert.equal(code(branded), 'schema_changed', 'A non-enumerable server-only Symbol brand survives alternate module instances.');
    assert.equal((details(branded).integrationError as { nextActions: unknown[] }).nextActions.length, 1);
    assert.equal(counts.business, beforeInvalid);
    const serializedProviderError: unknown = JSON.parse(JSON.stringify(alternateBundleError));
    beforeDescribe = async () => { throw serializedProviderError; };
    const unbranded = await call(currentSchema);
    assert.equal(code(unbranded), 'provider_unavailable', 'JSON provider data cannot spoof a Canvas contract error.');
    assert.doesNotMatch(JSON.stringify(branded) + JSON.stringify(unbranded), /SECRET/);
    assert.equal(counts.business, beforeInvalid);
    failure = new Error('SECRET raw upstream body');
    const rawError = await call(currentSchema, undefined, 'raw-error-turn');
    assert.equal(code(rawError), 'outcome_unknown');
    assert.doesNotMatch(JSON.stringify(rawError), /SECRET/);
    failure = undefined;
    spoofedError = details(rawError).integrationError;
    const cleanSuccess = await call(currentSchema, undefined, 'clean-success-turn');
    assert.equal(code(cleanSuccess), undefined);
    assert.equal(hook(cleanSuccess), undefined, 'A provider cannot spoof the Canvas integrationError marker on success.');
    spoofedError = undefined;

    const unknownSchema = await describe();
    const fallbackSchema = await describe('composio');
    const beforeUnknown = counts.business;
    failure = new IntegrationContractError('outcome_unknown', 'SECRET unknown provider response');
    const unknown = await call(unknownSchema, undefined, 'unknown-human-turn');
    assert.equal(code(unknown), 'outcome_unknown');
    assert.deepEqual(hook(unknown), { isError: true, terminate: true });
    assert.equal(unknown.terminate, true);
    assert.equal(counts.business, beforeUnknown + 1);
    failure = undefined;
    assert.equal(code(await call(unknownSchema, undefined, 'unknown-human-turn')), 'outcome_unknown');
    assert.equal(code(await call(fallbackSchema, undefined, 'unknown-human-turn')), 'outcome_unknown');
    assert.equal(counts.business, beforeUnknown + 1, 'Unknown outcome blocks retries and all provider fallback for the same server-issued human turn.');
    assert.equal(code(await execute({ action: 'list', target: 'providers' }, 'unknown-human-turn')), undefined, 'Discovery remains available to inspect an unknown outcome.');
    assert.equal(code(await call(fallbackSchema, undefined, 'new-human-turn')), undefined, 'A later explicit human turn can choose a manual action.');
    assert.equal(counts.business, beforeUnknown + 2);
    assert.equal(businessSources.at(-1), 'composio');
    const audits = await raw.all("SELECT user_id,session_id,agent_id,action,status,metadata_json,input_hash,output_hash FROM audit_events WHERE event_type='integration'") as Array<Record<string, unknown>>;
    assert(audits.length > 5, 'The actual audit service persists success, blocked and unknown events.');
    assert(audits.some((entry) => entry.status === 'success') && audits.some((entry) => entry.status === 'error') && audits.some((entry) => entry.status === 'blocked'));
    assert(audits.every((entry) => entry.user_id === 'alice' && entry.session_id === 'agent-session' && entry.agent_id === 'design-agent'));
    assert(audits.every((entry) => entry.input_hash === null && entry.output_hash === null));
    assert.doesNotMatch(JSON.stringify(audits), /SECRET|ORIGINAL argument|MUTATED argument|raw upstream|unknown provider/);
    const allowedAuditKeys = new Set(['version', 'action', 'providerRef', 'toolRef', 'schemaRef', 'source', 'code', 'toolCallId', 'durationMs']);
    assert(audits.every((entry) => Object.keys(JSON.parse(String(entry.metadata_json))).every((key) => allowedAuditKeys.has(key))));
    // MCP workers have no Composio snapshot. Their actual persisted task must
    // still carry the trusted issuing turn and prevent parent/sibling retries.
    const { DEFAULT_AGENT_ID } = await import('../app/lib/channels/constants');
    const { getAgentProfile } = await import('../app/lib/agents/registry');
    const { createPiDelegation, claimQueuedPiDelegation } = await import('../app/lib/pi/delegation-store');
    const { isPersistedIntegrationTurnUncertain } = await import('../app/lib/integration-tools/uncertain-turn-store');
    await getAgentProfile(DEFAULT_AGENT_ID);
    await database.db.insert(piSessions).values({ sessionId: 'mcp-parent', userId: 'alice', agentId: DEFAULT_AGENT_ID,
      workspaceId: 'team-a', workspaceType: 'team', organizationId: 'integration-agent-org',
      provider: 'fixture', model: 'fixture', createdAt: now, updatedAt: now });
    const parentContext = { ...(await resolveIntegrationExecutionContext({ actorUserId: 'alice', sessionId: 'mcp-parent',
      policyRevision: 'fixture' })).executionContext, agentTurnId: 'mcp-parent-issued-turn' };
    const parentTool = createIntegrationGatewayTool({ userId: 'alice', agentId: DEFAULT_AGENT_ID, sessionId: 'mcp-parent',
      executionContext: parentContext, policyCeiling: ceiling }, { dispatcher, isEnabled: () => enabled });
    const workerFactory = async (id: string) => {
      const childSessionId = `mcp-child-${id}`;
      await database.db.insert(piSessions).values({ sessionId: childSessionId, userId: 'alice', agentId: 'design-agent',
        workspaceId: 'team-a', workspaceType: 'team', organizationId: 'integration-agent-org', sessionKind: 'delegation_worker',
        parentSessionId: 'mcp-parent', delegationDepth: 1, provider: 'fixture', model: 'fixture', createdAt: now, updatedAt: now });
      const task = await createPiDelegation({ id: `mcp-task-${id}`, userId: 'alice', sourceSessionId: 'mcp-parent',
        sourceAgentId: DEFAULT_AGENT_ID, sourceAgentTurnId: parentContext.agentTurnId, workerSessionId: childSessionId,
        targetAgentId: 'design-agent', workerType: 'managed', goal: 'Create the approved design', toolsets: ['mcp'] });
      assert.equal(task.integrationBindingsJson, null, 'The generic source-turn guard does not require a Composio handoff.');
      await claimQueuedPiDelegation(task.id, 'mcp-fixture');
      const childContext = { ...(await resolveIntegrationExecutionContext({ actorUserId: 'alice', sessionId: childSessionId,
        policyRevision: 'fixture' })).executionContext, agentTurnId: `mcp-worker-turn-${id}` };
      const childTool = createIntegrationGatewayTool({ userId: 'alice', agentId: 'design-agent', sessionId: childSessionId,
        executionContext: childContext, policyCeiling: ceiling }, { dispatcher, isEnabled: () => enabled });
      const invoke = (request: unknown) => runWithAgentExecutionContext(childContext, () => childTool.execute(id, request as never));
      const toolPage = await invoke({ action: 'list', target: 'tools', providerRef: providers.mcp.providerRef });
      assert.equal(code(toolPage), undefined);
      const schemaResult = await invoke({ action: 'describe', toolRef: (details(toolPage) as IntegrationToolPage).tools[0].toolRef });
      assert.equal(code(schemaResult), undefined);
      return { invoke, schema: details(schemaResult) as IntegrationToolSchema };
    };
    const worker = await workerFactory('first');
    const beforeWorkerUnknown = counts.business;
    failure = new IntegrationContractError('outcome_unknown', 'SECRET uncertain MCP result');
    assert.equal(code(await worker.invoke({ action: 'call', toolRef: worker.schema.toolRef, schemaRef: worker.schema.schemaRef,
      arguments: { message: 'Worker design' } })), 'outcome_unknown');
    failure = undefined;
    assert.equal(counts.business, beforeWorkerUnknown + 1);
    assert.equal(await isPersistedIntegrationTurnUncertain(parentContext), true, 'Actual child execution persists the exact parent-issued turn.');
    const uncertainGlobal = globalThis as typeof globalThis & { __canvasIntegrationUncertainTurnsV1?: Map<string, unknown> };
    uncertainGlobal.__canvasIntegrationUncertainTurnsV1?.clear();
    const sibling = await workerFactory('fresh-sibling');
    assert.equal(code(await sibling.invoke({ action: 'call', toolRef: sibling.schema.toolRef, schemaRef: sibling.schema.schemaRef,
      arguments: { message: 'Sibling retry' } })), 'outcome_unknown');
    const parentInvoke = (request: unknown, turn = parentContext.agentTurnId) => runWithAgentExecutionContext({ ...parentContext, agentTurnId: turn },
      () => parentTool.execute('mcp-parent-call', request as never));
    const parentPage = await parentInvoke({ action: 'list', target: 'tools', providerRef: providers.mcp.providerRef });
    const parentSchema = details(await parentInvoke({ action: 'describe', toolRef: (details(parentPage) as IntegrationToolPage).tools[0].toolRef })) as IntegrationToolSchema;
    const parentRequest = { action: 'call', toolRef: parentSchema.toolRef, schemaRef: parentSchema.schemaRef, arguments: { message: 'Manual design' } };
    assert.equal(code(await parentInvoke(parentRequest)), 'outcome_unknown');
    assert.equal(counts.business, beforeWorkerUnknown + 1, 'Durable parent and fresh sibling guards prevent any second business invocation.');
    assert.equal(code(await parentInvoke(parentRequest, 'mcp-new-explicit-human-turn')), undefined);
    assert.equal(counts.business, beforeWorkerUnknown + 2);
    console.log('PASS actual PG agent gateway: default authorization/audit, model identity rejection, final revocation guards, immutable payloads/ceilings, native results, safe errors and uncertain-turn fallback lock.');
  } finally {
    internals._load = originalLoad;
    await database.close();
    await rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
