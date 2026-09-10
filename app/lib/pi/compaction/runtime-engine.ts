import { projectToolOutputBlocks } from '../tool-output-block-budget';
/**
 * Runtime integration for the Hermes-derived compaction capabilities.
 * The engine is shared by live chat and automations; persistence and locking
 * remain owned by Canvas' coordinator/store boundary.
 */

import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { logPiCompactionDiagnostic } from './diagnostics';

import {
  DEFAULT_PI_CONTEXT_BUDGET_POLICY,
  validatePiContextBudgetPolicy,
  type PiContextBudgetPolicy,
  type PiContextBudgetSnapshot,
} from '../context-budget';
import {
  composePiHistoryForLlm,
  estimatePiMessageTokens,
  type PiHistoryComposition,
  type PiHistorySelectionMode,
  type PiSessionSummaryState,
} from '../history-budget';
import {
  createSessionCompactionBudget,
  evaluateSessionCompactionPressure,
  type SessionCompactionBudget,
  type SessionCompactionPressure,
} from './policy';
import { prunePiSessionHistory, type PiPruningResult } from './pruning';
import { preparePiHistoryContext, type PreparePiHistoryContextResult } from '../session-summary';
import type { PiSummaryProgressEvent } from './summary-generator';
import {
  createPiCompactionShadowTelemetry,
  type PiCompactionShadowTelemetry,
} from './evaluation';
import {
  getPiCompactionRolloutDecision,
  type PiCompactionRolloutMode,
} from './rollout';

export type PiRuntimeCompactionInspection = Readonly<{
  budget: SessionCompactionBudget;
  roughHistoryTokens: number;
  pressure: SessionCompactionPressure;
}>;

export function getPiFinalPayloadPressure(snapshot: PiContextBudgetSnapshot): number {
  const contextWindowTokens = snapshot.contextWindowTokens ?? 0;
  const contextOverflow = Math.max(0, (snapshot.estimatedTotalTokens ?? 0) - contextWindowTokens);
  const serializedPayloadOverflow = Math.max(
    0,
    (snapshot.serializedMessageBytes ?? 0) - (snapshot.hardHistoryBytes ?? 0),
  );
  const imagePayloadOverflow = Math.max(
    0,
    (snapshot.multimodalBytes ?? 0) - (snapshot.totalImageBytesLimit ?? 0),
  );
  return Math.max(
    contextOverflow,
    Math.ceil(serializedPayloadOverflow / 4),
    Math.ceil(imagePayloadOverflow / 256),
  );
}

export function getPiFinalPayloadRetryLoad(snapshot: PiContextBudgetSnapshot): number {
  const contextWindowTokens = snapshot.contextWindowTokens ?? 0;
  const serializedPayloadOverflow = Math.max(
    0,
    (snapshot.serializedMessageBytes ?? 0) - (snapshot.hardHistoryBytes ?? 0),
  );
  const imagePayloadOverflow = Math.max(
    0,
    (snapshot.multimodalBytes ?? 0) - (snapshot.totalImageBytesLimit ?? 0),
  );
  return Math.max(
    snapshot.estimatedTotalTokens ?? 0,
    contextWindowTokens + Math.ceil(serializedPayloadOverflow / 4),
    contextWindowTokens + Math.ceil(imagePayloadOverflow / 256),
  );
}

