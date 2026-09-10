import type { McpAppInvocationDetails } from '@/app/lib/mcp/apps-types';

export const AUTOMATION_APP_URI = 'ui://canvas/automation-job/v1';
export const AUTOMATION_APP_OPERATIONS = ['create_automation_job', 'inspect_automation_job', 'update_automation_job'] as const;
export type AutomationAppOperation = typeof AUTOMATION_APP_OPERATIONS[number];

export type BuiltinToolAppDescriptor = {
  kind: 'builtin';
  version: 1;
  resourceUri: typeof AUTOMATION_APP_URI;
  toolCallId: string;
  operation: AutomationAppOperation;
  entityId: string;
};

export type ToolAppInvocation = {
  kind: 'mcp';
  descriptor: McpAppInvocationDetails['mcpApp'];
  input: unknown;
  result: unknown;
} | {
  kind: 'builtin';
  descriptor: BuiltinToolAppDescriptor;
};

export function isToolAppRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function readBuiltinToolAppDescriptor(value: unknown): BuiltinToolAppDescriptor | null {
  if (!isToolAppRecord(value) || value.kind !== 'builtin' || value.version !== 1
    || value.resourceUri !== AUTOMATION_APP_URI
    || typeof value.toolCallId !== 'string' || !value.toolCallId || value.toolCallId.length > 256
    || typeof value.entityId !== 'string' || !/^job-[0-9a-f-]{36}$/iu.test(value.entityId)
    || !AUTOMATION_APP_OPERATIONS.includes(value.operation as AutomationAppOperation)) return null;
  return { kind: 'builtin', version: 1, resourceUri: AUTOMATION_APP_URI,
    toolCallId: value.toolCallId, operation: value.operation as AutomationAppOperation, entityId: value.entityId };
}

/** Only genuine successful Canvas operations may bind an internal widget. */
export function readBuiltinToolAppMessage(value: unknown): BuiltinToolAppDescriptor | null {
  if (!isToolAppRecord(value) || value.role !== 'toolResult' || value.isError
    || !isToolAppRecord(value.details) || value.details.error) return null;
  const descriptor = readBuiltinToolAppDescriptor(value.details.toolApp);
  if (!descriptor || descriptor.toolCallId !== value.toolCallId) return null;
  const operation = value.toolName === 'automations' && value.details.action === 'call'
    ? value.details.operation : value.toolName;
  if (operation !== descriptor.operation || !isToolAppRecord(value.details.job)
    || value.details.job.id !== descriptor.entityId) return null;
  return descriptor;
}

/** Compatibility boundary: persisted MCP messages keep their existing shape. */
export function readToolAppInvocation(message: unknown): ToolAppInvocation | null {
  if (!isToolAppRecord(message) || !isToolAppRecord(message.details)) return null;
  const builtin = readBuiltinToolAppMessage(message);
  if (builtin) return { kind: 'builtin', descriptor: builtin };
  const { mcpApp, mcpToolInput, result } = message.details;
  if (!isToolAppRecord(mcpApp) || mcpApp.version !== 1
    || typeof mcpApp.connectionId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(mcpApp.connectionId)
    || typeof mcpApp.toolName !== 'string' || !mcpApp.toolName || mcpApp.toolName.length > 256
    || typeof mcpApp.resourceUri !== 'string' || !/^ui:\/\/[^\s]+$/u.test(mcpApp.resourceUri) || mcpApp.resourceUri.length > 4096) return null;
  return { kind: 'mcp', descriptor: { version: 1, connectionId: mcpApp.connectionId,
    toolName: mcpApp.toolName, resourceUri: mcpApp.resourceUri }, input: mcpToolInput, result };
}
