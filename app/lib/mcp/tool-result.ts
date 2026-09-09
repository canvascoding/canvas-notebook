import type { CallToolResult } from '@modelcontextprotocol/client';
import { getAgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { prepareToolOutput } from '@/app/lib/pi/tool-output-preparation';

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
  return prepareToolOutput({ result: normalizeMcpToolResult(server, tool, result), raw: result,
    identity: getAgentExecutionContext(), toolCallId, toolName: 'mcp',
  });
}
