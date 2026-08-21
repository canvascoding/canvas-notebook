import type { AgentTool } from '@earendil-works/pi-agent-core';

import {
  isProgressiveGatewayTool,
  withAllowedProgressiveGatewayOperations,
} from './progressive-tool-gateway';

/**
 * The built-in email agent may maintain mailbox cases and human-reviewed
 * outbox drafts, and may read workspace knowledge to do so. This is a hard
 * server-side ceiling, independent of persisted agent preferences.
 */
export const EMAIL_AGENT_ALLOWED_TOOL_NAMES = [
  'email_list_mailboxes',
  'email_search_messages',
  'email_read_message',
  'email_list_thread_messages',
  'email_list_cases',
  'email_create_or_update_case',
  'email_create_outbox_draft',
  'email_update_outbox_draft',
  'email_list_outbox_drafts',
  'ls',
  'read',
  'rg',
  'grep',
  'glob',
  'inspect_document_relations',
] as const;

export const EMAIL_AGENT_ALLOWED_TOOL_NAME_SET = new Set<string>(EMAIL_AGENT_ALLOWED_TOOL_NAMES);
export const EMAIL_AGENT_DEFAULT_ENABLED_TOOLS = [...EMAIL_AGENT_ALLOWED_TOOL_NAMES];

export function filterToolsToAllowedNames(tools: AgentTool[], allowedNames: ReadonlySet<string>): AgentTool[] {
  return tools.flatMap((tool) => {
    if (isProgressiveGatewayTool(tool)) {
      const constrained = withAllowedProgressiveGatewayOperations(tool, allowedNames);
      return constrained ? [constrained] : [];
    }
    return allowedNames.has(tool.name) ? [tool] : [];
  });
}

export function emailAgentDisallowedToolNames(toolNames: readonly string[] | null | undefined): string[] {
  return (toolNames || []).filter((toolName) => !EMAIL_AGENT_ALLOWED_TOOL_NAME_SET.has(toolName));
}
