import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  Agent,
  type AgentEvent,
  type AgentLoopTurnUpdate,
  type AgentMessage,
  type AgentTool,
  type PrepareNextTurnContext,
  type StreamFn,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Context, Message, Model } from '@earendil-works/pi-ai';

import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { resolveAndPinSessionRuntime } from '@/app/lib/agent-runtime-policy/provider-runtime';
import {
  createPiSystemPromptSnapshot,
  ensurePiSessionSystemPromptSnapshot,
  piSystemPromptSnapshotDbFields,
} from '@/app/lib/pi/system-prompt-snapshot';
import {
  composePiHistoryForLlm,
  estimateTextTokens,
  isPiHistoryCompositionSendable,
  type PiHistoryComposition,
  type PiHistorySelectionMode,
  type PiSessionSummaryState,
} from '@/app/lib/pi/history-budget';
import { preparePiFinalPayload } from '@/app/lib/pi/multimodal-preparation';
import { createPiRuntimeContextStatusProjection } from '@/app/lib/pi/runtime-context-status';
import { withPiProviderOverflowRecovery } from '@/app/lib/pi/provider-overflow-recovery';
import type { PiMessageNormalizationOptions } from '@/app/lib/pi/message-normalization';
import {
  createPiProviderUsageCalibrationEvidence,
  DEFAULT_PI_CONTEXT_BUDGET_POLICY,
  estimatePiToolSchemaTokens,
  getPiRequestOutputTokenCap,
  serializePiEffectiveToolSchemas,
  withPiRequestOutputTokenCap,
  type PiContextBudgetSnapshot,
  type PiProviderUsageCalibrationEvidence,
} from '@/app/lib/pi/context-budget';
import { MAX_LLM_HISTORY_BYTES } from '@/app/lib/pi/llm-payload-limits';
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
} from '@/app/lib/pi/model-resolver';
import {
  getPiFinalPayloadPressure,
  getPiFinalPayloadRetryLoad,
  inspectPiRuntimeCompactionPressure,
  preparePiHermesCompactionCandidate,
} from '@/app/lib/pi/compaction/runtime-engine';
import {
  getPiCompactionErrorDiagnostics,
  logPiCompactionDiagnostic,
} from '@/app/lib/pi/compaction/diagnostics';
import { sessionCompactionWarrantsAnotherPass } from '@/app/lib/pi/compaction/policy';
import {
  abortPiSessionCompaction,
  getActivePiSessionCompaction,
  invalidatePiSessionCompaction,
  runPiSessionCompaction,
  type PiCompactionCoordinatorPolicy,
  type PiCompactionCoordinatorResult,
} from '@/app/lib/pi/session-compaction-coordinator';
import { loadPiSessionWithSummary, savePiSession } from '@/app/lib/pi/session-store';
import { generatePendingPiSessionTitle } from '@/app/lib/pi/session-title-generator';
import { getPiTools } from '@/app/lib/pi/tool-registry';
import { filterToolsForPlanningMode } from '@/app/lib/pi/planning-mode';
import {
  appendEffectiveToolCapabilitiesPrompt,
  buildEffectiveToolManifest,
  effectiveToolManifestHas,
} from '@/app/lib/pi/effective-tool-manifest';
import { replaceNextTurnContext } from '@/app/lib/pi/next-turn-context';
import { getChannelSystemPromptBlock } from '@/app/lib/agents/channel-system-prompt';
import { formatZonedDateTimeForPrompt } from '@/app/lib/time-zones';
import { PLANNING_MODE_GUIDANCE } from '@/app/lib/agents/system-prompt-shared';
import { loadLatestPiSessionInputUsage, persistPiUsageEvents } from '@/app/lib/pi/usage-events';
import {
  getStudioOutputsRoot,
  resolveStudioFilePath,
  STUDIO_OUTPUTS_ROOT_DIR,
} from '@/app/lib/integrations/studio-workspace';
import { DEFAULT_AGENT_ID, normalizeStoredChannelId, WEB_CHANNEL_ID } from '@/app/lib/channels/constants';
import { buildWorkspaceFileTreePrompt } from '@/app/lib/agents/workspace-file-tree-context';
import { buildReferencedPluginRuntimeContext } from '@/app/lib/plugins/plugin-reference-context';
import { createToolLoopGuard } from '@/app/lib/pi/tool-loop-guard';
import {
  IDLE_RUNTIME_COMPACTION_STATUS,
  type RuntimeContextPressure,
  type RuntimeCompactionStatus,
} from '@/app/lib/chat/runtime-status';
import {
  createToolTailContinuationDecision,
  extractAgentMessageText,
  shouldContinueAfterIntermediateAck,
  type RuntimeContinuationDecision,
} from '@/app/lib/pi/run-continuation-guard';
import { and, eq } from 'drizzle-orm';
import {
  applyPiRuntimePromptContext,
  buildActiveWorkspacePromptBlock,
  type PiRuntimePromptContext,
  type RuntimePromptContextTarget,
} from '@/app/lib/pi/runtime-prompt-context';
import {
  cleanupAgentRuntimeTempDirs,
  getAgentRuntimeTempPromptBlock,
  resolveAgentRuntimeTempDir,
} from '@/app/lib/pi/agent-runtime-temp';
import {
  RuntimeMessageQueues,
  type RuntimeQueueEntry,
  type RuntimeQueuePreview,
} from '@/app/lib/pi/runtime-queue';
import { resolveAgentExecutionContextForSession } from '@/app/lib/pi/session-workspace-context';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { withPiSessionOperationLock } from '@/app/lib/pi/session-operation-lock';
import { createOperationTiming, type OperationTiming } from '@/app/lib/observability/operation-timing';
import { findUnambiguousOwnedPiSessionForRuntime } from '@/app/lib/pi/session-runtime-access';
import { buildBrowserRuntimeContextBlock } from '@/app/lib/pi/browser/runtime-context';
import { getBrowserRuntimeContextKey } from '@/app/lib/pi/browser/runtime';
import { subscribeBrowserSessionSnapshot } from '@/app/lib/pi/browser/session-state';
import { refreshBrowserSessionSnapshot } from '@/app/lib/pi/browser/session-state-service';
import type { BrowserSessionSnapshot } from '@/app/lib/pi/browser/types';
import type { BrowserToolMode } from '@/app/lib/pi/browser/tool';
import { buildMemoryPromptProjection } from '@/app/lib/memory/prompt-projection';

export type { PiRuntimePromptContext } from '@/app/lib/pi/runtime-prompt-context';

const IDLE_TTL_MS = 15 * 60 * 1000;
const IDLE_COMPACTION_DELAY_MS = 1_000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_RUNTIME_INSTANCES = 20;
const MAX_MESSAGE_CONTEXT_SNAPSHOTS = 64;
const RUNTIME_CONTEXT_VALUE_MAX_CHARS = 2_000;

function runtimeExecutionModeForSession(session: Pick<typeof piSessions.$inferSelect, 'sessionKind' | 'channelId'>) {
  if (session.sessionKind === 'delegation_worker') {
    return 'delegation' as const;
  }

  return normalizeStoredChannelId(session.channelId ?? 'app') === WEB_CHANNEL_ID
    ? 'interactive' as const
    : 'external_channel' as const;
}

function getStudioOutputReferencePaths(outputFilePath: string) {
  const normalizedOutputPath = outputFilePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const referencePath = normalizedOutputPath.startsWith('studio/')
    ? normalizedOutputPath
    : path.posix.join(STUDIO_OUTPUTS_ROOT_DIR, normalizedOutputPath);

  return {
    absolutePath: resolveStudioFilePath(referencePath, getStudioOutputsRoot())
      ?? path.join(getStudioOutputsRoot(), normalizedOutputPath),
    referencePath,
  };
}

function normalizeRuntimeContextValue(value: unknown, maxChars = RUNTIME_CONTEXT_VALUE_MAX_CHARS): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars).trimEnd()}...` : normalized;
}

function formatRuntimeContextValue(value: unknown, maxChars = RUNTIME_CONTEXT_VALUE_MAX_CHARS): string {
  return JSON.stringify(normalizeRuntimeContextValue(value, maxChars));
}

function formatRuntimeContextArray(values: unknown[], maxItems = 20): string {
  return JSON.stringify(
    values
      .map((value) => normalizeRuntimeContextValue(value, 240))
      .filter(Boolean)
      .slice(0, maxItems),
  );
}

function pushRuntimeContextLine(lines: string[], label: string, value: unknown, maxChars?: number) {
  const normalized = normalizeRuntimeContextValue(value, maxChars);
  if (normalized) {
    lines.push(`${label}: ${JSON.stringify(normalized)}`);
  }
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

export type PiRuntimeStatus = {
  sessionId: string;
  /** Monotonically increasing server revision for causally ordered UI state. */
  revision: number;
  browser?: BrowserSessionSnapshot;
  phase: RuntimePhase;
  activeTool: { toolCallId: string; name: string } | null;
  pendingToolCalls: number;
  followUpQueue: RuntimeQueuePreview[];
  steeringQueue: RuntimeQueuePreview[];
  canAbort: boolean;
  contextWindow: number;
  estimatedHistoryTokens: number;
  availableHistoryTokens: number;
  contextUsagePercent: number;
  finalRequestTokens?: number | null;
  finalRequestBudgetExceeded?: boolean;
  lastProviderInputTokens?: number | null;
  lastProviderInputAt?: string | null;
  nextRequestEstimatedTokens?: number | null;
  nextRequestBudgetExceeded?: boolean;
  nextRequestEstimateSource?: 'rough_estimate' | 'serialized_request' | null;
  contextPressure?: RuntimeContextPressure;
  includedSummary: boolean;
  omittedMessageCount: number;
  summaryUpdatedAt: string | null;
  lastCompactionAt: string | null;
  lastCompactionKind: 'manual' | 'automatic' | null;
  lastCompactionOmittedCount: number;
  compactionStatus: RuntimeCompactionStatus;
};

export type RuntimeStatusEvent = {
  type: 'runtime_status';
  status: PiRuntimeStatus;
};

export type ContextCompactedEvent = {
  type: 'context_compacted';
  attemptId: string;
  timestamp: string;
  kind: 'manual' | 'automatic';
  omittedMessageCount: number;
  includedSummary: boolean;
};

export type RuntimeErrorEvent = {
  type: 'error';
  error: string;
};

export type SessionTitleUpdatedEvent = {
  type: 'session_title_updated';
  title: string;
  titleGenerationState: string | null;
  timestamp: number;
};

export type PiRuntimeStreamEvent = AgentEvent | RuntimeStatusEvent | ContextCompactedEvent | RuntimeErrorEvent | SessionTitleUpdatedEvent;
type RuntimeSubscriber = (event: PiRuntimeStreamEvent) => void;

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
  executionContext: AgentExecutionContext;
  workspaceFileTreePromptBlock: string;
  memoryPromptBlock: string;
  browserSnapshot: BrowserSessionSnapshot;
  imageNormalizationOptions: PiMessageNormalizationOptions;
  requestOutputTokenCap: number;
  lastProviderInputUsage: {
    inputTokens: number;
    assistantTimestamp: Date;
  } | null;
};

type RuntimeOptions = {
  resetToolLoopGuard?: () => void;
  requiresRuntimeRecreation?: () => boolean;
  summaryStreamFn?: StreamFn;
  compactionPolicy?: PiCompactionCoordinatorPolicy;
  idleCompaction?: boolean;
  idleCompactionDelayMs?: number;
};

type PreparedRuntimePayload = {
  sourceMessages: AgentMessage[];
  messages: Message[];
  budgetSnapshot: PiContextBudgetSnapshot;
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

function buildQueuePreview(message: Extract<AgentMessage, { role: 'user' }>): RuntimeQueuePreview {
  const clientMessageId = typeof (message as { clientMessageId?: unknown }).clientMessageId === 'string'
    ? (message as unknown as { clientMessageId: string }).clientMessageId.trim() || undefined
    : undefined;
  return {
    id: `queue-${message.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    text: extractUserMessageText(message),
    attachmentCount: countMessageAttachments(message),
    ...(clientMessageId ? { clientMessageId } : {}),
    messageTimestamp: message.timestamp,
    signature: getMessageSignature(message),
  };
}

