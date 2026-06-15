'use client';

import React, { useState, useRef, useEffect, useCallback, useLayoutEffect, useMemo } from 'react';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createThinkingFilterState, filterThinkingChunk, flushThinkingFilter } from '@/app/lib/pi/thinking-filter';
import type { ThinkingFilterState } from '@/app/lib/pi/thinking-filter';
import { useTranslations } from 'next-intl';
import type { AnthropicSkill } from '@/app/lib/skills/skill-manifest-anthropic';
import {
  Paperclip,
  X,
  Loader2,
  History,
  Plus,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  ArrowDown,
  Wrench,
  Lightbulb,
  CircleHelp,
  Settings,
  ArrowLeft,
  Square,
} from 'lucide-react';
import { ComposerReferencePicker, type ComposerReferencePickerItem } from '@/app/components/canvas-agent-chat/ComposerReferencePicker';
import { ChatAgentSelector } from '@/app/components/canvas-agent-chat/ChatAgentSelector';
import { ChatHistoryPanel, type ChatHistoryPanelLabels, type ChatHistoryPanelProps } from '@/app/components/canvas-agent-chat/ChatHistoryPanel';
import { ChatMessageList } from '@/app/components/canvas-agent-chat/ChatMessageList';
import { ChatQueuePanel } from '@/app/components/canvas-agent-chat/ChatQueuePanel';
import { ChatStarterScreen } from '@/app/components/canvas-agent-chat/ChatStarterScreen';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { toUploadMediaUrl } from '@/app/lib/utils/media-url';
import { useFileStore } from '@/app/store/file-store';
import { Link } from '@/i18n/navigation';
import { useRouter, useSearchParams } from 'next/navigation';
import { usePathname as useLocalePathname } from '@/i18n/navigation';
import { useLocale } from 'next-intl';
import { Button } from '@/components/ui/button';


import { ThemeToggle } from '@/app/components/ThemeToggle';

import { findActiveComposerReference, replaceComposerReference, type ComposerReferenceMatch } from '@/app/lib/chat/composer-references';
import { useIsMobile } from '@/hooks/use-mobile';
import { BUSINESS_STARTER_PROMPTS, STUDIO_STARTER_PROMPTS } from '@/app/lib/chat/starter-prompts';
import { ChatRuntimeActivityBadge } from '@/app/components/canvas-agent-chat/ChatRuntimeActivityBadge';
import { ChatModelSelector } from '@/app/components/canvas-agent-chat/ChatModelSelector';
import { AttachmentPreviewDialog } from '@/app/components/canvas-agent-chat/AttachmentPreviewDialog';
import { AttachmentPreviewItem } from '@/app/components/canvas-agent-chat/AttachmentPreviewItem';
import {
  createImageAttachmentFromMediaUrl,
  deriveUploadAttachmentPreview,
  getAttachmentMediaUrl,
} from '@/app/lib/chat/attachment-preview';
import {
  contentToString,
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
  isImagePart,
  isRecord,
  isToolCallPart,
  normalizeMessageStart,
  truncatePreview,
} from '@/app/lib/chat/message-content';
import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
import {
  getHistoryRuntimeActiveToolName,
  getHistoryRuntimePhase,
} from '@/app/lib/chat/runtime-message-utils';
import { areChatMessageListsEquivalent } from '@/app/lib/chat/message-equivalence';
import { safeFetchJson } from '@/app/lib/chat/fetch-json';
import {
  buildCachedChatSessionEntry,
  isCacheableMessageSet,
  persistChatSessionCache,
  readCachedChatSession,
  readLatestCachedChatSession,
  rememberChatSessionCacheEntry,
  removeCachedChatSession,
  updateCachedChatSessionTitle,
} from '@/app/lib/chat/session-cache';
import {
  createChatSession,
  deleteChatSession as deleteChatSessionRequest,
  fetchChatSessionMessages,
  fetchChatSessions,
  patchChatSessions,
} from '@/app/lib/chat/session-api';
import { getSessionDisplayTitle, isAutomaticSessionTitle } from '@/app/lib/pi/session-titles';
import { type CompactBreakMessage, isComposioAuthRequiredMessage, isRuntimeContinuationMessage, type ComposioAuthRequiredMessage } from '@/app/lib/pi/custom-messages';
import { renderSkillIcon } from '@/app/lib/skills/skill-icons';
import { searchSkillReferenceEntries } from '@/app/lib/skills/skill-reference-search';
import { useWebSocket } from '@/app/hooks/useWebSocket';
import { ImagePreprocessDialog } from '@/app/components/shared/ImagePreprocessDialog';
import type { ConvertParams } from '@/app/components/shared/ImagePreprocessDialog';
import { usePlanModeStore } from '@/app/store/plan-mode-store';
import { useToolVerbosityStore } from '@/app/store/tool-verbosity-store';
import { getToolDisplayInfo } from '@/app/lib/pi/tool-display';
import { cn } from '@/lib/utils';

import { PlanModeToggle } from './PlanModeToggle';
import { CANVAS_CHAT_ACTIVE_SESSION_STORAGE_KEY } from '@/app/lib/chat/constants';
import { loadComposerDraft, removeComposerDraft, saveComposerDraft } from '@/app/lib/chat/draft-storage';
import { applySessionUnreadUpdate } from '@/app/lib/chat/unread';
import { fetchChatAgentConfig, fetchChatAgents } from '@/app/lib/chat/agent-api';
import { getAgentDisplayName } from '@/app/lib/chat/agent-display';
import type {
  AgentConfig,
  AgentProfile,
  AISession,
  Attachment,
  ChatEvent,
  ChatHistoryAgentOption,
  ChatHistoryGroup,
  ChatHistoryGroups,
  ChatMessage,
  ChatRequestContext,
  PersistedChatMessage,
  PersistedToolCallPart,
  QueuePreviewItem,
  UserPiContent,
} from '@/app/lib/chat/types';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';

const CHAT_AGENT_ID = DEFAULT_AGENT_ID;

type FilePickerFile = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  isImage: boolean;
};

type SkillPickerSkill = Pick<AnthropicSkill, 'name' | 'title' | 'description' | 'enabled'>;
type ReferencePickerValue = FilePickerFile | SkillPickerSkill;

interface CanvasAgentChatProps {
  initialPrompt?: string | null;
  initialPromptStorageKey?: string;
  showSkillsLink?: boolean;
  hideNavHeader?: boolean;
  chatContainerWidth?: number;
  isSurfaceVisible?: boolean;
  forcedSessionId?: string | null;
  requestContext?: ChatRequestContext;
  onMediaClick?: (mediaUrl: string) => void;
}

const DEFAULT_PROVIDER_ID = '';
const DEFAULT_MODEL_ID = '';
const DEFAULT_THINKING_LEVEL: PiThinkingLevel = 'off';
const BOTTOM_LOCK_THRESHOLD_PX = 12;
const SCROLL_BUTTON_THRESHOLD_PX = 160;
const MOBILE_TEXTAREA_BASE_HEIGHT_PX = 56;
const DESKTOP_TEXTAREA_BASE_HEIGHT_PX = 72;
const MOBILE_TEXTAREA_MAX_HEIGHT_PX = 192;
const DESKTOP_TEXTAREA_MAX_HEIGHT_PX = 256;
const MOBILE_TEXTAREA_MAX_VIEWPORT_RATIO = 0.3;
const DESKTOP_TEXTAREA_MAX_VIEWPORT_RATIO = 0.35;
const TOUCH_SCROLL_UNLOCK_THRESHOLD_PX = 8;

type AgentModelState = {
  provider: string;
  model: string;
  thinkingLevel: PiThinkingLevel;
};

type InitialPromptPayload = {
  prompt: string;
  attachments: Attachment[];
  agentId: string | null;
};

const MANAGED_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function resolveAgentModelState(config: AgentConfig | null): AgentModelState | null {
  if (!config?.piConfig) {
    return null;
  }

  const provider = config.effectiveConfig?.activeProvider || config.piConfig.activeProvider;
  const providerConfig = config.piConfig.providers?.[provider];
  const model = config.effectiveConfig?.model || providerConfig?.model;
  if (!provider || !model) {
    return null;
  }

  return {
    provider,
    model,
    thinkingLevel: config.effectiveConfig?.thinkingLevel || providerConfig?.thinking || DEFAULT_THINKING_LEVEL,
  };
}

function resolveAgentProviderState(config: AgentConfig | null): AgentModelState {
  const provider = config?.effectiveConfig?.activeProvider || config?.piConfig?.activeProvider || DEFAULT_PROVIDER_ID;
  const providerConfig = provider ? config?.piConfig?.providers?.[provider] : undefined;
  const modelState = resolveAgentModelState(config);
  return {
    provider,
    model: modelState?.model || '',
    thinkingLevel: modelState?.thinkingLevel || providerConfig?.thinking || DEFAULT_THINKING_LEVEL,
  };
}

