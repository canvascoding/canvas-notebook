/**
 * Runtime integration for the Hermes-derived compaction capabilities.
 * The engine is shared by live chat and automations; persistence and locking
 * remain owned by Canvas' coordinator/store boundary.
 */

import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';

import {
  DEFAULT_PI_CONTEXT_BUDGET_POLICY,
  validatePiContextBudgetPolicy,
  type PiContextBudgetPolicy,
  type PiContextBudgetSnapshot,
} from '../context-budget';
import {
  estimatePiMessageTokens,
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
}>;

export type PreparePiHermesCompactionCandidateResult = PreparePiHistoryContextResult & Readonly<{
  pruning: PiPruningResult;
}>;

export async function preparePiHermesCompactionCandidate(
  input: PreparePiHermesCompactionCandidateInput,
): Promise<PreparePiHermesCompactionCandidateResult> {
  const policy = validatePiContextBudgetPolicy(
    input.policy ?? DEFAULT_PI_CONTEXT_BUDGET_POLICY,
  );
  const inspection = inspectPiRuntimeCompactionPressure({
    messages: input.messages,
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
    messages: input.messages,
    estimateMessageTokens: estimatePiMessageTokens,
    enabled: true,
    protectLastMessages: policy.protectLastMessages,
    protectedTailTokenBudget: inspection.budget.targetTailTokens,
    triggerTokens: inspection.budget.triggerTokens,
    currentHistoryTokens: inspection.roughHistoryTokens,
  });
  const candidate = await preparePiHistoryContext({
    messages: [...pruning.messages],
    summary: input.summary,
    systemPromptTokens: input.systemPromptTokens,
    model: input.model,
    requestOutputTokens: input.requestOutputTokens,
    toolTokens: input.toolTokens,
    additionalContextTokens: input.additionalContextTokens,
    sessionId: input.sessionId,
    signal: input.signal,
    streamFn: input.streamFn,
    summaryMode: 'hermes_v2',
    selectionMode: input.selectionMode ?? 'automatic',
    focusTopic: input.focusTopic,
    policy,
    authorizedSessionId: input.sessionId,
    onSummaryProgress: input.onSummaryProgress,
  });
  return Object.freeze({ ...candidate, pruning });
}
