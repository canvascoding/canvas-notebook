'use client';

import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { useTranslations } from 'next-intl';
import { deriveUploadAttachmentPreview } from '@/app/lib/chat/attachment-preview';
import { CANVAS_CHAT_ACTIVE_SESSION_STORAGE_KEY } from '@/app/lib/chat/constants';
import { isRecord } from '@/app/lib/chat/message-content';
import { readLatestCachedChatSession } from '@/app/lib/chat/session-cache';
import type {
  AgentConfig,
  AISession,
  Attachment,
} from '@/app/lib/chat/types';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { isAgentConfigForAgent } from '@/app/components/canvas-agent-chat/useChatAgentConfig';

type ChatTranslator = ReturnType<typeof useTranslations<'chat'>>;

type InitialPromptPayload = {
  prompt: string;
  attachments: Attachment[];
  agentId: string | null;
};

type UseChatSessionBootstrapParams = {
  addSessionToHistory: (session: AISession) => void;
  agentConfig: AgentConfig | null;
  appendSystemMessage: (content: string) => void;
  clearSessionParamFromUrl: () => void;
  fetchHistory: () => Promise<void>;
  forcedSessionId?: string | null;
  handleControlAction: (
    action: 'send' | 'steer' | 'follow_up' | 'replace',
    override?: { text: string; attachments: Attachment[] },
  ) => Promise<void>;
  hasLoadedSessionListRef: MutableRefObject<boolean>;
  historyLength: number;
  initialPrompt?: string | null;
  initialPromptConsumedRef: MutableRefObject<boolean>;
  initialPromptStorageKey?: string;
  isLoadingHistory: boolean;
  isResolvingInitialChatState: boolean;
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

const MANAGED_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CHAT_AGENT_ID = DEFAULT_AGENT_ID;

function normalizeInitialPromptAgentId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return MANAGED_AGENT_ID_PATTERN.test(normalized) ? normalized : null;
}

function parseInitialPromptAttachment(value: unknown): Attachment | null {
  if (!isRecord(value)) {
    return null;
  }

  const contentKind = value.contentKind === 'image' || value.contentKind === 'document'
    ? value.contentKind
    : null;
  const name = typeof value.name === 'string' ? value.name : '';
  const id = typeof value.id === 'string' ? value.id : '';

  if (!contentKind || !name || !id) {
    return null;
  }

  return deriveUploadAttachmentPreview({
    name,
    id,
    contentKind,
    mimeType: typeof value.mimeType === 'string' ? value.mimeType : undefined,
    category: typeof value.category === 'string' ? value.category : undefined,
    filePath: typeof value.filePath === 'string' ? value.filePath : undefined,
    previewUrl: typeof value.previewUrl === 'string' ? value.previewUrl : undefined,
    mediaUrl: typeof value.mediaUrl === 'string' ? value.mediaUrl : undefined,
  });
}

function parseInitialPromptPayload(storedData: string): InitialPromptPayload | null {
  try {
    const parsed = JSON.parse(storedData) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : '';
    const attachments = Array.isArray(parsed.attachments)
      ? parsed.attachments
        .map(parseInitialPromptAttachment)
        .filter((attachment): attachment is Attachment => Boolean(attachment))
      : [];

    if (!prompt.trim() && attachments.length === 0) {
      return null;
    }

    return {
      prompt,
      attachments,
      agentId: normalizeInitialPromptAgentId(parsed.agentId),
    };
  } catch {
    const prompt = storedData.trim();
    return prompt ? { prompt, attachments: [], agentId: null } : null;
  }
}

