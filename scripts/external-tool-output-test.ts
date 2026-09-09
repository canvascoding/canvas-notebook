import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';

function text(result: AgentToolResult<unknown>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-external-output-'));
  process.env.DATA = root; process.env.CANVAS_DATA_ROOT = root;
  const modules = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = modules._load;
  const large = 'begin '.repeat(3_000) + 'ExactMiddleDetail' + ' end'.repeat(3_000);
  let mcpPayload: Record<string, unknown> = { content: [{ type: 'text', text: large }], structuredContent: { id: 'created-123', status: 'created', body: large } };
  let composioPayload: unknown = { data: large, id: 'mutation-456', success: true };
  let evaluation: unknown = { id: 'evaluated-789', body: large };
  const page = { content: async () => `<html><title>Rendered source</title><main><p>${large}</p></main></html>`, url: () => 'https://example.test/rendered', title: async () => 'Rendered source', evaluate: async () => evaluation };
  let forwardedSignal: AbortSignal | undefined;
  modules._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
    if (request === '@/app/lib/pi/tool-output-maintenance') return { maybeCleanupToolOutputOrphans: async () => undefined };
    if (request === '@/app/lib/mcp/manager') return {
      callMcpTool: async (_server: string, _tool: string, _args: unknown, signal?: AbortSignal) => { forwardedSignal = signal; return mcpPayload; },
      listMcpTools: async () => [{ name: 'fixture', inputSchema: { type: 'object' } }], startMcpIdleCleanup: () => undefined,
    };
    if (request === '@/app/lib/mcp/config') return { isMcpServerEnabled: () => true, readMcpConfig: async () => ({ mcpServers: { fixture: { directTools: ['fixture'] } } }) };
    if (request === './composio-gateway') return {
      executeGatewayTool: async () => composioPayload, getGatewayToolSchemas: async () => composioPayload,
      searchGatewayTools: async () => composioPayload,
      connectGatewayToolkit: async () => ({ redirectUrl: 'https://auth.example.test/connect' }),
    };
    if (request === './composio-profiles') return {};
    if (parent?.filename.endsWith('/browser/gateway.ts')) {
      if (request === './runtime') return {
        ensurePage: async () => page, getStatusDetails: async () => ({ running: true, activeTabId: 'tab-1', url: page.url() }),
        getTargetStore: () => ({ clear: () => undefined }), withBrowserRuntimeLock: async (_context: unknown, callback: () => Promise<unknown>) => callback(), scheduleIdleClose: () => undefined,
      };
      if (request === './session-state-service') return { refreshBrowserSessionSnapshot: async () => ({ activeTabId: 'tab-1', running: true }) };
      if (request === './view-control') return { assertAgentBrowserControl: () => undefined, getBrowserControlState: () => ({ mode: 'agent' }) };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    const { prepareToolOutput } = await import('../app/lib/pi/tool-output-preparation');
    const { getToolOutputMetadata } = await import('../app/lib/pi/tool-output-metadata');
    const { readStoredToolOutput, inspectToolOutputUsage } = await import('../app/lib/pi/tool-output-store');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { wrapToolWithExecutionContext } = await import('../app/lib/pi/tool-runtime-helpers');
    const { buildDirectMcpTools } = await import('../app/lib/mcp/direct-tools');
    const { createMcpProxyTool } = await import('../app/lib/mcp/proxy-tool');
    const { createComposioExecuteTool, createComposioGetToolSchemasTool, createComposioManageConnectionsTool } = await import('../app/lib/composio/composio-tools');
    const { createBrowserGatewayTool } = await import('../app/lib/pi/browser/tool');
    const { prepareWebToolOutput } = await import('../app/lib/pi/web-output-preparation');
    const identity = {
      organizationId: null, userId: 'external-user', sessionId: 'external-session', workspaceId: 'external-workspace',
      agentId: null, workspaceType: 'personal' as const, workspaceName: null, customerId: null, projectId: null,
      workspaceRoot: path.join(root, 'workspace'), workspaceRootRelativePath: null, canWrite: false, canDelete: false, canShare: false, legacy: false,
    };
    const readOriginal = async (result: AgentToolResult<unknown>) => {
      const metadata = getToolOutputMetadata(result.details);
      assert.ok(metadata?.references.length, 'large result has a real reference');
      assert.ok(text(result).length <= 12_000);
      assert.ok(JSON.stringify(result.details).length < 6_000, 'details do not duplicate the raw payload');
      return JSON.parse((await readStoredToolOutput(identity, metadata.references[0].reference)).content);
    };
    const controller = new AbortController();
    const direct = (await buildDirectMcpTools()).tools[0];
    const proxy = createMcpProxyTool();
    const directResult = await runWithAgentExecutionContext(identity, () => direct.execute('mcp-direct', {}, controller.signal));
    const proxyResult = await runWithAgentExecutionContext(identity, () => proxy.execute('mcp-proxy', { action: 'call_tool', server: 'fixture', tool: 'fixture' }, controller.signal));
    assert.equal(forwardedSignal, controller.signal);
    assert.deepEqual(await readOriginal(directResult), mcpPayload);
    assert.deepEqual(await readOriginal(proxyResult), mcpPayload);
    assert.match(text(directResult), /created-123/);
    assert.match(text(proxyResult), /created-123/);
    // Remove generated per-call references when comparing the deterministic views.
    assert.equal(text(directResult).replace(/tool-output:\/\/\S+/gu, '<ref>'), text(proxyResult).replace(/tool-output:\/\/\S+/gu, '<ref>'));
    mcpPayload = { isError: true, content: [{ type: 'text', text: 'Permission denied' }] };
    const error = await direct.execute('mcp-error', {});
    assert.match(text(error), /returned an error.*\nPermission denied/u);
    assert.equal((error.details as { isError: boolean }).isError, true);
    mcpPayload = { content: [{ type: 'resource', resource: { uri: 'resource://document', text: 'Resource body', mimeType: 'text/plain' } }, { type: 'resource_link', uri: 'https://example.test/resource', name: 'Document' }], structuredContent: { count: 2 } };
    const resource = await direct.execute('mcp-resource', {});
    assert.match(text(resource), /Resource body/); assert.match(text(resource), /https:\/\/example.test\/resource/);
    assert.deepEqual((resource.details as { result: unknown }).result, mcpPayload);

    const composioContext = { kind: 'resolved_composio_context' as const, userId: identity.userId, workspaceId: identity.workspaceId,
      profileId: 'profile', profileName: 'Default', profileSource: 'default' as const, composioUserId: 'external', cacheRevision: '1', storageScope: { secretScope: 'user' as const, userId: identity.userId } };
    const execute = createComposioExecuteTool(composioContext);
    const composio = await runWithAgentExecutionContext(identity, () => execute.execute('composio-large', { action: 'FIXTURE_CREATE', params: {} }));
    assert.deepEqual(await readOriginal(composio), composioPayload);
    assert.match(text(composio), /mutation-456/); assert.match(text(composio), /"success":true/);
    const schema = await runWithAgentExecutionContext(identity, () => createComposioGetToolSchemasTool(composioContext).execute('composio-schema', { tools: ['FIXTURE_CREATE'] }));
    assert.deepEqual(await readOriginal(schema), composioPayload);
    composioPayload = { auth_required: true, redirect_url: 'https://auth.example.test/connect', toolkit: 'fixture', toolkit_name: 'Fixture', tool_name: 'FIXTURE_CREATE', profile_id: 'profile', message: large };
    const auth = await runWithAgentExecutionContext(identity, () => execute.execute('auth-large', { action: 'FIXTURE_CREATE', params: {} }));
    assert.equal(JSON.parse(text(auth)).auth_required, true);
    assert.equal(JSON.parse(text(auth)).redirect_url, 'https://auth.example.test/connect');
    const connect = await createComposioManageConnectionsTool(composioContext).execute('connect-small', { action: 'connect', toolkit: 'fixture' });
    assert.equal(JSON.parse(text(connect)).redirect_url, 'https://auth.example.test/connect');

    const browser = createBrowserGatewayTool(identity);
    const rendered = await runWithAgentExecutionContext(identity, () => browser.execute('browser-content', { action: 'extract_content' }));
    assert.ok((await readOriginal(rendered)).content.includes('ExactMiddleDetail'));
    assert.equal((rendered.details as { browser: { activeTabId: string } }).browser.activeTabId, 'tab-1');
    const evaluated = await runWithAgentExecutionContext(identity, () => browser.execute('browser-eval', { action: 'evaluate', script: 'readOnlyFixture' }));
    assert.deepEqual(await readOriginal(evaluated), evaluation);
    assert.match(text(evaluated), /evaluated-789/);
    evaluation = { id: 'small', success: true };
    const smallEval = await runWithAgentExecutionContext(identity, () => browser.execute('browser-small', { action: 'evaluate', script: 'readOnlyFixture' }));
    assert.deepEqual(JSON.parse(text(smallEval)), evaluation);
    assert.deepEqual((smallEval.details as { result: unknown }).result, evaluation);

    const small = { content: [{ type: 'text' as const, text: 'written' }, { type: 'image' as const, data: 'fixture', mimeType: 'image/png' }], details: { filePath: '/workspace/file.txt', sha256: 'hash', changeId: 'change-123' } };
    const smallPrepared = await prepareToolOutput({ identity, toolCallId: 'small', toolName: 'write', result: small });
    assert.deepEqual(smallPrepared.content, small.content);
    assert.equal((smallPrepared.details as typeof small.details).changeId, small.details.changeId);
    assert.equal((smallPrepared.details as typeof small.details).sha256, small.details.sha256);
    const noSession = await prepareToolOutput({ identity: null, toolCallId: 'no-session', toolName: 'future-provider', result: { content: [{ type: 'text', text: large }], details: {} } });
    assert.match(text(noSession), /No active session/);
    assert.equal(getToolOutputMetadata(noSession.details)?.references.length, 0);
    const forged = await prepareToolOutput({ identity, toolCallId: 'forged', toolName: 'future-provider', result: { content: [{ type: 'text', text: large }], details: { toolOutput: { version: 1, policyVersion: 'forged', references: [{ reference: 'tool-output://forged' }] } } } });
    assert.notEqual(getToolOutputMetadata(forged.details)?.policyVersion, 'forged');
    await readOriginal(forged);
    const before = await inspectToolOutputUsage(identity);
    assert.equal(await prepareToolOutput({ identity, toolCallId: 'again', toolName: 'future-provider', result: forged }), forged);
    assert.deepEqual(await inspectToolOutputUsage(identity), before, 'prepared results are not stored twice');
    const web = await prepareWebToolOutput({ identity, toolCallId: 'web', sources: [{ title: 'Web', url: page.url(), content: large }], kind: 'pages', heading: 'Page', provider: 'fixture' });
    const copiedWeb = { ...web, details: { ...web.details, provider: 'fixture' } };
    assert.equal(await prepareToolOutput({ identity, toolCallId: 'web-again', toolName: 'web_fetch', result: copiedWeb }), copiedWeb);
    let updates = 0;
    const futureTool = wrapToolWithExecutionContext({ name: 'future_provider', label: 'Future', description: '', parameters: direct.parameters,
      execute: async (_id, _args, signal, onUpdate) => { assert.equal(signal, controller.signal); onUpdate?.(small); return { content: [{ type: 'text', text: large }], details: {} }; },
    }, identity);
    const future = await futureTool.execute('future-wrapped', {}, controller.signal, () => { updates++; });
    assert.equal(updates, 1);
    assert.ok(JSON.stringify(await readOriginal(future)).includes('ExactMiddleDetail'));
    const savedRead = { content: [{ type: 'text' as const, text: 'window' }], details: { toolOutputRead: true, nextOffset: 600 } };
    assert.equal(await prepareToolOutput({ identity, toolCallId: 'read', toolName: 'read', result: savedRead }), savedRead);
    const circular: Record<string, unknown> = {}; circular.self = circular;
    const failed = await prepareToolOutput({ identity, toolCallId: 'circular', toolName: 'future', result: { content: [{ type: 'text', text: large }], details: circular } });
    assert.match(text(failed), /serialization failed/);
    assert.equal(getToolOutputMetadata(failed.details)?.references.length, 0);
    assert.equal(getToolOutputMetadata(failed.details)?.modelChars, text(failed).length);
    const escaped = await prepareToolOutput({ identity, toolCallId: 'escaped', toolName: 'composio', maxChars: 2_000,
      result: { content: [{ type: 'text', text: JSON.stringify({ auth_required: true, redirect_url: 'https://auth.example.test/connect', body: '\u0000'.repeat(10_000) }) }], details: {} },
    });
    assert.ok(text(escaped).length <= 2_000);
    assert.equal(JSON.parse(text(escaped)).redirect_url, 'https://auth.example.test/connect');
    const failedStorage = await prepareToolOutput({ identity, toolCallId: 'too-large', toolName: 'future', result: { content: [{ type: 'text', text: 'x'.repeat(4 * 1024 * 1024 + 1) }], details: { isError: true } } });
    assert.equal(getToolOutputMetadata(failedStorage.details)?.references.length, 0);
    assert.match(text(failedStorage), /Full output unavailable/);
    assert.equal((failedStorage.details as { isError: boolean }).isError, true);
    const resourceId = 'opaque'.repeat(100);
    const mutation = await prepareToolOutput({ identity, toolCallId: 'mutation-identifiers', toolName: 'future',
      result: { content: [{ type: 'text', text: JSON.stringify({ body: large, resourceId, changeId: 'change-123', sha256: 'a'.repeat(64) }) }], details: {} },
    });
    assert.ok(text(mutation).includes(resourceId), 'opaque camelCase identifiers are never shortened');
    assert.match(text(mutation), /change-123/);
    assert.ok(text(mutation).includes('a'.repeat(64)));
    console.log('external-tool-output-test: ok (mocked providers/page; real storage and adapters)');
  } finally {
    modules._load = originalLoad;
    await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
