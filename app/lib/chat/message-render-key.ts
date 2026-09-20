import { getPiMessageContent, isToolCallPart } from '@/app/lib/chat/message-content';
import { getChatMessageTimestamp } from '@/app/lib/chat/message-metadata';
import type { ChatMessage } from '@/app/lib/chat/types';

export function getChatMessageRenderKey(message: ChatMessage): string {
  if (message.toolCallId) {
    return `tool-call:${message.toolCallId}`;
  }

  if (message.compactMeta) {
    return `compact:${message.compactMeta.attemptId || message.compactMeta.timestamp}`;
  }

  const piContent = getPiMessageContent(message.piMessage);
  if (Array.isArray(piContent)) {
    const toolCallIds = piContent
      .filter(isToolCallPart)
      .map((part) => part.id);
    if (toolCallIds.length > 0) {
      return `${message.role}:tool-calls:${toolCallIds.join(':')}`;
    }
  }

  const timestamp = getChatMessageTimestamp(message);
  if (timestamp !== null) {
    return `${message.role}:timestamp:${timestamp}`;
  }

  return `${message.role}:id:${message.id}`;
}
