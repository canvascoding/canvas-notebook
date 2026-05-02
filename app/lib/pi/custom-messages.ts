import type { AgentMessage } from '@mariozechner/pi-agent-core';

declare module '@mariozechner/pi-agent-core' {
  interface CustomAgentMessages {
    'compact-break': CompactBreakMessage;
    'composio_auth_required': ComposioAuthRequiredMessage;
  }
}

export interface CompactBreakMessage {
  role: 'compact-break';
  kind: 'manual' | 'automatic';
  timestamp: string;
  omittedMessageCount: number;
}

export function createCompactBreakMessage(
  kind: 'manual' | 'automatic',
  timestamp: string,
  omittedMessageCount: number,
): CompactBreakMessage {
  return { role: 'compact-break', kind, timestamp, omittedMessageCount };
}

export function isCompactBreakMessage(m: AgentMessage): m is CompactBreakMessage {
  return m.role === 'compact-break';
}

export interface ComposioAuthRequiredMessage {
  role: 'composio_auth_required';
  toolkit: string;
  toolkitName: string;
  redirectUrl: string;
  toolName: string;
}

export function createComposioAuthRequiredMessage(
  toolkit: string,
  toolkitName: string,
  redirectUrl: string,
  toolName: string,
): ComposioAuthRequiredMessage {
  return { role: 'composio_auth_required', toolkit, toolkitName, redirectUrl, toolName };
}

export function isComposioAuthRequiredMessage(m: AgentMessage): m is ComposioAuthRequiredMessage {
  return m.role === 'composio_auth_required';
}
