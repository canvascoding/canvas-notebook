'use client';

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  Loader2,
  ArrowDown,
} from 'lucide-react';
import { ChatComposer } from '@/app/components/canvas-agent-chat/ChatComposer';
import { ChatDelegationPanel } from '@/app/components/canvas-agent-chat/ChatDelegationPanel';
import { ChatHeader } from '@/app/components/canvas-agent-chat/ChatHeader';
import { ChatHistoryPanel, type ChatHistoryPanelProps } from '@/app/components/canvas-agent-chat/ChatHistoryPanel';
import { ChatMessageList } from '@/app/components/canvas-agent-chat/ChatMessageList';
import { ChatRuntimeNotice } from '@/app/components/canvas-agent-chat/ChatRuntimeNotice';
import { ChatStarterScreen } from '@/app/components/canvas-agent-chat/ChatStarterScreen';
import { ResizeHandle, usePanelResize } from '@/app/components/layout/ResizeHandle';
import { useFileStore } from '@/app/store/file-store';
import { useRouter, useSearchParams } from 'next/navigation';
import { usePathname as useLocalePathname } from '@/i18n/navigation';

import { useIsMobile } from '@/hooks/use-mobile';
import { AttachmentPreviewDialog } from '@/app/components/canvas-agent-chat/AttachmentPreviewDialog';
import { useChatComposerLayout } from '@/app/components/canvas-agent-chat/useChatComposerLayout';
import { useChatScrollController } from '@/app/components/canvas-agent-chat/useChatScrollController';
import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
import {
  removeCachedChatSession,
  updateCachedChatSessionTitle,
} from '@/app/lib/chat/session-cache';
import {
  deleteChatSession as deleteChatSessionRequest,
  patchChatSessions,
} from '@/app/lib/chat/session-api';
import { getSessionDisplayTitle } from '@/app/lib/pi/session-titles';
import { useWebSocket } from '@/app/hooks/useWebSocket';
import { ImagePreprocessDialog } from '@/app/components/shared/ImagePreprocessDialog';
import { usePlanModeStore } from '@/app/store/plan-mode-store';
import { useToolVerbosityStore } from '@/app/store/tool-verbosity-store';
import {
  selectActiveWorkspace,
  useWorkspaceStore,
  WORKSPACE_CHANGED_EVENT,
  type WorkspaceChangedDetail,
} from '@/app/store/workspace-store';
import type { AiEffectiveRuntimeResolution, AiRuntimeSelection } from '@/app/lib/agent-runtime-policy/types';

import {
  clearCanvasChatActiveSessionStorage,
  readCanvasChatActiveSessionStorage,
  writeCanvasChatActiveSessionStorage,
} from '@/app/lib/chat/constants';
import { removeComposerDraft } from '@/app/lib/chat/draft-storage';
import { getAgentProfileDisplayName } from '@/app/lib/chat/agent-display';
import { MAIN_AGENT_DISPLAY_NAME } from '@/app/lib/agents/main-agent';
import { useChatAgentConfig } from '@/app/components/canvas-agent-chat/useChatAgentConfig';
import { useChatAttachments } from '@/app/components/canvas-agent-chat/useChatAttachments';
import { useChatControlActions } from '@/app/components/canvas-agent-chat/useChatControlActions';
import { useChatComposerDraft } from '@/app/components/canvas-agent-chat/useChatComposerDraft';
import { useChatRuntimeEvents } from '@/app/components/canvas-agent-chat/useChatRuntimeEvents';
import {
  CHAT_HISTORY_PANEL_MAX_WIDTH,
  CHAT_HISTORY_PANEL_MIN_WIDTH,
  useChatSessionHistory,
} from '@/app/components/canvas-agent-chat/useChatSessionHistory';
import { useChatSessionBootstrap } from '@/app/components/canvas-agent-chat/useChatSessionBootstrap';
import { useChatSessionMessages } from '@/app/components/canvas-agent-chat/useChatSessionMessages';
import { useComposerReferences } from '@/app/components/canvas-agent-chat/useComposerReferences';
import { useChatRuntimeSelection } from '@/app/components/canvas-agent-chat/useChatRuntimeSelection';
import type {
  AgentProfile,
  AISession,
  ChatMessage,
  ChatRequestContext,
  QueuePreviewItem,
} from '@/app/lib/chat/types';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';

const CHAT_AGENT_ID = DEFAULT_AGENT_ID;

