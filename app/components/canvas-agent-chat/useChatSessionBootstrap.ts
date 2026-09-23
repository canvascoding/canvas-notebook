'use client';

import {
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { useTranslations } from 'next-intl';
import { saveLastActiveAgentId } from '@/app/lib/chat/agent-preferences';
import { fetchChatSessionBootstrap } from '@/app/lib/chat/session-api';
import { readLatestCachedChatSession } from '@/app/lib/chat/session-cache';
import type {
  AISession,
  Attachment,
} from '@/app/lib/chat/types';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { consumePromptHandoff, createPromptHandoff, isPromptHandoffForNavigation, readPromptHandoff, type PromptHandoff } from '@/app/lib/chat/prompt-handoff';
import { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
import { readCanvasChatActiveSessionStorage } from '@/app/lib/chat/constants';

type ChatTranslator = ReturnType<typeof useTranslations<'chat'>>;

type UseChatSessionBootstrapParams = {
  addSessionToHistory: (session: AISession) => void;
  appendSystemMessage: (content: string) => void;
  clearSessionParamFromUrl: () => void;
  fetchHistory: () => Promise<void>;
  forcedSessionId?: string | null;
  handleControlAction: (
    action: 'send' | 'steer' | 'follow_up' | 'replace',
    override?: { text: string; attachments: Attachment[]; handoffId?: string; workspaceId?: string },
  ) => Promise<void>;
  activeWorkspaceId?: string | null;
  hasLoadedSessionListRef: MutableRefObject<boolean>;
  historyLength: number;
  initialPrompt?: string | null;
  initialPromptConsumedRef: MutableRefObject<boolean>;
  initialPromptStorageKey?: string;
  isLoadingHistory: boolean;
  isAuthReady?: boolean;
  isResolvingInitialChatState: boolean;
  isRuntimeSelectionLoading: boolean;
  isWorkspaceNavigationPending: boolean;
  loadSession: (session: AISession) => Promise<void>;
  loadSessionList: () => Promise<AISession[]>;
  requestedSessionCleanupRef: MutableRefObject<string | null>;
  resolvedRequestedSessionId: string | null;
  selectedAgentId: string;
  sessionAgentIdRef: MutableRefObject<string>;
  sessionId: string | null;
  sessionIdRef: MutableRefObject<string | null>;
  setHistoryAgentFilter: (agentId: string) => void;
  setHistoryAndLatest: (sessions: AISession[]) => void;
  setIsResolvingInitialChatState: Dispatch<SetStateAction<boolean>>;
  setSelectedAgentId: Dispatch<SetStateAction<string>>;
  showHistory: boolean;
  t: ChatTranslator;
  userStartedNewChatRef: MutableRefObject<boolean>;
};

const CHAT_AGENT_ID = DEFAULT_AGENT_ID;

function sessionMatchesActiveWorkspace(session: AISession, activeWorkspaceId?: string | null): boolean {
  if (!activeWorkspaceId) {
    return true;
  }
  return session.workspace?.workspaceId === activeWorkspaceId;
}

export function useChatSessionBootstrap({
  addSessionToHistory,
  clearSessionParamFromUrl,
  fetchHistory,
  forcedSessionId,
  handleControlAction,
  activeWorkspaceId,
  hasLoadedSessionListRef,
  initialPrompt,
  initialPromptConsumedRef,
  initialPromptStorageKey,
  isLoadingHistory,
  isAuthReady = true,
  isResolvingInitialChatState,
  isRuntimeSelectionLoading,
  isWorkspaceNavigationPending,
  loadSession,
  requestedSessionCleanupRef,
  resolvedRequestedSessionId,
  selectedAgentId,
  sessionAgentIdRef,
  sessionId,
  sessionIdRef,
  setHistoryAgentFilter,
  setIsResolvingInitialChatState,
  setSelectedAgentId,
  showHistory,
  userStartedNewChatRef,
}: UseChatSessionBootstrapParams) {
  const [initialSessionFailure, setInitialSessionFailure] = useState<{
    message: string; workspaceId: string | null; sessionId: string | null; requestedSessionId: string | null;
  } | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const retryInitialSession = useCallback(() => {
    initialPromptConsumedRef.current = false;
    setRetryVersion((value) => value + 1);
  }, [initialPromptConsumedRef]);
  const directPromptRef = useRef<PromptHandoff | null>(null);
  const promptNavigationRef = useRef<object | null>(null);
  useLayoutEffect(() => {
    promptNavigationRef.current = {};
    return () => { promptNavigationRef.current = null; };
  }, [activeWorkspaceId, resolvedRequestedSessionId]);
  const requestedSessionLoadIdRef = useRef(0);
  const restoredSessionLoadIdRef = useRef(0);

  useEffect(() => {
    if (!isAuthReady || isWorkspaceNavigationPending || isRuntimeSelectionLoading || !activeWorkspaceId) return;
    if (initialPromptConsumedRef.current) return;
    const candidatePrompt = (initialPrompt || '').trim();
    if (!candidatePrompt && !initialPromptStorageKey) return;
    const auth = openedDocumentAuthScope();
    const navigation = promptNavigationRef.current;
    let payload: PromptHandoff | null;
    let storageKey: string | undefined;
    try {
      if (candidatePrompt) {
        if (!directPromptRef.current) directPromptRef.current = createPromptHandoff({
          prompt: candidatePrompt, attachments: [], agentId: selectedAgentId,
          workspaceId: activeWorkspaceId, auth,
        });
        payload = directPromptRef.current;
        if (payload.workspaceId !== activeWorkspaceId) return;
      } else {
        storageKey = initialPromptStorageKey;
        if (!isPromptHandoffForNavigation(window.sessionStorage, storageKey!, {
          search: window.location.search, workspaceId: activeWorkspaceId,
        })) return;
        payload = readPromptHandoff(window.sessionStorage, storageKey!, {
          workspaceId: activeWorkspaceId, auth,
          requestedHandoffId: new URLSearchParams(window.location.search).get('handoff'),
        });
      }
      if (!payload) return;
      if (payload.auth && (!auth || payload.auth.userId !== auth.userId || payload.auth.sessionId !== auth.sessionId)) {
        throw new Error('This prompt belongs to another sign-in session.');
      }
      if (storageKey && !new URLSearchParams(window.location.search).get('handoff')) {
        // Bind upgraded legacy handoffs before any later render can restore a saved session.
        const url = new URL(window.location.href);
        url.searchParams.set('handoff', payload.handoffId);
        url.searchParams.set('workspaceId', payload.workspaceId);
        url.searchParams.set('chat', 'open');
        window.history.replaceState(window.history.state, '', url);
      }
    } catch (error) {
      // Failed storage/account validation requires an explicit retry, never an effect loop.
      initialPromptConsumedRef.current = true;
      const message = error instanceof Error ? error.message : String(error);
      Promise.resolve().then(() => {
        if (promptNavigationRef.current !== navigation) return;
        setIsResolvingInitialChatState(false);
        setInitialSessionFailure({ message, workspaceId: activeWorkspaceId,
          sessionId: sessionIdRef.current, requestedSessionId: resolvedRequestedSessionId });
      });
      return;
    }
    const targetAgentId = payload.agentId || CHAT_AGENT_ID;
    if (targetAgentId !== selectedAgentId) {
      sessionAgentIdRef.current = targetAgentId;
      void saveLastActiveAgentId(targetAgentId);
      Promise.resolve().then(() => {
        setHistoryAgentFilter(targetAgentId);
        setSelectedAgentId(targetAgentId);
      });
      return;
    }

    // Lock before yielding: renders and agent/runtime updates cannot send twice.
    initialPromptConsumedRef.current = true;
    const handoff = payload;
    const isCurrentHandoff = () => promptNavigationRef.current === navigation
      && !userStartedNewChatRef.current
      && openedDocumentAuthScope() === auth
      && (!storageKey || new URLSearchParams(window.location.search).get('handoff') === handoff.handoffId);
    void (async () => {
      await Promise.resolve();
      if (!isCurrentHandoff()) return;
      setInitialSessionFailure(null);
      let detached = false;
      try {
        await handleControlAction('send', { text: handoff.prompt, attachments: handoff.attachments,
          handoffId: handoff.handoffId, workspaceId: handoff.workspaceId });
        if (storageKey) consumePromptHandoff(window.sessionStorage, storageKey, handoff.handoffId);
      } catch (error) {
        detached = error instanceof Error && error.name === 'AbortError';
        if (!detached && isCurrentHandoff()) {
          setInitialSessionFailure({ message: error instanceof Error ? error.message : String(error),
            workspaceId: handoff.workspaceId, sessionId: sessionIdRef.current,
            requestedSessionId: resolvedRequestedSessionId });
        }
      } finally {
        if (!detached && isCurrentHandoff()) setIsResolvingInitialChatState(false);
      }
    })();
  }, [activeWorkspaceId, handleControlAction, initialPrompt, initialPromptConsumedRef, initialPromptStorageKey,
    isAuthReady, isRuntimeSelectionLoading, isWorkspaceNavigationPending, resolvedRequestedSessionId, retryVersion,
    selectedAgentId, sessionAgentIdRef, sessionIdRef, setHistoryAgentFilter, setIsResolvingInitialChatState,
    setSelectedAgentId, userStartedNewChatRef]);

  useEffect(() => {
    if (isWorkspaceNavigationPending) return;
    if (initialPrompt?.trim()) return;
    if (resolvedRequestedSessionId) return;
    if (isResolvingInitialChatState) return;
    if (hasLoadedSessionListRef.current) return;
    if (userStartedNewChatRef.current) return;
    void fetchHistory();
  }, [fetchHistory, hasLoadedSessionListRef, initialPrompt, isResolvingInitialChatState, isWorkspaceNavigationPending, resolvedRequestedSessionId, userStartedNewChatRef]);

  useEffect(() => {
    if (isWorkspaceNavigationPending) return;
    if (showHistory && !hasLoadedSessionListRef.current && !isLoadingHistory) {
      void fetchHistory();
    }
  }, [showHistory, fetchHistory, hasLoadedSessionListRef, isLoadingHistory, isWorkspaceNavigationPending]);

  useEffect(() => {
    if (isWorkspaceNavigationPending) return;
    if (initialPrompt?.trim()) return;
    if (initialPromptStorageKey && typeof window !== 'undefined'
      && isPromptHandoffForNavigation(window.sessionStorage, initialPromptStorageKey, {
        search: window.location.search, workspaceId: activeWorkspaceId,
      })) {
      return;
    }
    if (userStartedNewChatRef.current) return;
    if (!resolvedRequestedSessionId) return;
    setIsResolvingInitialChatState(true);
    const requestId = requestedSessionLoadIdRef.current + 1;
    requestedSessionLoadIdRef.current = requestId;
    let cancelled = false;
    const isCurrentRequest = () => !cancelled && requestedSessionLoadIdRef.current === requestId;

    const controller = new AbortController();
    const startingSessionId = sessionIdRef.current;
    const loadRequestedSession = async () => {
      try {
        await Promise.resolve();
        if (!isCurrentRequest()) return;
        setInitialSessionFailure(null);
        const cachedEntry = readLatestCachedChatSession(resolvedRequestedSessionId);
        const targetSession = cachedEntry && sessionMatchesActiveWorkspace(cachedEntry.session, activeWorkspaceId)
          ? cachedEntry.session
          : (await fetchChatSessionBootstrap({ sessionId: resolvedRequestedSessionId,
              workspaceId: activeWorkspaceId, signal: controller.signal })).session;
        if (!isCurrentRequest() || userStartedNewChatRef.current
          || sessionIdRef.current !== startingSessionId) return;
        addSessionToHistory(targetSession);
        await loadSession(targetSession);
        if (!isCurrentRequest()) return;
        // URL cleanup can tear down this effect; finish the loading state first.
        setIsResolvingInitialChatState(false);
        if (!forcedSessionId) {
          requestedSessionCleanupRef.current = resolvedRequestedSessionId;
          clearSessionParamFromUrl();
        }
      } catch (err) {
        if (isCurrentRequest()) setInitialSessionFailure({
          message: err instanceof Error ? err.message : String(err), workspaceId: activeWorkspaceId ?? null,
          sessionId: sessionIdRef.current, requestedSessionId: resolvedRequestedSessionId,
        });
      } finally {
        if (isCurrentRequest()) setIsResolvingInitialChatState(false);
      }
    };

    void loadRequestedSession();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeWorkspaceId, addSessionToHistory, clearSessionParamFromUrl, forcedSessionId, initialPrompt, initialPromptStorageKey, isWorkspaceNavigationPending, loadSession, requestedSessionCleanupRef, resolvedRequestedSessionId, retryVersion, sessionIdRef, setIsResolvingInitialChatState, userStartedNewChatRef]);

  useEffect(() => {
    if (isWorkspaceNavigationPending) return;
    if (initialPrompt?.trim()) return;
    if (initialPromptStorageKey && typeof window !== 'undefined'
      && isPromptHandoffForNavigation(window.sessionStorage, initialPromptStorageKey, {
        search: window.location.search, workspaceId: activeWorkspaceId,
      })) {
      return;
    }
    if (initialPromptConsumedRef.current) return;
    if (resolvedRequestedSessionId) return;
    if (userStartedNewChatRef.current) return;
    if (sessionIdRef.current) return;

    const storedSessionId = readCanvasChatActiveSessionStorage(activeWorkspaceId);
    if (!storedSessionId) {
      setIsResolvingInitialChatState(false);
      return;
    }
    setIsResolvingInitialChatState(true);
    const requestId = restoredSessionLoadIdRef.current + 1;
    restoredSessionLoadIdRef.current = requestId;
    let cancelled = false;
    const isCurrentRequest = () => !cancelled && restoredSessionLoadIdRef.current === requestId;

    const controller = new AbortController();
    const restoreSession = async () => {
      try {
        await Promise.resolve();
        if (!isCurrentRequest()) return;
        setInitialSessionFailure(null);
        const cachedEntry = readLatestCachedChatSession(storedSessionId);
        const targetSession = cachedEntry && sessionMatchesActiveWorkspace(cachedEntry.session, activeWorkspaceId)
          ? cachedEntry.session
          : (await fetchChatSessionBootstrap({ sessionId: storedSessionId,
              workspaceId: activeWorkspaceId, signal: controller.signal })).session;
        if (!isCurrentRequest() || sessionIdRef.current || userStartedNewChatRef.current) return;
        addSessionToHistory(targetSession);
        await loadSession(targetSession);
      } catch (err) {
        if (isCurrentRequest()) setInitialSessionFailure({
          message: err instanceof Error ? err.message : String(err), workspaceId: activeWorkspaceId ?? null,
          sessionId: sessionIdRef.current, requestedSessionId: resolvedRequestedSessionId,
        });
      } finally {
        if (isCurrentRequest()) setIsResolvingInitialChatState(false);
      }
    };

    void restoreSession();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    activeWorkspaceId,
    addSessionToHistory,
    initialPrompt,
    initialPromptConsumedRef,
    initialPromptStorageKey,
    isWorkspaceNavigationPending,
    loadSession,
    resolvedRequestedSessionId,
    retryVersion,
    sessionIdRef,
    setIsResolvingInitialChatState,
    userStartedNewChatRef,
  ]);

  useEffect(() => {
    if (requestedSessionCleanupRef.current && !resolvedRequestedSessionId) {
      requestedSessionCleanupRef.current = null;
    }
  }, [requestedSessionCleanupRef, resolvedRequestedSessionId]);

  const initialSessionError = initialSessionFailure
    && initialSessionFailure.workspaceId === (activeWorkspaceId ?? null)
    && initialSessionFailure.sessionId === sessionId
    && initialSessionFailure.requestedSessionId === resolvedRequestedSessionId
    ? initialSessionFailure.message : null;
  return { initialSessionError, retryInitialSession };
}
