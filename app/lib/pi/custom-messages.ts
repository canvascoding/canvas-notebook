import type { AgentMessage } from '@mariozechner/pi-agent-core';

declare module '@mariozechner/pi-agent-core' {
  interface CustomAgentMessages {
    'compact-break': CompactBreakMessage;
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
