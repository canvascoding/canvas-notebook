import type { AgentMessage } from '@mariozechner/pi-agent-core';
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

  return {
    role: 'user',
    content,
    timestamp: Date.now(),
  } as Extract<AgentMessage, { role: 'user' }>;
}
