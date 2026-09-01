import type { AgentMessage } from '@earendil-works/pi-agent-core';

declare module '@earendil-works/pi-agent-core' {
  interface CustomAgentMessages {
    'compact-break': CompactBreakMessage;
    'composio_auth_required': ComposioAuthRequiredMessage;
    runtime_continuation: RuntimeContinuationMessage;
  }
}

export interface CompactBreakMessage {
  role: 'compact-break';
  attemptId: string;
  kind: 'manual' | 'automatic';
  timestamp: string;
  omittedMessageCount: number;
}

export function createCompactBreakMessage(
  attemptId: string,
  kind: 'manual' | 'automatic',
  timestamp: string,
  omittedMessageCount: number,
): CompactBreakMessage {
  return { role: 'compact-break', attemptId, kind, timestamp, omittedMessageCount };
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
  workspaceId?: string | null;
  profileId?: string | null;
  profileName?: string | null;
  profileSource?: 'default' | 'workspace_override' | null;
}

export function createComposioAuthRequiredMessage(
  toolkit: string,
  toolkitName: string,
  redirectUrl: string,
  toolName: string,
  context: {
    workspaceId?: string | null;
    profileId?: string | null;
    profileName?: string | null;
    profileSource?: 'default' | 'workspace_override' | null;
  } = {},
): ComposioAuthRequiredMessage {
  return { role: 'composio_auth_required', toolkit, toolkitName, redirectUrl, toolName, ...context };
}

export function isComposioAuthRequiredMessage(m: AgentMessage): m is ComposioAuthRequiredMessage {
  return m.role === 'composio_auth_required';
}

export type RuntimeContinuationReason = 'tool_tail' | 'intermediate_ack';

export interface RuntimeContinuationMessage {
  role: 'runtime_continuation';
  reason: RuntimeContinuationReason;
  content: string;
  timestamp: number;
}

export function createRuntimeContinuationMessage(
  reason: RuntimeContinuationReason,
  content: string,
  timestamp = Date.now(),
): RuntimeContinuationMessage {
  return { role: 'runtime_continuation', reason, content, timestamp };
}

export function isRuntimeContinuationMessage(m: AgentMessage): m is RuntimeContinuationMessage {
  return m.role === 'runtime_continuation';
}