function getMessageSignature(message: Extract<AgentMessage, { role: 'user' }>): string {
  const clientMessageId = typeof (message as { clientMessageId?: unknown }).clientMessageId === 'string'
    ? (message as unknown as { clientMessageId: string }).clientMessageId.trim()
    : '';
  return `${clientMessageId}:${message.timestamp}:${extractUserMessageText(message)}:${countMessageAttachments(message)}`;
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
    finalRequestTokens: status.finalRequestTokens,
    finalRequestBudgetExceeded: status.finalRequestBudgetExceeded,
    lastProviderInputTokens: status.lastProviderInputTokens,
    lastProviderInputAt: status.lastProviderInputAt,
    nextRequestEstimatedTokens: status.nextRequestEstimatedTokens,
    nextRequestBudgetExceeded: status.nextRequestBudgetExceeded,
    nextRequestEstimateSource: status.nextRequestEstimateSource,
    contextPressure: status.contextPressure,
    includedSummary: status.includedSummary,
    omittedMessageCount: status.omittedMessageCount,
    summaryUpdatedAt: status.summaryUpdatedAt,
    lastCompactionAt: status.lastCompactionAt,
    lastCompactionKind: status.lastCompactionKind,
    lastCompactionOmittedCount: status.lastCompactionOmittedCount,
    compactionStatus: status.compactionStatus,
    browser: status.browser,
  });
}

type PiRuntimePromptDispatchTarget = RuntimePromptContextTarget & {
  reloadTools: () => Promise<void>;
  refreshWorkspaceFileTreePrompt: () => Promise<void>;
  refreshMemoryPrompt: () => Promise<void>;
  startPrompt: (message: Extract<AgentMessage, { role: 'user' }>) => void;
};

export class LivePiRuntime {
  readonly sessionId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly provider: string;
  readonly model: Model<Api>;
  private systemPrompt: string;
  private tools: AgentTool[];
  private readonly executionContext: AgentExecutionContext;
  private workspaceFileTreePromptBlock: string;
  private memoryPromptBlock: string;
  readonly agent: Agent;

  private readonly subscribers = new Set<RuntimeSubscriber>();
  private readonly messageQueues = new RuntimeMessageQueues();
  private pendingReplace: RuntimeQueueEntry | null = null;
  private activeTool: { toolCallId: string; name: string } | null = null;
  private abortRequested = false;
  private isRunning = false;
  private summary: PiSessionSummaryState;
  private lastComposition: PiHistoryComposition | null = null;
  private lastFinalPayloadBudgetSnapshot: PiContextBudgetSnapshot | null = null;
  private preparedRuntimePayload: PreparedRuntimePayload | null = null;
  private lastProviderUsageCalibration: PiProviderUsageCalibrationEvidence | null = null;
  private lastProviderInputUsage: RuntimeInit['lastProviderInputUsage'];
  private readonly imageNormalizationOptions: PiMessageNormalizationOptions;
  private readonly requestOutputTokenCap: number;
  private lastPersistedLength: number;
  private messageSequenceCheckpoint: number;
  private compactionGeneration = 0;
  private lastAccessAt = Date.now();
  private lastCompactionAt: Date | null;
  private lastCompactionKind: 'manual' | 'automatic' | null;
  private lastCompactionOmittedCount: number;
  private compactionStatus: RuntimeCompactionStatus = IDLE_RUNTIME_COMPACTION_STATUS;
  private channelId: string | null = null;
  private timeZoneContext: { timeZone: string; currentTime: string } | null = null;
  private activeFileContext: string | null = null;
  private planningMode = false;
  private pageContext: string | null = null;
  private notebookContext: PiRuntimePromptContext['notebookContext'] | null = null;
  private readonly messageContextSnapshots = new Map<string, PiRuntimePromptContext>();
  private studioContext: PiRuntimePromptContext['studioContext'] | null = null;
  private emailContext: PiRuntimePromptContext['emailContext'] | null = null;
  private workspaceContext: PiRuntimePromptContext['workspace'] | null = null;
  private persistPromise: Promise<number> | null = null;
  private lastBroadcastStatusSignature: string | null = null;
  private statusRevision = 0;
  private currentUserPromptText = '';
  private currentUserPromptSignature: string | null = null;
  private syntheticContinuationCount = 0;
  private lastContinuationReason: RuntimeContinuationReason | null = null;
  private pendingInitialToolTailContinuation = false;
  private lastTurnDiagnostics: RuntimeTurnDiagnostics | null = null;
  private thinkingFilterState: ThinkingFilterState = createThinkingFilterState();
  private disposed = false;
  private idleCompactionTimer: ReturnType<typeof setTimeout> | null = null;
  private activePromptTiming: OperationTiming | null = null;
  private firstAssistantEventLogged = false;
  private firstTextDeltaLogged = false;
  private browserSnapshot: BrowserSessionSnapshot | null;
  private browserToolMode: BrowserToolMode;
  private browserToolsNeedRefresh = false;
  private browserSnapshotUnsubscribe: (() => void) | null = null;
  agentUnsubscribe: (() => void) | null = null;

  constructor(init: RuntimeInit, agent: Agent, private readonly options: RuntimeOptions = {}) {
    this.sessionId = init.sessionId;
    this.userId = init.userId;
    this.statusRevision = currentRuntimeStatusRevision(init.sessionId, init.userId);
    this.agentId = init.agentId;
    this.provider = init.provider;
    this.model = init.model;
    this.systemPrompt = init.systemPrompt;
    this.tools = init.tools;
    this.executionContext = init.executionContext;
    this.workspaceFileTreePromptBlock = init.workspaceFileTreePromptBlock;
    this.memoryPromptBlock = init.memoryPromptBlock;
    this.imageNormalizationOptions = init.imageNormalizationOptions;
    this.requestOutputTokenCap = init.requestOutputTokenCap;
    this.lastProviderInputUsage = init.lastProviderInputUsage;
    this.summary = init.summary;
    this.lastPersistedLength = init.initialMessages.length;
    this.messageSequenceCheckpoint = init.initialMessages.length;
    this.agent = agent;
    this.lastCompactionAt = init.summary.summaryUpdatedAt;
    this.lastCompactionKind = init.summary.summaryUpdatedAt ? 'automatic' : null;
    this.lastCompactionOmittedCount = 0;
    this.pendingInitialToolTailContinuation = createToolTailContinuationDecision(init.initialMessages) !== null;
    this.browserSnapshot = init.browserSnapshot.running ? init.browserSnapshot : null;
    this.browserToolMode = this.browserSnapshot ? 'active' : 'dormant';
    this.browserSnapshotUnsubscribe = subscribeBrowserSessionSnapshot(
      getBrowserRuntimeContextKey(this.executionContext),
      (snapshot) => {
        if (this.disposed) return;
        const nextMode: BrowserToolMode = snapshot.running ? 'active' : 'dormant';
        this.browserSnapshot = snapshot.running ? snapshot : null;
        this.invalidateContextBudget();
        if (nextMode !== this.browserToolMode) {
          this.browserToolsNeedRefresh = true;
        }
        this.publishStatus();
      },
    );
  }

  private invalidateContextBudget(): void {
    this.compactionGeneration += 1;
    invalidatePiSessionCompaction(this.getCompactionScope());
    this.lastComposition = null;
    this.lastFinalPayloadBudgetSnapshot = null;
    this.preparedRuntimePayload = null;
  }

  private getCompactionScope() {
    return {
      sessionId: this.sessionId,
      userId: this.userId,
      agentId: this.agentId,
      workspaceId: this.executionContext.workspaceId ?? null,
    };
  }

  private createCompactionGeneration(runtimeContext: string | null): string {
    const hash = createHash('sha256');
    hash.update(JSON.stringify({
      generation: this.compactionGeneration,
      provider: this.provider,
      model: this.model.id,
      contextWindow: this.model.contextWindow,
      modelMaxTokens: this.model.maxTokens,
      requestOutputTokenCap: this.requestOutputTokenCap,
      summaryRevision: this.summary.summaryRevision,
      summaryThroughSequence: this.summary.summaryThroughSequence,
      messageSequenceCheckpoint: this.messageSequenceCheckpoint,
      workspaceId: this.executionContext.workspaceId ?? null,
    }));
    hash.update(this.getEffectiveSystemPrompt());
    hash.update(serializePiEffectiveToolSchemas(this.getEffectiveTools()));
    hash.update(runtimeContext ?? '');
    return hash.digest('hex');
  }

  private composeHistory(
    messages: AgentMessage[],
    additionalContextTokens: number,
    selectionMode: PiHistorySelectionMode = 'automatic',
  ): PiHistoryComposition {
    return composePiHistoryForLlm({
      messages,
      summary: this.summary,
      systemPromptTokens: estimateTextTokens(this.getEffectiveSystemPrompt()),
      contextWindow: this.model.contextWindow,
      modelMaxTokens: this.model.maxTokens,
      requestOutputTokens: this.requestOutputTokenCap,
      toolTokens: estimatePiToolSchemaTokens(this.getEffectiveTools()),
      additionalContextTokens,
      selectionMode,
    });
  }

