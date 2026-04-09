'use client';

import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Usage } from '@mariozechner/pi-ai';
import { useTranslations } from 'next-intl';
import type { AnthropicSkill } from '@/app/lib/skills/skill-manifest-anthropic';
import {
  Paperclip,
  X,
  Image as ImageIcon,
  Loader2,
  History,
  Plus,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  ArrowDown,
  Trash2,
  Pencil,
  Sparkles,
  Wrench,
  Lightbulb,
  CircleHelp,
  Megaphone,
  WandSparkles,
  Clapperboard,
  BriefcaseBusiness,
  FileText,
  FolderTree,
  Settings,
} from 'lucide-react';
import { ComposerReferencePicker, type ComposerReferencePickerItem } from '@/app/components/canvas-agent-chat/ComposerReferencePicker';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { useFileStore } from '@/app/store/file-store';
import { Link } from '@/i18n/navigation';
import { usePathname, useSearchParams, useRouter } from 'next/navigation';
import { findActiveComposerReference, replaceComposerReference, type ComposerReferenceMatch } from '@/app/lib/chat/composer-references';
import { formatUsageBreakdown, formatUsageCompact, hasRenderableUsage } from '@/app/lib/pi/usage-format';
import { useIsMobile } from '@/hooks/use-mobile';
import { BUSINESS_STARTER_PROMPTS, type StarterPromptDefinition, type StarterPromptIcon } from '@/app/lib/chat/starter-prompts';
import { ChatRuntimeActivityBadge } from '@/app/components/canvas-agent-chat/ChatRuntimeActivityBadge';
import type { RuntimeStatus } from '@/app/components/canvas-agent-chat/runtime-status';
import { toast } from 'sonner';
import { getSessionDisplayTitle } from '@/app/lib/pi/session-titles';
import { type CompactBreakMessage, isCompactBreakMessage } from '@/app/lib/pi/custom-messages';
import { renderSkillIcon } from '@/app/lib/skills/skill-icons';
import { searchSkillReferenceEntries } from '@/app/lib/skills/skill-reference-search';
import { useWebSocket } from '@/app/hooks/useWebSocket';

interface Attachment {
  name: string;
  contentKind: 'image' | 'document';
  // File ID for accessing via /api/files/[id]
  id: string;
  mimeType?: string;
  // document category
  category?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'toolResult';
  content: string;
  type?: 'tool_use' | 'tool_result' | 'system' | 'compact_break';
  status?: 'pending' | 'sending' | 'queued_follow_up' | 'queued_steering' | 'aborting' | 'sent' | 'error';
  attachments?: Attachment[];
  piMessage?: AgentMessage;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: string;
  queueKind?: 'follow_up' | 'steer';
  isCollapsed?: boolean;
  autoCollapsedAtEnd?: boolean;
  previewText?: string;
  compactMeta?: {
    kind: 'manual' | 'automatic';
    timestamp: string;
    omittedMessageCount: number;
  };
}

interface AISession {
  id: number;
  sessionId: string;
  title: string;
  model: string;
  createdAt: string;
  engine?: 'legacy' | 'pi';
  lastMessageAt?: string | null;
  lastViewedAt?: string | null;
  hasUnread?: boolean;
  creator?: {
    name?: string | null;
    email?: string | null;
  };
}

interface ChatEvent {
  type: string;
  message?: AgentMessage;
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
  };
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: {
    content?: unknown[];
  };
  partialResult?: {
    content?: unknown[];
  };
  error?: string;
  messages?: AgentMessage[];
  status?: RuntimeStatus;
  timestamp?: string;
  kind?: 'manual' | 'automatic';
  omittedMessageCount?: number;
  includedSummary?: boolean;
}

type PersistedChatMessage = AgentMessage & {
  id?: number | string;
};
type UserPiMessage = Extract<AgentMessage, { role: 'user' }>;
type UserPiContent = UserPiMessage['content'];

type DiscoveryModel = {
  id: string;
  name: string;
  supportsVision?: boolean;
};

type AgentConfig = {
  piConfig: {
    activeProvider: string;
    providers: Record<string, { model: string }>;
  };
  discovery: Record<string, { models: DiscoveryModel[] }>;
};

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
}

const STARTER_PROMPT_ICONS: Record<StarterPromptIcon, React.ComponentType<{ className?: string }>> = {
  campaign: Megaphone,
  creative: WandSparkles,
  video: Clapperboard,
  strategy: BriefcaseBusiness,
  document: FileText,
  organize: FolderTree,
};

const DEFAULT_MODEL_ID = 'pi';
const BOTTOM_LOCK_THRESHOLD_PX = 16;
const MOBILE_TEXTAREA_BASE_HEIGHT_PX = 56;
const DESKTOP_TEXTAREA_BASE_HEIGHT_PX = 72;
const MOBILE_TEXTAREA_MAX_HEIGHT_PX = 192;
const DESKTOP_TEXTAREA_MAX_HEIGHT_PX = 256;
const MOBILE_TEXTAREA_MAX_VIEWPORT_RATIO = 0.3;
const DESKTOP_TEXTAREA_MAX_VIEWPORT_RATIO = 0.35;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTextPart(value: unknown): value is { type: 'text'; text: string } {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string';
}

function isImagePart(value: unknown): value is { type: 'image'; data: string; mimeType: string } {
  return isRecord(value) && value.type === 'image' && typeof value.data === 'string' && typeof value.mimeType === 'string';
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
    // Build the API URL for accessing the file
    const fileApiUrl = `/api/files/${encodeURIComponent(attachment.id)}`;
    
    if (attachment.contentKind === 'image') {
      content.push({
        type: 'image',
        data: fileApiUrl,
        mimeType: attachment.mimeType!,
      });
    } else {
      // All non-image files - provide file reference info
      // The agent will need to fetch and process the file
      content.push({
        type: 'text',
        text: `--- Datei: ${attachment.name} ---\nFile ID: ${attachment.id}\nAPI URL: ${fileApiUrl}\nTyp: ${attachment.mimeType || attachment.category || 'document'}\nKategorie: ${attachment.category || 'other'}\n\n[Diese Datei wurde hochgeladen und ist über die File ID zugänglich]\n--- Ende: ${attachment.name} ---`,
      });
    }
  }

  return content;
}

function normalizeMessageStart(text: string): string {
  return text.replace(/^\s+/, '');
}