export function useChatSessionBootstrap({
  addSessionToHistory,
  agentConfig,
  appendSystemMessage,
  clearSessionParamFromUrl,
  fetchHistory,
  forcedSessionId,
  handleControlAction,
  hasLoadedSessionListRef,
  historyLength,
  initialPrompt,
  initialPromptConsumedRef,
  initialPromptStorageKey,
  isLoadingHistory,
  isResolvingInitialChatState,
  loadSession,
  loadSessionList,
  requestedSessionCleanupRef,
  resolvedRequestedSessionId,
  selectedAgentId,
  sessionAgentIdRef,
  sessionId,
  sessionIdRef,
  setHistoryAgentFilter,
  setHistoryAndLatest,
  setIsResolvingInitialChatState,
  setSelectedAgentId,
  showHistory,
  t,
  userStartedNewChatRef,
}: UseChatSessionBootstrapParams) {
  useEffect(() => {
    if (initialPromptConsumedRef.current) return;
    if (!agentConfig) return;
    if (!isAgentConfigForAgent(agentConfig, selectedAgentId)) return;

    const queueInitialPrompt = async (promptText: string, promptAttachments: Attachment[], storageKey?: string) => {
      initialPromptConsumedRef.current = true;
      try {
        await handleControlAction('send', { text: promptText, attachments: promptAttachments });
        if (storageKey && typeof window !== 'undefined') {
          window.sessionStorage.removeItem(storageKey);
        }
      } catch (error) {
        setIsResolvingInitialChatState(false);
        appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
      }
    };

    const candidatePrompt = (initialPrompt || '').trim();
    if (candidatePrompt) {
      void queueInitialPrompt(candidatePrompt, []);
      return;
    }

    if (!initialPromptStorageKey || typeof window === 'undefined') return;
    const storedData = window.sessionStorage.getItem(initialPromptStorageKey);
    if (!storedData) return;

    const parsed = parseInitialPromptPayload(storedData);
    if (!parsed) {
      return;
    }

    const targetAgentId = parsed.agentId || CHAT_AGENT_ID;
    if (targetAgentId !== selectedAgentId) {
      sessionAgentIdRef.current = targetAgentId;
      Promise.resolve().then(() => {
        setHistoryAgentFilter(targetAgentId);
        setSelectedAgentId(targetAgentId);
      });
      return;
    }

    void queueInitialPrompt(parsed.prompt, parsed.attachments, initialPromptStorageKey);
  }, [agentConfig, appendSystemMessage, handleControlAction, initialPrompt, initialPromptConsumedRef, initialPromptStorageKey, selectedAgentId, sessionAgentIdRef, setHistoryAgentFilter, setIsResolvingInitialChatState, setSelectedAgentId, t]);

  useEffect(() => {
    if (initialPrompt?.trim()) return;
    if (resolvedRequestedSessionId) return;
    if (isResolvingInitialChatState) return;
    if (hasLoadedSessionListRef.current) return;
    if (userStartedNewChatRef.current) return;
    void fetchHistory();
  }, [fetchHistory, hasLoadedSessionListRef, initialPrompt, isResolvingInitialChatState, resolvedRequestedSessionId, userStartedNewChatRef]);

  useEffect(() => {
    if (showHistory && historyLength === 0 && !isLoadingHistory) {
      void fetchHistory();
    }
  }, [showHistory, historyLength, fetchHistory, isLoadingHistory]);

  useEffect(() => {
    if (initialPrompt?.trim()) return;
    if (initialPromptStorageKey && typeof window !== 'undefined' && window.sessionStorage.getItem(initialPromptStorageKey)) {
      return;
    }
    if (userStartedNewChatRef.current) return;
    if (!resolvedRequestedSessionId) return;
    setIsResolvingInitialChatState(true);

    const loadRequestedSession = async () => {
      try {
        const cachedEntry = readLatestCachedChatSession(resolvedRequestedSessionId);
        if (cachedEntry) {
          addSessionToHistory(cachedEntry.session);
          await loadSession(cachedEntry.session);
          if (!forcedSessionId) {
            requestedSessionCleanupRef.current = resolvedRequestedSessionId;
            clearSessionParamFromUrl();
          }
          void loadSessionList()
            .then((sessions) => {
              setHistoryAndLatest(sessions.length > 0 ? sessions : [cachedEntry.session]);
            })
            .catch((err) => {
              console.error('Failed to refresh requested session history', err);
            });
          return;
        }

        const sessions = await loadSessionList();
        if (sessions.length > 0) {
          setHistoryAndLatest(sessions);
          const targetSession = sessions.find((session: AISession) => session.sessionId === resolvedRequestedSessionId);
          if (targetSession) {
            await loadSession(targetSession);
            if (!forcedSessionId) {
              requestedSessionCleanupRef.current = resolvedRequestedSessionId;
              clearSessionParamFromUrl();
            }
          }
        }
      } catch (err) {
        console.error('Failed to load requested session', err);
      } finally {
        setIsResolvingInitialChatState(false);
      }
    };

    void loadRequestedSession();
  }, [addSessionToHistory, clearSessionParamFromUrl, forcedSessionId, initialPrompt, initialPromptStorageKey, loadSession, loadSessionList, requestedSessionCleanupRef, resolvedRequestedSessionId, setHistoryAndLatest, setIsResolvingInitialChatState, userStartedNewChatRef]);

  useEffect(() => {
    if (initialPrompt?.trim()) return;
    if (initialPromptStorageKey && typeof window !== 'undefined' && window.sessionStorage.getItem(initialPromptStorageKey)) {
      return;
    }
    if (initialPromptConsumedRef.current) return;
    if (resolvedRequestedSessionId) return;
    if (userStartedNewChatRef.current) return;
    if (sessionId) return;

    const storedSessionId = typeof window !== 'undefined'
      ? window.sessionStorage.getItem(CANVAS_CHAT_ACTIVE_SESSION_STORAGE_KEY)
      : null;
    if (!storedSessionId) {
      setIsResolvingInitialChatState(false);
      return;
    }
    setIsResolvingInitialChatState(true);

    const restoreSession = async () => {
      try {
        const cachedEntry = readLatestCachedChatSession(storedSessionId);
        if (cachedEntry) {
          addSessionToHistory(cachedEntry.session);
          await loadSession(cachedEntry.session);
          void loadSessionList()
            .then((sessions) => {
              setHistoryAndLatest(sessions.length > 0 ? sessions : [cachedEntry.session]);
            })
            .catch((err) => {
              console.error('Failed to refresh restored session history', err);
            });
          return;
        }

        const sessions = await loadSessionList();
        if (sessionIdRef.current) return;
        if (sessions.length > 0) {
          setHistoryAndLatest(sessions);
          const targetSession = sessions.find((s: AISession) => s.sessionId === storedSessionId);
          if (targetSession) {
            await loadSession(targetSession);
          }
        }
      } catch (err) {
        console.error('Failed to restore previous session', err);
      } finally {
        setIsResolvingInitialChatState(false);
      }
    };

    void restoreSession();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (requestedSessionCleanupRef.current && !resolvedRequestedSessionId) {
      requestedSessionCleanupRef.current = null;
    }
  }, [requestedSessionCleanupRef, resolvedRequestedSessionId]);
}
