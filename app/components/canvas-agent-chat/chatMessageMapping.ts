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
import { isDelegationCompletionMessage } from '@/app/lib/pi/delegation-completion-message';

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
        attemptId: cb.attemptId,
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
        workspaceId: authMsg.workspaceId,
        profileId: authMsg.profileId,
        profileName: authMsg.profileName,
        profileSource: authMsg.profileSource,
      },
    };
  }

  if (rawMessage.role === 'toolResult') {
    const resultContent = getPiMessageContent(rawMessage);
    const resultText = extractToolResultText(Array.isArray(resultContent) ? resultContent : undefined)
      || extractPiMessageText(rawMessage);
    try {
      const payload = JSON.parse(resultText) as Record<string, unknown>;
      if (payload.auth_required === true) {
        const toolkit = typeof payload.toolkit === 'string' ? payload.toolkit : '';
        const toolkitName = typeof payload.toolkit_name === 'string' ? payload.toolkit_name : toolkit;
        return {
          id: rawMessage.id?.toString() || `composio-auth-${toolkit}`,
          role: 'system',
          content: resultText,
          type: 'composio_auth_required',
          status: 'sent',
          piMessage: rawMessage,
          composioAuthMeta: {
            toolkit,
            toolkitName,
            redirectUrl: typeof payload.redirect_url === 'string' ? payload.redirect_url : '',
            toolName: typeof payload.tool_name === 'string' ? payload.tool_name : '',
            workspaceId: typeof payload.workspace_id === 'string' ? payload.workspace_id : null,
            profileId: typeof payload.profile_id === 'string' ? payload.profile_id : null,
            profileName: typeof payload.profile_name === 'string' ? payload.profile_name : null,
            profileSource: payload.profile_source === 'workspace_override' ? 'workspace_override' : 'default',
          },
        };
      }
    } catch {
      // Regular tool results are not required to contain JSON.
    }
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
    .filter((rawMessage) => (
      !isRuntimeContinuationMessage(rawMessage)
      && !isDelegationCompletionMessage(rawMessage)
    ))
    .map((rawMessage) => mapPersistedChatMessage(rawMessage, runStoppedLabel, toolCallsById));
}
