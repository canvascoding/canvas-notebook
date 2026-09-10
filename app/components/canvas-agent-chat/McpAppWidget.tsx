'use client';

import type { McpAppInvocationDetails } from '@/app/lib/mcp/apps-types';
import { ToolAppWidget } from './ToolAppWidget';

type Props = { descriptor: McpAppInvocationDetails['mcpApp']; input: unknown; result: unknown; sessionId: string; agentId: string };

/** Preserve the existing MCP entry point while sharing the complete host. */
export function McpAppWidget({ descriptor, input, result, sessionId, agentId }: Props) {
  return <ToolAppWidget invocation={{ kind: 'mcp', descriptor, input, result }} sessionId={sessionId} agentId={agentId} />;
}
