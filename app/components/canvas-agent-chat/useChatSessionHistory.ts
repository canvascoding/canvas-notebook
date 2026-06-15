'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useTranslations } from 'next-intl';
import type { ChatHistoryPanelLabels } from '@/app/components/canvas-agent-chat/ChatHistoryPanel';
import { fetchChatSessions, patchChatSessions } from '@/app/lib/chat/session-api';
import { applySessionUnreadUpdate } from '@/app/lib/chat/unread';
import { getAgentDisplayName } from '@/app/lib/chat/agent-display';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { isAutomaticSessionTitle } from '@/app/lib/pi/session-titles';
import type {
  AgentProfile,
  AISession,
  ChatHistoryAgentOption,
  ChatHistoryGroup,
  ChatHistoryGroups,
} from '@/app/lib/chat/types';

type ChatTranslator = ReturnType<typeof useTranslations<'chat'>>;

type UseChatSessionHistoryParams = {
  availableAgents: AgentProfile[];
  optimisticSessionTitlesRef: MutableRefObject<Record<string, string>>;
  requestSavedMessageRefreshRef: MutableRefObject<((sessionId: string) => void) | null>;
  selectedAgentId: string;
  sessionAgentIdRef: MutableRefObject<string>;
  sessionIdRef: MutableRefObject<string | null>;
  setHasUnreadInCurrentSession: Dispatch<SetStateAction<boolean>>;
  setSessionTitle: Dispatch<SetStateAction<string | null>>;
  setShowUnreadBanner: Dispatch<SetStateAction<boolean>>;
  surfaceVisibleRef: MutableRefObject<boolean>;
  t: ChatTranslator;
};

const CHAT_AGENT_ID = DEFAULT_AGENT_ID;

function sortSessionsByRecentActivity(sessions: AISession[]): AISession[] {
  return [...sessions].sort((a, b) => {
    const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : new Date(a.createdAt).getTime();
    const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : new Date(b.createdAt).getTime();
    return bTime - aTime;
  });
}

function getSessionTimeGroup(dateString: string): ChatHistoryGroup {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays <= 7) return 'last7';
  if (diffDays <= 14) return 'last14';
  if (diffDays <= 30) return 'last30';
  return 'older';
}

