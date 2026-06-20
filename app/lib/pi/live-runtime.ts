import 'server-only';

import path from 'node:path';
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';

import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { resolveAgentRuntimeConfig } from '@/app/lib/agents/effective-runtime-config';
import { createPiSystemPromptSnapshot, ensurePiSessionSystemPromptSnapshot } from '@/app/lib/pi/system-prompt-snapshot';
import { resolvePiApiKey } from '@/app/lib/pi/api-key-resolver';
import {
  composePiHistoryForLlm,
  estimateTextTokens,
  type PiHistoryComposition,
  type PiSessionSummaryState,
} from '@/app/lib/pi/history-budget';
import { normalizePiMessagesForLlm } from '@/app/lib/pi/message-normalization';
import { createCompactBreakMessage, createRuntimeContinuationMessage, type RuntimeContinuationReason } from '@/app/lib/pi/custom-messages';
import {
  createThinkingFilterState,
  filterThinkingChunk,
  flushThinkingFilter,
  type ThinkingFilterState,
} from '@/app/lib/pi/thinking-filter';
import {
  formatImageInputUnsupportedError,
  isImageInputUnsupportedError,
  resolvePiModel,
} from '@/app/lib/pi/model-resolver';
import { preparePiHistoryContext } from '@/app/lib/pi/session-summary';
import { loadPiSessionWithSummary, savePiSession } from '@/app/lib/pi/session-store';
import { getPiTools } from '@/app/lib/pi/tool-registry';
import { filterToolsForPlanningMode } from '@/app/lib/pi/planning-mode';
import { getChannelSystemPromptBlock } from '@/app/lib/agents/channel-system-prompt';
import { formatZonedDateTimeForPrompt } from '@/app/lib/time-zones';
import { EMAIL_SYSTEM_PROMPT_BLOCK } from '@/app/lib/agents/email-prompt-block';
import { PLANNING_MODE_GUIDANCE } from '@/app/lib/agents/system-prompt-shared';
import { STUDIO_SYSTEM_PROMPT_BLOCK } from '@/app/lib/agents/studio-prompt-block';
import { persistPiUsageEvents } from '@/app/lib/pi/usage-events';
import { getStudioOutputsRoot, STUDIO_OUTPUTS_ROOT_DIR } from '@/app/lib/integrations/studio-workspace';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { buildReferencedPluginRuntimeContext } from '@/app/lib/plugins/plugin-reference-context';
import { createToolLoopGuard } from '@/app/lib/pi/tool-loop-guard';
import {
  createToolTailContinuationDecision,
  extractAgentMessageText,
  shouldContinueAfterIntermediateAck,
  type RuntimeContinuationDecision,
} from '@/app/lib/pi/run-continuation-guard';
import { and, eq } from 'drizzle-orm';

const IDLE_TTL_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_RUNTIME_INSTANCES = 20;

function getStudioOutputReferencePaths(outputFilePath: string) {
  const normalizedOutputPath = outputFilePath.replace(/^\/+/, '');
  const referencePath = normalizedOutputPath.startsWith(`${STUDIO_OUTPUTS_ROOT_DIR}/`)
    ? normalizedOutputPath
    : path.posix.join(STUDIO_OUTPUTS_ROOT_DIR, normalizedOutputPath);

  const outputRelativePath = referencePath.startsWith(`${STUDIO_OUTPUTS_ROOT_DIR}/`)
    ? referencePath.slice(`${STUDIO_OUTPUTS_ROOT_DIR}/`.length)
    : normalizedOutputPath;

  return {
    absolutePath: path.join(getStudioOutputsRoot(), outputRelativePath),
    referencePath,
  };
}

// Lazy-cached emitter — resolved once, reused for every subsequent agent event.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _emitter: any = null;
async function getEmitter() {
  if (!_emitter) {
    const { getPiRuntimeEventEmitter } = await import('./runtime-event-emitter');
    _emitter = getPiRuntimeEventEmitter();
  }
  return _emitter;
}

type RuntimePhase = 'idle' | 'streaming' | 'running_tool' | 'aborting';

type QueueEntryPreview = {
  id: string;
  text: string;
  attachmentCount: number;
  messageTimestamp?: number;
  signature?: string;
};

export type PiRuntimeStatus = {
  sessionId: string;
  phase: RuntimePhase;
  activeTool: { toolCallId: string; name: string } | null;
  pendingToolCalls: number;
  followUpQueue: QueueEntryPreview[];
  steeringQueue: QueueEntryPreview[];
  canAbort: boolean;
  contextWindow: number;
  estimatedHistoryTokens: number;
  availableHistoryTokens: number;
  contextUsagePercent: number;
  includedSummary: boolean;
  omittedMessageCount: number;
  summaryUpdatedAt: string | null;
  lastCompactionAt: string | null;
  lastCompactionKind: 'manual' | 'automatic' | null;
  lastCompactionOmittedCount: number;
};

export type RuntimeStatusEvent = {
  type: 'runtime_status';
  status: PiRuntimeStatus;
};

export type ContextCompactedEvent = {
  type: 'context_compacted';
  timestamp: string;
  kind: 'manual' | 'automatic';
  omittedMessageCount: number;
  includedSummary: boolean;
};

export type RuntimeErrorEvent = {
  type: 'error';
  error: string;
};

export type PiRuntimeStreamEvent = AgentEvent | RuntimeStatusEvent | ContextCompactedEvent | RuntimeErrorEvent;
export type PiRuntimePromptContext = {
  channelId?: string;
  activeFilePath?: string | null;
  userTimeZone?: string;
  currentTime?: string;
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
};

type RuntimeSubscriber = (event: PiRuntimeStreamEvent) => void;

type RuntimeQueueEntry = {
  id: string;
  preview: QueueEntryPreview;
  message: Extract<AgentMessage, { role: 'user' }>;
  signature: string;
};

type RuntimeTurnEndEvent = Extract<AgentEvent, { type: 'turn_end' }>;

type RuntimeTurnDiagnostics = {
  role: AgentMessage['role'] | null;
  assistantPreview: string;
  stopReason?: string;
  toolCallCount: number;
  toolResultCount: number;
  followUpQueueLength: number;
  steeringQueueLength: number;
  syntheticContinuationCount: number;
  lastContinuationReason: RuntimeContinuationReason | null;
};

type RuntimeInit = {
  sessionId: string;
  userId: string;
  agentId: string;
  provider: string;
  model: Model<Api>;
  systemPrompt: string;
  tools: AgentTool[];
  summary: PiSessionSummaryState;
  initialMessages: AgentMessage[];
};

type RuntimeOptions = {
  resetToolLoopGuard?: () => void;
};

function isUserMessage(message: AgentMessage): message is Extract<AgentMessage, { role: 'user' }> {
  return message.role === 'user';
}

function formatRuntimeProviderError(message: string, model: Model<Api>): string {
  if (!isImageInputUnsupportedError(message)) {
    return message;
  }

  return formatImageInputUnsupportedError({
    modelId: model.id,
    provider: model.provider,
    message,
  });
}

function getErrorMessage(error: unknown, model: Model<Api>): string {
  const message = error instanceof Error ? error.message : 'Unknown agent error';
  return formatRuntimeProviderError(message, model);
}