export function inspectPiRuntimeCompactionPressure(input: {
  messages: readonly AgentMessage[];
  model: Model<Api>;
  outputReserveTokens: number;
  fixedRequestTokens: number;
  finalSnapshot?: PiContextBudgetSnapshot | null;
  providerActualInputTokens?: number | null;
  policy?: PiContextBudgetPolicy;
}): PiRuntimeCompactionInspection {
  const policy = validatePiContextBudgetPolicy(
    input.policy ?? DEFAULT_PI_CONTEXT_BUDGET_POLICY,
  );
  const snapshot = input.finalSnapshot ?? null;
  const outputReserveTokens = snapshot?.outputReserveTokens ?? input.outputReserveTokens;
  const fixedRequestTokens = snapshot
    ? snapshot.effectiveInstructionTokens
      + snapshot.toolSchemaTokens
      + snapshot.runtimeProviderOverheadTokens
      + snapshot.multimodalTokens
      + snapshot.safetyReserveTokens
    : input.fixedRequestTokens;
  const budget = createSessionCompactionBudget({
    contextWindowTokens: input.model.contextWindow,
    outputReserveTokens,
    fixedRequestTokens,
    modelIdentity: `${input.model.provider}:${input.model.api}:${input.model.id}`,
    config: {
      thresholdRatio: policy.triggerRatio,
      targetRatioOfThreshold: policy.targetRatio,
      minimumContextTokens: policy.minimumContextTokens,
      smallContextWindowLimitTokens: policy.smallContextWindowLimitTokens,
      smallContextThresholdFloorRatio: policy.smallContextThresholdFloorRatio,
      degenerateThresholdRatio: policy.degenerateThresholdRatio,
      modelThresholds: policy.modelThresholds,
      thresholdTokensCap: policy.thresholdTokensCap,
      protectFirstMessages: policy.protectFirstMessages,
      protectLastMessages: policy.protectLastMessages,
      maximumAttempts: policy.maxCompactionAttempts,
      tailMode: policy.tailMode,
    },
  });
  const roughHistoryTokens = input.messages.reduce(
    (total, message) => total + estimatePiMessageTokens(message),
    0,
  );
  const pressure = evaluateSessionCompactionPressure({
    budget,
    messageCount: input.messages.length,
    roughHistoryTokens,
    authoritativeNextRequestTokens: snapshot?.estimatedTotalTokens ?? null,
    providerActualInputTokens: input.providerActualInputTokens,
    payloadBudgetExceeded: snapshot?.payloadBudgetExceeded,
  });
  return Object.freeze({ budget, roughHistoryTokens, pressure });
}

export type PreparePiHermesCompactionCandidateInput = Readonly<{
  compactionAttemptId?: string;
  messages: AgentMessage[];
  summary: PiSessionSummaryState;
  systemPromptTokens: number;
  model: Model<Api>;
  requestOutputTokens: number;
  toolTokens: number;
  additionalContextTokens?: number;
  sessionId: string;
  signal: AbortSignal;
  streamFn?: StreamFn;
  selectionMode?: Extract<PiHistorySelectionMode, 'automatic' | 'force'>;
  focusTopic?: string | null;
  policy?: PiContextBudgetPolicy;
  onSummaryProgress?: (event: PiSummaryProgressEvent) => void;
  rolloutMode?: PiCompactionRolloutMode;
  onShadowTelemetry?: (telemetry: PiCompactionShadowTelemetry) => void;
}>;

export type PreparePiHermesCompactionCandidateResult = PreparePiHistoryContextResult & Readonly<{
  pruning: PiPruningResult;
}>;

export type ProjectPiHermesHistoryInput = Readonly<{
  messages: AgentMessage[];
  summary: PiSessionSummaryState;
  systemPromptTokens: number;
  model: Model<Api>;
  requestOutputTokens: number;
  toolTokens: number;
  additionalContextTokens?: number;
  selectionMode?: PiHistorySelectionMode;
  policy?: PiContextBudgetPolicy;
  rolloutMode?: PiCompactionRolloutMode;
  pruningMode?: 'disabled' | 'candidate';
}>;

export type PiHermesHistoryProjection = Readonly<{
  composition: PiHistoryComposition;
  inspection: PiRuntimeCompactionInspection;
  pruning: PiPruningResult;
}>;

/**
 * Builds the deterministic history projection shared by request preparation
 * and runtime status. The persisted transcript stays intact; only the LLM
 * projection receives safe, idempotent pruning.
 */
