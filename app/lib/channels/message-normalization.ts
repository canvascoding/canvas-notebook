import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { UserAgentMessage } from '@/app/lib/pi/runtime-service';
import type { InboundMessage } from './types';
import { resolveChatClientMessageId } from '@/app/lib/chat/message-submission';

export function buildUserAgentMessageFromInbound(message: InboundMessage): UserAgentMessage {
  const clientMessageId = resolveChatClientMessageId(message.clientMessageId, undefined);
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
    clientMessageId,
  } as Extract<AgentMessage, { role: 'user' }>;
}
