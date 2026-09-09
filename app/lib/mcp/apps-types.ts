import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/client';

export type McpAppInvocationDetails = {
  mcpApp: {
    version: 1;
    connectionId: string;
    toolName: string;
    resourceUri: string;
  };
  mcpToolInput: Record<string, unknown>;
  result: CallToolResult;
};

export type McpAppResourceResult = ReadResourceResult;
