import type { ChatMessage } from '@/app/lib/chat/types';

export function getChatMessageTimestamp(message: ChatMessage | undefined): number | null {
  if (!message?.piMessage) {
    return null;
  }

  const timestamp = (message.piMessage as { timestamp?: unknown }).timestamp;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return timestamp;
  }

  if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function getChatMessageDbId(message: ChatMessage | undefined): number | null {
  if (!message) {
    return null;
  }

  const parsed = parseInt(message.id, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getChatMessageSequence(message: ChatMessage | undefined): number | null {
  const sequence = (message?.piMessage as { sequence?: unknown } | undefined)?.sequence;
  return typeof sequence === 'number' && Number.isFinite(sequence) ? sequence : null;
}
