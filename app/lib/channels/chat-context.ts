import type { ChatRequestContext } from '@/app/lib/chat/types';
import type { InboundMessage } from './types';

export function buildChannelChatContext(
  message: Pick<InboundMessage, 'channelId'>,
  context?: ChatRequestContext,
): ChatRequestContext {
  return {
    ...context,
    channelId: message.channelId,
  };
}