function normalizeAssistantErrorMessage(message: AgentMessage, model: Model<Api>): void {
  if (message.role !== 'assistant' || message.stopReason !== 'error' || !message.errorMessage) {
    return;
  }

  message.errorMessage = formatRuntimeProviderError(message.errorMessage, model);
}

function normalizeAgentEventErrors(event: AgentEvent, model: Model<Api>): void {
  if ('message' in event && event.message) {
    normalizeAssistantErrorMessage(event.message, model);
  }

  if ('messages' in event && Array.isArray(event.messages)) {
    event.messages.forEach((message) => normalizeAssistantErrorMessage(message, model));
  }
}

function extractUserMessageText(message: Extract<AgentMessage, { role: 'user' }>): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return '';
  }

  return message.content
    .map((part) => (part && typeof part === 'object' && 'type' in part && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function countAssistantToolCalls(message: AssistantMessage): number {
  return message.content.filter((part) => (
    part && typeof part === 'object' && 'type' in part && part.type === 'toolCall'
  )).length;
}

function countMessageAttachments(message: Extract<AgentMessage, { role: 'user' }>): number {
  if (!Array.isArray(message.content)) {
    return 0;
  }

  return message.content.filter((part) => part && typeof part === 'object' && 'type' in part && part.type === 'image').length;
}

function buildQueuePreview(message: Extract<AgentMessage, { role: 'user' }>): QueueEntryPreview {
  return {
    id: `queue-${message.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    text: extractUserMessageText(message),
    attachmentCount: countMessageAttachments(message),
    messageTimestamp: message.timestamp,
    signature: getMessageSignature(message),
  };
}

function getMessageSignature(message: Extract<AgentMessage, { role: 'user' }>): string {
  return `${message.timestamp}:${extractUserMessageText(message)}:${countMessageAttachments(message)}`;
}

function sanitizeUserMessage(
  message: Extract<AgentMessage, { role: 'user' }>,
): Extract<AgentMessage, { role: 'user' }> {
  // Pass through all messages without filtering - let the model handle vision capabilities
  return message;
}

function appendRuntimeContextToUserMessage(
  message: Extract<AgentMessage, { role: 'user' }>,
  runtimeContext: string,
): Extract<AgentMessage, { role: 'user' }> {
  if (typeof message.content === 'string') {
    return {
      ...message,
      content: `${message.content}\n\n${runtimeContext}`,
    };
  }

  if (Array.isArray(message.content)) {
    return {
      ...message,
      content: [...message.content, { type: 'text', text: runtimeContext }],
    };
  }

  return message;
}

function toPercent(used: number, available: number): number {
  if (available <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round((used / available) * 100)));
}

function getRuntimeStatusSignature(status: PiRuntimeStatus): string {
  return JSON.stringify({
    phase: status.phase,
    activeTool: status.activeTool,
    pendingToolCalls: status.pendingToolCalls,
    followUpQueue: status.followUpQueue,
    steeringQueue: status.steeringQueue,
    canAbort: status.canAbort,
    contextWindow: status.contextWindow,
    estimatedHistoryTokens: status.estimatedHistoryTokens,
    availableHistoryTokens: status.availableHistoryTokens,
    contextUsagePercent: status.contextUsagePercent,
    includedSummary: status.includedSummary,
    omittedMessageCount: status.omittedMessageCount,
    summaryUpdatedAt: status.summaryUpdatedAt,
    lastCompactionAt: status.lastCompactionAt,
    lastCompactionKind: status.lastCompactionKind,
    lastCompactionOmittedCount: status.lastCompactionOmittedCount,
  });
}

type PiRuntimePromptDispatchTarget = {
  setChannelContext: (channelId: string | undefined) => void;
  setTimeZoneContext: (timeZone: string, currentTime: string) => void;
  setActiveFileContext: (path: string | null) => void;
  setPlanningMode: (enabled: boolean) => void;
  setPageContext: (page: string | undefined) => void;
  setStudioContext: (context: PiRuntimePromptContext['studioContext']) => void;
  setEmailContext: (context: PiRuntimePromptContext['emailContext']) => void;
  setWorkspaceContext: (context: PiRuntimePromptContext['workspace']) => void;
  reloadTools: () => Promise<void>;
  startPrompt: (message: Extract<AgentMessage, { role: 'user' }>) => void;
};

function applyPiRuntimePromptContext(
  runtime: PiRuntimePromptDispatchTarget,
  context?: PiRuntimePromptContext,
) {
  runtime.setChannelContext(context?.channelId);

  if (context?.userTimeZone && context.currentTime) {
    runtime.setTimeZoneContext(context.userTimeZone, context.currentTime);
  }

  runtime.setActiveFileContext(context?.activeFilePath ?? null);
  runtime.setPlanningMode(context?.planningMode ?? false);
  runtime.setPageContext(context?.currentPage);
  runtime.setStudioContext(context?.studioContext);
  runtime.setEmailContext(context?.emailContext);
  runtime.setWorkspaceContext(context?.workspace);
}

class LivePiRuntime {
  readonly sessionId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly provider: string;
  readonly model: Model<Api>;
  readonly systemPrompt: string;
  private tools: AgentTool[];
  readonly agent: Agent;

  private readonly subscribers = new Set<RuntimeSubscriber>();
  private followUpQueue: RuntimeQueueEntry[] = [];
  private steeringQueue: RuntimeQueueEntry[] = [];
  private pendingReplace: RuntimeQueueEntry | null = null;
  private activeTool: { toolCallId: string; name: string } | null = null;
  private abortRequested = false;
  private isRunning = false;
  private summary: PiSessionSummaryState;
  private lastComposition: PiHistoryComposition | null = null;
  private lastPersistedLength: number;
  private lastAccessAt = Date.now();
  private lastCompactionAt: Date | null;
  private lastCompactionKind: 'manual' | 'automatic' | null;
  private lastCompactionOmittedCount: number;
  private channelId: string | null = null;
  private timeZoneContext: { timeZone: string; currentTime: string } | null = null;
  private activeFileContext: string | null = null;
  private planningMode = false;
  private pageContext: string | null = null;
  private studioContext: PiRuntimePromptContext['studioContext'] | null = null;
  private emailContext: PiRuntimePromptContext['emailContext'] | null = null;
  private workspaceContext: PiRuntimePromptContext['workspace'] | null = null;
  private persistLock = false;
  private persistPending: 'turn_end' | 'agent_end' | 'error' | null = null;
  private lastBroadcastStatusSignature: string | null = null;
  private currentUserPromptText = '';
  private currentUserPromptSignature: string | null = null;
  private syntheticContinuationCount = 0;
  private lastContinuationReason: RuntimeContinuationReason | null = null;
  private pendingInitialToolTailContinuation = false;
  private lastTurnDiagnostics: RuntimeTurnDiagnostics | null = null;
  private thinkingFilterState: ThinkingFilterState = createThinkingFilterState();
  agentUnsubscribe: (() => void) | null = null;

  constructor(init: RuntimeInit, agent: Agent, private readonly options: RuntimeOptions = {}) {
    this.sessionId = init.sessionId;
    this.userId = init.userId;
    this.agentId = init.agentId;
    this.provider = init.provider;
    this.model = init.model;
    this.systemPrompt = init.systemPrompt;
    this.tools = init.tools;
    this.summary = init.summary;
    this.lastPersistedLength = init.initialMessages.length;
    this.agent = agent;
    this.lastCompactionAt = init.summary.summaryUpdatedAt;
    this.lastCompactionKind = init.summary.summaryUpdatedAt ? 'automatic' : null;
    this.lastCompactionOmittedCount = 0;
    this.pendingInitialToolTailContinuation = createToolTailContinuationDecision(init.initialMessages) !== null;
  }

  touch() {
    this.lastAccessAt = Date.now();
  }

  isExpired(now: number) {
    return !this.agent.state.isStreaming && !this.isRunning && now - this.lastAccessAt > IDLE_TTL_MS;
  }

  getLastAccessAt() {
    return this.lastAccessAt;
  }

  hasPendingReplace() {
    return this.pendingReplace !== null;
  }

  subscribe(subscriber: RuntimeSubscriber) {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  getStatus(): PiRuntimeStatus {
    if (!this.lastComposition) {
      this.lastComposition = composePiHistoryForLlm({
        messages: this.agent.state.messages,
        summary: this.summary,
        systemPromptTokens: estimateTextTokens(this.getEffectiveSystemPrompt()),
        contextWindow: this.model.contextWindow,
        modelMaxTokens: this.model.maxTokens,
        toolCount: this.tools.length,
      });
    }
    const composition = this.lastComposition;

    return {
      sessionId: this.sessionId,
      phase: this.abortRequested
        ? 'aborting'
        : this.activeTool
          ? 'running_tool'
          : this.isRunning
            ? 'streaming'
            : 'idle',
      activeTool: this.activeTool,
      pendingToolCalls: this.agent.state.pendingToolCalls.size,
      followUpQueue: this.followUpQueue.map((entry) => entry.preview),
      steeringQueue: this.steeringQueue.map((entry) => entry.preview),
      canAbort: this.isRunning || this.abortRequested,
      contextWindow: this.model.contextWindow,
      estimatedHistoryTokens: composition.estimatedHistoryTokens,
      availableHistoryTokens: composition.availableHistoryTokens,
      contextUsagePercent: toPercent(composition.estimatedHistoryTokens, composition.availableHistoryTokens),
      includedSummary: composition.includedSummary,
      omittedMessageCount: composition.omittedMessages.length,
      summaryUpdatedAt: this.summary.summaryUpdatedAt ? this.summary.summaryUpdatedAt.toISOString() : null,
      lastCompactionAt: this.lastCompactionAt ? this.lastCompactionAt.toISOString() : null,
      lastCompactionKind: this.lastCompactionKind,
      lastCompactionOmittedCount: this.lastCompactionOmittedCount,
    };
  }

  async queueFollowUp(message: Extract<AgentMessage, { role: 'user' }>) {
    if (!this.isRunning && !this.agent.state.isStreaming) {
      throw new Error('No active agent run to queue a follow-up message.');
    }

    const sanitized = sanitizeUserMessage(message);
    const entry = this.createQueueEntry(sanitized);
    this.followUpQueue.push(entry);
    this.touch();
    this.agent.followUp(entry.message);
    this.publishStatus();
    return this.getStatus();
  }

  async queueSteering(message: Extract<AgentMessage, { role: 'user' }>) {
    if (!this.isRunning && !this.agent.state.isStreaming) {
      throw new Error('No active agent run to steer.');
    }

    const sanitized = sanitizeUserMessage(message);
    const entry = this.createQueueEntry(sanitized);
    this.steeringQueue.push(entry);
    this.touch();
    this.agent.steer(entry.message);
    this.publishStatus();
    return this.getStatus();
  }

  async promoteQueuedMessageToSteering(queueItemId: string) {
    const followUpIndex = this.followUpQueue.findIndex((entry) => entry.preview.id === queueItemId || entry.id === queueItemId);
    if (followUpIndex === -1) {
      return this.getStatus();
    }

    const [entry] = this.followUpQueue.splice(followUpIndex, 1);
    if (!entry) {
      return this.getStatus();
    }

    this.agent.clearFollowUpQueue();
    for (const queuedEntry of this.followUpQueue) {
      this.agent.followUp(queuedEntry.message);
    }

    if (!this.isRunning && !this.agent.state.isStreaming) {
      this.startPrompt(entry.message);
      return this.getStatus();
    }

    this.steeringQueue.push(entry);
    this.touch();
    this.agent.steer(entry.message);
    this.publishStatus();
    return this.getStatus();
  }

  async removeQueuedMessage(queueItemId: string) {
    const followUpIndex = this.followUpQueue.findIndex((entry) => entry.preview.id === queueItemId || entry.id === queueItemId);
    if (followUpIndex !== -1) {
      this.followUpQueue.splice(followUpIndex, 1);
      this.agent.clearFollowUpQueue();
      for (const entry of this.followUpQueue) {
        this.agent.followUp(entry.message);
      }
      this.touch();
      this.publishStatus();
      return this.getStatus();
    }

    const steeringIndex = this.steeringQueue.findIndex((entry) => entry.preview.id === queueItemId || entry.id === queueItemId);
    if (steeringIndex !== -1) {
      this.steeringQueue.splice(steeringIndex, 1);
      this.agent.clearSteeringQueue();
      for (const entry of this.steeringQueue) {
        this.agent.steer(entry.message);
      }
      this.touch();
      this.publishStatus();
    }

    return this.getStatus();
  }

  async replace(message: Extract<AgentMessage, { role: 'user' }>) {
    const sanitized = sanitizeUserMessage(message);

    if (!this.isRunning && !this.agent.state.isStreaming) {
      this.startPrompt(sanitized);
      return this.getStatus();
    }

    this.agent.clearAllQueues();
    this.followUpQueue = [];
    this.steeringQueue = [];
    this.pendingReplace = this.createQueueEntry(sanitized);
    this.abortRequested = true;
    this.touch();
    this.publishStatus();
    this.agent.abort();
    return this.getStatus();
  }

  async abort() {
    if (this.isRunning || this.agent.state.isStreaming || this.abortRequested) {
      this.abortRequested = true;
      this.touch();
      this.publishStatus();
      this.agent.abort();
    }

    return this.getStatus();
  }

  async compactNow() {
    if (this.isRunning || this.agent.state.isStreaming) {
      throw new Error('Cannot compact while the agent is processing.');
    }

    const result = await preparePiHistoryContext({
      messages: this.agent.state.messages,
      summary: this.summary,
      systemPromptTokens: estimateTextTokens(this.getEffectiveSystemPrompt()),
      model: this.model,
      toolCount: this.tools.length,
      sessionId: this.sessionId,
    });

    if (result.summaryFailed && result.composition.omittedMessages.length > 0) {
      this.lastComposition = composePiHistoryForLlm({
        messages: this.agent.state.messages,
        summary: this.summary,
        systemPromptTokens: estimateTextTokens(this.getEffectiveSystemPrompt()),
        contextWindow: this.model.contextWindow,
        modelMaxTokens: this.model.maxTokens,
        toolCount: this.tools.length,
      });
      this.touch();
      this.publishStatus();
      throw new Error(
        'Context compaction failed because the summary could not be updated. No messages were removed.',
      );
    }

    this.summary = result.summary;
    this.lastComposition = result.composition;
    this.recordCompaction('manual', result.composition);

    await savePiSession(
      this.sessionId,
      this.userId,
      this.provider,
      this.model.id,
      this.agent.state.messages,
      this.summary,
      { agentId: this.agentId },
    );

    const omittedCount = result.composition.omittedMessages.length;
    if (omittedCount > 0) {
      this.agent.state.messages.splice(0, omittedCount);
      this.lastPersistedLength = this.agent.state.messages.length;
      this.lastComposition = composePiHistoryForLlm({
        messages: this.agent.state.messages,
        summary: this.summary,
        systemPromptTokens: estimateTextTokens(this.getEffectiveSystemPrompt()),
        contextWindow: this.model.contextWindow,
        modelMaxTokens: this.model.maxTokens,
        toolCount: this.tools.length,
      });
    }

    this.touch();
    this.publishStatus();
    return this.getStatus();
  }

  setChannelContext(channelId: string | undefined) {
    const nextChannelId = channelId?.trim().toLowerCase() || null;
    if (this.channelId === nextChannelId) {
      return;
    }

    this.channelId = nextChannelId;
    this.lastComposition = null;
  }

  setTimeZoneContext(timeZone: string, currentTime: string) {
    this.timeZoneContext = { timeZone, currentTime };
  }

  setActiveFileContext(path: string | null) {
    this.activeFileContext = path;
  }

  setPlanningMode(enabled: boolean) {
    this.planningMode = enabled;
  }

  setPageContext(page: string | undefined): void {
    this.pageContext = page ?? null;
  }

  setStudioContext(context: PiRuntimePromptContext['studioContext']) {
    this.studioContext = context ?? null;
  }

  setEmailContext(context: PiRuntimePromptContext['emailContext']) {
    this.emailContext = context ?? null;
  }

  setWorkspaceContext(context: PiRuntimePromptContext['workspace']) {
    this.workspaceContext = context ?? null;
  }

  async reloadTools() {
    this.tools = await getPiTools(this.userId, this.agentId, this.sessionId);
    this.lastComposition = null;
    this.agent.state.tools = this.planningMode ? filterToolsForPlanningMode(this.tools) : this.tools;
  }

  private getEffectiveSystemPrompt(): string {
    const blocks: string[] = [];
    const channelBlock = getChannelSystemPromptBlock(this.channelId);
    if (channelBlock && !this.systemPrompt.includes(channelBlock)) {
      blocks.push(channelBlock);
    }

    const workspaceBlock = this.getWorkspaceContextBlock();
    if (workspaceBlock) {
      blocks.push(workspaceBlock);
    }

    return blocks.length > 0 ? `${this.systemPrompt}\n\n${blocks.join('\n\n')}` : this.systemPrompt;
  }

  private getWorkspaceContextBlock(): string | null {
    if (!this.workspaceContext) {
      return null;
    }

    const lines = [
      '## Active Workspace Context',
      `This chat session is bound to the ${this.workspaceContext.workspaceType} workspace "${this.workspaceContext.workspaceName}".`,
      `Workspace ID: ${this.workspaceContext.workspaceId}`,
      'All workspace-relative file paths resolve inside this workspace. Do not switch workspace inside this session; a workspace switch requires a new chat session.',
    ];

    if (this.workspaceContext.organizationId) {
      lines.push(`Organization ID: ${this.workspaceContext.organizationId}`);
    }
    if (!this.workspaceContext.canWrite) {
      lines.push('Workspace writes are disabled for this session. Read files only unless the user switches to a workspace with write permission.');
    }
    if (!this.workspaceContext.canShare) {
      lines.push('Public sharing is disabled for this session.');
    }

    return lines.join('\n');
  }

  private getStudioContextBlock(): string | null {
    if (!this.studioContext) {
      return null;
    }

    const lines = [
      '## Active Studio Output Context',
      'The user is iterating on a specific Studio output in the detail view.',
    ];

    if (this.studioContext.currentOutputId) {
      lines.push(`Current output ID: ${this.studioContext.currentOutputId}`);
    }
    if (this.studioContext.generationId) {
      lines.push(`Generation ID: ${this.studioContext.generationId}`);
    }
    if (this.studioContext.generationPrompt) {
      lines.push(`Generation prompt: ${this.studioContext.generationPrompt}`);
    }
    if (this.studioContext.generationPresetId) {
      lines.push(`Preset ID: ${this.studioContext.generationPresetId}`);
    }
    if (this.studioContext.generationProductIds?.length) {
      lines.push(`Product IDs: ${this.studioContext.generationProductIds.join(', ')}`);
    }
    if (this.studioContext.generationPersonaIds?.length) {
      lines.push(`Persona IDs: ${this.studioContext.generationPersonaIds.join(', ')}`);
    }
    if (this.studioContext.outputFilePath) {
      const { absolutePath, referencePath } = getStudioOutputReferencePaths(this.studioContext.outputFilePath);
      lines.push(`Current Studio output DB filePath: ${this.studioContext.outputFilePath}`);
      lines.push(`Use this exact path when passing the current image as a Studio reference: ${referencePath}`);
      lines.push(`Use this exact path in studio_generate_image.extra_reference_urls: ${referencePath}`);
      lines.push(`Absolute filesystem path for file operations only: ${absolutePath}`);
    }
    if (this.studioContext.outputMediaUrl) {
      lines.push(`Output media URL: ${this.studioContext.outputMediaUrl}`);
      lines.push(`When embedding this output in Markdown, use this exact image URL: ${this.studioContext.outputMediaUrl}`);
    }
    if (this.studioContext.activeImagePath) {
      lines.push(`Active image file path: ${this.studioContext.activeImagePath}`);
    }

    lines.push('If the user asks to edit, restyle, recolor, remix, or make a variation of the visible image, call studio_generate_image and include the exact studio/outputs/... reference path above in extra_reference_urls. Do not pass the /data/... absolute filesystem path to studio_generate_image.');
    return lines.join('\n');
  }

  private getEmailContextBlock(): string | null {
    if (!this.emailContext) {
      return null;
    }

    const lines = [
      '## Active Email Context',
      'The user is working in the Canvas Email client.',
    ];

    if (this.emailContext.accountEmail) {
      lines.push(`Active account email: ${this.emailContext.accountEmail}`);
    }
    if (this.emailContext.accountId) {
      lines.push(`Active account ID: ${this.emailContext.accountId}`);
    }
    if (this.emailContext.folderName || this.emailContext.folder) {
      lines.push(`Active folder: ${this.emailContext.folderName || this.emailContext.folder}`);
    }
    if (this.emailContext.folder && this.emailContext.folderName && this.emailContext.folder !== this.emailContext.folderName) {
      lines.push(`Active folder path: ${this.emailContext.folder}`);
    }
    if (this.emailContext.filter) {
      lines.push(`Message filter: ${this.emailContext.filter}`);
    }
    if (this.emailContext.query) {
      lines.push(`Current search query: ${this.emailContext.query}`);
    }
    if (this.emailContext.selectedMessageId) {
      lines.push(`Selected message ID: ${this.emailContext.selectedMessageId}`);
    }
    if (this.emailContext.selectedMessageFolder) {
      lines.push(`Selected message folder: ${this.emailContext.selectedMessageFolder}`);
    }
    if (this.emailContext.selectedMessageSubject) {
      lines.push(`Selected message subject: ${this.emailContext.selectedMessageSubject}`);
    }
    if (this.emailContext.selectedMessageFrom) {
      lines.push(`Selected message from: ${this.emailContext.selectedMessageFrom}`);
    }
    if (this.emailContext.selectedMessageDate) {
      lines.push(`Selected message date: ${this.emailContext.selectedMessageDate}`);
    }
    if (typeof this.emailContext.selectedMessageIsRead === 'boolean') {
      lines.push(`Selected message read: ${this.emailContext.selectedMessageIsRead ? 'yes' : 'no'}`);
    }

    lines.push('This context contains only mailbox metadata. Use email_read before making claims about the selected email body.');
    return lines.join('\n');
  }

  private getPageContextBlock(): string | null {
    if (!this.pageContext) return null;
    if (this.pageContext.startsWith('/studio')) {
      return STUDIO_SYSTEM_PROMPT_BLOCK;
    }
    if (this.pageContext.startsWith('/emails')) {
      return EMAIL_SYSTEM_PROMPT_BLOCK;
    }
    return null;
  }

  private async getRuntimeContextBlock(latestUserMessageText?: string): Promise<string | null> {
    const sections: string[] = [];

    if (this.timeZoneContext) {
      const { timeZone, currentTime } = this.timeZoneContext;
      const formatted = formatZonedDateTimeForPrompt(currentTime, timeZone);
      sections.push(`Current Date & Time: ${formatted.localDateTime} (${formatted.timeZone}, ${formatted.utcOffset})`);
    }

    if (this.activeFileContext) {
      sections.push(`Currently open file in editor: ${this.activeFileContext}`);
    }

    if (this.planningMode) {
      sections.push(PLANNING_MODE_GUIDANCE);
    }

    const pageBlock = this.getPageContextBlock();
    if (pageBlock) {
      sections.push(pageBlock);
    }

    const studioBlock = this.getStudioContextBlock();
    if (studioBlock) {
      sections.push(studioBlock);
    }

    const emailBlock = this.getEmailContextBlock();
    if (emailBlock) {
      sections.push(emailBlock);
    }

    if (latestUserMessageText) {
      try {
        const pluginBlock = await buildReferencedPluginRuntimeContext(latestUserMessageText);
        if (pluginBlock) {
          sections.push(pluginBlock);
        }
      } catch (error) {
        console.warn('[LiveRuntime] Failed to build plugin reference context:', error);
      }
    }

    if (sections.length === 0) {
      return null;
    }

    return [
      '<runtime_context>',
      'Canvas-provided context for this turn. Treat this as operational context, not as a separate user request.',
      '',
      ...sections,
      '</runtime_context>',
    ].join('\n');
  }

  private async injectRuntimeContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
    let latestUserMessageText = '';
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (isUserMessage(message)) {
        latestUserMessageText = extractUserMessageText(message);
        break;
      }
    }

    const runtimeContext = await this.getRuntimeContextBlock(latestUserMessageText);
    if (!runtimeContext) {
      return messages;
    }

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (isUserMessage(message)) {
        const nextMessages = messages.slice();
        nextMessages[index] = appendRuntimeContextToUserMessage(message, runtimeContext);
        return nextMessages;
      }
    }

    return messages;
  }

  private resetRunSupervisorForUserMessage(message: Extract<AgentMessage, { role: 'user' }>): void {
    this.currentUserPromptText = extractUserMessageText(message);
    this.currentUserPromptSignature = getMessageSignature(message);
    this.syntheticContinuationCount = 0;
    this.lastContinuationReason = null;
    this.lastTurnDiagnostics = null;
  }

  private buildTurnDiagnostics(event: RuntimeTurnEndEvent): RuntimeTurnDiagnostics {
    const message = event.message;
    const isAssistant = message.role === 'assistant';
    return {
      role: message.role ?? null,
      assistantPreview: isAssistant ? extractAgentMessageText(message).slice(0, 200) : '',
      stopReason: isAssistant ? message.stopReason : undefined,
      toolCallCount: isAssistant ? countAssistantToolCalls(message) : 0,
      toolResultCount: event.toolResults.length,
      followUpQueueLength: this.followUpQueue.length,
      steeringQueueLength: this.steeringQueue.length,
      syntheticContinuationCount: this.syntheticContinuationCount,
      lastContinuationReason: this.lastContinuationReason,
    };
  }

  private createRuntimeContinuation(decision: RuntimeContinuationDecision): AgentMessage {
    this.syntheticContinuationCount += 1;
    this.lastContinuationReason = decision.reason;
    return createRuntimeContinuationMessage(decision.reason, decision.prompt);
  }

  private maybeCreateInitialToolTailContinuation(): AgentMessage | null {
    if (!this.pendingInitialToolTailContinuation) {
      return null;
    }

    this.pendingInitialToolTailContinuation = false;
    const decision = createToolTailContinuationDecision(this.agent.state.messages);
    if (!decision) {
      return null;
    }

    const message = this.createRuntimeContinuation(decision);
    console.log('[LiveRuntime] Queued synthetic continuation before prompt:', {
      sessionId: this.sessionId,
      reason: decision.reason,
      syntheticContinuationCount: this.syntheticContinuationCount,
    });
    return message;
  }

  private maybeQueueContinuationAfterTurn(event: RuntimeTurnEndEvent): RuntimeContinuationDecision | null {
    if (this.abortRequested || this.pendingReplace) {
      return null;
    }
    if (this.followUpQueue.length > 0 || this.steeringQueue.length > 0 || this.agent.hasQueuedMessages()) {
      return null;
    }
    if (event.message.role !== 'assistant' || event.toolResults.length > 0) {
      return null;
    }

    const decision = shouldContinueAfterIntermediateAck({
      userMessage: this.currentUserPromptText,
      assistantMessage: event.message,
      toolsAvailable: this.agent.state.tools.length > 0,
      syntheticContinuationCount: this.syntheticContinuationCount,
    });

    if (!decision) {
      return null;
    }

    this.agent.followUp(this.createRuntimeContinuation(decision));
    console.log('[LiveRuntime] Queued synthetic continuation after turn:', {
      sessionId: this.sessionId,
      reason: decision.reason,
      syntheticContinuationCount: this.syntheticContinuationCount,
      assistantPreview: decision.assistantPreview,
    });
    return decision;
  }

  startPrompt(message: Extract<AgentMessage, { role: 'user' }>) {
    const sanitized = sanitizeUserMessage(message);
    this.resetRunSupervisorForUserMessage(sanitized);
    const initialContinuation = this.maybeCreateInitialToolTailContinuation();
    
    // Log message structure for debugging
    console.log('[LiveRuntime] startPrompt called:', {
      role: sanitized.role,
      contentType: Array.isArray(sanitized.content) ? 'array' : typeof sanitized.content,
      contentLength: Array.isArray(sanitized.content) ? sanitized.content.length : sanitized.content.length,
      contentTypes: Array.isArray(sanitized.content) 
        ? sanitized.content.map((c: { type: string }) => c.type) 
        : 'string',
      hasImage: Array.isArray(sanitized.content) 
        ? sanitized.content.some((c: { type: string }) => c.type === 'image')
        : false,
      timestamp: sanitized.timestamp,
      syntheticContinuationCount: this.syntheticContinuationCount,
    });
    
    this.touch();
    this.options.resetToolLoopGuard?.();
    this.abortRequested = false;
    this.isRunning = true;
    this.publishStatus();

    const effectiveSystemPrompt = this.getEffectiveSystemPrompt();
    if (this.agent.state.systemPrompt !== effectiveSystemPrompt) {
      this.agent.state.systemPrompt = effectiveSystemPrompt;
    }

    // Apply planning mode tool filter
    if (this.planningMode) {
      this.agent.state.tools = filterToolsForPlanningMode(this.tools);
    } else {
      this.agent.state.tools = this.tools;
    }

    const prompts = initialContinuation ? [initialContinuation, sanitized] : sanitized;
    void this.agent.prompt(prompts).catch(async (error) => {
      this.publishError(error);
      await this.persistMessagesOnError();
    });
  }

  async onAgentEvent(event: AgentEvent) {
    this.touch();
    normalizeAgentEventErrors(event, this.model);

    if (event.type === 'message_start' && event.message?.role === 'assistant') {
      this.thinkingFilterState = createThinkingFilterState();
    }

    if (event.type === 'message_start' && isUserMessage(event.message)) {
      this.consumeQueuedMessage(event.message);
      const signature = getMessageSignature(event.message);
      if (signature !== this.currentUserPromptSignature) {
        this.resetRunSupervisorForUserMessage(event.message);
      }
    }

    if (event.type === 'message_update' && event.assistantMessageEvent) {
      const eventType = event.assistantMessageEvent.type;
      if (eventType === 'thinking_start' || eventType === 'thinking_delta' || eventType === 'thinking_end') {
        this.publishStatus();
        return;
      }
      if (eventType === 'text_delta') {
        const rawDelta = event.assistantMessageEvent.delta || '';
        if (rawDelta) {
          const filtered = filterThinkingChunk(rawDelta, this.thinkingFilterState);
          this.thinkingFilterState = filtered.state;
          if (filtered.text) {
            const filteredEvent: typeof event = {
              ...event,
              assistantMessageEvent: {
                ...event.assistantMessageEvent,
                delta: filtered.text,
              },
            };
            void getEmitter().then((emitter) => {
              emitter.emitEvent(this.sessionId, this.userId, filteredEvent as Record<string, unknown>);
            }).catch(() => {});
          }
        }
        this.publishStatus();
        return;
      }
    }

    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const flushed = flushThinkingFilter(this.thinkingFilterState);
      this.thinkingFilterState = createThinkingFilterState();
      if (flushed.text) {
        const syntheticDelta: AgentEvent = {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: flushed.text,
            partial: event.message,
          },
          message: event.message,
        };
        void getEmitter().then((emitter) => {
          emitter.emitEvent(this.sessionId, this.userId, syntheticDelta as Record<string, unknown>);
        }).catch(() => {});
      }
    }

    if (event.type === 'tool_execution_start') {
      this.activeTool = {
        toolCallId: event.toolCallId,
        name: event.toolName,
      };
    }

    if (event.type === 'tool_execution_end') {
      if (this.activeTool?.toolCallId === event.toolCallId) {
        this.activeTool = null;
      }
    }

    if (event.type === 'turn_end') {
      await this.handleTurnEnd(event);
    }

    if (event.type === 'agent_end') {
      await this.handleAgentEnd();
    }

    if (event.type !== 'agent_end') {
      void getEmitter().then((emitter) => {
        emitter.emitEvent(this.sessionId, this.userId, event as Record<string, unknown>);
      }).catch(() => {
        // Non-critical: WebSocket emission failure should not break runtime
      });
    }

    this.publishStatus();
  }

  async transformContext(messages: AgentMessage[], signal?: AbortSignal) {
    const result = await preparePiHistoryContext({
      messages,
      summary: this.summary,
      systemPromptTokens: estimateTextTokens(this.getEffectiveSystemPrompt()),
      model: this.model,
      toolCount: this.tools.length,
      sessionId: this.sessionId,
      signal,
    });

    const previousSummaryThroughTimestamp = this.summary.summaryThroughTimestamp ?? null;
    const previousSummaryUpdatedAt = this.summary.summaryUpdatedAt?.getTime() ?? null;
    this.summary = result.summary;
    this.lastComposition = result.composition;
    const nextSummaryThroughTimestamp = result.summary.summaryThroughTimestamp ?? null;
    const nextSummaryUpdatedAt = result.summary.summaryUpdatedAt?.getTime() ?? null;

    if (
      result.summaryUpdated &&
      (nextSummaryThroughTimestamp !== previousSummaryThroughTimestamp || nextSummaryUpdatedAt !== previousSummaryUpdatedAt) &&
      (result.composition.includedSummary || result.composition.omittedMessages.length > 0)
    ) {
      this.recordCompaction('automatic', result.composition);
    }

    this.publishStatus();
    return this.injectRuntimeContext(result.composition.llmMessages);
  }

  private createQueueEntry(message: Extract<AgentMessage, { role: 'user' }>) {
    return {
      id: `queued-${message.timestamp}-${Math.random().toString(36).slice(2, 10)}`,
      preview: buildQueuePreview(message),
      signature: getMessageSignature(message),
      message,
    };
  }

  private consumeQueuedMessage(message: Extract<AgentMessage, { role: 'user' }>) {
    const signature = getMessageSignature(message);
    const steeringIndex = this.steeringQueue.findIndex((entry) => entry.signature === signature);
    if (steeringIndex !== -1) {
      this.steeringQueue.splice(steeringIndex, 1);
      return;
    }

    const followUpIndex = this.followUpQueue.findIndex((entry) => entry.signature === signature);
    if (followUpIndex !== -1) {
      this.followUpQueue.splice(followUpIndex, 1);
    }
  }

  private async handleTurnEnd(event: RuntimeTurnEndEvent) {
    this.maybeQueueContinuationAfterTurn(event);
    this.lastTurnDiagnostics = this.buildTurnDiagnostics(event);

    try {
      const persistedCount = await this.persistMessages('turn_end');
      if (persistedCount > 0) {
        console.log(`[LiveRuntime] Incremental save after turn_end: ${persistedCount} messages for session ${this.sessionId}`);
      }
    } catch (error) {
      console.error('[LiveRuntime] Failed to incrementally save after turn_end:', error);
    }
  }

  private async handleAgentEnd() {
    this.activeTool = null;
    this.abortRequested = false;
    this.isRunning = false;
    let persistedCount = 0;
    let persistError: unknown = null;

    try {
      persistedCount = await this.persistMessages('agent_end');
    } catch (error) {
      persistError = error;
      console.error('[LiveRuntime] Failed to persist final messages after agent_end:', error);
      this.publishError(error);
    }

    this.lastComposition = null;
    this.publishStatus();
    
    // Emit message_saved event AFTER everything is saved to database
    // This allows notification system to read from DB without race conditions
    const allMessages = this.agent.state.messages.slice();
    const lastPersistedMessage = allMessages[allMessages.length - 1];
    if (!persistError && lastPersistedMessage && lastPersistedMessage.role === 'assistant') {
      try {
        const { getPiRuntimeEventEmitter } = await import('./runtime-event-emitter');
        const emitter = getPiRuntimeEventEmitter();
        emitter.emitEvent(this.sessionId, this.userId, {
          type: 'message_saved',
          message: lastPersistedMessage,
          timestamp: Date.now(),
        });
        console.log(`[LiveRuntime] Emitted message_saved event for session ${this.sessionId}`);
      } catch (error) {
        console.error('[LiveRuntime] Error emitting message_saved event:', error);
      }
    }

    if (persistedCount > 0) {
      console.log(`[LiveRuntime] Final save after agent_end: ${persistedCount} messages for session ${this.sessionId}`);
    }

    if (this.lastTurnDiagnostics) {
      console.log('[LiveRuntime] agent_end diagnostics:', {
        sessionId: this.sessionId,
        ...this.lastTurnDiagnostics,
      });
    }

    if (this.pendingReplace) {
      const replacement = this.pendingReplace.message;
      this.pendingReplace = null;
      this.startPrompt(replacement);
    }
  }

  private publish(event: PiRuntimeStreamEvent) {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  private publishStatus() {
    const status = this.getStatus();
    const event: RuntimeStatusEvent = {
      type: 'runtime_status',
      status,
    };

    this.publish(event);

    const signature = getRuntimeStatusSignature(status);
    if (signature === this.lastBroadcastStatusSignature) {
      return;
    }

    this.lastBroadcastStatusSignature = signature;
    this.emitRuntimeEvent(event);
  }

  private emitRuntimeEvent(event: PiRuntimeStreamEvent): void {
    void getEmitter().then((emitter) => {
      emitter.emitEvent(this.sessionId, this.userId, event as unknown as Record<string, unknown>);
    }).catch(() => {
      // Non-critical: WebSocket emission failure should not break runtime.
    });
  }

  private recordCompaction(kind: 'manual' | 'automatic', composition: PiHistoryComposition) {
    this.lastCompactionAt = new Date();
    this.lastCompactionKind = kind;
    this.lastCompactionOmittedCount = composition.omittedMessages.length;
    this.publish({
      type: 'context_compacted',
      timestamp: this.lastCompactionAt.toISOString(),
      kind,
      omittedMessageCount: composition.omittedMessages.length,
      includedSummary: composition.includedSummary,
    });
    this.agent.state.messages = [
      ...this.agent.state.messages,
      createCompactBreakMessage(kind, this.lastCompactionAt.toISOString(), composition.omittedMessages.length),
    ];
  }

  private async persistMessagesOnError() {
    try {
      const persistedCount = await this.persistMessages('error');
      if (persistedCount > 0) {
        console.log(`[LiveRuntime] Saved ${persistedCount} messages after error for session ${this.sessionId}`);
      }
    } catch (saveError) {
      console.error('[LiveRuntime] Failed to persist messages after error:', saveError);
    }
    this.isRunning = false;
    this.activeTool = null;
    this.abortRequested = false;
    this.lastComposition = null;
    this.publishStatus();
  }

  private publishError(error: unknown) {
    const event: RuntimeErrorEvent = {
      type: 'error',
      error: getErrorMessage(error, this.model),
    };
    this.publish(event);
    this.emitRuntimeEvent(event);
  }

  dispose(): void {
    if (this.agentUnsubscribe) {
      this.agentUnsubscribe();
      this.agentUnsubscribe = null;
    }
    this.subscribers.clear();
  }

  private async persistMessages(reason: 'turn_end' | 'agent_end' | 'error'): Promise<number> {
    if (this.persistLock) {
      this.persistPending = reason;
      return 0;
    }
    this.persistLock = true;
    try {
      const allMessages = this.agent.state.messages.slice();
      const startIndex = this.lastPersistedLength;

      if (allMessages.length <= startIndex) {
        return 0;
      }

      await savePiSession(
        this.sessionId,
        this.userId,
        this.provider,
        this.model.id,
        allMessages,
        this.summary,
        { agentId: this.agentId, persistedLength: startIndex },
      );

      const newMessages = allMessages.slice(startIndex);
      if (newMessages.length > 0) {
        await persistPiUsageEvents({
          sessionId: this.sessionId,
          userId: this.userId,
          messages: newMessages,
        });
      }

      this.lastPersistedLength = allMessages.length;
      return newMessages.length;
    } catch (error) {
      console.error(`[LiveRuntime] Failed to persist messages during ${reason}:`, error);
      throw error;
    } finally {
      this.persistLock = false;
      if (this.persistPending) {
        const pendingReason = this.persistPending;
        this.persistPending = null;
        return this.persistMessages(pendingReason);
      }
    }
  }
}

async function createRuntime(sessionId: string, userId: string): Promise<LivePiRuntime> {
  const sessionRecord = await db.query.piSessions.findFirst({
    where: and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, userId)),
  });

  const agentId = sessionRecord?.agentId ?? DEFAULT_AGENT_ID;
  const effectiveConfig = await resolveAgentRuntimeConfig(agentId);
  const provider = sessionRecord?.provider || effectiveConfig.activeProvider;
  const providerThinkingLevel = effectiveConfig.piConfig.providers[provider]?.thinking || effectiveConfig.thinkingLevel || 'off';
  const thinkingLevel = (sessionRecord?.thinkingLevel || providerThinkingLevel) as ThinkingLevel;
  const model = sessionRecord
    ? await resolvePiModel(sessionRecord.provider, sessionRecord.model)
    : effectiveConfig.model;
  const loadedSession = await loadPiSessionWithSummary(sessionId, userId, agentId);
  const initialMessages = loadedSession?.messages || [];
  const summary = loadedSession?.summary || {
    summaryText: null,
    summaryUpdatedAt: null,
    summaryThroughTimestamp: null,
    summaryThroughSequence: null,
  };
  const promptSnapshot = sessionRecord
    ? await ensurePiSessionSystemPromptSnapshot(sessionRecord)
    : await createPiSystemPromptSnapshot(agentId, { userId });
  const systemPrompt = promptSnapshot.systemPrompt;
  const tools = await getPiTools(userId, agentId, sessionId);
  const toolLoopGuard = createToolLoopGuard();

  const runtimeRef: { current: LivePiRuntime | null } = { current: null };
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel,
      tools,
      messages: initialMessages,
    },
    convertToLlm: async (messages) => normalizePiMessagesForLlm(messages.filter((m) => m.role !== 'compact-break' && m.role !== 'composio_auth_required')),
    transformContext: async (messages, signal) => {
      if (!runtimeRef.current) {
        throw new Error('PI runtime not initialized');
      }

      return runtimeRef.current.transformContext(messages, signal);
    },
    getApiKey: resolvePiApiKey,
    afterToolCall: async (context) => toolLoopGuard.afterToolCall(context),
    sessionId,
  });

  const runtime = new LivePiRuntime(
    {
      sessionId,
      userId,
      agentId,
      provider,
      model,
      systemPrompt,
      tools,
      summary,
      initialMessages,
    },
    agent,
    { resetToolLoopGuard: () => toolLoopGuard.reset() },
  );
  runtimeRef.current = runtime;

  const unsubscribe = agent.subscribe(async (event) => {
    await runtime.onAgentEvent(event);
  });
  runtime.agentUnsubscribe = unsubscribe;

  return runtime;
}

type RuntimeStore = {
  runtimes: Map<string, Promise<LivePiRuntime>>;
  cleanupStarted: boolean;
};

const globalStore = globalThis as typeof globalThis & {
  __canvasPiRuntimeStore?: RuntimeStore;
};

function getStore(): RuntimeStore {
  if (!globalStore.__canvasPiRuntimeStore) {
    globalStore.__canvasPiRuntimeStore = {
      runtimes: new Map<string, Promise<LivePiRuntime>>(),
      cleanupStarted: false,
    };
  }

  const store = globalStore.__canvasPiRuntimeStore;
  if (!store.cleanupStarted) {
    store.cleanupStarted = true;
    setInterval(() => {
      const now = Date.now();
      const resolved: Array<{ key: string; runtime: LivePiRuntime }> = [];
      void Promise.allSettled(
        [...store.runtimes.entries()].map(async ([key, runtimePromise]) => {
          try {
            const runtime = await runtimePromise;
            if (runtime.isExpired(now)) {
              runtime.dispose();
              store.runtimes.delete(key);
            } else {
              resolved.push({ key, runtime });
            }
          } catch {
            store.runtimes.delete(key);
          }
        }),
      ).then(() => {
        if (store.runtimes.size > MAX_RUNTIME_INSTANCES) {
          resolved.sort((a, b) => a.runtime.getLastAccessAt() - b.runtime.getLastAccessAt());
          const excess = store.runtimes.size - MAX_RUNTIME_INSTANCES;
          for (let i = 0; i < excess; i++) {
            const entry = resolved[i];
            if (entry) {
              store.runtimes.delete(entry.key);
              try { entry.runtime.dispose(); } catch { /* ignore */ }
            }
          }
        }
      });
    }, CLEANUP_INTERVAL_MS).unref?.();
  }

  return store;
}

function getRuntimeKey(sessionId: string, userId: string) {
  return `${userId}:${sessionId}`;
}

export async function getOrCreatePiRuntime(sessionId: string, userId: string) {
  const store = getStore();
  const key = getRuntimeKey(sessionId, userId);
  const existing = store.runtimes.get(key);
  if (existing) {
    const runtime = await existing;
    runtime.touch();
    return runtime;
  }

  const runtimePromise = createRuntime(sessionId, userId);
  store.runtimes.set(key, runtimePromise);

  try {
    const runtime = await runtimePromise;
    runtime.touch();
    return runtime;
  } catch (error) {
    store.runtimes.delete(key);
    throw error;
  }
}

export async function dispatchPiRuntimeUserMessage(
  sessionId: string,
  userId: string,
  message: Extract<AgentMessage, { role: 'user' }>,
  context?: PiRuntimePromptContext,
  runtimeInstance?: PiRuntimePromptDispatchTarget,
) {
  const runtime = runtimeInstance ?? (await getOrCreatePiRuntime(sessionId, userId));
  applyPiRuntimePromptContext(runtime, context);
  await runtime.reloadTools();
  runtime.startPrompt(message);
  return runtime;
}

export async function getExistingPiRuntime(sessionId: string, userId: string) {
  const store = getStore();
  const runtime = store.runtimes.get(getRuntimeKey(sessionId, userId));
  if (!runtime) {
    return null;
  }

  const resolved = await runtime;
  resolved.touch();
  return resolved;
}

export async function getExistingPiRuntimeStatuses(
  sessionIds: string[],
  userId: string,
): Promise<Map<string, PiRuntimeStatus>> {
  const store = getStore();
  const uniqueSessionIds = Array.from(new Set(sessionIds.filter(Boolean)));
  const entries = await Promise.all(uniqueSessionIds.map(async (sessionId) => {
    const key = getRuntimeKey(sessionId, userId);
    const runtimePromise = store.runtimes.get(key);
    if (!runtimePromise) {
      return null;
    }

    try {
      const runtime = await runtimePromise;
      runtime.touch();
      return [sessionId, runtime.getStatus()] as const;
    } catch {
      store.runtimes.delete(key);
      return null;
    }
  }));

  return new Map(entries.filter((entry): entry is readonly [string, PiRuntimeStatus] => entry !== null));
}

export async function invalidatePiRuntime(sessionId: string, userId: string) {
  const store = getStore();
  const key = getRuntimeKey(sessionId, userId);
  const runtimePromise = store.runtimes.get(key);
  store.runtimes.delete(key);

  if (!runtimePromise) {
    return false;
  }

  try {
    const runtime = await runtimePromise;
    if (runtime.getStatus().canAbort) {
      await runtime.abort();
    }
    runtime.dispose();
  } catch (error) {
    console.warn('[LiveRuntime] Failed to dispose invalidated runtime:', error);
  }

  return true;
}

export async function getPiRuntimeStatus(sessionId: string, userId: string): Promise<PiRuntimeStatus | null> {
  const existing = await getExistingPiRuntime(sessionId, userId);
  if (existing) {
    return existing.getStatus();
  }

  const sessionRecord = await db.query.piSessions.findFirst({
    where: and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, userId)),
  });

  if (!sessionRecord) {
    return null;
  }

  const loadedSession = await loadPiSessionWithSummary(sessionId, userId, sessionRecord.agentId);
  const messages = loadedSession?.messages || [];
  const summary = loadedSession?.summary || {
    summaryText: null,
    summaryUpdatedAt: null,
    summaryThroughTimestamp: null,
    summaryThroughSequence: null,
  };
  const promptSnapshot = await ensurePiSessionSystemPromptSnapshot(sessionRecord);
  const systemPrompt = promptSnapshot.systemPrompt;
  const tools = await getPiTools(userId, sessionRecord.agentId, sessionId);
  const model = await resolvePiModel(sessionRecord.provider, sessionRecord.model);
  const composition = composePiHistoryForLlm({
    messages,
    summary,
    systemPromptTokens: estimateTextTokens(systemPrompt),
    contextWindow: model.contextWindow,
    modelMaxTokens: model.maxTokens,
    toolCount: tools.length,
  });

  return {
    sessionId,
    phase: 'idle',
    activeTool: null,
    pendingToolCalls: 0,
    followUpQueue: [],
    steeringQueue: [],
    canAbort: false,
    contextWindow: model.contextWindow,
    estimatedHistoryTokens: composition.estimatedHistoryTokens,
    availableHistoryTokens: composition.availableHistoryTokens,
    contextUsagePercent: toPercent(composition.estimatedHistoryTokens, composition.availableHistoryTokens),
    includedSummary: composition.includedSummary,
    omittedMessageCount: composition.omittedMessages.length,
    summaryUpdatedAt: summary.summaryUpdatedAt ? summary.summaryUpdatedAt.toISOString() : null,
    lastCompactionAt: summary.summaryUpdatedAt ? summary.summaryUpdatedAt.toISOString() : null,
    lastCompactionKind: summary.summaryUpdatedAt ? 'automatic' : null,
    lastCompactionOmittedCount: summary.summaryUpdatedAt ? composition.omittedMessages.length : 0,
  };
}
