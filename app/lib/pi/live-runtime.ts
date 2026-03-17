import 'server-only';

import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';

import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { loadManagedAgentSystemPrompt } from '@/app/lib/agents/system-prompt';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { resolvePiApiKey } from '@/app/lib/pi/api-key-resolver';
import {
  composePiHistoryForLlm,
  estimateTextTokens,
  type PiHistoryComposition,
  type PiSessionSummaryState,
} from '@/app/lib/pi/history-budget';
import { filterImagesForNonVisionModel, normalizePiMessagesForLlm } from '@/app/lib/pi/message-normalization';
import { resolveActivePiModel, resolvePiModel } from '@/app/lib/pi/model-resolver';
import { preparePiHistoryContext } from '@/app/lib/pi/session-summary';
import { loadPiSessionWithSummary, savePiSession } from '@/app/lib/pi/session-store';
import { getPiTools } from '@/app/lib/pi/tool-registry';
import { persistPiUsageEvents } from '@/app/lib/pi/usage-events';
import { and, eq } from 'drizzle-orm';

const IDLE_TTL_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

type RuntimePhase = 'idle' | 'streaming' | 'running_tool' | 'aborting';

type QueueEntryPreview = {
  id: string;
  text: string;
  attachmentCount: number;
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

type RuntimeSubscriber = (event: PiRuntimeStreamEvent) => void;

type RuntimeQueueEntry = {
  id: string;
  preview: QueueEntryPreview;
  message: Extract<AgentMessage, { role: 'user' }>;
  signature: string;
};

type RuntimeInit = {
  sessionId: string;
  userId: string;
  provider: string;
  model: Model<Api>;
  systemPrompt: string;
  tools: AgentTool[];
  summary: PiSessionSummaryState;
  initialMessages: AgentMessage[];
};

function isUserMessage(message: AgentMessage): message is Extract<AgentMessage, { role: 'user' }> {
  return message.role === 'user';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown agent error';
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
  };
}

function getMessageSignature(message: Extract<AgentMessage, { role: 'user' }>): string {
  return `${message.timestamp}:${extractUserMessageText(message)}:${countMessageAttachments(message)}`;
}

function sanitizeUserMessage(
  message: Extract<AgentMessage, { role: 'user' }>,
  model: Model<Api>,
): Extract<AgentMessage, { role: 'user' }> {
  if (model.input?.includes('image')) {
    return message;
  }

  return filterImagesForNonVisionModel([message])[0] as Extract<AgentMessage, { role: 'user' }>;
}

function toPercent(used: number, available: number): number {
  if (available <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round((used / available) * 100)));
}

class LivePiRuntime {
  readonly sessionId: string;
  readonly userId: string;
  readonly provider: string;
  readonly model: Model<Api>;
  readonly systemPrompt: string;
  readonly tools: AgentTool[];
  readonly agent: Agent;

  private readonly subscribers = new Set<RuntimeSubscriber>();
  private followUpQueue: RuntimeQueueEntry[] = [];
  private steeringQueue: RuntimeQueueEntry[] = [];
  private pendingReplace: RuntimeQueueEntry | null = null;
  private activeTool: { toolCallId: string; name: string } | null = null;
  private abortRequested = false;
  private summary: PiSessionSummaryState;
  private lastComposition: PiHistoryComposition | null = null;
  private lastPersistedLength: number;
  private lastAccessAt = Date.now();
  private lastCompactionAt: Date | null;
  private lastCompactionKind: 'manual' | 'automatic' | null;
  private lastCompactionOmittedCount: number;

  constructor(init: RuntimeInit, agent: Agent) {
    this.sessionId = init.sessionId;
    this.userId = init.userId;
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
  }

  touch() {
    this.lastAccessAt = Date.now();
  }