  private async coordinateCompaction(input: {
    kind: 'manual' | 'automatic';
    cause: NonNullable<RuntimeCompactionStatus['cause']>;
    bypassCooldown?: boolean;
    messages: AgentMessage[];
    additionalContextTokens: number;
    runtimeContext: string | null;
    signal?: AbortSignal;
    selectionMode?: 'automatic' | 'force';
    focusTopic?: string | null;
  }): Promise<PiCompactionCoordinatorResult> {
    await this.persistMessages('turn_end');
    const summarySnapshot = { ...this.summary };
    const generation = this.createCompactionGeneration(input.runtimeContext);
    const systemPromptTokens = estimateTextTokens(this.getEffectiveSystemPrompt());
    const toolTokens = estimatePiToolSchemaTokens(this.getEffectiveTools());
    const before = this.composeHistory(input.messages, input.additionalContextTokens);
    const activeAttempt = getActivePiSessionCompaction(this.getCompactionScope());
    const attemptId = activeAttempt?.attemptId ?? `compact-${randomUUID()}`;
    const ownsStatus = activeAttempt === null;
    const startedAt = Date.now();
    const diagnosticContext = {
      sessionId: this.sessionId,
      attemptId,
      trigger: input.kind,
      cause: input.cause,
      provider: this.provider,
      model: this.model.id,
    };
    logPiCompactionDiagnostic('info', 'attempt_started', {
      ...diagnosticContext,
      ownsStatus,
      bypassCooldown: input.bypassCooldown === true,
      selectionMode: input.selectionMode ?? 'automatic',
      messageCount: input.messages.length,
      additionalContextTokens: input.additionalContextTokens,
      systemPromptTokens,
      toolTokens,
      beforeEstimatedTokens: before.estimatedHistoryTokens,
      beforeEstimatedBytes: before.estimatedHistoryBytes,
      triggerTokens: before.triggerHistoryTokens,
      targetTokens: before.targetHistoryTokens,
      summaryRevision: summarySnapshot.summaryRevision,
      summaryThroughSequence: summarySnapshot.summaryThroughSequence,
      focusApplied: Boolean(input.focusTopic?.trim()),
    });
    if (ownsStatus) {
      this.compactionStatus = {
        state: 'running',
        attemptId,
        trigger: input.kind,
        cause: input.cause,
        reasonCode: null,
        retryAfter: null,
        omittedMessageCount: 0,
        beforeTokens: before.estimatedHistoryTokens,
        afterTokens: null,
        triggerTokens: before.triggerHistoryTokens,
        targetTokens: before.targetHistoryTokens,
        focusApplied: Boolean(input.focusTopic?.trim()),
      };
      this.publishStatus();
    }
    let result: PiCompactionCoordinatorResult;
    try {
      result = await runPiSessionCompaction({
        ...this.getCompactionScope(),
        trigger: input.kind,
        bypassCooldown: input.bypassCooldown,
        attemptId,
        generation,
        expectedSummaryRevision: summarySnapshot.summaryRevision,
        expectedThroughSequence: summarySnapshot.summaryThroughSequence,
        provider: this.provider,
        model: this.model.id,
        contractFingerprint: generation,
        metrics: {
          beforeEstimatedTokens: before.estimatedHistoryTokens,
          beforeEstimatedBytes: before.estimatedHistoryBytes,
          triggerTokens: before.triggerHistoryTokens,
          targetTokens: before.targetHistoryTokens,
        },
        policy: this.options.compactionPolicy,
        signal: input.signal,
        isGenerationCurrent: (candidateGeneration) => (
          !this.disposed
          && candidateGeneration === this.createCompactionGeneration(input.runtimeContext)
        ),
        prepareCandidate: (candidateSignal, reportProgress) => preparePiHermesCompactionCandidate({
          messages: input.messages.slice(),
          summary: summarySnapshot,
          systemPromptTokens,
          model: this.model,
          requestOutputTokens: this.requestOutputTokenCap,
          toolTokens,
          additionalContextTokens: input.additionalContextTokens,
          sessionId: this.sessionId,
          signal: candidateSignal,
          streamFn: this.options.summaryStreamFn,
          selectionMode: input.selectionMode ?? 'automatic',
          focusTopic: input.focusTopic,
          onSummaryProgress: (progress) => {
            reportProgress(progress);
            if (progress.status === 'started' || progress.status === 'completed') {
              logPiCompactionDiagnostic('info', 'summary_progress', {
                ...diagnosticContext,
                stage: progress.stage,
                status: progress.status,
                completed: progress.completed,
                total: progress.total,
              });
            }
          },
        }),
      });
    } catch (error) {
      logPiCompactionDiagnostic('error', 'attempt_threw', {
        ...diagnosticContext,
        durationMs: Date.now() - startedAt,
        ...getPiCompactionErrorDiagnostics(error),
      });
      throw error;
    }
    if (ownsStatus && this.compactionStatus.attemptId === result.attemptId) {
      this.compactionStatus = {
        state: result.state === 'cooldown_active'
          || result.state === 'breaker_active'
          || result.state === 'already_running'
          ? 'deferred'
          : result.state,
        attemptId: result.attemptId,
        trigger: input.kind,
        cause: input.cause,
        reasonCode: result.reasonCode ?? (result.state === 'already_running' ? 'already_running' : null),
        retryAfter: result.retryAt?.toISOString() ?? null,
        omittedMessageCount: result.composition?.omittedMessages.length ?? 0,
        beforeTokens: before.estimatedHistoryTokens,
        afterTokens: result.composition?.estimatedHistoryTokens ?? null,
        triggerTokens: result.composition?.triggerHistoryTokens ?? before.triggerHistoryTokens,
        targetTokens: result.composition?.targetHistoryTokens ?? before.targetHistoryTokens,
        focusApplied: Boolean(input.focusTopic?.trim()),
      };
      this.publishStatus();
    }
    const terminalLevel = result.state === 'succeeded' || result.state === 'no_op'
      ? 'info'
      : 'warn';
    logPiCompactionDiagnostic(terminalLevel, 'attempt_finished', {
      ...diagnosticContext,
      durationMs: Date.now() - startedAt,
      state: result.state,
      reasonCode: result.reasonCode ?? (result.state === 'already_running' ? 'already_running' : null),
      retryAt: result.retryAt?.toISOString() ?? null,
      beforeEstimatedTokens: before.estimatedHistoryTokens,
      afterEstimatedTokens: result.composition?.estimatedHistoryTokens ?? null,
      omittedMessageCount: result.composition?.omittedMessages.length ?? 0,
      triggerTokens: result.composition?.triggerHistoryTokens ?? before.triggerHistoryTokens,
      targetTokens: result.composition?.targetHistoryTokens ?? before.targetHistoryTokens,
      summaryUpdated: Boolean(result.summary),
    });
    return result;
  }

  private async buildFinalPayload(messages: AgentMessage[]): Promise<PreparedRuntimePayload> {
    const prepared = await preparePiFinalPayload({
      messages,
      model: this.model,
      effectiveInstructions: [{ role: 'system', content: this.getEffectiveSystemPrompt() }],
      effectiveTools: this.getEffectiveTools(),
      requestOutputTokenCap: this.requestOutputTokenCap,
      runtimeContractRevision: 'canvas-pi-runtime-v1',
    }, this.imageNormalizationOptions);
    this.lastFinalPayloadBudgetSnapshot = prepared.budgetSnapshot;
    return {
      sourceMessages: messages,
      messages: prepared.messages,
      budgetSnapshot: prepared.budgetSnapshot,
    };
  }

  private cachePreparedRuntimePayload(payload: PreparedRuntimePayload): void {
    this.preparedRuntimePayload = payload;
  }

  private isFinalPayloadSendable(snapshot: PiContextBudgetSnapshot): boolean {
    return !snapshot.payloadBudgetExceeded && !snapshot.contextBudgetExceeded;
  }

  async prepareFinalPayload(messages: AgentMessage[]): Promise<Message[]> {
    const cached = this.preparedRuntimePayload;
    const prepared = cached?.sourceMessages === messages
      ? cached
      : await this.buildFinalPayload(messages);
    this.preparedRuntimePayload = null;

    if (prepared.budgetSnapshot.payloadBudgetExceeded) {
      throw new Error(
        `The final request exceeds the ${Math.floor(MAX_LLM_HISTORY_BYTES / (1024 * 1024))}MB LLM transfer budget after image compression. `
        + 'Shorten the latest message or attachments.',
      );
    }
    if (prepared.budgetSnapshot.contextBudgetExceeded) {
      throw new Error(
        'The final serialized request exceeds the selected model context window after instructions, tools, provider overhead, output reserve, multimodal input, and safety margin.',
      );
    }

    return prepared.messages;
  }