interface CanvasAgentChatProps {
  initialPrompt?: string | null;
  initialPromptStorageKey?: string;
  showSkillsLink?: boolean;
  hideNavHeader?: boolean;
  showWorkspaceSwitcher?: boolean;
  chatContainerWidth?: number;
  isSurfaceVisible?: boolean;
  forcedSessionId?: string | null;
  requestContext?: ChatRequestContext;
  onRuntimeStatusChange?: (status: RuntimeStatus | null) => void;
  onSessionContextChange?: (context: { agentId: string; sessionId: string } | null) => void;
  onOpenLiveBrowser?: () => void;
  onMediaClick?: (mediaUrl: string) => void;
}

const CHAT_REQUEST_TIMEOUT_MS = 30_000;
const ONBOARDING_CHAT_REQUEST_TIMEOUT_MS = 90_000;

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

function formatContextTokens(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }

  return `${value}`;
}

function isSelectableRuntimeSelection(
  resolution: AiEffectiveRuntimeResolution | null,
  selection: AiRuntimeSelection | null,
): boolean {
  if (!resolution || !selection) return false;
  const provider = resolution.providers.find((candidate) => (
    candidate.installationId === selection.providerInstallationId
  ));
  const model = provider?.models.find((candidate) => candidate.id === selection.modelId);
  return Boolean(
    provider?.selectable
      && provider.providerId === selection.providerId
      && model?.enabled
      && model.thinkingLevels.includes(selection.thinkingLevel),
  );
}

