'use client';

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { useTranslations } from 'next-intl';
import {
  Loader2,
  History,
  Plus,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  ArrowDown,
  Wrench,
  Lightbulb,
  Settings,
  ArrowLeft,
} from 'lucide-react';
import { ChatComposer } from '@/app/components/canvas-agent-chat/ChatComposer';
import { ChatAgentSelector } from '@/app/components/canvas-agent-chat/ChatAgentSelector';
import { ChatHistoryPanel, type ChatHistoryPanelProps } from '@/app/components/canvas-agent-chat/ChatHistoryPanel';
import { ChatMessageList } from '@/app/components/canvas-agent-chat/ChatMessageList';
import { ChatStarterScreen } from '@/app/components/canvas-agent-chat/ChatStarterScreen';
import { toUploadMediaUrl } from '@/app/lib/utils/media-url';
import { useFileStore } from '@/app/store/file-store';
import { Link } from '@/i18n/navigation';
import { useRouter, useSearchParams } from 'next/navigation';
import { usePathname as useLocalePathname } from '@/i18n/navigation';
import { useLocale } from 'next-intl';
import { Button } from '@/components/ui/button';


import { ThemeToggle } from '@/app/components/ThemeToggle';

import { useIsMobile } from '@/hooks/use-mobile';
import { BUSINESS_STARTER_PROMPTS, STUDIO_STARTER_PROMPTS } from '@/app/lib/chat/starter-prompts';
import { ChatRuntimeActivityBadge } from '@/app/components/canvas-agent-chat/ChatRuntimeActivityBadge';
import { AttachmentPreviewDialog } from '@/app/components/canvas-agent-chat/AttachmentPreviewDialog';
import { deriveUploadAttachmentPreview } from '@/app/lib/chat/attachment-preview';
import { useChatComposerLayout } from '@/app/components/canvas-agent-chat/useChatComposerLayout';
import {
  countPiMessageImageAttachments,
  getQueuedSignatureFromPiMessage,
} from '@/app/components/canvas-agent-chat/chatRuntimeMessageUtils';
import { useChatScrollController } from '@/app/components/canvas-agent-chat/useChatScrollController';
import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
import {
  removeCachedChatSession,
  updateCachedChatSessionTitle,
} from '@/app/lib/chat/session-cache';
import {
  createChatSession,
  deleteChatSession as deleteChatSessionRequest,
  patchChatSessions,
} from '@/app/lib/chat/session-api';
import { getSessionDisplayTitle, isAutomaticSessionTitle } from '@/app/lib/pi/session-titles';
import { useWebSocket } from '@/app/hooks/useWebSocket';
import { ImagePreprocessDialog } from '@/app/components/shared/ImagePreprocessDialog';
import { usePlanModeStore } from '@/app/store/plan-mode-store';
import { useToolVerbosityStore } from '@/app/store/tool-verbosity-store';
import { getToolDisplayInfo } from '@/app/lib/pi/tool-display';
import { cn } from '@/lib/utils';

import { CANVAS_CHAT_ACTIVE_SESSION_STORAGE_KEY } from '@/app/lib/chat/constants';
import { loadComposerDraft, removeComposerDraft, saveComposerDraft } from '@/app/lib/chat/draft-storage';
import { getAgentDisplayName } from '@/app/lib/chat/agent-display';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  DEFAULT_THINKING_LEVEL,
  isAgentConfigForAgent,
  resolveAgentModelState,
  resolveAgentProviderState,
  useChatAgentConfig,
  type AgentModelState,
} from '@/app/components/canvas-agent-chat/useChatAgentConfig';
import { useChatAttachments } from '@/app/components/canvas-agent-chat/useChatAttachments';
import { useChatComposerDraft } from '@/app/components/canvas-agent-chat/useChatComposerDraft';
import { useChatRuntimeEvents } from '@/app/components/canvas-agent-chat/useChatRuntimeEvents';
import { useChatSessionHistory } from '@/app/components/canvas-agent-chat/useChatSessionHistory';
import { useChatSessionBootstrap } from '@/app/components/canvas-agent-chat/useChatSessionBootstrap';
import { useChatSessionMessages } from '@/app/components/canvas-agent-chat/useChatSessionMessages';
import { useComposerReferences } from '@/app/components/canvas-agent-chat/useComposerReferences';
import type {
  AgentProfile,
  AISession,
  Attachment,
  ChatMessage,
  ChatRequestContext,
  QueuePreviewItem,
  UserPiContent,
} from '@/app/lib/chat/types';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';

const CHAT_AGENT_ID = DEFAULT_AGENT_ID;

interface CanvasAgentChatProps {
  initialPrompt?: string | null;
  initialPromptStorageKey?: string;
  showSkillsLink?: boolean;
  hideNavHeader?: boolean;
  chatContainerWidth?: number;
  isSurfaceVisible?: boolean;
  forcedSessionId?: string | null;
  requestContext?: ChatRequestContext;
  onRuntimeStatusChange?: (status: RuntimeStatus | null) => void;
  onMediaClick?: (mediaUrl: string) => void;
}

const CHAT_REQUEST_TIMEOUT_MS = 30_000;
const ONBOARDING_CHAT_REQUEST_TIMEOUT_MS = 90_000;

function resolveAttachmentCategory(attachment: Attachment): string {
  const category = attachment.category || (attachment.contentKind === 'image' ? 'image' : 'document');
  return category;
}

function buildAttachmentContainerPath(attachment: Attachment): string {
  const category = resolveAttachmentCategory(attachment);
  return `/data/user-uploads/${category}/${attachment.id}`;
}

function buildPromptContent(text: string, attachments: Attachment[]): UserPiContent {
  if (attachments.length === 0) {
    return text;
  }

  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
  if (text) {
    content.push({ type: 'text', text });
  }

  for (const attachment of attachments) {
    const displayAttachment = deriveUploadAttachmentPreview(attachment);
    const category = resolveAttachmentCategory(displayAttachment);
    const containerFilePath = displayAttachment.filePath || buildAttachmentContainerPath(displayAttachment);
    const metadataLines = [
      `containerFilePath: ${containerFilePath}`,
      `fileId: ${displayAttachment.id}`,
      `mimeType: ${displayAttachment.mimeType || 'application/octet-stream'}`,
      `category: ${category}`,
      `contentKind: ${displayAttachment.contentKind}`,
    ];

    if (displayAttachment.previewUrl) {
      metadataLines.push(`previewUrl: ${displayAttachment.previewUrl}`);
    }

    if (displayAttachment.mediaUrl) {
      metadataLines.push(`mediaUrl: ${displayAttachment.mediaUrl}`);
    }

    content.push({
      type: 'text',
      text: `--- Attachment: ${displayAttachment.name} ---
${metadataLines.join('\n')}

[Agent-Hinweis: Verwende containerFilePath, wenn du die Datei per Tool lesen, kopieren, verschieben oder im Workspace organisieren sollst.]
--- Ende Attachment: ${displayAttachment.name} ---`,
    });

    if (displayAttachment.contentKind === 'image') {
      // Images: Use API URL (will be converted to Base64 by message-normalization.ts)
      // This keeps the existing image handling intact
      content.push({
        type: 'image',
        data: toUploadMediaUrl(displayAttachment.id),
        mimeType: displayAttachment.mimeType!,
      });
    }
  }

  return content;
}

function isTextareaAtHistoryBoundary(textarea: HTMLTextAreaElement, direction: 'older' | 'newer'): boolean {
  const { selectionStart, selectionEnd, value } = textarea;
  if (selectionStart !== selectionEnd) {
    return false;
  }

  if (direction === 'older') {
    return !value.slice(0, selectionStart).includes('\n');
  }

  return !value.slice(selectionEnd).includes('\n');
}

function getOptimisticSessionTitle(candidate: string | null | undefined, fallbackTitle: string): string {
  const trimmed = candidate?.trim();
  if (!trimmed) {
    return fallbackTitle;
  }

  return trimmed.slice(0, 48);
}

function formatContextTokens(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }

  return `${value}`;
}

