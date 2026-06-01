'use client';

import React, { useState, useRef, useEffect, useCallback, useLayoutEffect, useMemo } from 'react';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { MermaidDiagram } from '@/components/ui/mermaid-diagram';
import { isColorCode, ColorSwatch } from '@/app/lib/markdown/color-swatch';
import { rehypeInlineColorSwatch } from '@/app/lib/markdown/rehype-inline-color-swatch';
import { useTranslations } from 'next-intl';
import type { AnthropicSkill } from '@/app/lib/skills/skill-manifest-anthropic';
import {
  Paperclip,
  X,
  Image as ImageIcon,
  CornerDownRight,
  GripVertical,
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
  Terminal,
  FolderOpen,
  Lightbulb,
  CircleHelp,
  Megaphone,
  WandSparkles,
  Clapperboard,
  BriefcaseBusiness,
  FileText,
  FolderTree,
  Settings,
  Search,
  Globe,
  Paintbrush,
  Video,
  AudioLines,
  Package,
  UserRound,
  Palette,
  ListChecks,
  ListTodo,
  CheckCircle2,
  XCircle,
  Copy,
  Eye,
  EyeOff,
  ArrowLeft,
  CheckCheck,
  ExternalLink,
  Lock,
  MoreHorizontal,
  Square,
  Brain,
  CalendarClock,
  CalendarCog,
  CalendarPlus,
  CalendarX,
  FileJson,
  Inbox,
  MailOpen,
  MailPlus,
  MessagesSquare,
  Network,
  PencilLine,
  Play,
  Plug,
  PlugZap,
  SearchCheck,
  Send,
  SquareFunction,
} from 'lucide-react';
import { ComposerReferencePicker, type ComposerReferencePickerItem } from '@/app/components/canvas-agent-chat/ComposerReferencePicker';
import { FileReferenceCard } from '@/app/components/canvas-agent-chat/FileReferenceCard';
import { extractFilePaths, isFilePath, normalizeChatFilePath } from '@/app/lib/chat/extract-file-paths';
import { extractStudioImageMediaUrls, rewriteRelativeStudioImageMarkdown } from '@/app/lib/chat/studio-image-markdown';
import { validateFileExists } from '@/app/lib/chat/validate-file-paths';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { toMediaUrl, toWorkspaceMediaUrl } from '@/app/lib/utils/media-url';
import { useFileStore } from '@/app/store/file-store';
import { Link } from '@/i18n/navigation';
import { useRouter, useSearchParams } from 'next/navigation';
import { usePathname as useLocalePathname, getPathname } from '@/i18n/navigation';
import { useLocale } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';


import { ThemeToggle } from '@/app/components/ThemeToggle';

import { findActiveComposerReference, replaceComposerReference, type ComposerReferenceMatch } from '@/app/lib/chat/composer-references';
import { useIsMobile } from '@/hooks/use-mobile';
import { BUSINESS_STARTER_PROMPTS, STUDIO_STARTER_PROMPTS, type StarterPromptDefinition, type StarterPromptIcon } from '@/app/lib/chat/starter-prompts';
import { ChatRuntimeActivityBadge } from '@/app/components/canvas-agent-chat/ChatRuntimeActivityBadge';
import { ChatModelSelector } from '@/app/components/canvas-agent-chat/ChatModelSelector';
import { AgentAvatar, AgentIcon } from '@/app/components/agents/AgentAvatar';
import type { RuntimeQueueItem, RuntimeStatus } from '@/app/components/canvas-agent-chat/runtime-status';
import { getSessionDisplayTitle, isAutomaticSessionTitle } from '@/app/lib/pi/session-titles';
import { type CompactBreakMessage, isCompactBreakMessage, isComposioAuthRequiredMessage, type ComposioAuthRequiredMessage } from '@/app/lib/pi/custom-messages';
import { renderSkillIcon } from '@/app/lib/skills/skill-icons';
import { searchSkillReferenceEntries } from '@/app/lib/skills/skill-reference-search';
import { useWebSocket } from '@/app/hooks/useWebSocket';
import { ImagePreprocessDialog } from '@/app/components/shared/ImagePreprocessDialog';
import type { ConvertParams } from '@/app/components/shared/ImagePreprocessDialog';
import { usePlanModeStore } from '@/app/store/plan-mode-store';
import { useToolVerbosityStore, type ToolVerbosity } from '@/app/store/tool-verbosity-store';
import { getToolDisplayInfo, type ToolDisplayTone } from '@/app/lib/pi/tool-display';
import { cn } from '@/lib/utils';

import { PlanModeToggle } from './PlanModeToggle';
import { CANVAS_CHAT_ACTIVE_SESSION_STORAGE_KEY } from '@/app/lib/chat/constants';
import { applySessionUnreadUpdate } from '@/app/lib/chat/unread';
import type { ChatRequestContext } from '@/app/lib/chat/types';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';

interface Attachment {
  name: string;
  contentKind: 'image' | 'document';
  // File ID for accessing via /api/files/[id]
  id: string;
  mimeType?: string;
  // document category
  category?: string;
  // Optional: absolute file path for direct server-side reading (studio outputs, etc.)
  filePath?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'toolResult';
  content: string;
  type?: 'tool_use' | 'tool_result' | 'system' | 'compact_break' | 'composio_auth_required';
  status?: 'pending' | 'sending' | 'queued_follow_up' | 'queued_steering' | 'aborting' | 'sent' | 'error';
  attachments?: Attachment[];
  piMessage?: AgentMessage;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: string;
  queueKind?: 'follow_up' | 'steer';
  optimistic?: boolean;
  isCollapsed?: boolean;
  autoCollapsedAtEnd?: boolean;
  previewText?: string;
  compactMeta?: {
    kind: 'manual' | 'automatic';
    timestamp: string;
    omittedMessageCount: number;
  };
  composioAuthMeta?: {
    toolkit: string;
    toolkitName: string;
    redirectUrl: string;
    toolName: string;
  };
}

type QueuePreviewItem = RuntimeQueueItem & { kind: 'follow_up' | 'steer' };

interface AISession {
  id: number;
  sessionId: string;
  title: string | null;
  agentId?: string;
  model: string;
  provider?: string | null;
  thinkingLevel?: PiThinkingLevel | null;
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

type CachedChatSession = {
  version: 1;
  session: AISession;
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  oldestTimestamp: number | null;
  oldestMessageId: number | null;
  cachedAt: number;
};

type ChatSessionCacheStore = {
  version: 1;
  entries: CachedChatSession[];
};

interface ChatEvent {
  type: string;
  message?: AgentMessage;
  text?: string;
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
type PersistedToolCallPart = {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: unknown;
};
type UserPiMessage = Extract<AgentMessage, { role: 'user' }>;
type UserPiContent = UserPiMessage['content'];

type CollapsedRun = {
  key: string;
  finalAssistantId: string;
  steps: ChatMessage[];
  startedAt: number | null;
  endedAt: number | null;
};

type DiscoveryModel = {
  id: string;
  name: string;
  supportsVision?: boolean;
  reasoning?: boolean;
};

type AgentConfig = {
  piConfig: {
    activeProvider: string;
    providers: Record<string, { model: string; thinking?: PiThinkingLevel }>;
  };
  effectiveConfig?: {
    agentId: string;
    activeProvider: string;
    model: string | null;
    thinkingLevel: PiThinkingLevel;
    setupState?: {
      modelConfigured: boolean;
      issues: string[];
    };
  };
  discovery: Record<string, { models: DiscoveryModel[] }>;
};

type AgentProfile = {
  agentId: string;
  name: string;
  iconId?: string;
  type: string;
  removable: boolean;
};

type ChatHistoryGroup = 'today' | 'last7' | 'last14' | 'last30' | 'older';
type ChatHistoryGroups = Record<ChatHistoryGroup, AISession[]>;
type ChatHistoryPanelVariant = 'sidebar' | 'overlay';
type ChatHistoryAgentOption = {
  agentId: string;
  name: string;
  iconId?: string;
  count: number;
};
const CHAT_HISTORY_GROUP_ORDER: ChatHistoryGroup[] = ['today', 'last7', 'last14', 'last30', 'older'];

const CHAT_AGENT_ID = DEFAULT_AGENT_ID;
const CHAT_SESSION_CACHE_VERSION = 1;
const CHAT_SESSION_MESSAGE_CACHE_STORAGE_KEY = 'canvas.chat.sessionMessages.v1';
const CHAT_SESSION_MESSAGE_CACHE_MAX_ENTRIES = 6;
const CHAT_SESSION_MESSAGE_CACHE_MAX_MESSAGES = 120;
const CHAT_SESSION_MESSAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const inMemoryChatSessionCache = new Map<string, CachedChatSession>();
let hasHydratedChatSessionCache = false;

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

const STARTER_PROMPT_ICONS: Record<StarterPromptIcon, React.ComponentType<{ className?: string }>> = {
  campaign: Megaphone,
  creative: WandSparkles,
  video: Clapperboard,
  strategy: BriefcaseBusiness,
  document: FileText,
  organize: FolderTree,
};

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