function extractPiMessageText(piMessage?: AgentMessage | null): string {
  if (!piMessage || isCompactBreakMessage(piMessage)) return '';
  if (!Array.isArray(piMessage.content)) {
    return typeof piMessage.content === 'string' ? piMessage.content : '';
  }

  const textContent = piMessage.content
    .map((part: unknown) => {
      if (isTextPart(part)) return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');

  if (textContent) {
    return normalizeMessageStart(textContent);
  }

  if (piMessage.role === 'assistant' && piMessage.stopReason === 'error' && piMessage.errorMessage) {
    return `[Error] ${piMessage.errorMessage}`;
  }

  return '';
}

function extractToolResultText(content: unknown[] | undefined): string {
  if (!Array.isArray(content)) {
    return '';
  }

  return normalizeMessageStart(
    content
      .map((part) => (isTextPart(part) ? part.text : ''))
      .filter(Boolean)
      .join('\n'),
  );
}

function extractImageAttachments(content: unknown): Attachment[] | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  const attachments = content.reduce<Attachment[]>((result, part, index) => {
    if (isImagePart(part)) {
      // For images, use the data as the ID (could be file ID or data URL)
      // In the new system, data should be a file ID like "name---uuid.ext"
      const imageId = part.data.startsWith('/api/files/') 
        ? part.data.replace('/api/files/', '') 
        : part.data;
      
      result.push({
        name: `attachment-${index + 1}`,
        contentKind: 'image',
        id: imageId,
        mimeType: part.mimeType,
        category: 'image',
      });
    }
    return result;
  }, []);

  return attachments.length > 0 ? attachments : undefined;
}

function getAssistantUsage(message?: AgentMessage | null) {
  if (!message || message.role !== 'assistant' || !hasRenderableUsage(message.usage)) {
    return null;
  }

  return message.usage;
}

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function sumUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

function getAssistantChainUsage(messages: ChatMessage[], index: number): Usage | null {
  const currentMessage = messages[index];
  if (!currentMessage || currentMessage.role !== 'assistant') {
    return null;
  }

  let chainStart = index;
  while (chainStart > 0 && messages[chainStart - 1]?.role !== 'user') {
    chainStart -= 1;
  }

  let chainEnd = index;
  while (chainEnd + 1 < messages.length && messages[chainEnd + 1]?.role !== 'user') {
    chainEnd += 1;
  }

  let lastAssistantIndex = -1;
  let aggregatedUsage: Usage | null = null;

  for (let cursor = chainStart; cursor <= chainEnd; cursor += 1) {
    const message = messages[cursor];
    if (message?.role !== 'assistant') {
      continue;
    }

    lastAssistantIndex = cursor;
    const usage = getAssistantUsage(message.piMessage);
    if (!usage) {
      continue;
    }

    aggregatedUsage = aggregatedUsage ? sumUsage(aggregatedUsage, usage) : sumUsage(EMPTY_USAGE, usage);
  }

  if (lastAssistantIndex !== index || !aggregatedUsage || !hasRenderableUsage(aggregatedUsage)) {
    return null;
  }

  return aggregatedUsage;
}

function getSessionDisplayLabel(sessionTitle: string | null, fallbackTitle: string): string {
  return getSessionDisplayTitle(sessionTitle, fallbackTitle);
}

function formatToolArgs(args: unknown): string {
  if (args === undefined) {
    return '';
  }

  if (typeof args === 'string') {
    return args;
  }

  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function buildQueuedMessageKey(text: string, attachmentCount: number): string {
  return `${text.trim()}::${attachmentCount}`;
}

function formatContextTokens(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }

  return `${value}`;
}

function truncatePreview(value: string, maxLength = 88): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function getToolStatusLabel(
  message: ChatMessage,
  t: ReturnType<typeof useTranslations<'chat'>>
): string {
  switch (message.status) {
    case 'sending':
      return t('toolStatusRunning');
    case 'aborting':
      return t('toolStatusAborting');
    case 'error':
      return t('toolStatusError');
    default:
      return t('toolStatusDone');
  }
}

function getCompactBreakLabel(
  message: ChatMessage,
  t: ReturnType<typeof useTranslations<'chat'>>
): string {
  const meta = message.compactMeta;
  if (!meta) {
    return message.content;
  }

  const baseLabel = meta.kind === 'manual' ? t('compactManual') : t('compactAutomatic');
  if (meta.omittedMessageCount > 0) {
    return t('compactWithCount', { label: baseLabel, count: meta.omittedMessageCount });
  }

  return baseLabel;
}

function MarkdownMessage({ content, variant }: { content: string; variant: 'user' | 'assistant' | 'tool' }) {
  const sharedClasses =
    'break-words text-sm leading-relaxed [&_p]:my-0 [&_p+p]:mt-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mt-1 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_hr]:my-4 [&_hr]:border-border/60 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_code]:rounded-sm [&_code]:px-1.5 [&_code]:py-0.5 [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold';
  const toneClasses =
    variant === 'user'
      ? '[&_blockquote]:border-primary-foreground/40 [&_pre]:border-primary-foreground/20 [&_pre]:bg-primary-foreground/10 [&_code]:bg-primary-foreground/15 [&_th]:border-primary-foreground/20 [&_td]:border-primary-foreground/20'
      : '[&_blockquote]:border-border/80 [&_pre]:border-border [&_pre]:bg-background/80 [&_code]:bg-background/80 [&_th]:border-border [&_td]:border-border';

  return (
    <div className={`${sharedClasses} ${toneClasses}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function StreamingMessageIndicator() {
  const t = useTranslations('chat');
  return (
    <div
      data-testid="chat-assistant-streaming-indicator"
      aria-label={t('assistantStreamingAria')}
      className="inline-flex min-h-8 min-w-12 items-center justify-center px-1 text-muted-foreground/80"
    >
      <span className="sr-only">{t('assistantStreamingSr')}</span>
      {[0, 160, 320].map((delay) => (
        <span
          key={delay}
          aria-hidden="true"
          className="chat-streaming-dot mx-0.5 h-1.5 w-1.5 rounded-full bg-current"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  );
}

function StarterPromptButton({
  prompt,
  onSelect,
  compact = false,
}: {
  prompt: StarterPromptDefinition;
  onSelect: (value: string) => void;
  compact?: boolean;
}) {
  const t = useTranslations('chat');
  const Icon = STARTER_PROMPT_ICONS[prompt.icon];

  return (
    <button
      type="button"
      data-testid={`chat-starter-prompt-${prompt.id}`}
      onClick={() => onSelect(prompt.prompt)}
      className={`group flex min-w-0 flex-col items-start gap-2 border border-border bg-background/90 text-left text-foreground transition-colors hover:border-primary/40 hover:bg-accent ${
        compact ? 'p-2.5' : 'min-w-[320px] p-4'
      }`}
    >
      <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        <Icon className="h-4 w-4 text-primary" />
        {t('example')}
      </span>
      <div className="space-y-1">
        <div className={`${compact ? 'text-sm' : 'text-base'} font-semibold tracking-tight`}>{prompt.title}</div>
        <p className={`${compact ? 'text-xs line-clamp-2' : 'text-sm'} leading-relaxed text-muted-foreground`}>{prompt.description}</p>
      </div>
    </button>
  );
}

export default function CanvasAgentChat({
  initialPrompt,
  initialPromptStorageKey,
  showSkillsLink = false,
}: CanvasAgentChatProps) {
  const t = useTranslations('chat');
  const searchParams = useSearchParams();
  const requestedSessionId = searchParams.get('session');
  const pathname = usePathname();
  const router = useRouter();
  const sessionBasePath = pathname.includes('/chat') ? pathname : '/notebook';
  const isMobile = useIsMobile();
  const currentFile = useFileStore((s) => s.currentFile);
  
  // WebSocket integration (only if enabled)
  const isWebSocketEnabled = typeof window !== 'undefined' && process.env.WEBSOCKET_ENABLED === 'true';
  const { connected: wsConnected, subscribe, unsubscribe, sendMessage, markAsRead } = useWebSocket({
    autoConnect: isWebSocketEnabled,
  });
  
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showMobileDetails, setShowMobileDetails] = useState(false);
  const [showMobileActionPanel, setShowMobileActionPanel] = useState(false);
  const [history, setHistory] = useState<AISession[]>([]);
  const [latestSession, setLatestSession] = useState<AISession | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [activeModel, setActiveModel] = useState(DEFAULT_MODEL_ID);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [hasUnreadInCurrentSession, setHasUnreadInCurrentSession] = useState(false);
  const [showUnreadBanner, setShowUnreadBanner] = useState(false);
  const [isUserActiveInChat, setIsUserActiveInChat] = useState(false);

  const [activeReferenceMatch, setActiveReferenceMatch] = useState<ComposerReferenceMatch | null>(null);
  const [referencePickerItems, setReferencePickerItems] = useState<ComposerReferencePickerItem<ReferencePickerValue>[]>([]);
  const [selectedReferenceIndex, setSelectedReferenceIndex] = useState(0);
  const [availableSkills, setAvailableSkills] = useState<SkillPickerSkill[] | null>(null);

  const localizedStarterPrompts = BUSINESS_STARTER_PROMPTS.map((prompt) => ({
    ...prompt,
    title: t(`starterPrompts.${prompt.id}.title`),
    description: t(`starterPrompts.${prompt.id}.description`),
    prompt: t(`starterPrompts.${prompt.id}.prompt`),
  }));
  const [isLoadingReferenceItems, setIsLoadingReferenceItems] = useState(false);
  const [composerHeight, setComposerHeight] = useState(220);
  const [composerWidth, setComposerWidth] = useState(0);
  const [showComposerHint, setShowComposerHint] = useState(false);
  const [textareaHeight, setTextareaHeight] = useState(DESKTOP_TEXTAREA_BASE_HEIGHT_PX);

  // Upload states
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const referencePickerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialPromptConsumedRef = useRef(false);
  const toolMessageIdsRef = useRef<Record<string, string>>({});
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamSessionRef = useRef<string | null>(null);
  const currentAssistantIdRef = useRef<string | null>(null);
  const runtimeStatusRef = useRef<RuntimeStatus | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastCompactionMarkerRef = useRef<string | null>(null);
  const userStartedNewChatRef = useRef(false);
  const previousMessageCountRef = useRef(0);
  const isAtBottomRef = useRef(true);
  const referenceRequestIdRef = useRef(0);
  const pageVisibleRef = useRef(true);
  const channelRef = useRef<BroadcastChannel | null>(null);

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
    const nextHeight = Math.max(baseHeight, Math.min(textarea.scrollHeight, maxHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
    setTextareaHeight((current) => (current === nextHeight ? current : nextHeight));
  }, [getTextareaBaseHeight, getTextareaMaxHeight]);

  useEffect(() => {
    runtimeStatusRef.current = runtimeStatus;
  }, [runtimeStatus]);

  // Page Visibility Tracking - detect if tab is active or in background
  useEffect(() => {
    const handleVisibilityChange = () => {
      pageVisibleRef.current = document.visibilityState === 'visible';
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Route & Activity Tracking - detect if user is in chat/notebook route
  useEffect(() => {
    const isChatRoute = pathname.includes('/chat') || pathname.includes('/notebook');
    const isViewingSession = !showHistory && sessionIdRef.current !== null;
    
    setIsUserActiveInChat(isChatRoute && isViewingSession);
  }, [pathname, showHistory]);

  // BroadcastChannel for Multi-Tab communication (fallback for SSE mode)
  useEffect(() => {
    if (isWebSocketEnabled) {
      return; // Skip BroadcastChannel when WebSocket is enabled
    }
    
    channelRef.current = new BroadcastChannel('canvas-chat-unread');
    
    channelRef.current.onmessage = (event) => {
      const { type, sessionId, sessionTitle: broadcastTitle } = event.data;
      
      if (type === 'new-response' && sessionId !== sessionIdRef.current) {
        // Show toast in this tab too (only if not viewing this session)
        const isViewingCurrentSession = isUserActiveInChat && sessionIdRef.current === sessionId;
        
        if (!isViewingCurrentSession) {
          const wasHidden = !pageVisibleRef.current;
          const duration = wasHidden ? 10000 : 4000;
          
          toast.info(t('newResponseReady'), {
            description: broadcastTitle,
            action: {
              label: t('openSession'),
              onClick: () => {
                router.push(`${sessionBasePath}?session=${sessionId}`);
              },
            },
            duration,
            position: 'top-right',
          });
        }
      }
    };
    
    return () => channelRef.current?.close();
  }, [isUserActiveInChat, isWebSocketEnabled, router, sessionBasePath, t]);

  // Session subscription for WebSocket
  useEffect(() => {
    if (!isWebSocketEnabled || !wsConnected || !sessionId) {
      return;
    }

    // Subscribe to session for receiving events
    subscribe(sessionId);
    
    console.log(`[CanvasAgentChat] Subscribed to session ${sessionId}`);
    
    // Mark as read via WebSocket when user is active in chat
    if (isUserActiveInChat) {
      markAsRead(sessionId);
    }
    
    // Update global state for provider (always, not just WebSocket mode)
    if (typeof window !== 'undefined') {
      window.__setCurrentSession?.(sessionId);
      window.__setUserActive?.(isUserActiveInChat);
    }

    return () => {
      unsubscribe(sessionId);
      console.log(`[CanvasAgentChat] Unsubscribed from session ${sessionId}`);
      // Don't reset on unmount - let the route change handle it
    };
  }, [isWebSocketEnabled, wsConnected, sessionId, isUserActiveInChat, subscribe, unsubscribe, markAsRead]);

  // Update global WebSocket state when user activity changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.__setUserActive?.(isUserActiveInChat);
    }
  }, [isUserActiveInChat]);

  // Reset global state when leaving chat route
  useEffect(() => {
    return () => {
      // Cleanup when navigating away from chat
      if (typeof window !== 'undefined') {
        window.__setCurrentSession?.(null);
        window.__setUserActive?.(false);
        console.log('[CanvasAgentChat] Reset global state on route change');
      }
    };
  }, []);

  // Listen for session-updated events to update history unread status
  useEffect(() => {
    if (!isWebSocketEnabled) return;

    const handleSessionUpdated = (event: CustomEvent<{ sessionId: string; lastMessageAt: string }>) => {
      const { sessionId, lastMessageAt } = event.detail;
      console.log('[CanvasAgentChat] Session updated (history):', sessionId, lastMessageAt);
      
      // Update history state to reflect new lastMessageAt
      setHistory(prev => prev.map(session => 
        session.sessionId === sessionId 
          ? { ...session, lastMessageAt, hasUnread: sessionId !== sessionIdRef.current }
          : session
      ));
    };

    window.addEventListener('session-updated', handleSessionUpdated as EventListener);
    return () => {
      window.removeEventListener('session-updated', handleSessionUpdated as EventListener);
    };
  }, [isWebSocketEnabled]);

  // Create session on mount if not in history view
  useEffect(() => {
    if (!sessionIdRef.current && !showHistory && messages.length === 0) {
      void ensureSession();
    }
  }, []);

  useLayoutEffect(() => {
    syncTextareaHeight();
  }, [input, isMobile, syncTextareaHeight]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  const syncBottomLockState = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return true;
    }

    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    const nextIsAtBottom = scrollHeight - scrollTop - clientHeight <= BOTTOM_LOCK_THRESHOLD_PX;
    isAtBottomRef.current = nextIsAtBottom;
    setIsAtBottom((current) => (current === nextIsAtBottom ? current : nextIsAtBottom));
    return nextIsAtBottom;
  }, []);

  const handleScroll = useCallback(() => {
    syncBottomLockState();
  }, [syncBottomLockState]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;
    syncBottomLockState();
    scrollContainer.addEventListener('scroll', handleScroll);
    return () => scrollContainer.removeEventListener('scroll', handleScroll);
  }, [handleScroll, syncBottomLockState]);

  useLayoutEffect(() => {
    if (messages.length === 0) {
      previousMessageCountRef.current = 0;
      isAtBottomRef.current = true;
      setIsAtBottom(true);
      return;
    }

    const lastMessage = messages[messages.length - 1];
    const messageCountIncreased = messages.length > previousMessageCountRef.current;

    if (isAtBottomRef.current || (messageCountIncreased && lastMessage.role === 'user')) {
      scrollToBottom(lastMessage.role === 'user' ? 'smooth' : 'auto');
    }

    previousMessageCountRef.current = messages.length;
  }, [messages, scrollToBottom]);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      if (data.success) {
        const sessions = data.sessions || [];
        setHistory(sessions);
        setLatestSession(sessions[0] || null);

        if (sessionIdRef.current) {
          const currentSession = sessions.find((session: AISession) => session.sessionId === sessionIdRef.current);
          if (currentSession) {
            setSessionTitle(currentSession.title || null);
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch history', err);
    }
  }, []);

  const resetStreamConnection = useCallback(() => {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    streamSessionRef.current = null;
    currentAssistantIdRef.current = null;
  }, []);

  const reconcileQueuedMessages = useCallback((status: RuntimeStatus) => {
    setMessages((prev) => {
      const followQueueCounts = new Map<string, number>();
      const steeringQueueCounts = new Map<string, number>();

      for (const entry of status.followUpQueue) {
        const key = buildQueuedMessageKey(entry.text, entry.attachmentCount);
        followQueueCounts.set(key, (followQueueCounts.get(key) || 0) + 1);
      }

      for (const entry of status.steeringQueue) {
        const key = buildQueuedMessageKey(entry.text, entry.attachmentCount);
        steeringQueueCounts.set(key, (steeringQueueCounts.get(key) || 0) + 1);
      }

      return prev.map((message) => {
        if (message.role !== 'user') {
          return message;
        }

        const key = buildQueuedMessageKey(message.content, message.attachments?.length || 0);
        const followCount = followQueueCounts.get(key) || 0;
        if (followCount > 0) {
          followQueueCounts.set(key, followCount - 1);
          return { ...message, status: 'queued_follow_up', queueKind: 'follow_up' };
        }

        const steerCount = steeringQueueCounts.get(key) || 0;
        if (steerCount > 0) {
          steeringQueueCounts.set(key, steerCount - 1);
          return { ...message, status: 'queued_steering', queueKind: 'steer' };
        }

        if (message.status === 'queued_follow_up' || message.status === 'queued_steering' || message.status === 'pending' || message.status === 'aborting') {
          return { ...message, status: 'sent', queueKind: undefined };
        }

        return message;
      });
    });
  }, []);

  const setRuntimeStatusWithReconciliation = useCallback((status: RuntimeStatus) => {
    setRuntimeStatus(status);
    reconcileQueuedMessages(status);
  }, [reconcileQueuedMessages]);

  const updateAssistantMessage = useCallback((id: string, content: string, type?: ChatMessage['type'], status?: ChatMessage['status']) => {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === id
          ? { ...message, content: message.content ? content : normalizeMessageStart(content), type: type || message.type, status: status || message.status }
          : message,
      ),
    );
  }, []);

  const syncPiMessage = useCallback((id: string, piMessage: AgentMessage) => {
    setMessages((prev) =>
      prev.map((message) => {
        if (message.id !== id) return message;

        const nextContent = extractPiMessageText(piMessage);
        const isAssistantError = piMessage.role === 'assistant' && (piMessage.stopReason === 'error' || piMessage.stopReason === 'aborted');

        return {
          ...message,
          content: nextContent || message.content,
          status: isAssistantError ? 'error' : 'sent',
          type: isAssistantError ? 'system' : message.type,
          piMessage,
        };
      }),
    );
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
  }) => {
    const { assistantMessageId, toolCallId, toolName, toolArgs, content, status, piMessage, type } = params;
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
      const response = await fetch(`/api/stream/status?sessionId=${encodeURIComponent(targetSessionId)}`);
      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      if (payload.success && payload.status) {
        setRuntimeStatusWithReconciliation(payload.status as RuntimeStatus);
      }
    } catch (error) {
      console.error('Failed to load runtime status', error);
    }
  }, [setRuntimeStatusWithReconciliation]);

  const ensureSession = useCallback(async () => {
    if (sessionIdRef.current) {
      return sessionIdRef.current;
    }

    const createSessionResponse = await fetch('/api/sessions', {
      method: 'POST',
    });

    const createSessionPayload = await createSessionResponse.json().catch(() => null);
    if (!createSessionResponse.ok || !createSessionPayload?.success || !createSessionPayload?.session?.sessionId) {
      throw new Error(createSessionPayload?.error || `Failed to create session (HTTP ${createSessionResponse.status})`);
    }

    const nextSessionId = createSessionPayload.session.sessionId as string;
    setSessionId(nextSessionId);
    
    // Use input as temporary title if available, otherwise use default
    const tempTitle = input.trim().slice(0, 50) || createSessionPayload.session.title || t('newChatTitle');
    setSessionTitle(tempTitle);
    
    sessionIdRef.current = nextSessionId;
    
    // Subscribe to session via WebSocket immediately
    if (isWebSocketEnabled && wsConnected && nextSessionId) {
      subscribe(nextSessionId);
      console.log(`[CanvasAgentChat] Auto-subscribed to new session ${nextSessionId}`);
    }
    
    return nextSessionId;
  }, [input, t, isWebSocketEnabled, wsConnected, subscribe]);

  const createAssistantBubble = useCallback((message?: AgentMessage) => {
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

    if (event.type === 'message_start' && event.message?.role === 'assistant') {
      createAssistantBubble(event.message);
      return;
    }

    if (event.type === 'message_update') {
      const assistantId = currentAssistantIdRef.current || createAssistantBubble(event.message);
      if (event.message?.role === 'assistant') {
        syncPiMessage(assistantId, event.message);
      }

      if (event.assistantMessageEvent?.type === 'text_delta') {
        updateAssistantMessage(assistantId, event.assistantMessageEvent.delta || '', undefined, 'sending');
      }
      return;
    }

    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const assistantId = currentAssistantIdRef.current || createAssistantBubble(event.message);
      syncPiMessage(assistantId, event.message);
      currentAssistantIdRef.current = null;
      
      // Update session title from AI response if available
      const assistantMessage = event.message;
      if (assistantMessage && assistantMessage.content) {
        const contentText = JSON.stringify(assistantMessage.content);
        // Check if content contains title information
        if (contentText.includes('title') || contentText.includes('Title')) {
          // Extract potential title (simplified)
          const potentialTitle = contentText.slice(0, 120);
          setSessionTitle(potentialTitle);
          console.log('[CanvasAgentChat] Updated session title from AI response');
        }
      }
      
      // For WebSocket mode, lastMessageAt is updated by server
      // For SSE mode, update it manually
      if (!isWebSocketEnabled) {
        const targetSessionId = streamSessionRef.current;
        if (targetSessionId) {
          const now = new Date();
          void fetch('/api/sessions', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              sessionId: targetSessionId, 
              lastMessageAt: now.toISOString() 
            }),
          }).catch(err => console.error('Failed to update lastMessageAt', err));
        }
      }
      
      // Show toast notification if user is NOT currently viewing this session
      // This includes: user is in different session, in history view, or on different page
      const targetSessionId = streamSessionRef.current || sessionIdRef.current;
      const isViewingCurrentSession = isUserActiveInChat && sessionIdRef.current === targetSessionId;
      
      if (!isViewingCurrentSession && targetSessionId) {
        // Find session title for toast
        const session = history.find(s => s.sessionId === targetSessionId);
        const displayTitle = session 
          ? getSessionDisplayTitle(session.title, t('newChatTitle')) 
          : (sessionTitle || t('newChatTitle'));
        
        // Calculate duration based on visibility
        const wasHidden = !pageVisibleRef.current;
        const duration = wasHidden ? 10000 : 4000; // 10s if hidden, 4s if visible
        
        toast.info(t('newResponseReady'), {
          description: displayTitle,
          action: {
            label: t('openSession'),
            onClick: () => {
              router.push(`${sessionBasePath}?session=${targetSessionId}`);
            },
          },
          duration,
          position: 'top-right',
        });
        
        // Broadcast to other tabs only in SSE mode (WebSocket handles it server-side)
        if (!isWebSocketEnabled && channelRef.current) {
          channelRef.current.postMessage({
            type: 'new-response',
            sessionId: targetSessionId,
            sessionTitle: displayTitle,
          });
        }
      }
      
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
      upsertToolMessage({
        assistantMessageId: currentAssistantIdRef.current,
        toolCallId: event.toolCallId,
        toolName: event.toolName || t('tool'),
        content: text,
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
  }, [appendCompactionBreak, appendSystemMessage, createAssistantBubble, setRuntimeStatusWithReconciliation, syncPiMessage, t, updateAssistantMessage, upsertToolMessage]);

  const openRuntimeStream = useCallback(async (
    targetSessionId: string,
    promptMessage?: Extract<AgentMessage, { role: 'user' }>,
  ) => {
    if (streamAbortRef.current && streamSessionRef.current === targetSessionId && !promptMessage) {
      return;
    }

    if (streamAbortRef.current && streamSessionRef.current !== targetSessionId) {
      resetStreamConnection();
    }

    const controller = new AbortController();
    streamAbortRef.current = controller;
    streamSessionRef.current = targetSessionId;
    currentAssistantIdRef.current = null;

    try {
      // Get user's timezone and current time from browser
      const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const currentTime = new Date().toISOString();

      const activeFilePath = currentFile?.path ?? null;

      const response = await fetch('/api/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: targetSessionId,
          ...(promptMessage ? { message: promptMessage, messages: [promptMessage] } : {}),
          userTimeZone,
          currentTime,
          ...(activeFilePath ? { activeFilePath } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let lineBuffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            handleStreamEvent(JSON.parse(line) as ChatEvent);
          } catch {
            // Ignore malformed stream lines.
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        console.error('Chat stream error:', error);
        appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
      }
    } finally {
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
        streamSessionRef.current = null;
        currentAssistantIdRef.current = null;
      }
      void fetchHistory();
      if (sessionIdRef.current === targetSessionId) {
        void refreshRuntimeStatus(targetSessionId);
      }
    }
  }, [appendSystemMessage, currentFile, fetchHistory, handleStreamEvent, refreshRuntimeStatus, resetStreamConnection, t]);

  const postControl = useCallback(async (
    targetSessionId: string,
    action: 'follow_up' | 'steer' | 'abort' | 'replace' | 'compact',
    message?: Extract<AgentMessage, { role: 'user' }>,
  ) => {
    const response = await fetch('/api/stream/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: targetSessionId,
        action,
        ...(message ? { message } : {}),
      }),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) {
      throw new Error(payload?.error || `Control request failed (${response.status})`);
    }

    if (payload.status) {
      setRuntimeStatusWithReconciliation(payload.status as RuntimeStatus);
      return payload.status as RuntimeStatus;
    }

    return null;
  }, [setRuntimeStatusWithReconciliation]);

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
      },
    ]);
    return id;
  }, []);

  const scanForImageReferences = useCallback(async (text: string): Promise<Attachment[]> => {
    // This function is disabled for now - it would need a different approach
    // with the new ID-based system. Images need to be explicitly uploaded.
    return [];
  }, []);

  const handleControlAction = useCallback(async (
    action: 'send' | 'steer' | 'replace',
    override?: { text: string; attachments: Attachment[] },
  ) => {
    const rawText = override?.text ?? input.trim();
    const baseAttachments = override?.attachments ?? attachments;

    if (!rawText && baseAttachments.length === 0) {
      return;
    }

    const autoAttachments = override ? [] : await scanForImageReferences(rawText);
    const messageAttachments = [...baseAttachments, ...autoAttachments];
    const userMessage: Extract<AgentMessage, { role: 'user' }> = {
      role: 'user',
      content: buildPromptContent(rawText, messageAttachments),
      timestamp: Date.now(),
    };

    setInput('');
    setAttachments([]);

    const targetSessionId = await ensureSession();
    
    // Use WebSocket if enabled and connected
    if (isWebSocketEnabled && wsConnected) {
      appendOptimisticUserMessage(rawText, messageAttachments, 'sent', undefined, userMessage);
      
      // Get user's timezone and current time from browser
      const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const currentTime = new Date().toISOString();
      const activeFilePath = currentFile?.path ?? null;
      
      // Send message with full context
      sendMessage(targetSessionId, userMessage as unknown as Record<string, unknown>, {
        activeFilePath,
        userTimeZone,
        currentTime,
      });
      
      return;
    }
    
    // Fallback to SSE if WebSocket not available
    const currentPhase = runtimeStatusRef.current?.phase || 'idle';

    if (currentPhase === 'idle') {
      appendOptimisticUserMessage(rawText, messageAttachments, 'sent', undefined, userMessage);
      await openRuntimeStream(targetSessionId, userMessage);
      return;
    }

    if (!streamAbortRef.current || streamSessionRef.current !== targetSessionId) {
      void openRuntimeStream(targetSessionId);
    }

    if (action === 'send') {
      appendOptimisticUserMessage(rawText, messageAttachments, 'queued_follow_up', 'follow_up', userMessage);
      await postControl(targetSessionId, 'follow_up', userMessage);
      return;
    }

    if (action === 'steer') {
      appendOptimisticUserMessage(rawText, messageAttachments, 'queued_steering', 'steer', userMessage);
      await postControl(targetSessionId, 'steer', userMessage);
      return;
    }

    appendOptimisticUserMessage(rawText, messageAttachments, 'sending', undefined, userMessage);
    setMessages((prev) =>
      prev.map((message) => (message.role === 'user' && message.status === 'sending' ? { ...message, status: 'aborting' } : message)),
    );
    await postControl(targetSessionId, 'replace', userMessage);
  }, [appendOptimisticUserMessage, attachments, currentFile, ensureSession, input, isWebSocketEnabled, wsConnected, sendMessage, openRuntimeStream, postControl, scanForImageReferences]);

  const handleSend = useCallback(async () => {
    try {
      await handleControlAction('send');
    } catch (error) {
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendSystemMessage, handleControlAction, t]);

  const handleSteer = useCallback(async () => {
    try {
      await handleControlAction('steer');
    } catch (error) {
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendSystemMessage, handleControlAction, t]);

  const handleNowSend = useCallback(async () => {
    try {
      await handleControlAction('replace');
    } catch (error) {
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendSystemMessage, handleControlAction, t]);

  const handleStop = useCallback(async () => {
    if (!sessionIdRef.current) return;
    try {
      await postControl(sessionIdRef.current, 'abort');
    } catch (error) {
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendSystemMessage, postControl, t]);

  const handleCompact = useCallback(async () => {
    if (!sessionIdRef.current) return;
    try {
      const status = await postControl(sessionIdRef.current, 'compact');
      if (status?.lastCompactionAt && status.lastCompactionKind) {
        appendCompactionBreak(status.lastCompactionKind, status.lastCompactionAt, status.lastCompactionOmittedCount || 0);
      }
    } catch (error) {
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendCompactionBreak, appendSystemMessage, postControl, t]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      channelRef.current?.close();
      streamAbortRef.current?.abort();
    };
  }, []);

  const startNewChat = useCallback(() => {
    resetStreamConnection();
    setRuntimeStatus(null);
    setSessionId(null);
    setSessionTitle(null);
    setInput('');
    setAttachments([]);
    sessionIdRef.current = null;
    lastCompactionMarkerRef.current = null;
    userStartedNewChatRef.current = true;
    setMessages([]);
    setShowHistory(false);
    setShowMobileDetails(false);
    setShowMobileActionPanel(false);
    if (agentConfig?.piConfig?.activeProvider && agentConfig?.piConfig?.providers) {
      const provider = agentConfig.piConfig.activeProvider;
      setActiveModel(agentConfig.piConfig.providers[provider]?.model || DEFAULT_MODEL_ID);
    } else {
      setActiveModel(DEFAULT_MODEL_ID);
    }
    toolMessageIdsRef.current = {};
  }, [agentConfig, resetStreamConnection]);

  const loadSession = useCallback(async (session: AISession) => {
    resetStreamConnection();
    setSessionId(session.sessionId);
    setSessionTitle(session.title || null);
    sessionIdRef.current = session.sessionId;
    lastCompactionMarkerRef.current = null;
    userStartedNewChatRef.current = false;
    setShowMobileDetails(false);
    setShowMobileActionPanel(false);
    setActiveModel(session.model || DEFAULT_MODEL_ID);
    setMessages([{ id: 'system', role: 'system', content: 'Loading...', status: 'pending', type: 'system' }]);
    setShowHistory(false);
    toolMessageIdsRef.current = {};

    // Check if session has unread messages and show banner
    if (session.hasUnread) {
      setHasUnreadInCurrentSession(true);
      setShowUnreadBanner(true);
      // Mark as read in database
      try {
        await fetch('/api/sessions', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: session.sessionId, markAsRead: true }),
        });
        setHasUnreadInCurrentSession(false);
        setShowUnreadBanner(false);
        // Update history state to reflect read status
        setHistory(prev => prev.map(s => 
          s.sessionId === session.sessionId ? { ...s, hasUnread: false, lastViewedAt: new Date().toISOString() } : s
        ));
      } catch (err) {
        console.error('Failed to mark session as read', err);
      }
    } else {
      setHasUnreadInCurrentSession(false);
      setShowUnreadBanner(false);
    }

    try {
      const [messagesResponse, statusResponse] = await Promise.all([
        fetch(`/api/sessions/messages?sessionId=${encodeURIComponent(session.sessionId)}`),
        fetch(`/api/stream/status?sessionId=${encodeURIComponent(session.sessionId)}`),
      ]);

      const messagesPayload = await messagesResponse.json();
      const statusPayload = await statusResponse.json().catch(() => null);

      if (messagesPayload.success && messagesPayload.messages) {
        setMessages(
          messagesPayload.messages.map((rawMessage: PersistedChatMessage) => {
            if (rawMessage.role === 'compact-break') {
              const cb = rawMessage as unknown as CompactBreakMessage;
              return {
                id: rawMessage.id?.toString() || `compact-${cb.timestamp}`,
                role: 'system' as const,
                content: '',
                type: 'compact_break' as const,
                status: 'sent' as const,
                compactMeta: {
                  kind: cb.kind,
                  timestamp: cb.timestamp,
                  omittedMessageCount: cb.omittedMessageCount,
                },
              };
            }

            const isToolResult = rawMessage.role === 'toolResult';
            const content = isToolResult
              ? extractToolResultText(Array.isArray(rawMessage.content) ? rawMessage.content : undefined) || extractPiMessageText(rawMessage)
              : extractPiMessageText(rawMessage);

            return {
              id: rawMessage.id?.toString() || Math.random().toString(),
              role: rawMessage.role,
              content,
              status: 'sent',
              type: isToolResult ? 'tool_result' : undefined,
              attachments: extractImageAttachments(rawMessage.content),
              piMessage: rawMessage,
              isCollapsed: isToolResult,
              autoCollapsedAtEnd: isToolResult,
              previewText: isToolResult ? truncatePreview(content) : undefined,
            };
          }),
        );
      }

      if (statusPayload?.success && statusPayload.status) {
        setRuntimeStatusWithReconciliation(statusPayload.status as RuntimeStatus);
        lastCompactionMarkerRef.current = (statusPayload.status as RuntimeStatus).lastCompactionAt || null;
        if ((statusPayload.status as RuntimeStatus).phase !== 'idle') {
          // For WebSocket mode, subscription happens via useEffect
          // For SSE mode, open the stream
          if (!isWebSocketEnabled) {
            void openRuntimeStream(session.sessionId);
          }
        }
      } else {
        setRuntimeStatus(null);
      }
      
      // Hide history view after loading session
      setShowHistory(false);
      
    } catch (err) {
      console.error('Failed to load messages', err);
      setMessages([{ id: 'error', role: 'system', content: t('failedToLoadMessageHistory') }]);
    }
  }, [isWebSocketEnabled, openRuntimeStream, resetStreamConnection, setRuntimeStatusWithReconciliation, t]);

  const deleteSession = useCallback(async (id: string) => {
    if (!confirm(t('deleteSessionConfirm'))) return;

    try {
      const res = await fetch(`/api/sessions?sessionId=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setHistory((prev) => prev.filter((session) => session.sessionId !== id));
        if (sessionIdRef.current === id) {
          startNewChat();
        }
      }
    } catch (err) {
      console.error('Failed to delete session', err);
    }
  }, [startNewChat, t]);

  const renameSession = useCallback(async (session: AISession) => {
    const nextTitle = prompt(t('renameSessionPrompt'), getSessionDisplayTitle(session.title, t('newChatTitle')));
    if (!nextTitle || !nextTitle.trim()) return;

    try {
      const res = await fetch('/api/sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId, title: nextTitle.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setHistory((prev) => prev.map((item) => (item.sessionId === session.sessionId ? { ...item, title: nextTitle.trim() } : item)));
        if (sessionIdRef.current === session.sessionId) {
          setSessionTitle(nextTitle.trim());
        }
      }
    } catch (err) {
      console.error('Failed to rename session', err);
    }
  }, [t]);

  const handleFileUpload = useCallback(async (file: File) => {
    setIsUploading(true);
    setUploadError(null);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/upload/attachment', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setUploadError(data.error ?? 'Upload fehlgeschlagen. Bitte erneut versuchen.');
      } else {
        // New unified response format - all file types use same structure
        const uploadedFile = data.file;
        const isImage = uploadedFile.category === 'image';
        
        setAttachments((prev) => [
          ...prev,
          {
            name: uploadedFile.originalName,
            contentKind: isImage ? 'image' : 'document',
            id: uploadedFile.id,
            mimeType: uploadedFile.mimeType,
            category: uploadedFile.category,
          },
        ]);
      }
    } catch (err) {
      console.error('Upload failed', err);
      setUploadError('Upload fehlgeschlagen. Netzwerkfehler oder Server nicht erreichbar.');
    } finally {
      setIsUploading(false);
    }
  }, []);

  const onFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) handleFileUpload(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [handleFileUpload]);

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    let foundImage = false;
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].type.indexOf('image') !== -1) {
        foundImage = true;
        const file = items[i].getAsFile();
        if (file) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const renamedFile = new File([file], `screenshot-${timestamp}.png`, { type: file.type });
          handleFileUpload(renamedFile);
        }
      }
    }
    if (!foundImage) {
      const text = event.clipboardData?.getData('text') ?? '';
      if (/\.(png|jpe?g|webp|gif)$/i.test(text.trim())) {
        setUploadError('Tipp: Dateien aus dem Finder können nicht direkt eingefügt werden. Bitte nutze die Büroklammer zum Hochladen, oder kopiere das Bild direkt (z.B. Screenshot).');
      }
    }
  }, [handleFileUpload]);

  const closeReferencePicker = useCallback(() => {
    setActiveReferenceMatch(null);
    setReferencePickerItems([]);
    setSelectedReferenceIndex(0);
    referenceRequestIdRef.current += 1;
  }, []);

  const fetchFiles = useCallback(async (query: string = '', requestId: number) => {
    try {
      const res = await fetch(`/api/files/list?q=${encodeURIComponent(query)}&limit=50`);
      const data = await res.json();
      if (requestId !== referenceRequestIdRef.current) {
        return;
      }

      if (data.success) {
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
      const data = await res.json();
      if (!data.success) {
        return [];
      }

      const nextSkills = (data.skills as Array<SkillPickerSkill & { path?: string }>).filter((skill) => skill.enabled).map((skill) => ({
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
  }, [closeReferencePicker, fetchFiles, fetchSkills, setSkillReferenceItems]);

  const handleReferenceSelect = useCallback((item: ComposerReferencePickerItem<ReferencePickerValue>) => {
    if (!activeReferenceMatch) {
      return;
    }

    const replacement = item.kind === 'file'
      ? `@"${(item.payload as FilePickerFile).path}" `
      : `/${(item.payload as SkillPickerSkill).name} `;
    const { nextValue, nextCursorPosition } = replaceComposerReference(input, activeReferenceMatch, replacement);

    setInput(nextValue);
    closeReferencePicker();

    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursorPosition, nextCursorPosition);
    }, 0);
  }, [activeReferenceMatch, closeReferencePicker, input]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (activeReferenceMatch && e.key === 'Escape') {
      e.preventDefault();
      closeReferencePicker();
      return;
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

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }, [activeReferenceMatch, closeReferencePicker, handleReferenceSelect, handleSend, referencePickerItems, selectedReferenceIndex]);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await fetch('/api/agents/config');
        const data = await res.json();
        if (data.success) {
          setAgentConfig(data.data);
        }
      } catch (err) {
        console.error('Failed to fetch agent config', err);
      }
    };

    void fetchConfig();
  }, []);

  useEffect(() => {
    if (agentConfig?.piConfig?.activeProvider && agentConfig?.piConfig?.providers) {
      const provider = agentConfig.piConfig.activeProvider;
      const model = agentConfig.piConfig.providers[provider]?.model;
      if (model) {
        setActiveModel(model);
      }
    }
  }, [agentConfig]);

  const currentModelSupportsVision = useCallback(() => {
    if (!agentConfig) return false;
    const activeProvider = agentConfig.piConfig.activeProvider;
    const modelId = agentConfig.piConfig.providers[activeProvider]?.model;
    if (!modelId) return false;
    return agentConfig.discovery[activeProvider]?.models.find((model) => model.id === modelId)?.supportsVision || false;
  }, [agentConfig]);

  useEffect(() => {
    if (initialPromptConsumedRef.current) return;

    const queueInitialPrompt = async (promptText: string, promptAttachments: Attachment[]) => {
      initialPromptConsumedRef.current = true;
      try {
        await handleControlAction('send', { text: promptText, attachments: promptAttachments });
      } catch (error) {
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

    try {
      const parsed = JSON.parse(storedData);
      if (parsed && (parsed.prompt || parsed.attachments)) {
        window.sessionStorage.removeItem(initialPromptStorageKey);
        void queueInitialPrompt(parsed.prompt || '', parsed.attachments || []);
        return;
      }
    } catch {
      // fallback below
    }

    if (storedData.trim()) {
      window.sessionStorage.removeItem(initialPromptStorageKey);
      void queueInitialPrompt(storedData.trim(), []);
    }
  }, [appendSystemMessage, handleControlAction, initialPrompt, initialPromptStorageKey, t]);

  useEffect(() => {
    if (initialPrompt?.trim()) return;
    if (requestedSessionId) return;
    if (userStartedNewChatRef.current) return;
    void fetchHistory();
  }, [fetchHistory, initialPrompt, requestedSessionId]);

  useEffect(() => {
    if (initialPrompt?.trim()) return;
    if (initialPromptStorageKey && typeof window !== 'undefined' && window.sessionStorage.getItem(initialPromptStorageKey)) {
      return;
    }
    if (userStartedNewChatRef.current) return;
    if (!requestedSessionId) return;

    const loadRequestedSession = async () => {
      try {
        const res = await fetch('/api/sessions');
        const data = await res.json();
        if (data.success && data.sessions && data.sessions.length > 0) {
          const targetSession = data.sessions.find((session: AISession) => session.sessionId === requestedSessionId);
          if (targetSession) {
            await loadSession(targetSession);
          }
        }
      } catch (err) {
        console.error('Failed to load requested session', err);
      }
    };

    void loadRequestedSession();
  }, [initialPrompt, initialPromptStorageKey, loadSession, requestedSessionId]);

  useEffect(() => {
    if (!sessionId) return;
    void refreshRuntimeStatus(sessionId);
    const interval = setInterval(() => {
      void refreshRuntimeStatus(sessionId);
    }, 4000);
    return () => clearInterval(interval);
  }, [refreshRuntimeStatus, sessionId]);

  useEffect(() => () => {
    resetStreamConnection();
  }, [resetStreamConnection]);

  useEffect(() => {
    if (!isMobile) {
      setShowMobileDetails(false);
      setShowMobileActionPanel(false);
    }
  }, [isMobile]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;

    const updateComposerHeight = () => {
      const { height, width } = composer.getBoundingClientRect();
      setComposerHeight(height);
      setComposerWidth(width);
    };

    updateComposerHeight();

    const resizeObserver = new ResizeObserver(() => {
      updateComposerHeight();
    });

    resizeObserver.observe(composer);
    window.addEventListener('resize', updateComposerHeight);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateComposerHeight);
    };
  }, [attachments.length, isMobile, runtimeStatus?.phase, showMobileActionPanel]);

  useEffect(() => {
    syncTextareaHeight();
  }, [composerWidth, syncTextareaHeight]);

  const totalQueuedMessages = (runtimeStatus?.followUpQueue.length || 0) + (runtimeStatus?.steeringQueue.length || 0);
  const queuePreview = [...(runtimeStatus?.steeringQueue || []), ...(runtimeStatus?.followUpQueue || [])].slice(0, 3);
  const contextLabel = runtimeStatus
    ? t('contextLabel', {
        percent: runtimeStatus.contextUsagePercent,
        used: formatContextTokens(runtimeStatus.estimatedHistoryTokens),
        available: formatContextTokens(runtimeStatus.availableHistoryTokens),
        window: formatContextTokens(runtimeStatus.contextWindow),
      })
    : t('noSessionYet');
  const sessionDisplayLabel = getSessionDisplayLabel(sessionTitle, t('newChatTitle'));
  const hasComposerContent = Boolean(input.trim()) || attachments.length > 0;
  const scrollContentPadding = composerHeight + 24;
  const scrollButtonOffset = composerHeight + 16;
  const isCompactComposer = composerWidth > 0 && composerWidth < 520;
  const isCompactView = isMobile || (composerWidth > 0 && composerWidth < 640);

  const applyStarterPrompt = useCallback((value: string) => {
    setInput(value);
    setShowHistory(false);
    setShowMobileActionPanel(false);
    textareaRef.current?.focus();
  }, []);

  const composerPlaceholder = isMobile
    ? t('composerPlaceholderMobile')
    : isCompactComposer
      ? t('composerPlaceholderCompact')
      : t('composerPlaceholderDefault');
  const composerHint =
    runtimeStatus?.phase !== 'idle'
      ? isMobile
        ? t('composerHintBusyMobile')
        : t('composerHintBusyDesktop')
      : t('composerHintIdle');
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
    <div className="relative flex h-full flex-col overflow-hidden bg-card text-card-foreground">
      <div className="z-10 border-b border-border bg-background/95">
        {/* Compact Header Row */}
        <div className="flex items-center justify-between px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            {showHistory ? (
              <button
                type="button"
                aria-label={t('backToChat')}
                onClick={() => setShowHistory(false)}
                className="border border-transparent p-1 transition-colors hover:border-border hover:bg-accent"
                title={t('backToChat')}
              >
                <ChevronLeft size={18} />
              </button>
            ) : (
              <button
                type="button"
                aria-label={t('openHistory')}
                onClick={() => {
                  setShowHistory(true);
                  void fetchHistory();
                }}
                className="border border-transparent p-1 transition-colors hover:border-border hover:bg-accent"
                title={t('openHistory')}
              >
                <History size={18} />
              </button>
            )}
            <div className="min-w-0">
              {showHistory ? (
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">{t('history')}</span>
              ) : isMobile ? (
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">{t('canvasChatLabel')}</span>
              ) : (
                <div className="flex min-w-0 items-center gap-1.5">
                  {/* Session Badge */}
                  <div
                    data-testid="chat-session-id"
                    title={sessionDisplayLabel}
                    className="inline-flex min-w-0 items-center gap-1.5 border border-border/60 bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-foreground"
                  >
                    <span className="text-[9px] uppercase tracking-[0.15em] text-muted-foreground">{t('sessionLabel')}</span>
                    <span className="min-w-0 truncate max-w-[120px]">{sessionDisplayLabel}</span>
                  </div>
                  {/* Model Badge */}
                  <div
                    data-testid="chat-model-badge"
                    title={t('currentModelLabel', { model: activeModel })}
                    className="inline-flex min-w-0 items-center gap-1 border border-border/60 bg-muted/50 px-2.5 py-0.5 text-[11px] text-foreground"
                  >
                    <span className="text-[9px] uppercase tracking-[0.15em] text-muted-foreground">{t('modelLabel')}</span>
                    <span className="max-w-[140px] truncate font-mono text-[9px]">{activeModel}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={t('newChatTitle')}
              onClick={startNewChat}
              className="group flex items-center gap-1 border border-primary/30 bg-primary/15 px-2 py-1 text-primary transition-all hover:bg-primary/25"
              title={t('newChatTitle')}
            >
              <Plus size={16} />
              <span className="hidden text-[11px] font-bold sm:inline">{t('newChatShort')}</span>
            </button>
            {showSkillsLink && (
              <Link
                href="/skills"
                aria-label={t('viewSkills')}
                className="group flex items-center gap-1 border border-border bg-muted/50 px-2 py-1 text-muted-foreground transition-all hover:bg-accent hover:text-foreground"
                title={t('viewSkills')}
              >
                <Lightbulb size={16} />
                <span className="hidden text-[11px] font-bold sm:inline">{t('skills')}</span>
              </Link>
            )}
          </div>
        </div>

        {/* Compact Status Bar */}
        {!showHistory && (
          <div data-testid="chat-runtime-banner" className="border-t border-border/50 px-3 py-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <div data-testid="chat-runtime-status" className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <ChatRuntimeActivityBadge status={runtimeStatus} />
                
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
                {!isMobile && runtimeStatus?.activeTool && (
                  <span className="inline-flex items-center gap-1 border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600">
                    <Wrench size={10} />
                    {runtimeStatus.activeTool.name}
                  </span>
                )}
              </div>
              
              {/* Right: Action Buttons */}
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                {!isMobile ? (
                  <span
                    data-testid="chat-context-meter"
                    className="inline-flex items-center border border-border/60 bg-muted/40 px-2.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                  >
                    {contextLabel}
                  </span>
                ) : null}
                {!isMobile && (
                  <>
                    <button
                      type="button"
                      data-testid="chat-stop"
                      onClick={() => void handleStop()}
                      disabled={!runtimeStatus?.canAbort}
                      className="border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {t('stop')}
                    </button>
                    <button
                      type="button"
                      data-testid="chat-compact"
                      onClick={() => void handleCompact()}
                      disabled={!sessionId || runtimeStatus?.phase !== 'idle'}
                      className="border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {t('compact')}
                    </button>
                  </>
                )}
                {isMobile && (
                  <button
                    type="button"
                    data-testid="chat-stop"
                    onClick={() => void handleStop()}
                    disabled={!runtimeStatus?.canAbort}
                    className="border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('stop')}
                  </button>
                )}
                {isMobile && (
                  <button
                    type="button"
                    data-testid="chat-mobile-details-toggle"
                    onClick={() => setShowMobileDetails((current) => !current)}
                    className="inline-flex items-center gap-1 border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-accent"
                  >
                    {t('details')}
                    {showMobileDetails ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  </button>
                )}
              </div>
            </div>
            
            {/* Context Progress Bar - Slim */}
            <div className="mt-1.5 flex items-center gap-2">
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
                  style={{ width: `${Math.max(4, runtimeStatus?.contextUsagePercent || 0)}%` }}
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
                  <div
                    data-testid="chat-model-badge"
                    title={t('currentModelLabel', { model: activeModel })}
                    className="inline-flex min-w-0 items-center gap-1 border border-border/60 bg-muted/40 px-2.5 py-0.5 text-[10px] text-foreground"
                  >
                    <span className="text-[9px] uppercase tracking-[0.15em] text-muted-foreground">{t('modelLabel')}</span>
                    <span className="max-w-[120px] truncate font-mono text-[9px]">{activeModel}</span>
                  </div>
                  {runtimeStatus?.includedSummary && (
                    <span className="border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {t('summary')}
                    </span>
                  )}
                  {runtimeStatus?.activeTool && (
                    <span className="inline-flex items-center gap-1 border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600">
                      <Wrench size={9} />
                      {runtimeStatus.activeTool.name}
                    </span>
                  )}
                </div>
                <div data-testid="chat-context-meter" className="text-[10px] text-muted-foreground">
                  {contextLabel}
                </div>
                {totalQueuedMessages > 0 && (
                  <div data-testid="chat-queue-panel" className="border border-border/60 bg-muted/30 p-1.5 text-[10px]">
                    <div className="mb-1 font-medium text-foreground">{t('queuedCount', { count: totalQueuedMessages })}</div>
                    <div className="flex flex-wrap gap-1 text-muted-foreground">
                      {queuePreview.map((entry) => (
                        <span key={entry.id} className="border border-border/60 bg-muted/40 px-1.5 py-0.5">
                          {entry.text || t('imageMessage')}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="relative flex-1">
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

        {showHistory && (
          <div className="absolute inset-0 z-20 space-y-1 overflow-y-auto bg-background p-2 pb-20">
            <div className="mb-2 flex items-center gap-2 border-b border-border px-2 py-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              <History size={10} /> {t('sessions')}
            </div>
            {history.length === 0 && <div className="p-8 text-center text-sm italic text-muted-foreground">{t('noRecentSessions')}</div>}
            {history.map((session) => (
              <div key={session.id} className="group mb-1 flex w-full items-center border border-transparent bg-muted/30 p-2 transition-all hover:border-border hover:bg-accent">
                <button type="button" onClick={() => void loadSession(session)} className="min-w-0 flex-1 text-left flex items-start gap-2">
                  {session.hasUnread && (
                    <div 
                      className="mt-1 h-2 w-2 shrink-0 rounded-full bg-blue-500"
                      title={t('unreadResponse')}
                      aria-label={t('unreadResponse')}
                    />
                  )}
                  <div className="min-w-0 flex-1 text-left">
                    <div className="truncate text-sm font-medium text-foreground group-hover:text-primary">
                      {getSessionDisplayTitle(session.title, t('newChatTitle'))}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                      <span>{new Date(session.createdAt).toLocaleString()}</span>
                      <span>&bull;</span>
                      <span>{session.model}</span>
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => void renameSession(session)}
                  className="ml-2 shrink-0 border border-transparent p-2 text-muted-foreground transition-all hover:border-border hover:bg-accent"
                  title={t('renameSession')}
                >
                  <Pencil size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => void deleteSession(session.sessionId)}
                  className="ml-1 shrink-0 border border-transparent p-2 text-muted-foreground transition-all hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                  title={t('deleteSession')}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div
          ref={scrollContainerRef}
          data-testid="chat-scroll-region"
          className="absolute inset-0 space-y-4 overflow-y-auto p-4"
          style={{
            paddingBottom: `${scrollContentPadding}px`,
            overflowAnchor: isAtBottom ? 'auto' : 'none',
          }}
        >
          {messages.length === 0 && (
            <div className="flex min-h-full flex-col justify-start py-4 md:justify-center md:py-0">
              <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-5 text-center">
                <div className="space-y-2">
                  <span className="inline-flex items-center gap-2 border border-border bg-background/80 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    <Sparkles className="h-4 w-4 text-primary" />
                    {t('productivityBadge')}
                  </span>
                  {latestSession ? (
                    <div className="flex justify-center">
                      <Link
                        href={`${sessionBasePath}?session=${encodeURIComponent(latestSession.sessionId)}`}
                        className="inline-flex max-w-full items-center gap-2 border border-border bg-background/80 px-3 py-1.5 text-xs text-foreground transition-colors hover:border-primary/40 hover:bg-accent"
                      >
                        <History className="h-3.5 w-3.5 text-primary" />
                        <span className="font-medium">{t('openLatestSession')}</span>
                        <span className="max-w-[14rem] truncate text-muted-foreground">{latestSession.title || latestSession.sessionId}</span>
                      </Link>
                    </div>
                  ) : null}
                  <div className="space-y-1">
                    <h2 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">{t('starterTitle')}</h2>
                    <p className="mx-auto max-w-2xl text-sm leading-relaxed text-muted-foreground">
                      {t('starterDescription')}
                    </p>
                  </div>
                </div>
                <div data-testid="chat-starter-prompts" className={`w-full gap-3 pb-3 ${isCompactView ? 'grid grid-cols-1 sm:grid-cols-2' : 'flex overflow-x-auto no-scrollbar md:grid md:grid-cols-2 md:overflow-visible xl:grid-cols-3'} gap-4`}>
                  {localizedStarterPrompts.map((prompt) => (
                    <StarterPromptButton key={prompt.id} prompt={prompt} onSelect={applyStarterPrompt} compact={isCompactView} />
                  ))}
                </div>
              </div>
            </div>
          )}

          {messages.map((message, index) => {
            const isUser = message.role === 'user';
            const isAssistant = message.role === 'assistant';
            const isTool = message.role === 'toolResult';
            const isSystem = message.role === 'system';
            const isSystemError = isSystem && message.status === 'error';
            const usage = getAssistantChainUsage(messages, index);
            const isCompactBreak = message.type === 'compact_break';
            const isStreamingAssistant = isAssistant && message.status === 'sending';

            if (isCompactBreak) {
              return (
                <div key={message.id} data-testid="chat-compaction-break" className="flex items-center gap-3 py-1">
                  <div className="h-px flex-1 bg-border/80" />
                  <div className="border border-border/70 bg-background/90 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    {getCompactBreakLabel(message, t)}
                  </div>
                  <div className="h-px flex-1 bg-border/80" />
                </div>
              );
            }

            const bubbleClass = isUser
              ? 'border-primary bg-primary text-primary-foreground shadow-sm'
              : isAssistant
                ? 'border-border bg-muted text-foreground'
                : isTool
                  ? 'border-amber-500/40 bg-amber-500/10 text-foreground'
                  : isSystemError
                    ? 'border-destructive/40 bg-destructive/10 text-destructive'
                    : 'border-border bg-background/80 text-muted-foreground';

            const title = isUser ? t('you') : isTool ? (message.toolName || t('tool')) : isAssistant ? t('assistant') : t('system');
            const bodyContent =
              message.content ||
              (message.status === 'queued_follow_up'
                ? t('queuedAfterCurrentRun')
                : message.status === 'queued_steering'
                  ? t('queuedAsSteeringMessage')
                  : message.status === 'aborting'
                    ? t('willSendAfterStop')
                    : message.status === 'sending'
                      ? (isTool ? t('runningTool') : t('agentWorking'))
                      : '');
            const toolBodyVisible = isTool ? !message.isCollapsed : true;
            const toolStatusLabel = isTool ? getToolStatusLabel(message, t) : null;

            return (
              <div key={message.id} data-testid={`chat-message-${message.role}`} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[96%] border p-3 sm:max-w-[90%] ${bubbleClass}`}>
                  {isTool ? (
                    <div>
                      <button
                        type="button"
                        data-testid="chat-tool-toggle"
                        onClick={() => toggleToolMessage(message.id)}
                        className="flex w-full items-start gap-3 text-left"
                      >
                        <span className="mt-0.5 text-amber-600/90">
                          <Wrench className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">{title}</span>
                            <span className="border border-amber-500/30 bg-background/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                              {toolStatusLabel}
                            </span>
                            {message.autoCollapsedAtEnd ? <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{t('auto')}</span> : null}
                          </div>
                          <div className="mt-1 text-sm font-medium text-foreground">{message.toolName || t('tool')}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{message.previewText || t('noOutputYet')}</div>
                        </div>
                        <span className="mt-0.5 text-muted-foreground">
                          {toolBodyVisible ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </span>
                      </button>

                      {toolBodyVisible ? (
                        <div data-testid="chat-tool-body" className="mt-3 space-y-3">
                          {message.toolArgs ? (
                            <div className="rounded-md border border-amber-500/30 bg-background/60 p-2">
                              <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{t('toolInput')}</div>
                              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90">{message.toolArgs}</pre>
                            </div>
                          ) : null}
                          <MarkdownMessage content={bodyContent} variant="tool" />
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <>
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">{title}</span>
                        {message.status === 'aborting' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-70" />}
                        {message.status === 'queued_follow_up' ? <span className="text-[10px] uppercase tracking-widest opacity-60">{t('queue')}</span> : null}
                        {message.status === 'queued_steering' ? <span className="text-[10px] uppercase tracking-widest opacity-60">{t('steer')}</span> : null}
                      </div>

                      {isUser ? (
                        <MarkdownMessage content={bodyContent} variant="user" />
                      ) : isAssistant ? (
                        isStreamingAssistant ? (
                          <StreamingMessageIndicator />
                        ) : (
                          <MarkdownMessage content={bodyContent} variant="assistant" />
                        )
                      ) : (
                        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{bodyContent}</div>
                      )}
                    </>
                  )}

                  {message.attachments && message.attachments.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {message.attachments.map((attachment, index) => (
                        <div key={index} className="flex items-center gap-1.5 border border-border bg-background/50 p-1.5 px-2.5 text-[10px]">
                          <ImageIcon className="h-3 w-3" /> {attachment.name}
                        </div>
                      ))}
                    </div>
                  )}

                  {usage ? (
                    <div data-testid="chat-usage-footer" className="mt-3 border-t border-border/70 pt-2 text-[11px] text-muted-foreground">
                      <div className="font-medium text-foreground/80">{formatUsageCompact(usage)}</div>
                      <div>{formatUsageBreakdown(usage)}</div>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {!isAtBottom && messages.length > 0 && (
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
        className="absolute bottom-0 left-0 right-0 z-20 border-t border-border bg-background/95 px-3 pt-3"
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

        {attachments.length > 0 && (
          <div
            className={`mb-2 gap-2 border border-border bg-muted/60 p-2 ${
              isMobile ? 'flex overflow-x-auto no-scrollbar' : 'flex flex-wrap'
            }`}
          >
            {attachments.map((attachment, index) => (
              <div key={index} className="flex shrink-0 items-center gap-2 border border-border bg-accent/70 p-1 px-2 text-xs">
                {attachment.contentKind === 'image'
                  ? <ImageIcon className="h-3.5 w-3.5" />
                  : <FileText className="h-3.5 w-3.5" />} {attachment.name}
                <button type="button" onClick={() => removeAttachment(index)} className="hover:text-destructive">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {!isMobile && runtimeStatus && totalQueuedMessages > 0 && (
          <div data-testid="chat-queue-panel" className="mb-2 border border-border bg-muted/50 p-2 text-xs">
            <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
              <span>{t('queuedCount', { count: totalQueuedMessages })}</span>
              {runtimeStatus.activeTool ? <span className="text-muted-foreground">{t('activeToolPrefix')} {runtimeStatus.activeTool.name}</span> : null}
            </div>
            <div className="flex flex-wrap gap-2 text-muted-foreground">
              {queuePreview.map((entry) => (
                <span key={entry.id} className="border border-border/70 bg-background/60 px-2 py-1">
                  {entry.text || t('imageMessage')}
                </span>
              ))}
            </div>
          </div>
        )}

        {isMobile ? (
          <>
            {showMobileActionPanel && totalQueuedMessages > 0 ? (
              <div data-testid="chat-mobile-action-panel" className="mb-2 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  data-testid="chat-steer"
                  onClick={() => void handleSteer()}
                  disabled={!hasComposerContent}
                className="border border-border bg-muted/60 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                  {t('steerAction')}
                </button>
                <button
                  type="button"
                  data-testid="chat-send-now"
                  onClick={() => void handleNowSend()}
                  disabled={!hasComposerContent}
                className="border border-primary/30 bg-primary/10 px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                  {t('sendNow')}
                </button>
                <button
                  type="button"
                  data-testid="chat-compact-mobile"
                  onClick={() => void handleCompact()}
                  disabled={!sessionId || runtimeStatus?.phase !== 'idle'}
                className="border border-border bg-background/80 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                  {t('compactCanvas')}
                </button>
                <button
                  type="button"
                onClick={() => setShowMobileActionPanel(false)}
                className="border border-border bg-background/80 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent"
              >
                  {t('close')}
                </button>
              </div>
            ) : null}
          </>
        ) : totalQueuedMessages > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="chat-steer"
              onClick={() => void handleSteer()}
              disabled={!hasComposerContent}
              className="border border-border bg-muted/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('steerAction')}
            </button>
            <button
              type="button"
              data-testid="chat-send-now"
              onClick={() => void handleNowSend()}
              disabled={!hasComposerContent}
              className="border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('sendNow')}
            </button>
          </div>
        ) : null}

        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="border border-transparent p-2.5 text-muted-foreground transition-colors hover:border-border hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            title={isUploading ? t('uploading') : t('attachImage')}
          >
            {isUploading
              ? <Loader2 className="h-5 w-5 animate-spin" />
              : <Paperclip className="h-5 w-5" />}
          </button>
          <input type="file" ref={fileInputRef} onChange={onFileChange} className="hidden" accept="image/*,application/pdf,.docx,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html" />
          <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              data-testid="chat-input"
              rows={1}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={composerPlaceholder}
              style={{ height: `${textareaHeight}px` }}
              className="w-full resize-none border border-border bg-background p-2.5 text-base placeholder:text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring md:text-sm sm:placeholder:text-sm"
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
          {isMobile && totalQueuedMessages > 0 ? (
            <button
              type="button"
              data-testid="chat-mobile-action-toggle"
              onClick={() => setShowMobileActionPanel((current) => !current)}
              className="relative border border-transparent p-2.5 text-muted-foreground transition-colors hover:border-border hover:bg-accent"
              title={t('quickActions')}
            >
              <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground">
                {totalQueuedMessages}
              </span>
              {showMobileActionPanel ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="chat-send"
            onClick={() => void handleSend()}
            className="flex-shrink-0 bg-primary p-2.5 text-primary-foreground transition-all hover:bg-primary/90 disabled:opacity-30"
            disabled={!hasComposerContent}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-5 w-5">
              <path d="M22 2L11 13M22 2L15 22L11 13M11 13L2 9L22 2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <div className="mt-2 flex items-start justify-between gap-2">
          <div className="flex flex-col items-start gap-1">
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
            {showComposerHint ? (
              <div className="max-w-[38rem] border border-border/60 bg-muted/30 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
                {composerHint}
              </div>
            ) : null}
          </div>
          <Link
            href="/settings?tab=agent"
            aria-label={t('openAgentSettings')}
            className="inline-flex items-center gap-1 border border-border/60 bg-muted/30 px-2 py-1 text-[10px] text-muted-foreground transition-all hover:bg-accent hover:text-foreground"
            title={t('openAgentSettings')}
          >
            <Settings className="h-3 w-3" />
            <span>{t('settings')}</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