export default function CanvasAgentChat({
  initialPrompt,
  initialPromptStorageKey,
  showSkillsLink = false,
  hideNavHeader = false,
  chatContainerWidth,
  isSurfaceVisible = true,
  forcedSessionId,
  requestContext,
  onRuntimeStatusChange,
  onMediaClick,
}: CanvasAgentChatProps) {
  const t = useTranslations('chat');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedSessionId = searchParams.get('session');
  const pathname = useLocalePathname();
  const sessionBasePath = pathname.includes('/chat') ? pathname : '/notebook';
  const resolvedRequestedSessionId = forcedSessionId ?? requestedSessionId;
  const isMobile = useIsMobile();
  const currentFile = useFileStore((s) => s.currentFile);
  const { planningMode, togglePlanningMode } = usePlanModeStore();
  const toolVerbosity = useToolVerbosityStore((s) => s.toolVerbosity);

  // Container width detection for history layout
  const containerRef = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const containerMeasureRafRef = useRef<number | null>(null);
  const HISTORY_BREAKPOINT = 650;
  const effectiveContainerWidth = chatContainerWidth ?? measuredWidth;
  const shouldShowHistoryAsOverlay = isMobile || effectiveContainerWidth < HISTORY_BREAKPOINT;

  useEffect(() => {
    if (chatContainerWidth !== undefined) return;
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => {
      containerMeasureRafRef.current = null;
      const nextWidth = Math.ceil(container.getBoundingClientRect().width);
      setMeasuredWidth((current) => (current === nextWidth ? current : nextWidth));
    };

    const scheduleWidthUpdate = () => {
      if (containerMeasureRafRef.current !== null) {
        cancelAnimationFrame(containerMeasureRafRef.current);
      }
      containerMeasureRafRef.current = requestAnimationFrame(updateWidth);
    };

    updateWidth();

    const resizeObserver = new ResizeObserver(scheduleWidthUpdate);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      if (containerMeasureRafRef.current !== null) {
        cancelAnimationFrame(containerMeasureRafRef.current);
        containerMeasureRafRef.current = null;
      }
    };
  }, [chatContainerWidth]);
  
  // WebSocket integration
  const { connected: wsConnected, error: wsError, subscribe, unsubscribe, request: wsRequest } = useWebSocket({
    autoConnect: false,
  });
  
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [oldestTimestamp, setOldestTimestamp] = useState<number | null>(null);
  const [oldestMessageId, setOldestMessageId] = useState<number | null>(null);
  const [oldestSequence, setOldestSequence] = useState<number | null>(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [input, setInput] = useState<string>('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showMobileDetails, setShowMobileDetails] = useState(false);
  const {
    activeModel,
    activeProvider,
    activeThinkingLevel,
    agentConfig,
    availableAgents,
    isAgentConfigLoading,
    selectedAgentId,
    setActiveModel,
    setActiveProvider,
    setActiveThinkingLevel,
    setSelectedAgentId,
    updateAgentModelSelection,
  } = useChatAgentConfig({
    initialAgentId: CHAT_AGENT_ID,
    sessionId,
  });
  const [hasUnreadInCurrentSession, setHasUnreadInCurrentSession] = useState(false);
  const [showUnreadBanner, setShowUnreadBanner] = useState(false);
  const [openQueueItemPopoverId, setOpenQueueItemPopoverId] = useState<string | null>(null);
  const [isResolvingInitialChatState, setIsResolvingInitialChatState] = useState(() => {
    if (initialPrompt?.trim() || resolvedRequestedSessionId) {
      return true;
    }
    if (typeof window === 'undefined') {
      return false;
    }
    const hasStoredInitialPrompt = Boolean(
      initialPromptStorageKey && window.sessionStorage.getItem(initialPromptStorageKey),
    );
    const hasStoredSession = Boolean(window.sessionStorage.getItem(CANVAS_CHAT_ACTIVE_SESSION_STORAGE_KEY));
    return hasStoredInitialPrompt || hasStoredSession;
  });
  const [expandedRunKeys, setExpandedRunKeys] = useState<Set<string>>(() => new Set());

  const isStudioChatContext = Boolean(requestContext?.currentPage?.startsWith('/studio') || pathname?.startsWith('/studio'));
  const starterPromptSource = isStudioChatContext ? STUDIO_STARTER_PROMPTS : BUSINESS_STARTER_PROMPTS;
  const starterPromptTranslationKey = isStudioChatContext ? 'studioStarterPrompts' : 'starterPrompts';
  const localizedStarterPrompts = starterPromptSource.map((prompt) => ({
    ...prompt,
    title: t(`${starterPromptTranslationKey}.${prompt.id}.title`),
    description: t(`${starterPromptTranslationKey}.${prompt.id}.description`),
    prompt: t(`${starterPromptTranslationKey}.${prompt.id}.prompt`),
  }));
  const [showComposerHint, setShowComposerHint] = useState(false);

  const isWebSocketUnavailable = wsError?.code === 'AUTH_ERROR';

  const sessionIdRef = useRef<string | null>(null);
  const {
    attachments,
    fileInputRef,
    handleAttachmentPreviewClose,
    handleAttachmentPreviewOpen,
    handleImagePreprocessConfirm,
    handleImagePreprocessOpenChange,
    handleImagePreprocessSkip,
    handleMediaPreviewClick,
    handlePaste,
    imagePreprocessFiles,
    isUploading,
    onFileChange,
    previewAttachment,
    previewAttachmentGroup,
    removeAttachment,
    setAttachments,
    setUploadError,
    uploadError,
  } = useChatAttachments({ onMediaClick });
  const {
    composerHeight,
    composerRef,
    composerWidth,
    textareaHeight,
    textareaRef,
  } = useChatComposerLayout({ input, isMobile });
  const {
    isAtBottom,
    isAtBottomRef,
    messagesEndRef,
    scrollContainerRef,
    scrollContentRef,
    scrollToBottom,
    showScrollButton,
  } = useChatScrollController({ messages });
  const initialPromptConsumedRef = useRef(false);
  const requestedSessionCleanupRef = useRef<string | null>(null);
  const optimisticSessionTitlesRef = useRef<Record<string, string>>({});
  const sessionAgentIdRef = useRef<string>(CHAT_AGENT_ID);
  const surfaceVisibleRef = useRef(isSurfaceVisible);
  const userStartedNewChatRef = useRef(false);
  const refreshSavedMessagesRef = useRef<((sessionId: string) => void) | null>(null);
  const requestSavedMessageRefreshRef = useRef<((sessionId: string) => void) | null>(null);
  const deferredSavedMessageRefreshSessionRef = useRef<string | null>(null);
  const subscribedSessionAckRef = useRef<string | null>(null);
  const subscribedSessionRequestRef = useRef<{ sessionId: string; promise: Promise<void> } | null>(null);
  const skipNextSessionStatusRefreshRef = useRef<string | null>(null);
  const {
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
    setTotalUnreadCount,
    startHistoryResizing,
    totalUnreadCount,
  } = useChatSessionHistory({
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
  });
  const {
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
  } = useChatRuntimeEvents({
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
  });
  useEffect(() => {
    requestSavedMessageRefreshRef.current = requestSavedMessageRefresh;
    return () => {
      if (requestSavedMessageRefreshRef.current === requestSavedMessageRefresh) {
        requestSavedMessageRefreshRef.current = null;
      }
    };
  }, [requestSavedMessageRefresh]);
  const {
    navigateInputHistory,
    resetInputHistoryNavigation,
  } = useChatComposerDraft({
    input,
    messages,
    sessionIdRef,
    setInput,
    textareaRef,
  });
  const {
    activeReferenceMatch,
    closeReferencePicker,
    handleInputChange,
    handleReferenceSelect,
    isLoadingReferenceItems,
    referencePickerItems,
    referencePickerRef,
    selectedReferenceIndex,
    selectNextReference,
    selectPreviousReference,
  } = useComposerReferences({
    input,
    resetInputHistoryNavigation,
    setInput,
    textareaRef,
  });

  const buildRequestContext = useCallback((activeFilePath: string | null): ChatRequestContext => ({
    activeFilePath,
    userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    currentTime: new Date().toISOString(),
    planningMode,
    currentPage: typeof window !== 'undefined' ? window.location.pathname : undefined,
    ...requestContext,
  }), [planningMode, requestContext]);

  const ensureSessionSubscribed = useCallback(async (targetSessionId: string) => {
    if (subscribedSessionAckRef.current === targetSessionId) {
      return;
    }

    if (subscribedSessionRequestRef.current?.sessionId === targetSessionId) {
      await subscribedSessionRequestRef.current.promise;
      return;
    }

    const promise = subscribe(targetSessionId)
      .then((payload) => {
        if (payload.success === false) {
          throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to subscribe to chat session');
        }
        if (subscribedSessionRequestRef.current?.sessionId === targetSessionId) {
          subscribedSessionAckRef.current = targetSessionId;
        }
      })
      .finally(() => {
        if (subscribedSessionRequestRef.current?.sessionId === targetSessionId) {
          subscribedSessionRequestRef.current = null;
        }
      });

    subscribedSessionRequestRef.current = { sessionId: targetSessionId, promise };
    await promise;
  }, [subscribe]);

  // Session subscription for WebSocket
  useEffect(() => {
    if (!wsConnected || !sessionId) {
      if (!wsConnected) {
        subscribedSessionAckRef.current = null;
        subscribedSessionRequestRef.current = null;
      }
      return;
    }

    void ensureSessionSubscribed(sessionId)
      .then(() => {
        console.log(`[CanvasAgentChat] Subscribed to session ${sessionId}`);
      })
      .catch((error) => {
        console.error(`[CanvasAgentChat] Failed to subscribe to session ${sessionId}`, error);
      });

    return () => {
      if (subscribedSessionAckRef.current === sessionId) {
        subscribedSessionAckRef.current = null;
      }
      if (subscribedSessionRequestRef.current?.sessionId === sessionId) {
        subscribedSessionRequestRef.current = null;
      }
      unsubscribe(sessionId);
      console.log(`[CanvasAgentChat] Unsubscribed from session ${sessionId}`);
    };
  }, [ensureSessionSubscribed, wsConnected, sessionId, unsubscribe]);

  // Session is created on-demand when user sends first message

  useEffect(() => {
    sessionIdRef.current = sessionId;
    resetInputHistoryNavigation();
    // Persist active session so mobile can restore it after Sheet unmount/remount.
    // Only write non-null values here — clearing is handled explicitly by startNewChat.
    // If we cleared on null, a fresh mount (sessionId=null) would erase the stored value
    // before the restore effect has a chance to read it.
    if (typeof window !== 'undefined' && sessionId) {
      window.sessionStorage.setItem(CANVAS_CHAT_ACTIVE_SESSION_STORAGE_KEY, sessionId);
    }
  }, [resetInputHistoryNavigation, sessionId]);

  useEffect(() => {
    surfaceVisibleRef.current = isSurfaceVisible;

    window.dispatchEvent(new CustomEvent('chat-active-session-changed', {
      detail: {
        sessionId: isSurfaceVisible ? sessionId : null,
        isVisible: isSurfaceVisible,
      },
    }));

    return () => {
      window.dispatchEvent(new CustomEvent('chat-active-session-changed', {
        detail: {
          sessionId: null,
          isVisible: false,
        },
      }));
    };
  }, [isSurfaceVisible, sessionId]);

  const refreshRuntimeStatus = useCallback(async (targetSessionId: string) => {
    try {
      await ensureSessionSubscribed(targetSessionId);
      const payload = await wsRequest<{ success: boolean; status?: RuntimeStatus }>('get_status', {
        sessionId: targetSessionId,
      });
      if (payload.success && payload.status) {
        setRuntimeStatusWithReconciliation(payload.status as RuntimeStatus);
      }
    } catch (error) {
      console.error('Failed to load runtime status', error);
    }
  }, [ensureSessionSubscribed, setRuntimeStatusWithReconciliation, wsRequest]);

  const ensureSession = useCallback(async (preferredTitle?: string) => {
    if (sessionIdRef.current) {
      return sessionIdRef.current;
    }

    const agentId = selectedAgentId;
    const sessionAgentConfig = isAgentConfigForAgent(agentConfig, agentId) ? agentConfig : null;
    const configuredModelState = resolveAgentModelState(sessionAgentConfig);
    const requestedModel = activeModel.trim() || configuredModelState?.model || '';
    const requestedThinkingLevel = activeModel.trim()
      ? activeThinkingLevel
      : configuredModelState?.thinkingLevel || activeThinkingLevel;
    const optimisticTitle = getOptimisticSessionTitle(preferredTitle ?? input, t('newChatTitle'));
    const requestedTitle = isAutomaticSessionTitle(optimisticTitle) ? undefined : optimisticTitle;

    const createSessionPayload = await createChatSession({
      agentId,
      ...(requestedTitle ? { title: requestedTitle } : {}),
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(requestedThinkingLevel ? { thinkingLevel: requestedThinkingLevel } : {}),
    });

    if (!createSessionPayload?.success || !createSessionPayload.session?.sessionId) {
      throw new Error(createSessionPayload?.error || 'Failed to create session');
    }

    const nextSessionId = createSessionPayload.session.sessionId as string;
    const createdProvider = createSessionPayload.session.provider || activeProvider;
    const createdModel = createSessionPayload.session.model || activeModel;
    const createdThinkingLevel = createSessionPayload.session.thinkingLevel || activeThinkingLevel;

    skipNextSessionStatusRefreshRef.current = nextSessionId;
    setSessionId(nextSessionId);
    setActiveProvider(createdProvider);
    setActiveModel(createdModel);
    setActiveThinkingLevel(createdThinkingLevel);
    sessionAgentIdRef.current = agentId;

    const tempTitle = requestedTitle || getOptimisticSessionTitle(preferredTitle ?? input, createSessionPayload.session.title || t('newChatTitle'));
    setSessionTitle(tempTitle);
    if (!isAutomaticSessionTitle(tempTitle)) {
      optimisticSessionTitlesRef.current[nextSessionId] = tempTitle;
    }

    sessionIdRef.current = nextSessionId;

    // Add new session to history immediately so it appears in the sidebar
    const newSession: AISession = {
      id: Date.now(), // temporary id for local state
      sessionId: nextSessionId,
      title: tempTitle,
      agentId: createSessionPayload.session.agentId || agentId,
      model: createdModel,
      provider: createdProvider,
      thinkingLevel: createdThinkingLevel,
      createdAt: new Date().toISOString(),
      engine: createSessionPayload.session.engine || 'pi',
      lastMessageAt: new Date().toISOString(),
      hasUnread: false, // User just created it, so no unread messages
      creator: createSessionPayload.session.creator,
    };

    addSessionToHistory(newSession);

    // Note: Subscription happens automatically via useEffect when sessionId changes
    // No need to subscribe here manually to avoid double subscription

    return nextSessionId;
  }, [activeModel, activeProvider, activeThinkingLevel, addSessionToHistory, agentConfig, input, selectedAgentId, setActiveModel, setActiveProvider, setActiveThinkingLevel, t]);

  const postControl = useCallback(async (
    targetSessionId: string,
    action: 'follow_up' | 'steer' | 'promote_queued_to_steer' | 'remove_queued_item' | 'abort' | 'replace' | 'compact',
    message?: Extract<AgentMessage, { role: 'user' }>,
    queueItemId?: string,
  ) => {
    const payload = await wsRequest<{ success: boolean; status?: RuntimeStatus; error?: string }>('control', {
      sessionId: targetSessionId,
      action,
      ...(message ? { message } : {}),
      ...(queueItemId ? { queueItemId } : {}),
    });

    if (payload.status) {
      setRuntimeStatusWithReconciliation(payload.status as RuntimeStatus);
      return payload.status as RuntimeStatus;
    }

    return null;
  }, [setRuntimeStatusWithReconciliation, wsRequest]);

  const scanForImageReferences = useCallback(async (): Promise<Attachment[]> => {
    // This function is disabled for now - it would need a different approach
    // with the new ID-based system. Images need to be explicitly uploaded.
    return [];
  }, []);

  const runtimePhase = runtimeStatus?.phase;
  const chatRequestTimeoutMs = requestContext?.currentPage === 'onboarding'
    ? ONBOARDING_CHAT_REQUEST_TIMEOUT_MS
    : CHAT_REQUEST_TIMEOUT_MS;

  useEffect(() => {
    onRuntimeStatusChange?.(runtimeStatus);
  }, [onRuntimeStatusChange, runtimeStatus]);

  const handleControlAction = useCallback(async (
    action: 'send' | 'steer' | 'follow_up' | 'replace',
    override?: { text: string; attachments: Attachment[] },
  ) => {
    if (!override && isUploading) {
      return;
    }

    const sendShouldQueue = action === 'send' && runtimePhase !== undefined && runtimePhase !== 'idle';
    const effectiveAction = sendShouldQueue ? 'follow_up' : action;
    const rawText = override?.text ?? input.trim();
    const baseAttachments = override?.attachments ?? attachments;

    if (!rawText && baseAttachments.length === 0) {
      return;
    }

    const effectiveAgentConfig = isAgentConfigForAgent(agentConfig, selectedAgentId) ? agentConfig : null;
    const configuredModelState = resolveAgentModelState(effectiveAgentConfig);
    const effectiveModel = activeModel.trim() || configuredModelState?.model || '';

    if (!effectiveModel.trim()) {
      throw new Error(t('modelRequiredError'));
    }

    if (!activeModel.trim() && configuredModelState) {
      setActiveProvider(configuredModelState.provider);
      setActiveModel(configuredModelState.model);
      setActiveThinkingLevel(configuredModelState.thinkingLevel);
    }

    // Close history when sending message (always on mobile, conditionally on desktop)
    if (showHistory && (isMobile || shouldShowHistoryAsOverlay)) {
      setShowHistory(false);
    }

    const autoAttachments = override ? [] : await scanForImageReferences();
    const messageAttachments = [...baseAttachments, ...autoAttachments];
    const userMessage: Extract<AgentMessage, { role: 'user' }> = {
      role: 'user',
      content: buildPromptContent(rawText, messageAttachments),
      timestamp: Date.now(),
    };

    resetInputHistoryNavigation();
    setInput('');
    setAttachments([]);
    removeComposerDraft(sessionIdRef.current ?? '__new__');

    const optimisticStatus: ChatMessage['status'] = effectiveAction === 'follow_up'
      ? 'queued_follow_up'
      : effectiveAction === 'steer'
        ? 'queued_steering'
        : effectiveAction === 'replace'
          ? 'aborting'
          : 'pending';
    const optimisticQueueKind = effectiveAction === 'follow_up'
      ? 'follow_up'
      : effectiveAction === 'steer'
        ? 'steer'
        : undefined;
    const optimisticMessageId = effectiveAction === 'follow_up'
      ? null
      : appendOptimisticUserMessage(rawText, messageAttachments, optimisticStatus, optimisticQueueKind, userMessage);
    const optimisticAssistantId = effectiveAction === 'send' ? createAssistantBubble() : null;
    setIsResolvingInitialChatState(false);

    const activeFilePath = currentFile?.path ?? null;

    try {
      const targetSessionId = await ensureSession(rawText);
      setOptimisticRuntimePhase('streaming', targetSessionId);
      await ensureSessionSubscribed(targetSessionId);
      const payload = effectiveAction === 'send'
        ? await wsRequest<{ success: boolean; status?: RuntimeStatus; error?: string }>('send_message', {
          sessionId: targetSessionId,
          message: userMessage as unknown as Record<string, unknown>,
          context: buildRequestContext(activeFilePath),
        }, chatRequestTimeoutMs)
        : { status: await postControl(targetSessionId, effectiveAction, userMessage) };

      if (optimisticMessageId) {
        setMessages((prev) => prev.map((message) => (
          message.id === optimisticMessageId ? { ...message, status: 'sent' as const } : message
        )));
      }

      if (payload.status) {
        setRuntimeStatusWithReconciliation(payload.status as RuntimeStatus);
      }
    } catch (error) {
      if (optimisticMessageId) {
        setMessages((prev) => prev.map((message) => (
          message.id === optimisticMessageId ? { ...message, status: 'error' as const } : message
        )));
      }
      if (optimisticAssistantId) {
        setMessages((prev) => prev.filter((message) => message.id !== optimisticAssistantId));
        clearCurrentAssistant(optimisticAssistantId);
      }
      throw error;
    }

    return;
  }, [activeModel, agentConfig, appendOptimisticUserMessage, attachments, buildRequestContext, chatRequestTimeoutMs, clearCurrentAssistant, createAssistantBubble, currentFile, ensureSession, ensureSessionSubscribed, input, isUploading, postControl, resetInputHistoryNavigation, runtimePhase, selectedAgentId, setActiveModel, setActiveProvider, setActiveThinkingLevel, showHistory, isMobile, setAttachments, setOptimisticRuntimePhase, setRuntimeStatusWithReconciliation, shouldShowHistoryAsOverlay, scanForImageReferences, t, wsRequest]);

  const handleSend = useCallback(async () => {
    try {
      await handleControlAction('send');
    } catch (error) {
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendSystemMessage, handleControlAction, t]);

  const handlePromoteQueuedMessage = useCallback(async (queueItemId: string) => {
    if (!sessionIdRef.current) return;
    try {
      await postControl(sessionIdRef.current, 'promote_queued_to_steer', undefined, queueItemId);
    } catch (error) {
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendSystemMessage, postControl, t]);

  const handleRemoveQueuedMessage = useCallback(async (queueItemId: string) => {
    if (!sessionIdRef.current) return;
    try {
      await postControl(sessionIdRef.current, 'remove_queued_item', undefined, queueItemId);
    } catch (error) {
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendSystemMessage, postControl, t]);

  const handleStop = useCallback(async () => {
    if (!sessionIdRef.current) return;
    try {
      await postControl(sessionIdRef.current, 'abort');
    } catch (error) {
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendSystemMessage, postControl, t]);

  const handleEditQueuedMessage = useCallback(async (entry: QueuePreviewItem) => {
    if (!sessionIdRef.current) return;
    try {
      // 1. Find matching local message to restore attachments
      let messageAttachments: Attachment[] = [];
      if (entry.signature) {
        const matchingMessage = messages.find(
          (msg) =>
            msg.role === 'user' &&
            getQueuedSignatureFromPiMessage(msg.piMessage) === entry.signature,
        );
        if (matchingMessage?.attachments) {
          messageAttachments = matchingMessage.attachments;
        }
      } else {
        const matchingMessage = messages.find(
          (msg) =>
            msg.role === 'user' &&
            msg.content === entry.text &&
            countPiMessageImageAttachments(msg.piMessage) === entry.attachmentCount,
        );
        if (matchingMessage?.attachments) {
          messageAttachments = matchingMessage.attachments;
        }
      }

      // 2. Remove from queue
      await postControl(sessionIdRef.current, 'remove_queued_item', undefined, entry.id);

      // 3. Load into composer
      setInput(entry.text);
      setAttachments(messageAttachments);
      setOpenQueueItemPopoverId(null);
      textareaRef.current?.focus();
    } catch (error) {
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [messages, postControl, appendSystemMessage, t, setInput, setAttachments, textareaRef]);

  const handleCompact = useCallback(async () => {
    if (!sessionIdRef.current) return;
    try {
      const status = await postControl(sessionIdRef.current, 'compact');
      if (status?.lastCompactionAt && status.lastCompactionKind) {
        if (status.lastCompactionOmittedCount === 0) {
          appendSystemMessage(t('compactAlreadyOptimized'));
        } else {
          appendCompactionBreak(status.lastCompactionKind, status.lastCompactionAt, status.lastCompactionOmittedCount || 0);
        }
      }
    } catch (error) {
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendCompactionBreak, appendSystemMessage, postControl, t]);

  const startNewChat = useCallback((agentIdOverride?: string) => {
    const nextAgentId = agentIdOverride || selectedAgentId;
    resetStreamConnection();
    setRuntimeStatus(null);
    setSessionId(null);
    setSessionTitle(null);
    resetInputHistoryNavigation();
    // Persist any unsent text from the previous session before switching to new chat
    const currentSessionId = sessionIdRef.current;
    if (currentSessionId && input.trim()) {
      saveComposerDraft(currentSessionId, input);
    }
    const newChatDraft = loadComposerDraft('__new__');
    setInput(newChatDraft ?? '');
    setAttachments([]);
    sessionIdRef.current = null;
    sessionAgentIdRef.current = nextAgentId;
    resetRuntimeMessageRefs();
    userStartedNewChatRef.current = true;
    // Clear persisted session so reopening chat doesn't restore this session
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(CANVAS_CHAT_ACTIVE_SESSION_STORAGE_KEY);
    }
    setMessages([]);
    setHasMoreBefore(false);
    setOldestTimestamp(null);
    setOldestSequence(null);
    setIsLoadingOlder(false);
    setExpandedRunKeys(new Set());
    // Always close history on mobile when starting new chat, conditionally on desktop
    if (isMobile || shouldShowHistoryAsOverlay) {
      setShowHistory(false);
    }
    setShowMobileDetails(false);
    const isCurrentAgentConfig = agentConfig?.effectiveConfig?.agentId
      ? agentConfig.effectiveConfig.agentId === nextAgentId
      : nextAgentId === selectedAgentId;
    const providerState = isCurrentAgentConfig
      ? resolveAgentProviderState(agentConfig)
      : { provider: DEFAULT_PROVIDER_ID, model: DEFAULT_MODEL_ID, thinkingLevel: DEFAULT_THINKING_LEVEL };
    setActiveProvider(providerState.provider);
    setActiveModel(providerState.model);
    setActiveThinkingLevel(providerState.thinkingLevel);
  }, [agentConfig, input, resetInputHistoryNavigation, resetRuntimeMessageRefs, resetStreamConnection, selectedAgentId, setActiveModel, setActiveProvider, setActiveThinkingLevel, isMobile, setAttachments, setRuntimeStatus, shouldShowHistoryAsOverlay]);

  const selectChatAgent = useCallback((agentId: string) => {
    if (agentId === selectedAgentId && !sessionIdRef.current) {
      return;
    }
    setSelectedAgentId(agentId);
    setHistoryAgentFilter(agentId);
    resetHistoryState();
    startNewChat(agentId);
    void fetchHistory();
  }, [fetchHistory, resetHistoryState, selectedAgentId, setSelectedAgentId, startNewChat, setHistoryAgentFilter]);

  const { loadOlderMessages, loadSession } = useChatSessionMessages({
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
  });

  const clearSessionParamFromUrl = useCallback(() => {
    if (typeof window === 'undefined' || !window.location.search.includes('session=')) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    params.delete('session');
    const nextQuery = params.toString();
    const nextUrl = nextQuery ? `${pathname}?${nextQuery}` : pathname;
    router.replace(nextUrl, { scroll: false });
  }, [pathname, router]);

  const deleteSession = useCallback(async (id: string) => {
    if (!confirm(t('deleteSessionConfirm'))) return;

    try {
      const targetSession = history.find((session) => session.sessionId === id);
      const data = await deleteChatSessionRequest(targetSession?.agentId || selectedAgentId, id);
      if (data?.success) {
        removeCachedChatSession(id, targetSession?.agentId || selectedAgentId);
        removeComposerDraft(id);
        setHistory((prev) => prev.filter((session) => session.sessionId !== id));
        if (sessionIdRef.current === id) {
          startNewChat();
        }
      }
    } catch (err) {
      console.error('Failed to delete session', err);
    }
  }, [history, selectedAgentId, setHistory, startNewChat, t]);

  const renameSession = useCallback(async (session: AISession) => {
    const nextTitle = prompt(t('renameSessionPrompt'), getSessionDisplayTitle(session.title, t('newChatTitle')));
    if (!nextTitle || !nextTitle.trim()) return;

    try {
      const data = await patchChatSessions({ agentId: session.agentId || selectedAgentId, sessionId: session.sessionId, title: nextTitle.trim() });
      if (data?.success) {
        optimisticSessionTitlesRef.current[session.sessionId] = nextTitle.trim();
        updateCachedChatSessionTitle(session.sessionId, nextTitle.trim(), session.agentId || selectedAgentId);
        setHistory((prev) => prev.map((item) => (item.sessionId === session.sessionId ? { ...item, title: nextTitle.trim() } : item)));
        if (sessionIdRef.current === session.sessionId) {
          setSessionTitle(nextTitle.trim());
        }
      }
    } catch (err) {
      console.error('Failed to rename session', err);
    }
  }, [selectedAgentId, setHistory, t]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.shiftKey && e.key === 'Tab') {
      e.preventDefault();
      togglePlanningMode();
      return;
    }

    if (activeReferenceMatch && e.key === 'Escape') {
      e.preventDefault();
      closeReferencePicker();
      return;
    }

    if (e.key === 'Escape') {
      const status = runtimeStatusRef.current;
      if (status && status.phase !== 'idle' && status.phase !== 'aborting' && status.canAbort && !isWebSocketUnavailable) {
        e.preventDefault();
        void handleStop();
        return;
      }
    }

    if (activeReferenceMatch && referencePickerItems.length > 0) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          selectNextReference();
          return;
        case 'ArrowUp':
          e.preventDefault();
          selectPreviousReference();
          return;
        case 'Enter':
        case 'Tab':
          e.preventDefault();
          if (referencePickerItems[selectedReferenceIndex]) {
            handleReferenceSelect(referencePickerItems[selectedReferenceIndex]);
          }
          return;
      }
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const direction = e.key === 'ArrowUp' ? 'older' : 'newer';
      if (isTextareaAtHistoryBoundary(e.currentTarget, direction) && navigateInputHistory(direction)) {
        e.preventDefault();
      }
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }, [activeReferenceMatch, closeReferencePicker, handleReferenceSelect, handleSend, handleStop, isWebSocketUnavailable, navigateInputHistory, referencePickerItems, runtimeStatusRef, selectNextReference, selectedReferenceIndex, selectPreviousReference, togglePlanningMode]);

  useChatSessionBootstrap({
    addSessionToHistory,
    agentConfig,
    appendSystemMessage,
    clearSessionParamFromUrl,
    fetchHistory,
    forcedSessionId,
    handleControlAction,
    hasLoadedSessionListRef,
    historyLength: history.length,
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
  });

  // Poll runtime status only while the agent is active; fetch once on session switch
  const isAgentActive = runtimeStatus != null && runtimeStatus.phase !== 'idle';
  const handleModelChange = useCallback((next: AgentModelState) => {
    updateAgentModelSelection(next);
    setHistory((items) => items.map((item) => (
      item.sessionId === sessionIdRef.current
        ? { ...item, model: next.model, provider: next.provider, thinkingLevel: next.thinkingLevel }
        : item
    )));
  }, [setHistory, updateAgentModelSelection]);

  const invalidateRuntimeAfterModelChange = useCallback(async () => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) {
      return;
    }
    try {
      await wsRequest('change_model', { sessionId: currentSessionId }, 5000);
    } catch (error) {
      console.warn('Runtime invalidation after model change did not complete over WebSocket', error);
    }
    await refreshRuntimeStatus(currentSessionId);
  }, [refreshRuntimeStatus, wsRequest]);

  useEffect(() => {
    if (!sessionId) return;
    if (skipNextSessionStatusRefreshRef.current === sessionId) {
      skipNextSessionStatusRefreshRef.current = null;
      return;
    }
    void refreshRuntimeStatus(sessionId);
  }, [refreshRuntimeStatus, sessionId]);

  useEffect(() => {
    if (!sessionId || !isAgentActive) return;
    const interval = setInterval(() => {
      void refreshRuntimeStatus(sessionId);
    }, 4000);
    return () => clearInterval(interval);
  }, [refreshRuntimeStatus, sessionId, isAgentActive]);

  useEffect(() => () => {
    resetStreamConnection();
  }, [resetStreamConnection]);

  useEffect(() => {
    if (!isMobile) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setShowMobileDetails(false);
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [isMobile]);

  const totalQueuedMessages = (runtimeStatus?.followUpQueue.length || 0) + (runtimeStatus?.steeringQueue.length || 0);
  const isRuntimeBusy = Boolean(runtimeStatus && runtimeStatus.phase !== 'idle');
  const queueItems: QueuePreviewItem[] = [
    ...(runtimeStatus?.steeringQueue || []).map((entry) => ({ ...entry, kind: 'steer' as const })),
    ...(runtimeStatus?.followUpQueue || []).map((entry) => ({ ...entry, kind: 'follow_up' as const })),
  ];
  const activeToolDisplay = runtimeStatus?.activeTool ? getToolDisplayInfo(runtimeStatus.activeTool.name, locale) : null;
  const contextCompactLabel = runtimeStatus
    ? t('contextCompactLabel', {
        used: formatContextTokens(runtimeStatus.estimatedHistoryTokens),
        available: formatContextTokens(runtimeStatus.availableHistoryTokens),
      })
    : t('noSessionYet');
  const contextDetailedLabel = runtimeStatus
    ? t('contextLabel', {
        used: formatContextTokens(runtimeStatus.estimatedHistoryTokens),
        available: formatContextTokens(runtimeStatus.availableHistoryTokens),
        window: formatContextTokens(runtimeStatus.contextWindow),
      })
    : t('noSessionYet');
  const contextTooltip = runtimeStatus
    ? t('contextTooltip', {
        percent: runtimeStatus.contextUsagePercent,
        used: formatContextTokens(runtimeStatus.estimatedHistoryTokens),
        available: formatContextTokens(runtimeStatus.availableHistoryTokens),
        window: formatContextTokens(runtimeStatus.contextWindow),
        reserved: formatContextTokens(Math.max(0, runtimeStatus.contextWindow - runtimeStatus.availableHistoryTokens)),
      })
    : t('noSessionYet');
  const contextProgressPercent = Math.min(100, Math.max(0, runtimeStatus?.contextUsagePercent ?? 0));
  const sessionDisplayLabel = getSessionDisplayTitle(sessionTitle, t('newChatTitle'));
  const hasComposerContent = Boolean(input.trim()) || attachments.length > 0;
  const primaryActionIsStop = isRuntimeBusy && !hasComposerContent;
  const isRuntimeAborting = runtimeStatus?.phase === 'aborting';
  const primaryActionLabel = primaryActionIsStop ? (isRuntimeAborting ? t('stopping') : t('stop')) : t('sendAction');
  const selectedAgentConfig = isAgentConfigForAgent(agentConfig, selectedAgentId) ? agentConfig : null;
  const selectedAgentModelState = resolveAgentModelState(selectedAgentConfig);
  const effectiveActiveProvider = activeProvider || selectedAgentModelState?.provider || DEFAULT_PROVIDER_ID;
  const effectiveActiveModel = activeModel || selectedAgentModelState?.model || DEFAULT_MODEL_ID;
  const effectiveActiveThinkingLevel = activeModel
    ? activeThinkingLevel
    : selectedAgentModelState?.thinkingLevel || activeThinkingLevel;
  const isModelConfigured = Boolean(effectiveActiveModel.trim());
  const primaryActionDisabled = primaryActionIsStop
    ? isRuntimeAborting || !runtimeStatus?.canAbort || isWebSocketUnavailable
    : isUploading || !hasComposerContent || isWebSocketUnavailable || !isModelConfigured;
  const isModelConfigurationLoading = isAgentConfigLoading && !isModelConfigured;
  const showModelRequiredNotice = !isModelConfigured && !isModelConfigurationLoading;
  const isHistoryOverlayOpen = showHistory && shouldShowHistoryAsOverlay;
  const scrollContentPadding = isHistoryOverlayOpen ? 24 : composerHeight + 24;
  const scrollButtonOffset = isHistoryOverlayOpen ? 16 : composerHeight + 16;
  const isCompactComposer = composerWidth > 0 && composerWidth < 520;
  const isCompactView = isMobile || (composerWidth > 0 && composerWidth < 640);
  const showInitialChatLoader = messages.length === 0 && isResolvingInitialChatState;
  const showStarterScreen = messages.length === 0 && !sessionId && !isResolvingInitialChatState;
  const activeSessionAgentId = history.find((session) => session.sessionId === sessionId)?.agentId || selectedAgentId;
  const activeAgentProfile = agentProfilesById.get(activeSessionAgentId);
  const activeAgentDisplayName = activeAgentProfile?.name || getAgentDisplayName(activeSessionAgentId);
  const chatAgentOptions = useMemo<AgentProfile[]>(() => (
    availableAgents.length > 0
      ? availableAgents
      : [{ agentId: CHAT_AGENT_ID, name: 'Canvas Agent', iconId: 'bot', type: 'main', removable: false }]
  ), [availableAgents]);

  const historyPanelProps: Omit<ChatHistoryPanelProps, 'variant' | 'width' | 'onBackToChat'> = {
    history,
    filteredHistory,
    historySearchQuery,
    historyUnreadOnly,
    historyAgentFilter,
    historyAgentOptions,
    totalUnreadCount,
    currentSessionId: sessionId,
    agentProfilesById,
    groupLabels: historyGroupLabels,
    labels: historyPanelLabels,
    onSearchQueryChange: setHistorySearchQuery,
    onUnreadOnlyChange: setHistoryUnreadOnly,
    onAgentFilterChange: setHistoryAgentFilter,
    onMarkAllAsRead: markAllAsRead,
    onLoadSession: loadSession,
    onRenameSession: renameSession,
    onDeleteSession: deleteSession,
  };

  const toggleRunDisclosure = useCallback((runKey: string) => {
    setExpandedRunKeys((current) => {
      const next = new Set(current);
      if (next.has(runKey)) {
        next.delete(runKey);
      } else {
        next.add(runKey);
      }
      return next;
    });
  }, []);

  const applyStarterPrompt = useCallback((value: string) => {
    setInput(value);
    // Always close history on mobile when applying starter prompt
    if (isMobile || shouldShowHistoryAsOverlay) {
      setShowHistory(false);
    }
    textareaRef.current?.focus();
  }, [shouldShowHistoryAsOverlay, isMobile, textareaRef]);

  const composerPlaceholder = isMobile
    ? t('composerPlaceholderMobile')
    : isCompactComposer
      ? t('composerPlaceholderCompact')
      : t('composerPlaceholderDefault');
  const composerPlaceholderText = isModelConfigurationLoading
    ? t('modelLoadingPlaceholder')
    : showModelRequiredNotice
      ? t('modelRequiredPlaceholder')
      : isWebSocketUnavailable
        ? t('liveUpdatesUnavailable')
        : composerPlaceholder;
  const composerHint =
    isRuntimeBusy
      ? isMobile
        ? t('composerHintBusyMobile')
        : t('composerHintBusyDesktop')
      : t('composerHintIdle');
  const composerDisabled = isUploading || isWebSocketUnavailable;
  const activeReferenceKind = activeReferenceMatch?.kind;
  const referencePickerHeader = activeReferenceKind === 'skill'
    ? isLoadingReferenceItems
      ? t('loadingSkills')
      : t('skillsFound', { count: referencePickerItems.length })
    : isLoadingReferenceItems
      ? t('loadingFiles')
      : t('filesFound', { count: referencePickerItems.length });
  const referencePickerEmptyState = activeReferenceKind === 'skill'
    ? activeReferenceMatch?.query
      ? t('noSkillsFoundMatching', { query: activeReferenceMatch.query })
      : t('noSkillsAvailable')
    : activeReferenceMatch?.query
      ? t('noFilesFoundMatching', { query: activeReferenceMatch.query })
      : t('noFilesInWorkspace');

  return (
    <div ref={containerRef} className="relative flex h-full flex-col overflow-hidden bg-card text-card-foreground">
      {!hideNavHeader && (
      <header className="z-40 h-16 flex-shrink-0 border-b border-border bg-background/95 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-full items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className="gap-2 px-2 sm:px-3">
              <Link href="/">
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">{tCommon('suite')}</span>
              </Link>
            </Button>
            <h1 className="hidden md:block text-lg md:text-2xl font-bold truncate">{t('title')}</h1>
          </div>
          <div className="flex items-center gap-1.5 md:gap-4">
            <ThemeToggle />
            <Button asChild variant="outline" size="sm" className="hidden gap-2 px-2 sm:px-3 md:inline-flex">
              <Link href="/usage">{t('usage')}</Link>
            </Button>

          </div>
        </div>
      </header>
      )}

      {/* Compact Header Row */}
      <div className={cn('z-10 border-b border-border bg-background/95', isHistoryOverlayOpen ? 'hidden' : null)}>
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <div className="flex min-w-[12rem] flex-1 items-center gap-2 overflow-hidden">
            {showHistory ? (
              <button
                type="button"
                aria-label={t('backToChat')}
                onClick={() => setShowHistory(false)}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent transition-colors hover:border-border hover:bg-accent"
                title={t('backToChat')}
              >
                <ChevronLeft size={18} />
              </button>
            ) : (
              <button
                type="button"
                data-testid="chat-history-toggle"
                aria-label={t('toggleSidebar')}
                onClick={() => setShowHistory(true)}
                className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent transition-colors hover:border-border hover:bg-accent"
                title={t('toggleSidebar')}
              >
                <History size={18} />
                {totalUnreadCount > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-blue-500 text-[9px] font-bold text-white">
                    {totalUnreadCount > 9 ? '9+' : totalUnreadCount}
                  </span>
                )}
              </button>
            )}
            <div className="min-w-0 flex-1">
              {isMobile ? (
                <span className="block truncate text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">{t('canvasChatLabel')}</span>
              ) : (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {/* Session Badge */}
                  <div
                    data-testid="chat-session-id"
                    title={sessionId || t('newChatTitle')}
                    className="inline-flex h-8 min-w-0 max-w-[min(18rem,100%)] items-center gap-1.5 rounded-md border border-border/60 bg-muted/50 px-2 text-[11px] font-medium text-foreground"
                  >
                    <span className="text-[9px] uppercase tracking-[0.15em] text-muted-foreground">{t('sessionLabel')}</span>
                    <span className="min-w-0 truncate">{sessionDisplayLabel}</span>
                  </div>
                  <ChatAgentSelector
                    variant="desktop"
                    activeAgentId={activeSessionAgentId}
                    activeAgentName={activeAgentDisplayName}
                    activeAgentIconId={activeAgentProfile?.iconId}
                    agents={chatAgentOptions}
                    onSelectAgent={selectChatAgent}
                  />
                </div>
              )}
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label={t('newChatTitle')}
              onClick={() => startNewChat()}
              className="group inline-flex h-8 items-center gap-1 rounded-md border border-primary/30 bg-primary/15 px-2.5 text-primary transition-all hover:bg-primary/25"
              title={t('newChatTitle')}
            >
              <Plus size={16} />
              <span className="hidden text-[11px] font-bold sm:inline">{t('newChatShort')}</span>
            </button>
            {showSkillsLink && (
              <Link
                href="/settings?tab=skills"
                aria-label={t('viewSkills')}
                className="group inline-flex h-8 items-center gap-1 rounded-md border border-border bg-muted/50 px-2.5 text-muted-foreground transition-all hover:bg-accent hover:text-foreground"
                title={t('viewSkills')}
              >
                <Lightbulb size={16} />
                <span className="hidden text-[11px] font-bold sm:inline">{t('skills')}</span>
              </Link>
            )}
          </div>
        </div>

        {/* Compact Status Bar */}
        <div data-testid="chat-runtime-banner" className="border-t border-border/50 px-3 py-1.5">
          <div className="flex flex-wrap items-start gap-2">
            <div data-testid="chat-runtime-status" className="flex min-w-[12rem] flex-1 flex-wrap items-center gap-2">
              <ChatRuntimeActivityBadge status={runtimeStatus} />
              {isMobile ? (
                <ChatAgentSelector
                  variant="mobile"
                  activeAgentId={activeSessionAgentId}
                  activeAgentName={activeAgentDisplayName}
                  activeAgentIconId={activeAgentProfile?.iconId}
                  agents={chatAgentOptions}
                  onSelectAgent={selectChatAgent}
                />
              ) : null}
              
              {/* Queue Badge */}
              {runtimeStatus && totalQueuedMessages > 0 && (
                <span className="inline-flex items-center gap-1 border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  {t('queuedCount', { count: totalQueuedMessages })}
                </span>
              )}
              
              {/* Summary Badge */}
              {!isMobile && runtimeStatus?.includedSummary && (
                <span className="border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {t('summary')}
                </span>
              )}
              
              {/* Active Tool Badge */}
              {!isMobile && runtimeStatus?.activeTool && toolVerbosity !== 'minimal' && (
                <span className="inline-flex items-center gap-1 border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600">
                  <Wrench size={10} />
                  {toolVerbosity === 'verbose' ? runtimeStatus.activeTool.name : activeToolDisplay?.label}
                </span>
              )}
            </div>
            
            {/* Right: Action Buttons */}
            <div className="flex w-full min-w-0 flex-wrap items-center justify-start gap-1.5 md:ml-auto md:w-auto md:justify-end">
              {!isMobile ? (
                <span
                  data-testid="chat-context-meter"
                  title={contextTooltip}
                  className="inline-flex h-7 min-w-0 max-w-full items-center rounded-md border border-border/60 bg-muted/40 px-2.5 text-[10px] font-medium text-muted-foreground md:max-w-[min(20rem,40vw)]"
                >
                  <span className="min-w-0 truncate">{contextDetailedLabel}</span>
                </span>
              ) : null}
              {!isMobile && (
                <>
                  <button
                    type="button"
                    data-testid="chat-compact"
                    onClick={() => void handleCompact()}
                    disabled={!sessionId || runtimeStatus?.phase !== 'idle'}
                    className="h-7 rounded-md border border-border bg-muted/50 px-2.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('compact')}
                  </button>
                  <Link
                    href="/settings?tab=agent"
                    aria-label={t('openAgentSettings')}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2.5 text-[11px] font-medium text-muted-foreground transition-all hover:bg-accent hover:text-foreground"
                    title={t('openAgentSettings')}
                  >
                    <Settings className="h-3 w-3" />
                    {!isCompactView ? <span>{t('settings')}</span> : null}
                  </Link>
                </>
              )}
              {isMobile && (
                <>
                  <button
                    type="button"
                    data-testid="chat-mobile-details-toggle"
                    aria-expanded={showMobileDetails}
                    onClick={() => setShowMobileDetails((current) => !current)}
                    className="inline-flex items-center gap-1 border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-accent"
                  >
                    {t('details')}
                    {showMobileDetails ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  </button>
                  <Link
                    href="/settings?tab=agent"
                    data-testid="chat-mobile-agent-settings"
                    aria-label={t('openAgentSettings')}
                    className="inline-flex items-center gap-1 border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground transition-all hover:bg-accent hover:text-foreground"
                    title={t('openAgentSettings')}
                  >
                    <Settings className="h-3 w-3" />
                  </Link>
                </>
              )}
            </div>
          </div>
          
          {/* Context Progress Bar - Slim */}
          <div className="mt-1.5 flex items-center gap-2" title={contextTooltip}>
            <div className="flex-1 h-1 overflow-hidden rounded-full bg-black/5 dark:bg-gray-700">
              <div
                data-testid="chat-context-progress"
                className={`h-full rounded-full transition-all ${
                  runtimeStatus?.phase === 'aborting'
                    ? 'bg-rose-400'
                    : runtimeStatus?.phase === 'running_tool'
                      ? 'bg-amber-400'
                      : 'bg-cyan-400'
                }`}
                style={{ width: `${contextProgressPercent}%` }}
              />
            </div>
          </div>
          
          {/* Mobile Details Panel */}
          {isMobile && showMobileDetails && (
            <div data-testid="chat-mobile-details-panel" className="mt-2 space-y-2 border-t border-border/50 pt-2">
              <div className="flex flex-wrap gap-1.5">
                <div
                  data-testid="chat-session-id"
                  title={sessionId || t('newChatTitle')}
                  className="inline-flex min-w-0 items-center gap-1 border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] text-foreground"
                >
                  <span className="text-[9px] uppercase tracking-[0.15em] text-muted-foreground">{t('sessionLabel')}</span>
                  <span className="min-w-0 truncate">{sessionDisplayLabel}</span>
                </div>
                {runtimeStatus?.includedSummary && (
                  <span className="border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {t('summary')}
                  </span>
                )}
                {runtimeStatus?.activeTool && toolVerbosity !== 'minimal' && (
                  <span className="inline-flex items-center gap-1 border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600">
                    <Wrench size={9} />
                    {toolVerbosity === 'verbose' ? runtimeStatus.activeTool.name : activeToolDisplay?.label}
                  </span>
                )}
              </div>
              <div data-testid="chat-context-meter" title={contextTooltip} className="text-[10px] text-muted-foreground">
                {contextCompactLabel}
              </div>
              {totalQueuedMessages > 0 && (
                <div data-testid="chat-mobile-details-queue-panel" className="border border-border/60 bg-muted/30 p-1.5 text-[10px]">
                  <div className="mb-1 font-medium text-foreground">{t('queuedCount', { count: totalQueuedMessages })}</div>
                </div>
                )}
              </div>
            )}
           </div>
         </div>

        <div className="relative flex-1 flex min-h-0">
        {showHistory && !shouldShowHistoryAsOverlay && (
          <>
            <ChatHistoryPanel
              variant="sidebar"
              width={historySidebarWidth}
              {...historyPanelProps}
            />
            <div
              className="flex w-1 cursor-col-resize items-center justify-center bg-border transition-all hover:w-1.5 hover:bg-primary/60"
              onMouseDown={startHistoryResizing}
            >
              <div className="h-8 w-0.5 bg-muted-foreground/60" />
            </div>
          </>
        )}

        <div className="relative flex-1 min-w-0 flex flex-col">
        {/* Unread Banner - shows when entering a session with unread AI responses */}
        {showUnreadBanner && hasUnreadInCurrentSession && (
          <div className="absolute top-0 left-0 right-0 z-30 flex justify-center">
            <div className="flex items-center gap-3 rounded-b-lg border border-blue-500/30 bg-blue-500/10 px-4 py-2 backdrop-blur-sm shadow-lg">
              <div className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
              <span className="text-xs font-medium text-blue-600 dark:text-blue-400">{t('newResponseReceived')}</span>
              <button
                type="button"
                onClick={() => {
                  setShowUnreadBanner(false);
                  setHasUnreadInCurrentSession(false);
                }}
                className="rounded px-2 py-1 text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-500/20"
              >
                {t('markAsRead')}
              </button>
            </div>
          </div>
        )}

        {showHistory && shouldShowHistoryAsOverlay && (
          <ChatHistoryPanel
            variant="overlay"
            onBackToChat={() => setShowHistory(false)}
            {...historyPanelProps}
          />
        )}

        <div
          ref={scrollContainerRef}
          data-testid="chat-scroll-region"
          className="absolute inset-0 overflow-y-auto overflow-x-hidden p-4"
          style={{
            paddingBottom: `${scrollContentPadding}px`,
            overflowAnchor: isAtBottom ? 'none' : 'auto',
          }}
        >
          <div ref={scrollContentRef} className="min-h-full space-y-4">
            {showInitialChatLoader && (
            <div className="flex min-h-full items-center justify-center py-8">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{t('loadingSessions')}</span>
              </div>
            </div>
            )}

            {showStarterScreen && (
            <ChatStarterScreen
              latestSession={latestSession}
              sessionBasePath={sessionBasePath}
              isStudioChatContext={isStudioChatContext}
              prompts={localizedStarterPrompts}
              isCompactView={isCompactView}
              onSelectPrompt={applyStarterPrompt}
            />
            )}

            {messages.length > 0 && hasMoreBefore && (
            <button
              type="button"
              onClick={() => void loadOlderMessages()}
              disabled={isLoadingOlder}
              className="mx-auto flex w-full max-w-xs items-center justify-center gap-2 rounded-md border border-border bg-background/80 px-4 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoadingOlder ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>{t('loadingOlderMessages')}</span>
                </>
              ) : (
                <span>{t('loadEarlierMessages')}</span>
              )}
            </button>
            )}

            <ChatMessageList
              messages={messages}
              isRuntimeBusy={isRuntimeBusy}
              runtimePhase={runtimeStatus?.phase}
              expandedRunKeys={expandedRunKeys}
              toolVerbosity={toolVerbosity}
              onToggleToolMessage={toggleToolMessage}
              onToggleRunDisclosure={toggleRunDisclosure}
              onMediaClick={handleMediaPreviewClick}
              onAttachmentOpen={handleAttachmentPreviewOpen}
            />
            <div ref={messagesEndRef} />
          </div>
        </div>

        {showScrollButton && messages.length > 0 && (
          <button
            type="button"
            onClick={() => scrollToBottom()}
            className="absolute right-4 z-30 border border-primary/30 bg-primary p-2 text-primary-foreground shadow-sm transition-all hover:bg-primary/90"
            style={{ bottom: `${scrollButtonOffset}px` }}
            title={t('scrollToBottom')}
          >
            <ArrowDown size={20} />
          </button>
        )}
      <ChatComposer
        ref={composerRef}
        ariaHidden={isHistoryOverlayOpen}
        isMobile={isMobile}
        uploadError={uploadError}
        onClearUploadError={() => setUploadError(null)}
        isWebSocketUnavailable={isWebSocketUnavailable}
        showModelRequiredNotice={showModelRequiredNotice}
        attachments={attachments}
        onRemoveAttachment={removeAttachment}
        onAttachmentOpen={handleAttachmentPreviewOpen}
        showQueuePanel={Boolean(runtimeStatus && totalQueuedMessages > 0)}
        queueItems={queueItems}
        openQueueItemId={openQueueItemPopoverId}
        onOpenQueueItemChange={setOpenQueueItemPopoverId}
        onPromoteQueuedMessage={(queueItemId) => {
          void handlePromoteQueuedMessage(queueItemId);
        }}
        onRemoveQueuedMessage={(queueItemId) => {
          void handleRemoveQueuedMessage(queueItemId);
        }}
        onEditQueuedMessage={(entry) => {
          void handleEditQueuedMessage(entry);
        }}
        fileInputRef={fileInputRef}
        onFileChange={onFileChange}
        composerDisabled={composerDisabled}
        isUploading={isUploading}
        textareaRef={textareaRef}
        input={input}
        onInputChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        composerPlaceholderText={composerPlaceholderText}
        textareaHeight={textareaHeight}
        planningMode={planningMode}
        showReferencePicker={Boolean(activeReferenceMatch)}
        referencePickerEmptyState={referencePickerEmptyState}
        referencePickerHeader={referencePickerHeader}
        referencePickerItems={referencePickerItems}
        onReferenceSelect={handleReferenceSelect}
        referencePickerRef={referencePickerRef}
        selectedReferenceIndex={selectedReferenceIndex}
        primaryActionIsStop={primaryActionIsStop}
        primaryActionLabel={primaryActionLabel}
        primaryActionDisabled={primaryActionDisabled}
        onStop={handleStop}
        onSend={handleSend}
        selectedAgentId={selectedAgentId}
        sessionId={sessionId}
        activeModel={effectiveActiveModel}
        activeProvider={effectiveActiveProvider}
        thinkingLevel={effectiveActiveThinkingLevel}
        agentConfig={selectedAgentConfig}
        modelSelectorDisabled={Boolean(runtimeStatus && runtimeStatus.phase !== 'idle') || !effectiveActiveProvider}
        compactModelSelector={isCompactView}
        onModelChange={handleModelChange}
        onRuntimeInvalidated={invalidateRuntimeAfterModelChange}
        showComposerHint={showComposerHint}
        onToggleComposerHint={() => setShowComposerHint((current) => !current)}
        composerHint={composerHint}
      />
        </div>
      </div>
      <AttachmentPreviewDialog
        attachment={previewAttachment}
        attachments={previewAttachmentGroup}
        onClose={handleAttachmentPreviewClose}
      />
      <ImagePreprocessDialog
        open={imagePreprocessFiles !== null}
        onOpenChange={handleImagePreprocessOpenChange}
        files={imagePreprocessFiles ?? []}
        onConfirm={handleImagePreprocessConfirm}
        onSkip={handleImagePreprocessSkip}
      />
    </div>
  );
}
