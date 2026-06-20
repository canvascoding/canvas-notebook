import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import type { RuntimeQueueItem, RuntimeStatus } from '@/app/lib/chat/runtime-status';

/**
 * Context fields attached to every chat message sent to the PI runtime.
 * Used by both the temporary HTTP compatibility routes and the WebSocket runtime protocol.
 */
export interface ChatRequestContext {
  channelId?: string;
  userTimeZone?: string;
  currentTime?: string;
  activeFilePath?: string | null;
  workingDirectory?: string;
  workspace?: {
    workspaceId: string;
    workspaceType: 'personal' | 'team' | 'project';
    workspaceName: string;
    organizationId?: string | null;
    canWrite: boolean;
    canShare: boolean;
  };
  planningMode?: boolean;
  currentPage?: string;
  studioContext?: {
    generationId?: string;
    currentOutputId?: string;
    generationPrompt?: string | null;
    generationPresetId?: string | null;
    generationProductIds?: string[];
    generationPersonaIds?: string[];
    outputFilePath?: string | null;
    outputMediaUrl?: string | null;
    activeImagePath?: string | null;
  };
  emailContext?: {
    accountEmail?: string;
    accountId?: string;
    filter?: 'all' | 'unread';
    folder?: string;
    folderName?: string;
    query?: string;
    selectedMessageDate?: string | null;
    selectedMessageFolder?: string;
    selectedMessageFrom?: string | null;
    selectedMessageId?: string;
    selectedMessageIsRead?: boolean | null;
    selectedMessageSubject?: string | null;
  };
}

export interface ChatAttachment {
  name: string;
  contentKind: 'image' | 'document';
  // Upload file ID or stable attachment key.
  id: string;
  mimeType?: string;
  category?: string;
  // Optional absolute/container path for direct server-side reading.
  filePath?: string;
  // Lightweight image thumbnail. Chat UI must use this instead of loading originals.
  previewUrl?: string;
  // Original media URL, used only for explicit open/zoom actions.
  mediaUrl?: string;
  size?: number;
}

export type Attachment = ChatAttachment;

export interface ChatMessage {
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

export type QueuePreviewItem = RuntimeQueueItem & { kind: 'follow_up' | 'steer' };
export type SessionRuntimePhase = RuntimeStatus['phase'];

export interface AISession {
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
  runtimePhase?: SessionRuntimePhase | null;
  runtimeActiveToolName?: string | null;
  hasUnread?: boolean;
  creator?: {
    name?: string | null;
    email?: string | null;
  };
}

export type CachedChatSession = {
  version: 1;
  session: AISession;
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  oldestTimestamp: number | null;
  oldestMessageId: number | null;
  oldestSequence: number | null;
  cachedAt: number;
};

export type ChatSessionCacheStore = {
  version: 1;
  entries: CachedChatSession[];
};

export interface ChatEvent {
  type: string;
  message?: AgentMessage;
  text?: string;
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
    content?: string;
  };
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: {
    content?: unknown[];
    details?: unknown;
  };
  partialResult?: {
    content?: unknown[];
    details?: unknown;
  };
  error?: string;
  messages?: AgentMessage[];
  status?: RuntimeStatus;
  timestamp?: string;
  kind?: 'manual' | 'automatic';
  omittedMessageCount?: number;
  includedSummary?: boolean;
}

export type PersistedChatMessage = AgentMessage & {
  id?: number | string;
  sequence?: number;
};

export type PersistedToolCallPart = {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: unknown;
};

export type UserPiMessage = Extract<AgentMessage, { role: 'user' }>;
export type UserPiContent = UserPiMessage['content'];

export type CollapsedRun = {
  key: string;
  finalAssistantId: string;
  steps: ChatMessage[];
  startedAt: number | null;
  endedAt: number | null;
};

export type AttachmentOpenHandler = (attachment: Attachment, previewGroup?: Attachment[]) => void;

export type DiscoveryModel = {
  id: string;
  name: string;
  supportsVision?: boolean;
  reasoning?: boolean;
};

export type AgentConfig = {
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

export type AgentProfile = {
  agentId: string;
  name: string;
  iconId?: string;
  type: string;
  removable: boolean;
};

export type ChatHistoryGroup = 'today' | 'last7' | 'last14' | 'last30' | 'older';
export type ChatHistoryGroups = Record<ChatHistoryGroup, AISession[]>;
export type ChatHistoryPanelVariant = 'sidebar' | 'overlay';
export type ChatHistoryAgentOption = {
  agentId: string;
  name: string;
  iconId?: string;
};