function isAgentConfigForAgent(config: AgentConfig | null, agentId: string): boolean {
  const configAgentId = config?.effectiveConfig?.agentId;
  return !configAgentId || configAgentId === agentId;
}

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

function isLiveMessageInProgress(message: ChatMessage): boolean {
  return Boolean(message.optimistic) ||
    message.status === 'pending' ||
    message.status === 'sending' ||
    message.status === 'aborting' ||
    message.status === 'queued_follow_up' ||
    message.status === 'queued_steering';
}

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

  return trimmed.slice(0, 50);
}

function buildQueuedMessageKey(text: string, attachmentCount: number): string {
  return `${text.trim()}::${attachmentCount}`;
}

function getAgentMessageTimestamp(message?: AgentMessage | null): number | null {
  const timestamp = (message as { timestamp?: unknown } | null | undefined)?.timestamp;
  return typeof timestamp === 'number' ? timestamp : null;
}

function countPiMessageImageAttachments(message?: AgentMessage | null): number {
  const content = getPiMessageContent(message);
  if (!Array.isArray(content)) {
    return 0;
  }

  return content.filter(isImagePart).length;
}

function getQueuedSignatureFromPiMessage(message?: AgentMessage | null): string | null {
  const timestamp = getAgentMessageTimestamp(message);
  if (timestamp === null || !message || message.role !== 'user') {
    return null;
  }

  return `${timestamp}:${extractPiMessageText(message)}:${countPiMessageImageAttachments(message)}`;
}

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

