import type { McpAppInvocationDetails } from '@/app/lib/mcp/apps-types';

export const AUTOMATION_APP_URI = 'ui://canvas/automation-job/v1';
export const AUTOMATION_APP_OPERATIONS = ['create_automation_job', 'inspect_automation_job', 'update_automation_job'] as const;
export type AutomationAppOperation = typeof AUTOMATION_APP_OPERATIONS[number];
export const PUBLIC_SHARE_APP_URI = 'ui://canvas/public-share/v1';
export const PUBLIC_SHARE_APP_OPERATIONS = ['create', 'list', 'revoke'] as const;
export type PublicShareAppOperation = typeof PUBLIC_SHARE_APP_OPERATIONS[number];
export const MAX_BUILTIN_TOOL_APPS = 10;

export const TODO_APP_URI = 'ui://canvas/human-todo/v1';
export const TODO_APP_OPERATIONS = ['create_human_todo', 'inspect_human_todo', 'update_human_todo'] as const;
export type TodoAppOperation = typeof TODO_APP_OPERATIONS[number];

type BuiltinToolAppBinding = {
  kind: 'builtin';
  version: 1;
  toolCallId: string;
  entityId: string;
};
export type BuiltinToolAppDescriptor = BuiltinToolAppBinding & (
  { resourceUri: typeof AUTOMATION_APP_URI; operation: AutomationAppOperation }
  | { resourceUri: typeof TODO_APP_URI; operation: TodoAppOperation }
  | { resourceUri: typeof PUBLIC_SHARE_APP_URI; operation: PublicShareAppOperation }
);

export function automationToolApp(entityId: string, toolCallId: string, operation: AutomationAppOperation): BuiltinToolAppDescriptor {
  return { kind: 'builtin', version: 1, resourceUri: AUTOMATION_APP_URI, entityId, toolCallId, operation };
}

export function todoToolApp(entityId: string, toolCallId: string, operation: TodoAppOperation): BuiltinToolAppDescriptor {
  return { kind: 'builtin', version: 1, resourceUri: TODO_APP_URI, entityId, toolCallId, operation };
}

/** One bounded, deduplicated card per returned public link. */
export function publicShareToolApps(shares: Array<{ id: string }>, toolCallId: string, operation: PublicShareAppOperation): BuiltinToolAppDescriptor[] {
  return [...new Set(shares.map(share => share.id))].slice(0, MAX_BUILTIN_TOOL_APPS).map(entityId => ({
    kind: 'builtin', version: 1, resourceUri: PUBLIC_SHARE_APP_URI, entityId, toolCallId, operation,
  }));
}

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
    || typeof value.toolCallId !== 'string' || !value.toolCallId || value.toolCallId.length > 256
    || typeof value.entityId !== 'string') return null;
  if (value.resourceUri === AUTOMATION_APP_URI && /^job-[0-9a-f-]{36}$/iu.test(value.entityId)
    && AUTOMATION_APP_OPERATIONS.includes(value.operation as AutomationAppOperation)) {
    return automationToolApp(value.entityId, value.toolCallId, value.operation as AutomationAppOperation);
  }
  if (value.resourceUri === TODO_APP_URI && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value.entityId)
    && TODO_APP_OPERATIONS.includes(value.operation as TodoAppOperation)) {
    return todoToolApp(value.entityId, value.toolCallId, value.operation as TodoAppOperation);
  }
  if (value.resourceUri === PUBLIC_SHARE_APP_URI && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value.entityId)
    && PUBLIC_SHARE_APP_OPERATIONS.includes(value.operation as PublicShareAppOperation)) {
    return publicShareToolApps([{ id: value.entityId }], value.toolCallId, value.operation as PublicShareAppOperation)[0];
  }
  return null;
}

/** Only genuine successful Canvas operations may bind internal widgets. */
export function readBuiltinToolAppMessages(value: unknown): BuiltinToolAppDescriptor[] {
  if (!isToolAppRecord(value) || value.role !== 'toolResult' || value.isError
    || !isToolAppRecord(value.details) || value.details.error) return [];
  const details = value.details;
  if (details.toolApp && details.toolApps) return [];
  const candidates = details.toolApps === undefined ? [details.toolApp] : details.toolApps;
  if (!Array.isArray(candidates) || candidates.length > MAX_BUILTIN_TOOL_APPS) return [];
  const seen = new Set<string>();
  return candidates.flatMap((candidate): BuiltinToolAppDescriptor[] => {
    const descriptor = readBuiltinToolAppDescriptor(candidate);
    if (!descriptor || descriptor.toolCallId !== value.toolCallId || seen.has(descriptor.entityId)) return [];
    if (descriptor.resourceUri === PUBLIC_SHARE_APP_URI) {
      const shares = descriptor.operation === 'revoke' ? [details.share] : details.shares;
      if (value.toolName !== 'public_share_file' || descriptor.operation !== details.publicShareAction
        || !Array.isArray(shares) || !shares.some(share => isToolAppRecord(share) && share.id === descriptor.entityId)) return [];
    } else {
      const operation = descriptor.resourceUri === AUTOMATION_APP_URI && value.toolName === 'automation_manage' && details.action === 'call'
        ? details.operation : value.toolName;
      const entity = details[descriptor.resourceUri === AUTOMATION_APP_URI ? 'job' : 'todo'];
      if (operation !== descriptor.operation || !isToolAppRecord(entity) || entity.id !== descriptor.entityId) return [];
    }
    seen.add(descriptor.entityId);
    return [descriptor];
  });
}

export function readBuiltinToolAppMessage(value: unknown): BuiltinToolAppDescriptor | null {
  return readBuiltinToolAppMessages(value)[0] ?? null;
}

export function readToolAppInvocations(message: unknown): ToolAppInvocation[] {
  const builtins = readBuiltinToolAppMessages(message);
  if (builtins.length) return builtins.map(descriptor => ({ kind: 'builtin', descriptor }));
  const invocation = readToolAppInvocation(message);
  return invocation ? [invocation] : [];
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
