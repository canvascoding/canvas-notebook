'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { openedDocumentAuthScope, subscribeOpenedDocumentAuthInvalidation } from '@/app/lib/collaboration/opened-document-registry';
import { useTranslations } from 'next-intl';
import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
import { EMPTY_CHAT_PAGINATION, reconcileChatMessages, reconcileChatPagination, type ChatMessagePagination } from '@/app/lib/chat/chat-reconciliation';
import {
  buildCachedChatSessionEntry,
  isCacheableMessageSet,
  persistChatSessionCache,
  readCachedChatSession,
  readLatestCachedChatSession,
  rememberChatSessionCacheEntry,
} from '@/app/lib/chat/session-cache';
import { fetchChatSessionMessages, patchChatSessions, type ChatSessionMessagesPayload } from '@/app/lib/chat/session-api';
import { loadComposerDraft } from '@/app/lib/chat/draft-storage';
import { saveLastActiveAgentId } from '@/app/lib/chat/agent-preferences';
import type {
  AISession,
  ChatMessage,
} from '@/app/lib/chat/types';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
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
  activeWorkspaceId?: string | null;
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
  sessionWorkspaceIdRef: MutableRefObject<string | null>;
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
  skipNextSessionStatusRefreshRef: MutableRefObject<string | null>;
  t: ChatTranslator;
  userStartedNewChatRef: MutableRefObject<boolean>;
  wsRequest: WebSocketRequest;
};