function getVisibleUserMessageKey(message: AgentMessage | null | undefined, fallbackContent: string): string {
  return buildQueuedMessageKey(fallbackContent, countPiMessageImageAttachments(message));
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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showMobileDetails, setShowMobileDetails] = useState(false);
  const [history, setHistory] = useState<AISession[]>([]);
  const [historySearchQuery, setHistorySearchQuery] = useState<string>('');
  const [historyUnreadOnly, setHistoryUnreadOnly] = useState<boolean>(false);
  const [historyAgentFilter, setHistoryAgentFilter] = useState<string>('all');
  const [historySidebarWidth, setHistorySidebarWidth] = useState(280);
  const historyResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const isHistoryResizing = useRef(false);
  const [latestSession, setLatestSession] = useState<AISession | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [activeModel, setActiveModel] = useState(DEFAULT_MODEL_ID);
  const [activeProvider, setActiveProvider] = useState(DEFAULT_PROVIDER_ID);
  const [activeThinkingLevel, setActiveThinkingLevel] = useState<PiThinkingLevel>(DEFAULT_THINKING_LEVEL);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [isAgentConfigLoading, setIsAgentConfigLoading] = useState(true);
  const [availableAgents, setAvailableAgents] = useState<AgentProfile[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState(CHAT_AGENT_ID);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [hasUnreadInCurrentSession, setHasUnreadInCurrentSession] = useState(false);
  const [showUnreadBanner, setShowUnreadBanner] = useState(false);
  const [totalUnreadCount, setTotalUnreadCount] = useState(0);
  const [openQueueItemPopoverId, setOpenQueueItemPopoverId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
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

  const [activeReferenceMatch, setActiveReferenceMatch] = useState<ComposerReferenceMatch | null>(null);
  const [referencePickerItems, setReferencePickerItems] = useState<ComposerReferencePickerItem<ReferencePickerValue>[]>([]);
  const [selectedReferenceIndex, setSelectedReferenceIndex] = useState(0);
  const [availableSkills, setAvailableSkills] = useState<SkillPickerSkill[] | null>(null);

  const isStudioChatContext = Boolean(requestContext?.currentPage?.startsWith('/studio') || pathname?.startsWith('/studio'));
  const starterPromptSource = isStudioChatContext ? STUDIO_STARTER_PROMPTS : BUSINESS_STARTER_PROMPTS;
  const starterPromptTranslationKey = isStudioChatContext ? 'studioStarterPrompts' : 'starterPrompts';
  const localizedStarterPrompts = starterPromptSource.map((prompt) => ({
    ...prompt,
    title: t(`${starterPromptTranslationKey}.${prompt.id}.title`),
    description: t(`${starterPromptTranslationKey}.${prompt.id}.description`),
    prompt: t(`${starterPromptTranslationKey}.${prompt.id}.prompt`),
  }));
  const [isLoadingReferenceItems, setIsLoadingReferenceItems] = useState(false);
  const [composerHeight, setComposerHeight] = useState(220);
  const [composerWidth, setComposerWidth] = useState(0);
  const [showComposerHint, setShowComposerHint] = useState(false);
  const [textareaHeight, setTextareaHeight] = useState(DESKTOP_TEXTAREA_BASE_HEIGHT_PX);

  // Upload states
  const [pendingUploads, setPendingUploads] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [imagePreprocessFiles, setImagePreprocessFiles] = useState<import('@/app/components/shared/ImagePreprocessDialog').PreprocessFileInfo[] | null>(null);
  const [imagePreprocessPendingFiles, setImagePreprocessPendingFiles] = useState<File[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const [previewAttachmentGroup, setPreviewAttachmentGroup] = useState<Attachment[]>([]);
  const isUploading = pendingUploads > 0;
  const isWebSocketUnavailable = wsError?.code === 'AUTH_ERROR';

  const referencePickerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialPromptConsumedRef = useRef(false);
  const requestedSessionCleanupRef = useRef<string | null>(null);
  const optimisticSessionTitlesRef = useRef<Record<string, string>>({});
  const toolMessageIdsRef = useRef<Record<string, string>>({});
  const currentAssistantIdRef = useRef<string | null>(null);
  const streamingContentRef = useRef<string>('');
  const lastFlushedStreamingContentRef = useRef<string>('');
  const streamingRafRef = useRef<number | null>(null);
  const thinkingFilterRef = useRef<ThinkingFilterState>(createThinkingFilterState());
  const thinkingContentRef = useRef<string>('');
  const runtimeStatusRef = useRef<RuntimeStatus | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sessionAgentIdRef = useRef<string>(CHAT_AGENT_ID);
  const surfaceVisibleRef = useRef(isSurfaceVisible);
  const lastCompactionMarkerRef = useRef<string | null>(null);
  const userStartedNewChatRef = useRef(false);
  const previousMessageCountRef = useRef(0);
  const isAtBottomRef = useRef(true);
  const autoScrollRef = useRef<{ top: number; time: number } | null>(null);
  const autoScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchScrollStartYRef = useRef<number | null>(null);
  const composerMeasureRafRef = useRef<number | null>(null);
  const referenceRequestIdRef = useRef(0);
  const messagesRef = useRef<ChatMessage[]>([]);
  const refreshSavedMessagesRef = useRef<((sessionId: string) => void) | null>(null);
  const deferredSavedMessageRefreshSessionRef = useRef<string | null>(null);
  const subscribedSessionAckRef = useRef<string | null>(null);
  const subscribedSessionRequestRef = useRef<{ sessionId: string; promise: Promise<void> } | null>(null);
  const sessionListRequestRef = useRef<Promise<AISession[]> | null>(null);
  const loadSessionRequestIdRef = useRef(0);
  const loadSessionAbortRef = useRef<AbortController | null>(null);
  const skipNextSessionStatusRefreshRef = useRef<string | null>(null);
  const cachePersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeObserverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLoadedSessionListRef = useRef(false);
  const inputHistoryCursorRef = useRef<number | null>(null);
  const inputHistoryDraftRef = useRef('');
  const historyRef = useRef<AISession[]>([]);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const userMessageHistory = useMemo(() => (
    messages
      .filter((message) => message.role === 'user')
      .map((message) => contentToString(message.content).trim())
      .filter(Boolean)
  ), [messages]);

  const resetInputHistoryNavigation = useCallback(() => {
    inputHistoryCursorRef.current = null;
    inputHistoryDraftRef.current = '';
  }, []);

  const applyInputHistoryValue = useCallback((value: string) => {
    setInput(value);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(value.length, value.length);
    });
  }, []);

  // Sync messagesRef with messages state
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

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
    return () => {
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
    };
  }, []);

  // Persist composer text as draft when user types
  useEffect(() => {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
    }
    draftSaveTimerRef.current = setTimeout(() => {
      const key = sessionIdRef.current ?? '__new__';
      if (input.trim()) {
        saveComposerDraft(key, input);
      } else {
        removeComposerDraft(key);
      }
    }, 300);
  }, [input]);

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
  }, [activeModel, activeProvider, activeThinkingLevel, hasMoreBefore, messages, oldestMessageId, oldestSequence, oldestTimestamp, selectedAgentId, sessionId, sessionTitle]);

  const getTextareaBaseHeight = useCallback(() => (
    isMobile ? MOBILE_TEXTAREA_BASE_HEIGHT_PX : DESKTOP_TEXTAREA_BASE_HEIGHT_PX
  ), [isMobile]);

  const getTextareaMaxHeight = useCallback(() => {
    if (typeof window === 'undefined') {
      return isMobile ? MOBILE_TEXTAREA_MAX_HEIGHT_PX : DESKTOP_TEXTAREA_MAX_HEIGHT_PX;
    }

    const viewportLimit = Math.floor(
      window.innerHeight * (isMobile ? MOBILE_TEXTAREA_MAX_VIEWPORT_RATIO : DESKTOP_TEXTAREA_MAX_VIEWPORT_RATIO),
    );
    const fixedLimit = isMobile ? MOBILE_TEXTAREA_MAX_HEIGHT_PX : DESKTOP_TEXTAREA_MAX_HEIGHT_PX;
    return Math.max(getTextareaBaseHeight(), Math.min(fixedLimit, viewportLimit));
  }, [getTextareaBaseHeight, isMobile]);

  const syncTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const baseHeight = getTextareaBaseHeight();
    const maxHeight = getTextareaMaxHeight();
    textarea.style.height = 'auto';
    const nextHeight = Math.max(baseHeight, Math.min(Math.ceil(textarea.scrollHeight), maxHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
    setTextareaHeight((current) => (current === nextHeight ? current : nextHeight));
  }, [getTextareaBaseHeight, getTextareaMaxHeight]);

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
  }, [hasLiveMessagesInProgress]);

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
  }, [hasLiveMessagesInProgress, messages, runtimeStatus?.phase, sessionId]);

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
  }, []);

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

  // Listen for session_updated events (from WebSocket client) to update history unread status
  useEffect(() => {
    const handleSessionUpdated = (event: CustomEvent<{ sessionId: string; lastMessageAt: string; title?: string }>) => {
      const { sessionId, lastMessageAt, title } = event.detail;
      const currentSessionId = sessionIdRef.current;
      const currentVisible = surfaceVisibleRef.current;
      const isCurrentVisibleSession = sessionId === currentSessionId && currentVisible;
      console.log(`[CanvasAgentChat] session_updated received: sessionId=${sessionId}, lastMessageAt=${lastMessageAt}, title="${title}", currentSessionId=${currentSessionId}, surfaceVisible=${currentVisible}, isCurrentVisibleSession=${isCurrentVisibleSession}`);
      const sessionFound = historyRef.current.some((session) => session.sessionId === sessionId);
      const resolvedTitle = resolveSessionTitle(sessionId, title);

      // Update history state to reflect new lastMessageAt (and title if provided)
      setHistory(prev => {
        const updated = prev.map(session => {
          if (session.sessionId !== sessionId) return session;
          const updatedSession = applySessionUnreadUpdate(session, event.detail, {
            isCurrentVisibleSession,
            title: resolvedTitle,
          });
          console.log(`[CanvasAgentChat] Unread calc for ${sessionId}: isCurrentVisible=${isCurrentVisibleSession}, lastMessageAt=${lastMessageAt}, lastViewedAt=${session.lastViewedAt}, newLastViewedAt=${updatedSession.lastViewedAt}, hasUnread=${updatedSession.hasUnread}`);
          return updatedSession;
        });

        // Recalculate unread count
        const unreadCount = updated.filter(s => s.hasUnread).length;
        setTotalUnreadCount(unreadCount);
        historyRef.current = updated;

        return updated;
      });

      if (resolvedTitle && sessionId === sessionIdRef.current) {
        setSessionTitle(resolvedTitle);
      }

      if (isCurrentVisibleSession) {
        requestSavedMessageRefresh(sessionId);
        void patchChatSessions({ agentId: sessionAgentIdRef.current || selectedAgentId, sessionId, markAsRead: true }).catch((error) => {
          console.error('Failed to mark active session as read after response', error);
        });
      }

      if (!sessionFound) {
        void (async () => {
          try {
            const sessions = await loadSessionList();
            setHistory(sessions);
            setLatestSession(sessions[0] || null);
            setTotalUnreadCount(sessions.filter((session: AISession) => session.hasUnread).length);
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
  }, [loadSessionList, requestSavedMessageRefresh, resolveSessionTitle, selectedAgentId]);

  // Session is created on-demand when user sends first message

  useLayoutEffect(() => {
    syncTextareaHeight();
  }, [input, isMobile, syncTextareaHeight]);

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

  const markAutoScroll = useCallback((container: HTMLElement) => {
    autoScrollRef.current = {
      top: Math.max(0, container.scrollHeight - container.clientHeight),
      time: Date.now(),
    };

    if (autoScrollTimerRef.current) {
      clearTimeout(autoScrollTimerRef.current);
    }

    autoScrollTimerRef.current = setTimeout(() => {
      autoScrollRef.current = null;
      autoScrollTimerRef.current = null;
    }, 1500);
  }, []);

  const isProgrammaticScroll = useCallback((container: HTMLElement) => {
    const marker = autoScrollRef.current;
    if (!marker) {
      return false;
    }

    if (Date.now() - marker.time > 1500) {
      autoScrollRef.current = null;
      return false;
    }

    return Math.abs(container.scrollTop - marker.top) < 2;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const container = scrollContainerRef.current;
    if (!container) return;
    markAutoScroll(container);
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    setShowScrollButton(false);
    if (behavior === 'auto') {
      container.scrollTop = container.scrollHeight - container.clientHeight;
    } else {
      container.scrollTo({ top: container.scrollHeight, behavior });
    }
  }, [markAutoScroll]);

  const releaseBottomLock = useCallback(() => {
    if (!isAtBottomRef.current) {
      return;
    }

    isAtBottomRef.current = false;
    setIsAtBottom(false);
  }, []);

  const syncBottomLockState = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return true;
    }

    const distanceFromBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    const nextIsAtBottom = distanceFromBottom <= BOTTOM_LOCK_THRESHOLD_PX;
    const nextShowScrollButton = distanceFromBottom > SCROLL_BUTTON_THRESHOLD_PX;
    isAtBottomRef.current = nextIsAtBottom;
    setIsAtBottom((current) => {
      if (current === nextIsAtBottom) return current;
      return nextIsAtBottom;
    });
    setShowScrollButton((current) => {
      if (current === nextShowScrollButton) return current;
      return nextShowScrollButton;
    });
    return nextIsAtBottom;
  }, []);

  const handleScroll = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer && isAtBottomRef.current && isProgrammaticScroll(scrollContainer)) {
      scrollToBottom('auto');
      return;
    }

    syncBottomLockState();
  }, [isProgrammaticScroll, scrollToBottom, syncBottomLockState]);

  const handleWheel = useCallback((event: WheelEvent) => {
    if (event.deltaY < 0) {
      releaseBottomLock();
    }
  }, [releaseBottomLock]);

  const handleTouchStart = useCallback((event: TouchEvent) => {
    touchScrollStartYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMove = useCallback((event: TouchEvent) => {
    const startY = touchScrollStartYRef.current;
    const currentY = event.touches[0]?.clientY;
    if (startY == null || currentY == null) {
      return;
    }

    if (currentY - startY > TOUCH_SCROLL_UNLOCK_THRESHOLD_PX) {
      releaseBottomLock();
    }
  }, [releaseBottomLock]);

  const handleTouchEnd = useCallback(() => {
    touchScrollStartYRef.current = null;
  }, []);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;
    syncBottomLockState();
    scrollContainer.addEventListener('scroll', handleScroll);
    scrollContainer.addEventListener('wheel', handleWheel, { passive: true });
    scrollContainer.addEventListener('touchstart', handleTouchStart, { passive: true });
    scrollContainer.addEventListener('touchmove', handleTouchMove, { passive: true });
    scrollContainer.addEventListener('touchend', handleTouchEnd);
    scrollContainer.addEventListener('touchcancel', handleTouchEnd);
    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll);
      scrollContainer.removeEventListener('wheel', handleWheel);
      scrollContainer.removeEventListener('touchstart', handleTouchStart);
      scrollContainer.removeEventListener('touchmove', handleTouchMove);
      scrollContainer.removeEventListener('touchend', handleTouchEnd);
      scrollContainer.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [handleScroll, handleTouchEnd, handleTouchMove, handleTouchStart, handleWheel, syncBottomLockState]);

  // ═══════════════════════════════════════════════════════════════════
  // Scroll-Effekt: ResizeObserver mit Debounce
  // ═══════════════════════════════════════════════════════════════════
  // WICHTIG: Dieser Observer reagiert auf *jede* Höhenänderung im Chat-
  // Content (z.B. Streaming-Text, kollabierte Tool-Nachrichten, oder
  // asynchron geladene Bilder). Ohne Debounce führt das schnelle Hoch-
  // /Runter-Springen, wenn z.B. ein Bild von SafeMarkdownImage plötzlich
  // erscheint.
  //
  // Der Debounce (200 ms) fasst schnelle, aufeinanderfolgende Resize-
  // Events zu einem einzigen scrollToBottom zusammen. Manuelle Aufrufe
  // von scrollToBottom (z.B. beim Senden oder bei neuer Nachricht)
  // werden dadurch NICHT beeinflusst.
  // ═══════════════════════════════════════════════════════════════════
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const scrollContent = scrollContentRef.current;
    if (!scrollContainer || !scrollContent) return;

    const resizeObserver = new ResizeObserver(() => {
      if (!isAtBottomRef.current) return;

      if (resizeObserverTimerRef.current) {
        clearTimeout(resizeObserverTimerRef.current);
      }

      resizeObserverTimerRef.current = setTimeout(() => {
        resizeObserverTimerRef.current = null;
        scrollToBottom('auto');
      }, 200);
    });

    resizeObserver.observe(scrollContent);
    return () => {
      resizeObserver.disconnect();
      if (resizeObserverTimerRef.current) {
        clearTimeout(resizeObserverTimerRef.current);
        resizeObserverTimerRef.current = null;
      }
    };
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    if (messages.length === 0) {
      previousMessageCountRef.current = 0;
      isAtBottomRef.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsAtBottom(true);
      setShowScrollButton(false);
      return;
    }

    const messageCountIncreased = messages.length > previousMessageCountRef.current;

    if (!messageCountIncreased) {
      previousMessageCountRef.current = messages.length;
      return;
    }

    const lastMessage = messages[messages.length - 1];

    if (isAtBottomRef.current || lastMessage.role === 'user') {
      scrollToBottom(lastMessage.role === 'user' ? 'smooth' : 'auto');
    }

    previousMessageCountRef.current = messages.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run on count change, not on every message mutation
  }, [messages.length, scrollToBottom]);

  const fetchHistory = useCallback(async () => {
    setIsLoadingHistory(true);
    try {
      const currentVisibleSessionId = surfaceVisibleRef.current ? sessionIdRef.current : null;
      const sessions = await loadSessionList();
      const activeVisibleUnreadSession = currentVisibleSessionId
        ? sessions.find((session: AISession) => session.sessionId === currentVisibleSessionId && session.hasUnread)
        : null;
      const visibleSessions = activeVisibleUnreadSession
        ? sessions.map((session: AISession) => (
            session.sessionId === currentVisibleSessionId
              ? {
                  ...session,
                  hasUnread: false,
                  lastViewedAt: session.lastMessageAt || new Date().toISOString(),
                }
              : session
          ))
        : sessions;

      if (activeVisibleUnreadSession && currentVisibleSessionId) {
        setHasUnreadInCurrentSession(false);
        setShowUnreadBanner(false);
        void patchChatSessions({ agentId: sessionAgentIdRef.current || selectedAgentId, sessionId: currentVisibleSessionId, markAsRead: true }).catch((error) => {
          console.error('Failed to mark active session as read after history refresh', error);
        });
      }

      setHistory(visibleSessions);
      setLatestSession(visibleSessions[0] || null);
      
      // Calculate total unread count
      const unreadCount = visibleSessions.filter((s: AISession) => s.hasUnread).length;
      setTotalUnreadCount(unreadCount);

      if (sessionIdRef.current) {
        const currentSession = visibleSessions.find((session: AISession) => session.sessionId === sessionIdRef.current);
        if (currentSession) {
          setSessionTitle(resolveSessionTitle(currentSession.sessionId, currentSession.title));
        }
      }
    } catch (err) {
      console.error('Failed to fetch history', err);
    } finally {
      setIsLoadingHistory(false);
    }
  }, [loadSessionList, resolveSessionTitle, selectedAgentId]);

  const markAllAsRead = useCallback(async () => {
    try {
      const data = await patchChatSessions({ agentId: selectedAgentId, markAllAsRead: true });
      if (data?.success) {
        const now = data.lastViewedAt;
        setHistory((prev) => prev.map((s) => s.hasUnread ? { ...s, lastViewedAt: s.lastMessageAt || now, hasUnread: false } : s));
        setTotalUnreadCount(0);
      }
    } catch (err) {
      console.error('Failed to mark all as read', err);
    }
  }, [selectedAgentId]);

  const getSessionTimeGroup = useCallback((dateString: string): ChatHistoryGroup => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return 'today';
    if (diffDays <= 7) return 'last7';
    if (diffDays <= 14) return 'last14';
    if (diffDays <= 30) return 'last30';
    return 'older';
  }, []);

  const resetStreamConnection = useCallback(() => {
    currentAssistantIdRef.current = null;
    if (streamingRafRef.current !== null) {
      cancelAnimationFrame(streamingRafRef.current);
      streamingRafRef.current = null;
    }
    streamingContentRef.current = '';
    thinkingFilterRef.current = createThinkingFilterState();
    thinkingContentRef.current = '';
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
  }, []);

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
  }, []);

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
  }, []);

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
  }, []);

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
  }, [t]);

  const toggleToolMessage = useCallback((messageId: string) => {
    setMessages((prev) =>
      prev.map((message) => (
        message.id === messageId && message.role === 'toolResult'
          ? { ...message, isCollapsed: !message.isCollapsed, autoCollapsedAtEnd: false }
          : message
      )),
    );
  }, []);

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
  }, []);

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

    setHistory((prevHistory) => {
      // Check if session already exists (shouldn't happen, but safety check)
      const exists = prevHistory.some(s => s.sessionId === nextSessionId);
      if (exists) return prevHistory;

      // Add new session at the beginning and re-sort by lastMessageAt
      const updated = [newSession, ...prevHistory];
      updated.sort((a, b) => {
        const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : new Date(a.createdAt).getTime();
        const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : new Date(b.createdAt).getTime();
        return bTime - aTime;
      });
      return updated;
    });
    setLatestSession(newSession);

    // Note: Subscription happens automatically via useEffect when sessionId changes
    // No need to subscribe here manually to avoid double subscription

    return nextSessionId;
  }, [activeModel, activeProvider, activeThinkingLevel, agentConfig, input, selectedAgentId, t]);

  // Helper to sync PI message to chat
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

  // Helper to find existing message by PI message (to prevent duplicates when loading from DB + receiving stream events)
  const findExistingMessageByPiMessage = useCallback((message?: AgentMessage): string | null => {
    if (!message) return null;
    
    // Use PI message timestamp as unique identifier
    const piTimestamp = (message as { timestamp?: number }).timestamp;
    if (!piTimestamp) return null;
    
    // Check current messages for one with matching PI timestamp
    const existingId = messagesRef.current.find(
      (m: ChatMessage) => m.role === 'assistant' && m.piMessage && (m.piMessage as { timestamp?: number }).timestamp === piTimestamp
    )?.id;
    
    return existingId || null;
  }, []);

  // Helper to create assistant message bubble
  const createAssistantBubble = useCallback((message?: AgentMessage) => {
    // Check if message already exists (e.g., loaded from DB)
    const existingId = findExistingMessageByPiMessage(message);
    if (existingId) {
      // Message already exists, use existing ID and don't create duplicate
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
  }, [setMessages, findExistingMessageByPiMessage]);

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
  }, [scrollToBottom]);



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
                    : msg
                )
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
      // Stop the RAF loop and do one final authoritative sync from the PI message object.
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
      return;
    }

    // Note: event types 'message', 'message_delta', and 'messages' are no longer produced
    // by LivePiRuntime. The live runtime uses message_start / message_update / message_end.
  }, [appendCompactionBreak, appendSystemMessage, createAssistantBubble, requestSavedMessageRefresh, scrollToBottom, setMessages, setRuntimeStatusWithReconciliation, syncPiMessage, t, upsertToolMessage, upsertUserMessageFromPiMessage]);

  // Listen for WebSocket agent events (from current tab, other tabs, or background runs).
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
  }, [handleStreamEvent]);

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
  }, []);

  const scanForImageReferences = useCallback(async (): Promise<Attachment[]> => {
    // This function is disabled for now - it would need a different approach
    // with the new ID-based system. Images need to be explicitly uploaded.
    return [];
  }, []);

  const runtimePhase = runtimeStatus?.phase;

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
        })
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
        if (currentAssistantIdRef.current === optimisticAssistantId) {
          currentAssistantIdRef.current = null;
        }
      }
      throw error;
    }

    return;
  }, [activeModel, agentConfig, appendOptimisticUserMessage, attachments, buildRequestContext, createAssistantBubble, currentFile, ensureSession, ensureSessionSubscribed, input, isUploading, postControl, resetInputHistoryNavigation, runtimePhase, selectedAgentId, showHistory, isMobile, setOptimisticRuntimePhase, setRuntimeStatusWithReconciliation, shouldShowHistoryAsOverlay, scanForImageReferences, t, wsRequest]);

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
  }, [messages, postControl, appendSystemMessage, t, setInput, setAttachments]);

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
    lastCompactionMarkerRef.current = null;
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
    toolMessageIdsRef.current = {};
  }, [agentConfig, input, resetInputHistoryNavigation, resetStreamConnection, selectedAgentId, isMobile, shouldShowHistoryAsOverlay]);

  const selectChatAgent = useCallback((agentId: string) => {
    if (agentId === selectedAgentId && !sessionIdRef.current) {
      return;
    }
    setSelectedAgentId(agentId);
    setHistoryAgentFilter(agentId);
    sessionListRequestRef.current = null;
    hasLoadedSessionListRef.current = false;
    setHistory([]);
    setLatestSession(null);
    setTotalUnreadCount(0);
    startNewChat(agentId);
    void fetchHistory();
  }, [fetchHistory, selectedAgentId, startNewChat]);

  const mapRawMessage = useCallback((
    rawMessage: PersistedChatMessage,
    toolCallsById: Map<string, PersistedToolCallPart> = new Map(),
  ): ChatMessage => {
    if (rawMessage.role === 'compact-break') {
      const cb = rawMessage as unknown as CompactBreakMessage;
      return {
        id: rawMessage.id?.toString() || `compact-${cb.timestamp}`,
        role: 'system' as const,
        content: '',
        type: 'compact_break' as const,
        status: 'sent' as const,
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
        role: 'system' as const,
        content: `Authentication required for ${authMsg.toolkitName}. [Connect ${authMsg.toolkitName}](${authMsg.redirectUrl})`,
        type: 'composio_auth_required' as const,
        status: 'sent' as const,
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
      ? t('runStopped')
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
  }, [t]);

  const mapRawMessages = useCallback((rawMessages: PersistedChatMessage[]): ChatMessage[] => {
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
      .map((rawMessage) => mapRawMessage(rawMessage, toolCallsById));
  }, [mapRawMessage]);

  const hydrateMessageRefsFromMessages = useCallback((nextMessages: ChatMessage[]) => {
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
          hydrateMessageRefsFromMessages(nextMessages);
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
  }, [hydrateMessageRefsFromMessages, mapRawMessages, scrollToBottom, selectedAgentId]);

  useEffect(() => {
    refreshSavedMessagesRef.current = refreshSavedMessages;
    return () => {
      if (refreshSavedMessagesRef.current === refreshSavedMessages) {
        refreshSavedMessagesRef.current = null;
      }
    };
  }, [refreshSavedMessages]);

  const loadSession = useCallback(async (session: AISession) => {
    const sessionAgentId = session.agentId || CHAT_AGENT_ID;
    const requestId = loadSessionRequestIdRef.current + 1;
    loadSessionRequestIdRef.current = requestId;
    loadSessionAbortRef.current?.abort();
    const abortController = new AbortController();
    loadSessionAbortRef.current = abortController;

    resetStreamConnection();
    setSelectedAgentId(sessionAgentId);
    setSessionId(session.sessionId);
    setSessionTitle(resolveSessionTitle(session.sessionId, session.title));
    sessionIdRef.current = session.sessionId;
    sessionAgentIdRef.current = sessionAgentId;
    lastCompactionMarkerRef.current = null;
    userStartedNewChatRef.current = false;
    const sessionDraft = loadComposerDraft(session.sessionId);
    setInput(sessionDraft ?? '');
    setShowMobileDetails(false);
    const sessionProvider = session.provider || agentConfig?.piConfig?.activeProvider || 'pi';
    setActiveProvider(sessionProvider);
    setActiveModel(session.model || DEFAULT_MODEL_ID);
    setActiveThinkingLevel(
      session.thinkingLevel ||
      agentConfig?.piConfig?.providers?.[sessionProvider]?.thinking ||
      DEFAULT_THINKING_LEVEL,
    );
    setHasMoreBefore(false);
    setOldestTimestamp(null);
    setOldestMessageId(null);
    setOldestSequence(null);
    setIsLoadingOlder(false);
    setExpandedRunKeys(new Set());
    setRuntimeStatus(null);
    toolMessageIdsRef.current = {};

    const cachedEntry = readCachedChatSession(sessionAgentId, session.sessionId) || readLatestCachedChatSession(session.sessionId);
    const hasCachedMessages = Boolean(cachedEntry && isCacheableMessageSet(cachedEntry.messages));

    if (cachedEntry && hasCachedMessages) {
      setMessages(cachedEntry.messages);
      hydrateMessageRefsFromMessages(cachedEntry.messages);
      setHasMoreBefore(cachedEntry.hasMoreBefore);
      setOldestTimestamp(cachedEntry.oldestTimestamp);
      setOldestMessageId(cachedEntry.oldestMessageId);
      setOldestSequence(cachedEntry.oldestSequence);
      requestAnimationFrame(() => {
        scrollToBottom('auto');
      });
    } else {
      hydrateMessageRefsFromMessages([]);
      setMessages([{ id: 'system', role: 'system', content: 'Loading...', status: 'pending', type: 'system' }]);
    }

    // Always close history on mobile, conditionally on desktop
    if (isMobile || shouldShowHistoryAsOverlay) {
      setShowHistory(false);
    }

    // Check if session has unread messages and show banner
    console.log(`[CanvasAgentChat] loadSession: sessionId=${session.sessionId}, hasUnread=${session.hasUnread}, lastMessageAt=${session.lastMessageAt}, lastViewedAt=${session.lastViewedAt}`);
    if (session.hasUnread) {
      setHasUnreadInCurrentSession(true);
      setShowUnreadBanner(true);
      setHistory(prev => {
        const updated = prev.map(s =>
          s.sessionId === session.sessionId ? { ...s, hasUnread: false, lastViewedAt: new Date().toISOString() } : s
        );
        setTotalUnreadCount(updated.filter(s => s.hasUnread).length);
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
          hydrateMessageRefsFromMessages(nextMessages);
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

      // Hide history view after loading session (always on mobile, conditionally on desktop)
      if (isMobile || shouldShowHistoryAsOverlay) {
        setShowHistory(false);
      }

      // Force scroll to bottom after session load
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
          lastCompactionMarkerRef.current = (statusPayload.status as RuntimeStatus).lastCompactionAt || null;
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
  }, [agentConfig, ensureSessionSubscribed, hydrateMessageRefsFromMessages, mapRawMessages, resetStreamConnection, resolveSessionTitle, scrollToBottom, setRuntimeStatusWithReconciliation, t, isMobile, shouldShowHistoryAsOverlay, wsRequest]);

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

        setMessages(prev => [...olderMessages, ...prev]);
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

        // Preserve scroll position after prepending messages
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
  }, [hasMoreBefore, isLoadingOlder, mapRawMessages, oldestMessageId, oldestSequence, oldestTimestamp, selectedAgentId]);

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
  }, [history, selectedAgentId, startNewChat, t]);

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
  }, [selectedAgentId, t]);

  const handleFileUploadMultiple = useCallback(async (files: File[], convertParams?: (ConvertParams | null)[]) => {
    if (files.length === 0) {
      return;
    }
    setPendingUploads((count) => count + 1);
    setUploadError(null);
    
    try {
      const formData = new FormData();
      files.forEach((file) => formData.append('file', file));

      if (convertParams && convertParams.length > 0) {
        const paramsSerializable = convertParams.map((p) =>
          p ? { format: p.format, quality: p.quality, maxDimension: p.maxDimension } : null
        );
        formData.append('convertParams', JSON.stringify(paramsSerializable));
      }
      
      const res = await fetch('/api/upload/attachment', { method: 'POST', body: formData });
      const data = await safeFetchJson<{ success: boolean; error?: string; errors?: string[]; files?: { id: string; originalName: string; mimeType: string; size?: number; category: string }[] }>(res);
      
      if (!data || !data.success) {
        throw new Error(data?.error ?? 'Upload failed');
      }
      
      // API now returns array of files
      const uploadedFiles = data.files || [];
      
      const attachments: Attachment[] = uploadedFiles.map((uploadedFile: {
        id: string;
        originalName: string;
        mimeType: string;
        size?: number;
        category: string;
      }) => {
        const isImage = uploadedFile.category === 'image';
        return deriveUploadAttachmentPreview({
          name: uploadedFile.originalName,
          contentKind: isImage ? 'image' : 'document',
          id: uploadedFile.id,
          mimeType: uploadedFile.mimeType,
          size: uploadedFile.size,
          category: uploadedFile.category,
        });
      });
      
      setAttachments((prev) => [...prev, ...attachments]);
      
      // Show warning if some files failed
      if (data.errors && data.errors.length > 0) {
        setUploadError(`Einige Dateien konnten nicht hochgeladen werden: ${data.errors.join(', ')}`);
      }
    } catch (err) {
      console.error('Upload failed', err);
      setUploadError(err instanceof Error ? err.message : 'Upload fehlgeschlagen. Netzwerkfehler oder Server nicht erreichbar.');
    } finally {
      setPendingUploads((count) => Math.max(0, count - 1));
    }
  }, []);

  const preprocessAndUpload = useCallback(async (files: File[]) => {
    const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence']);
    const HEIC_EXTS = new Set(['heic', 'heif']);
    const SIZE_THRESHOLD = 1_500_000;
    const preprocessFiles: import('@/app/components/shared/ImagePreprocessDialog').PreprocessFileInfo[] = [];
    const normalFiles: File[] = [];

    for (const file of files) {
      const isHeic = HEIC_TYPES.has(file.type.toLowerCase()) || HEIC_EXTS.has(file.name.split('.').pop()?.toLowerCase() ?? '');
      const isImage = file.type.startsWith('image/') || HEIC_EXTS.has(file.name.split('.').pop()?.toLowerCase() ?? '');
      const isLarge = isImage && file.size > SIZE_THRESHOLD;
      if (isHeic || isLarge) {
        preprocessFiles.push({ file, isHeic, isLarge });
      } else {
        normalFiles.push(file);
      }
    }

    if (normalFiles.length > 0) {
      await handleFileUploadMultiple(normalFiles);
    }
    if (preprocessFiles.length > 0) {
      setImagePreprocessPendingFiles(preprocessFiles.map((f) => f.file));
      setImagePreprocessFiles(preprocessFiles);
    }
  }, [handleFileUploadMultiple]);

  const handleImagePreprocessConfirm = useCallback(async (convertParams: (ConvertParams | null)[]) => {
    await handleFileUploadMultiple(imagePreprocessPendingFiles, convertParams);
    setImagePreprocessFiles(null);
    setImagePreprocessPendingFiles([]);
  }, [handleFileUploadMultiple, imagePreprocessPendingFiles]);

  const handleImagePreprocessSkip = useCallback(async () => {
    const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence']);
    const HEIC_EXTS = new Set(['heic', 'heif']);
    const nonHeicFiles = imagePreprocessPendingFiles.filter((f) => {
      return !HEIC_TYPES.has(f.type.toLowerCase()) && !HEIC_EXTS.has(f.name.split('.').pop()?.toLowerCase() ?? '');
    });
    if (nonHeicFiles.length > 0) {
      await handleFileUploadMultiple(nonHeicFiles);
    }
    setImagePreprocessFiles(null);
    setImagePreprocessPendingFiles([]);
  }, [handleFileUploadMultiple, imagePreprocessPendingFiles]);

  const onFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length > 0) preprocessAndUpload(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [preprocessAndUpload]);

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const pastedImages: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const renamedFile = new File([file], `screenshot-${timestamp}.png`, { type: file.type });
          pastedImages.push(renamedFile);
        }
      }
    }
    if (pastedImages.length > 0) {
      void preprocessAndUpload(pastedImages);
      return;
    }
    if (pastedImages.length === 0) {
      const text = event.clipboardData?.getData('text') ?? '';
      if (/\.(png|jpe?g|webp|gif)$/i.test(text.trim())) {
        setUploadError('Tipp: Dateien aus dem Finder können nicht direkt eingefügt werden. Bitte nutze die Büroklammer zum Hochladen, oder kopiere das Bild direkt (z.B. Screenshot).');
      }
    }
  }, [preprocessAndUpload]);

  const closeReferencePicker = useCallback(() => {
    setActiveReferenceMatch(null);
    setReferencePickerItems([]);
    setSelectedReferenceIndex(0);
    referenceRequestIdRef.current += 1;
  }, []);

  const fetchFiles = useCallback(async (query: string = '', requestId: number) => {
    try {
      const res = await fetch(`/api/files/list?q=${encodeURIComponent(query)}&limit=50`);
      const data = await safeFetchJson<{ success: boolean; files?: FilePickerFile[] }>(res);
      if (requestId !== referenceRequestIdRef.current) {
        return;
      }

      if (data?.success) {
        const items = (data.files as FilePickerFile[]).map((file) => ({
          id: `file:${file.path}`,
          kind: 'file' as const,
          icon: getFileIconComponent({ name: file.name, path: file.path, type: file.type }),
          label: file.path,
          payload: file,
        }));
        setReferencePickerItems(items);
        setSelectedReferenceIndex(0);
      }
    } catch (err) {
      console.error('Failed to fetch files', err);
    }
  }, []);

  const setSkillReferenceItems = useCallback((skills: SkillPickerSkill[], query: string) => {
    const items = searchSkillReferenceEntries(skills, query).map((skill) => ({
      id: `skill:${skill.name}`,
      kind: 'skill' as const,
      icon: renderSkillIcon(skill.name, skill.description),
      label: skill.title,
      secondaryLabel: `/${skill.name}`,
      payload: skill,
    }));
    setReferencePickerItems(items);
    setSelectedReferenceIndex(0);
  }, []);

  const fetchSkills = useCallback(async () => {
    if (availableSkills) {
      return availableSkills;
    }

    try {
      const res = await fetch('/api/skills');
      const data = await safeFetchJson<{ success: boolean; skills?: Array<SkillPickerSkill & { path?: string }> }>(res);
      if (!data?.success) {
        return [];
      }

      const nextSkills = (data.skills || []).filter((skill) => skill.enabled).map((skill) => ({
        description: skill.description,
        enabled: skill.enabled,
        name: skill.name,
        title: skill.title,
      }));
      setAvailableSkills(nextSkills);
      return nextSkills;
    } catch (err) {
      console.error('Failed to fetch skills', err);
      return [];
    }
  }, [availableSkills]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart;
    resetInputHistoryNavigation();
    setInput(value);

    const match = findActiveComposerReference(value, cursorPos);
    if (!match) {
      setIsLoadingReferenceItems(false);
      closeReferencePicker();
      return;
    }

    setActiveReferenceMatch(match);
    setIsLoadingReferenceItems(true);
    const requestId = referenceRequestIdRef.current + 1;
    referenceRequestIdRef.current = requestId;

    if (match.kind === 'file') {
      void fetchFiles(match.query, requestId).finally(() => {
        if (referenceRequestIdRef.current === requestId) {
          setIsLoadingReferenceItems(false);
        }
      });
      return;
    }

    void fetchSkills().then((skills) => {
      if (referenceRequestIdRef.current !== requestId) {
        return;
      }

      setSkillReferenceItems(skills, match.query);
      setIsLoadingReferenceItems(false);
    });
  }, [closeReferencePicker, fetchFiles, fetchSkills, resetInputHistoryNavigation, setSkillReferenceItems]);

  const handleReferenceSelect = useCallback((item: ComposerReferencePickerItem<ReferencePickerValue>) => {
    if (!activeReferenceMatch) {
      return;
    }

    const replacement = item.kind === 'file'
      ? `@"${(item.payload as FilePickerFile).path}" `
      : `/${(item.payload as SkillPickerSkill).name} `;
    const { nextValue, nextCursorPosition } = replaceComposerReference(input, activeReferenceMatch, replacement);

    resetInputHistoryNavigation();
    setInput(nextValue);
    closeReferencePicker();

    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursorPosition, nextCursorPosition);
    }, 0);
  }, [activeReferenceMatch, closeReferencePicker, input, resetInputHistoryNavigation]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  const handleAttachmentPreviewOpen = useCallback((attachment: Attachment, previewGroup?: Attachment[]) => {
    const displayAttachment = deriveUploadAttachmentPreview(attachment);
    const mediaUrl = getAttachmentMediaUrl(displayAttachment);
    if (mediaUrl && onMediaClick) {
      onMediaClick(mediaUrl);
      return;
    }
    const displayGroup = (previewGroup?.length ? previewGroup : [displayAttachment])
      .map((item) => deriveUploadAttachmentPreview(item))
      .filter((item) => item.contentKind === 'image');
    setPreviewAttachment(displayAttachment);
    setPreviewAttachmentGroup(displayGroup.length ? displayGroup : [displayAttachment]);
  }, [onMediaClick, setPreviewAttachment, setPreviewAttachmentGroup]);

  const handleMediaPreviewClick = useCallback((mediaUrl: string) => {
    if (onMediaClick) {
      onMediaClick(mediaUrl);
      return;
    }
    setPreviewAttachment(createImageAttachmentFromMediaUrl(mediaUrl));
    setPreviewAttachmentGroup([]);
  }, [onMediaClick, setPreviewAttachment, setPreviewAttachmentGroup]);

  const handleAttachmentPreviewClose = useCallback(() => {
    setPreviewAttachment(null);
    setPreviewAttachmentGroup([]);
  }, [setPreviewAttachment, setPreviewAttachmentGroup]);

  const navigateInputHistory = useCallback((direction: 'older' | 'newer'): boolean => {
    if (userMessageHistory.length === 0) {
      return false;
    }

    const currentCursor = inputHistoryCursorRef.current;
    let nextCursor: number | null;

    if (direction === 'older') {
      if (currentCursor === null) {
        inputHistoryDraftRef.current = input;
        nextCursor = userMessageHistory.length - 1;
      } else {
        nextCursor = Math.max(0, currentCursor - 1);
      }
    } else {
      if (currentCursor === null) {
        return false;
      }
      nextCursor = currentCursor >= userMessageHistory.length - 1 ? null : currentCursor + 1;
    }

    inputHistoryCursorRef.current = nextCursor;
    applyInputHistoryValue(nextCursor === null ? inputHistoryDraftRef.current : userMessageHistory[nextCursor]);
    return true;
  }, [applyInputHistoryValue, input, userMessageHistory]);

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
          setSelectedReferenceIndex((prev) => (prev < referencePickerItems.length - 1 ? prev + 1 : prev));
          return;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedReferenceIndex((prev) => (prev > 0 ? prev - 1 : 0));
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
  }, [activeReferenceMatch, closeReferencePicker, handleReferenceSelect, handleSend, handleStop, isWebSocketUnavailable, navigateInputHistory, referencePickerItems, selectedReferenceIndex, togglePlanningMode]);

  useEffect(() => {
    let cancelled = false;

    const fetchConfig = async () => {
      try {
        setAgentConfig(null);
        setIsAgentConfigLoading(true);
        const config = await fetchChatAgentConfig(selectedAgentId);
        if (!cancelled) {
          setAgentConfig(config);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to fetch agent config', err);
        }
      } finally {
        if (!cancelled) {
          setIsAgentConfigLoading(false);
        }
      }
    };

    void fetchConfig();
    return () => {
      cancelled = true;
    };
  }, [selectedAgentId]);

  useEffect(() => {
    const fetchAgents = async () => {
      try {
        setAvailableAgents(await fetchChatAgents());
      } catch (err) {
        console.error('Failed to fetch agents', err);
      }
    };

    void fetchAgents();
  }, []);

  useEffect(() => {
    if (sessionId) {
      return;
    }
    const providerState = resolveAgentProviderState(agentConfig);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveProvider(providerState.provider);
    setActiveModel(providerState.model);
    setActiveThinkingLevel(providerState.thinkingLevel);
  }, [agentConfig, sessionId]);



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
  }, [agentConfig, appendSystemMessage, handleControlAction, initialPrompt, initialPromptStorageKey, selectedAgentId, t]);

  useEffect(() => {
    if (initialPrompt?.trim()) return;
    if (resolvedRequestedSessionId) return;
    if (isResolvingInitialChatState) return;
    if (hasLoadedSessionListRef.current) return;
    if (userStartedNewChatRef.current) return;
    void fetchHistory();
  }, [fetchHistory, initialPrompt, isResolvingInitialChatState, resolvedRequestedSessionId]);

  // Fetch history when showing history panel and it's empty (mobile bug fix)
  useEffect(() => {
    if (showHistory && history.length === 0 && !isLoadingHistory) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void fetchHistory();
    }
  }, [showHistory, history.length, fetchHistory, isLoadingHistory]);

  useEffect(() => {
    if (initialPrompt?.trim()) return;
    if (initialPromptStorageKey && typeof window !== 'undefined' && window.sessionStorage.getItem(initialPromptStorageKey)) {
      return;
    }
    if (userStartedNewChatRef.current) return;
    if (!resolvedRequestedSessionId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsResolvingInitialChatState(true);

    const loadRequestedSession = async () => {
      try {
        const cachedEntry = readLatestCachedChatSession(resolvedRequestedSessionId);
        if (cachedEntry) {
          setHistory((current) => {
            if (current.some((session) => session.sessionId === cachedEntry.session.sessionId)) {
              return current;
            }
            return [cachedEntry.session, ...current];
          });
          setLatestSession((current) => current || cachedEntry.session);
          setTotalUnreadCount((current) => current + (cachedEntry.session.hasUnread ? 1 : 0));
          await loadSession(cachedEntry.session);
          if (!forcedSessionId) {
            requestedSessionCleanupRef.current = resolvedRequestedSessionId;
            clearSessionParamFromUrl();
          }
          void loadSessionList()
            .then((sessions) => {
              setHistory(sessions);
              setLatestSession(sessions[0] || cachedEntry.session);
              setTotalUnreadCount(sessions.filter((session: AISession) => session.hasUnread).length);
            })
            .catch((err) => {
              console.error('Failed to refresh requested session history', err);
            });
          return;
        }

        const sessions = await loadSessionList();
        if (sessions.length > 0) {
          setHistory(sessions);
          setLatestSession(sessions[0] || null);
          setTotalUnreadCount(sessions.filter((session: AISession) => session.hasUnread).length);
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
  }, [clearSessionParamFromUrl, forcedSessionId, initialPrompt, initialPromptStorageKey, loadSession, loadSessionList, resolvedRequestedSessionId]);

  // Restore previously active session on remount (mobile Sheet unmount/remount)
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
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsResolvingInitialChatState(false);
      return;
    }
    setIsResolvingInitialChatState(true);

    const restoreSession = async () => {
      try {
        const cachedEntry = readLatestCachedChatSession(storedSessionId);
        if (cachedEntry) {
          setHistory((current) => {
            if (current.some((session) => session.sessionId === cachedEntry.session.sessionId)) {
              return current;
            }
            return [cachedEntry.session, ...current];
          });
          setLatestSession((current) => current || cachedEntry.session);
          setTotalUnreadCount((current) => current + (cachedEntry.session.hasUnread ? 1 : 0));
          await loadSession(cachedEntry.session);
          void loadSessionList()
            .then((sessions) => {
              setHistory(sessions);
              setLatestSession(sessions[0] || cachedEntry.session);
              setTotalUnreadCount(sessions.filter((session: AISession) => session.hasUnread).length);
            })
            .catch((err) => {
              console.error('Failed to refresh restored session history', err);
            });
          return;
        }

        const sessions = await loadSessionList();
        // A new session may have been created while the fetch was in-flight
        if (sessionIdRef.current) return;
        if (sessions.length > 0) {
          setHistory(sessions);
          setLatestSession(sessions[0] || null);
          setTotalUnreadCount(sessions.filter((session: AISession) => session.hasUnread).length);
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
  }, [resolvedRequestedSessionId]);

  // Poll runtime status only while the agent is active; fetch once on session switch
  const isAgentActive = runtimeStatus != null && runtimeStatus.phase !== 'idle';
  const handleModelChange = useCallback((next: { model: string; thinkingLevel: PiThinkingLevel; provider: string }) => {
    setActiveModel(next.model);
    setActiveProvider(next.provider);
    setActiveThinkingLevel(next.thinkingLevel);
    setAgentConfig((current) => {
      const providerConfig = current?.piConfig?.providers?.[next.provider];
      if (!current || !providerConfig) {
        return current;
      }

      return {
        ...current,
        effectiveConfig: current.effectiveConfig
          ? {
              ...current.effectiveConfig,
              activeProvider: next.provider,
              model: next.model,
              thinkingLevel: next.thinkingLevel,
              setupState: current.effectiveConfig.setupState
                ? {
                    ...current.effectiveConfig.setupState,
                    modelConfigured: true,
                    issues: current.effectiveConfig.setupState.issues.filter((issue) => !issue.toLowerCase().includes('model')),
                  }
                : current.effectiveConfig.setupState,
            }
          : current.effectiveConfig,
        piConfig: {
          ...current.piConfig,
          activeProvider: next.provider,
          providers: {
            ...current.piConfig.providers,
            [next.provider]: {
              ...providerConfig,
              model: next.model,
              thinking: next.thinkingLevel,
            },
          },
        },
      };
    });
    setHistory((items) => items.map((item) => (
      item.sessionId === sessionIdRef.current
        ? { ...item, model: next.model, provider: next.provider, thinkingLevel: next.thinkingLevel }
        : item
    )));
  }, []);

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
    if (autoScrollTimerRef.current) {
      clearTimeout(autoScrollTimerRef.current);
      autoScrollTimerRef.current = null;
    }
    if (composerMeasureRafRef.current !== null) {
      cancelAnimationFrame(composerMeasureRafRef.current);
      composerMeasureRafRef.current = null;
    }
    resetStreamConnection();
  }, [resetStreamConnection]);

  useEffect(() => {
    if (!isMobile) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setShowMobileDetails(false);
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [isMobile]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;

    const updateComposerSize = () => {
      composerMeasureRafRef.current = null;
      const { height, width } = composer.getBoundingClientRect();
      const nextHeight = Math.ceil(height);
      const nextWidth = Math.ceil(width);
      setComposerHeight((current) => (current === nextHeight ? current : nextHeight));
      setComposerWidth((current) => (current === nextWidth ? current : nextWidth));
    };

    const scheduleComposerSizeUpdate = () => {
      if (composerMeasureRafRef.current !== null) {
        cancelAnimationFrame(composerMeasureRafRef.current);
      }
      composerMeasureRafRef.current = requestAnimationFrame(updateComposerSize);
    };

    updateComposerSize();

    const resizeObserver = new ResizeObserver(() => {
      scheduleComposerSizeUpdate();
    });

    resizeObserver.observe(composer);
    window.addEventListener('resize', scheduleComposerSizeUpdate);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', scheduleComposerSizeUpdate);
      if (composerMeasureRafRef.current !== null) {
        cancelAnimationFrame(composerMeasureRafRef.current);
        composerMeasureRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    syncTextareaHeight();
  }, [composerWidth, syncTextareaHeight]);

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
  const agentProfilesById = useMemo(() => new Map(availableAgents.map((agent) => [agent.agentId, agent])), [availableAgents]);
  const activeAgentProfile = agentProfilesById.get(activeSessionAgentId);
  const activeAgentDisplayName = activeAgentProfile?.name || getAgentDisplayName(activeSessionAgentId);
  const chatAgentOptions = useMemo<AgentProfile[]>(() => (
    availableAgents.length > 0
      ? availableAgents
      : [{ agentId: CHAT_AGENT_ID, name: 'Canvas Agent', iconId: 'bot', type: 'main', removable: false }]
  ), [availableAgents]);
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
      filtered = filtered.filter(s => s.hasUnread);
    }

    if (historyAgentFilter !== 'all') {
      filtered = filtered.filter(s => (s.agentId || CHAT_AGENT_ID) === historyAgentFilter);
    }

    if (historySearchQuery.trim()) {
      const query = historySearchQuery.toLowerCase();
      filtered = filtered.filter(s =>
        s.title?.toLowerCase().includes(query) ||
        s.sessionId.toLowerCase().includes(query) ||
        (agentProfilesById.get(s.agentId || CHAT_AGENT_ID)?.name || getAgentDisplayName(s.agentId)).toLowerCase().includes(query)
      );
    }

    filtered.sort((a, b) => {
      const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : new Date(a.createdAt).getTime();
      const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : new Date(b.createdAt).getTime();
      return bTime - aTime;
    });

    const grouped: ChatHistoryGroups = {
      today: [],
      last7: [],
      last14: [],
      last30: [],
      older: [],
    };

    filtered.forEach(session => {
      const group = getSessionTimeGroup(session.createdAt);
      grouped[group].push(session);
    });

    return grouped;
  }, [agentProfilesById, history, historyAgentFilter, historySearchQuery, historyUnreadOnly, getSessionTimeGroup]);

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
  }, [shouldShowHistoryAsOverlay, isMobile]);

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

  const startHistoryResizing = useCallback((e: React.MouseEvent) => {
    isHistoryResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    historyResizeRef.current = {
      startX: e.clientX,
      startWidth: historySidebarWidth,
    };
  }, [historySidebarWidth]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isHistoryResizing.current || !historyResizeRef.current) return;
      const nextWidth = Math.min(400, Math.max(220, historyResizeRef.current.startWidth + (e.clientX - historyResizeRef.current.startX)));
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
                    title={sessionDisplayLabel}
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
      </div>

      <div
        ref={composerRef}
        aria-hidden={isHistoryOverlayOpen}
        className={cn(
          'absolute bottom-0 left-0 right-0 z-20 border-t border-border bg-background/95 px-3 pt-3',
          isHistoryOverlayOpen ? 'hidden' : null,
        )}
        style={{ paddingBottom: isMobile ? 'calc(env(safe-area-inset-bottom) + 0.75rem)' : '0.75rem' }}
      >
        {uploadError && (
          <div className="mb-2 flex items-center justify-between border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
            <span>{uploadError}</span>
            <button type="button" onClick={() => setUploadError(null)} className="ml-2 hover:opacity-70">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {isWebSocketUnavailable && (
          <div className="mb-2 border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-100">
            <div className="font-medium">{t('liveUpdatesUnavailable')}</div>
            <div className="mt-1 text-[11px] opacity-80">{t('liveUpdatesUnavailableDescription')}</div>
          </div>
        )}

        {showModelRequiredNotice && (
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-100">
            <div className="min-w-0">
              <div className="font-medium">{t('modelRequiredTitle')}</div>
              <div className="mt-1 text-[11px] opacity-80">{t('modelRequiredDescription')}</div>
            </div>
            <Link
              href="/settings?tab=agent"
              className="inline-flex shrink-0 items-center gap-1 border border-amber-500/40 bg-background/60 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
            >
              <Settings className="h-3 w-3" />
              {t('openAgentSettings')}
            </Link>
          </div>
        )}

        {attachments.length > 0 && (
          <div
            className={`mb-2 gap-2 border border-border bg-muted/60 p-2 ${
              isMobile ? 'flex overflow-x-auto no-scrollbar' : 'flex flex-wrap'
            }`}
          >
            {attachments.map((attachment, index) => (
              <AttachmentPreviewItem
                key={`${attachment.id || attachment.filePath || attachment.name}-${index}`}
                attachment={attachment}
                context="composer"
                previewGroup={attachments}
                onRemove={() => removeAttachment(index)}
                onOpen={handleAttachmentPreviewOpen}
              />
            ))}
          </div>
        )}

        {runtimeStatus && totalQueuedMessages > 0 && (
          <ChatQueuePanel
            items={queueItems}
            isMobile={isMobile}
            isWebSocketUnavailable={isWebSocketUnavailable}
            openItemId={openQueueItemPopoverId}
            onOpenItemChange={setOpenQueueItemPopoverId}
            onPromote={(queueItemId) => {
              void handlePromoteQueuedMessage(queueItemId);
            }}
            onRemove={(queueItemId) => {
              void handleRemoveQueuedMessage(queueItemId);
            }}
            onEdit={(entry) => {
              void handleEditQueuedMessage(entry);
            }}
          />
        )}

        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={composerDisabled}
            className="border border-transparent p-2.5 text-muted-foreground transition-colors hover:border-border hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            title={isUploading ? t('uploading') : t('attachImage')}
          >
            {isUploading
              ? <Loader2 className="h-5 w-5 animate-spin" />
              : <Paperclip className="h-5 w-5" />}
          </button>
          <input type="file" ref={fileInputRef} onChange={onFileChange} className="hidden" accept="image/*,application/pdf,.docx,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html" multiple />
          <div className="relative flex-1 min-w-0">
            <textarea
              ref={textareaRef}
              data-testid="chat-input"
              rows={1}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={composerPlaceholderText}
              style={{ height: `${textareaHeight}px` }}
              disabled={isWebSocketUnavailable}
              className={`w-full resize-none border bg-background p-2.5 text-base placeholder:text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 md:text-sm sm:placeholder:text-sm ${planningMode ? 'border-amber-500 focus:ring-amber-500' : 'border-border focus:ring-ring'}`}
            />

            {activeReferenceMatch ? (
              <ComposerReferencePicker
                emptyState={referencePickerEmptyState}
                header={referencePickerHeader}
                items={referencePickerItems}
                onSelect={handleReferenceSelect}
                pickerRef={referencePickerRef}
                selectedIndex={selectedReferenceIndex}
              />
            ) : null}
          </div>
          <button
            type="button"
            data-testid="chat-send"
            data-action={primaryActionIsStop ? 'stop' : 'send'}
            aria-label={primaryActionLabel}
            onClick={() => {
              if (primaryActionIsStop) {
                void handleStop();
                return;
              }
              void handleSend();
            }}
            className={cn(
              'flex-shrink-0 bg-primary p-2.5 text-primary-foreground transition-all hover:bg-primary/90 disabled:opacity-30',
            )}
            disabled={primaryActionDisabled}
            title={primaryActionLabel}
          >
            {primaryActionIsStop ? (
              <Square className="h-5 w-5 fill-current" />
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-5 w-5">
                <path d="M22 2L11 13M22 2L15 22L11 13M11 13L2 9L22 2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>
        <div className="mt-2 flex items-start justify-between gap-2">
          <div className="flex flex-col items-start gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <ChatModelSelector
                agentId={selectedAgentId}
                sessionId={sessionId}
                activeModel={effectiveActiveModel}
                activeProvider={effectiveActiveProvider}
                thinkingLevel={effectiveActiveThinkingLevel}
                agentConfig={selectedAgentConfig}
                disabled={Boolean(runtimeStatus && runtimeStatus.phase !== 'idle') || !effectiveActiveProvider}
                compact={isCompactView}
                onModelChange={handleModelChange}
                onRuntimeInvalidated={invalidateRuntimeAfterModelChange}
              />
              <PlanModeToggle />
              <button
                type="button"
                data-testid="chat-composer-hint-toggle"
                aria-expanded={showComposerHint}
                onClick={() => setShowComposerHint((current) => !current)}
                className="inline-flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <CircleHelp className="h-3.5 w-3.5" />
                {t('hint')}
              </button>
            </div>
            {showComposerHint ? (
              <div className="max-w-[38rem] border border-border/60 bg-muted/30 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
                {composerHint}
              </div>
            ) : null}
          </div>
          </div>
        </div>
       </div>
      <AttachmentPreviewDialog
        attachment={previewAttachment}
        attachments={previewAttachmentGroup}
        onClose={handleAttachmentPreviewClose}
      />
      <ImagePreprocessDialog
        open={imagePreprocessFiles !== null}
        onOpenChange={(open) => { if (!open) { setImagePreprocessFiles(null); setImagePreprocessPendingFiles([]); } }}
        files={imagePreprocessFiles ?? []}
        onConfirm={handleImagePreprocessConfirm}
        onSkip={handleImagePreprocessSkip}
      />
    </div>
  );
}
