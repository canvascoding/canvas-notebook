import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/client';

export type PersonalMcpAppDescriptor = {
  version: 1;
  connectionId: string;
  toolName: string;
  resourceUri: string;
};

export type SharedMcpAppDescriptor = {
  version: 2;
  connectionRef: string;
  toolCallId: string;
  toolName: string;
  resourceUri: string;
  bindingRevision: string;
};

export type McpAppDescriptor = PersonalMcpAppDescriptor | SharedMcpAppDescriptor;

export type McpAppInvocationDetails = {
  mcpApp: McpAppDescriptor;
  mcpToolInput: Record<string, unknown>;
  result: CallToolResult;
};

export type McpAppResourceResult = ReadResourceResult;
