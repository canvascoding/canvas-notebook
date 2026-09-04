import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import type { PiSessionTitleGenerationState } from '@/app/lib/pi/session-titles';
import type { RuntimeQueueItem, RuntimeStatus } from '@/app/lib/chat/runtime-status';

export type ChatWorkspaceType = 'personal' | 'organization' | 'team' | 'project';

export type NotebookChatPlacement = 'full' | 'hidden' | 'overlay' | 'side';

export type NotebookRequestActiveSurface =
  | { kind: 'browser' }
  | { kind: 'document'; path: string }
  | { kind: 'email' };

export type NotebookRequestContext = {
  activeSurface: NotebookRequestActiveSurface | null;
  chatPlacement: NotebookChatPlacement;
  openDocuments: Array<{
    path: string;
    state: 'active' | 'background';
  }>;
};

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
    workspaceType: ChatWorkspaceType;
    workspaceName: string;
    workspaceDescription?: string;
    organizationId?: string | null;
    canWrite: boolean;
    canDelete: boolean;
    canShare: boolean;
    brandContext?: string;
  };
  planningMode?: boolean;
  currentPage?: string;
  notebookContext?: NotebookRequestContext;
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
    attemptId?: string;
    kind: 'manual' | 'automatic';
    timestamp: string;
    omittedMessageCount: number;
  };
  composioAuthMeta?: {
    toolkit: string;
    toolkitName: string;
    redirectUrl: string;
    toolName: string;
    workspaceId?: string | null;
    profileId?: string | null;
    profileName?: string | null;
    profileSource?: 'default' | 'workspace_override' | null;
  };
}

export type QueuePreviewItem = RuntimeQueueItem & { kind: 'follow_up' | 'steer' };
export type SessionRuntimePhase = RuntimeStatus['phase'];

export interface AISession {
  id: number;
  sessionId: string;
  title: string | null;
  titleGenerationState?: PiSessionTitleGenerationState | null;
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
  workspace?: {
    workspaceId: string;
    workspaceType: ChatWorkspaceType;
    workspaceName: string;
    organizationId?: string | null;
    rootRelativePath?: string | null;
    legacy?: boolean;
  } | null;
  creator?: {
    name?: string | null;
    email?: string | null;
  };
}

export type ChatHistorySearchMatch = {
  kind: 'title' | 'content';
  messageId?: number;
  role?: string;
  snippet?: string;
};

export type ChatHistorySearchResult = {
  session: AISession;
  match: ChatHistorySearchMatch;
};

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
  attemptId?: string;
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

export type ToolBatchCall = {
  id: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: string;
  message?: ChatMessage;
};

export type ToolBatch = {
  key: string;
  anchorMessageId: string;
  sourceAssistantMessageId?: string;
  calls: ToolBatchCall[];
  startedAt: number | null;
  endedAt: number | null;
};

export type ToolBatchProjection = {
  batchesByAnchorId: Map<string, ToolBatch>;
  hiddenToolMessageIds: Set<string>;
};

export type AttachmentOpenHandler = (attachment: Attachment, previewGroup?: Attachment[]) => void;

export type AgentProfile = {
  agentId: string;
  name: string;
  iconId?: string;
  type: string;
  removable: boolean;
  scopeType?: 'user' | 'organization' | 'system';
  organizationId?: string | null;
  ownerUserId?: string | null;
  createdByUserId?: string | null;
  revision?: number;
  defaultProviderInstallationId?: string | null;
  defaultProvider?: string | null;
  defaultModel?: string | null;
  defaultThinking?: PiThinkingLevel | null;
  enabledTools?: string[] | null;
  relevantSkills?: string[] | null;
  relevantConnections?: string[] | null;
  access?: {
    canUse: boolean;
    canEdit: boolean;
    canManage: boolean;
  };
};

export type ChatHistoryGroup =
  | 'searchTitle'
  | 'searchContent'
  | 'today'
  | 'last7'
  | 'last14'
  | 'last30'
  | 'older';
export type ChatHistoryGroups = Record<ChatHistoryGroup, AISession[]>;
export type ChatHistoryPanelVariant = 'sidebar' | 'overlay';
export type ChatHistoryAgentOption = {
  agentId: string;
  name: string;
  iconId?: string;
};