export default function CanvasAgentChat({
  initialPrompt,
  initialPromptStorageKey,
  showSkillsLink = false,
  hideNavHeader = false,
  showWorkspaceSwitcher = true,
  chatContainerWidth,
  isSurfaceVisible = true,
  forcedSessionId,
  requestContext,
  onRuntimeStatusChange,
  onSessionContextChange,
  onOpenLiveBrowser,
  onMediaClick,
}: CanvasAgentChatProps) {
  const t = useTranslations('chat');
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedSessionId = searchParams.get('session');
  const requestedWorkspaceId = searchParams.get('workspaceId')?.trim() || null;
  const pathname = useLocalePathname();
  const isMobile = useIsMobile();
  const currentFile = useFileStore((s) => s.currentFile);
  const { planningMode, togglePlanningMode } = usePlanModeStore();
  const toolVerbosity = useToolVerbosityStore((s) => s.toolVerbosity);
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
  const workspaceInitialized = useWorkspaceStore((state) => state.initialized);
  const activeWorkspaceId = activeWorkspace?.id ?? null;
  const isWorkspaceNavigationPending = Boolean(
    requestedWorkspaceId
    && (!workspaceInitialized || requestedWorkspaceId !== activeWorkspaceId),
  );
  const resolvedRequestedSessionId = forcedSessionId
    ?? (isWorkspaceNavigationPending ? null : requestedSessionId);

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
  const [, setShowMobileDetails] = useState(false);
  const {
    activeModel,
    activeProvider,
    activeThinkingLevel,
    availableAgents,
    refreshAgents,
    selectedAgentId,
    setActiveModel,
    setActiveProvider,
    setActiveThinkingLevel,
    setSelectedAgentId,
    updateAgentModelSelection,
  } = useChatAgentConfig({
    initialAgentId: CHAT_AGENT_ID,
    sessionId,
    workspaceId: activeWorkspaceId,
  });
  const {
    resolution: runtimeResolution,
    selection: requestedRuntimeSelection,
    selectionSource: runtimeSelectionSource,
    hasLocalSelection: hasLocalRuntimeSelection,
    loading: isRuntimeSelectionLoading,
    error: runtimeSelectionError,
    setRequestedSelection: setRequestedRuntimeSelection,
    applyResolution: applyRuntimeResolution,
    refresh: refreshRuntimeSelection,
  } = useChatRuntimeSelection({
    workspaceId: activeWorkspaceId,
    agentId: selectedAgentId,
    sessionId,
  });
  const runtimeSelection = isSelectableRuntimeSelection(runtimeResolution, requestedRuntimeSelection)
    ? requestedRuntimeSelection
    : null;
  useEffect(() => {
    if (!runtimeSelection) return;
    updateAgentModelSelection({
      provider: runtimeSelection.providerId,
      model: runtimeSelection.modelId,
      thinkingLevel: runtimeSelection.thinkingLevel,
    });
  }, [runtimeSelection, updateAgentModelSelection]);
  const selectedAgentProfile = availableAgents.find((agent) => agent.agentId === selectedAgentId);
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
    const hasStoredSession = Boolean(readCanvasChatActiveSessionStorage(activeWorkspaceId));
    return hasStoredInitialPrompt || hasStoredSession;
  });
  const [expandedRunKeys, setExpandedRunKeys] = useState<Set<string>>(() => new Set());

  const isStudioChatContext = Boolean(requestContext?.currentPage?.startsWith('/studio') || pathname?.startsWith('/studio'));
  const promptSuggestions = (isStudioChatContext
    ? ['studioProduct', 'studioVideo', 'studioCreative']
    : ['campaign', 'creative', 'strategy']
  ).map((key) => t(`promptSuggestions.${key}`));
  const [showComposerHint, setShowComposerHint] = useState(false);

  const isWebSocketUnavailable = wsError?.code === 'AUTH_ERROR';

  const sessionIdRef = useRef<string | null>(null);
  const sessionWorkspaceIdRef = useRef<string | null>(null);
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
    imagePreprocessProgressItems,
    isUploading,
    onFileChange,
    previewAttachment,
    previewAttachmentGroup,
    removeAttachment,
    setAttachments,
    setUploadError,
    uploadFiles,
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
  const historyPanelRef = useRef<HTMLDivElement | null>(null);
  const openingLatestSessionRef = useRef<string | null>(null);
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
    setHistorySidebarWidth,
    setHistoryUnreadOnly,
    setTotalUnreadCount,
    totalUnreadCount,
  } = useChatSessionHistory({
    activeWorkspaceId,
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
  const applyHistoryPanelWidth = useCallback((nextWidth: number) => {
    historyPanelRef.current?.style.setProperty('width', `${nextWidth}px`);
  }, []);
  const historyResize = usePanelResize({
    orientation: 'vertical',
    value: historySidebarWidth,
    min: CHAT_HISTORY_PANEL_MIN_WIDTH,
    max: CHAT_HISTORY_PANEL_MAX_WIDTH,
    onResize: applyHistoryPanelWidth,
    onResizeEnd: setHistorySidebarWidth,
  });
  useEffect(() => {
    applyHistoryPanelWidth(historySidebarWidth);
  }, [applyHistoryPanelWidth, historySidebarWidth]);
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
    referencePickerError,
    referencePickerItems,
    selectedReferenceIndex,
    selectNextReference,
    selectPreviousReference,
  } = useComposerReferences({
    agentId: selectedAgentId,
    input,
    relevantSkillNames: selectedAgentProfile?.relevantSkills,
    workspaceId: activeWorkspaceId,
    resetInputHistoryNavigation,
    setInput,
    textareaRef,
  });

  const handleWorkspaceFilesDrop = useCallback((paths: string[]) => {
    const references = paths.map((path) => `@"${path}"`);
    if (references.length === 0) return;

    resetInputHistoryNavigation();
    setInput((current) => `${current}${current.trimEnd() ? ' ' : ''}${references.join(' ')} `);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [resetInputHistoryNavigation, setInput, textareaRef]);

  const buildRequestContext = useCallback((activeFilePath: string | null): ChatRequestContext => ({
    activeFilePath,
    userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    currentTime: new Date().toISOString(),
    workspace: activeWorkspace
      ? {
        workspaceId: activeWorkspace.id,
        workspaceType: activeWorkspace.type,
        workspaceName: activeWorkspace.name,
        workspaceDescription: activeWorkspace.description,
        organizationId: activeWorkspace.organizationId,
        canWrite: activeWorkspace.permissions.canWrite,
        canDelete: activeWorkspace.permissions.canDelete,
        canShare: activeWorkspace.permissions.canCreatePublicLinks,
      }
      : undefined,
    planningMode,
    currentPage: typeof window !== 'undefined' ? window.location.pathname : undefined,
    ...requestContext,
  }), [activeWorkspace, planningMode, requestContext]);

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
    if (sessionId) {
      writeCanvasChatActiveSessionStorage(
        sessionWorkspaceIdRef.current ?? activeWorkspaceId,
        sessionId,
      );
    }
  }, [activeWorkspaceId, resetInputHistoryNavigation, sessionId]);

  useEffect(() => {
    surfaceVisibleRef.current = isSurfaceVisible;

    window.dispatchEvent(new CustomEvent('chat-active-session-changed', {
      detail: {
        sessionId: isSurfaceVisible ? sessionId : null,
        workspaceId: isSurfaceVisible ? activeWorkspaceId : null,
        isVisible: isSurfaceVisible,
      },
    }));

    return () => {
      window.dispatchEvent(new CustomEvent('chat-active-session-changed', {
        detail: {
          sessionId: null,
          workspaceId: null,
          isVisible: false,
        },
      }));
    };
  }, [activeWorkspaceId, isSurfaceVisible, sessionId]);

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

  const runtimePhase = runtimeStatus?.phase;
  const chatRequestTimeoutMs = requestContext?.currentPage === 'onboarding'
    ? ONBOARDING_CHAT_REQUEST_TIMEOUT_MS
    : CHAT_REQUEST_TIMEOUT_MS;

  useEffect(() => {
    onRuntimeStatusChange?.(runtimeStatus);
  }, [onRuntimeStatusChange, runtimeStatus]);

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

  const {
    handleCompact,
    handleControlAction,
    handleEditQueuedMessage,
    handlePromoteQueuedMessage,
    handleRemoveQueuedMessage,
    handleSend,
    handleStop,
    selectChatAgent: selectChatAgentWithoutLoadCancellation,
    startNewChat: startNewChatWithoutLoadCancellation,
  } = useChatControlActions({
    activeModel,
    activeProvider,
    activeThinkingLevel,
    runtimeSelection,
    hasLocalRuntimeSelection,
    runtimeCatalogRevision: runtimeResolution?.catalogRevision ?? null,
    runtimePolicyRevision: runtimeResolution?.policyRevision ?? null,
    refreshRuntimeSelection,
    activeWorkspaceId,
    addSessionToHistory,
    appendCompactionBreak,
    appendOptimisticUserMessage,
    appendSystemMessage,
    attachments,
    buildRequestContext,
    chatRequestTimeoutMs,
    clearCurrentAssistant,
    createAssistantBubble,
    currentFilePath: currentFile?.path ?? null,
    ensureSessionSubscribed,
    fetchHistory,
    input,
    isMobile,
    isUploading,
    messages,
    resetHistoryState,
    resetInputHistoryNavigation,
    resetRuntimeMessageRefs,
    resetStreamConnection,
    runtimePhase,
    selectedAgentId,
    sessionAgentIdRef,
    sessionIdRef,
    sessionWorkspaceIdRef,
    setActiveModel,
    setActiveProvider,
    setActiveThinkingLevel,
    setAttachments,
    setExpandedRunKeys,
    setHasMoreBefore,
    setHistoryAgentFilter,
    setInput,
    setIsLoadingOlder,
    setIsResolvingInitialChatState,
    setMessages,
    setOldestSequence,
    setOldestTimestamp,
    setOpenQueueItemPopoverId,
    setOptimisticRuntimePhase,
    setRuntimeStatus,
    setRuntimeStatusWithReconciliation,
    setSelectedAgentId,
    setSessionId,
    setSessionTitle,
    setShowHistory,
    setShowMobileDetails,
    shouldShowHistoryAsOverlay,
    showHistory,
    skipNextSessionStatusRefreshRef,
    t,
    textareaRef,
    userStartedNewChatRef,
    wsRequest,
  });

  const { cancelSessionLoad, loadOlderMessages, loadSession } = useChatSessionMessages({
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
  });

  const startNewChat = useCallback((
    agentIdOverride?: string,
    options?: Parameters<typeof startNewChatWithoutLoadCancellation>[1],
  ) => {
    cancelSessionLoad();
    openingLatestSessionRef.current = null;
    startNewChatWithoutLoadCancellation(agentIdOverride, options);
  }, [cancelSessionLoad, startNewChatWithoutLoadCancellation]);

  const selectChatAgent = useCallback((agentId: string) => {
    cancelSessionLoad();
    openingLatestSessionRef.current = null;
    selectChatAgentWithoutLoadCancellation(agentId);
  }, [cancelSessionLoad, selectChatAgentWithoutLoadCancellation]);

  const openLatestSession = useCallback(() => {
    const targetSession = latestSession;
    if (!targetSession || openingLatestSessionRef.current) {
      return;
    }

    openingLatestSessionRef.current = targetSession.sessionId;
    void loadSession(targetSession).finally(() => {
      if (openingLatestSessionRef.current === targetSession.sessionId) {
        openingLatestSessionRef.current = null;
      }
    });
  }, [latestSession, loadSession]);

  useEffect(() => {
    const handleWorkspaceChange = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceChangedDetail>).detail;
      const routeParams = new URLSearchParams(window.location.search);
      const preservesWorkspaceSession = (
        routeParams.get('workspaceId')?.trim() === detail.activeWorkspaceId
        && Boolean(routeParams.get('session')?.trim())
      );
      closeReferencePicker();
      if (!preservesWorkspaceSession) {
        clearSessionParamFromUrl();
      }
      clearCanvasChatActiveSessionStorage(detail.activeWorkspaceId);
      startNewChat(undefined, {
        clearActiveSessionStorage: false,
      });
    };

    window.addEventListener(WORKSPACE_CHANGED_EVENT, handleWorkspaceChange);
    return () => window.removeEventListener(WORKSPACE_CHANGED_EVENT, handleWorkspaceChange);
  }, [clearSessionParamFromUrl, closeReferencePicker, startNewChat]);

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
        updateCachedChatSessionTitle(session.sessionId, nextTitle.trim(), session.agentId || selectedAgentId, 'manual');
        setHistory((prev) => prev.map((item) => (
          item.sessionId === session.sessionId
            ? { ...item, title: nextTitle.trim(), titleGenerationState: 'manual' }
            : item
        )));
        if (sessionIdRef.current === session.sessionId) {
          setSessionTitle(nextTitle.trim());
        }
      }
    } catch (err) {
      console.error('Failed to rename session', err);
    }
  }, [selectedAgentId, setHistory, t]);

  const markSessionAsUnread = useCallback(async (session: AISession) => {
    if (session.engine !== 'pi' || session.hasUnread || !session.lastMessageAt) return;

    try {
      const data = await patchChatSessions({
        agentId: session.agentId || selectedAgentId,
        sessionId: session.sessionId,
        markAsUnread: true,
      });
      if (data?.success) {
        setHistory((previous) => {
          const updated = previous.map((item) => (
            item.sessionId === session.sessionId
              ? { ...item, lastViewedAt: null, hasUnread: Boolean(data.session?.hasUnread ?? true) }
              : item
          ));
          setTotalUnreadCount(updated.filter((item) => item.hasUnread).length);
          return updated;
        });
      }
    } catch (error) {
      console.error('Failed to mark session as unread', error);
    }
  }, [selectedAgentId, setHistory, setTotalUnreadCount]);

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
    appendSystemMessage,
    clearSessionParamFromUrl,
    fetchHistory,
    forcedSessionId,
    handleControlAction,
    activeWorkspaceId,
    hasLoadedSessionListRef,
    historyLength: history.length,
    initialPrompt,
    initialPromptConsumedRef,
    initialPromptStorageKey,
    isLoadingHistory,
    isResolvingInitialChatState,
    isRuntimeSelectionLoading,
    isWorkspaceNavigationPending,
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

  // Runtime changes arrive over the subscribed WebSocket. Refresh once for a
  // session switch or reconnect so missed events never require polling.
  const handleRuntimeSelectionChange = useCallback((next: AiRuntimeSelection) => {
    setRequestedRuntimeSelection(next);
    updateAgentModelSelection({
      provider: next.providerId,
      model: next.modelId,
      thinkingLevel: next.thinkingLevel,
    });
    setHistory((items) => items.map((item) => (
      item.sessionId === sessionIdRef.current
        ? { ...item, model: next.modelId, provider: next.providerId, thinkingLevel: next.thinkingLevel }
        : item
    )));
  }, [setHistory, setRequestedRuntimeSelection, updateAgentModelSelection]);

  const refreshRuntimeStatusAfterModelChange = useCallback(async () => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) {
      return;
    }
    await refreshRuntimeStatus(currentSessionId);
  }, [refreshRuntimeStatus]);

  useEffect(() => {
    if (!sessionId || !wsConnected) return;
    if (skipNextSessionStatusRefreshRef.current === sessionId) {
      skipNextSessionStatusRefreshRef.current = null;
      return;
    }
    void refreshRuntimeStatus(sessionId);
  }, [refreshRuntimeStatus, sessionId, wsConnected]);

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
  const isRuntimeBusy = Boolean(
    runtimeStatus
    && (runtimeStatus.phase !== 'idle' || runtimeStatus.compactionStatus?.state === 'running'),
  );
  const queueItems: QueuePreviewItem[] = [
    ...(runtimeStatus?.steeringQueue || []).map((entry) => ({ ...entry, kind: 'steer' as const })),
    ...(runtimeStatus?.followUpQueue || []).map((entry) => ({ ...entry, kind: 'follow_up' as const })),
  ];
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
  const isModelConfigured = Boolean(runtimeSelection);
  const primaryActionDisabled = primaryActionIsStop
    ? isRuntimeAborting || !runtimeStatus?.canAbort || isWebSocketUnavailable
    : isUploading || !hasComposerContent || isWebSocketUnavailable || !isModelConfigured;
  const isModelConfigurationLoading = isRuntimeSelectionLoading && !isModelConfigured;
  const showModelRequiredNotice = !isModelConfigured && !isModelConfigurationLoading;
  const isHistoryOverlayOpen = showHistory && shouldShowHistoryAsOverlay;
  const scrollContentPadding = isHistoryOverlayOpen ? 24 : composerHeight + 24;
  const scrollButtonOffset = isHistoryOverlayOpen ? 16 : composerHeight + 16;
  const isCompactComposer = composerWidth > 0 && composerWidth < 520;
  const isCompactView = isMobile || (composerWidth > 0 && composerWidth < 640);
  const showInitialChatLoader = messages.length === 0 && isResolvingInitialChatState;
  const showStarterScreen = messages.length === 0 && !sessionId && !isResolvingInitialChatState;
  const activeSession = history.find((session) => session.sessionId === sessionId);
  const activeSessionAgentId = activeSession?.agentId || selectedAgentId;
  useEffect(() => {
    onSessionContextChange?.(
      sessionId
        ? {
            agentId: activeSessionAgentId,
            sessionId,
          }
        : null,
    );
  }, [activeSessionAgentId, onSessionContextChange, sessionId]);
  useEffect(() => () => onSessionContextChange?.(null), [onSessionContextChange]);
  const isSessionTitleGenerating = activeSession?.titleGenerationState === 'pending' || activeSession?.titleGenerationState === 'generating';
  const activeAgentProfile = agentProfilesById.get(activeSessionAgentId);
  const activeAgentDisplayName = getAgentProfileDisplayName(activeSessionAgentId, activeAgentProfile?.name);
  const chatAgentOptions = useMemo<AgentProfile[]>(() => (
    (availableAgents.length > 0
      ? availableAgents
      : [{ agentId: CHAT_AGENT_ID, name: MAIN_AGENT_DISPLAY_NAME, iconId: 'bot', type: 'main', removable: false }]
    ).map((agent) => ({
      ...agent,
      name: getAgentProfileDisplayName(agent.agentId, agent.name),
    }))
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
    onMarkSessionAsUnread: markSessionAsUnread,
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
  const referencePickerHeader = activeReferenceKind === 'all'
    ? isLoadingReferenceItems
      ? t('loadingReferences')
      : t('referencesFound', { count: referencePickerItems.length })
    : activeReferenceKind === 'capability'
    ? isLoadingReferenceItems
      ? t('loadingCapabilities')
      : t('capabilitiesFound', { count: referencePickerItems.length })
    : isLoadingReferenceItems
      ? t('loadingFiles')
      : t('filesFound', { count: referencePickerItems.length });
  const referencePickerEmptyState = referencePickerError
    ? t('referenceSearchFailed', { message: referencePickerError })
    : activeReferenceKind === 'all'
    ? activeReferenceMatch?.query
      ? t('noReferencesFoundMatching', { query: activeReferenceMatch.query })
      : t('noReferencesAvailable')
    : activeReferenceKind === 'capability'
    ? activeReferenceMatch?.query
      ? t('noCapabilitiesFoundMatching', { query: activeReferenceMatch.query })
      : t('noCapabilitiesAvailable')
    : activeReferenceMatch?.query
      ? t('noFilesFoundMatching', { query: activeReferenceMatch.query })
      : t('noFilesInWorkspace');

  return (
    <div ref={containerRef} className="relative flex h-full flex-col overflow-hidden bg-card text-card-foreground">
      <ChatHeader
        activeAgentDisplayName={activeAgentDisplayName}
        activeAgentIconId={activeAgentProfile?.iconId}
        activeSessionAgentId={activeSessionAgentId}
        chatAgentOptions={chatAgentOptions}
        contextDetailedLabel={contextDetailedLabel}
        contextProgressPercent={contextProgressPercent}
        contextTooltip={contextTooltip}
        hideNavHeader={hideNavHeader}
        isHistoryOverlayOpen={isHistoryOverlayOpen}
        isMobile={isMobile}
        isSessionTitleGenerating={isSessionTitleGenerating}
        onCompact={() => void handleCompact()}
        onSelectAgent={(agentId) => {
          closeReferencePicker();
          selectChatAgent(agentId);
        }}
        onReloadAgents={refreshAgents}
        onOpenLiveBrowser={onOpenLiveBrowser}
        onSetShowHistory={setShowHistory}
        onStartNewChat={() => startNewChat()}
        runtimeStatus={runtimeStatus}
        sessionDisplayLabel={sessionDisplayLabel}
        sessionId={sessionId}
        showHistory={showHistory}
        showSkillsLink={showSkillsLink}
        showWorkspaceSwitcher={showWorkspaceSwitcher}
        totalUnreadCount={totalUnreadCount}
      />

        <div className="relative flex-1 flex min-h-0">
        {showHistory && !shouldShowHistoryAsOverlay && (
          <>
            <ChatHistoryPanel
              variant="sidebar"
              width={historySidebarWidth}
              containerRef={historyPanelRef}
              {...historyPanelProps}
            />
            <ResizeHandle
              data-testid="chat-history-resize-handle"
              orientation="vertical"
              label={t('resizeHistoryHandleLabel')}
              controls="chat-history-panel"
              min={CHAT_HISTORY_PANEL_MIN_WIDTH}
              max={CHAT_HISTORY_PANEL_MAX_WIDTH}
              value={historySidebarWidth}
              resizing={historyResize.isResizing}
              {...historyResize.handleProps}
            />
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
            overflowAnchor: 'none',
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
              activeAgentDisplayName={activeAgentDisplayName}
              activeAgentId={activeSessionAgentId}
              latestSession={latestSession}
              isStudioChatContext={isStudioChatContext}
              onOpenLatestSession={openLatestSession}
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
              assistantName={activeAgentDisplayName}
              runtimePhase={runtimeStatus?.phase}
              expandedRunKeys={expandedRunKeys}
              toolVerbosity={toolVerbosity}
              onToggleRunDisclosure={toggleRunDisclosure}
              onMediaClick={handleMediaPreviewClick}
              onAttachmentOpen={handleAttachmentPreviewOpen}
            />
            <ChatRuntimeNotice status={runtimeStatus} />
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
        delegationPanel={sessionId ? (
          <ChatDelegationPanel
            key={sessionId}
            sourceSessionId={sessionId}
            agents={chatAgentOptions}
          />
        ) : null}
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
        onFilesDrop={uploadFiles}
        onWorkspaceFilesDrop={handleWorkspaceFilesDrop}
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
        selectedReferenceIndex={selectedReferenceIndex}
        primaryActionIsStop={primaryActionIsStop}
        primaryActionLabel={primaryActionLabel}
        primaryActionDisabled={primaryActionDisabled}
        onStop={handleStop}
        onSend={handleSend}
        selectedAgentId={selectedAgentId}
        sessionId={sessionId}
        runtimeSelection={requestedRuntimeSelection}
        runtimeSelectionSource={runtimeSelectionSource}
        runtimeResolution={runtimeResolution}
        runtimeSelectionError={runtimeSelectionError}
        hasLocalRuntimeSelection={hasLocalRuntimeSelection}
        modelSelectorDisabled={Boolean(runtimeStatus && runtimeStatus.phase !== 'idle') || isRuntimeSelectionLoading}
        compactModelSelector={isCompactView}
        onRuntimeSelectionChange={handleRuntimeSelectionChange}
        onRuntimeResolutionChange={applyRuntimeResolution}
        onRuntimeResolutionRefresh={refreshRuntimeSelection}
        onRuntimeStatusRefresh={refreshRuntimeStatusAfterModelChange}
        showComposerHint={showComposerHint}
        onToggleComposerHint={() => setShowComposerHint((current) => !current)}
        composerHint={composerHint}
        promptSuggestions={promptSuggestions}
        showPromptSuggestions={showStarterScreen}
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
        isProcessing={isUploading}
        progressItems={imagePreprocessProgressItems}
      />
    </div>
  );
}
