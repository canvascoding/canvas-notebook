import type {
  ChatMessage,
  PersistedChatMessage,
  PersistedToolCallPart,
} from '@/app/lib/chat/types';
import {
  dedupeAttachments,
  extractImageAttachments,
  extractMessageAttachments,
  extractPiMessageText,
  extractToolResultImageAttachments,
  extractToolResultText,
  formatToolArgs,
  getChatMessageRole,
  getPiMessageContent,
  isAbortedAssistantPiMessage,
  isToolCallPart,
  truncatePreview,
} from '@/app/lib/chat/message-content';
import {
  type CompactBreakMessage,
  isComposioAuthRequiredMessage,
  isRuntimeContinuationMessage,
  type ComposioAuthRequiredMessage,
} from '@/app/lib/pi/custom-messages';

export function mapPersistedChatMessage(
  rawMessage: PersistedChatMessage,
  runStoppedLabel: string,
  toolCallsById: Map<string, PersistedToolCallPart> = new Map(),
): ChatMessage {
  if (rawMessage.role === 'compact-break') {
    const cb = rawMessage as unknown as CompactBreakMessage;
    return {
      id: rawMessage.id?.toString() || `compact-${cb.timestamp}`,
      role: 'system',
      content: '',
      type: 'compact_break',
      status: 'sent',
      piMessage: rawMessage,
      compactMeta: {
        kind: cb.kind,
        timestamp: cb.timestamp,
        omittedMessageCount: cb.omittedMessageCount,
      },
    };
  }

  if (isComposioAuthRequiredMessage(rawMessage)) {
    const authMsg = rawMessage as ComposioAuthRequiredMessage;
    return {
      id: rawMessage.id?.toString() || `composio-auth-${authMsg.toolkit}`,
      role: 'system',
      content: `Authentication required for ${authMsg.toolkitName}. [Connect ${authMsg.toolkitName}](${authMsg.redirectUrl})`,
      type: 'composio_auth_required',
      status: 'sent',
      piMessage: rawMessage,
      composioAuthMeta: {
        toolkit: authMsg.toolkit,
        toolkitName: authMsg.toolkitName,
        redirectUrl: authMsg.redirectUrl,
        toolName: authMsg.toolName,
      },
    };
  }

  const isToolResult = rawMessage.role === 'toolResult';
  const toolCallId = isToolResult && 'toolCallId' in rawMessage && typeof rawMessage.toolCallId === 'string'
    ? rawMessage.toolCallId
    : undefined;
  const persistedToolCall = toolCallId ? toolCallsById.get(toolCallId) : undefined;
  const rawMessageContent = getPiMessageContent(rawMessage);
  const content = isToolResult
    ? extractToolResultText(Array.isArray(rawMessageContent) ? rawMessageContent : undefined) || extractPiMessageText(rawMessage)
    : extractPiMessageText(rawMessage, { hideAttachmentMetadata: rawMessage.role === 'user' });
  const resolvedContent = isAbortedAssistantPiMessage(rawMessage) && !content.trim()
    ? runStoppedLabel
    : content;
  const imageAttachments = dedupeAttachments([
    ...extractImageAttachments(rawMessageContent),
    ...extractToolResultImageAttachments(rawMessage),
  ]);
  const messageAttachments = rawMessage.role === 'user'
    ? extractMessageAttachments(rawMessageContent)
    : imageAttachments.length > 0 ? imageAttachments : undefined;
  const chatRole = getChatMessageRole(rawMessage.role);

  return {
    id: rawMessage.id?.toString() || Math.random().toString(),
    role: chatRole,
    content: resolvedContent,
    status: 'sent',
    type: isToolResult ? 'tool_result' : chatRole === 'system' ? 'system' : undefined,
    attachments: messageAttachments,
    piMessage: rawMessage,
    toolCallId,
    toolName: persistedToolCall?.name || (isToolResult && 'toolName' in rawMessage && typeof rawMessage.toolName === 'string' ? rawMessage.toolName : undefined),
    toolArgs: persistedToolCall ? formatToolArgs(persistedToolCall.arguments) : undefined,
    isCollapsed: isToolResult,
    autoCollapsedAtEnd: isToolResult,
    previewText: isToolResult ? truncatePreview(resolvedContent) : undefined,
  };
}

export function mapPersistedChatMessages(
  rawMessages: PersistedChatMessage[],
  runStoppedLabel: string,
): ChatMessage[] {
  const toolCallsById = new Map<string, PersistedToolCallPart>();

  for (const rawMessage of rawMessages) {
    const rawMessageContent = getPiMessageContent(rawMessage);
    if (rawMessage.role !== 'assistant' || !Array.isArray(rawMessageContent)) {
      continue;
    }

    for (const part of rawMessageContent) {
      if (isToolCallPart(part)) {
        toolCallsById.set(part.id, part);
      }
    }
  }

  return rawMessages
    .filter((rawMessage) => !isRuntimeContinuationMessage(rawMessage))
    .map((rawMessage) => mapPersistedChatMessage(rawMessage, runStoppedLabel, toolCallsById));
}
