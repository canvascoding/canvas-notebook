import assert from 'node:assert/strict';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

async function main(): Promise<void> {
  const { projectAgentMessageForLoadedContext } = await import('../app/lib/pi/message-projection');
  const { projectAgentEventForExternal, projectAgentMessageForPersistence } = await import('../app/lib/pi/visual-data-projection');
  const mcpToolResult = {
    role: 'toolResult',
    toolName: 'account_lookup',
    toolCallId: 'mcp-projection-tool',
    content: [{ type: 'text', text: 'MCP account lookup completed.' }],
    details: {
      mcpApp: {
        version: 1,
        connectionId: 'mcp-connection-1',
        toolName: 'account_lookup',
        resourceUri: 'https://mcp.fixture.test/resource',
        internalWidgetDescriptor: { token: 'WIDGET_DESCRIPTOR_MUST_NOT_REACH_MODEL' },
      },
      mcpToolInput: { args: { accountId: 'MCP_INPUT_MUST_NOT_REACH_MODEL' } },
      result: {
        content: [{ type: 'text', text: 'MCP result text.' }],
        structuredContent: {
          account: 'safe model result',
          args: { businessField: 'GENERIC_ARGS_MUST_REACH_MODEL' },
        },
        _meta: {
          args: 'MCP_META_ARGS_MUST_NOT_REACH_MODEL',
          internalWidgetDescriptor: 'MCP_META_WIDGET_MUST_NOT_REACH_MODEL',
        },
      },
    },
    timestamp: Date.now(),
  } as unknown as AgentMessage;

  const context = projectAgentMessageForLoadedContext(mcpToolResult, 'context') as unknown as Record<string, unknown>;
  const contextJson = JSON.stringify(context);
  assert.match(contextJson, /safe model result/);
  assert.match(contextJson, /GENERIC_ARGS_MUST_REACH_MODEL/);
  assert.doesNotMatch(contextJson, /MCP_INPUT_MUST_NOT_REACH_MODEL/);
  assert.doesNotMatch(contextJson, /MCP_META_ARGS_MUST_NOT_REACH_MODEL/);
  assert.doesNotMatch(contextJson, /MCP_META_WIDGET_MUST_NOT_REACH_MODEL/);
  assert.doesNotMatch(contextJson, /WIDGET_DESCRIPTOR_MUST_NOT_REACH_MODEL/);
  assert.doesNotMatch(contextJson, /mcpApp/);
  assert.doesNotMatch(contextJson, /mcpToolInput/);

  const display = projectAgentMessageForLoadedContext(mcpToolResult, 'display') as unknown as Record<string, unknown>;
  const displayJson = JSON.stringify(display);
  assert.match(displayJson, /MCP_INPUT_MUST_NOT_REACH_MODEL/);
  assert.match(displayJson, /MCP_META_ARGS_MUST_NOT_REACH_MODEL/);
  assert.match(displayJson, /WIDGET_DESCRIPTOR_MUST_NOT_REACH_MODEL/);

  const originalMcpPayload = {
    ...mcpToolResult,
    details: {
      ...(mcpToolResult as unknown as { details: Record<string, unknown> }).details,
      result: {
        content: [{ type: 'image', data: 'MCP_ORIGINAL_BINARY_PAYLOAD', mimeType: 'image/png' }],
        structuredContent: { rows: [{ name: 'retained' }] },
        _meta: { widget: 'MCP_ORIGINAL_META_PAYLOAD' },
      },
    },
  } as AgentMessage;
  const persisted = projectAgentMessageForPersistence(originalMcpPayload);
  assert.match(JSON.stringify(persisted), /MCP_ORIGINAL_BINARY_PAYLOAD/);
  assert.match(JSON.stringify(persisted), /MCP_ORIGINAL_META_PAYLOAD/);
  const external = projectAgentEventForExternal({ type: 'tool_execution_end', result: { details: (originalMcpPayload as unknown as { details: unknown }).details } });
  assert.match(JSON.stringify(external), /MCP_ORIGINAL_BINARY_PAYLOAD/);
  assert.match(JSON.stringify(external), /MCP_ORIGINAL_META_PAYLOAD/);

  const ordinaryMcpContext = projectAgentMessageForLoadedContext({
    ...mcpToolResult,
    toolName: 'mcp_lookup',
    details: { result: { structuredContent: { args: { business: 'ordinary-business-args' } }, _meta: { secret: 'ordinary-mcp-meta' } } },
  } as AgentMessage, 'context');
  assert.match(JSON.stringify(ordinaryMcpContext), /ordinary-business-args/);
  assert.doesNotMatch(JSON.stringify(ordinaryMcpContext), /ordinary-mcp-meta/);

  const oversized = {
    ...mcpToolResult,
    details: {
      ...(mcpToolResult as unknown as { details: Record<string, unknown> }).details,
      result: { content: [{ type: 'text', text: 'MCP_OVERSIZED_RESULT '.repeat(120_000) }] },
    },
  } as AgentMessage;
  const oversizedDisplay = projectAgentMessageForLoadedContext(oversized, 'display') as unknown as Record<string, unknown>;
  const oversizedDetails = oversizedDisplay.details as Record<string, unknown>;
  assert.ok(JSON.stringify(oversizedDetails).length < 2 * 1024 * 1024);
  assert.deepEqual(oversizedDetails.mcpApp, {
    version: 1,
    connectionId: 'mcp-connection-1',
    toolName: 'account_lookup',
    resourceUri: 'https://mcp.fixture.test/resource',
  });

  const hostileDescriptor = projectAgentMessageForLoadedContext({
    ...oversized,
    details: {
      ...(oversized as unknown as { details: Record<string, unknown> }).details,
      mcpApp: { version: { nested: 'x'.repeat(3 * 1024 * 1024) }, connectionId: 'x'.repeat(100_000) },
    },
  } as AgentMessage, 'display') as unknown as Record<string, unknown>;
  assert.ok(JSON.stringify(hostileDescriptor.details).length < 2 * 1024 * 1024);

  console.log('mcp-message-projection-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