export function useChatSessionHistory({
  availableAgents,
  optimisticSessionTitlesRef,
  requestSavedMessageRefreshRef,
  selectedAgentId,
  sessionAgentIdRef,
  sessionIdRef,
  setHasUnreadInCurrentSession,
  setSessionTitle,
  setShowUnreadBanner,
  surfaceVisibleRef,
  t,
}: UseChatSessionHistoryParams) {
  const [history, setHistory] = useState<AISession[]>([]);
  const [historySearchQuery, setHistorySearchQuery] = useState('');
  const [historyUnreadOnly, setHistoryUnreadOnly] = useState(false);
  const [historyAgentFilter, setHistoryAgentFilter] = useState('all');
  const [historySidebarWidth, setHistorySidebarWidth] = useState(280);
  const [latestSession, setLatestSession] = useState<AISession | null>(null);
  const [totalUnreadCount, setTotalUnreadCount] = useState(0);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const historyRef = useRef<AISession[]>([]);
  const historyResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const isHistoryResizing = useRef(false);
  const sessionListRequestRef = useRef<Promise<AISession[]> | null>(null);
  const hasLoadedSessionListRef = useRef(false);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  const agentProfilesById = useMemo(() => new Map(availableAgents.map((agent) => [agent.agentId, agent])), [availableAgents]);

  const resolveSessionTitle = useCallback((targetSessionId: string, title: string | null | undefined) => {
    const optimisticTitle = optimisticSessionTitlesRef.current[targetSessionId];
    const normalizedTitle = title?.trim() || null;

    if (optimisticTitle && (!normalizedTitle || isAutomaticSessionTitle(normalizedTitle))) {
      return optimisticTitle;
    }

    if (optimisticTitle && normalizedTitle && !isAutomaticSessionTitle(normalizedTitle)) {
      delete optimisticSessionTitlesRef.current[targetSessionId];
    }

    return normalizedTitle;
  }, [optimisticSessionTitlesRef]);

  const applyResolvedTitles = useCallback((sessions: AISession[]) => {
    return sessions.map((session) => {
      const resolvedTitle = resolveSessionTitle(session.sessionId, session.title);
      if (resolvedTitle === session.title) {
        return session;
      }

      return {
        ...session,
        title: resolvedTitle,
      };
    });
  }, [resolveSessionTitle]);

  const loadSessionList = useCallback(async () => {
    if (sessionListRequestRef.current) {
      return sessionListRequestRef.current;
    }

    const request = (async () => {
      const sessions = applyResolvedTitles(await fetchChatSessions('all'));
      hasLoadedSessionListRef.current = true;
      return sessions;
    })();

    sessionListRequestRef.current = request;

    try {
      return await request;
    } finally {
      if (sessionListRequestRef.current === request) {
        sessionListRequestRef.current = null;
      }
    }
  }, [applyResolvedTitles]);

  const setHistoryAndLatest = useCallback((sessions: AISession[]) => {
    setHistory(sessions);
    setLatestSession(sessions[0] || null);
    setTotalUnreadCount(sessions.filter((session) => session.hasUnread).length);
  }, []);

  const addSessionToHistory = useCallback((session: AISession) => {
    setHistory((prevHistory) => {
      const exists = prevHistory.some((item) => item.sessionId === session.sessionId);
      if (exists) return prevHistory;
      return sortSessionsByRecentActivity([session, ...prevHistory]);
    });
    setLatestSession(session);
  }, []);

  const resetHistoryState = useCallback(() => {
    sessionListRequestRef.current = null;
    hasLoadedSessionListRef.current = false;
    setHistory([]);
    setLatestSession(null);
    setTotalUnreadCount(0);
  }, []);

  const fetchHistory = useCallback(async () => {
    setIsLoadingHistory(true);
    try {
      const currentVisibleSessionId = surfaceVisibleRef.current ? sessionIdRef.current : null;
      const sessions = await loadSessionList();
      const activeVisibleUnreadSession = currentVisibleSessionId
        ? sessions.find((candidate) => candidate.sessionId === currentVisibleSessionId && candidate.hasUnread)
        : null;
      const visibleSessions = activeVisibleUnreadSession
        ? sessions.map((candidate) => (
            candidate.sessionId === currentVisibleSessionId
              ? {
                  ...candidate,
                  hasUnread: false,
                  lastViewedAt: candidate.lastMessageAt || new Date().toISOString(),
                }
              : candidate
          ))
        : sessions;

      if (activeVisibleUnreadSession && currentVisibleSessionId) {
        setHasUnreadInCurrentSession(false);
        setShowUnreadBanner(false);
        void patchChatSessions({
          agentId: sessionAgentIdRef.current || selectedAgentId,
          sessionId: currentVisibleSessionId,
          markAsRead: true,
        }).catch((error) => {
          console.error('Failed to mark active session as read after history refresh', error);
        });
      }

      setHistoryAndLatest(visibleSessions);

      const activeSessionId = sessionIdRef.current;
      if (activeSessionId) {
        const currentSession = visibleSessions.find((candidate) => candidate.sessionId === activeSessionId);
        if (currentSession) {
          setSessionTitle(resolveSessionTitle(currentSession.sessionId, currentSession.title));
        }
      }
    } catch (err) {
      console.error('Failed to fetch history', err);
    } finally {
      setIsLoadingHistory(false);
    }
  }, [
    loadSessionList,
    resolveSessionTitle,
    selectedAgentId,
    sessionAgentIdRef,
    sessionIdRef,
    setHasUnreadInCurrentSession,
    setHistoryAndLatest,
    setSessionTitle,
    setShowUnreadBanner,
    surfaceVisibleRef,
  ]);

  const markAllAsRead = useCallback(async () => {
    try {
      const data = await patchChatSessions({ agentId: selectedAgentId, markAllAsRead: true });
      if (data?.success) {
        const now = data.lastViewedAt;
        setHistory((prev) => prev.map((item) => (
          item.hasUnread ? { ...item, lastViewedAt: item.lastMessageAt || now, hasUnread: false } : item
        )));
        setTotalUnreadCount(0);
      }
    } catch (err) {
      console.error('Failed to mark all as read', err);
    }
  }, [selectedAgentId]);

  useEffect(() => {
    const handleSessionUpdated = (event: CustomEvent<{ sessionId: string; lastMessageAt: string; title?: string }>) => {
      const { sessionId: updatedSessionId, lastMessageAt, title } = event.detail;
      const currentSessionId = sessionIdRef.current;
      const currentVisible = surfaceVisibleRef.current;
      const isCurrentVisibleSession = updatedSessionId === currentSessionId && currentVisible;
      console.log(`[CanvasAgentChat] session_updated received: sessionId=${updatedSessionId}, lastMessageAt=${lastMessageAt}, title="${title}", currentSessionId=${currentSessionId}, surfaceVisible=${currentVisible}, isCurrentVisibleSession=${isCurrentVisibleSession}`);
      const sessionFound = historyRef.current.some((candidate) => candidate.sessionId === updatedSessionId);
      const resolvedTitle = resolveSessionTitle(updatedSessionId, title);

      setHistory((prev) => {
        const updated = prev.map((session) => {
          if (session.sessionId !== updatedSessionId) return session;
          const updatedSession = applySessionUnreadUpdate(session, event.detail, {
            isCurrentVisibleSession,
            title: resolvedTitle,
          });
          console.log(`[CanvasAgentChat] Unread calc for ${updatedSessionId}: isCurrentVisible=${isCurrentVisibleSession}, lastMessageAt=${lastMessageAt}, lastViewedAt=${session.lastViewedAt}, newLastViewedAt=${updatedSession.lastViewedAt}, hasUnread=${updatedSession.hasUnread}`);
          return updatedSession;
        });

        setTotalUnreadCount(updated.filter((candidate) => candidate.hasUnread).length);
        historyRef.current = updated;

        return updated;
      });

      if (resolvedTitle && updatedSessionId === sessionIdRef.current) {
        setSessionTitle(resolvedTitle);
      }

      if (isCurrentVisibleSession) {
        requestSavedMessageRefreshRef.current?.(updatedSessionId);
        void patchChatSessions({
          agentId: sessionAgentIdRef.current || selectedAgentId,
          sessionId: updatedSessionId,
          markAsRead: true,
        }).catch((error) => {
          console.error('Failed to mark active session as read after response', error);
        });
      }

      if (!sessionFound) {
        void (async () => {
          try {
            const sessions = await loadSessionList();
            setHistoryAndLatest(sessions);
          } catch (error) {
            console.error('Failed to refresh history after session update', error);
          }
        })();
      }
    };

    window.addEventListener('session_updated', handleSessionUpdated as EventListener);
    return () => {
      window.removeEventListener('session_updated', handleSessionUpdated as EventListener);
    };
  }, [
    loadSessionList,
    requestSavedMessageRefreshRef,
    resolveSessionTitle,
    selectedAgentId,
    sessionAgentIdRef,
    sessionIdRef,
    setHistoryAndLatest,
    setSessionTitle,
    surfaceVisibleRef,
  ]);

  const historyAgentOptions = useMemo<ChatHistoryAgentOption[]>(() => {
    const byId = new Map<string, ChatHistoryAgentOption>();
    for (const agent of availableAgents) {
      byId.set(agent.agentId, { agentId: agent.agentId, name: agent.name, iconId: agent.iconId });
    }
    for (const session of history) {
      const agentId = session.agentId || CHAT_AGENT_ID;
      const existing = byId.get(agentId);
      byId.set(agentId, {
        agentId,
        name: existing?.name || getAgentDisplayName(agentId),
        iconId: existing?.iconId,
      });
    }
    return Array.from(byId.values()).sort((a, b) => {
      if (a.agentId === CHAT_AGENT_ID) return -1;
      if (b.agentId === CHAT_AGENT_ID) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [availableAgents, history]);

  const filteredHistory = useMemo<ChatHistoryGroups>(() => {
    let filtered = [...history];

    if (historyUnreadOnly) {
      filtered = filtered.filter((candidate) => candidate.hasUnread);
    }

    if (historyAgentFilter !== 'all') {
      filtered = filtered.filter((candidate) => (candidate.agentId || CHAT_AGENT_ID) === historyAgentFilter);
    }

    const trimmedQuery = historySearchQuery.trim();
    if (trimmedQuery) {
      const query = trimmedQuery.toLowerCase();
      filtered = filtered.filter((candidate) =>
        candidate.title?.toLowerCase().includes(query) ||
        candidate.sessionId.toLowerCase().includes(query) ||
        (agentProfilesById.get(candidate.agentId || CHAT_AGENT_ID)?.name || getAgentDisplayName(candidate.agentId)).toLowerCase().includes(query)
      );
    }

    const grouped: ChatHistoryGroups = {
      today: [],
      last7: [],
      last14: [],
      last30: [],
      older: [],
    };

    sortSessionsByRecentActivity(filtered).forEach((session) => {
      const group = getSessionTimeGroup(session.createdAt);
      grouped[group].push(session);
    });

    return grouped;
  }, [agentProfilesById, history, historyAgentFilter, historySearchQuery, historyUnreadOnly]);

  const historyGroupLabels = useMemo<Record<ChatHistoryGroup, string>>(() => ({
    today: t('groupToday'),
    last7: t('groupLast7Days'),
    last14: t('groupLast14Days'),
    last30: t('groupLast30Days'),
    older: t('groupOlder'),
  }), [t]);

  const historyPanelLabels = useMemo<ChatHistoryPanelLabels>(() => ({
    chatHistory: t('chatHistory'),
    searchSessions: t('searchSessions'),
    filterAllAgents: t('filterAllAgents'),
    filterUnreadOnly: t('filterUnreadOnly'),
    filterAllSessions: t('filterAllSessions'),
    markAllAsRead: t('markAllAsRead'),
    backToChat: t('backToChat'),
    noRecentSessions: t('noRecentSessions'),
    noSessionsFoundWithFilter: t('noSessionsFoundWithFilter'),
    newChatTitle: t('newChatTitle'),
    unreadResponse: t('unreadResponse'),
    renameSession: t('renameSession'),
    deleteSession: t('deleteSession'),
  }), [t]);

  const startHistoryResizing = useCallback((event: ReactMouseEvent) => {
    isHistoryResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    historyResizeRef.current = {
      startX: event.clientX,
      startWidth: historySidebarWidth,
    };
  }, [historySidebarWidth]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!isHistoryResizing.current || !historyResizeRef.current) return;
      const nextWidth = Math.min(400, Math.max(220, historyResizeRef.current.startWidth + (event.clientX - historyResizeRef.current.startX)));
      setHistorySidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      if (isHistoryResizing.current) {
        isHistoryResizing.current = false;
        historyResizeRef.current = null;
        document.body.style.cursor = 'default';
        document.body.style.userSelect = 'auto';
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  return {
    addSessionToHistory,
    agentProfilesById,
    fetchHistory,
    filteredHistory,
    hasLoadedSessionListRef,
    history,
    historyAgentFilter,
    historyAgentOptions,
    historyGroupLabels,
    historyPanelLabels,
    historyRef,
    historySearchQuery,
    historySidebarWidth,
    historyUnreadOnly,
    isLoadingHistory,
    latestSession,
    loadSessionList,
    markAllAsRead,
    resetHistoryState,
    resolveSessionTitle,
    setHistory,
    setHistoryAgentFilter,
    setHistoryAndLatest,
    setHistorySearchQuery,
    setHistoryUnreadOnly,
    setLatestSession,
    setTotalUnreadCount,
    startHistoryResizing,
    totalUnreadCount,
  };
}
