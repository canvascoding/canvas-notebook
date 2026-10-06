import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import type { Client, Tool } from '@modelcontextprotocol/client';
import type { IntegrationToolAdapter } from '../app/lib/integration-tools/runtime-contracts';
import { installMcpAccessMocks } from './fixtures/mcp-test-access';

const initialTools: Tool[] = [
  { name: 'create_design', description: 'Create a design with nested layout parameters.',
    inputSchema: { type: 'object', properties: { layout: { $ref: '#/$defs/layout' } }, required: ['layout'],
      $defs: { layout: { type: 'object', properties: { title: { type: 'string' }, size: { enum: ['square', 'wide'] } }, required: ['title', 'size'], additionalProperties: false } }, additionalProperties: false },
    outputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, annotations: { readOnlyHint: false } },
  { name: 'read_design', description: 'Read an existing design.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, annotations: { readOnlyHint: true } },
  { name: 'widget_design', description: 'Show a design preview.', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://design/preview.html', visibility: ['model', 'app'] } } },
  { name: 'internal_ui', description: 'Only the app may use this action.', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['app'] } } },
];

async function startFixture() {
  let origin = '';
  let requests = 0;
  let lists = 0;
  const calls: Array<{ name: string; arguments: unknown }> = [];
  let tools = structuredClone(initialTools);
  let onNextList: (() => void | Promise<void>) | undefined;
  let listsUntilChange = 1;
  let dropNextCall = false;
  let resultMode: 'normal' | 'large' | 'image' = 'normal';
  const large = 'head '.repeat(4_000) + 'EXACT_MIDDLE_OUTPUT' + ' tail'.repeat(4_000);
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'integration-runtime-fixture', version: '1' }, { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler('tools/list', async () => {
      lists += 1;
      const change = onNextList && --listsUntilChange === 0 ? onNextList : undefined;
      if (change) onNextList = undefined;
      await change?.();
      return { tools };
    });
    server.setRequestHandler('tools/call', async request => {
      calls.push({ name: request.params.name, arguments: request.params.arguments });
      if (resultMode === 'image') return { content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], structuredContent: { id: 'image-design' } };
      return {
        content: [{ type: 'text', text: resultMode === 'large' ? large : 'Design created.' }],
        structuredContent: { id: 'created-design', arguments: request.params.arguments, ...(resultMode === 'large' ? { body: large } : {}) },
        _meta: { privateWidgetMarker: 'PRIVATE_WIDGET_ONLY' },
      };
    });
    return server;
  }, { legacy: 'reject' });
  const server = http.createServer(async (request, response) => {
    requests += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    let isCall = false;
    try { isCall = JSON.parse(body).method === 'tools/call'; } catch { /* Non-JSON lifecycle requests are permitted. */ }
    const result = await handler.fetch(new Request(`${origin}${request.url}`, {
      method: request.method,
      headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      ...(body ? { body } : {}),
    }));
    if (dropNextCall && isCall) {
      dropNextCall = false;
      response.destroy();
      return;
    }
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.headers.get('content-type')?.includes('text/event-stream')) response.flushHeaders();
    if (result.body) {
      for await (const chunk of result.body) response.write(Buffer.from(chunk));
    }
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/mcp`, calls, large,
    get requests() { return requests; }, get lists() { return lists; },
    get tools() { return tools; }, set tools(value: Tool[]) { tools = value; },
    onNextList(change: () => void | Promise<void>, afterLists = 1) { onNextList = change; listsUntilChange = afterLists; },
    dropNextCall() { dropNextCall = true; },
    notifyToolsChanged() { handler.notify.toolsChanged(); },
    setResultMode(mode: typeof resultMode) { resultMode = mode; },
    close: async () => {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function expectCode(task: () => Promise<unknown>, code: string) {
  await assert.rejects(task, error => Boolean(error && typeof error === 'object' && 'code' in error && error.code === code));
}

async function main() {
  const environmentKeys = ['CANVAS_DATA_ROOT', 'DATA', 'INTEGRATIONS_ENV_MASTER_KEY', 'BASE_URL', 'MCP_ALLOW_INSECURE_HTTP', 'MCP_ALLOW_PRIVATE_NETWORK', 'MCP_ALLOW_STDIO'] as const;
  const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-integration-mcp-runtime-'));
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.DATA = dataRoot;
  process.env.INTEGRATIONS_ENV_MASTER_KEY = crypto.randomBytes(32).toString('base64url');
  process.env.BASE_URL = 'http://localhost:3000';
  process.env.MCP_ALLOW_INSECURE_HTTP = 'true';
  process.env.MCP_ALLOW_PRIVATE_NETWORK = 'true';
  const { memberships, restore } = installMcpAccessMocks();
  const moduleInternals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const accessFixtureLoad = moduleInternals._load;
  let afterValidatedMetadata: (() => Promise<void>) | undefined;
  let afterGuardEnvironmentRead: (() => Promise<void>) | undefined;
  let remainingEnvironmentReads = 0;
  moduleInternals._load = (request, parent, isMain) => {
    const loaded = accessFixtureLoad(request, parent, isMain);
    if (request === '@/app/lib/mcp/env-runtime') {
      const original = loaded as typeof import('../app/lib/mcp/env-runtime');
      return { ...original, readMcpAvailableEnvSnapshot: async (...input: Parameters<typeof original.readMcpAvailableEnvSnapshot>) => {
        if (afterGuardEnvironmentRead && --remainingEnvironmentReads === 0) {
          const mutation = afterGuardEnvironmentRead;
          afterGuardEnvironmentRead = undefined;
          await mutation();
        }
        return original.readMcpAvailableEnvSnapshot(...input);
      } };
    }
    if (request === '@/app/lib/mcp/manager') {
      const original = loaded as typeof import('../app/lib/mcp/manager');
      return { ...original, callMcpToolWithCurrentMetadata: (...input: Parameters<typeof original.callMcpToolWithCurrentMetadata>) => {
        const options = input[5];
        if (options?.validateTool) {
          const validateTool = options.validateTool;
          input[5] = { ...options, validateTool: async (...metadata: Parameters<typeof validateTool>) => {
            await validateTool(...metadata);
            if (afterValidatedMetadata) {
              afterGuardEnvironmentRead = afterValidatedMetadata;
              afterValidatedMetadata = undefined;
              // First read is the immediate manager check; second is the
              // actual HTTP credentials snapshot before header construction.
              remainingEnvironmentReads = 2;
            }
          } };
        }
        return original.callMcpToolWithCurrentMetadata(...input);
      } };
    }
    return loaded;
  };
  memberships.set('admin', { organizationId: 'org-a', role: 'admin', status: 'active' });
  memberships.set('member', { organizationId: 'org-a', role: 'member', status: 'active' });
  memberships.set('other', { organizationId: 'org-b', role: 'admin', status: 'active' });
  const fixture = await startFixture();
  const { mcpIntegrationToolAdapter: adapter } = await import('../app/lib/integration-tools/adapters/mcp-runtime');
  const { listMcpIntegrationProviders } = await import('../app/lib/integration-tools/adapters/mcp');
  const { readMcpConfig, writeMcpConfigRaw } = await import('../app/lib/mcp/config');
  const { publishMcpServerDefinition, setMcpServerDefinitionEnabled } = await import('../app/lib/mcp/server-definitions');
  const { createPersonalMcpConnection } = await import('../app/lib/mcp/personal-connections');
  const { patchUnifiedEnvEntries } = await import('../app/lib/secrets/unified-env-store');
  const { invalidateMcpOAuthGeneration } = await import('../app/lib/mcp/oauth-lifecycle');
  const { closeAllMcpServers, closeMcpServer, closeMcpServersForScope, listMcpTools, callMcpToolWithCurrentMetadata } = await import('../app/lib/mcp/manager');
  const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
  const { getToolOutputMetadata } = await import('../app/lib/pi/tool-output-metadata');
  const { readStoredToolOutput } = await import('../app/lib/pi/tool-output-store');
  const { projectAgentMessageForLoadedContext } = await import('../app/lib/pi/message-projection');
  const { IntegrationDispatcher } = await import('../app/lib/integration-tools/dispatcher');
  const { UNRESTRICTED_INTEGRATION_POLICY } = await import('../app/lib/integration-tools/policy');
  const { integrationMetadataCache } = await import('../app/lib/integration-tools/metadata-cache');
  const context = { actorUserId: 'admin', organizationId: 'org-a', workspaceId: 'team-workspace', agentId: 'design-agent', policyRevision: 'policy-1' };
  const scope = { userId: 'admin', organizationId: 'org-a' };
  const args = { layout: { title: 'Design A', size: 'square' } };
  const identity = {
    organizationId: 'org-a', userId: 'admin', sessionId: 'runtime-session', workspaceId: 'team-workspace',
    agentId: 'design-agent', workspaceType: 'team' as const, workspaceName: null, customerId: null, projectId: null,
    workspaceRoot: path.join(dataRoot, 'workspace'), workspaceRootRelativePath: null, canWrite: true, canDelete: false, canShare: false, legacy: false,
  };

  try {
    await writeMcpConfigRaw(JSON.stringify({ mcpServers: {
      fixture: { url: fixture.url, auth: 'none', timeoutMs: 1000, bearerTokenEnv: 'DESIGN_TOKEN', displayName: 'Canva' },
      unused: { url: `${fixture.url}/unused`, auth: 'none', displayName: 'Other unused account' },
    } }), scope);
    await patchUnifiedEnvEntries([{ key: 'DESIGN_TOKEN', value: 'account-a-private-key' }], { userId: 'admin' });
    const descriptor = (await listMcpIntegrationProviders(context)).providers.find(provider => provider.displayName === 'Canva');
    assert(descriptor);
    const provider = await adapter.resolveProvider(context, descriptor.providerRef);
    assert.equal(fixture.requests, 0, 'resolving an opaque provider does not start it or discover unrelated servers');
    await expectCode(() => adapter.resolveProvider({ ...context, actorUserId: 'other', organizationId: 'org-b' }, descriptor.providerRef), 'provider_denied');
    await expectCode(() => adapter.resolveProvider(context, 'mcp:v1:invented-reference'), 'provider_denied');
    const deniedTools = await adapter.listTools(context, provider, { limit: 1, allowedToolNames: [] });
    assert.deepEqual(deniedTools.tools, []);
    assert.equal(fixture.requests, 0, 'an explicit empty tool allowlist does not fetch a catalogue or start a server');

    const firstPage = await adapter.listTools(context, provider, { limit: 1 });
    assert.equal(firstPage.tools.length, 1);
    assert(firstPage.nextCursor);
    assert(!JSON.stringify(firstPage).includes('inputSchema') && !JSON.stringify(firstPage).includes('$defs'), 'progressive list output contains only small tool descriptions');
    const firstCatalogRequests = fixture.requests;
    const firstCatalogLists = fixture.lists;
    const secondPage = await adapter.listTools(context, provider, { limit: 1, cursor: firstPage.nextCursor });
    assert.notEqual(firstPage.tools[0].name, secondPage.tools[0].name);
    assert.equal(fixture.lists, firstCatalogLists, 'successive small metadata pages reuse descriptions without preloading schemas or listing remotely');
    assert.equal(fixture.requests, firstCatalogRequests);
    const all = await adapter.listTools(context, provider, { limit: 50 });
    assert(!all.tools.some(tool => tool.name === 'internal_ui'), 'real MCP App visibility is enforced');
    const onlyWidget = await adapter.listTools(context, provider, { limit: 1, allowedToolNames: ['widget_design'] });
    assert.deepEqual(onlyWidget.tools.map(tool => tool.name), ['widget_design'], 'tool restrictions apply before pagination, even when the allowed tool was on a later unrestricted page');
    await expectCode(() => adapter.listTools(context, provider, { limit: 1, allowedToolNames: ['widget_design'], cursor: firstPage.nextCursor! }), 'invalid_cursor');
    const searched = await adapter.listTools(context, provider, { limit: 10, query: 'nested layout' });
    assert.deepEqual(searched.tools.map(tool => tool.name), ['create_design']);
    await expectCode(() => adapter.listTools(context, provider, { limit: 1, query: 'other', cursor: firstPage.nextCursor! }), 'invalid_cursor');
    const changedWorkspace = await adapter.resolveProvider({ ...context, workspaceId: 'another-workspace' }, descriptor.providerRef);
    await expectCode(() => adapter.listTools({ ...context, workspaceId: 'another-workspace' }, changedWorkspace, { limit: 1, cursor: firstPage.nextCursor! }), 'invalid_cursor');
    const schema = await adapter.describeTool(context, provider, 'create_design');
    assert.deepEqual(schema.inputSchema, initialTools[0].inputSchema, 'nested local refs are preserved exactly');
    assert.deepEqual(schema.outputSchema, initialTools[0].outputSchema);
    assert.equal(schema.toolVersion, null, 'there is no invented MCP per-tool version');
    await expectCode(() => adapter.describeTool(context, provider, 'internal_ui'), 'tool_not_found');

    const small = await runWithAgentExecutionContext(identity, () => adapter.callTool(context, provider, schema, args, { toolCallId: 'create-once' }));
    assert.equal(fixture.calls.length, 1);
    assert.deepEqual(fixture.calls[0], { name: 'create_design', arguments: args });
    assert.match(JSON.stringify(small), /created-design/);

    fixture.tools = [...fixture.tools, { name: 'new_tool', description: 'Newly available.', inputSchema: { type: 'object' } }];
    assert(integrationMetadataCache.size > 0);
    const listsBeforeNotification = fixture.lists;
    fixture.notifyToolsChanged();
    const noticeDeadline = Date.now() + 3000;
    while (integrationMetadataCache.size > 0 && Date.now() < noticeDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(integrationMetadataCache.size, 0, 'an actual tools/list_changed subscription notice invalidates the process-wide description cache');
    assert.equal(fixture.lists, listsBeforeNotification, 'the notification does not auto-refresh or preload tool schemas');
    await expectCode(() => adapter.listTools(context, provider, { limit: 1, cursor: firstPage.nextCursor! }), 'invalid_cursor');
    fixture.tools = structuredClone(initialTools);
    fixture.onNextList(() => {
      fixture.tools[0].inputSchema = { type: 'object', properties: { brand: { type: 'string' } }, required: ['brand'] };
    });
    await expectCode(() => adapter.callTool(context, provider, schema, args, { toolCallId: 'stale-schema' }), 'schema_changed');
    assert.equal(fixture.calls.length, 1, 'a schema flip on the manager fresh list never executes the business action');
    fixture.tools = structuredClone(initialTools);
    fixture.tools = fixture.tools.filter(tool => tool.name !== 'create_design');
    await expectCode(() => adapter.callTool(context, provider, schema, args, { toolCallId: 'removed-tool' }), 'provider_unavailable');
    assert.equal(fixture.calls.length, 1);
    fixture.tools = structuredClone(initialTools);

    await patchUnifiedEnvEntries([{ key: 'DESIGN_TOKEN', value: 'account-b-private-key' }], { userId: 'admin' });
    const listsBeforeStaleMetadata = fixture.lists;
    await expectCode(() => adapter.listTools(context, provider, { limit: 1 }), 'binding_changed');
    assert.equal(fixture.lists, listsBeforeStaleMetadata, 'cached metadata cannot authorize an old account binding');
    await expectCode(() => adapter.callTool(context, provider, schema, args, { toolCallId: 'changed-secret' }), 'binding_changed');
    assert.equal(fixture.calls.length, 1, 'static credential value changes invalidate schemas even when the key remains present');
    const rebound = await adapter.resolveProvider(context, descriptor.providerRef);
    const reboundSchema = await adapter.describeTool(context, rebound, 'create_design');
    fixture.onNextList(async () => {
      await patchUnifiedEnvEntries([{ key: 'DESIGN_TOKEN', value: 'account-c-private-key' }], { userId: 'admin' });
    });
    await expectCode(() => adapter.callTool(context, rebound, reboundSchema, args, { toolCallId: 'changed-secret-after-preflight' }), 'binding_changed');
    assert.equal(fixture.calls.length, 1, 'the manager guard also catches an account change after adapter preflight');
    const beforeGenerationChange = await adapter.resolveProvider(context, descriptor.providerRef);
    const generationSchema = await adapter.describeTool(context, beforeGenerationChange, 'create_design');
    const config = await readMcpConfig(scope);
    assert(config.mcpServers.fixture.connectionId);
    await invalidateMcpOAuthGeneration(config.mcpServers.fixture.connectionId, scope);
    await expectCode(() => adapter.callTool(context, beforeGenerationChange, generationSchema, args, { toolCallId: 'revoked-auth-generation' }), 'binding_changed');
    assert.equal(fixture.calls.length, 1, 'current credential generations invalidate old tool schemas');
    const beforeConfigChange = await adapter.resolveProvider(context, descriptor.providerRef);
    const configSchema = await adapter.describeTool(context, beforeConfigChange, 'create_design');
    config.mcpServers.fixture.timeoutMs = 2000;
    await writeMcpConfigRaw(JSON.stringify(config), scope);
    await expectCode(() => adapter.callTool(context, beforeConfigChange, configSchema, args, { toolCallId: 'changed-config' }), 'binding_changed');
    assert.equal(fixture.calls.length, 1);

    const current = await adapter.resolveProvider(context, descriptor.providerRef);
    const widgetSchema = await adapter.describeTool(context, current, 'widget_design');
    fixture.setResultMode('large');
    const widget = await runWithAgentExecutionContext(identity, () => adapter.callTool(context, current, widgetSchema, {}, { toolCallId: 'widget-large' }));
    const widgetDetails = widget.details as { mcpApp: { resourceUri: string; connectionId: string }; result: unknown };
    assert.equal(widgetDetails.mcpApp.resourceUri, 'ui://design/preview.html');
    assert.equal(widgetDetails.mcpApp.connectionId, config.mcpServers.fixture.connectionId);
    assert.match(JSON.stringify(widgetDetails.result), /PRIVATE_WIDGET_ONLY/, 'the capped display payload preserves widget metadata');
    const metadata = getToolOutputMetadata(widget.details);
    assert(metadata?.references.length, 'the real output pipeline stores a large result');
    const archive = await readStoredToolOutput(identity, metadata.references[0].reference);
    assert.match(archive.content, /EXACT_MIDDLE_OUTPUT/);
    assert.doesNotMatch(archive.content, /PRIVATE_WIDGET_ONLY/, 'agent-readable archives preserve the existing metadata privacy boundary');
    const modelView = projectAgentMessageForLoadedContext({ ...widget, role: 'toolResult', toolName: 'integrations', toolCallId: 'widget-large', isError: false, timestamp: Date.now() } as Parameters<typeof projectAgentMessageForLoadedContext>[0]);
    assert.doesNotMatch(JSON.stringify(modelView), /PRIVATE_WIDGET_ONLY|mcpApp|mcpToolInput/);
    fixture.setResultMode('image');
    const image = await runWithAgentExecutionContext(identity, () => adapter.callTool(context, current, widgetSchema, {}, { toolCallId: 'widget-image' }));
    assert.match(JSON.stringify(image), /aGVsbG8=|image\/png/, 'existing image/resource representation survives routing');

    const canceled = new AbortController();
    canceled.abort();
    const beforeCancellation = fixture.calls.length;
    await assert.rejects(() => adapter.callTool(context, current, widgetSchema, {}, { toolCallId: 'canceled', signal: canceled.signal }));
    assert.equal(fixture.calls.length, beforeCancellation, 'cancellation before dispatch never executes a tool');
    fixture.setResultMode('normal');
    fixture.dropNextCall();
    await expectCode(() => adapter.callTool(context, current, widgetSchema, {}, { toolCallId: 'uncertain-mutation' }), 'outcome_unknown');
    assert.equal(fixture.calls.length, beforeCancellation + 1, 'an uncertain mutation is not repeated or routed to another account');

    const definition = await publishMcpServerDefinition('org-a', 'Approved design fixture', { url: fixture.url, auth: 'none' });
    const account = await createPersonalMcpConnection('member', definition.id, 'Member design account');
    const memberContext = { ...context, actorUserId: 'member' };
    const memberDescriptor = (await listMcpIntegrationProviders(memberContext)).providers.find(provider => provider.configured && provider.scope.resourceId === account.connectionId);
    assert(memberDescriptor);
    const memberProvider = await adapter.resolveProvider(memberContext, memberDescriptor.providerRef);
    const memberSchema = await adapter.describeTool(memberContext, memberProvider, 'create_design');
    await publishMcpServerDefinition('org-a', 'Renamed approved fixture', { url: fixture.url, auth: 'none' }, definition.id);
    await expectCode(() => adapter.callTool(memberContext, memberProvider, memberSchema, args, { toolCallId: 'approval-revision' }), 'binding_changed');
    const newlyApproved = await adapter.resolveProvider(memberContext, memberDescriptor.providerRef);
    const newlyApprovedSchema = await adapter.describeTool(memberContext, newlyApproved, 'create_design');
    await adapter.listTools(memberContext, newlyApproved, { limit: 1 });
    await setMcpServerDefinitionEnabled('org-a', definition.id, false);
    const listsBeforeRevocation = fixture.lists;
    await expectCode(() => adapter.listTools(memberContext, newlyApproved, { limit: 1 }), 'provider_denied');
    assert.equal(fixture.lists, listsBeforeRevocation, 'revocation is checked live before a cache hit');
    await expectCode(() => adapter.callTool(memberContext, newlyApproved, newlyApprovedSchema, args, { toolCallId: 'approval-revoked' }), 'provider_denied');
    assert.equal(fixture.calls.length, beforeCancellation + 1, 'changed or revoked approval never reaches the provider');

    // Exercise the real dispatcher, isolated schema worker, MCP manager, HTTP
    // provider and result pipeline together through the public opaque contract.
    let secondaryRequests = 0;
    const secondaryUnavailable = async (): Promise<never> => {
      secondaryRequests += 1;
      throw new Error('The secondary source must not be used by this MCP workflow.');
    };
    const secondaryAdapter: IntegrationToolAdapter = {
      source: 'composio', resolveProvider: secondaryUnavailable, listTools: secondaryUnavailable,
      describeTool: secondaryUnavailable, callTool: secondaryUnavailable,
    };
    const dispatcher = new IntegrationDispatcher({
      adapters: { mcp: adapter, composio: secondaryAdapter },
      catalogAdapters: { mcp: listMcpIntegrationProviders, composio: secondaryUnavailable },
    });
    const policy = { ...UNRESTRICTED_INTEGRATION_POLICY, allowedSources: ['mcp'] as const };
    const dispatch = (request: unknown, toolCallId: string) => dispatcher.execute({ context, policy, request, toolCallId });
    const sourcePage = await dispatch({ action: 'search', target: 'providers', query: 'Canva' }, 'dispatcher-provider-search');
    assert('target' in sourcePage && sourcePage.target === 'providers');
    const chosen = sourcePage.providers.find(item => item.providerRef === descriptor.providerRef);
    assert(chosen);
    const toolPage = await dispatch({ action: 'search', target: 'tools', providerRef: chosen.providerRef, query: 'nested layout' }, 'dispatcher-tool-search');
    assert('target' in toolPage && toolPage.target === 'tools');
    assert.equal(toolPage.tools.length, 1);
    assert.equal(toolPage.tools[0].name, 'create_design');
    assert(!JSON.stringify(toolPage).includes('inputSchema'), 'dispatcher search preserves progressive schema disclosure');
    const described = await dispatch({ action: 'describe', toolRef: toolPage.tools[0].toolRef }, 'dispatcher-schema');
    assert('schemaRef' in described);
    assert.match(described.schemaRef, /^schema:v1:/);
    const dispatchCall = { action: 'call', toolRef: toolPage.tools[0].toolRef, schemaRef: described.schemaRef };
    const beforeDispatch = fixture.calls.length;
    await expectCode(() => dispatch({ ...dispatchCall, arguments: { layout: { title: 'Invalid', size: 'giant' } } }, 'dispatcher-invalid-nested'), 'invalid_arguments');
    assert.equal(fixture.calls.length, beforeDispatch, 'the real schema worker rejects invalid nested enum arguments before any business call');
    const dispatchResult = await runWithAgentExecutionContext(identity, () => dispatch({ ...dispatchCall, arguments: args }, 'dispatcher-create'));
    assert('target' in dispatchResult && dispatchResult.target === 'result');
    assert.equal(dispatchResult.source, 'mcp');
    assert.equal(dispatchResult.providerRef, chosen.providerRef);
    assert.equal(fixture.calls.length, beforeDispatch + 1);
    assert.deepEqual(fixture.calls.at(-1), { name: 'create_design', arguments: args });
    const listsBeforeFlip = fixture.lists;
    fixture.onNextList(() => {
      fixture.tools[0].inputSchema = { type: 'object', properties: { brand: { type: 'string' } }, required: ['brand'] };
    }, 2);
    await expectCode(() => dispatch({ ...dispatchCall, arguments: args }, 'dispatcher-manager-schema-flip'), 'schema_changed');
    assert.equal(fixture.lists, listsBeforeFlip + 2, 'schema changes occur after the dispatcher schema preflight, on the manager live list');
    assert.equal(fixture.calls.length, beforeDispatch + 1, 'the final manager schema guard prevents execution after worker validation');
    fixture.tools = structuredClone(initialTools);

    const widgetPage = await dispatch({ action: 'search', target: 'tools', providerRef: chosen.providerRef, query: 'preview' }, 'dispatcher-widget-search');
    assert('target' in widgetPage && widgetPage.target === 'tools' && widgetPage.tools.length === 1);
    const widgetDescription = await dispatch({ action: 'describe', toolRef: widgetPage.tools[0].toolRef }, 'dispatcher-widget-schema');
    assert('schemaRef' in widgetDescription);
    fixture.setResultMode('large');
    const dispatcherWidget = await runWithAgentExecutionContext(identity, () => dispatch({
      action: 'call', toolRef: widgetPage.tools[0].toolRef, schemaRef: widgetDescription.schemaRef, arguments: {},
    }, 'dispatcher-widget-result'));
    assert('target' in dispatcherWidget && dispatcherWidget.target === 'result');
    const dispatcherOutput = getToolOutputMetadata(dispatcherWidget.result.details);
    assert(dispatcherOutput?.references.length, 'the real dispatcher result still contains a stored original');
    const dispatcherArchive = await readStoredToolOutput(identity, dispatcherOutput.references[0].reference);
    assert.match(dispatcherArchive.content, /EXACT_MIDDLE_OUTPUT/);
    assert.doesNotMatch(dispatcherArchive.content, /PRIVATE_WIDGET_ONLY/);
    const dispatcherWidgetDetails = dispatcherWidget.result.details as { mcpApp: { resourceUri: string } };
    assert.equal(dispatcherWidgetDetails.mcpApp.resourceUri, 'ui://design/preview.html');
    assert.equal(secondaryRequests, 0, 'discovery and execution never query or fall back to the secondary source');

    fixture.setResultMode('normal');
    const transportProvider = await adapter.resolveProvider(context, descriptor.providerRef);
    const transportSchema = await adapter.describeTool(context, transportProvider, 'create_design');
    const otherScope = { userId: 'other', organizationId: 'org-b' };
    await writeMcpConfigRaw(JSON.stringify({ mcpServers: { legacy: { url: fixture.url, auth: 'none' } } }), otherScope);
    await listMcpTools('legacy', { scope: otherScope });
    let releaseLegacy!: () => void;
    const legacyGate = new Promise<void>(resolve => { releaseLegacy = resolve; });
    const legacyCall = legacyGate.then(() => callMcpToolWithCurrentMetadata('legacy', 'read_design', { id: 'parallel-legacy' }, undefined, otherScope));
    const beforeHeaderRace = fixture.calls.length;
    afterValidatedMetadata = async () => {
      await patchUnifiedEnvEntries([{ key: 'DESIGN_TOKEN', value: 'account-after-validation-private-key' }], { userId: 'admin' });
      releaseLegacy();
      await legacyCall;
    };
    await expectCode(() => adapter.callTool(context, transportProvider, transportSchema, args, { toolCallId: 'post-validation-credential-race' }), 'binding_changed');
    assert.equal(remainingEnvironmentReads, 0, 'the mutation happened at the final HTTP credentials snapshot, after metadata validation');
    assert.equal(fixture.calls.length, beforeHeaderRace + 1, 'only the independent legacy call executes; the changed-account business request is blocked');
    assert.deepEqual(fixture.calls.at(-1), { name: 'read_design', arguments: { id: 'parallel-legacy' } }, 'the invocation guard never leaks to a parallel legacy request');

    type TestEntry = { serverName: string; scope?: { userId?: string }; client?: Client; closed?: boolean };
    const managerStore = (globalThis as typeof globalThis & { __canvasMcpManagerStore?: { entries: Map<string, TestEntry> } }).__canvasMcpManagerStore;
    assert(managerStore);
    const currentEntry = () => [...managerStore.entries.values()].find(entry => entry.serverName === 'fixture' && entry.scope?.userId === 'admin');
    for (const closeMode of ['rotation', 'server', 'scope', 'all'] as const) {
      await listMcpTools('fixture', { scope });
      const oldEntry = currentEntry();
      assert(oldEntry?.client);
      let releaseClose!: () => void;
      let enteredClose!: () => void;
      const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
      const closeEntered = new Promise<void>(resolve => { enteredClose = resolve; });
      const originalClose = oldEntry.client.close.bind(oldEntry.client);
      oldEntry.client.close = async () => { enteredClose(); await closeGate; return originalClose(); };
      if (closeMode === 'rotation') await patchUnifiedEnvEntries([{ key: 'DESIGN_TOKEN', value: 'parallel-rotation-account' }], { userId: 'admin' });
      const closing = closeMode === 'rotation' ? listMcpTools('fixture', { scope })
        : closeMode === 'server' ? closeMcpServer('fixture', scope)
        : closeMode === 'scope' ? closeMcpServersForScope(scope, ['DESIGN_TOKEN']) : closeAllMcpServers();
      try {
        await closeEntered;
        await listMcpTools('fixture', { scope });
        const replacement = currentEntry();
        assert(replacement?.client && replacement !== oldEntry);
        const callsBeforeReplacement: number = fixture.calls.length;
        await callMcpToolWithCurrentMetadata('fixture', 'read_design', { id: `parallel-${closeMode}` }, undefined, scope);
        assert.equal(fixture.calls.length, callsBeforeReplacement + 1, 'the real replacement serves its business request while the old SDK client close is gated');
        releaseClose();
        await closing;
        assert.equal(currentEntry(), replacement, `${closeMode} close retains the concurrently registered replacement`);
        assert(!replacement.closed, `${closeMode} close never aborts the replacement`);
      } finally { releaseClose(); await closing; }
    }

    await listMcpTools('fixture', { scope });
    const entryBeforeFailure = currentEntry();
    assert(entryBeforeFailure?.client);
    let releaseOldFailure!: () => void;
    let enteredOldValidation!: () => void;
    const failureGate = new Promise<void>(resolve => { releaseOldFailure = resolve; });
    const validationEntered = new Promise<void>(resolve => { enteredOldValidation = resolve; });
    const oldCall = callMcpToolWithCurrentMetadata('fixture', 'read_design', { id: 'obsolete-call' }, undefined, scope, {
      validateTool: async () => { enteredOldValidation(); await failureGate; throw new Error('Obsolete MCP metadata failed.'); },
    }).then(() => undefined, error => error as Error);
    try {
      await validationEntered;
      await patchUnifiedEnvEntries([{ key: 'DESIGN_TOKEN', value: 'replacement-after-old-validation' }], { userId: 'admin' });
      await listMcpTools('fixture', { scope });
      const replacement = currentEntry();
      assert(replacement?.client && replacement !== entryBeforeFailure);
      releaseOldFailure();
      assert.match((await oldCall)?.message || '', /Obsolete MCP metadata failed/);
      assert.equal(currentEntry(), replacement, 'an old in-flight failure cannot close a newer connection selected by the same ID');
      assert(!replacement.closed);
      const callsBefore = fixture.calls.length;
      await callMcpToolWithCurrentMetadata('fixture', 'read_design', { id: 'retained-after-old-error' }, undefined, scope);
      assert.equal(fixture.calls.length, callsBefore + 1, 'the replacement still performs its real business request after the old error finishes');
    } finally { releaseOldFailure(); await oldCall; }

    // HTTP transport URLs and STDIO credentials persist in a managed client.
    // Real ENV edits therefore recreate either kind before using a new binding.
    const endpointB = await startFixture();
    try {
      const urlConfig = await readMcpConfig(scope);
      urlConfig.mcpServers.variableEndpoint = { url: '${DESIGN_ENDPOINT}', auth: 'none', displayName: 'Variable design endpoint' };
      await patchUnifiedEnvEntries([{ key: 'DESIGN_ENDPOINT', value: fixture.url }], { userId: 'admin' });
      await writeMcpConfigRaw(JSON.stringify(urlConfig), scope);
      const endpointDescriptor = (await listMcpIntegrationProviders(context)).providers.find(item => item.displayName === 'Variable design endpoint');
      assert(endpointDescriptor);
      const endpointAProvider = await adapter.resolveProvider(context, endpointDescriptor.providerRef);
      const endpointASchema = await adapter.describeTool(context, endpointAProvider, 'create_design');
      await adapter.callTool(context, endpointAProvider, endpointASchema, args, { toolCallId: 'endpoint-a' });
      const callsOnA = fixture.calls.length;
      await patchUnifiedEnvEntries([{ key: 'DESIGN_ENDPOINT', value: endpointB.url }], { userId: 'admin' });
      const endpointBProvider = await adapter.resolveProvider(context, endpointDescriptor.providerRef);
      const endpointBSchema = await adapter.describeTool(context, endpointBProvider, 'create_design');
      await adapter.callTool(context, endpointBProvider, endpointBSchema, args, { toolCallId: 'endpoint-b' });
      assert.equal(fixture.calls.length, callsOnA, 'the pinned old URL never receives a new endpoint binding');
      assert.equal(endpointB.calls.length, 1, 'a new ENV endpoint uses its actual new HTTP client');
    } finally { await closeAllMcpServers(); await endpointB.close(); }

    process.env.MCP_ALLOW_STDIO = 'true';
    const processStarts = path.join(dataRoot, 'stdio-starts.txt');
    const stdioConfig = await readMcpConfig(scope);
    stdioConfig.mcpServers.local = {
      command: process.execPath, args: ['--import', 'tsx', path.resolve('scripts/fixtures/fake-mcp-server.ts')],
      env: { ECHO_PREFIX: '${PROCESS_ACCESS_TOKEN}', MCP_START_FILE: processStarts }, displayName: 'Local credential fixture',
    };
    await patchUnifiedEnvEntries([{ key: 'PROCESS_ACCESS_TOKEN', value: 'process-account-a:' }], { userId: 'admin' });
    await writeMcpConfigRaw(JSON.stringify(stdioConfig), scope);
    const processDescriptor = (await listMcpIntegrationProviders(context)).providers.find(item => item.displayName === 'Local credential fixture');
    assert(processDescriptor);
    const processA = await adapter.resolveProvider(context, processDescriptor.providerRef);
    const processASchema = await adapter.describeTool(context, processA, 'echo');
    const processAResult = await adapter.callTool(context, processA, processASchema, { message: 'first' }, { toolCallId: 'process-account-a' });
    assert.match(JSON.stringify(processAResult), /process-account-a:first/);
    const startsAfterA = (await fs.readFile(processStarts, 'utf8')).trim().split('\n').length;
    assert(startsAfterA > 0);
    await patchUnifiedEnvEntries([{ key: 'PROCESS_ACCESS_TOKEN', value: 'process-account-b:' }], { userId: 'admin' });
    const processB = await adapter.resolveProvider(context, processDescriptor.providerRef);
    const processBSchema = await adapter.describeTool(context, processB, 'echo');
    const processBResult = await adapter.callTool(context, processB, processBSchema, { message: 'second' }, { toolCallId: 'process-account-b' });
    assert.match(JSON.stringify(processBResult), /process-account-b:second/);
    assert.doesNotMatch(JSON.stringify(processBResult), /process-account-a/);
    // SDK version negotiation may start a probe before the final process.
    assert((await fs.readFile(processStarts, 'utf8')).trim().split('\n').length > startsAfterA, 'a real new STDIO process starts with the new ENV binding');
    console.log('integration-tool-mcp-runtime-test: ok');
  } finally {
    await closeAllMcpServers().catch(() => undefined);
    await fixture.close();
    moduleInternals._load = accessFixtureLoad;
    integrationMetadataCache.clear();
    restore();
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