export function useChatSessionMessages({
  activeModel,
  activeProvider,
  activeThinkingLevel,
  activeWorkspaceId,
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
  sessionWorkspaceIdRef,
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
  skipNextSessionStatusRefreshRef,
  t,
  userStartedNewChatRef,
  wsRequest,
}: UseChatSessionMessagesParams) {
  const loadSessionRequestIdRef = useRef(0);
  const loadSessionAbortRef = useRef<AbortController | null>(null);
  const loadingSessionIdRef = useRef<string | null>(null);
  const cacheWriterScopeRef = useRef(openedDocumentAuthScope());
  const cacheWriterRevokedRef = useRef(false);
  useLayoutEffect(() => subscribeOpenedDocumentAuthInvalidation(() => {
    cacheWriterRevokedRef.current = true;
  }), []);
  const cachePersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const activeWorkspaceRef = useRef(activeWorkspaceId ?? null);
  const paginationRef = useRef<ChatMessagePagination>(EMPTY_CHAT_PAGINATION);
  useLayoutEffect(() => {
    activeWorkspaceRef.current = activeWorkspaceId ?? null;
    paginationRef.current = { hasMoreBefore, oldestTimestamp, oldestMessageId, oldestSequence };
  }, [activeWorkspaceId, hasMoreBefore, oldestTimestamp, oldestMessageId, oldestSequence]);
  const olderRequestRef = useRef<AbortController | null>(null);
  const refreshRequestRef = useRef<{ controller: AbortController; queued: boolean } | null>(null);

  const applyPagination = useCallback((next: ChatMessagePagination) => {
    paginationRef.current = next;
    setHasMoreBefore(next.hasMoreBefore);
    setOldestTimestamp(next.oldestTimestamp);
    setOldestMessageId(next.oldestMessageId);
    setOldestSequence(next.oldestSequence);
  }, [setHasMoreBefore, setOldestMessageId, setOldestSequence, setOldestTimestamp]);

  const applyMessagePage = useCallback((payload: ChatSessionMessagesPayload, snapshot: ChatMessage[], isCurrent: () => boolean) => {
    if (!payload.success || !Array.isArray(payload.messages) || !isCurrent()) return;
    const incoming = mapPersistedChatMessages(payload.messages, t('runStopped'));
    setMessages((current) => {
      if (!isCurrent()) return current;
      const content = current.filter((message) => !(message.id === 'error' && message.type === 'system' && message.status === 'error'));
      const next = reconcileChatMessages(content.length === current.length ? current : content, incoming, snapshot);
      hydrateRuntimeMessageRefs(next);
      return next;
    });
    const first = payload.messages[0] as unknown as Record<string, unknown> | undefined;
    applyPagination(reconcileChatPagination(paginationRef.current, {
      hasMoreBefore: payload.hasMoreBefore ?? payload.messages.length >= 50,
      oldestTimestamp: payload.oldestTimestamp ?? (typeof first?.timestamp === 'number' ? first.timestamp : null),
      oldestMessageId: payload.oldestMessageId ?? (typeof first?.id === 'number' ? first.id : null),
      oldestSequence: payload.oldestSequence ?? (typeof first?.sequence === 'number' ? first.sequence : null),
    }));
  }, [applyPagination, hydrateRuntimeMessageRefs, setMessages, t]);

  const cancelSessionLoad = useCallback(() => {
    const cancelledSessionId = loadingSessionIdRef.current;
    loadSessionRequestIdRef.current += 1;
    loadSessionAbortRef.current?.abort();
    loadSessionAbortRef.current = null;
    loadingSessionIdRef.current = null;
    olderRequestRef.current?.abort();
    olderRequestRef.current = null;
    refreshRequestRef.current?.controller.abort();
    refreshRequestRef.current = null;
    setIsLoadingMessages(false);
    setIsLoadingOlder(false);
    if (cancelledSessionId && skipNextSessionStatusRefreshRef.current === cancelledSessionId) {
      skipNextSessionStatusRefreshRef.current = null;
    }
  }, [setIsLoadingOlder, skipNextSessionStatusRefreshRef]);


  useEffect(() => {
    return () => {
      cancelSessionLoad();
      if (cachePersistTimerRef.current) {
        clearTimeout(cachePersistTimerRef.current);
        cachePersistTimerRef.current = null;
      }
      persistChatSessionCache();
    };
  }, [cancelSessionLoad]);

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
      workspace: historySession?.workspace ?? null,
      creator: historySession?.creator,
    };

    // Bind the writer to the session's original auth epoch, not the time a delayed
    // React effect happens to run. A new explicit load may establish a new writer.
    if (!cacheWriterScopeRef.current && !cacheWriterRevokedRef.current) {
      cacheWriterScopeRef.current = openedDocumentAuthScope();
    }
    const entry = buildCachedChatSessionEntry({
      authScope: cacheWriterScopeRef.current,
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
    if (sessionIdRef.current !== targetSessionId) return;
    if (loadingSessionIdRef.current === targetSessionId) {
      deferredSavedMessageRefreshSessionRef.current = targetSessionId;
      return;
    }
    if (refreshRequestRef.current) {
      refreshRequestRef.current.queued = true;
      return;
    }
    const requestAgentId = sessionAgentIdRef.current || selectedAgentId;
    const workspaceId = activeWorkspaceRef.current;
    const generation = loadSessionRequestIdRef.current;
    const request = { controller: new AbortController(), queued: false };
    const snapshot = messagesRef.current;
    refreshRequestRef.current = request;
    const isCurrent = () => !request.controller.signal.aborted
      && generation === loadSessionRequestIdRef.current
      && activeWorkspaceRef.current === workspaceId
      && sessionIdRef.current === targetSessionId
      && sessionAgentIdRef.current === requestAgentId;

    void (async () => {
      try {
        const payload = await fetchChatSessionMessages({
          agentId: requestAgentId,
          sessionId: targetSessionId,
          limit: 50,
          workspaceId,
          signal: request.controller.signal,
          cache: 'no-store',
          credentials: 'include',
        });
        if (!isCurrent() || !payload?.success || !Array.isArray(payload.messages)) return;
        applyMessagePage(payload, snapshot, isCurrent);
        if (isAtBottomRef.current) {
          requestAnimationFrame(() => {
            if (isCurrent() && isAtBottomRef.current) scrollToBottom('auto');
          });
        }
      } catch (error) {
        if (isCurrent()) console.error('Failed to refresh messages after saved chat response', error);
      } finally {
        if (refreshRequestRef.current === request) {
          refreshRequestRef.current = null;
          if (request.queued && isCurrent()) refreshSavedMessagesRef.current?.(targetSessionId);
        }
      }
    })();
  }, [applyMessagePage, deferredSavedMessageRefreshSessionRef, isAtBottomRef, messagesRef, refreshSavedMessagesRef, scrollToBottom, selectedAgentId, sessionAgentIdRef, sessionIdRef]);

  useEffect(() => {
    refreshSavedMessagesRef.current = refreshSavedMessages;
    return () => {
      if (refreshSavedMessagesRef.current === refreshSavedMessages) {
        refreshSavedMessagesRef.current = null;
      }
    };
  }, [refreshSavedMessages, refreshSavedMessagesRef]);

  const loadSession = useCallback(async (session: AISession) => {
    if (loadingSessionIdRef.current === session.sessionId) {
      return;
    }

    cancelSessionLoad();
    cacheWriterScopeRef.current = openedDocumentAuthScope();
    cacheWriterRevokedRef.current = false;
    const sessionAgentId = session.agentId || DEFAULT_AGENT_ID;
    const requestId = loadSessionRequestIdRef.current;
    const workspaceId = activeWorkspaceRef.current;
    const abortController = new AbortController();
    loadSessionAbortRef.current = abortController;
    loadingSessionIdRef.current = session.sessionId;
    const isCurrent = () => !abortController.signal.aborted
      && loadSessionRequestIdRef.current === requestId
      && activeWorkspaceRef.current === workspaceId
      && sessionIdRef.current === session.sessionId
      && sessionAgentIdRef.current === sessionAgentId;

    resetStreamConnection();
    setSelectedAgentId(sessionAgentId);
    void saveLastActiveAgentId(sessionAgentId);
    skipNextSessionStatusRefreshRef.current = session.sessionId;
    setSessionId(session.sessionId);
    setSessionTitle(resolveSessionTitle(session.sessionId, session.title));
    sessionIdRef.current = session.sessionId;
    sessionWorkspaceIdRef.current = session.workspace?.workspaceId ?? activeWorkspaceId ?? null;
    sessionAgentIdRef.current = sessionAgentId;
    resetRuntimeMessageRefs();
    userStartedNewChatRef.current = false;
    const sessionDraft = loadComposerDraft(session.sessionId);
    setInput(sessionDraft ?? '');
    setShowMobileDetails(false);
    setActiveProvider(session.provider || DEFAULT_PROVIDER_ID);
    setActiveModel(session.model || DEFAULT_MODEL_ID);
    setActiveThinkingLevel(
      session.thinkingLevel || DEFAULT_THINKING_LEVEL,
    );
    applyPagination(EMPTY_CHAT_PAGINATION);
    setIsLoadingOlder(false);
    setExpandedRunKeys(new Set());
    setRuntimeStatus(null);

    const cachedCandidate = readCachedChatSession(sessionAgentId, session.sessionId) || readLatestCachedChatSession(session.sessionId);
    const cachedEntry = cachedCandidate && (!workspaceId || cachedCandidate.session.workspace?.workspaceId === workspaceId)
      ? cachedCandidate : null;
    const hasCachedMessages = Boolean(cachedEntry && isCacheableMessageSet(cachedEntry.messages));
    setIsLoadingMessages(!hasCachedMessages);

    if (cachedEntry && hasCachedMessages) {
      setMessages(cachedEntry.messages);
      hydrateRuntimeMessageRefs(cachedEntry.messages);
      applyPagination(cachedEntry);
      const initialScrollTop = scrollContainerRef.current?.scrollTop;
      requestAnimationFrame(() => {
        if (isCurrent() && scrollContainerRef.current?.scrollTop === initialScrollTop) scrollToBottom('auto');
      });
    } else {
      hydrateRuntimeMessageRefs([]);
      setMessages([]);
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
          if (!isCurrent()) return;
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

    const requestSnapshot = cachedEntry && hasCachedMessages ? cachedEntry.messages : [];
    const initialScrollTop = scrollContainerRef.current?.scrollTop;
    try {
      const statusPromise = ensureSessionSubscribed(session.sessionId).then(() => (
        isCurrent() ? wsRequest<{ success: boolean; status?: RuntimeStatus }>('get_status', {
          sessionId: session.sessionId,
        }) : null
      )).catch((error) => {
        console.error('Failed to load runtime status', error);
        return null;
      });

      void statusPromise.then((statusPayload) => {
        if (!isCurrent()) {
          return;
        }

        if (statusPayload?.success && statusPayload.status) {
          setRuntimeStatusWithReconciliation(statusPayload.status as RuntimeStatus);
          const status = statusPayload.status as RuntimeStatus;
          setLastCompactionMarker(status.compactionStatus?.attemptId || status.lastCompactionAt);
        } else {
          setRuntimeStatus(null);
        }
      });

      const messagesPayload = await fetchChatSessionMessages({
        agentId: sessionAgentId,
        sessionId: session.sessionId,
        limit: 50,
        workspaceId,
        signal: abortController.signal,
        ...(hasCachedMessages ? { cache: 'no-store' as const } : {}),
      });

      if (!isCurrent()) return;

      if (messagesPayload?.success && Array.isArray(messagesPayload.messages)) {
        // A shared read started before the warm snapshot may contain older live
        // content. Fresh reads can authoritatively update unchanged overlaps.
        const predatesCache = cachedEntry && hasCachedMessages
          && typeof messagesPayload.clientReadStartedAt === 'number'
          && messagesPayload.clientReadStartedAt < cachedEntry.cachedAt;
        applyMessagePage(messagesPayload, predatesCache ? [] : requestSnapshot, isCurrent);
      } else if (!hasCachedMessages) {
        setMessages((current) => !isCurrent() || current.length > 0 ? current : [
          { id: 'error', role: 'system', type: 'system', status: 'error', content: t('failedToLoadMessageHistory') },
        ]);
      }

      if (isMobile || shouldShowHistoryAsOverlay) {
        setShowHistory(false);
      }

      requestAnimationFrame(() => {
        if (!isCurrent()) return;
        if (isAtBottomRef.current || (!hasCachedMessages && scrollContainerRef.current?.scrollTop === initialScrollTop)) {
          scrollToBottom('auto');
        }
      });
    } catch (err) {
      if (!isCurrent()) {
        return;
      }
      console.error('Failed to load messages', err);
      if (!hasCachedMessages) {
        setMessages((current) => !isCurrent() || current.length > 0 ? current : [
          { id: 'error', role: 'system', type: 'system', status: 'error', content: t('failedToLoadMessageHistory') },
        ]);
      }
    } finally {
      if (isCurrent()) {
        setIsLoadingMessages(false);
        if (loadSessionAbortRef.current === abortController) {
          loadSessionAbortRef.current = null;
        }
        if (loadingSessionIdRef.current === session.sessionId) {
          loadingSessionIdRef.current = null;
        }
        if (deferredSavedMessageRefreshSessionRef.current === session.sessionId && !hasLiveMessagesInProgress()) {
          deferredSavedMessageRefreshSessionRef.current = null;
          refreshSavedMessagesRef.current?.(session.sessionId);
        }
      }
    }
  }, [activeWorkspaceId, applyMessagePage, applyPagination, cancelSessionLoad, deferredSavedMessageRefreshSessionRef, hasLiveMessagesInProgress, isAtBottomRef, refreshSavedMessagesRef, scrollContainerRef, ensureSessionSubscribed, hydrateRuntimeMessageRefs, isMobile, resetRuntimeMessageRefs, resetStreamConnection, resolveSessionTitle, scrollToBottom, sessionAgentIdRef, sessionIdRef, sessionWorkspaceIdRef, setActiveModel, setActiveProvider, setActiveThinkingLevel, setExpandedRunKeys, setHasUnreadInCurrentSession, setHistory, setInput, setIsLoadingOlder, setLastCompactionMarker, setMessages, setRuntimeStatus, setRuntimeStatusWithReconciliation, setSelectedAgentId, setSessionId, setSessionTitle, setShowHistory, setShowMobileDetails, setShowUnreadBanner, setTotalUnreadCount, shouldShowHistoryAsOverlay, skipNextSessionStatusRefreshRef, t, userStartedNewChatRef, wsRequest]);

  const loadOlderMessages = useCallback(async () => {
    const currentSessionId = sessionIdRef.current;
    const boundary = paginationRef.current;
    if (!currentSessionId || olderRequestRef.current || isLoadingOlder || !boundary.hasMoreBefore
      || (boundary.oldestSequence === null && boundary.oldestTimestamp === null)) return;

    const controller = new AbortController();
    olderRequestRef.current = controller;
    setIsLoadingOlder(true);
    const agentId = sessionAgentIdRef.current || selectedAgentId;
    const workspaceId = activeWorkspaceRef.current;
    const generation = loadSessionRequestIdRef.current;
    const snapshot = messagesRef.current;
    const isCurrent = () => !controller.signal.aborted
      && generation === loadSessionRequestIdRef.current
      && activeWorkspaceRef.current === workspaceId
      && sessionIdRef.current === currentSessionId
      && sessionAgentIdRef.current === agentId;
    const scrollContainer = scrollContainerRef.current;

    try {
      const payload = await fetchChatSessionMessages({
        agentId,
        sessionId: currentSessionId,
        limit: 50,
        workspaceId,
        signal: controller.signal,
        beforeSequence: boundary.oldestSequence,
        before: boundary.oldestSequence === null ? boundary.oldestTimestamp : null,
        beforeId: boundary.oldestMessageId,
      });
      if (!isCurrent() || !payload?.success || !payload.messages) return;
      if (payload.messages.length === 0) {
        applyPagination({ ...paginationRef.current, hasMoreBefore: false });
        return;
      }
      // Capture immediately before insertion, so scrolling while the network
      // request was pending is preserved too.
      const previousScrollHeight = scrollContainer?.scrollHeight ?? 0;
      const previousScrollTop = scrollContainer?.scrollTop ?? 0;
      applyMessagePage(payload, snapshot, isCurrent);
      requestAnimationFrame(() => {
        // The request has finished by this frame; validate navigation rather
        // than the in-flight pagination slot, which has already been released.
        if (!controller.signal.aborted && generation === loadSessionRequestIdRef.current
          && activeWorkspaceRef.current === workspaceId && sessionIdRef.current === currentSessionId
          && scrollContainer && scrollContainerRef.current === scrollContainer
          && scrollContainer.scrollTop === previousScrollTop) {
          scrollContainer.scrollTop = previousScrollTop + scrollContainer.scrollHeight - previousScrollHeight;
        }
      });
    } catch (err) {
      if (isCurrent()) console.error('[CanvasAgentChat] Failed to load older messages:', err);
    } finally {
      if (olderRequestRef.current === controller) {
        olderRequestRef.current = null;
        if (!controller.signal.aborted && generation === loadSessionRequestIdRef.current
          && activeWorkspaceRef.current === workspaceId && sessionIdRef.current === currentSessionId) {
          setIsLoadingOlder(false);
        }
      }
    }
  }, [applyMessagePage, applyPagination, isLoadingOlder, messagesRef, scrollContainerRef, selectedAgentId, sessionAgentIdRef, sessionIdRef, setIsLoadingOlder]);

  return {
    cancelSessionLoad,
    isLoadingMessages,
    loadOlderMessages,
    loadSession,
    refreshSavedMessages,
  };
}
