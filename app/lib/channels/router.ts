import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ChatRequestContext } from '@/app/lib/chat/types';
import { sendMessage, type UserAgentMessage } from '@/app/lib/pi/runtime-service';
import type { InboundMessage } from './types';
import { resolveChannelSession } from './session-resolver';

export type RoutedChannelMessageResult = {
  sessionId: string;
  status: Record<string, unknown>;
};

function toUserAgentMessage(message: InboundMessage): UserAgentMessage {
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

export async function handleInboundChannelMessage(
  message: InboundMessage,
  context?: ChatRequestContext,
): Promise<RoutedChannelMessageResult> {
  const sessionId = await resolveChannelSession({
    userId: message.userId,
    channelId: message.channelId,
    channelSessionKey: message.channelSessionKey,
    channelThreadKey: message.channelThreadKey,
    requestedSessionId: message.requestedSessionId,
    displayName: typeof message.metadata?.displayName === 'string' ? message.metadata.displayName : null,
  });

  const status = await sendMessage(sessionId, message.userId, toUserAgentMessage(message), context);
  return { sessionId, status };
}
