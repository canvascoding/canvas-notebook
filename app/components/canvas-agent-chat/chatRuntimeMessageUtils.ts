import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  extractPiMessageText,
  getPiMessageContent,
  isImagePart,
} from '@/app/lib/chat/message-content';
import type { ChatMessage } from '@/app/lib/chat/types';

export function isLiveMessageInProgress(message: ChatMessage): boolean {
  return Boolean(message.optimistic) ||
    message.status === 'pending' ||
    message.status === 'sending' ||
    message.status === 'aborting' ||
    message.status === 'queued_follow_up' ||
    message.status === 'queued_steering';
}

export function buildQueuedMessageKey(text: string, attachmentCount: number): string {
  return `${text.trim()}::${attachmentCount}`;
}

export function getAgentMessageTimestamp(message?: AgentMessage | null): number | null {
  const timestamp = (message as { timestamp?: unknown } | null | undefined)?.timestamp;
  return typeof timestamp === 'number' ? timestamp : null;
}

export function countPiMessageImageAttachments(message?: AgentMessage | null): number {
  const content = getPiMessageContent(message);
  if (!Array.isArray(content)) {
    return 0;
  }

  return content.filter(isImagePart).length;
}

export function getQueuedSignatureFromPiMessage(message?: AgentMessage | null): string | null {
  const timestamp = getAgentMessageTimestamp(message);
  if (timestamp === null || !message || message.role !== 'user') {
    return null;
  }

  return `${timestamp}:${extractPiMessageText(message)}:${countPiMessageImageAttachments(message)}`;
}

export function getVisibleUserMessageKey(message: AgentMessage | null | undefined, fallbackContent: string): string {
  return buildQueuedMessageKey(fallbackContent, countPiMessageImageAttachments(message));
}
