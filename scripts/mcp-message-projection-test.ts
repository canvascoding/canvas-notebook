import assert from 'node:assert/strict';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

async function main(): Promise<void> {
  const { projectAgentMessageForLoadedContext, parsePersistedPiMessage, stripMcpModelMetadata } = await import('../app/lib/pi/message-projection');
  const { projectAgentEventForExternal, projectAgentMessageForPersistence } = await import('../app/lib/pi/visual-data-projection');
  const { readMcpAppDescriptor, stripMcpAppAuthority } = await import('../app/lib/mcp/apps-contracts');
  const { readToolAppInvocation } = await import('../app/lib/tool-apps/types');
  const legacyDescriptor = { version: 1 as const, connectionId: '11111111-1111-4111-8111-111111111111',
    toolName: 'account_lookup', resourceUri: 'ui://fixture/app.html' };
  assert.deepEqual(readMcpAppDescriptor({ ...legacyDescriptor, privateExtra: 'omitted' }), legacyDescriptor);
  assert.deepEqual(readToolAppInvocation({ details: { mcpApp: legacyDescriptor, mcpToolInput: {}, result: {} } })?.descriptor, legacyDescriptor,
    'legacy persisted shape keeps its existing compatibility boundary');
  const sharedDescriptor = { version: 2 as const, connectionRef: 'canvas-connection:11111111-1111-4111-8111-111111111111',
    toolCallId: 'shared-tool-call', toolName: 'account_lookup', resourceUri: 'ui://fixture/app.html', bindingRevision: 'a'.repeat(64) };
  assert.deepEqual(readMcpAppDescriptor(sharedDescriptor), sharedDescriptor);
  const limits = { ...sharedDescriptor, toolCallId: 'x'.repeat(256), toolName: 'y'.repeat(256), resourceUri: `ui://${'z'.repeat(4091)}` };
  assert.deepEqual(readMcpAppDescriptor(limits), limits);
  for (const invalid of [null, [], { ...sharedDescriptor, version: 3 },
    { ...sharedDescriptor, connectionRef: 'canvas-connection:AAAAAAAA-1111-4111-8111-111111111111' },
    { ...sharedDescriptor, connectionRef: legacyDescriptor.connectionId }, { ...sharedDescriptor, bindingRevision: 'A'.repeat(64) },
    { ...sharedDescriptor, bindingRevision: 'a'.repeat(63) }, { ...sharedDescriptor, toolCallId: ' ' },
    { ...sharedDescriptor, toolCallId: 'x'.repeat(257) }, { ...sharedDescriptor, toolCallId: 'call\nother' },
    { ...sharedDescriptor, toolCallId: 'call\u007fother' }, { ...sharedDescriptor, toolCallId: 'call\u0085other' },
    { ...sharedDescriptor, toolName: ' ' }, { ...sharedDescriptor, toolName: 'x'.repeat(257) },
    { ...sharedDescriptor, resourceUri: 'file:///private/app.html' }, { ...sharedDescriptor, resourceUri: 'ui://fixture/app html' },
    { ...sharedDescriptor, resourceUri: `ui://${'x'.repeat(4092)}` }, { ...sharedDescriptor, connectionId: legacyDescriptor.connectionId },
    { ...sharedDescriptor, actorUserId: 'forged' }, { ...sharedDescriptor, mcpAppAuthority: { version: 1 } },
    Object.fromEntries(Object.entries(sharedDescriptor).filter(([key]) => key !== 'bindingRevision'))]) {
    assert.equal(readMcpAppDescriptor(invalid), null, 'invalid/mixed shared transport identities fail closed');
  }
  const privateAuthority = { version: 1, integrationContext: { actorUserId: 'PRIVATE_ACTOR', workspaceId: 'PRIVATE_WORKSPACE',
    workspaceRoot: '/private/fixture/authority/root' }, effectivePolicy: { privateMarker: 'PRIVATE_EFFECTIVE_POLICY' },
    providerRef: 'PRIVATE_PROVIDER_REF', bindingRevision: sharedDescriptor.bindingRevision };
  const sharedMessage = { role: 'toolResult', toolName: 'integrations', toolCallId: sharedDescriptor.toolCallId, isError: false,
    timestamp: Date.now(), content: [{ type: 'text', text: 'shared result' }], details: {
      mcpApp: sharedDescriptor, mcpAppAuthority: privateAuthority, mcpToolInput: { value: 1 }, result: {
        content: [{ type: 'image', data: 'SHARED_WIDGET_IMAGE', mimeType: 'image/png' }], structuredContent: { retained: true },
        _meta: { privateWidget: 'SHARED_WIDGET_META' },
      },
    } } satisfies AgentMessage;
  assert.deepEqual(readToolAppInvocation(sharedMessage)?.descriptor, sharedDescriptor);
  for (const invalid of [{ ...sharedMessage, role: 'assistant' }, { ...sharedMessage, isError: true },
    { ...sharedMessage, toolCallId: 'other-tool-call' }, { ...sharedMessage, details: { ...sharedMessage.details, error: 'failed' } }]) {
    assert.equal(readToolAppInvocation(invalid), null, 'shared widgets require a matching successful actual tool result');
  }
  const sharedOriginal = JSON.stringify(sharedMessage);
  const sharedPersisted = projectAgentMessageForPersistence(sharedMessage);
  assert(sharedPersisted.role === 'toolResult', 'persistence must retain the actual tool-result role');
  assert.deepEqual((sharedPersisted.details as Record<string, unknown>).mcpAppAuthority, privateAuthority);
  assert.equal(JSON.stringify(sharedPersisted), sharedOriginal, 'persistence preserves exact private proof and provider widget payload');
  assert.equal(projectAgentMessageForLoadedContext(sharedPersisted, 'raw'), sharedPersisted);
  for (const mode of ['display', 'context'] as const) {
    const view = parsePersistedPiMessage(JSON.stringify(sharedPersisted), mode);
    assert.doesNotMatch(JSON.stringify(view), /mcpAppAuthority|PRIVATE_ACTOR|PRIVATE_WORKSPACE|PRIVATE_EFFECTIVE_POLICY|PRIVATE_PROVIDER_REF/);
    if (mode === 'display') {
      assert.deepEqual(readToolAppInvocation(view)?.descriptor, sharedDescriptor);
      assert.match(JSON.stringify(view), /SHARED_WIDGET_META/);
    } else assert.doesNotMatch(JSON.stringify(view), /mcpApp|mcpToolInput|SHARED_WIDGET_META/);
  }
  assert.doesNotMatch(JSON.stringify(stripMcpModelMetadata(sharedMessage)), /mcpAppAuthority|PRIVATE_ACTOR|SHARED_WIDGET_META/);
  const alreadyPublic = { result: new Date(0), _meta: { visibleWidget: true } };
  assert.equal(stripMcpAppAuthority(alreadyPublic), alreadyPublic, 'ordinary public payloads retain identity and opaque values');
  for (const event of [{ type: 'tool_execution_end', result: sharedMessage }, { type: 'message_end', message: sharedMessage },
    { type: 'agent_end', messages: [sharedMessage] }, { type: 'unknown', nested: { mcpAppAuthority: privateAuthority } }]) {
    const view = projectAgentEventForExternal(event);
    assert.doesNotMatch(JSON.stringify(view), /mcpAppAuthority|PRIVATE_ACTOR|PRIVATE_EFFECTIVE_POLICY|PRIVATE_PROVIDER_REF/);
    if (event.type !== 'unknown') assert.match(JSON.stringify(view), /SHARED_WIDGET_META/);
  }
  const oversizedShared = { ...sharedMessage, details: { ...sharedMessage.details,
    result: { content: [{ type: 'text', text: 'x'.repeat(3 * 1024 * 1024) }], _meta: { privateWidget: 'SHARED_WIDGET_META' } },
  } } as AgentMessage;
  const boundedShared = projectAgentMessageForPersistence(oversizedShared);
  assert(boundedShared.role === 'toolResult', 'bounded persistence must retain the actual tool-result role');
  assert.ok(JSON.stringify(boundedShared.details).length < 2 * 1024 * 1024);
  assert.deepEqual((boundedShared.details as Record<string, unknown>).mcpAppAuthority, privateAuthority,
    'oversized persistence keeps the whole original authority, rather than truncating its policy or private paths');
  assert.deepEqual(readToolAppInvocation(boundedShared)?.descriptor, sharedDescriptor);
  const boundedDisplay = projectAgentMessageForLoadedContext(oversizedShared, 'display');
  assert.deepEqual(readToolAppInvocation(boundedDisplay)?.descriptor, sharedDescriptor);
  assert.doesNotMatch(JSON.stringify(boundedDisplay), /mcpAppAuthority|PRIVATE_ACTOR/);
  const boundedExternal = projectAgentEventForExternal({ type: 'tool_execution_end', result: oversizedShared });
  assert.deepEqual(readToolAppInvocation(boundedExternal.result)?.descriptor, sharedDescriptor);
  assert.doesNotMatch(JSON.stringify(boundedExternal), /mcpAppAuthority|PRIVATE_ACTOR/);
  assert.doesNotMatch(JSON.stringify(projectAgentMessageForLoadedContext({ ...sharedMessage, details: { mcpAppAuthority: privateAuthority } } as AgentMessage, 'display')),
    /mcpAppAuthority|PRIVATE_ACTOR/, 'a missing app descriptor cannot reveal its private proof');
  assert.equal(JSON.stringify(sharedMessage), sharedOriginal, 'public projections never mutate the stored original');
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
