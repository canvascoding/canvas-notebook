import type { AgentTool } from '@earendil-works/pi-agent-core';

import {
  isProgressiveGatewayTool,
  withAllowedProgressiveGatewayOperations,
} from './progressive-tool-gateway';

/**
 * Inbox-triggered automations run on untrusted external email content. Their
 * narrow server-side ceiling is deliberately independent of the Email Agent's
 * administrator-managed tool preferences for normal sessions.
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
