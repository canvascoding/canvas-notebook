'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { useTranslations } from 'next-intl';
import {
  createThinkingFilterState,
  filterThinkingChunk,
  flushThinkingFilter,
} from '@/app/lib/pi/thinking-filter';
import type { ThinkingFilterState } from '@/app/lib/pi/thinking-filter';
import {
  dedupeAttachments,
  extractImageAttachments,
  extractMessageAttachments,
  extractPiMessageText,
  extractToolResultImageAttachments,
  extractToolResultText,
  formatToolArgs,
  getPiMessageContent,
  isAbortedAssistantPiMessage,
  normalizeMessageStart,
  truncatePreview,
} from '@/app/lib/chat/message-content';
import {
  getHistoryRuntimeActiveToolName,
  getHistoryRuntimePhase,
} from '@/app/lib/chat/runtime-message-utils';
import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
import type {
  AISession,
  Attachment,
  ChatEvent,
  ChatMessage,
} from '@/app/lib/chat/types';
import {
  buildQueuedMessageKey,
  countPiMessageImageAttachments,
  getAgentMessageTimestamp,
  getQueuedSignatureFromPiMessage,
  getVisibleUserMessageKey,
  isLiveMessageInProgress,
} from '@/app/components/canvas-agent-chat/chatRuntimeMessageUtils';

type ChatTranslator = ReturnType<typeof useTranslations<'chat'>>;

type UseChatRuntimeEventsParams = {
  deferredSavedMessageRefreshSessionRef: MutableRefObject<string | null>;
  refreshSavedMessagesRef: MutableRefObject<((sessionId: string) => void) | null>;
  historyRef: MutableRefObject<AISession[]>;
  isAtBottomRef: MutableRefObject<boolean>;
  messages: ChatMessage[];
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  sessionIdRef: MutableRefObject<string | null>;
  setHistory: Dispatch<SetStateAction<AISession[]>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  t: ChatTranslator;
};

function takeQueueMatch(counts: Map<string, number>, key: string | null): boolean {
  if (!key) {
    return false;
  }

  const count = counts.get(key) || 0;
  if (count <= 0) {
    return false;
  }

  counts.set(key, count - 1);
  return true;
}