export function projectPiHermesHistory(
  input: ProjectPiHermesHistoryInput,
): PiHermesHistoryProjection {
  const messages = projectToolOutputBlocks(input.messages, input.model);
  const policy = validatePiContextBudgetPolicy(
    input.policy ?? DEFAULT_PI_CONTEXT_BUDGET_POLICY,
  );
  const rollout = getPiCompactionRolloutDecision(input.rolloutMode);
  const inspection = inspectPiRuntimeCompactionPressure({
    messages,
    model: input.model,
    outputReserveTokens: input.requestOutputTokens,
    fixedRequestTokens:
      input.systemPromptTokens
      + input.toolTokens
      + Math.max(0, input.additionalContextTokens ?? 0)
      + policy.safetyFloorTokens,
    policy,
  });
  const pruning = prunePiSessionHistory({
    messages,
    estimateMessageTokens: estimatePiMessageTokens,
    enabled: rollout.pruningEnabled && input.pruningMode === 'candidate',
    protectLastMessages: policy.protectLastMessages,
    protectedTailTokenBudget: inspection.budget.targetTailTokens,
    triggerTokens: inspection.budget.triggerTokens,
    currentHistoryTokens: inspection.roughHistoryTokens,
  });
  const composition = composePiHistoryForLlm({
    messages: [...pruning.messages],
    summary: input.summary,
    systemPromptTokens: input.systemPromptTokens,
    contextWindow: input.model.contextWindow,
    modelMaxTokens: input.model.maxTokens,
    requestOutputTokens: input.requestOutputTokens,
    toolTokens: input.toolTokens,
    additionalContextTokens: input.additionalContextTokens,
    modelIdentity: `${input.model.provider}:${input.model.api}:${input.model.id}`,
    selectionMode: input.selectionMode ?? 'automatic',
    policy,
  });
  return Object.freeze({ composition, inspection, pruning });
}

export async function preparePiHermesCompactionCandidate(
  input: PreparePiHermesCompactionCandidateInput,
): Promise<PreparePiHermesCompactionCandidateResult> {
  const policy = validatePiContextBudgetPolicy(
    input.policy ?? DEFAULT_PI_CONTEXT_BUDGET_POLICY,
  );
  const rollout = getPiCompactionRolloutDecision(input.rolloutMode);
  const projection = projectPiHermesHistory({ ...input, pruningMode: 'candidate' });
  logPiCompactionDiagnostic('info', 'candidate_projection', {
    sessionId: input.sessionId,
    attemptId: input.compactionAttemptId ?? null,
    selectionMode: input.selectionMode ?? 'automatic',
    rawEstimatedTokens: input.messages.reduce((total, message) => total + estimatePiMessageTokens(message), 0),
    projectedEstimatedTokens: projection.inspection.roughHistoryTokens,
    messageCount: input.messages.length,
    minimumRequiredTokens: projection.composition.minimumRequiredTokens,
    availableHistoryTokens: projection.composition.availableHistoryTokens,
    contextBudgetExceeded: projection.composition.contextBudgetExceeded,
    payloadBudgetExceeded: projection.composition.payloadBudgetExceeded,
  });
  if (rollout.shadowEvaluationEnabled) {
    const telemetry = createPiCompactionShadowTelemetry({
      messages: input.messages,
      summary: input.summary,
      systemPromptTokens: input.systemPromptTokens,
      contextWindow: input.model.contextWindow,
      modelMaxTokens: input.model.maxTokens,
      requestOutputTokens: input.requestOutputTokens,
      toolTokens: input.toolTokens,
      additionalContextTokens: input.additionalContextTokens,
      modelIdentity: `${input.model.provider}:${input.model.api}:${input.model.id}`,
      selectionMode: input.selectionMode,
      policy,
    });
    if (input.onShadowTelemetry) {
      input.onShadowTelemetry(telemetry);
    } else {
      console.info('[PI Compaction Shadow]', JSON.stringify(telemetry));
    }
  }
  const candidate = await preparePiHistoryContext({
    compactionAttemptId: input.compactionAttemptId,
    messages: [...projection.pruning.messages],
    summary: input.summary,
    systemPromptTokens: input.systemPromptTokens,
    model: input.model,
    requestOutputTokens: input.requestOutputTokens,
    toolTokens: input.toolTokens,
    additionalContextTokens: input.additionalContextTokens,
    sessionId: input.sessionId,
    signal: input.signal,
    streamFn: input.streamFn,
    summaryMode: rollout.summaryMode,
    selectionMode: input.selectionMode ?? 'automatic',
    focusTopic: input.focusTopic,
    policy,
    authorizedSessionId: input.sessionId,
    onSummaryProgress: input.onSummaryProgress,
  });
  return Object.freeze({ ...candidate, pruning: projection.pruning });
}
