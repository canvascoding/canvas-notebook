import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { UserAgentMessage } from '@/app/lib/pi/runtime-service';
import type { InboundMessage } from './types';

export function buildUserAgentMessageFromInbound(message: InboundMessage): UserAgentMessage {
  const content = message.contentParts?.length
    ? message.contentParts
    : message.images?.length
      ? [
          { type: 'text' as const, text: message.text },
          ...message.images.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
        ]
      : message.text;
  const timestamp = typeof message.agentMessageTimestamp === 'number' && Number.isFinite(message.agentMessageTimestamp)
    ? message.agentMessageTimestamp
    : Date.now();

  return {
    role: 'user',
    content,
    timestamp,
  } as Extract<AgentMessage, { role: 'user' }>;
}