export function useChatRuntimeEvents({
  deferredSavedMessageRefreshSessionRef,
  refreshSavedMessagesRef,
  historyRef,
  isAtBottomRef,
  messages,
  scrollToBottom,
  sessionIdRef,
  setHistory,
  setMessages,
  t,
}: UseChatRuntimeEventsParams) {
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const toolMessageIdsRef = useRef<Record<string, string>>({});
  const currentAssistantIdRef = useRef<string | null>(null);
  const streamingContentRef = useRef<string>('');
  const lastFlushedStreamingContentRef = useRef<string>('');
  const streamingRafRef = useRef<number | null>(null);
  const thinkingFilterRef = useRef<ThinkingFilterState>(createThinkingFilterState());
  const thinkingContentRef = useRef<string>('');
  const runtimeStatusRef = useRef<RuntimeStatus | null>(null);
  const lastCompactionMarkerRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    runtimeStatusRef.current = runtimeStatus;
  }, [runtimeStatus]);

  const hasLiveMessagesInProgress = useCallback(() => {
    const status = runtimeStatusRef.current;
    if (status && status.phase !== 'idle') {
      return true;
    }
    return messagesRef.current.some(isLiveMessageInProgress);
  }, []);

  const requestSavedMessageRefresh = useCallback((targetSessionId: string) => {
    if (sessionIdRef.current !== targetSessionId) {
      return;
    }

    const refreshSavedMessages = refreshSavedMessagesRef.current;
    if (!refreshSavedMessages || hasLiveMessagesInProgress()) {
      deferredSavedMessageRefreshSessionRef.current = targetSessionId;
      return;
    }

    refreshSavedMessages(targetSessionId);
  }, [deferredSavedMessageRefreshSessionRef, hasLiveMessagesInProgress, refreshSavedMessagesRef, sessionIdRef]);

  const resetStreamConnection = useCallback(() => {
    currentAssistantIdRef.current = null;
    if (streamingRafRef.current !== null) {
      cancelAnimationFrame(streamingRafRef.current);
      streamingRafRef.current = null;
    }
    streamingContentRef.current = '';
    lastFlushedStreamingContentRef.current = '';
    thinkingFilterRef.current = createThinkingFilterState();
    thinkingContentRef.current = '';
  }, []);

  const resetRuntimeMessageRefs = useCallback(() => {
    toolMessageIdsRef.current = {};
    currentAssistantIdRef.current = null;
    lastCompactionMarkerRef.current = null;
  }, []);

  const clearCurrentAssistant = useCallback((messageId?: string | null) => {
    if (!messageId || currentAssistantIdRef.current === messageId) {
      currentAssistantIdRef.current = null;
    }
  }, []);

  const setLastCompactionMarker = useCallback((timestamp: string | null | undefined) => {
    lastCompactionMarkerRef.current = timestamp || null;
  }, []);

  const reconcileQueuedMessages = useCallback((status: RuntimeStatus) => {
    setMessages((prev) => {
      const followSignatureCounts = new Map<string, number>();
      const steerSignatureCounts = new Map<string, number>();
      const followFallbackCounts = new Map<string, number>();
      const steerFallbackCounts = new Map<string, number>();

      for (const entry of status.followUpQueue) {
        if (entry.signature) {
          followSignatureCounts.set(entry.signature, (followSignatureCounts.get(entry.signature) || 0) + 1);
        } else {
          const key = buildQueuedMessageKey(entry.text, entry.attachmentCount);
          followFallbackCounts.set(key, (followFallbackCounts.get(key) || 0) + 1);
        }
      }

      for (const entry of status.steeringQueue) {
        if (entry.signature) {
          steerSignatureCounts.set(entry.signature, (steerSignatureCounts.get(entry.signature) || 0) + 1);
        } else {
          const key = buildQueuedMessageKey(entry.text, entry.attachmentCount);
          steerFallbackCounts.set(key, (steerFallbackCounts.get(key) || 0) + 1);
        }
      }

      return prev.map((message) => {
        if (message.role !== 'user') {
          return message;
        }

        const signature = getQueuedSignatureFromPiMessage(message.piMessage);
        if (takeQueueMatch(followSignatureCounts, signature)) {
          return { ...message, status: 'queued_follow_up', queueKind: 'follow_up' };
        }

        if (takeQueueMatch(steerSignatureCounts, signature)) {
          return { ...message, status: 'queued_steering', queueKind: 'steer' };
        }

        const canUseFallbackMatch = message.status === 'queued_follow_up' || message.status === 'queued_steering' || Boolean(message.queueKind);
        if (canUseFallbackMatch) {
          const key = buildQueuedMessageKey(message.content, countPiMessageImageAttachments(message.piMessage));
          if (takeQueueMatch(followFallbackCounts, key)) {
            return { ...message, status: 'queued_follow_up', queueKind: 'follow_up' };
          }
          if (takeQueueMatch(steerFallbackCounts, key)) {
            return { ...message, status: 'queued_steering', queueKind: 'steer' };
          }
        }

        if (message.status === 'queued_follow_up' || message.status === 'queued_steering' || message.status === 'pending' || message.status === 'aborting') {
          return { ...message, status: 'sent', queueKind: undefined };
        }

        return message;
      });
    });
  }, [setMessages]);

  const applyRuntimeStatusToHistory = useCallback((status: RuntimeStatus) => {
    const runtimePhase = getHistoryRuntimePhase(status);
    const runtimeActiveToolName = getHistoryRuntimeActiveToolName(status);

    setHistory((prev) => {
      let changed = false;
      const next = prev.map((session) => {
        if (session.sessionId !== status.sessionId) {
          return session;
        }

        if (
          session.runtimePhase === runtimePhase &&
          session.runtimeActiveToolName === runtimeActiveToolName
        ) {
          return session;
        }

        changed = true;
        return {
          ...session,
          runtimePhase,
          runtimeActiveToolName,
        };
      });

      if (changed) {
        historyRef.current = next;
        return next;
      }

      return prev;
    });
  }, [historyRef, setHistory]);

  const setRuntimeStatusWithReconciliation = useCallback((status: RuntimeStatus) => {
    setRuntimeStatus(status);
    applyRuntimeStatusToHistory(status);
    reconcileQueuedMessages(status);
  }, [applyRuntimeStatusToHistory, reconcileQueuedMessages]);

  const setOptimisticRuntimePhase = useCallback((phase: RuntimeStatus['phase'], sessionIdOverride?: string | null) => {
    setRuntimeStatus((current) => {
      const sessionId = sessionIdOverride || current?.sessionId || sessionIdRef.current || 'pending-session';
      const baseStatus: RuntimeStatus = current || {
        sessionId,
        phase: 'idle',
        activeTool: null,
        pendingToolCalls: 0,
        followUpQueue: [],
        steeringQueue: [],
        canAbort: false,
        contextWindow: 0,
        estimatedHistoryTokens: 0,
        availableHistoryTokens: 0,
        contextUsagePercent: 0,
        includedSummary: false,
        omittedMessageCount: 0,
        summaryUpdatedAt: null,
        lastCompactionAt: null,
        lastCompactionKind: null,
        lastCompactionOmittedCount: 0,
      };

      const nextStatus: RuntimeStatus = {
        ...baseStatus,
        sessionId,
        phase,
        activeTool: phase === 'running_tool' ? baseStatus.activeTool : null,
        pendingToolCalls: phase === 'idle' ? 0 : baseStatus.pendingToolCalls,
        canAbort: phase !== 'idle',
      };

      runtimeStatusRef.current = nextStatus;
      return nextStatus;
    });
  }, [sessionIdRef]);

  const appendSystemMessage = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-system`,
        role: 'system',
        content,
        status: 'error',
        type: 'system',
      },
    ]);
  }, [setMessages]);

  const appendCompactionBreak = useCallback((kind: 'manual' | 'automatic', timestamp: string, omittedMessageCount: number) => {
    if (lastCompactionMarkerRef.current === timestamp) {
      return;
    }

    lastCompactionMarkerRef.current = timestamp;
    setMessages((prev) => [
      ...prev,
      {
        id: `compact-${timestamp}`,
        role: 'system',
        content: kind === 'manual' ? t('compactManual') : t('compactAutomatic'),
        type: 'compact_break',
        status: 'sent',
        compactMeta: {
          kind,
          timestamp,
          omittedMessageCount,
        },
      },
    ]);
  }, [setMessages, t]);

  const toggleToolMessage = useCallback((messageId: string) => {
    setMessages((prev) =>
      prev.map((message) => (
        message.id === messageId && message.role === 'toolResult'
          ? { ...message, isCollapsed: !message.isCollapsed, autoCollapsedAtEnd: false }
          : message
      )),
    );
  }, [setMessages]);

  const upsertToolMessage = useCallback((params: {
    assistantMessageId?: string | null;
    content?: string;
    status?: ChatMessage['status'];
    toolCallId?: string;
    toolName?: string;
    toolArgs?: string;
    piMessage?: AgentMessage;
    type?: ChatMessage['type'];
    attachments?: Attachment[];
  }) => {
    const { assistantMessageId, toolCallId, toolName, toolArgs, content, status, piMessage, type, attachments } = params;
    const knownMessageId = toolCallId ? toolMessageIdsRef.current[toolCallId] : undefined;
    const messageId = knownMessageId || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (toolCallId && !knownMessageId) {
      toolMessageIdsRef.current[toolCallId] = messageId;
    }

    setMessages((prev) => {
      const index = prev.findIndex((message) => message.id === messageId);
      const assistantIndex = assistantMessageId ? prev.findIndex((message) => message.id === assistantMessageId) : -1;
      const nextMessage: ChatMessage = {
        id: messageId,
        role: 'toolResult',
        content: content || '',
        status: status || 'sent',
        toolCallId,
        toolName,
        toolArgs,
        piMessage,
        attachments,
        type: type || 'tool_result',
        isCollapsed: status === 'sent',
        autoCollapsedAtEnd: status === 'sent',
        previewText: truncatePreview(content || ''),
      };

      if (index === -1) {
        if (assistantIndex === -1) {
          return [...prev, nextMessage];
        }

        const nextMessages = [...prev];
        nextMessages.splice(assistantIndex, 0, nextMessage);
        return nextMessages;
      }

      const mergedMessage: ChatMessage = {
        ...prev[index],
        ...nextMessage,
        content: content ?? prev[index].content,
        toolArgs: toolArgs ?? prev[index].toolArgs,
        toolName: toolName ?? prev[index].toolName,
        piMessage: piMessage ?? prev[index].piMessage,
        attachments: attachments ?? prev[index].attachments,
        type: type || prev[index].type,
        isCollapsed: status === 'sent' ? true : (status === 'sending' ? false : prev[index].isCollapsed),
        autoCollapsedAtEnd: status === 'sent' ? true : prev[index].autoCollapsedAtEnd,
        previewText: truncatePreview(content ?? prev[index].content),
      };

      const nextMessages = [...prev];
      nextMessages[index] = mergedMessage;
      return nextMessages;
    });
  }, [setMessages]);

  const syncPiMessage = useCallback((id: string, piMessage: AgentMessage) => {
    setMessages((prev) =>
      prev.map((message) => {
        if (message.id !== id) return message;
        const nextContent = extractPiMessageText(piMessage);
        const isAssistantAbort = isAbortedAssistantPiMessage(piMessage);
        const isAssistantError = piMessage.role === 'assistant' && piMessage.stopReason === 'error';
        return {
          ...message,
          content: nextContent || (isAssistantAbort ? t('runStopped') : message.content),
          status: isAssistantError ? 'error' : 'sent',
          type: isAssistantError ? 'system' : message.type,
          piMessage,
        };
      }),
    );
  }, [setMessages, t]);

  const findExistingMessageByPiMessage = useCallback((message?: AgentMessage): string | null => {
    if (!message) return null;

    const piTimestamp = (message as { timestamp?: number }).timestamp;
    if (!piTimestamp) return null;

    const existingId = messagesRef.current.find(
      (m: ChatMessage) => m.role === 'assistant' && m.piMessage && (m.piMessage as { timestamp?: number }).timestamp === piTimestamp,
    )?.id;

    return existingId || null;
  }, []);

  const createAssistantBubble = useCallback((message?: AgentMessage) => {
    const existingId = findExistingMessageByPiMessage(message);
    if (existingId) {
      currentAssistantIdRef.current = existingId;
      return existingId;
    }

    const activeAssistantId = currentAssistantIdRef.current;
    if (activeAssistantId) {
      setMessages((prev) => prev.map((chatMessage) => {
        if (chatMessage.id !== activeAssistantId || chatMessage.role !== 'assistant') {
          return chatMessage;
        }

        const nextContent = extractPiMessageText(message);
        return {
          ...chatMessage,
          content: nextContent || chatMessage.content,
          status: 'sending',
          piMessage: message || chatMessage.piMessage,
        };
      }));
      return activeAssistantId;
    }

    const assistantId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    currentAssistantIdRef.current = assistantId;
    setMessages((prev) => [
      ...prev,
      {
        id: assistantId,
        role: 'assistant',
        content: extractPiMessageText(message),
        status: 'sending',
        piMessage: message,
      },
    ]);
    return assistantId;
  }, [findExistingMessageByPiMessage, setMessages]);

  const upsertUserMessageFromPiMessage = useCallback((piMessage: Extract<AgentMessage, { role: 'user' }>) => {
    const timestamp = getAgentMessageTimestamp(piMessage);
    const signature = getQueuedSignatureFromPiMessage(piMessage);
    const content = extractPiMessageText(piMessage, { hideAttachmentMetadata: true });
    const rawContent = getPiMessageContent(piMessage);
    const messageAttachments = extractMessageAttachments(rawContent);
    const visibleMessageKey = getVisibleUserMessageKey(piMessage, content);

    setMessages((prev) => {
      let existingIndex = prev.findIndex((message) => {
        if (message.role !== 'user') {
          return false;
        }

        const existingTimestamp = getAgentMessageTimestamp(message.piMessage);
        if (timestamp !== null && existingTimestamp === timestamp) {
          return true;
        }

        return Boolean(signature && getQueuedSignatureFromPiMessage(message.piMessage) === signature);
      });

      if (existingIndex === -1) {
        const activeAssistantId = currentAssistantIdRef.current;
        for (let index = prev.length - 1; index >= 0; index -= 1) {
          const message = prev[index];
          if (message.role !== 'user' || !message.optimistic) {
            continue;
          }

          const existingKey = getVisibleUserMessageKey(message.piMessage, message.content);
          if (existingKey !== visibleMessageKey) {
            continue;
          }

          const existingTimestamp = getAgentMessageTimestamp(message.piMessage);
          const timestampsAreClose =
            timestamp !== null &&
            existingTimestamp !== null &&
            Math.abs(timestamp - existingTimestamp) < 15000;
          const pendingLocalTurn =
            message.status === 'pending' ||
            message.status === 'queued_steering' ||
            message.status === 'aborting';
          const activeAssistantAfterMessage =
            timestamp === null &&
            Boolean(activeAssistantId && prev.slice(index + 1).some((candidate) => candidate.id === activeAssistantId));

          if (timestampsAreClose || pendingLocalTurn || activeAssistantAfterMessage) {
            existingIndex = index;
            break;
          }
        }
      }

      if (existingIndex !== -1) {
        const nextMessages = [...prev];
        const existingMessage = nextMessages[existingIndex];
        nextMessages[existingIndex] = {
          ...existingMessage,
          content: content || existingMessage.content,
          status: 'sent',
          attachments: messageAttachments || existingMessage.attachments,
          piMessage,
          queueKind: undefined,
          optimistic: false,
        };
        return nextMessages;
      }

      return [
        ...prev,
        {
          id: `user-${timestamp ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          content,
          status: 'sent',
          attachments: messageAttachments,
          piMessage,
          optimistic: false,
        },
      ];
    });

    if (isAtBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom('auto'));
    }
  }, [isAtBottomRef, scrollToBottom, setMessages]);

  const appendOptimisticUserMessage = useCallback((
    text: string,
    messageAttachments: Attachment[],
    status: ChatMessage['status'],
    queueKind?: ChatMessage['queueKind'],
    piMessage?: Extract<AgentMessage, { role: 'user' }>,
  ) => {
    const id = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setMessages((prev) => [
      ...prev,
      {
        id,
        role: 'user',
        content: text,
        status,
        attachments: messageAttachments,
        piMessage,
        queueKind,
        optimistic: true,
      },
    ]);
    return id;
  }, [setMessages]);

  const hydrateRuntimeMessageRefs = useCallback((nextMessages: ChatMessage[]) => {
    const nextToolMessageIds: Record<string, string> = {};
    let nextAssistantId: string | null = null;
    let nextCompactionMarker: string | null = null;

    for (const message of nextMessages) {
      if (message.toolCallId) {
        nextToolMessageIds[message.toolCallId] = message.id;
      }
      if (message.role === 'assistant' && message.status === 'sending') {
        nextAssistantId = message.id;
      }
      if (message.compactMeta?.timestamp) {
        nextCompactionMarker = message.compactMeta.timestamp;
      }
    }

    toolMessageIdsRef.current = nextToolMessageIds;
    currentAssistantIdRef.current = nextAssistantId;
    lastCompactionMarkerRef.current = nextCompactionMarker;
    messagesRef.current = nextMessages;
  }, []);

  const handleStreamEvent = useCallback((event: ChatEvent) => {
    if (event.type === 'runtime_status' && event.status) {
      setRuntimeStatusWithReconciliation(event.status);
      return;
    }

    if (event.type === 'context_compacted' && event.timestamp && event.kind) {
      appendCompactionBreak(event.kind, event.timestamp, event.omittedMessageCount || 0);
      return;
    }

    if (event.type === 'message_saved') {
      const currentSessionId = sessionIdRef.current;
      if (!currentSessionId) return;
      requestSavedMessageRefresh(currentSessionId);
      return;
    }

    if (event.type === 'message_start' && event.message?.role === 'user') {
      upsertUserMessageFromPiMessage(event.message);
      return;
    }

    if (event.type === 'message_start' && event.message?.role === 'assistant') {
      streamingContentRef.current = '';
      lastFlushedStreamingContentRef.current = '';
      thinkingFilterRef.current = createThinkingFilterState();
      thinkingContentRef.current = '';
      createAssistantBubble(event.message);
      return;
    }

    if (event.type === 'agent_end') {
      if (streamingRafRef.current !== null) {
        cancelAnimationFrame(streamingRafRef.current);
        streamingRafRef.current = null;
      }
      streamingContentRef.current = '';
      lastFlushedStreamingContentRef.current = '';
      thinkingFilterRef.current = createThinkingFilterState();
      thinkingContentRef.current = '';

      if (event.messages?.length) {
        for (const finalMessage of event.messages) {
          if (finalMessage.role === 'user') {
            upsertUserMessageFromPiMessage(finalMessage);
            continue;
          }

          if (finalMessage.role === 'assistant') {
            const assistantId = currentAssistantIdRef.current || createAssistantBubble(finalMessage);
            syncPiMessage(assistantId, finalMessage);
            currentAssistantIdRef.current = null;
            continue;
          }

          if (finalMessage.role === 'toolResult') {
            const rawContent = getPiMessageContent(finalMessage);
            const text = extractToolResultText(Array.isArray(rawContent) ? rawContent : undefined) || extractPiMessageText(finalMessage);
            const toolCallId = 'toolCallId' in finalMessage && typeof finalMessage.toolCallId === 'string'
              ? finalMessage.toolCallId
              : undefined;
            const toolName = 'toolName' in finalMessage && typeof finalMessage.toolName === 'string'
              ? finalMessage.toolName
              : undefined;
            const resultAttachments = dedupeAttachments([
              ...extractImageAttachments(rawContent),
              ...extractToolResultImageAttachments(finalMessage),
            ]);

            upsertToolMessage({
              toolCallId,
              toolName,
              content: text,
              status: 'sent',
              type: 'tool_result',
              piMessage: finalMessage,
              attachments: resultAttachments.length > 0 ? resultAttachments : undefined,
            });
          }
        }
      }

      setMessages((prev) => prev.map((message) => (
        message.optimistic ? { ...message, optimistic: false } : message
      )));
      return;
    }

    if (event.type === 'message_update') {
      const assistantId = currentAssistantIdRef.current || createAssistantBubble(event.message);
      const eventType = event.assistantMessageEvent?.type;

      if (eventType === 'thinking_start' || eventType === 'thinking_delta') {
        const delta = event.assistantMessageEvent?.delta || '';
        if (delta) {
          thinkingContentRef.current += delta;
        }
        return;
      }

      if (eventType === 'thinking_end') {
        const content = event.assistantMessageEvent?.content;
        if (typeof content === 'string' && content) {
          thinkingContentRef.current += content;
        }
        return;
      }

      if (eventType === 'text_delta') {
        const rawDelta = event.assistantMessageEvent?.delta || '';
        const filtered = filterThinkingChunk(rawDelta, thinkingFilterRef.current);
        thinkingFilterRef.current = filtered.state;
        if (filtered.thinking) {
          thinkingContentRef.current += filtered.thinking;
        }
        const displayDelta = filtered.text;
        if (displayDelta) {
          streamingContentRef.current += displayDelta;
        }
        if (streamingRafRef.current === null) {
          const flush = () => {
            const content = normalizeMessageStart(streamingContentRef.current);
            if (content !== lastFlushedStreamingContentRef.current) {
              lastFlushedStreamingContentRef.current = content;
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantId
                    ? { ...msg, content, status: 'sending' as const }
                    : msg,
                ),
              );
              if (isAtBottomRef.current) {
                scrollToBottom('auto');
              }
            }
            streamingRafRef.current = requestAnimationFrame(flush);
          };
          streamingRafRef.current = requestAnimationFrame(flush);
        }
      }
      return;
    }

    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      if (streamingRafRef.current !== null) {
        cancelAnimationFrame(streamingRafRef.current);
        streamingRafRef.current = null;
      }

      const flushed = flushThinkingFilter(thinkingFilterRef.current);
      if (flushed.text) {
        streamingContentRef.current += flushed.text;
      }
      if (flushed.thinking) {
        thinkingContentRef.current += flushed.thinking;
      }
      thinkingFilterRef.current = createThinkingFilterState();

      streamingContentRef.current = '';
      lastFlushedStreamingContentRef.current = '';
      const assistantId = currentAssistantIdRef.current || createAssistantBubble(event.message);
      syncPiMessage(assistantId, event.message);
      currentAssistantIdRef.current = null;

      return;
    }

    if (event.type === 'tool_execution_start') {
      upsertToolMessage({
        assistantMessageId: currentAssistantIdRef.current,
        toolCallId: event.toolCallId,
        toolName: event.toolName || t('tool'),
        toolArgs: formatToolArgs(event.args),
        status: 'sending',
        type: 'tool_use',
      });
      return;
    }

    if (event.type === 'tool_execution_update') {
      upsertToolMessage({
        assistantMessageId: currentAssistantIdRef.current,
        toolCallId: event.toolCallId,
        toolName: event.toolName || t('tool'),
        content: extractToolResultText(event.partialResult?.content),
        status: 'sending',
        type: 'tool_use',
      });
      return;
    }

    if (event.type === 'tool_execution_end') {
      const text = extractToolResultText(event.result?.content);
      const resultDetails = event.result?.details;
      const toolResultPiMessage = {
        role: 'toolResult',
        toolCallId: event.toolCallId,
        toolName: event.toolName || t('tool'),
        content: text ? [{ type: 'text', text }] : [],
        details: resultDetails,
        isError: false,
        timestamp: Date.now(),
      } as AgentMessage;
      const resultAttachments = dedupeAttachments([
        ...extractImageAttachments(event.result?.content),
        ...extractToolResultImageAttachments(toolResultPiMessage),
      ]);
      upsertToolMessage({
        assistantMessageId: currentAssistantIdRef.current,
        toolCallId: event.toolCallId,
        toolName: event.toolName || t('tool'),
        content: text,
        status: 'sent',
        type: 'tool_result',
        piMessage: toolResultPiMessage,
        attachments: resultAttachments.length > 0 ? resultAttachments : undefined,
      });
      return;
    }

    if (event.type === 'tool_result') {
      const { toolCallId, text } = event;
      upsertToolMessage({
        toolCallId,
        status: 'sent',
        type: 'tool_result',
        piMessage: {
          role: 'toolResult',
          content: text ? [{ type: 'text', text }] : [],
          timestamp: Date.now(),
        } as AgentMessage,
      });
      return;
    }

    if (event.type === 'error') {
      appendSystemMessage(t('errorMessage', { message: event.error || t('unknownError') }));
    }
  }, [
    appendCompactionBreak,
    appendSystemMessage,
    createAssistantBubble,
    isAtBottomRef,
    requestSavedMessageRefresh,
    scrollToBottom,
    sessionIdRef,
    setMessages,
    setRuntimeStatusWithReconciliation,
    syncPiMessage,
    t,
    upsertToolMessage,
    upsertUserMessageFromPiMessage,
  ]);

  useEffect(() => {
    const handleAgentEvent = (event: CustomEvent<{ sessionId: string; event: ChatEvent }>) => {
      const { sessionId: eventSessionId, event: agentEvent } = event.detail;

      if (eventSessionId !== sessionIdRef.current) return;

      handleStreamEvent(agentEvent);
    };

    window.addEventListener('agent_event', handleAgentEvent as EventListener);
    return () => {
      window.removeEventListener('agent_event', handleAgentEvent as EventListener);
    };
  }, [handleStreamEvent, sessionIdRef]);

  return {
    appendCompactionBreak,
    appendOptimisticUserMessage,
    appendSystemMessage,
    clearCurrentAssistant,
    createAssistantBubble,
    hasLiveMessagesInProgress,
    hydrateRuntimeMessageRefs,
    messagesRef,
    requestSavedMessageRefresh,
    resetRuntimeMessageRefs,
    resetStreamConnection,
    runtimeStatus,
    runtimeStatusRef,
    setLastCompactionMarker,
    setOptimisticRuntimePhase,
    setRuntimeStatus,
    setRuntimeStatusWithReconciliation,
    toggleToolMessage,
  };
}