  getContextBudgetEvidence(): Readonly<{
    snapshot: PiContextBudgetSnapshot | null;
    calibration: PiProviderUsageCalibrationEvidence | null;
  }> {
    return Object.freeze({
      snapshot: this.lastFinalPayloadBudgetSnapshot,
      calibration: this.lastProviderUsageCalibration,
    });
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

  getRuntimeTempDir() {
    return resolveAgentRuntimeTempDir({
      userId: this.userId,
      sessionId: this.sessionId,
      agentId: this.agentId,
      organizationId: this.workspaceContext?.organizationId ?? null,
    });
  }

  hasPendingReplace() {
    return this.pendingReplace !== null;
  }

  private get followUpQueue() {
    return this.messageQueues.followUps;
  }

  private get steeringQueue() {
    return this.messageQueues.steering;
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
        requestOutputTokens: this.requestOutputTokenCap,
        toolTokens: estimatePiToolSchemaTokens(this.tools),
        additionalContextTokens: this.getBrowserRuntimeContextTokenEstimate(),
      });
    }
    const composition = this.lastComposition;
    const finalPayloadBudget = this.lastFinalPayloadBudgetSnapshot;
    const hasPendingReplace = this.pendingReplace !== null;
    const exposeFinalPayloadBudget = Boolean(
      finalPayloadBudget
      && !this.abortRequested
      && !hasPendingReplace
      && (this.isRunning || !this.isFinalPayloadSendable(finalPayloadBudget)),
    );
    const contextStatus = createPiRuntimeContextStatusProjection({
      composition,
      contextWindow: this.model.contextWindow,
      finalSnapshot: exposeFinalPayloadBudget ? finalPayloadBudget : null,
    });

    return {
      sessionId: this.sessionId,
      revision: this.statusRevision,
      ...(this.browserSnapshot ? { browser: this.browserSnapshot } : {}),
      phase: this.abortRequested || hasPendingReplace
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
      canAbort: this.isRunning
        || this.abortRequested
        || hasPendingReplace
        || getActivePiSessionCompaction(this.getCompactionScope()) !== null,
      contextWindow: this.model.contextWindow,
      estimatedHistoryTokens: composition.estimatedHistoryTokens,
      availableHistoryTokens: composition.availableHistoryTokens,
      contextUsagePercent: toPercent(composition.estimatedHistoryTokens, composition.availableHistoryTokens),
      finalRequestTokens: exposeFinalPayloadBudget ? finalPayloadBudget!.estimatedTotalTokens : null,
      finalRequestBudgetExceeded: exposeFinalPayloadBudget
        ? !this.isFinalPayloadSendable(finalPayloadBudget!)
        : false,
      lastProviderInputTokens: this.lastProviderInputUsage?.inputTokens ?? null,
      lastProviderInputAt: this.lastProviderInputUsage?.assistantTimestamp.toISOString() ?? null,
      nextRequestEstimatedTokens: contextStatus.nextRequestEstimatedTokens,
      nextRequestBudgetExceeded: contextStatus.nextRequestBudgetExceeded,
      nextRequestEstimateSource: contextStatus.nextRequestEstimateSource,
      contextPressure: contextStatus.contextPressure,
      includedSummary: composition.includedSummary,
      omittedMessageCount: composition.omittedMessages.length,
      summaryUpdatedAt: this.summary.summaryUpdatedAt ? this.summary.summaryUpdatedAt.toISOString() : null,
      lastCompactionAt: this.lastCompactionAt ? this.lastCompactionAt.toISOString() : null,
      lastCompactionKind: this.lastCompactionKind,
      lastCompactionOmittedCount: this.lastCompactionOmittedCount,
      compactionStatus: this.compactionStatus,
    };
  }

  async queueFollowUp(
    message: Extract<AgentMessage, { role: 'user' }>,
    context?: PiRuntimePromptContext,
  ) {
    if (!this.isRunning && !this.agent.state.isStreaming) {
      throw new Error('No active agent run to queue a follow-up message.');
    }

    const sanitized = sanitizeUserMessage(message);
    const entry = this.createQueueEntry(sanitized, context);
    this.rememberMessageContext(sanitized, context);
    this.messageQueues.enqueueFollowUp(entry, this.agent);
    this.touch();
    this.publishStatus();
    return this.getStatus();
  }

  async queueSteering(
    message: Extract<AgentMessage, { role: 'user' }>,
    context?: PiRuntimePromptContext,
  ) {
    if (!this.isRunning && !this.agent.state.isStreaming) {
      throw new Error('No active agent run to steer.');
    }

    const sanitized = sanitizeUserMessage(message);
    const entry = this.createQueueEntry(sanitized, context);
    this.rememberMessageContext(sanitized, context);
    this.messageQueues.enqueueSteering(entry, this.agent);
    this.touch();
    this.publishStatus();
    return this.getStatus();
  }

  async promoteQueuedMessageToSteering(queueItemId: string) {
    const entry = this.messageQueues.promoteFollowUp(queueItemId, this.agent);
    if (!entry) {
      return this.getStatus();
    }

    if (!this.isRunning && !this.agent.state.isStreaming) {
      this.messageQueues.trackSteering(entry);
      this.startPrompt(entry.message, entry.context);
      return this.getStatus();
    }

    this.messageQueues.enqueueSteering(entry, this.agent);
    this.touch();
    this.publishStatus();
    return this.getStatus();
  }

  async removeQueuedMessage(queueItemId: string) {
    const removedKind = this.messageQueues.remove(queueItemId, this.agent);
    if (removedKind) {
      this.touch();
      this.publishStatus();
    }

    return this.getStatus();
  }

  async replace(
    message: Extract<AgentMessage, { role: 'user' }>,
    context?: PiRuntimePromptContext,
  ) {
    const sanitized = sanitizeUserMessage(message);

    if (!this.isRunning && !this.agent.state.isStreaming) {
      this.startPrompt(sanitized, context);
      return this.getStatus();
    }

    this.messageQueues.clear(this.agent);
    this.pendingReplace = this.createQueueEntry(sanitized, context);
    this.rememberMessageContext(sanitized, context);
    this.abortRequested = true;
    this.invalidateContextBudget();
    this.touch();
    this.publishStatus();
    this.agent.abort();
    return this.getStatus();
  }

  async abort() {
    const compactionAborted = abortPiSessionCompaction(this.getCompactionScope());
    if (this.isRunning || this.agent.state.isStreaming || this.abortRequested) {
      this.abortRequested = true;
      this.invalidateContextBudget();
      this.touch();
      this.publishStatus();
      this.agent.abort();
    } else if (compactionAborted) {
      this.touch();
      this.publishStatus();
    }

    return this.getStatus();
  }

  async compactNow(focusTopic?: string | null) {
    if (this.isRunning || this.agent.state.isStreaming) {
      throw new Error('Cannot compact while the agent is processing.');
    }
    const normalizedFocusTopic = focusTopic?.trim() || null;
    if (normalizedFocusTopic && normalizedFocusTopic.length > 500) {
      throw new Error('Compaction focus must not exceed 500 characters.');
    }

    const additionalContextTokens = this.getBrowserRuntimeContextTokenEstimate();
    const result = await this.coordinateCompaction({
      kind: 'manual',
      cause: 'manual',
      messages: this.agent.state.messages,
      additionalContextTokens,
      runtimeContext: null,
      selectionMode: 'force',
      focusTopic: normalizedFocusTopic,
    });

    if (result.state === 'succeeded' && result.summary && result.composition) {
      this.summary = result.summary;
      this.lastComposition = result.composition;
      this.recordCompaction(result.attemptId, 'manual', result.composition);
      await this.persistMessages('turn_end');
      this.lastComposition = this.composeHistory(this.agent.state.messages, additionalContextTokens);
      this.touch();
      this.publishStatus();
      return this.getStatus();
    }

    if (result.state === 'no_op' && result.composition) {
      this.lastComposition = result.composition;
      this.touch();
      this.publishStatus();
      return this.getStatus();
    }

    if (result.reasonCode === 'payload_bytes_exceeded') {
      throw new Error(
        `Context compaction cannot run because the latest message exceeds the ${Math.floor(MAX_LLM_HISTORY_BYTES / (1024 * 1024))}MB LLM transfer budget. ` +
        'Shorten the latest message or attachments.',
      );
    }
    if (result.reasonCode === 'fixed_context_too_large') {
      throw new Error(
        'Context compaction cannot run because the system prompt, tools, output reserve, or latest message already exceeds the selected model context window.',
      );
    }
    if (result.state === 'cooldown_active') {
      throw new Error(
        `Context compaction is cooling down${result.retryAt ? ` until ${result.retryAt.toISOString()}` : ''}. No messages were removed.`,
      );
    }
    if (result.state === 'breaker_active') {
      throw new Error(
        `Automatic context compaction is paused after repeated ineffective attempts${result.retryAt ? ` until ${result.retryAt.toISOString()}` : ''}. ` +
        'No messages were removed. A later automatic request will run one recovery probe.',
      );
    }
    if (result.state === 'already_running') {
      throw new Error('Context compaction is already running for this session.');
    }
    if (result.state === 'aborted') {
      throw new Error('Context compaction was aborted. No messages were removed.');
    }
    if (result.state === 'stale') {
      throw new Error('Context compaction became stale after the runtime context changed. No messages were removed.');
    }
    if (result.reasonCode === 'summary_idle_timeout') {
      throw new Error(
        'Context compaction failed because the summary stream made no progress before the idle deadline. No messages were removed.',
      );
    }
    if (result.reasonCode === 'summary_total_timeout') {
      throw new Error(
        'Context compaction exceeded its total time ceiling even though the summary stream was making progress. No messages were removed.',
      );
    }
    if (result.reasonCode === 'summary_timeout') {
      throw new Error('Context compaction timed out while updating the summary. No messages were removed.');
    }
    if (result.state === 'deferred' || result.reasonCode === 'summary_provider_error') {
      throw new Error(
        'Context compaction failed because the summary could not be updated. No messages were removed.',
      );
    }
    throw new Error('Context compaction could not commit a safe session summary. No messages were removed.');
  }

  setChannelContext(channelId: string | undefined) {
    const nextChannelId = channelId?.trim().toLowerCase() || null;
    if (this.channelId === nextChannelId) {
      return;
    }

    this.channelId = nextChannelId;
    this.invalidateContextBudget();
  }

  setTimeZoneContext(timeZone: string, currentTime: string) {
    this.timeZoneContext = { timeZone, currentTime };
    this.invalidateContextBudget();
  }

  setActiveFileContext(path: string | null) {
    this.activeFileContext = path;
    this.invalidateContextBudget();
  }

  setPlanningMode(enabled: boolean) {
    this.planningMode = enabled;
    this.invalidateContextBudget();
  }

  setPageContext(page: string | undefined): void {
    this.pageContext = page ?? null;
    this.invalidateContextBudget();
  }

  setNotebookContext(context: PiRuntimePromptContext['notebookContext']) {
    this.notebookContext = context ?? null;
    this.invalidateContextBudget();
  }

  setStudioContext(context: PiRuntimePromptContext['studioContext']) {
    this.studioContext = context ?? null;
    this.invalidateContextBudget();
  }

  setEmailContext(context: PiRuntimePromptContext['emailContext']) {
    this.emailContext = context ?? null;
    this.invalidateContextBudget();
  }

  setWorkspaceContext(context: PiRuntimePromptContext['workspace']) {
    this.workspaceContext = context ?? null;
    this.invalidateContextBudget();
  }

  async refreshWorkspaceFileTreePrompt(): Promise<void> {
    if (!this.hasWorkspaceReadCapability()) {
      this.workspaceFileTreePromptBlock = '';
      this.invalidateContextBudget();
      if (!this.isRunning && !this.agent.state.isStreaming) {
        this.agent.state.systemPrompt = this.getEffectiveSystemPrompt();
      }
      return;
    }
    const result = await buildWorkspaceFileTreePrompt({
      workspaceId: this.executionContext.workspaceId,
      rootPath: this.executionContext.workspaceRoot,
    });
    this.workspaceFileTreePromptBlock = result.promptBlock;
    this.invalidateContextBudget();
    if (!this.isRunning && !this.agent.state.isStreaming) {
      this.agent.state.systemPrompt = this.getEffectiveSystemPrompt();
    }
  }

  async refreshMemoryPrompt(): Promise<void> {
    this.memoryPromptBlock = await buildMemoryPromptProjection({
      userId: this.userId,
      agentId: this.agentId,
      workspaceId: this.executionContext.workspaceId,
      organizationId: this.executionContext.organizationId,
      usableContextTokens: this.model.contextWindow,
    });
    this.lastComposition = null;
  }

  async prepareNextTurnContext(
    context: PrepareNextTurnContext,
    signal?: AbortSignal,
  ): Promise<AgentLoopTurnUpdate | undefined> {
    if (signal?.aborted) return undefined;
    if (this.browserToolsNeedRefresh) {
      await this.reloadTools();
    }
    if (signal?.aborted) return undefined;
    await this.refreshWorkspaceFileTreePrompt();
    if (signal?.aborted) return undefined;
    // The agent loop retains its own context snapshot between turns. Updating
    // agent.state.tools alone therefore does not expose a newly active browser
    // schema until a later user run unless we replace the loop context here.
    return replaceNextTurnContext(context.context, {
      systemPrompt: this.getEffectiveSystemPrompt(),
      tools: this.agent.state.tools,
    });
  }

  async reloadTools() {
    if (this.systemPromptRefreshRequested && !this.isRunning && !this.agent.state.isStreaming) {
      await this.refreshSystemPrompt();
    }
    const browserSnapshot = await refreshBrowserSessionSnapshot(this.executionContext);
    const browserMode: BrowserToolMode = browserSnapshot.running ? 'active' : 'dormant';
    this.browserSnapshot = browserSnapshot.running ? browserSnapshot : null;
    this.tools = await getPiTools(this.userId, this.agentId, this.sessionId, {
      executionContext: this.executionContext,
      browserMode,
    });
    this.browserToolMode = browserMode;
    this.browserToolsNeedRefresh = false;
    this.invalidateContextBudget();
    this.agent.state.tools = this.getEffectiveTools();
    if (!this.isRunning && !this.agent.state.isStreaming) {
      this.agent.state.systemPrompt = this.getEffectiveSystemPrompt();
    }
  }

  private systemPromptRefreshRequested = false;

  requestSystemPromptRefresh(): void {
    this.systemPromptRefreshRequested = true;
  }

  private async refreshSystemPrompt(): Promise<void> {
    const session = await db.query.piSessions.findFirst({
      where: and(
        eq(piSessions.sessionId, this.sessionId),
        eq(piSessions.userId, this.userId),
        eq(piSessions.agentId, this.agentId),
      ),
    });
    const snapshot = await createPiSystemPromptSnapshot(this.agentId, {
      userId: this.userId,
      organizationId: session?.organizationId,
      workspaceId: session?.workspaceId,
      projectId: session?.projectId,
    });
    this.systemPrompt = snapshot.systemPrompt;
    this.systemPromptRefreshRequested = false;
    this.invalidateContextBudget();
    this.agent.state.systemPrompt = this.getEffectiveSystemPrompt();
    await db
      .update(piSessions)
      .set(piSystemPromptSnapshotDbFields(snapshot))
      .where(and(
        eq(piSessions.sessionId, this.sessionId),
        eq(piSessions.userId, this.userId),
        eq(piSessions.agentId, this.agentId),
      ));
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

    if (this.workspaceFileTreePromptBlock) {
      blocks.push(this.workspaceFileTreePromptBlock);
    }

    if (this.memoryPromptBlock) {
      blocks.push(this.memoryPromptBlock);
    }

    const runtimeTempBlock = this.getAgentRuntimeTempContextBlock();
    if (runtimeTempBlock) {
      blocks.push(runtimeTempBlock);
    }

    const foundation = blocks.length > 0 ? `${this.systemPrompt}\n\n${blocks.join('\n\n')}` : this.systemPrompt;
    return appendEffectiveToolCapabilitiesPrompt(
      foundation,
      buildEffectiveToolManifest(this.getEffectiveTools()),
    );
  }

  private getEffectiveTools(): AgentTool[] {
    return this.planningMode ? filterToolsForPlanningMode(this.tools) : this.tools;
  }

  private hasWorkspaceReadCapability(): boolean {
    const manifest = buildEffectiveToolManifest(this.getEffectiveTools());
    return ['ls', 'read', 'rg', 'grep', 'glob', 'inspect_document_relations']
      .some((toolName) => effectiveToolManifestHas(manifest, toolName));
  }

  private getAgentRuntimeTempContextBlock(): string | null {
    if (!this.userId || !this.sessionId) {
      return null;
    }

    return getAgentRuntimeTempPromptBlock({
      userId: this.userId,
      sessionId: this.sessionId,
      agentId: this.agentId,
      organizationId: this.workspaceContext?.organizationId ?? null,
    });
  }

  private getWorkspaceContextBlock(): string | null {
    return buildActiveWorkspacePromptBlock(this.workspaceContext);
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
      pushRuntimeContextLine(lines, 'Current output ID', this.studioContext.currentOutputId);
    }
    if (this.studioContext.generationId) {
      pushRuntimeContextLine(lines, 'Generation ID', this.studioContext.generationId);
    }
    if (this.studioContext.generationPrompt) {
      pushRuntimeContextLine(lines, 'Generation prompt', this.studioContext.generationPrompt);
    }
    if (this.studioContext.generationPresetId) {
      pushRuntimeContextLine(lines, 'Preset ID', this.studioContext.generationPresetId);
    }
    if (this.studioContext.generationProductIds?.length) {
      lines.push(`Product IDs: ${formatRuntimeContextArray(this.studioContext.generationProductIds)}`);
    }
    if (this.studioContext.generationPersonaIds?.length) {
      lines.push(`Persona IDs: ${formatRuntimeContextArray(this.studioContext.generationPersonaIds)}`);
    }
    if (this.studioContext.outputFilePath) {
      const { absolutePath, referencePath } = getStudioOutputReferencePaths(this.studioContext.outputFilePath);
      pushRuntimeContextLine(lines, 'Current Studio output DB filePath', this.studioContext.outputFilePath);
      pushRuntimeContextLine(lines, 'Use this exact path when passing the current image as a Studio reference', referencePath);
      pushRuntimeContextLine(lines, 'Use this exact path in studio_generate_image.extra_reference_urls', referencePath);
      pushRuntimeContextLine(lines, 'Absolute filesystem path for file operations only', absolutePath);
    }
    if (this.studioContext.outputMediaUrl) {
      pushRuntimeContextLine(lines, 'Output media URL', this.studioContext.outputMediaUrl);
      pushRuntimeContextLine(lines, 'When embedding this output in Markdown, use this exact image URL', this.studioContext.outputMediaUrl);
    }
    if (this.studioContext.activeImagePath) {
      pushRuntimeContextLine(lines, 'Active image file path', this.studioContext.activeImagePath);
    }

    lines.push('If the user asks to edit, restyle, recolor, remix, or make a variation of the visible image, call studio_generate_image and include the exact workspace-scoped Studio reference path above in extra_reference_urls. Do not pass the /data/... absolute filesystem path to studio_generate_image.');
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
      pushRuntimeContextLine(lines, 'Active account email', this.emailContext.accountEmail);
    }
    if (this.emailContext.accountId) {
      pushRuntimeContextLine(lines, 'Active account ID', this.emailContext.accountId);
    }
    if (this.emailContext.folderName || this.emailContext.folder) {
      pushRuntimeContextLine(lines, 'Active folder', this.emailContext.folderName || this.emailContext.folder);
    }
    if (this.emailContext.folder && this.emailContext.folderName && this.emailContext.folder !== this.emailContext.folderName) {
      pushRuntimeContextLine(lines, 'Active folder path', this.emailContext.folder);
    }
    if (this.emailContext.filter) {
      pushRuntimeContextLine(lines, 'Message filter', this.emailContext.filter);
    }
    if (this.emailContext.query) {
      pushRuntimeContextLine(lines, 'Current search query', this.emailContext.query);
    }
    if (this.emailContext.selectedMessageId) {
      pushRuntimeContextLine(lines, 'Selected message ID', this.emailContext.selectedMessageId);
    }
    if (this.emailContext.selectedMessageFolder) {
      pushRuntimeContextLine(lines, 'Selected message folder', this.emailContext.selectedMessageFolder);
    }
    if (this.emailContext.selectedMessageSubject) {
      pushRuntimeContextLine(lines, 'Selected message subject', this.emailContext.selectedMessageSubject);
    }
    if (this.emailContext.selectedMessageFrom) {
      pushRuntimeContextLine(lines, 'Selected message from', this.emailContext.selectedMessageFrom);
    }
    if (this.emailContext.selectedMessageDate) {
      pushRuntimeContextLine(lines, 'Selected message date', this.emailContext.selectedMessageDate);
    }
    if (typeof this.emailContext.selectedMessageIsRead === 'boolean') {
      lines.push(`Selected message read: ${this.emailContext.selectedMessageIsRead ? 'yes' : 'no'}`);
    }

    lines.push('This context contains only mailbox metadata. Use email_read_message before making claims about the selected email body.');
    return lines.join('\n');
  }

  private getNotebookContextBlock(
    context: PiRuntimePromptContext['notebookContext'] | null = this.notebookContext,
  ): string | null {
    if (!context) return null;

    const lines = [
      '## Notebook Workbench Context',
      `Chat placement: ${formatRuntimeContextValue(context.chatPlacement)}`,
    ];
    if (context.activeSurface?.kind === 'document') {
      lines.push(`Active side-by-side document: ${formatRuntimeContextValue(context.activeSurface.path)}`);
    } else if (context.activeSurface) {
      lines.push(`Active side-by-side surface: ${formatRuntimeContextValue(context.activeSurface.kind)}`);
    } else {
      lines.push('No work surface is implicit context for this message.');
    }

    if (context.openDocuments.length > 0) {
      lines.push('Open document tabs (UI metadata only):');
      for (const document of context.openDocuments) {
        lines.push(`- ${formatRuntimeContextValue(document.path)} (${document.state})`);
      }
    }

    lines.push(
      'Only the active side-by-side surface is implicit conversation context.',
      'Background document tabs are organizational metadata. Do not read, quote, or modify them unless the user explicitly refers to them.',
      'Document contents are not included here. Use a file-reading tool when the user request requires the active or explicitly referenced document contents.',
    );
    return lines.join('\n');
  }

  private getPageContextBlock(): string | null {
    if (!this.pageContext) return null;
    if (this.pageContext.startsWith('/studio')) {
      return '## Studio Context\nUse only the effective runtime tools listed below for studio work.';
    }
    if (this.pageContext.startsWith('/emails')) {
      return '## Email Context\nUse only the effective runtime tools listed below for mailbox work. Email drafts require human review; do not imply that an email was sent.';
    }
    return null;
  }

  private getBrowserRuntimeContextTokenEstimate(): number {
    const browserBlock = buildBrowserRuntimeContextBlock(this.browserSnapshot);
    return browserBlock ? estimateTextTokens(browserBlock) : 0;
  }

  private async getRuntimeContextBlock(
    latestUserMessageText?: string,
    messageContext?: PiRuntimePromptContext,
  ): Promise<string | null> {
    const sections: string[] = [];

    if (this.timeZoneContext) {
      const { timeZone, currentTime } = this.timeZoneContext;
      const formatted = formatZonedDateTimeForPrompt(currentTime, timeZone);
      sections.push(`Current Date & Time: ${formatRuntimeContextValue(`${formatted.localDateTime} (${formatted.timeZone}, ${formatted.utcOffset})`)}`);
    }

    const activeFileContext = messageContext
      ? messageContext.activeFilePath ?? null
      : this.activeFileContext;
    if (activeFileContext) {
      sections.push(`Currently open file in editor: ${formatRuntimeContextValue(activeFileContext)}`);
    }

    const notebookBlock = this.getNotebookContextBlock(
      messageContext ? messageContext.notebookContext ?? null : this.notebookContext,
    );
    if (notebookBlock) {
      sections.push(notebookBlock);
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

    const browserBlock = buildBrowserRuntimeContextBlock(this.browserSnapshot);
    if (browserBlock) {
      sections.push(browserBlock);
    }

    if (latestUserMessageText) {
      try {
        const pluginBlock = await buildReferencedPluginRuntimeContext(latestUserMessageText, { userId: this.userId });
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

  private async injectRuntimeContext(
    messages: AgentMessage[],
    preparedRuntimeContext?: string | null,
  ): Promise<AgentMessage[]> {
    let runtimeContext = preparedRuntimeContext;
    if (runtimeContext === undefined) {
      let latestUserMessageText = '';
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (isUserMessage(message)) {
          latestUserMessageText = extractUserMessageText(message);
          break;
        }
      }
      runtimeContext = await this.getRuntimeContextBlock(latestUserMessageText);
    }

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

  private applyAutomaticCompactionResult(result: PiCompactionCoordinatorResult): boolean {
    if (result.state !== 'succeeded' || !result.summary || !result.composition) {
      return false;
    }

    this.summary = result.summary;
    this.lastComposition = result.composition;
    this.recordCompaction(result.attemptId, 'automatic', result.composition);
    this.publishStatus();
    return true;
  }

  private async finalizeContextCandidate(input: {
    composition: PiHistoryComposition;
    sourceMessages: AgentMessage[];
    runtimeContext: string | null;
    additionalContextTokens: number;
    signal?: AbortSignal;
  }): Promise<AgentMessage[]> {
    let composition = input.composition;
    let candidate = await this.injectRuntimeContext(composition.llmMessages, input.runtimeContext);
    let prepared = await this.buildFinalPayload(candidate);
    if (this.isFinalPayloadSendable(prepared.budgetSnapshot)) {
      this.cachePreparedRuntimePayload(prepared);
      return candidate;
    }

    this.preparedRuntimePayload = null;
    const maximumAttempts = DEFAULT_PI_CONTEXT_BUDGET_POLICY.maxCompactionAttempts ?? 3;
    let previousLoad = getPiFinalPayloadRetryLoad(prepared.budgetSnapshot);
    let addedContextReserve = input.additionalContextTokens;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      addedContextReserve += Math.max(1, getPiFinalPayloadPressure(prepared.budgetSnapshot));
      const retry = await this.coordinateCompaction({
        // A request-blocking retry may pass a failure cooldown, but never the
        // coordinator lock or transactional commit fences.
        kind: 'automatic',
        cause: 'hard_limit',
        bypassCooldown: true,
        messages: input.sourceMessages,
        additionalContextTokens: addedContextReserve,
        runtimeContext: input.runtimeContext,
        signal: input.signal,
        selectionMode: 'force',
      });

      if (this.applyAutomaticCompactionResult(retry)) {
        composition = retry.composition!;
      } else if (
        (retry.state === 'no_op' || retry.state === 'deferred')
        && retry.composition
        && isPiHistoryCompositionSendable(retry.composition, this.summary)
      ) {
        composition = retry.composition;
        this.lastComposition = composition;
        this.publishStatus();
      } else {
        break;
      }

      candidate = await this.injectRuntimeContext(composition.llmMessages, input.runtimeContext);
      prepared = await this.buildFinalPayload(candidate);
      if (this.isFinalPayloadSendable(prepared.budgetSnapshot)) {
        this.cachePreparedRuntimePayload(prepared);
        return candidate;
      }
      const nextLoad = getPiFinalPayloadRetryLoad(prepared.budgetSnapshot);
      if (!sessionCompactionWarrantsAnotherPass({
        originalTokens: previousLoad,
        newTokens: nextLoad,
        thresholdTokens: prepared.budgetSnapshot.contextWindowTokens,
      })) {
        break;
      }
      previousLoad = nextLoad;
    }

    this.preparedRuntimePayload = null;
    throw new Error(
      'The final request still exceeds the selected model context window after automatic compaction. '
      + 'Shorten the latest message or attachments, or use a larger-context model.',
    );
  }

  async recoverProviderContextOverflow(signal?: AbortSignal): Promise<Context | null> {
    const messages = this.agent.state.messages.slice();
    let latestUserMessageText = '';
    let latestUserMessageContext: PiRuntimePromptContext | undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!isUserMessage(message)) continue;
      latestUserMessageText = extractUserMessageText(message);
      latestUserMessageContext = this.messageContextSnapshots.get(getMessageSignature(message));
      break;
    }
    const runtimeContext = await this.getRuntimeContextBlock(
      latestUserMessageText,
      latestUserMessageContext,
    );
    const additionalContextTokens = (runtimeContext ? estimateTextTokens(runtimeContext) : 0)
      + Math.max(1, Math.ceil(this.model.contextWindow * 0.05));
    const result = await this.coordinateCompaction({
      kind: 'automatic',
      cause: 'provider_overflow',
      bypassCooldown: true,
      messages,
      additionalContextTokens,
      runtimeContext,
      signal,
      selectionMode: 'force',
    });
    if (!this.applyAutomaticCompactionResult(result) || !result.composition) return null;
    const candidate = await this.injectRuntimeContext(result.composition.llmMessages, runtimeContext);
    const prepared = await this.buildFinalPayload(candidate);
    if (!this.isFinalPayloadSendable(prepared.budgetSnapshot)) return null;
    return {
      systemPrompt: this.getEffectiveSystemPrompt(),
      tools: this.getEffectiveTools(),
      messages: prepared.messages,
    };
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

  startPrompt(
    message: Extract<AgentMessage, { role: 'user' }>,
    context?: PiRuntimePromptContext,
  ) {
    if (this.disposed) {
      throw new Error('The session runtime was replaced before the prompt started. Try again.');
    }
    const sanitized = sanitizeUserMessage(message);
    this.rememberMessageContext(sanitized, context);
    this.activePromptTiming = createOperationTiming();
    this.firstAssistantEventLogged = false;
    this.firstTextDeltaLogged = false;
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
    this.invalidateContextBudget();
    this.options.resetToolLoopGuard?.();
    this.abortRequested = false;
    this.isRunning = true;
    this.publishStatus();

    this.agent.state.tools = this.getEffectiveTools();
    const effectiveSystemPrompt = this.getEffectiveSystemPrompt();
    if (this.agent.state.systemPrompt !== effectiveSystemPrompt) {
      this.agent.state.systemPrompt = effectiveSystemPrompt;
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
      if (!this.firstAssistantEventLogged) {
        this.firstAssistantEventLogged = true;
        console.log('[AgentRuntimeTiming] first_assistant_event', {
          sessionId: this.sessionId,
          elapsedMs: this.activePromptTiming?.elapsedMs() ?? null,
        });
      }
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
        if (rawDelta && !this.firstTextDeltaLogged) {
          this.firstTextDeltaLogged = true;
          console.log('[AgentRuntimeTiming] first_text_delta', {
            sessionId: this.sessionId,
            elapsedMs: this.activePromptTiming?.elapsedMs() ?? null,
          });
        }
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
      const providerReportedInputTokens = event.message.usage?.input;
      if (typeof providerReportedInputTokens === 'number' && providerReportedInputTokens > 0) {
        const assistantTimestamp = new Date(event.message.timestamp);
        this.lastProviderInputUsage = {
          inputTokens: Math.floor(providerReportedInputTokens),
          assistantTimestamp: Number.isNaN(assistantTimestamp.getTime()) ? new Date() : assistantTimestamp,
        };
      }
      if (
        this.lastFinalPayloadBudgetSnapshot
        && typeof providerReportedInputTokens === 'number'
        && providerReportedInputTokens > 0
      ) {
        this.lastProviderUsageCalibration = createPiProviderUsageCalibrationEvidence({
          snapshot: this.lastFinalPayloadBudgetSnapshot,
          provider: event.message.provider,
          model: event.message.model,
          providerReportedInputTokens,
        });
      }
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
    let latestUserMessageText = '';
    let latestUserMessageContext: PiRuntimePromptContext | undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (isUserMessage(message)) {
        latestUserMessageText = extractUserMessageText(message);
        latestUserMessageContext = this.messageContextSnapshots.get(getMessageSignature(message));
        break;
      }
    }
    const runtimeContext = await this.getRuntimeContextBlock(
      latestUserMessageText,
      latestUserMessageContext,
    );
    const additionalContextTokens = runtimeContext ? estimateTextTokens(runtimeContext) : 0;
    const systemPromptTokens = estimateTextTokens(this.getEffectiveSystemPrompt());
    const toolTokens = estimatePiToolSchemaTokens(this.getEffectiveTools());
    const roughInspection = inspectPiRuntimeCompactionPressure({
      messages,
      model: this.model,
      outputReserveTokens: this.requestOutputTokenCap,
      fixedRequestTokens:
        systemPromptTokens
        + toolTokens
        + additionalContextTokens
        + DEFAULT_PI_CONTEXT_BUDGET_POLICY.safetyFloorTokens,
      providerActualInputTokens: this.lastProviderInputUsage?.inputTokens ?? null,
    });
    const preflight = this.composeHistory(messages, additionalContextTokens);
    if (roughInspection.pressure.cheapGatePassed) {
      const completeCandidate = await this.injectRuntimeContext(messages, runtimeContext);
      const exactPreflight = await this.buildFinalPayload(completeCandidate);
      const exactInspection = inspectPiRuntimeCompactionPressure({
        messages,
        model: this.model,
        outputReserveTokens: this.requestOutputTokenCap,
        fixedRequestTokens: systemPromptTokens + toolTokens + additionalContextTokens,
        finalSnapshot: exactPreflight.budgetSnapshot,
        providerActualInputTokens: this.lastProviderInputUsage?.inputTokens ?? null,
      });
      if (!exactInspection.pressure.shouldCompact && this.isFinalPayloadSendable(exactPreflight.budgetSnapshot)) {
        this.lastComposition = this.composeHistory(messages, additionalContextTokens, 'full');
        this.cachePreparedRuntimePayload(exactPreflight);
        return completeCandidate;
      }
    }
    if (
      !roughInspection.pressure.cheapGatePassed
      && (
        !preflight.softThresholdExceeded
        && !preflight.contextBudgetExceeded
        && isPiHistoryCompositionSendable(preflight, this.summary)
      )
    ) {
      this.lastComposition = preflight;
      return this.finalizeContextCandidate({
        composition: preflight,
        sourceMessages: messages,
        runtimeContext,
        additionalContextTokens,
        signal,
      });
    }

    const result = await this.coordinateCompaction({
      kind: 'automatic',
      cause: 'threshold',
      messages,
      additionalContextTokens,
      runtimeContext,
      signal,
    });

    if (this.applyAutomaticCompactionResult(result) && result.composition) {
      return this.finalizeContextCandidate({
        composition: result.composition,
        sourceMessages: messages,
        runtimeContext,
        additionalContextTokens,
        signal,
      });
    }

    if ((result.state === 'no_op' || result.state === 'deferred') && result.composition) {
      this.lastComposition = result.composition;
      if (isPiHistoryCompositionSendable(result.composition, this.summary)) {
        this.publishStatus();
        return this.finalizeContextCandidate({
          composition: result.composition,
          sourceMessages: messages,
          runtimeContext,
          additionalContextTokens,
          signal,
        });
      }
    }

    if (result.reasonCode === 'payload_bytes_exceeded') {
        throw new Error(
          `The current request exceeds the ${Math.floor(MAX_LLM_HISTORY_BYTES / (1024 * 1024))}MB LLM transfer budget after image compression. ` +
          'Shorten the latest message or attachments.',
        );
    }
    if (result.reasonCode === 'fixed_context_too_large') {
      throw new Error(
        `The current request is too large for the selected model context window. ` +
        `It requires at least ${preflight.minimumRequiredTokens.toLocaleString()} history tokens after system, tool, and output reserves. ` +
        'Use a larger-context model or shorten the latest message/attachments.',
      );
    }
    if (result.state === 'aborted') {
      throw new Error('Context compaction was aborted before the model request.');
    }
    if (result.state === 'stale') {
      throw new Error('Context compaction was invalidated because the runtime context changed. Retry the request.');
    }

    const fallback = this.composeHistory(messages, additionalContextTokens, 'hard_limit');
    if (isPiHistoryCompositionSendable(fallback, this.summary)) {
      this.lastComposition = fallback;
      this.publishStatus();
      return this.finalizeContextCandidate({
        composition: fallback,
        sourceMessages: messages,
        runtimeContext,
        additionalContextTokens,
        signal,
      });
    }
    if (result.state === 'cooldown_active') {
      throw new Error(
        `Context compaction is cooling down${result.retryAt ? ` until ${result.retryAt.toISOString()}` : ''}, and the complete history no longer fits.`,
      );
    }
    if (result.state === 'breaker_active') {
      throw new Error(
        `Automatic context compaction is paused after repeated ineffective attempts${result.retryAt ? ` until ${result.retryAt.toISOString()}` : ''}, ` +
        'and the complete history no longer fits. Retry after the recovery window or compact manually.',
      );
    }
    if (result.state === 'already_running') {
      throw new Error('Context compaction is already running, and the complete history cannot be sent safely yet.');
    }
    if (result.reasonCode === 'summary_idle_timeout') {
      throw new Error(
        'Context compaction stalled because the summary stream stopped making progress, and the complete history cannot be sent safely. Retry or use a larger-context model.',
      );
    }
    if (result.reasonCode === 'summary_total_timeout') {
      throw new Error(
        'Context compaction exceeded its total time ceiling, and the complete history cannot be sent safely. Retry or use a larger-context model.',
      );
    }
    if (result.reasonCode === 'summary_timeout') {
      throw new Error('Context compaction timed out, and the complete history cannot be sent safely. Retry or use a larger-context model.');
    }
    if (result.reasonCode === 'summary_provider_error') {
      throw new Error(
        'Context compaction could not update the summary, and the complete history cannot be sent safely. Retry or use a larger-context model.',
      );
    }
    throw new Error(
      'The current request cannot be sent safely because context compaction did not preserve complete history coverage. ' +
      'Use a larger-context model, shorten the request, or retry compaction.',
    );
  }

  private rememberMessageContext(
    message: Extract<AgentMessage, { role: 'user' }>,
    context?: PiRuntimePromptContext,
  ) {
    if (!context) return;
    this.messageContextSnapshots.set(getMessageSignature(message), context);
    while (this.messageContextSnapshots.size > MAX_MESSAGE_CONTEXT_SNAPSHOTS) {
      const oldestKey = this.messageContextSnapshots.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.messageContextSnapshots.delete(oldestKey);
    }
  }

  private createQueueEntry(
    message: Extract<AgentMessage, { role: 'user' }>,
    context?: PiRuntimePromptContext,
  ) {
    return {
      id: `queued-${message.timestamp}-${Math.random().toString(36).slice(2, 10)}`,
      preview: buildQueuePreview(message),
      signature: getMessageSignature(message),
      message,
      context,
    };
  }

  private consumeQueuedMessage(message: Extract<AgentMessage, { role: 'user' }>) {
    this.messageQueues.consume(getMessageSignature(message), this.agent);
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

    if (!persistError) {
      this.scheduleInitialSessionTitle(allMessages);
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

    if (this.options.requiresRuntimeRecreation?.()) {
      const replacement = this.pendingReplace ?? null;
      this.pendingReplace = null;
      await evictPiRuntimeInstance(this.sessionId, this.userId, this);
      if (replacement) {
        queueMicrotask(() => {
          void dispatchPiRuntimeUserMessage(
            this.sessionId,
            this.userId,
            replacement.message,
            replacement.context,
          ).catch((error) => {
            console.error('[LiveRuntime] Failed to dispatch replacement on recreated runtime:', error);
          });
        });
      }
      return;
    }

    if (this.pendingReplace) {
      const replacement = this.pendingReplace;
      this.pendingReplace = null;
      await this.refreshWorkspaceFileTreePrompt();
      this.startPrompt(replacement.message, replacement.context);
      return;
    }

    this.scheduleIdleCompaction();
  }

  private scheduleIdleCompaction(): void {
    if (this.idleCompactionTimer) clearTimeout(this.idleCompactionTimer);
    this.idleCompactionTimer = null;
    if (!this.options.idleCompaction || this.disposed) return;
    const delayMs = Math.max(
      0,
      Math.floor(this.options.idleCompactionDelayMs ?? IDLE_COMPACTION_DELAY_MS),
    );
    this.idleCompactionTimer = setTimeout(() => {
      this.idleCompactionTimer = null;
      void this.runIdleCompaction();
    }, delayMs);
  }

  private async runIdleCompaction(): Promise<void> {
    if (
      this.disposed
      || this.isRunning
      || this.agent.state.isStreaming
      || this.pendingReplace
    ) return;
    const additionalContextTokens = this.getBrowserRuntimeContextTokenEstimate();
    try {
      const result = await this.coordinateCompaction({
        kind: 'automatic',
        cause: 'idle',
        messages: this.agent.state.messages.slice(),
        additionalContextTokens,
        runtimeContext: null,
        selectionMode: 'force',
      });
      if (this.applyAutomaticCompactionResult(result) && result.composition) {
        await this.persistMessages('agent_end');
        this.lastComposition = this.composeHistory(
          this.agent.state.messages,
          additionalContextTokens,
        );
        this.touch();
        this.publishStatus();
      }
    } catch (error) {
      console.warn('[LiveRuntime] Optional idle context compaction failed.', {
        sessionId: this.sessionId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  private publish(event: PiRuntimeStreamEvent) {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  private publishStatus() {
    const currentStatus = this.getStatus();
    const signature = getRuntimeStatusSignature(currentStatus);
    if (signature === this.lastBroadcastStatusSignature) {
      return;
    }
    this.statusRevision = nextRuntimeStatusRevision(this.sessionId, this.userId);
    const status = this.getStatus();
    const event: RuntimeStatusEvent = {
      type: 'runtime_status',
      status,
    };

    this.publish(event);
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

  private recordCompaction(
    attemptId: string,
    kind: 'manual' | 'automatic',
    composition: PiHistoryComposition,
  ) {
    this.lastCompactionAt = new Date();
    this.lastCompactionKind = kind;
    this.lastCompactionOmittedCount = composition.omittedMessages.length;
    this.publish({
      type: 'context_compacted',
      attemptId,
      timestamp: this.lastCompactionAt.toISOString(),
      kind,
      omittedMessageCount: composition.omittedMessages.length,
      includedSummary: composition.includedSummary,
    });
    this.agent.state.messages = [
      ...this.agent.state.messages,
      createCompactBreakMessage(attemptId, kind, this.lastCompactionAt.toISOString(), composition.omittedMessages.length),
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

  private scheduleInitialSessionTitle(messages: AgentMessage[]) {
    const streamFn = this.options.summaryStreamFn;
    if (!streamFn) return;

    void generatePendingPiSessionTitle({
      agentId: this.agentId,
      messages,
      model: this.model,
      sessionId: this.sessionId,
      streamFn,
      userId: this.userId,
    }).then((result) => {
      if (!result.updated || !result.title) return;
      this.emitRuntimeEvent({
        type: 'session_title_updated',
        title: result.title,
        titleGenerationState: result.titleGenerationState,
        timestamp: Date.now(),
      });
    }).catch((error) => {
      console.warn('[LiveRuntime] Session title generation could not be scheduled.', {
        sessionId: this.sessionId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.idleCompactionTimer) clearTimeout(this.idleCompactionTimer);
    this.idleCompactionTimer = null;
    abortPiSessionCompaction(this.getCompactionScope());
    if (this.browserSnapshotUnsubscribe) {
      this.browserSnapshotUnsubscribe();
      this.browserSnapshotUnsubscribe = null;
    }
    if (this.agentUnsubscribe) {
      this.agentUnsubscribe();
      this.agentUnsubscribe = null;
    }
    this.subscribers.clear();
  }

  private async persistMessages(reason: 'turn_end' | 'agent_end' | 'error'): Promise<number> {
    if (this.persistPromise) {
      const pending = this.persistPromise;
      const persistedCount = await pending;
      if (this.agent.state.messages.length > this.lastPersistedLength) {
        return persistedCount + await this.persistMessages(reason);
      }
      return persistedCount;
    }
    const operation = this.persistMessagesOnce(reason);
    this.persistPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.persistPromise === operation) this.persistPromise = null;
    }
  }

  private async persistMessagesOnce(reason: 'turn_end' | 'agent_end' | 'error'): Promise<number> {
    const allMessages = this.agent.state.messages.slice();
    const startIndex = this.lastPersistedLength;
    if (allMessages.length <= startIndex) return 0;

    try {
      const saveResult = await savePiSession(
        this.sessionId,
        this.userId,
        this.provider,
        this.model.id,
        allMessages,
        this.summary,
        {
          agentId: this.agentId,
          persistedLength: startIndex,
          expectedSummaryRevision: this.summary.summaryRevision,
        },
      );
      this.summary = { ...this.summary, summaryRevision: saveResult.summaryRevision };
      this.messageSequenceCheckpoint = saveResult.sequenceCheckpoint;

      const newMessages = allMessages.slice(startIndex);
      if (newMessages.length > 0) {
        await persistPiUsageEvents({
          sessionId: this.sessionId,
          userId: this.userId,
          messages: newMessages,
        });
        if (newMessages.some((message) => message.role === 'assistant')) {
          queueMicrotask(() => {
            void import('@/app/lib/memory/service')
              .then(({ scheduleMemoryReviewForSession }) => scheduleMemoryReviewForSession({
                sessionId: this.sessionId,
                userId: this.userId,
              }))
              .then(() => import('@/app/lib/memory/review-worker'))
              .then(({ triggerMemoryReviewWorker }) => {
                triggerMemoryReviewWorker();
              })
              .catch((error) => {
                console.error('[LiveRuntime] Failed to schedule memory review:', error);
              });
          });
        }
      }

      this.lastPersistedLength = allMessages.length;
      return newMessages.length;
    } catch (error) {
      console.error(`[LiveRuntime] Failed to persist messages during ${reason}:`, error);
      throw error;
    }
  }
}

async function createRuntime(sessionId: string, userId: string): Promise<LivePiRuntime> {
  const timing = createOperationTiming();
  const sessionRecord = await findUnambiguousOwnedPiSessionForRuntime({ sessionId, userId });
  timing.mark('sessionLookup');
  if (!sessionRecord) {
    throw new Error('Session not found. Create the chat session before starting its runtime.');
  }

  const agentId = sessionRecord.agentId ?? DEFAULT_AGENT_ID;
  const executionContext = await resolveAgentExecutionContextForSession({
    sessionId,
    userId,
    agentId,
  });
  timing.mark('executionContext');
  if (!executionContext.organizationId) {
    throw new Error('Complete the app AI runtime setup before starting an agent session.');
  }
  const executableRuntime = await resolveAndPinSessionRuntime({
    organizationId: executionContext.organizationId,
    userId,
    workspaceId: executionContext.workspaceId,
    workspaceType: executionContext.workspaceType,
    agentId,
    sessionId,
    requestedSelection: null,
    executionMode: runtimeExecutionModeForSession(sessionRecord),
    principal: {
      type: 'user',
      userId,
      credentialSubjectUserId: userId,
    },
  });
  timing.mark('runtimeResolution');
  const provider = executableRuntime.selection.selection.providerId;
  const thinkingLevel = executableRuntime.selection.selection.thinkingLevel as ThinkingLevel;
  const model = executableRuntime.model;
  const [loadedSession, lastProviderInputUsage] = await Promise.all([
    loadPiSessionWithSummary(sessionId, userId, agentId),
    loadLatestPiSessionInputUsage(sessionId, userId),
  ]);
  timing.mark('sessionHistory');
  const initialMessages = loadedSession?.messages || [];
  const summary = loadedSession?.summary || {
    summaryText: null,
    summaryUpdatedAt: null,
    summaryThroughTimestamp: null,
    summaryThroughSequence: null,
    summaryRevision: 0,
  };
  const promptSnapshot = sessionRecord
    ? await ensurePiSessionSystemPromptSnapshot(sessionRecord)
    : await createPiSystemPromptSnapshot(agentId, { userId });
  timing.mark('systemPrompt');
  const systemPrompt = promptSnapshot.systemPrompt;
  const browserSnapshot = await refreshBrowserSessionSnapshot(executionContext);
  const tools = await getPiTools(userId, agentId, sessionId, {
    executionContext,
    browserMode: browserSnapshot.running ? 'active' : 'dormant',
  });
  timing.mark('tools');
  const workspaceFileTreePrompt = ['ls', 'read', 'rg', 'grep', 'glob', 'inspect_document_relations']
    .some((toolName) => effectiveToolManifestHas(buildEffectiveToolManifest(tools), toolName))
    ? await buildWorkspaceFileTreePrompt({
        workspaceId: executionContext.workspaceId,
        rootPath: executionContext.workspaceRoot,
      })
    : { promptBlock: '' };
  timing.mark('workspaceFileTree');
  const memoryPromptBlock = await buildMemoryPromptProjection({
    userId,
    agentId,
    workspaceId: executionContext.workspaceId,
    organizationId: executionContext.organizationId,
    usableContextTokens: model.contextWindow,
  });
  timing.mark('memoryPrompt');
  const toolLoopGuard = createToolLoopGuard();
  const imageNormalizationOptions = {
    workspaceImageRoot: executionContext.workspaceRoot,
    allowedImageFileRoots: [
      executionContext.workspaceRoot,
      resolveAgentRuntimeTempDir({
        userId,
        sessionId,
        agentId,
        organizationId: executionContext.organizationId,
      }),
    ],
    uploadOwnerUserId: userId,
    uploadWorkspaceId: executionContext.workspaceId,
  };
  const requestOutputTokenCap = getPiRequestOutputTokenCap(model);
  const cappedMainRequestStreamFn = withPiRequestOutputTokenCap(
    executableRuntime.streamFn,
    requestOutputTokenCap,
  );

  const runtimeRef: { current: LivePiRuntime | null } = { current: null };
  const mainRequestStreamFn = withPiProviderOverflowRecovery(
    cappedMainRequestStreamFn,
    async ({ options }) => runtimeRef.current?.recoverProviderContextOverflow(options?.signal) ?? null,
  );
  const agent = new Agent({
    initialState: {
      systemPrompt: appendEffectiveToolCapabilitiesPrompt(systemPrompt, buildEffectiveToolManifest(tools)),
      model,
      thinkingLevel,
      tools,
      messages: initialMessages,
    },
    convertToLlm: async (messages) => {
      if (!runtimeRef.current) {
        throw new Error('PI runtime not initialized');
      }
      return runtimeRef.current.prepareFinalPayload(messages);
    },
    transformContext: async (messages, signal) => {
      if (!runtimeRef.current) {
        throw new Error('PI runtime not initialized');
      }

      return runtimeRef.current.transformContext(messages, signal);
    },
    streamFn: mainRequestStreamFn,
    afterToolCall: async (context) => toolLoopGuard.afterToolCall(context),
    prepareNextTurnWithContext: async (context, signal) => {
      if (!runtimeRef.current) return undefined;
      return runtimeRef.current.prepareNextTurnContext(context, signal);
    },
    sessionId,
  });
  timing.mark('agentConstruction');

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
      executionContext,
      workspaceFileTreePromptBlock: workspaceFileTreePrompt.promptBlock,
      memoryPromptBlock,
      browserSnapshot,
      imageNormalizationOptions,
      requestOutputTokenCap,
      lastProviderInputUsage,
    },
    agent,
    {
      resetToolLoopGuard: () => toolLoopGuard.reset(),
      requiresRuntimeRecreation: executableRuntime.requiresRecreation,
      summaryStreamFn: executableRuntime.streamFn,
      idleCompaction: process.env.CANVAS_PI_IDLE_COMPACTION_ENABLED === 'true',
    },
  );
  runtimeRef.current = runtime;

  const unsubscribe = agent.subscribe(async (event) => {
    await runtime.onAgentEvent(event);
  });
  runtime.agentUnsubscribe = unsubscribe;

  console.log('[AgentRuntimeTiming] runtime_created', {
    sessionId,
    agentId,
    provider,
    model: model.id,
    initialMessageCount: initialMessages.length,
    toolCount: tools.length,
    timing: timing.snapshot(),
  });

  return runtime;
}

type RuntimeStore = {
  runtimes: Map<string, Promise<LivePiRuntime>>;
  statusRevisions: Map<string, number>;
  cleanupStarted: boolean;
};

const globalStore = globalThis as typeof globalThis & {
  __canvasPiRuntimeStore?: RuntimeStore;
};

function getStore(): RuntimeStore {
  if (!globalStore.__canvasPiRuntimeStore) {
    globalStore.__canvasPiRuntimeStore = {
      runtimes: new Map<string, Promise<LivePiRuntime>>(),
      statusRevisions: new Map<string, number>(),
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
        void cleanupAgentRuntimeTempDirs({
          nowMs: now,
          activeDirs: resolved.map((entry) => entry.runtime.getRuntimeTempDir()),
        }).catch(() => undefined);
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

function currentRuntimeStatusRevision(sessionId: string, userId: string): number {
  return getStore().statusRevisions.get(getRuntimeKey(sessionId, userId)) || 0;
}

function nextRuntimeStatusRevision(sessionId: string, userId: string): number {
  const store = getStore();
  const key = getRuntimeKey(sessionId, userId);
  const revision = (store.statusRevisions.get(key) || 0) + 1;
  store.statusRevisions.set(key, revision);
  return revision;
}

async function evictPiRuntimeInstance(
  sessionId: string,
  userId: string,
  runtime: LivePiRuntime,
): Promise<boolean> {
  const store = getStore();
  const key = getRuntimeKey(sessionId, userId);
  const runtimePromise = store.runtimes.get(key);
  if (!runtimePromise) return false;

  let storedRuntime: LivePiRuntime;
  try {
    storedRuntime = await runtimePromise;
  } catch {
    if (store.runtimes.get(key) === runtimePromise) {
      store.runtimes.delete(key);
    }
    return false;
  }
  if (storedRuntime !== runtime || store.runtimes.get(key) !== runtimePromise) {
    return false;
  }
  store.runtimes.delete(key);
  runtime.dispose();
  return true;
}

export async function getOrCreatePiRuntimeWithState(sessionId: string, userId: string) {
  const store = getStore();
  const key = getRuntimeKey(sessionId, userId);
  const existing = store.runtimes.get(key);
  if (existing) {
    const runtime = await existing;
    runtime.touch();
    return { runtime, created: false };
  }

  const runtimePromise = createRuntime(sessionId, userId);
  store.runtimes.set(key, runtimePromise);

  try {
    const runtime = await runtimePromise;
    runtime.touch();
    return { runtime, created: true };
  } catch (error) {
    store.runtimes.delete(key);
    throw error;
  }
}

export async function getOrCreatePiRuntime(sessionId: string, userId: string) {
  const { runtime } = await getOrCreatePiRuntimeWithState(sessionId, userId);
  return runtime;
}

export async function dispatchPiRuntimeUserMessage(
  sessionId: string,
  userId: string,
  message: Extract<AgentMessage, { role: 'user' }>,
  context?: PiRuntimePromptContext,
  runtimeInstance?: PiRuntimePromptDispatchTarget,
) {
  return withPiSessionOperationLock(sessionId, userId, async () => {
    const currentRuntime = runtimeInstance
      ? await getExistingPiRuntime(sessionId, userId)
      : null;
    const runtimeHandle = runtimeInstance && currentRuntime === runtimeInstance
      ? { runtime: runtimeInstance, created: false }
      : await getOrCreatePiRuntimeWithState(sessionId, userId);
    const runtime = runtimeHandle.runtime;
    applyPiRuntimePromptContext(runtime, context);
    if (!runtimeHandle.created) {
      await runtime.reloadTools();
    }
    await runtime.refreshMemoryPrompt();
    await runtime.refreshWorkspaceFileTreePrompt();
    runtime.startPrompt(message, context);
    return runtime;
  });
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

/** Marks live sessions for a prompt reload at their next safe turn boundary. */
export async function requestPiRuntimePromptRefreshForUser(userId: string): Promise<number> {
  const store = getStore();
  let count = 0;
  for (const runtimePromise of store.runtimes.values()) {
    try {
      const runtime = await runtimePromise;
      if (runtime.userId !== userId) continue;
      runtime.requestSystemPromptRefresh();
      count += 1;
    } catch {
      // A failed runtime is cleaned up by the regular store lifecycle.
    }
  }
  return count;
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

  const sessionRecord = await findUnambiguousOwnedPiSessionForRuntime({ sessionId, userId });

  if (!sessionRecord) {
    return null;
  }

  const [loadedSession, lastProviderInputUsage] = await Promise.all([
    loadPiSessionWithSummary(sessionId, userId, sessionRecord.agentId),
    loadLatestPiSessionInputUsage(sessionId, userId),
  ]);
  const messages = loadedSession?.messages || [];
  const summary = loadedSession?.summary || {
    summaryText: null,
    summaryUpdatedAt: null,
    summaryThroughTimestamp: null,
    summaryThroughSequence: null,
    summaryRevision: 0,
  };
  const promptSnapshot = await ensurePiSessionSystemPromptSnapshot(sessionRecord);
  const systemPrompt = promptSnapshot.systemPrompt;
  const executionContext = await resolveAgentExecutionContextForSession({
    sessionId,
    userId,
    agentId: sessionRecord.agentId,
  });
  if (!executionContext.organizationId) {
    throw new Error('Complete the app AI runtime setup before loading the session runtime.');
  }
  const browserSnapshot = await refreshBrowserSessionSnapshot(executionContext);
  const tools = await getPiTools(userId, sessionRecord.agentId, sessionId, {
    executionContext,
    browserMode: browserSnapshot.running ? 'active' : 'dormant',
  });
  const executableRuntime = await resolveAndPinSessionRuntime({
    organizationId: executionContext.organizationId,
    userId,
    workspaceId: executionContext.workspaceId,
    workspaceType: executionContext.workspaceType,
    agentId: sessionRecord.agentId,
    sessionId,
    requestedSelection: null,
    executionMode: runtimeExecutionModeForSession(sessionRecord),
    principal: {
      type: 'user',
      userId,
      credentialSubjectUserId: userId,
    },
  });
  const model = executableRuntime.model;
  const browserRuntimeContextBlock = buildBrowserRuntimeContextBlock(browserSnapshot);
  const composition = composePiHistoryForLlm({
    messages,
    summary,
    systemPromptTokens: estimateTextTokens(systemPrompt),
    contextWindow: model.contextWindow,
    modelMaxTokens: model.maxTokens,
    requestOutputTokens: getPiRequestOutputTokenCap(model),
    toolTokens: estimatePiToolSchemaTokens(tools),
    additionalContextTokens: browserRuntimeContextBlock
      ? estimateTextTokens(browserRuntimeContextBlock)
      : 0,
  });
  const contextStatus = createPiRuntimeContextStatusProjection({
    composition,
    contextWindow: model.contextWindow,
  });

  return {
    sessionId,
    revision: currentRuntimeStatusRevision(sessionId, userId),
    ...(browserSnapshot.running ? { browser: browserSnapshot } : {}),
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
    finalRequestTokens: null,
    finalRequestBudgetExceeded: false,
    lastProviderInputTokens: lastProviderInputUsage?.inputTokens ?? null,
    lastProviderInputAt: lastProviderInputUsage?.assistantTimestamp.toISOString() ?? null,
    nextRequestEstimatedTokens: contextStatus.nextRequestEstimatedTokens,
    nextRequestBudgetExceeded: contextStatus.nextRequestBudgetExceeded,
    nextRequestEstimateSource: contextStatus.nextRequestEstimateSource,
    contextPressure: contextStatus.contextPressure,
    includedSummary: composition.includedSummary,
    omittedMessageCount: composition.omittedMessages.length,
    summaryUpdatedAt: summary.summaryUpdatedAt ? summary.summaryUpdatedAt.toISOString() : null,
    lastCompactionAt: summary.summaryUpdatedAt ? summary.summaryUpdatedAt.toISOString() : null,
    lastCompactionKind: summary.summaryUpdatedAt ? 'automatic' : null,
    lastCompactionOmittedCount: summary.summaryUpdatedAt ? composition.omittedMessages.length : 0,
    compactionStatus: IDLE_RUNTIME_COMPACTION_STATUS,
  };
}
