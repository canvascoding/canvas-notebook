import type { ChatRequestContext } from '@/app/lib/chat/types';
import { sendMessage } from '@/app/lib/pi/runtime-service';
import type { InboundMessage } from './types';
import { resolveChannelSession } from './session-resolver';
import { buildUserAgentMessageFromInbound } from './message-normalization';

export type RoutedChannelMessageResult = {
  sessionId: string;
  status: Record<string, unknown>;
};

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

  const status = await sendMessage(sessionId, message.userId, buildUserAgentMessageFromInbound(message), context);
  return { sessionId, status };
}
