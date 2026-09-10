import type { CallToolResult } from '@modelcontextprotocol/client';
import { getAgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { prepareToolOutput } from '@/app/lib/pi/tool-output-preparation';
import { stripMcpModelMetadata } from '@/app/lib/pi/message-projection';
import { readMcpAppToolMetadata } from './apps-metadata';
import type { callMcpToolWithCurrentMetadata } from './manager';

/** One normalization contract for direct MCP tools and the MCP gateway. */
export function normalizeMcpToolResult(server: string, tool: string, result: CallToolResult) {
  const blocks = Array.isArray(result.content) ? result.content.map(block => {
    if (block.type === 'text') return block.text;
    if (block.type === 'image') return `[image ${block.mimeType}]`;
    if (block.type === 'audio') return `[audio ${block.mimeType}]`;
    if (block.type === 'resource') return `[resource ${block.resource.uri}]${'text' in block.resource ? `\n${block.resource.text}` : ''}`;
    if (block.type === 'resource_link') return `[resource link ${block.uri}]${block.name ? ` ${block.name}` : ''}`;
    return JSON.stringify(block);
  }) : [];
  if (blocks.length === 0 && result.structuredContent !== undefined) blocks.push(`Structured result:\n${JSON.stringify(result.structuredContent)}`);
  if (!Array.isArray(result.content) && result.structuredContent === undefined) blocks.push(JSON.stringify(result));
  const body = blocks.join('\n') || '(empty MCP tool result)';
  return {
    content: [{ type: 'text' as const, text: result.isError ? `MCP tool "${server}.${tool}" returned an error:\n${body}` : body }],
    details: { server, tool, isError: result.isError === true, result },
  };
}

export async function prepareMcpToolResult(server: string, tool: string, result: CallToolResult, toolCallId: string) {
  const modelResult = stripMcpModelMetadata(result) as CallToolResult;
  const normalized = normalizeMcpToolResult(server, tool, modelResult);
  normalized.details.result = result;
  // Agent-readable archives must obey the same MCP metadata boundary as text.
  return prepareToolOutput({ result: normalized, raw: modelResult, outcomeValues: [modelResult],
    identity: getAgentExecutionContext(), toolCallId, toolName: 'mcp',
  });
}

/** Current server metadata controls widget eligibility. Keep the existing,
 * separately capped widget payload for display; final LLM normalization removes
 * these details, while its text continues through the common output budget. */
export async function prepareMcpToolInvocation(server: string, tool: string,
  invocation: Awaited<ReturnType<typeof callMcpToolWithCurrentMetadata>>, input: Record<string, unknown>, toolCallId: string) {
  const prepared = await prepareMcpToolResult(server, tool, invocation.result, toolCallId);
  const app = invocation.connectionId ? readMcpAppToolMetadata(invocation.tool) : null;
  if (!app || !invocation.connectionId) return prepared;
  const fitsWidget = JSON.stringify({ input, result: invocation.result }).length <= 2 * 1024 * 1024;
  return { ...prepared, details: { ...(prepared.details as Record<string, unknown>),
    mcpApp: { version: 1 as const, connectionId: invocation.connectionId, toolName: invocation.tool.name, resourceUri: app.resourceUri },
    // Oversized widget data follows the existing unavailable-widget behavior;
    // the ordinary output preview still exposes any successfully stored original.
    mcpToolInput: fitsWidget ? input : undefined,
    result: fitsWidget ? invocation.result : undefined,
  } };
}