  return {
    name,
    id,
    contentKind,
    mimeType: typeof value.mimeType === 'string' ? value.mimeType : undefined,
    category: typeof value.category === 'string' ? value.category : undefined,
    filePath: typeof value.filePath === 'string' ? value.filePath : undefined,
  };
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

const TOOL_TONE_ICONS: Record<ToolDisplayTone, React.ComponentType<{ className?: string }>> = {
  command: Terminal,
  file: FolderOpen,
  search: Search,
  web: Globe,
  image: Paintbrush,
  video: Video,
  sound: AudioLines,
  data: Package,
  person: UserRound,
  style: Palette,
  list: ListChecks,
  automationList: CalendarClock,
  automationCreate: CalendarPlus,
  automationUpdate: CalendarCog,
  automationDelete: CalendarX,
  automationTrigger: Play,
  emailAccounts: Inbox,
  emailRead: MailOpen,
  emailDraftCreate: MailPlus,
  emailDraftUpdate: PencilLine,
  emailSend: Send,
  mcp: PlugZap,
  memory: Brain,
  session: MessagesSquare,
  delegation: Network,
  todo: ListTodo,
  composioSearch: SearchCheck,
  composioSchema: FileJson,
  composioExecute: SquareFunction,
  composioConnections: Plug,
  default: Settings,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTextPart(value: unknown): value is { type: 'text'; text: string } {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string';
}

// Helper to safely convert message content to string
function contentToString(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (isTextPart(part) ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

const STUDIO_MEDIA_PATH_PREFIXES = [
  'studio/',
  'studio-gen-',
  'user-uploads/studio-references/',
  'presets/',
  'products/',
  'personas/',
  'styles/',
  'references/',
];

function isExternalOrApiMediaSrc(src: string): boolean {
  return (
    src.startsWith('/') ||
    src.startsWith('#') ||
    /^[a-z][a-z0-9+.-]*:/i.test(src)
  );
}

function isStudioMediaPath(src: string): boolean {
  const normalized = src.replace(/^\/+/, '');
  return STUDIO_MEDIA_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function resolveMarkdownImageSrc(src: string): string {
  const trimmed = src.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (isStudioMediaPath(trimmed)) {
    return toMediaUrl(trimmed.replace(/^\/+/, ''));
  }

  if (isFilePath(trimmed)) {
    return toWorkspaceMediaUrl(normalizeChatFilePath(trimmed));
  }

  if (isExternalOrApiMediaSrc(trimmed)) {
    return trimmed;
  }

  return trimmed;
}

function getRecentStudioImageMediaUrls(messages: ChatMessage[], messageIndex: number): string[] {
  const urls: string[] = [];

  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const previousMessage = messages[index];
    if (previousMessage.role === 'user') {
      break;
    }

    if (previousMessage.role === 'toolResult' && previousMessage.toolName === 'studio_generate_image') {
      urls.unshift(...extractStudioImageMediaUrls(previousMessage.content));
    }
  }

  return urls;
}

function getChatMessageTimestamp(message: ChatMessage | undefined): number | null {
  if (!message?.piMessage) {
    return null;
  }

  const timestamp = (message.piMessage as { timestamp?: unknown }).timestamp;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return timestamp;
  }

  if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getChatMessageDbId(message: ChatMessage | undefined): number | null {
  if (!message) {
    return null;
  }

  const parsed = parseInt(message.id, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getChatSessionCacheKey(agentId: string | null | undefined, sessionId: string): string {
  return `${agentId || CHAT_AGENT_ID}:${sessionId}`;
}

function isCacheableMessageSet(messages: ChatMessage[]): boolean {
  if (messages.length === 0) {
    return false;
  }

  if (messages.length === 1) {
    const [message] = messages;
    if (message.type === 'system' && (message.status === 'pending' || message.status === 'error')) {
      return false;
    }
  }

  return true;
}

function normalizeCachedSessionEntry(value: unknown): CachedChatSession | null {
  if (!isRecord(value) || value.version !== CHAT_SESSION_CACHE_VERSION) {
    return null;
  }

  const sessionValue = value.session;
  const messagesValue = value.messages;
  const cachedAt = typeof value.cachedAt === 'number' ? value.cachedAt : 0;

  if (!isRecord(sessionValue) || !Array.isArray(messagesValue) || !cachedAt) {
    return null;
  }

  const sessionId = typeof sessionValue.sessionId === 'string' ? sessionValue.sessionId : '';
  if (!sessionId) {
    return null;
  }

  const session: AISession = {
    id: typeof sessionValue.id === 'number' ? sessionValue.id : cachedAt,
    sessionId,
    title: typeof sessionValue.title === 'string' ? sessionValue.title : null,
    agentId: typeof sessionValue.agentId === 'string' ? sessionValue.agentId : CHAT_AGENT_ID,
    model: typeof sessionValue.model === 'string' ? sessionValue.model : DEFAULT_MODEL_ID,
    provider: typeof sessionValue.provider === 'string' ? sessionValue.provider : null,
    thinkingLevel: typeof sessionValue.thinkingLevel === 'string' ? sessionValue.thinkingLevel as PiThinkingLevel : null,
    createdAt: typeof sessionValue.createdAt === 'string' ? sessionValue.createdAt : new Date(cachedAt).toISOString(),
    engine: sessionValue.engine === 'legacy' ? 'legacy' : 'pi',
    lastMessageAt: typeof sessionValue.lastMessageAt === 'string' ? sessionValue.lastMessageAt : null,
    lastViewedAt: typeof sessionValue.lastViewedAt === 'string' ? sessionValue.lastViewedAt : null,
    hasUnread: typeof sessionValue.hasUnread === 'boolean' ? sessionValue.hasUnread : false,
    creator: isRecord(sessionValue.creator)
      ? {
          name: typeof sessionValue.creator.name === 'string' ? sessionValue.creator.name : null,
          email: typeof sessionValue.creator.email === 'string' ? sessionValue.creator.email : null,
        }
      : undefined,
  };

  return {
    version: CHAT_SESSION_CACHE_VERSION,
    session,
    messages: messagesValue as ChatMessage[],
    hasMoreBefore: typeof value.hasMoreBefore === 'boolean' ? value.hasMoreBefore : false,
    oldestTimestamp: typeof value.oldestTimestamp === 'number' ? value.oldestTimestamp : null,
    oldestMessageId: typeof value.oldestMessageId === 'number' ? value.oldestMessageId : null,
    cachedAt,
  };
}

function hydrateChatSessionCacheFromStorage() {
  if (hasHydratedChatSessionCache || typeof window === 'undefined') {
    return;
  }

  hasHydratedChatSessionCache = true;

  try {
    const stored = window.sessionStorage.getItem(CHAT_SESSION_MESSAGE_CACHE_STORAGE_KEY);
    if (!stored) {
      return;
    }

    const parsed = JSON.parse(stored) as unknown;
    if (!isRecord(parsed) || parsed.version !== CHAT_SESSION_CACHE_VERSION || !Array.isArray(parsed.entries)) {
      return;
    }

    for (const candidate of parsed.entries) {
      const entry = normalizeCachedSessionEntry(candidate);
      if (!entry || Date.now() - entry.cachedAt > CHAT_SESSION_MESSAGE_CACHE_TTL_MS) {
        continue;
      }
      inMemoryChatSessionCache.set(getChatSessionCacheKey(entry.session.agentId, entry.session.sessionId), entry);
    }
  } catch (error) {
    console.warn('[CanvasAgentChat] Failed to hydrate chat session cache', error);
  }
}

function trimCachedMessages(messages: ChatMessage[]): { messages: ChatMessage[]; droppedEarlierMessages: boolean } {
  if (messages.length <= CHAT_SESSION_MESSAGE_CACHE_MAX_MESSAGES) {
    return { messages, droppedEarlierMessages: false };
  }

  return {
    messages: messages.slice(-CHAT_SESSION_MESSAGE_CACHE_MAX_MESSAGES),
    droppedEarlierMessages: true,
  };
}

function buildCachedChatSessionEntry(params: {
  session: AISession;
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  oldestTimestamp: number | null;
  oldestMessageId: number | null;
}): CachedChatSession {
  const trimmed = trimCachedMessages(params.messages);
  const firstMessage = trimmed.messages[0];
  const trimmedOldestTimestamp = trimmed.droppedEarlierMessages
    ? getChatMessageTimestamp(firstMessage) ?? params.oldestTimestamp
    : params.oldestTimestamp;
  const trimmedOldestMessageId = trimmed.droppedEarlierMessages
    ? getChatMessageDbId(firstMessage) ?? params.oldestMessageId
    : params.oldestMessageId;

  return {
    version: CHAT_SESSION_CACHE_VERSION,
    session: {
      ...params.session,
      title: params.session.title ?? null,
    },
    messages: trimmed.messages,
    hasMoreBefore: params.hasMoreBefore || trimmed.droppedEarlierMessages,
    oldestTimestamp: trimmedOldestTimestamp,
    oldestMessageId: trimmedOldestMessageId,
    cachedAt: Date.now(),
  };
}

function rememberChatSessionCacheEntry(entry: CachedChatSession) {
  inMemoryChatSessionCache.set(getChatSessionCacheKey(entry.session.agentId, entry.session.sessionId), entry);
}

function persistChatSessionCache() {
  if (typeof window === 'undefined') {
    return;
  }

  const entries = Array.from(inMemoryChatSessionCache.values())
    .filter((entry) => Date.now() - entry.cachedAt <= CHAT_SESSION_MESSAGE_CACHE_TTL_MS)
    .sort((a, b) => b.cachedAt - a.cachedAt)
    .slice(0, CHAT_SESSION_MESSAGE_CACHE_MAX_ENTRIES);
  const store: ChatSessionCacheStore = {
    version: CHAT_SESSION_CACHE_VERSION,
    entries,
  };

  try {
    window.sessionStorage.setItem(CHAT_SESSION_MESSAGE_CACHE_STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    try {
      window.sessionStorage.setItem(
        CHAT_SESSION_MESSAGE_CACHE_STORAGE_KEY,
        JSON.stringify({ ...store, entries: entries.slice(0, 1) }),
      );
    } catch {
      window.sessionStorage.removeItem(CHAT_SESSION_MESSAGE_CACHE_STORAGE_KEY);
    }
    console.warn('[CanvasAgentChat] Failed to persist full chat session cache', error);
  }
}

function readCachedChatSession(agentId: string | null | undefined, sessionId: string): CachedChatSession | null {
  hydrateChatSessionCacheFromStorage();
  const cacheKey = getChatSessionCacheKey(agentId, sessionId);
  const entry = inMemoryChatSessionCache.get(cacheKey) || null;
  if (!entry || Date.now() - entry.cachedAt > CHAT_SESSION_MESSAGE_CACHE_TTL_MS) {
    if (entry) {
      inMemoryChatSessionCache.delete(cacheKey);
      persistChatSessionCache();
    }
    return null;
  }
  return entry;
}

function readLatestCachedChatSession(sessionId: string): CachedChatSession | null {
  hydrateChatSessionCacheFromStorage();
  const entries = Array.from(inMemoryChatSessionCache.values())
    .filter((entry) => entry.session.sessionId === sessionId && Date.now() - entry.cachedAt <= CHAT_SESSION_MESSAGE_CACHE_TTL_MS)
    .sort((a, b) => b.cachedAt - a.cachedAt);
  return entries[0] || null;
}

function removeCachedChatSession(sessionId: string, agentId?: string | null) {
  hydrateChatSessionCacheFromStorage();
  for (const [cacheKey, entry] of inMemoryChatSessionCache.entries()) {
    const matchesSession = entry.session.sessionId === sessionId;
    const matchesAgent = !agentId || entry.session.agentId === agentId;
    if (matchesSession && matchesAgent) {
      inMemoryChatSessionCache.delete(cacheKey);
    }
  }
  persistChatSessionCache();
}

function updateCachedChatSessionTitle(sessionId: string, title: string, agentId?: string | null) {
  hydrateChatSessionCacheFromStorage();
  let changed = false;
  for (const [cacheKey, entry] of inMemoryChatSessionCache.entries()) {
    const matchesSession = entry.session.sessionId === sessionId;
    const matchesAgent = !agentId || entry.session.agentId === agentId;
    if (!matchesSession || !matchesAgent) {
      continue;
    }
    inMemoryChatSessionCache.set(cacheKey, {
      ...entry,
      session: {
        ...entry.session,
        title,
      },
      cachedAt: Date.now(),
    });
    changed = true;
  }
  if (changed) {
    persistChatSessionCache();
  }
}

function formatRunDuration(startedAt: number | null, endedAt: number | null): string | null {
  if (!startedAt || !endedAt || endedAt <= startedAt) {
    return null;
  }

  const totalSeconds = Math.max(1, Math.round((endedAt - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0 && seconds > 0) {
    return `${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

function buildCollapsedRunMap(messages: ChatMessage[], isRuntimeBusy: boolean): Map<string, CollapsedRun> {
  const runs = new Map<string, CollapsedRun>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'user') {
      continue;
    }

    let runEnd = messages.length;
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      if (messages[cursor]?.role === 'user') {
        runEnd = cursor;
        break;
      }
    }

    if (isRuntimeBusy && runEnd === messages.length) {
      continue;
    }

    let finalAssistantIndex = -1;
    for (let cursor = runEnd - 1; cursor > index; cursor -= 1) {
      if (messages[cursor]?.role === 'assistant') {
        finalAssistantIndex = cursor;
        break;
      }
    }

    if (finalAssistantIndex === -1) {
      index = runEnd - 1;
      continue;
    }

    const steps = messages.slice(index + 1, finalAssistantIndex).filter((step) => (
      step.type !== 'compact_break' &&
      step.type !== 'composio_auth_required' &&
      (step.role === 'assistant' || step.role === 'toolResult' || step.role === 'system')
    ));

    if (steps.length > 0) {
      const finalAssistant = messages[finalAssistantIndex];
      runs.set(finalAssistant.id, {
        key: `${message.id}-${finalAssistant.id}`,
        finalAssistantId: finalAssistant.id,
        steps,
        startedAt: getChatMessageTimestamp(message),
        endedAt: getChatMessageTimestamp(finalAssistant) || getChatMessageTimestamp(steps[steps.length - 1]),
      });
    }

    index = runEnd - 1;
  }

  return runs;
}

function hasEarlierVisibleAssistantInRun(messages: ChatMessage[], messageIndex: number, hiddenMessageIds: Set<string>): boolean {
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const previousMessage = messages[index];
    if (previousMessage.role === 'user') {
      return false;
    }

    if (hiddenMessageIds.has(previousMessage.id) || previousMessage.role !== 'assistant') {
      continue;
    }

    if (previousMessage.status === 'sending' || contentToString(previousMessage.content).trim().length > 0) {
      return true;
    }
  }

  return false;
}

async function safeFetchJson<T = unknown>(res: Response): Promise<T | null> {
  if (!res.ok) {
    return null;
  }
  const text = await res.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function isImagePart(value: unknown): value is { type: 'image'; data: string; mimeType: string } {
  return isRecord(value) && value.type === 'image' && typeof value.data === 'string' && typeof value.mimeType === 'string';
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
    const category = resolveAttachmentCategory(attachment);
    const containerFilePath = attachment.filePath || buildAttachmentContainerPath(attachment);

    content.push({
      type: 'text',
      text: `--- Attachment: ${attachment.name} ---
containerFilePath: ${containerFilePath}
fileId: ${attachment.id}
mimeType: ${attachment.mimeType || 'application/octet-stream'}
category: ${category}
contentKind: ${attachment.contentKind}

[Agent-Hinweis: Verwende containerFilePath, wenn du die Datei per Tool lesen, kopieren, verschieben oder im Workspace organisieren sollst.]
--- Ende Attachment: ${attachment.name} ---`,
    });

    if (attachment.contentKind === 'image') {
      // Images: Use API URL (will be converted to Base64 by message-normalization.ts)
      // This keeps the existing image handling intact
      content.push({
        type: 'image',
        data: `/api/files/${encodeURIComponent(attachment.id)}`,
        mimeType: attachment.mimeType!,
      });
    }
  }

  return content;
}

function createAttachmentBlockRegex(): RegExp {
  return /(^|\n)--- Attachment: ([^\n]+) ---\n([\s\S]*?)\n--- Ende Attachment: [^\n]+ ---/g;
}

function getAttachmentBlockField(block: string, fieldName: string): string | undefined {
  const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`^${escapedFieldName}:\\s*(.*)$`, 'm'));
  return match?.[1]?.trim() || undefined;
}

function parseAttachmentBlocks(text: string): Attachment[] {
  const attachments: Attachment[] = [];

  for (const match of text.matchAll(createAttachmentBlockRegex())) {
    const name = match[2]?.trim();
    const block = match[3] || '';
    const id = getAttachmentBlockField(block, 'fileId');
    const rawContentKind = getAttachmentBlockField(block, 'contentKind');
    const contentKind = rawContentKind === 'image' || rawContentKind === 'document'
      ? rawContentKind
      : null;

    if (!name || !id || !contentKind) {
      continue;
    }

    attachments.push({
      name,
      id,
      contentKind,
      mimeType: getAttachmentBlockField(block, 'mimeType'),
      category: getAttachmentBlockField(block, 'category'),
      filePath: getAttachmentBlockField(block, 'containerFilePath'),
    });
  }

  return attachments;
}

function stripAttachmentBlocks(text: string): string {
  return text
    .replace(createAttachmentBlockRegex(), (_match, prefix: string) => prefix || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeAttachmentId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getImagePartAttachmentId(part: { data: string }): string {
  const rawId = part.data.startsWith('/api/files/')
    ? part.data.slice('/api/files/'.length)
    : part.data;
  return decodeAttachmentId(rawId);
}

function dedupeAttachments(attachments: Attachment[]): Attachment[] {
  const byKey = new Map<string, Attachment>();

  for (const attachment of attachments) {
    const key = `${attachment.contentKind}:${attachment.id || attachment.filePath || attachment.name}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, attachment);
      continue;
    }

    byKey.set(key, {
      ...existing,
      name: existing.name || attachment.name,
      mimeType: existing.mimeType || attachment.mimeType,
      category: existing.category || attachment.category,
      filePath: existing.filePath || attachment.filePath,
    });
  }

  return Array.from(byKey.values());
}

function normalizeMessageStart(text: string): string {
  return text.replace(/^\s+/, '');
}

function isAbortedAssistantPiMessage(piMessage?: AgentMessage | null): boolean {
  const candidate = piMessage as { role?: unknown; stopReason?: unknown } | null | undefined;
  return candidate?.role === 'assistant' && candidate.stopReason === 'aborted';
}

function getPiMessageContent(piMessage?: AgentMessage | null): string | unknown[] | undefined {
  if (!piMessage || !('content' in piMessage)) {
    return undefined;
  }

  return piMessage.content;
}

function getChatMessageRole(role: AgentMessage['role']): ChatMessage['role'] {
  if (role === 'user' || role === 'assistant' || role === 'toolResult') {
    return role;
  }

  return 'system';
}

function extractPiMessageText(piMessage?: AgentMessage | null, options?: { hideAttachmentMetadata?: boolean }): string {
  if (!piMessage || isCompactBreakMessage(piMessage) || isComposioAuthRequiredMessage(piMessage)) return '';
  const messageContent = getPiMessageContent(piMessage);
  if (!Array.isArray(messageContent)) {
    const text = typeof messageContent === 'string' ? messageContent : '';
    return options?.hideAttachmentMetadata ? stripAttachmentBlocks(text) : text;
  }

  const textContent = messageContent
    .map((part: unknown) => {
      if (isTextPart(part)) return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');

  if (textContent) {
    const visibleText = options?.hideAttachmentMetadata ? stripAttachmentBlocks(textContent) : textContent;
    return normalizeMessageStart(visibleText);
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

function isToolCallPart(part: unknown): part is PersistedToolCallPart {
  return (
    !!part &&
    typeof part === 'object' &&
    'type' in part &&
    part.type === 'toolCall' &&
    'id' in part &&
    typeof part.id === 'string' &&
    'name' in part &&
    typeof part.name === 'string'
  );
}

function extractImageAttachments(content: unknown, metadataAttachments: Attachment[] = []): Attachment[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const metadataById = new Map(metadataAttachments.map((attachment) => [attachment.id, attachment]));
  const attachments = content.reduce<Attachment[]>((result, part, index) => {
    if (isImagePart(part)) {
      const imageId = getImagePartAttachmentId(part);
      const metadata = metadataById.get(imageId);
      
      result.push({
        name: metadata?.name || `attachment-${index + 1}`,
        contentKind: 'image',
        id: imageId,
        mimeType: metadata?.mimeType || part.mimeType,
        category: metadata?.category || 'image',
        filePath: metadata?.filePath,
      });
    }
    return result;
  }, []);

  return attachments;
}

function extractMessageAttachments(content: unknown): Attachment[] | undefined {
  const text = contentToString(content);
  const metadataAttachments = parseAttachmentBlocks(text);
  const imageAttachments = extractImageAttachments(content, metadataAttachments);
  const attachments = dedupeAttachments([...metadataAttachments, ...imageAttachments]);
  return attachments.length > 0 ? attachments : undefined;
}

function getSessionDisplayLabel(sessionTitle: string | null, fallbackTitle: string): string {
  return getSessionDisplayTitle(sessionTitle, fallbackTitle);
}

function getAgentDisplayName(agentId: string | null | undefined): string {
  if (!agentId || agentId === DEFAULT_AGENT_ID) {
    return 'Canvas Agent';
  }
  return agentId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

type ChatHistorySessionRowProps = {
  session: AISession;
  isActive: boolean;
  agentProfile?: AgentProfile;
  agentName: string;
  newChatTitle: string;
  unreadResponseLabel: string;
  renameSessionLabel: string;
  deleteSessionLabel: string;
  onLoadSession: (session: AISession) => void | Promise<void>;
  onRenameSession: (session: AISession) => void | Promise<void>;
  onDeleteSession: (sessionId: string) => void | Promise<void>;
};

function ChatHistorySessionRow({
  session,
  isActive,
  agentProfile,
  agentName,
  newChatTitle,
  unreadResponseLabel,
  renameSessionLabel,
  deleteSessionLabel,
  onLoadSession,
  onRenameSession,
  onDeleteSession,
}: ChatHistorySessionRowProps) {
  const createdAtLabel = new Date(session.createdAt).toLocaleString();

  return (
    <div className={`group mb-1 flex w-full items-center p-2 transition-all ${
      isActive
        ? 'border border-primary/30 bg-primary/10'
        : 'border border-transparent bg-muted/30 hover:border-border hover:bg-accent'
    }`}>
      <button type="button" onClick={() => { void onLoadSession(session); }} className="min-w-0 flex-1 text-left flex items-start gap-2">
        <span className="relative mt-0.5 shrink-0">
          <AgentAvatar
            iconId={agentProfile?.iconId}
            className={`h-8 w-8 rounded-md ${
              isActive ? 'border-primary bg-primary/15 text-primary' : 'bg-background/80'
            }`}
            iconClassName="h-4 w-4"
          />
          {session.hasUnread && (
            <span
              data-testid="chat-history-unread-indicator"
              className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-background bg-blue-500"
              title={unreadResponseLabel}
              aria-label={unreadResponseLabel}
            />
          )}
        </span>
        <div className="min-w-0 flex-1 text-left">
          <div className={`truncate text-sm font-medium ${
            isActive ? 'text-primary' : 'text-foreground group-hover:text-primary'
          }`}>
            {getSessionDisplayTitle(session.title, newChatTitle)}
          </div>
          <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
            <span>{createdAtLabel}</span>
            <span>&bull;</span>
            <span className="inline-flex min-w-0 items-center gap-1">
              <AgentIcon iconId={agentProfile?.iconId} className="h-3 w-3 shrink-0" />
              <span className="truncate">{agentName}</span>
            </span>
            <span>&bull;</span>
            <span>{session.model}</span>
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={() => { void onRenameSession(session); }}
        className="ml-2 shrink-0 border border-transparent p-2 text-muted-foreground transition-all hover:border-border hover:bg-accent"
        title={renameSessionLabel}
      >
        <Pencil size={15} />
      </button>
      <button
        type="button"
        onClick={() => { void onDeleteSession(session.sessionId); }}
        className="ml-1 shrink-0 border border-transparent p-2 text-muted-foreground transition-all hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
        title={deleteSessionLabel}
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

type ChatHistoryPanelLabels = {
  chatHistory: string;
  searchSessions: string;
  filterAllAgents: string;
  filterUnreadOnly: string;
  filterAllSessions: string;
  markAllAsRead: string;
  backToChat: string;
  noRecentSessions: string;
  noSessionsFoundWithFilter: string;
  newChatTitle: string;
  unreadResponse: string;
  renameSession: string;
  deleteSession: string;
};

type ChatHistoryPanelProps = {
  variant: ChatHistoryPanelVariant;
  width?: number;
  history: AISession[];
  filteredHistory: ChatHistoryGroups;
  historySearchQuery: string;
  historyUnreadOnly: boolean;
  historyAgentFilter: string;
  historyAgentOptions: ChatHistoryAgentOption[];
  totalUnreadCount: number;
  currentSessionId: string | null;
  agentProfilesById: Map<string, AgentProfile>;
  groupLabels: Record<ChatHistoryGroup, string>;
  labels: ChatHistoryPanelLabels;
  onSearchQueryChange: (value: string) => void;
  onUnreadOnlyChange: (value: boolean) => void;
  onAgentFilterChange: (value: string) => void;
  onMarkAllAsRead: () => void | Promise<void>;
  onBackToChat?: () => void;
  onLoadSession: (session: AISession) => void | Promise<void>;
  onRenameSession: (session: AISession) => void | Promise<void>;
  onDeleteSession: (sessionId: string) => void | Promise<void>;
};

function ChatHistoryPanel({
  variant,
  width,
  history,
  filteredHistory,
  historySearchQuery,
  historyUnreadOnly,
  historyAgentFilter,
  historyAgentOptions,
  totalUnreadCount,
  currentSessionId,
  agentProfilesById,
  groupLabels,
  labels,
  onSearchQueryChange,
  onUnreadOnlyChange,
  onAgentFilterChange,
  onMarkAllAsRead,
  onBackToChat,
  onLoadSession,
  onRenameSession,
  onDeleteSession,
}: ChatHistoryPanelProps) {
  const isOverlay = variant === 'overlay';
  const hasActiveFilter = historySearchQuery.trim().length > 0 || historyUnreadOnly || historyAgentFilter !== 'all';
  const hasFilteredSessions = CHAT_HISTORY_GROUP_ORDER.some((group) => filteredHistory[group].length > 0);

  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden',
        isOverlay
          ? 'absolute inset-0 z-20 bg-background'
          : 'flex-shrink-0 border-r border-border bg-card',
      )}
      style={!isOverlay && width ? { width: `${width}px` } : undefined}
    >
      <div className="shrink-0 space-y-2 border-b border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <History size={14} className="shrink-0 text-muted-foreground" />
            <span className="truncate text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              {labels.chatHistory}
            </span>
          </div>
          {isOverlay && onBackToChat ? (
            <button
              type="button"
              onClick={onBackToChat}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronLeft size={12} />
              {labels.backToChat}
            </button>
          ) : null}
        </div>

        <div className="relative">
          <input
            type="text"
            value={historySearchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder={labels.searchSessions}
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 pl-8 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
        </div>

        <div className="flex gap-1 overflow-x-auto pb-1">
          <button
            type="button"
            onClick={() => onAgentFilterChange('all')}
            className={`shrink-0 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${
              historyAgentFilter === 'all'
                ? 'border-primary/30 bg-primary/15 text-primary'
                : 'border-border bg-muted/30 text-muted-foreground'
            }`}
          >
            {labels.filterAllAgents}
          </button>
          {historyAgentOptions.map((agent) => (
            <button
              key={agent.agentId}
              type="button"
              onClick={() => onAgentFilterChange(agent.agentId)}
              className={`shrink-0 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${
                historyAgentFilter === agent.agentId
                  ? 'border-primary/30 bg-primary/15 text-primary'
                  : 'border-border bg-muted/30 text-muted-foreground'
              }`}
              title={agent.agentId}
            >
              <AgentIcon iconId={agent.iconId} className="mr-1 inline h-3 w-3 align-[-2px]" />
              {agent.name}
              {agent.count > 0 ? ` ${agent.count}` : ''}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onUnreadOnlyChange(!historyUnreadOnly)}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${
              historyUnreadOnly
                ? 'border-primary/30 bg-primary/15 text-primary'
                : 'border-border bg-muted/30 text-muted-foreground'
            }`}
          >
            {historyUnreadOnly ? <Eye size={12} /> : <EyeOff size={12} />}
            {historyUnreadOnly ? labels.filterUnreadOnly : labels.filterAllSessions}
          </button>
          {totalUnreadCount > 0 ? (
            <button
              type="button"
              onClick={() => { void onMarkAllAsRead(); }}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/15 hover:text-primary"
            >
              <CheckCheck size={12} />
              {labels.markAllAsRead}
            </button>
          ) : null}
        </div>
      </div>

      <div className={cn('flex-1 overflow-y-auto p-2', isOverlay ? 'pb-[calc(env(safe-area-inset-bottom)+0.75rem)]' : null)}>
        {history.length === 0 ? (
          <div className="p-8 text-center text-sm italic text-muted-foreground">
            {labels.noRecentSessions}
          </div>
        ) : null}

        {CHAT_HISTORY_GROUP_ORDER.map((group) => {
          const sessions = filteredHistory[group];
          if (sessions.length === 0) return null;

          return (
            <div key={group} className="mb-4">
              <div className="mb-2 px-2 text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                {groupLabels[group]} ({sessions.length})
              </div>
              {sessions.map((session) => {
                const isActive = currentSessionId === session.sessionId;
                const sessionAgentId = session.agentId || CHAT_AGENT_ID;
                const sessionAgentProfile = agentProfilesById.get(sessionAgentId);
                const sessionAgentName = sessionAgentProfile?.name || getAgentDisplayName(session.agentId);

                return (
                  <ChatHistorySessionRow
                    key={session.id}
                    session={session}
                    isActive={isActive}
                    agentProfile={sessionAgentProfile}
                    agentName={sessionAgentName}
                    newChatTitle={labels.newChatTitle}
                    unreadResponseLabel={labels.unreadResponse}
                    renameSessionLabel={labels.renameSession}
                    deleteSessionLabel={labels.deleteSession}
                    onLoadSession={onLoadSession}
                    onRenameSession={onRenameSession}
                    onDeleteSession={onDeleteSession}
                  />
                );
              })}
            </div>
          );
        })}

        {history.length > 0 && !hasFilteredSessions ? (
          <div className="p-8 text-center text-sm italic text-muted-foreground">
            {hasActiveFilter ? labels.noSessionsFoundWithFilter : labels.noRecentSessions}
          </div>
        ) : null}
      </div>
    </div>
  );
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

function FileLink({ href, children }: { href: string; children: React.ReactNode }) {
  const fileStore = useFileStore();
  const fileTree = fileStore.fileTree;
  const pathname = useLocalePathname();
  const locale = useLocale();
  const [isValid, setIsValid] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    const normalizedPath = normalizeChatFilePath(href);
    validateFileExists(normalizedPath, fileTree).then((exists) => {
      setIsValid(exists);
    });
  }, [href, fileTree]);

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const normalizedPath = normalizeChatFilePath(href);

    if (!normalizedPath) return;

    if (pathname.includes('/chat')) {
      const notebookPath = getPathname({
        locale,
        href: { pathname: '/notebook', query: { path: normalizedPath } },
      });
      window.open(notebookPath, 'canvas-notebook');
      return;
    }

    void fileStore.revealAndLoadFile(normalizedPath);
  };

  const isNotFound = isValid === false;

  return (
    <button
      onClick={handleClick}
      className={`underline underline-offset-2 transition-colors ${
        isNotFound
          ? 'text-muted-foreground cursor-not-allowed'
          : 'cursor-pointer text-primary hover:text-primary/80'
      }`}
      title={isNotFound ? `File not found: ${href}` : `Open ${href}`}
    >
      {children}
    </button>
  );
}

function MarkdownMessage({
  content,
  variant,
  onMediaClick,
}: {
  content: string;
  variant: 'user' | 'assistant' | 'tool';
  onMediaClick?: (mediaUrl: string) => void;
}) {
  const sharedClasses =
    'min-w-0 max-w-full break-words text-sm leading-relaxed [&_p]:my-0 [&_p+p]:mt-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mt-1 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_hr]:my-4 [&_hr]:border-border/60 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_code]:rounded-sm [&_code]:px-1.5 [&_code]:py-0.5 [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold';
  const toneClasses =
    variant === 'user'
      ? '[&_blockquote]:border-primary-foreground/40 [&_pre]:border-primary-foreground/20 [&_pre]:bg-primary-foreground/10 [&_code]:bg-primary-foreground/15'
      : '[&_blockquote]:border-border/80 [&_pre]:border-border [&_pre]:bg-background/80 [&_code]:bg-background/80';
  const tableBorderClasses =
    variant === 'user'
      ? 'border-primary-foreground/20'
      : 'border-border';
  const tableHeaderClasses =
    variant === 'user'
      ? 'bg-primary-foreground/10 text-primary-foreground'
      : 'bg-background/70 text-foreground';
  const tableCellClasses =
    variant === 'user'
      ? 'border-primary-foreground/20'
      : 'border-border';

  const extractColorCode = (props: Record<string, unknown>): string | null => {
    const colorCode = props['data-color-code'] ?? props.dataColorCode ?? props.datacolorcode;
    return typeof colorCode === 'string' ? colorCode : null;
  };

  const components = {
    span: ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { dataColorCode?: string }) => {
      const colorCode = extractColorCode(props as Record<string, unknown>);
      if (colorCode) {
        return <ColorSwatch color={colorCode} />;
      }
      return <span className={className} {...props} />;
    },
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      if (href && isFilePath(href)) {
        return <FileLink href={href}>{children}</FileLink>;
      }
      return (
        <a 
          href={href} 
          target="_blank" 
          rel="noopener noreferrer"
          className="underline underline-offset-2"
        >
          {children}
        </a>
      );
    },
    table: ({ children }: React.TableHTMLAttributes<HTMLTableElement>) => (
      <div className={`my-3 max-w-full overflow-x-auto rounded-md border ${tableBorderClasses}`}>
        <table className="w-max min-w-full border-collapse text-left text-sm">
          {children}
        </table>
      </div>
    ),
    th: ({ children, className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
      <th
        className={cn(
          'whitespace-nowrap border px-2.5 py-1.5 align-top text-xs font-semibold',
          tableCellClasses,
          tableHeaderClasses,
          className,
        )}
        {...props}
      >
        {children}
      </th>
    ),
    td: ({ children, className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
      <td
        className={cn(
          'whitespace-nowrap border px-2.5 py-1.5 align-top',
          tableCellClasses,
          className,
        )}
        {...props}
      >
        {children}
      </td>
    ),
    img: ({ src, alt }: React.ImgHTMLAttributes<HTMLImageElement>) => {
      if (typeof src !== 'string' || !src) return null;
      const resolvedSrc = resolveMarkdownImageSrc(src);
      const clickable = Boolean(onMediaClick);
      return (
        <button
          type="button"
          className={`my-3 block overflow-hidden rounded-2xl border border-border/70 bg-background/70 ${clickable ? 'cursor-pointer transition hover:border-primary/40' : 'cursor-default'}`}
          onClick={() => { if (onMediaClick) onMediaClick(resolvedSrc); }}
          disabled={!clickable}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={resolvedSrc} alt={alt || ''} className="max-h-[320px] w-auto max-w-full object-contain" />
        </button>
      );
    },
    code: ({ className, children, ...props }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) => {
      const codeString = String(children).replace(/\n$/, '');
      
      // First check if it's a color code (before language detection)
      // This handles both inline code and code blocks that might have hljs classes
      const cleanedCode = codeString.replace(/\n$/, '').trim();
      if (isColorCode(cleanedCode)) {
        return <ColorSwatch color={cleanedCode} />;
      }
      
      const lang = className?.replace('language-', '').replace('hljs', '').trim();
      if (lang === 'mermaid') {
        return <MermaidDiagram code={codeString} />;
      }
      
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
    pre: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => {
      const child = React.Children.toArray(children)[0];
      if (React.isValidElement(child) && child.type === 'code') {
        const codeProps = child.props as { className?: string; children?: React.ReactNode };
        const lang = codeProps.className?.replace('language-', '').replace('hljs', '').trim();
        if (lang === 'mermaid') {
          return <>{children}</>;
        }
      }
      return <pre {...props}>{children}</pre>;
    },
  };

  return (
    <div className={`${sharedClasses} ${toneClasses}`}>
      <ReactMarkdown 
        remarkPlugins={[remarkGfm]} 
        rehypePlugins={[rehypeInlineColorSwatch, rehypeHighlight]}
        components={components}
      >
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

function ToolCallPill({
  message,
  onMediaClick,
}: {
  message: ChatMessage;
  onMediaClick?: (mediaUrl: string) => void;
}) {
  const t = useTranslations('chat');
  const locale = useLocale();
  const isMobile = useIsMobile();
  const [copied, setCopied] = useState(false);
  const display = getToolDisplayInfo(message.toolName, locale);
  const Icon = TOOL_TONE_ICONS[display.tone] || TOOL_TONE_ICONS.default;
  const isRunning = message.status === 'sending' || message.status === 'aborting';
  const isError = message.status === 'error';
  const bodyContent =
    contentToString(message.content) ||
    (isRunning ? t('runningTool') : t('noOutputYet'));
  const toolStatusLabel = getToolStatusLabel(message, t);

  const copyDetails = async () => {
    const sections = [
      message.toolName ? `${t('toolTechnicalName')}: ${message.toolName}` : null,
      message.toolArgs ? `${t('toolInput')}\n${message.toolArgs}` : null,
      bodyContent ? `${t('toolOutput')}\n${bodyContent}` : null,
    ].filter(Boolean);

    try {
      await navigator.clipboard.writeText(sections.join('\n\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  const renderTrigger = () => (
    <button
      type="button"
      className={`group inline-flex max-w-[90%] items-center gap-2 rounded-full border px-2.5 py-1 text-xs shadow-sm transition-colors ${
        isError
          ? 'border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15'
          : isRunning
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300'
            : 'border-border/70 bg-background/85 text-muted-foreground hover:border-primary/30 hover:bg-accent hover:text-foreground'
      }`}
      aria-label={`${display.label}: ${toolStatusLabel}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate font-medium">{display.label}</span>
      {isRunning ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      ) : isError ? (
        <XCircle className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" />
      )}
    </button>
  );

  const detailsPanel = (
    <>
      <div className="shrink-0 border-b border-border/70 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              {isMobile ? (
                <DialogTitle className="truncate text-sm font-semibold leading-normal">{display.label}</DialogTitle>
              ) : (
                <span className="truncate">{display.label}</span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              {isMobile ? (
                <DialogDescription asChild>
                  <span>{toolStatusLabel}</span>
                </DialogDescription>
              ) : (
                <span>{toolStatusLabel}</span>
              )}
              {message.toolName ? <span className="font-mono">{message.toolName}</span> : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={() => void copyDetails()}>
              <Copy className="mr-1 h-3.5 w-3.5" />
              {copied ? t('copied') : t('copy')}
            </Button>
            {isMobile ? (
              <DialogClose asChild>
                <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-xs">
                  <X className="mr-1 h-3.5 w-3.5" />
                  {t('close')}
                </Button>
              </DialogClose>
            ) : null}
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
        {message.toolArgs ? (
          <div className="rounded-md border border-border/70 bg-muted/35 p-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t('toolInput')}</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/85">{message.toolArgs}</pre>
          </div>
        ) : null}
        <div className="rounded-md border border-border/70 bg-background p-2">
          <div className="mb-1 border-b border-border/70 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t('toolOutput')}</div>
          <MarkdownMessage content={bodyContent} variant="tool" onMediaClick={onMediaClick} />
        </div>
      </div>
    </>
  );

  return (
    <div key={message.id} data-testid="chat-tool-subtle" className="flex justify-start py-0.5">
      {isMobile ? (
        <Dialog>
          <DialogTrigger asChild>{renderTrigger()}</DialogTrigger>
          <DialogContent
            layout="viewport"
            showCloseButton={false}
            className="bg-background"
          >
            {detailsPanel}
          </DialogContent>
        </Dialog>
      ) : (
        <Popover>
          <PopoverTrigger asChild>{renderTrigger()}</PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            collisionPadding={16}
            sticky="always"
            className="flex max-h-[var(--radix-popover-content-available-height)] w-[min(calc(100vw-2rem),560px)] flex-col overflow-hidden p-0"
          >
            {detailsPanel}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

function RunStepItem({
  message,
  toolVerbosity,
  onMediaClick,
}: {
  message: ChatMessage;
  toolVerbosity: ToolVerbosity;
  onMediaClick?: (mediaUrl: string) => void;
}) {
  const t = useTranslations('chat');
  const locale = useLocale();
  const isTool = message.role === 'toolResult';
  const isAssistant = message.role === 'assistant';
  const display = isTool ? getToolDisplayInfo(message.toolName, locale) : null;
  const Icon = display ? (TOOL_TONE_ICONS[display.tone] || TOOL_TONE_ICONS.default) : MessageStepIcon;
  const title = isTool ? (display?.label || message.toolName || t('tool')) : isAssistant ? t('assistant') : t('system');
  const bodyContent =
    contentToString(message.content) ||
    (message.status === 'sending' ? (isTool ? t('runningTool') : t('agentWorking')) : '');
  const preview = message.previewText || truncatePreview(bodyContent || t('noOutputYet'));
  const isMinimal = toolVerbosity === 'minimal';

  if (isTool && toolVerbosity !== 'minimal') {
    return (
      <div data-testid="chat-run-step" className="min-w-0 overflow-hidden">
        <ToolCallPill message={message} onMediaClick={onMediaClick} />
      </div>
    );
  }

  return (
    <div
      data-testid="chat-run-step"
      className={cn(
        'min-w-0 overflow-hidden border border-border/70 bg-background/70',
        isMinimal ? 'px-2 py-1.5' : 'p-2',
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-xs font-medium text-foreground">{title}</span>
          </div>
          {!isMinimal ? (
            <div className="mt-0.5 line-clamp-2 min-w-0 break-words text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              {preview}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MessageStepIcon({ className }: { className?: string }) {
  return <Sparkles className={className} />;
}

function AgentRunDisclosure({
  run,
  expanded,
  onToggle,
  toolVerbosity,
  onMediaClick,
}: {
  run: CollapsedRun;
  expanded: boolean;
  onToggle: () => void;
  toolVerbosity: ToolVerbosity;
  onMediaClick?: (mediaUrl: string) => void;
}) {
  const t = useTranslations('chat');
  const duration = formatRunDuration(run.startedAt, run.endedAt);
  const summary = duration
    ? t('workedForWithSteps', { duration, count: run.steps.length })
    : t('workedSteps', { count: run.steps.length });

  return (
    <div data-testid="chat-run-disclosure" className="flex justify-start">
      <div className="min-w-0 w-full max-w-[90%]">
        <button
          type="button"
          data-testid="chat-run-disclosure-toggle"
          onClick={onToggle}
          className="group flex min-w-0 w-full items-start gap-2 border-t border-border/70 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <span className="min-w-0 break-words leading-relaxed [overflow-wrap:anywhere]">{summary}</span>
        </button>

        {expanded ? (
          <div data-testid="chat-run-steps" className="mb-2 min-w-0 space-y-2 pl-4 sm:pl-6">
            {run.steps.map((step) => (
              <RunStepItem
                key={step.id}
                message={step}
                toolVerbosity={toolVerbosity}
                onMediaClick={onMediaClick}
              />
            ))}
          </div>
        ) : null}
      </div>
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
      className={cn(
        'group flex h-full w-full min-w-0 flex-col items-start overflow-hidden border border-border bg-background/90 text-left text-foreground transition-colors hover:border-primary/40 hover:bg-accent',
        compact ? 'gap-2 p-2.5' : 'gap-3 p-4',
      )}
    >
      <span className="inline-flex max-w-full min-w-0 items-center gap-2 text-[11px] font-semibold uppercase text-muted-foreground">
        <Icon className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 truncate">{t('example')}</span>
      </span>
      <div className="min-w-0 space-y-1">
        <div className={`${compact ? 'text-sm' : 'text-base'} line-clamp-2 min-w-0 break-words font-semibold [overflow-wrap:anywhere]`}>
          {prompt.title}
        </div>
        <p className={`${compact ? 'line-clamp-2 text-xs' : 'line-clamp-3 text-sm'} min-w-0 break-words leading-relaxed text-muted-foreground [overflow-wrap:anywhere]`}>
          {prompt.description}
        </p>
      </div>
    </button>
  );
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
  const HISTORY_BREAKPOINT = 650;
  const effectiveContainerWidth = chatContainerWidth ?? measuredWidth;
  const shouldShowHistoryAsOverlay = isMobile || effectiveContainerWidth < HISTORY_BREAKPOINT;

  useEffect(() => {
    if (chatContainerWidth !== undefined) return;
    const updateWidth = () => {
      if (containerRef.current) {
        setMeasuredWidth(containerRef.current.clientWidth);
      }
    };
    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, [chatContainerWidth]);
  
  // WebSocket integration
  const { connected: wsConnected, error: wsError, subscribe, unsubscribe, request: wsRequest } = useWebSocket({
    autoConnect: false,
  });
  
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [oldestTimestamp, setOldestTimestamp] = useState<number | null>(null);
  const [oldestMessageId, setOldestMessageId] = useState<number | null>(null);
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
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [imagePreprocessFiles, setImagePreprocessFiles] = useState<import('@/app/components/shared/ImagePreprocessDialog').PreprocessFileInfo[] | null>(null);
  const [imagePreprocessPendingFiles, setImagePreprocessPendingFiles] = useState<File[]>([]);
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
  const subscribedSessionAckRef = useRef<string | null>(null);
  const subscribedSessionRequestRef = useRef<{ sessionId: string; promise: Promise<void> } | null>(null);
  const sessionListRequestRef = useRef<Promise<AISession[]> | null>(null);
  const loadSessionRequestIdRef = useRef(0);
  const loadSessionAbortRef = useRef<AbortController | null>(null);
  const skipNextSessionStatusRefreshRef = useRef<string | null>(null);
  const cachePersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLoadedSessionListRef = useRef(false);
  const inputHistoryCursorRef = useRef<number | null>(null);
  const inputHistoryDraftRef = useRef('');
  const historyRef = useRef<AISession[]>([]);

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
    });

    rememberChatSessionCacheEntry(entry);

    if (cachePersistTimerRef.current) {
      clearTimeout(cachePersistTimerRef.current);
    }
    cachePersistTimerRef.current = setTimeout(() => {
      cachePersistTimerRef.current = null;
      persistChatSessionCache();
    }, 300);
  }, [activeModel, activeProvider, activeThinkingLevel, hasMoreBefore, messages, oldestMessageId, oldestTimestamp, selectedAgentId, sessionId, sessionTitle]);

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
      const params = new URLSearchParams({ agentId: 'all' });
      const res = await fetch(`/api/sessions?${params.toString()}`);
      const data = await safeFetchJson<{ success: boolean; sessions?: AISession[] }>(res);
      if (!data?.success) {
        return [];
      }
      const sessions = applyResolvedTitles(data.sessions || []);
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
        refreshSavedMessagesRef.current?.(sessionId);
        void fetch('/api/sessions', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: sessionAgentIdRef.current || selectedAgentId, sessionId, markAsRead: true }),
        }).catch((error) => {
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
  }, [loadSessionList, resolveSessionTitle, selectedAgentId]);

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

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const scrollContent = scrollContentRef.current;
    if (!scrollContainer || !scrollContent) return;

    const resizeObserver = new ResizeObserver(() => {
      if (!isAtBottomRef.current) return;
      scrollToBottom('auto');
    });

    resizeObserver.observe(scrollContent);
    return () => resizeObserver.disconnect();
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
        void fetch('/api/sessions', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: sessionAgentIdRef.current || selectedAgentId, sessionId: currentVisibleSessionId, markAsRead: true }),
        }).catch((error) => {
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
      const res = await fetch('/api/sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: selectedAgentId, markAllAsRead: true }),
      });
      const data = await safeFetchJson<{ success: boolean; lastViewedAt?: string }>(res);
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

  const setRuntimeStatusWithReconciliation = useCallback((status: RuntimeStatus) => {
    setRuntimeStatus(status);
    reconcileQueuedMessages(status);
  }, [reconcileQueuedMessages]);

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

    const createSessionResponse = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId,
        ...(requestedTitle ? { title: requestedTitle } : {}),
        ...(requestedModel ? { model: requestedModel } : {}),
        ...(requestedThinkingLevel ? { thinkingLevel: requestedThinkingLevel } : {}),
      }),
    });

    const createSessionPayload = await createSessionResponse.json().catch(() => null);
    if (!createSessionResponse.ok || !createSessionPayload?.success || !createSessionPayload?.session?.sessionId) {
      throw new Error(createSessionPayload?.error || `Failed to create session (HTTP ${createSessionResponse.status})`);
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

  // Helper function to format tool arguments
  const formatToolArgs = useCallback((args: unknown): string => {
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
  }, []);

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
      refreshSavedMessagesRef.current?.(currentSessionId);
      return;
    }

    if (event.type === 'message_start' && event.message?.role === 'user') {
      upsertUserMessageFromPiMessage(event.message);
      return;
    }

    if (event.type === 'message_start' && event.message?.role === 'assistant') {
      streamingContentRef.current = '';
      lastFlushedStreamingContentRef.current = '';
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
      if (event.assistantMessageEvent?.type === 'text_delta') {
        streamingContentRef.current += event.assistantMessageEvent.delta || '';
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
  }, [appendCompactionBreak, appendSystemMessage, createAssistantBubble, formatToolArgs, scrollToBottom, setMessages, setRuntimeStatusWithReconciliation, syncPiMessage, t, upsertToolMessage, upsertUserMessageFromPiMessage]);

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
  }, [activeModel, agentConfig, appendOptimisticUserMessage, attachments, buildRequestContext, createAssistantBubble, currentFile, ensureSession, ensureSessionSubscribed, input, postControl, resetInputHistoryNavigation, runtimePhase, selectedAgentId, showHistory, isMobile, setOptimisticRuntimePhase, setRuntimeStatusWithReconciliation, shouldShowHistoryAsOverlay, scanForImageReferences, t, wsRequest]);

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
    setInput('');
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
  }, [agentConfig, resetInputHistoryNavigation, resetStreamConnection, selectedAgentId, isMobile, shouldShowHistoryAsOverlay]);

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
    const imageAttachments = extractImageAttachments(rawMessageContent);
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
  }, [formatToolArgs, t]);

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

    return rawMessages.map((rawMessage) => mapRawMessage(rawMessage, toolCallsById));
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
        const response = await fetch(
          `/api/sessions/messages?agentId=${encodeURIComponent(requestAgentId)}&sessionId=${encodeURIComponent(targetSessionId)}&limit=50`,
          { cache: 'no-store', credentials: 'include' },
        );
        const payload = await safeFetchJson<{
          success: boolean;
          messages?: PersistedChatMessage[];
          hasMoreBefore?: boolean;
          oldestTimestamp?: number | null;
          oldestMessageId?: number | null;
        }>(response);

        if (
          sessionIdRef.current !== targetSessionId ||
          !payload?.success ||
          !Array.isArray(payload.messages)
        ) {
          return;
        }

        const nextMessages = mapRawMessages(payload.messages);
        setMessages(nextMessages);
        hydrateMessageRefsFromMessages(nextMessages);
        setHasMoreBefore(typeof payload.hasMoreBefore === 'boolean' ? payload.hasMoreBefore : payload.messages.length >= 50);
        setOldestTimestamp(payload.oldestTimestamp ?? null);
        setOldestMessageId(payload.oldestMessageId ?? null);
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
      void fetch('/api/sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: sessionAgentId, sessionId: session.sessionId, markAsRead: true }),
      })
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

      const messagesResponse = await fetch(
        `/api/sessions/messages?agentId=${encodeURIComponent(sessionAgentId)}&sessionId=${encodeURIComponent(session.sessionId)}&limit=50`,
        { signal: abortController.signal },
      );

      if (
        abortController.signal.aborted ||
        loadSessionRequestIdRef.current !== requestId ||
        sessionIdRef.current !== session.sessionId
      ) {
        return;
      }

      const messagesPayload = await safeFetchJson<{
        success: boolean;
        messages?: PersistedChatMessage[];
        hasMoreBefore?: boolean;
        oldestTimestamp?: number | null;
        oldestMessageId?: number | null;
      }>(messagesResponse);

      if (
        abortController.signal.aborted ||
        loadSessionRequestIdRef.current !== requestId ||
        sessionIdRef.current !== session.sessionId
      ) {
        return;
      }

      if (messagesPayload?.success && Array.isArray(messagesPayload.messages)) {
        const nextMessages = mapRawMessages(messagesPayload.messages);
        if (nextMessages.length > 0 || !hasCachedMessages) {
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
    if (!currentSessionId || isLoadingOlder || !hasMoreBefore || oldestTimestamp === null) return;

    setIsLoadingOlder(true);
    const agentId = sessionAgentIdRef.current || selectedAgentId;

    const scrollContainer = scrollContainerRef.current;
    const previousScrollHeight = scrollContainer?.scrollHeight ?? 0;

    try {
      const response = await fetch(
        `/api/sessions/messages?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(currentSessionId)}&before=${oldestTimestamp}${oldestMessageId !== null ? `&beforeId=${oldestMessageId}` : ''}&limit=50`,
      );
      const payload = await response.json();

      if (payload.success && payload.messages) {
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
  }, [hasMoreBefore, isLoadingOlder, mapRawMessages, oldestMessageId, oldestTimestamp, selectedAgentId]);

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
      const params = new URLSearchParams({ agentId: targetSession?.agentId || selectedAgentId, sessionId: id });
      const res = await fetch(`/api/sessions?${params.toString()}`, { method: 'DELETE' });
      const data = await safeFetchJson<{ success: boolean }>(res);
      if (data?.success) {
        removeCachedChatSession(id, targetSession?.agentId || selectedAgentId);
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
      const res = await fetch('/api/sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: session.agentId || selectedAgentId, sessionId: session.sessionId, title: nextTitle.trim() }),
      });
      const data = await safeFetchJson<{ success: boolean }>(res);
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
    setIsUploading(true);
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
      const data = await safeFetchJson<{ success: boolean; error?: string; errors?: string[]; files?: { id: string; originalName: string; mimeType: string; category: string }[] }>(res);
      
      if (!data || !data.success) {
        throw new Error(data?.error ?? 'Upload failed');
      }
      
      // API now returns array of files
      const uploadedFiles = data.files || [];
      
      const attachments: Attachment[] = uploadedFiles.map((uploadedFile: {
        id: string;
        originalName: string;
        mimeType: string;
        category: string;
      }) => {
        const isImage = uploadedFile.category === 'image';
        return {
          name: uploadedFile.originalName,
          contentKind: isImage ? 'image' : 'document',
          id: uploadedFile.id,
          mimeType: uploadedFile.mimeType,
          category: uploadedFile.category,
        };
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
      setIsUploading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/preserve-manual-memoization
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

  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const handleImagePreprocessConfirm = useCallback(async (convertParams: (ConvertParams | null)[]) => {
    await handleFileUploadMultiple(imagePreprocessPendingFiles, convertParams);
    setImagePreprocessFiles(null);
    setImagePreprocessPendingFiles([]);
  }, [handleFileUploadMultiple, imagePreprocessPendingFiles]);

  // eslint-disable-next-line react-hooks/preserve-manual-memoization
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

  const handleFileUpload = useCallback(async (file: File) => {
    await preprocessAndUpload([file]);
  }, [preprocessAndUpload]);

  const onFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length > 0) preprocessAndUpload(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [preprocessAndUpload]);

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
        return true;
      }
      nextCursor = currentCursor >= userMessageHistory.length - 1 ? null : currentCursor + 1;
    }

    inputHistoryCursorRef.current = nextCursor;
    applyInputHistoryValue(nextCursor === null ? inputHistoryDraftRef.current : userMessageHistory[nextCursor]);
    return true;
  }, [applyInputHistoryValue, input, userMessageHistory]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
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
      if (navigateInputHistory(e.key === 'ArrowUp' ? 'older' : 'newer')) {
        e.preventDefault();
      }
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }, [activeReferenceMatch, closeReferencePicker, handleReferenceSelect, handleSend, navigateInputHistory, referencePickerItems, selectedReferenceIndex, togglePlanningMode]);

  useEffect(() => {
    let cancelled = false;

    const fetchConfig = async () => {
      try {
        setAgentConfig(null);
        setIsAgentConfigLoading(true);
        const params = new URLSearchParams({ agentId: selectedAgentId, readiness: 'false' });
        const res = await fetch(`/api/agents/config?${params.toString()}`);
        const data = await safeFetchJson<{ success: boolean; data?: AgentConfig }>(res);
        if (!cancelled && data?.success) {
          setAgentConfig(data.data ?? null);
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
        const res = await fetch('/api/agents', { cache: 'no-store' });
        const data = await safeFetchJson<{ success: boolean; data?: { agents?: AgentProfile[] } }>(res);
        if (data?.success) {
          setAvailableAgents(data.data?.agents || []);
        }
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
  const collapsedRunMap = useMemo(() => buildCollapsedRunMap(messages, isRuntimeBusy), [messages, isRuntimeBusy]);
  const hiddenStepIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of collapsedRunMap.values()) {
      for (const step of run.steps) {
        ids.add(step.id);
      }
    }
    return ids;
  }, [collapsedRunMap]);
  const contextCompactLabel = runtimeStatus
    ? t('contextCompactLabel', {
        percent: runtimeStatus.contextUsagePercent,
        available: formatContextTokens(runtimeStatus.availableHistoryTokens),
      })
    : t('noSessionYet');
  const contextDetailedLabel = runtimeStatus
    ? t('contextLabel', {
        percent: runtimeStatus.contextUsagePercent,
        used: formatContextTokens(runtimeStatus.estimatedHistoryTokens),
        available: formatContextTokens(runtimeStatus.availableHistoryTokens),
        window: formatContextTokens(runtimeStatus.contextWindow),
      })
    : t('noSessionYet');
  const contextTooltip = runtimeStatus
    ? t('contextTooltip', {
        used: formatContextTokens(runtimeStatus.estimatedHistoryTokens),
        available: formatContextTokens(runtimeStatus.availableHistoryTokens),
        window: formatContextTokens(runtimeStatus.contextWindow),
        reserved: formatContextTokens(Math.max(0, runtimeStatus.contextWindow - runtimeStatus.availableHistoryTokens)),
      })
    : t('noSessionYet');
  const contextProgressPercent = Math.min(100, Math.max(0, runtimeStatus?.contextUsagePercent ?? 0));
  const sessionDisplayLabel = getSessionDisplayLabel(sessionTitle, t('newChatTitle'));
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
    : !hasComposerContent || isWebSocketUnavailable || !isModelConfigured;
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
    const byId = new Map<string, { agentId: string; name: string; iconId?: string; count: number }>();
    for (const agent of availableAgents) {
      byId.set(agent.agentId, { agentId: agent.agentId, name: agent.name, iconId: agent.iconId, count: 0 });
    }
    for (const session of history) {
      const agentId = session.agentId || CHAT_AGENT_ID;
      const existing = byId.get(agentId);
      byId.set(agentId, {
        agentId,
        name: existing?.name || getAgentDisplayName(agentId),
        iconId: existing?.iconId,
        count: (existing?.count || 0) + 1,
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

  const renderChatAgentSelector = (variant: 'desktop' | 'mobile') => {
    const compact = variant === 'mobile';

    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="chat-agent-id"
            aria-label={`${t('agentSelectTitle')}: ${activeAgentDisplayName}`}
            title={t('agentSelectTitle')}
            className={cn(
              'inline-flex min-w-0 items-center gap-1.5 border border-border/60 bg-muted/50 font-medium text-foreground transition-colors hover:bg-accent',
              compact ? 'max-w-[12rem] px-2 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]',
            )}
          >
            {!compact ? (
              <span className="text-[9px] uppercase tracking-[0.15em] text-muted-foreground">{t('agentLabel')}</span>
            ) : null}
            <AgentIcon iconId={activeAgentProfile?.iconId} className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className={cn('min-w-0 truncate', compact ? 'max-w-[8rem]' : 'max-w-[120px]')}>
              {activeAgentDisplayName}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="bottom" className="w-64 p-1">
          <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {t('agentSelectTitle')}
          </div>
          {chatAgentOptions.map((agent) => {
            const selected = agent.agentId === activeSessionAgentId;
            return (
              <button
                key={agent.agentId}
                type="button"
                onClick={() => selectChatAgent(agent.agentId)}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ${
                  selected ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
                }`}
              >
                <AgentAvatar iconId={agent.iconId} className="h-9 w-9" iconClassName="h-4 w-4" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{agent.name}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">{agent.agentId}</span>
                </span>
                {selected ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : null}
              </button>
            );
          })}
        </PopoverContent>
      </Popover>
    );
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

  const renderQueueItem = (entry: QueuePreviewItem) => {
    const canPromote = entry.kind === 'follow_up' && !isWebSocketUnavailable;
    const label = entry.text || t('imageMessage');

    return (
      <div
        key={`${entry.kind}-${entry.id}`}
        data-testid="chat-queue-item"
        data-queue-kind={entry.kind}
        className={cn(
          'group flex min-h-10 items-center gap-2 border-b border-border/60 px-2.5 py-1.5 last:border-b-0',
          isMobile ? 'text-[13px]' : 'text-sm',
        )}
      >
        <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground/35" aria-hidden="true" />
        <CornerDownRight className="h-4 w-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />
        <button
          type="button"
          onClick={() => {
            if (canPromote) {
              void handlePromoteQueuedMessage(entry.id);
            }
          }}
          disabled={!canPromote}
          className="min-w-0 flex-1 truncate text-left text-foreground/75 transition-colors enabled:hover:text-foreground disabled:cursor-default"
          title={label}
        >
          {label}
        </button>
        <button
          type="button"
          data-testid="chat-queue-item-steer"
          onClick={() => void handlePromoteQueuedMessage(entry.id)}
          disabled={!canPromote}
          className="inline-flex shrink-0 items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary disabled:cursor-default disabled:opacity-45"
          title={t('steerAction')}
        >
          <CornerDownRight className="h-3.5 w-3.5" />
          <span>{t('steer')}</span>
        </button>
        <button
          type="button"
          data-testid="chat-queue-item-remove"
          onClick={() => void handleRemoveQueuedMessage(entry.id)}
          disabled={isWebSocketUnavailable}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
          title={t('removeQueuedMessage')}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <span
          aria-hidden="true"
          className="hidden h-8 w-8 shrink-0 items-center justify-center text-muted-foreground/60 sm:inline-flex"
        >
          <MoreHorizontal className="h-4 w-4" />
        </span>
      </div>
    );
  };

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
      <div className="z-10 border-b border-border bg-background/95">
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
                data-testid="chat-history-toggle"
                aria-label={t('toggleSidebar')}
                onClick={() => setShowHistory(true)}
                className="relative border border-transparent p-1 transition-colors hover:border-border hover:bg-accent"
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
            <div className="min-w-0">
              {isMobile ? (
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
                  {renderChatAgentSelector('desktop')}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={t('newChatTitle')}
              onClick={() => startNewChat()}
              className="group flex items-center gap-1 border border-primary/30 bg-primary/15 px-2 py-1 text-primary transition-all hover:bg-primary/25"
              title={t('newChatTitle')}
            >
              <Plus size={16} />
              <span className="hidden text-[11px] font-bold sm:inline">{t('newChatShort')}</span>
            </button>
            {showSkillsLink && (
              <Link
                href="/settings?tab=skills"
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
        <div data-testid="chat-runtime-banner" className="border-t border-border/50 px-3 py-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <div data-testid="chat-runtime-status" className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <ChatRuntimeActivityBadge status={runtimeStatus} />
              {isMobile ? renderChatAgentSelector('mobile') : null}
              
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
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {!isMobile ? (
                <span
                  data-testid="chat-context-meter"
                  title={contextTooltip}
                  className="inline-flex items-center border border-border/60 bg-muted/40 px-2.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                >
                  {contextDetailedLabel}
                </span>
              ) : null}
              {!isMobile && (
                <>
                  <button
                    type="button"
                    data-testid="chat-compact"
                    onClick={() => void handleCompact()}
                    disabled={!sessionId || runtimeStatus?.phase !== 'idle'}
                    className="border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('compact')}
                  </button>
                  <Link
                    href="/settings?tab=agent"
                    aria-label={t('openAgentSettings')}
                    className="inline-flex items-center gap-1 border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-all hover:bg-accent hover:text-foreground"
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
            <div className="flex min-h-full min-w-0 flex-col justify-start py-4 md:justify-center md:py-0">
              <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col items-center gap-5 text-center">
                <div className="w-full min-w-0 space-y-2">
                  <span className="inline-flex max-w-full min-w-0 items-center justify-center gap-2 overflow-hidden border border-border bg-background/80 px-3 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
                    <Sparkles className="h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0 truncate">{t('productivityBadge')}</span>
                  </span>
                  {latestSession ? (
                    <div className="flex min-w-0 justify-center">
                      <Link
                        href={`${sessionBasePath}?session=${encodeURIComponent(latestSession.sessionId)}`}
                        className="inline-flex max-w-full min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 overflow-hidden border border-border bg-background/80 px-3 py-1.5 text-xs text-foreground transition-colors hover:border-primary/40 hover:bg-accent"
                      >
                        <History className="h-3.5 w-3.5 shrink-0 text-primary" />
                        <span className="min-w-0 truncate font-medium">{t('openLatestSession')}</span>
                        <span className="min-w-0 max-w-full truncate text-muted-foreground sm:max-w-[14rem]">{latestSession.title || latestSession.sessionId}</span>
                      </Link>
                    </div>
                  ) : null}
                  <div className="space-y-1">
                    <h2 className="mx-auto max-w-3xl break-words text-xl font-semibold text-foreground [overflow-wrap:anywhere] md:text-2xl">
                      {t(isStudioChatContext ? 'studioStarterTitle' : 'starterTitle')}
                    </h2>
                    <p className="mx-auto max-w-2xl break-words text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                      {t(isStudioChatContext ? 'studioStarterDescription' : 'starterDescription')}
                    </p>
                  </div>
                </div>
                <div
                  data-testid="chat-starter-prompts"
                  className="grid w-full min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3 pb-3"
                >
                  {localizedStarterPrompts.map((prompt) => (
                    <StarterPromptButton key={prompt.id} prompt={prompt} onSelect={applyStarterPrompt} compact={isCompactView} />
                  ))}
                </div>
              </div>
            </div>
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

            {messages.map((message, messageIndex) => {
            if (hiddenStepIds.has(message.id)) {
              return null;
            }

            const isUser = message.role === 'user';
            const isAssistant = message.role === 'assistant';
            const isTool = message.role === 'toolResult';
            const isSystem = message.role === 'system';
            const isSystemError = isSystem && message.status === 'error';
            const isCompactBreak = message.type === 'compact_break';
            const isStreamingAssistant = isAssistant && message.status === 'sending';
            const isAbortedAssistant = isAssistant && isAbortedAssistantPiMessage(message.piMessage);
            const collapsedRun = isAssistant ? collapsedRunMap.get(message.id) : undefined;
            const rawBodyContent = contentToString(message.content);
            const hasVisibleAssistantContent = rawBodyContent.trim().length > 0;
            const suppressAssistantTitle = isAssistant && hasEarlierVisibleAssistantInRun(messages, messageIndex, hiddenStepIds);

            if (isTool && toolVerbosity === 'minimal') {
              return null;
            }

            if (isTool && toolVerbosity === 'subtle') {
              return (
                <ToolCallPill
                  key={message.id}
                  message={message}
                  onMediaClick={onMediaClick}
                />
              );
            }

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

            if (message.type === 'composio_auth_required' && message.composioAuthMeta) {
              const meta = message.composioAuthMeta;
              return (
                <div key={message.id} className="flex justify-start">
                  <div className="max-w-[90%] rounded-lg border border-blue-500/30 bg-blue-500/5 p-4">
                    <div className="flex items-start gap-3">
                      <Lock className="mt-0.5 h-5 w-5 shrink-0 text-blue-500" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-foreground">Authentication Required</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {meta.toolkitName} needs authorization to use {meta.toolName}.
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {meta.redirectUrl && (
                            <Button size="sm" onClick={() => window.open(meta.redirectUrl, '_blank', 'noopener,noreferrer')}>
                              <ExternalLink className="mr-1 h-3 w-3" />
                              Connect {meta.toolkitName}
                            </Button>
                          )}
                          <Link href="/settings?tab=integrations">
                            <Button variant="outline" size="sm">
                              {t('goToSettings') || 'Settings → Integrations'}
                            </Button>
                          </Link>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            }

            if (isAssistant && !isStreamingAssistant && !hasVisibleAssistantContent && message.status !== 'error' && !isAbortedAssistant) {
              return null;
            }

            const bubbleClass = isUser
              ? 'border-primary bg-primary text-primary-foreground shadow-sm'
              : isAbortedAssistant
                ? 'border-rose-500/30 bg-rose-500/10 text-rose-800 dark:text-rose-200'
                : isAssistant
                  ? 'border-border bg-muted text-foreground'
                  : isTool
                    ? 'border-amber-500/40 bg-amber-500/10 text-foreground'
                    : isSystemError
                      ? 'border-destructive/40 bg-destructive/10 text-destructive'
                      : 'border-border bg-background/80 text-muted-foreground';

            const title = isUser ? t('you') : isTool ? (message.toolName || t('tool')) : isAssistant ? t('assistant') : t('system');
            const bodyContent =
              rawBodyContent ||
              (isAbortedAssistant
                ? t('runStopped')
                : message.status === 'queued_follow_up'
                  ? t('queuedAfterCurrentRun')
                  : message.status === 'queued_steering'
                    ? t('queuedAsSteeringMessage')
                    : message.status === 'aborting'
                      ? t('willSendAfterStop')
                      : message.status === 'sending'
                        ? (isTool ? t('runningTool') : t('agentWorking'))
                        : '');
            const displayBodyContent = isAssistant
              ? rewriteRelativeStudioImageMarkdown(
                  bodyContent,
                  getRecentStudioImageMediaUrls(messages, messageIndex),
                )
              : bodyContent;
            const toolBodyVisible = isTool ? !message.isCollapsed : true;
            const toolStatusLabel = isTool ? getToolStatusLabel(message, t) : null;

            const renderedMessage = (
              <div data-testid={`chat-message-${message.role}`} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[96%] border p-3 sm:max-w-[90%] overflow-hidden min-w-0 ${bubbleClass}`}>
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
                              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90 max-w-full">{message.toolArgs}</pre>
                            </div>
                          ) : null}
                          <MarkdownMessage content={bodyContent} variant="tool" onMediaClick={onMediaClick} />
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <>
                      {!isAssistant || !suppressAssistantTitle ? (
                        <div className="mb-2 flex items-center gap-2">
                          <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">{title}</span>
                          {isAbortedAssistant ? <span className="text-[10px] uppercase tracking-widest opacity-60">{t('runStoppedBadge')}</span> : null}
                          {message.status === 'aborting' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-70" />}
                          {message.status === 'queued_follow_up' ? <span className="text-[10px] uppercase tracking-widest opacity-60">{t('queue')}</span> : null}
                          {message.status === 'queued_steering' ? <span className="text-[10px] uppercase tracking-widest opacity-60">{t('steer')}</span> : null}
                        </div>
                      ) : null}

                      {isUser ? (
                        <MarkdownMessage content={bodyContent} variant="user" onMediaClick={onMediaClick} />
                      ) : isAssistant ? (
                        isStreamingAssistant && !rawBodyContent ? (
                          <StreamingMessageIndicator />
                        ) : (
                          <>
                            <MarkdownMessage content={displayBodyContent} variant="assistant" onMediaClick={onMediaClick} />
                            {isStreamingAssistant ? (
                              <div className="mt-2 inline-flex items-center gap-1 text-muted-foreground/70">
                                {[0, 160, 320].map((delay) => (
                                  <span
                                    key={delay}
                                    aria-hidden="true"
                                    className="chat-streaming-dot h-1 w-1 rounded-full bg-current"
                                    style={{ animationDelay: `${delay}ms` }}
                                  />
                                ))}
                                <span className="sr-only">{t('assistantStreamingSr')}</span>
                              </div>
                            ) : null}
                          </>
                        )
                      ) : (
                        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{bodyContent}</div>
                      )}
                    </>
                  )}

                  {message.attachments && message.attachments.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {message.attachments.map((attachment, index) => (
                        <div key={index} data-testid="chat-message-attachment" className="flex items-center gap-1.5 border border-border bg-background/50 p-1.5 px-2.5 text-[10px]">
                          {attachment.contentKind === 'image'
                            ? <ImageIcon className="h-3 w-3" />
                            : <FileText className="h-3 w-3" />}
                          {attachment.name}
                        </div>
                      ))}
                    </div>
                  )}

                  {isAssistant && !isStreamingAssistant && bodyContent && (() => {
                    const filePaths = extractFilePaths(bodyContent);
                    return filePaths.length > 0 ? <FileReferenceCard paths={filePaths} /> : null;
                  })()}
                </div>
              </div>
            );

            if (collapsedRun) {
              return (
                <React.Fragment key={message.id}>
                  <AgentRunDisclosure
                    run={collapsedRun}
                    expanded={expandedRunKeys.has(collapsedRun.key)}
                    onToggle={() => toggleRunDisclosure(collapsedRun.key)}
                    toolVerbosity={toolVerbosity}
                    onMediaClick={onMediaClick}
                  />
                  {renderedMessage}
                </React.Fragment>
              );
            }

            return (
              <React.Fragment key={message.id}>
                {renderedMessage}
              </React.Fragment>
            );
            })}
            {toolVerbosity === 'minimal' && runtimeStatus?.phase === 'running_tool' ? (
            <div data-testid="chat-minimal-tool-activity" className="flex justify-start px-1 py-1">
              <div className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-border/60 bg-background/80 px-3 text-muted-foreground/80">
                {[0, 160, 320].map((delay) => (
                  <span
                    key={delay}
                    aria-hidden="true"
                    className="chat-streaming-dot h-1.5 w-1.5 rounded-full bg-current"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
                <span className="sr-only">{t('toolWorking')}</span>
              </div>
            </div>
            ) : null}
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

        {runtimeStatus && totalQueuedMessages > 0 && (
          <div
            data-testid="chat-queue-panel"
            className={cn(
              'mb-2 overflow-hidden rounded-md border border-border/70 bg-background/95 shadow-sm',
              isMobile ? 'max-h-36' : 'max-h-44',
            )}
          >
            <div className={cn('overflow-y-auto', isMobile ? 'max-h-36' : 'max-h-44')}>
              {queueItems.map((entry) => renderQueueItem(entry))}
            </div>
          </div>
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
