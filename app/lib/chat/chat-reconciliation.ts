import { areChatMessageListsEquivalent, areChatMessagesEquivalent } from '@/app/lib/chat/message-equivalence';
import { getChatMessageSequence, getChatMessageTimestamp } from '@/app/lib/chat/message-metadata';
import { getChatMessageRenderKey } from '@/app/lib/chat/message-render-key';
import type { ChatMessage } from '@/app/lib/chat/types';

function persistedId(message: ChatMessage): number | null {
  return /^\d+$/.test(message.id) ? Number(message.id) : null;
}

function matchingMessage(left: ChatMessage, right: ChatMessage): boolean {
  if (left.role !== right.role) return false;
  if (left.id === right.id) return true;
  // Distinct persisted messages can legitimately share a timestamp and text.
  if (persistedId(left) !== null && persistedId(right) !== null) return false;
  return getChatMessageRenderKey(left) === getChatMessageRenderKey(right);
}

function chronologicalOrder(left: ChatMessage, right: ChatMessage): number {
  const leftSequence = getChatMessageSequence(left);
  const rightSequence = getChatMessageSequence(right);
  if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  const leftTime = getChatMessageTimestamp(left);
  const rightTime = getChatMessageTimestamp(right);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;
  const leftId = persistedId(left);
  const rightId = persistedId(right);
  if (leftId !== null && rightId !== null) return leftId - rightId;
  // Unconfirmed local messages without runtime metadata remain after history.
  if (leftTime === null && leftId === null && (rightTime !== null || rightId !== null)) return 1;
  if (rightTime === null && rightId === null && (leftTime !== null || leftId !== null)) return -1;
  return 0;
}

/** Merge a persisted page without discarding other pages or newer live updates. */
export function reconcileChatMessages(
  current: ChatMessage[],
  incoming: ChatMessage[],
  requestSnapshot: ChatMessage[],
): ChatMessage[] {
  const merged = [...current];
  for (const persisted of incoming) {
    const index = merged.findIndex((message) => matchingMessage(message, persisted));
    if (index < 0) {
      merged.push(persisted);
      continue;
    }
    const visible = merged[index];
    const atRequestStart = requestSnapshot.find((message) => matchingMessage(message, visible));
    // A WebSocket event or optimistic update after request start wins over that
    // request's potentially older snapshot. The next refresh can confirm it.
    if (!atRequestStart || !areChatMessagesEquivalent(atRequestStart, visible)) continue;
    merged[index] = {
      ...persisted,
      ...(visible.isCollapsed !== undefined ? { isCollapsed: visible.isCollapsed } : {}),
      ...(visible.autoCollapsedAtEnd !== undefined ? { autoCollapsedAtEnd: visible.autoCollapsedAtEnd } : {}),
    };
  }
  merged.sort(chronologicalOrder);
  const sameRuntimeMetadata = current.length === merged.length && current.every((message, index) => (
    getChatMessageSequence(message) === getChatMessageSequence(merged[index])
    && getChatMessageTimestamp(message) === getChatMessageTimestamp(merged[index])
  ));
  return sameRuntimeMetadata && areChatMessageListsEquivalent(current, merged) ? current : merged;
}

export type ChatMessagePagination = {
  hasMoreBefore: boolean;
  oldestTimestamp: number | null;
  oldestMessageId: number | null;
  oldestSequence: number | null;
};

export const EMPTY_CHAT_PAGINATION: ChatMessagePagination = {
  hasMoreBefore: false, oldestTimestamp: null, oldestMessageId: null, oldestSequence: null,
};

/** Keep the earliest loaded boundary when refreshing only the newest page. */
export function reconcileChatPagination(
  current: ChatMessagePagination,
  incoming: ChatMessagePagination,
): ChatMessagePagination {
  if (incoming.oldestSequence === null && incoming.oldestTimestamp === null && incoming.oldestMessageId === null) {
    return current;
  }
  let order = 0;
  if (current.oldestSequence !== null && incoming.oldestSequence !== null) {
    order = current.oldestSequence - incoming.oldestSequence;
  } else if (current.oldestTimestamp !== null && incoming.oldestTimestamp !== null) {
    order = current.oldestTimestamp - incoming.oldestTimestamp;
  }
  if (order === 0 && current.oldestMessageId !== null && incoming.oldestMessageId !== null) {
    order = current.oldestMessageId - incoming.oldestMessageId;
  }
  return order < 0 ? current : incoming;
}
