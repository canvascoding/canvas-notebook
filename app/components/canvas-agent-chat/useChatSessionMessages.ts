'use client';

import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { useTranslations } from 'next-intl';
import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
import { areChatMessageListsEquivalent } from '@/app/lib/chat/message-equivalence';
import {
  buildCachedChatSessionEntry,
  isCacheableMessageSet,
  persistChatSessionCache,
  readCachedChatSession,
  readLatestCachedChatSession,
  rememberChatSessionCacheEntry,
} from '@/app/lib/chat/session-cache';
import { fetchChatSessionMessages, patchChatSessions } from '@/app/lib/chat/session-api';
import { loadComposerDraft } from '@/app/lib/chat/draft-storage';
import { saveLastActiveAgentId } from '@/app/lib/chat/agent-preferences';
import type {
  AgentConfig,
  AISession,
  ChatMessage,
} from '@/app/lib/chat/types';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_THINKING_LEVEL,
} from '@/app/components/canvas-agent-chat/useChatAgentConfig';
import { mapPersistedChatMessages } from '@/app/components/canvas-agent-chat/chatMessageMapping';

type ChatTranslator = ReturnType<typeof useTranslations<'chat'>>;

type WebSocketRequest = <T extends Record<string, unknown> = Record<string, unknown>>(
  type: string,
  payload: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<T>;

type UseChatSessionMessagesParams = {
  activeModel: string;
  activeProvider: string;
  activeThinkingLevel: PiThinkingLevel | null;
  agentConfig: AgentConfig | null;
  deferredSavedMessageRefreshSessionRef: MutableRefObject<string | null>;
  ensureSessionSubscribed: (targetSessionId: string) => Promise<void>;
  hasLiveMessagesInProgress: () => boolean;
  hasMoreBefore: boolean;
  historyRef: MutableRefObject<AISession[]>;
  hydrateRuntimeMessageRefs: (messages: ChatMessage[]) => void;
  isAtBottomRef: MutableRefObject<boolean>;
  isLoadingOlder: boolean;
  isMobile: boolean;
  messages: ChatMessage[];
  messagesRef: MutableRefObject<ChatMessage[]>;
  oldestMessageId: number | null;
  oldestSequence: number | null;
  oldestTimestamp: number | null;
  refreshSavedMessagesRef: MutableRefObject<((sessionId: string) => void) | null>;
  resetRuntimeMessageRefs: () => void;
  resetStreamConnection: () => void;
  resolveSessionTitle: (targetSessionId: string, title: string | null | undefined) => string | null;
  runtimeStatus: RuntimeStatus | null;
  scrollContainerRef: { current: HTMLDivElement | null };
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  selectedAgentId: string;
  sessionAgentIdRef: MutableRefObject<string>;
  sessionId: string | null;
  sessionIdRef: MutableRefObject<string | null>;
  sessionTitle: string | null;
  setActiveModel: Dispatch<SetStateAction<string>>;
  setActiveProvider: Dispatch<SetStateAction<string>>;
  setActiveThinkingLevel: Dispatch<SetStateAction<PiThinkingLevel>>;
  setExpandedRunKeys: Dispatch<SetStateAction<Set<string>>>;
  setHasMoreBefore: Dispatch<SetStateAction<boolean>>;
  setHasUnreadInCurrentSession: Dispatch<SetStateAction<boolean>>;
  setHistory: Dispatch<SetStateAction<AISession[]>>;
  setInput: Dispatch<SetStateAction<string>>;
  setIsLoadingOlder: Dispatch<SetStateAction<boolean>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setOldestMessageId: Dispatch<SetStateAction<number | null>>;
  setOldestSequence: Dispatch<SetStateAction<number | null>>;
  setOldestTimestamp: Dispatch<SetStateAction<number | null>>;
  setRuntimeStatus: Dispatch<SetStateAction<RuntimeStatus | null>>;
  setRuntimeStatusWithReconciliation: (status: RuntimeStatus) => void;
  setLastCompactionMarker: (timestamp: string | null | undefined) => void;
  setSelectedAgentId: Dispatch<SetStateAction<string>>;
  setSessionId: Dispatch<SetStateAction<string | null>>;
  setSessionTitle: Dispatch<SetStateAction<string | null>>;
  setShowHistory: Dispatch<SetStateAction<boolean>>;
  setShowMobileDetails: Dispatch<SetStateAction<boolean>>;
  setShowUnreadBanner: Dispatch<SetStateAction<boolean>>;
  setTotalUnreadCount: Dispatch<SetStateAction<number>>;
  shouldShowHistoryAsOverlay: boolean;
  t: ChatTranslator;
  userStartedNewChatRef: MutableRefObject<boolean>;
  wsRequest: WebSocketRequest;
};

export function useChatSessionMessages({
  activeModel,
  activeProvider,
  activeThinkingLevel,
  agentConfig,
  deferredSavedMessageRefreshSessionRef,
  ensureSessionSubscribed,
  hasLiveMessagesInProgress,
  hasMoreBefore,
  historyRef,
  hydrateRuntimeMessageRefs,
  isAtBottomRef,
  isLoadingOlder,
  isMobile,
  messages,
  messagesRef,
  oldestMessageId,
  oldestSequence,
  oldestTimestamp,
  refreshSavedMessagesRef,
  resetRuntimeMessageRefs,
  resetStreamConnection,
  resolveSessionTitle,
  runtimeStatus,
  scrollContainerRef,
  scrollToBottom,
  selectedAgentId,
  sessionAgentIdRef,
  sessionId,
  sessionIdRef,
  sessionTitle,
  setActiveModel,
  setActiveProvider,
  setActiveThinkingLevel,
  setExpandedRunKeys,
  setHasMoreBefore,
  setHasUnreadInCurrentSession,
  setHistory,
  setInput,
  setIsLoadingOlder,
  setMessages,
  setOldestMessageId,
  setOldestSequence,
  setOldestTimestamp,
  setRuntimeStatus,
  setRuntimeStatusWithReconciliation,
  setLastCompactionMarker,
  setSelectedAgentId,
  setSessionId,
  setSessionTitle,
  setShowHistory,
  setShowMobileDetails,
  setShowUnreadBanner,
  setTotalUnreadCount,
  shouldShowHistoryAsOverlay,
  t,
  userStartedNewChatRef,
  wsRequest,
}: UseChatSessionMessagesParams) {
  const loadSessionRequestIdRef = useRef(0);
  const loadSessionAbortRef = useRef<AbortController | null>(null);
  const cachePersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mapRawMessages = useCallback((rawMessages: Parameters<typeof mapPersistedChatMessages>[0]): ChatMessage[] => {
    return mapPersistedChatMessages(rawMessages, t('runStopped'));
  }, [t]);

  useEffect(() => {
    return () => {
      loadSessionAbortRef.current?.abort();
      if (cachePersistTimerRef.current) {
        clearTimeout(cachePersistTimerRef.current);
        cachePersistTimerRef.current = null;
      }
      persistChatSessionCache();
    };
  }, []);

  useEffect(() => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId || currentSessionId !== sessionId || !isCacheableMessageSet(messages)) {
      return;
    }

    const sessionAgentId = sessionAgentIdRef.current || selectedAgentId;
    const historySession = historyRef.current.find((candidate) => candidate.sessionId === currentSessionId);
    const sessionForCache: AISession = {
      id: historySession?.id ?? Date.now(),
      sessionId: currentSessionId,
      title: sessionTitle,
      agentId: sessionAgentId,
      model: activeModel || historySession?.model || DEFAULT_MODEL_ID,
      provider: activeProvider || historySession?.provider || null,
      thinkingLevel: activeThinkingLevel || historySession?.thinkingLevel || null,
      createdAt: historySession?.createdAt ?? new Date().toISOString(),
      engine: historySession?.engine ?? 'pi',
      lastMessageAt: historySession?.lastMessageAt ?? new Date().toISOString(),
      lastViewedAt: historySession?.lastViewedAt ?? null,
      hasUnread: false,
      creator: historySession?.creator,
    };

    const entry = buildCachedChatSessionEntry({
      session: sessionForCache,
      messages,
      hasMoreBefore,
      oldestTimestamp,
      oldestMessageId,
      oldestSequence,
    });

    rememberChatSessionCacheEntry(entry);

    if (cachePersistTimerRef.current) {
      clearTimeout(cachePersistTimerRef.current);
    }
    cachePersistTimerRef.current = setTimeout(() => {
      cachePersistTimerRef.current = null;
      persistChatSessionCache();
    }, 300);
  }, [activeModel, activeProvider, activeThinkingLevel, hasMoreBefore, historyRef, messages, oldestMessageId, oldestSequence, oldestTimestamp, selectedAgentId, sessionAgentIdRef, sessionId, sessionIdRef, sessionTitle]);

  useEffect(() => {
    const targetSessionId = deferredSavedMessageRefreshSessionRef.current;
    if (!targetSessionId) {
      return;
    }

    if (targetSessionId !== sessionId) {
      deferredSavedMessageRefreshSessionRef.current = null;
      return;
    }

    const refreshSavedMessages = refreshSavedMessagesRef.current;
    if (!refreshSavedMessages || hasLiveMessagesInProgress()) {
      return;
    }

    deferredSavedMessageRefreshSessionRef.current = null;
    refreshSavedMessages(targetSessionId);
  }, [deferredSavedMessageRefreshSessionRef, hasLiveMessagesInProgress, messages, refreshSavedMessagesRef, runtimeStatus?.phase, sessionId]);

  const refreshSavedMessages = useCallback((targetSessionId: string) => {
    const requestAgentId = sessionAgentIdRef.current || selectedAgentId;

    void (async () => {
      try {
        const payload = await fetchChatSessionMessages({
          agentId: requestAgentId,
          sessionId: targetSessionId,
          limit: 50,
          cache: 'no-store',
          credentials: 'include',
        });

        if (
          sessionIdRef.current !== targetSessionId ||
          !payload?.success ||
          !Array.isArray(payload.messages)
        ) {
          return;
        }

        const nextMessages = mapRawMessages(payload.messages);
        if (!areChatMessageListsEquivalent(messagesRef.current, nextMessages)) {
          setMessages(nextMessages);
          hydrateRuntimeMessageRefs(nextMessages);
        }
        setHasMoreBefore(typeof payload.hasMoreBefore === 'boolean' ? payload.hasMoreBefore : payload.messages.length >= 50);
        setOldestTimestamp(payload.oldestTimestamp ?? null);
        setOldestMessageId(payload.oldestMessageId ?? null);
        setOldestSequence(payload.oldestSequence ?? null);
        if (isAtBottomRef.current) {
          requestAnimationFrame(() => scrollToBottom('auto'));
        }
      } catch (error) {
        console.error('Failed to refresh messages after saved chat response', error);
      }
    })();
  }, [hydrateRuntimeMessageRefs, isAtBottomRef, mapRawMessages, messagesRef, scrollToBottom, selectedAgentId, sessionAgentIdRef, sessionIdRef, setHasMoreBefore, setMessages, setOldestMessageId, setOldestSequence, setOldestTimestamp]);

  useEffect(() => {
    refreshSavedMessagesRef.current = refreshSavedMessages;
    return () => {
      if (refreshSavedMessagesRef.current === refreshSavedMessages) {
        refreshSavedMessagesRef.current = null;
      }
    };
  }, [refreshSavedMessages, refreshSavedMessagesRef]);

  const loadSession = useCallback(async (session: AISession) => {
    const sessionAgentId = session.agentId || DEFAULT_AGENT_ID;
    const requestId = loadSessionRequestIdRef.current + 1;
    loadSessionRequestIdRef.current = requestId;
    loadSessionAbortRef.current?.abort();
    const abortController = new AbortController();
    loadSessionAbortRef.current = abortController;

    resetStreamConnection();
    setSelectedAgentId(sessionAgentId);
    void saveLastActiveAgentId(sessionAgentId);
    setSessionId(session.sessionId);
    setSessionTitle(resolveSessionTitle(session.sessionId, session.title));
    sessionIdRef.current = session.sessionId;
    sessionAgentIdRef.current = sessionAgentId;
    resetRuntimeMessageRefs();
    userStartedNewChatRef.current = false;
    const sessionDraft = loadComposerDraft(session.sessionId);
    setInput(sessionDraft ?? '');
    setShowMobileDetails(false);
    setActiveProvider(session.provider || agentConfig?.piConfig?.activeProvider || 'pi');
    setActiveModel(session.model || DEFAULT_MODEL_ID);
    setActiveThinkingLevel(
      session.thinkingLevel ||
      agentConfig?.piConfig?.providers?.[session.provider || agentConfig?.piConfig?.activeProvider || 'pi']?.thinking ||
      DEFAULT_THINKING_LEVEL,
    );
    setHasMoreBefore(false);
    setOldestTimestamp(null);
    setOldestMessageId(null);
    setOldestSequence(null);
    setIsLoadingOlder(false);
    setExpandedRunKeys(new Set());
    setRuntimeStatus(null);

    const cachedEntry = readCachedChatSession(sessionAgentId, session.sessionId) || readLatestCachedChatSession(session.sessionId);
    const hasCachedMessages = Boolean(cachedEntry && isCacheableMessageSet(cachedEntry.messages));

    if (cachedEntry && hasCachedMessages) {
      setMessages(cachedEntry.messages);
      hydrateRuntimeMessageRefs(cachedEntry.messages);
      setHasMoreBefore(cachedEntry.hasMoreBefore);
      setOldestTimestamp(cachedEntry.oldestTimestamp);
      setOldestMessageId(cachedEntry.oldestMessageId);
      setOldestSequence(cachedEntry.oldestSequence);
      requestAnimationFrame(() => {
        scrollToBottom('auto');
      });
    } else {
      hydrateRuntimeMessageRefs([]);
      setMessages([{ id: 'system', role: 'system', content: 'Loading...', status: 'pending', type: 'system' }]);
    }

    if (isMobile || shouldShowHistoryAsOverlay) {
      setShowHistory(false);
    }

    console.log(`[CanvasAgentChat] loadSession: sessionId=${session.sessionId}, hasUnread=${session.hasUnread}, lastMessageAt=${session.lastMessageAt}, lastViewedAt=${session.lastViewedAt}`);
    if (session.hasUnread) {
      setHasUnreadInCurrentSession(true);
      setShowUnreadBanner(true);
      setHistory((prev) => {
        const updated = prev.map((s) =>
          s.sessionId === session.sessionId ? { ...s, hasUnread: false, lastViewedAt: new Date().toISOString() } : s
        );
        setTotalUnreadCount(updated.filter((s) => s.hasUnread).length);
        return updated;
      });
      void patchChatSessions({ agentId: sessionAgentId, sessionId: session.sessionId, markAsRead: true })
        .then(() => {
          if (sessionIdRef.current !== session.sessionId) return;
          setHasUnreadInCurrentSession(false);
          setShowUnreadBanner(false);
        })
        .catch((err) => {
          console.error('Failed to mark session as read', err);
        });
    } else {
      setHasUnreadInCurrentSession(false);
      setShowUnreadBanner(false);
    }

    try {
      const statusPromise = ensureSessionSubscribed(session.sessionId).then(() => (
        wsRequest<{ success: boolean; status?: RuntimeStatus }>('get_status', {
          sessionId: session.sessionId,
        })
      )).catch((error) => {
        console.error('Failed to load runtime status', error);
        return null;
      });

      const messagesPayload = await fetchChatSessionMessages({
        agentId: sessionAgentId,
        sessionId: session.sessionId,
        limit: 50,
        signal: abortController.signal,
      });

      if (
        abortController.signal.aborted ||
        loadSessionRequestIdRef.current !== requestId ||
        sessionIdRef.current !== session.sessionId
      ) {
        return;
      }

      if (messagesPayload?.success && Array.isArray(messagesPayload.messages)) {
        const nextMessages = mapRawMessages(messagesPayload.messages);
        if (
          (nextMessages.length > 0 || !hasCachedMessages) &&
          (!hasCachedMessages || !cachedEntry || !areChatMessageListsEquivalent(cachedEntry.messages, nextMessages))
        ) {
          setMessages(nextMessages);
          hydrateRuntimeMessageRefs(nextMessages);
        }
        if (typeof messagesPayload.hasMoreBefore === 'boolean') {
          setHasMoreBefore(messagesPayload.hasMoreBefore);
        } else if (messagesPayload.messages.length >= 50) {
          setHasMoreBefore(true);
        } else {
          setHasMoreBefore(false);
        }
        if (messagesPayload.oldestTimestamp != null) {
          setOldestTimestamp(messagesPayload.oldestTimestamp);
        } else if (messagesPayload.messages.length > 0) {
          const firstRaw = messagesPayload.messages[0] as unknown as Record<string, unknown>;
          const ts = typeof firstRaw.timestamp === 'number' ? firstRaw.timestamp : null;
          if (ts != null) setOldestTimestamp(ts);
        }
        if (typeof messagesPayload.oldestMessageId === 'number') {
          setOldestMessageId(messagesPayload.oldestMessageId);
        } else if (messagesPayload.messages.length > 0) {
          const firstRaw = messagesPayload.messages[0] as unknown as Record<string, unknown>;
          const id = typeof firstRaw.id === 'number' ? firstRaw.id : null;
          if (id != null) setOldestMessageId(id);
        }
        if (typeof messagesPayload.oldestSequence === 'number') {
          setOldestSequence(messagesPayload.oldestSequence);
        } else if (messagesPayload.messages.length > 0) {
          const firstRaw = messagesPayload.messages[0] as unknown as Record<string, unknown>;
          const sequence = typeof firstRaw.sequence === 'number' ? firstRaw.sequence : null;
          if (sequence != null) setOldestSequence(sequence);
        }
      } else if (!hasCachedMessages) {
        setMessages([{ id: 'error', role: 'system', content: t('failedToLoadMessageHistory') }]);
      }

      if (isMobile || shouldShowHistoryAsOverlay) {
        setShowHistory(false);
      }

      requestAnimationFrame(() => {
        scrollToBottom('auto');
      });

      void statusPromise.then((statusPayload) => {
        if (
          abortController.signal.aborted ||
          loadSessionRequestIdRef.current !== requestId ||
          sessionIdRef.current !== session.sessionId
        ) {
          return;
        }

        if (statusPayload?.success && statusPayload.status) {
          setRuntimeStatusWithReconciliation(statusPayload.status as RuntimeStatus);
          setLastCompactionMarker((statusPayload.status as RuntimeStatus).lastCompactionAt);
        } else {
          setRuntimeStatus(null);
        }
      }).finally(() => {
        if (loadSessionAbortRef.current === abortController) {
          loadSessionAbortRef.current = null;
        }
      });
    } catch (err) {
      if (abortController.signal.aborted || loadSessionRequestIdRef.current !== requestId) {
        return;
      }
      console.error('Failed to load messages', err);
      if (!hasCachedMessages) {
        setMessages([{ id: 'error', role: 'system', content: t('failedToLoadMessageHistory') }]);
      }
    } finally {
      if (abortController.signal.aborted && loadSessionAbortRef.current === abortController) {
        loadSessionAbortRef.current = null;
      }
    }
  }, [agentConfig, ensureSessionSubscribed, hydrateRuntimeMessageRefs, isMobile, mapRawMessages, resetRuntimeMessageRefs, resetStreamConnection, resolveSessionTitle, scrollToBottom, sessionAgentIdRef, sessionIdRef, setActiveModel, setActiveProvider, setActiveThinkingLevel, setExpandedRunKeys, setHasMoreBefore, setHasUnreadInCurrentSession, setHistory, setInput, setIsLoadingOlder, setLastCompactionMarker, setMessages, setOldestMessageId, setOldestSequence, setOldestTimestamp, setRuntimeStatus, setRuntimeStatusWithReconciliation, setSelectedAgentId, setSessionId, setSessionTitle, setShowHistory, setShowMobileDetails, setShowUnreadBanner, setTotalUnreadCount, shouldShowHistoryAsOverlay, t, userStartedNewChatRef, wsRequest]);

  const loadOlderMessages = useCallback(async () => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId || isLoadingOlder || !hasMoreBefore || (oldestSequence === null && oldestTimestamp === null)) return;

    setIsLoadingOlder(true);
    const agentId = sessionAgentIdRef.current || selectedAgentId;

    const scrollContainer = scrollContainerRef.current;
    const previousScrollHeight = scrollContainer?.scrollHeight ?? 0;

    try {
      const payload = await fetchChatSessionMessages({
        agentId,
        sessionId: currentSessionId,
        limit: 50,
        beforeSequence: oldestSequence,
        before: oldestSequence === null ? oldestTimestamp : null,
        beforeId: oldestMessageId,
      });

      if (payload?.success && payload.messages) {
        const olderMessages: ChatMessage[] = mapRawMessages(payload.messages);

        if (olderMessages.length === 0) {
          setHasMoreBefore(false);
          return;
        }

        setMessages((prev) => [...olderMessages, ...prev]);
        setHasMoreBefore(payload.hasMoreBefore ?? (olderMessages.length >= 50));
        if (payload.oldestTimestamp != null) {
          setOldestTimestamp(payload.oldestTimestamp);
        }
        if (typeof payload.oldestMessageId === 'number') {
          setOldestMessageId(payload.oldestMessageId);
        }
        if (typeof payload.oldestSequence === 'number') {
          setOldestSequence(payload.oldestSequence);
        }

        requestAnimationFrame(() => {
          if (scrollContainer) {
            const newScrollHeight = scrollContainer.scrollHeight;
            scrollContainer.scrollTop = newScrollHeight - previousScrollHeight;
          }
        });
      }
    } catch (err) {
      console.error('[CanvasAgentChat] Failed to load older messages:', err);
    } finally {
      setIsLoadingOlder(false);
    }
  }, [hasMoreBefore, isLoadingOlder, mapRawMessages, oldestMessageId, oldestSequence, oldestTimestamp, scrollContainerRef, selectedAgentId, sessionAgentIdRef, sessionIdRef, setHasMoreBefore, setIsLoadingOlder, setMessages, setOldestMessageId, setOldestSequence, setOldestTimestamp]);

  return {
    loadOlderMessages,
    loadSession,
    refreshSavedMessages,
  };
}