  isExpired(now: number) {
    return !this.agent.state.isStreaming && now - this.lastAccessAt > IDLE_TTL_MS;
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
    const composition =
      this.lastComposition ||
      composePiHistoryForLlm({
        messages: this.agent.state.messages,
        summary: this.summary,
        systemPromptTokens: estimateTextTokens(this.systemPrompt),
        contextWindow: this.model.contextWindow,
        modelMaxTokens: this.model.maxTokens,
        toolCount: this.tools.length,
      });

    return {
      sessionId: this.sessionId,
      phase: this.abortRequested
        ? 'aborting'
        : this.activeTool
          ? 'running_tool'
          : this.agent.state.isStreaming
            ? 'streaming'
            : 'idle',
      activeTool: this.activeTool,
      pendingToolCalls: this.agent.state.pendingToolCalls.size,
      followUpQueue: this.followUpQueue.map((entry) => entry.preview),
      steeringQueue: this.steeringQueue.map((entry) => entry.preview),
      canAbort: this.agent.state.isStreaming || this.abortRequested,
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
    if (!this.agent.state.isStreaming) {
      throw new Error('No active agent run to queue a follow-up message.');
    }

    const sanitized = sanitizeUserMessage(message, this.model);
    const entry = this.createQueueEntry(sanitized);
    this.followUpQueue.push(entry);
    this.touch();
    this.agent.followUp(entry.message);
    this.publishStatus();
    return this.getStatus();
  }

  async queueSteering(message: Extract<AgentMessage, { role: 'user' }>) {
    if (!this.agent.state.isStreaming) {
      throw new Error('No active agent run to steer.');
    }

    const sanitized = sanitizeUserMessage(message, this.model);
    const entry = this.createQueueEntry(sanitized);
    this.steeringQueue.push(entry);
    this.touch();
    this.agent.steer(entry.message);
    this.publishStatus();
    return this.getStatus();
  }

  async replace(message: Extract<AgentMessage, { role: 'user' }>) {
    const sanitized = sanitizeUserMessage(message, this.model);

    if (!this.agent.state.isStreaming) {
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
    if (this.agent.state.isStreaming) {
      this.abortRequested = true;
      this.touch();
      this.publishStatus();
      this.agent.abort();
    }

    return this.getStatus();
  }

  async compactNow() {
    if (this.agent.state.isStreaming) {
      throw new Error('Cannot compact while the agent is processing.');
    }

    const result = await preparePiHistoryContext({
      messages: this.agent.state.messages,
      summary: this.summary,
      systemPromptTokens: estimateTextTokens(this.systemPrompt),
      model: this.model,
      toolCount: this.tools.length,
      sessionId: this.sessionId,
    });

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
    );
    this.touch();
    this.publishStatus();
    return this.getStatus();
  }

  startPrompt(message: Extract<AgentMessage, { role: 'user' }>) {
    const sanitized = sanitizeUserMessage(message, this.model);
    this.touch();
    this.abortRequested = false;
    this.publishStatus();

    void this.agent.prompt(sanitized).catch((error) => {
      this.publishError(error);
    });
  }

  onAgentEvent(event: AgentEvent) {
    this.touch();

    if (event.type === 'message_start' && isUserMessage(event.message)) {
      this.consumeQueuedMessage(event.message);
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

    if (event.type === 'agent_end') {
      void this.handleAgentEnd();
    }

    this.publish(event);
    this.publishStatus();
  }

  async transformContext(messages: AgentMessage[], signal?: AbortSignal) {
    const result = await preparePiHistoryContext({
      messages,
      summary: this.summary,
      systemPromptTokens: estimateTextTokens(this.systemPrompt),
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
      (nextSummaryThroughTimestamp !== previousSummaryThroughTimestamp || nextSummaryUpdatedAt !== previousSummaryUpdatedAt) &&
      (result.composition.includedSummary || result.composition.omittedMessages.length > 0)
    ) {
      this.recordCompaction('automatic', result.composition);
    }

    this.publishStatus();
    return result.composition.llmMessages;
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

  private async handleAgentEnd() {
    this.activeTool = null;
    this.abortRequested = false;

    const allMessages = this.agent.state.messages.slice();
    const newMessages = allMessages.slice(this.lastPersistedLength);

    await savePiSession(
      this.sessionId,
      this.userId,
      this.provider,
      this.model.id,
      allMessages,
      this.summary,
    );

    if (newMessages.length > 0) {
      await persistPiUsageEvents({
        sessionId: this.sessionId,
        userId: this.userId,
        messages: newMessages,
      });
    }

    this.lastPersistedLength = allMessages.length;
    this.publishStatus();

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
    this.publish({
      type: 'runtime_status',
      status: this.getStatus(),
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
  }

  private publishError(error: unknown) {
    this.publish({
      type: 'error',
      error: getErrorMessage(error),
    });
  }
}

async function createRuntime(sessionId: string, userId: string): Promise<LivePiRuntime> {
  const sessionRecord = await db.query.piSessions.findFirst({
    where: and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, userId)),
  });

  const piConfig = await readPiRuntimeConfig();
  const provider = sessionRecord?.provider || piConfig.activeProvider;
  const model = sessionRecord
    ? await resolvePiModel(sessionRecord.provider, sessionRecord.model)
    : await resolveActivePiModel();
  const loadedSession = await loadPiSessionWithSummary(sessionId, userId);
  const initialMessages = loadedSession?.messages || [];
  const summary = loadedSession?.summary || {
    summaryText: null,
    summaryUpdatedAt: null,
    summaryThroughTimestamp: null,
  };
  const { systemPrompt } = await loadManagedAgentSystemPrompt();
  const tools = await getPiTools();

  const runtimeRef: { current: LivePiRuntime | null } = { current: null };
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: ((piConfig.providers[provider]?.thinking || 'off') as ThinkingLevel),
      tools,
      messages: initialMessages,
    },
    convertToLlm: async (messages) => normalizePiMessagesForLlm(messages),
    transformContext: async (messages, signal) => {
      if (!runtimeRef.current) {
        throw new Error('PI runtime not initialized');
      }

      return runtimeRef.current.transformContext(messages, signal);
    },
    getApiKey: resolvePiApiKey,
    sessionId,
  });

  const runtime = new LivePiRuntime(
    {
      sessionId,
      userId,
      provider,
      model,
      systemPrompt,
      tools,
      summary,
      initialMessages,
    },
    agent,
  );
  runtimeRef.current = runtime;

  agent.subscribe((event) => {
    runtime.onAgentEvent(event);
  });

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
      for (const [key, runtimePromise] of store.runtimes.entries()) {
        void runtimePromise.then((runtime) => {
          if (runtime.isExpired(now)) {
            store.runtimes.delete(key);
          }
        });
      }
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

  const loadedSession = await loadPiSessionWithSummary(sessionId, userId);
  const messages = loadedSession?.messages || [];
  const summary = loadedSession?.summary || {
    summaryText: null,
    summaryUpdatedAt: null,
    summaryThroughTimestamp: null,
  };
  const { systemPrompt } = await loadManagedAgentSystemPrompt();
  const tools = await getPiTools();
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
