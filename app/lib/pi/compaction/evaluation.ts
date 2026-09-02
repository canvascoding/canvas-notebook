import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  DEFAULT_PI_CONTEXT_BUDGET_POLICY,
  validatePiContextBudgetPolicy,
  type PiContextBudgetPolicy,
} from '../context-budget';
import {
  composePiHistoryForLlm,
  estimatePiMessageTokens,
  type PiHistorySelectionMode,
  type PiSessionSummaryState,
} from '../history-budget';
import {
  isPiActionableUserMessage,
  isPiVisibleAssistantMessage,
} from './selection';
import { buildPiHistoryUnits } from './units';

export type PiCompactionVariantEvaluation = Readonly<{
  tailMode: 'legacy' | 'lean';
  messageCount: number;
  keptMessageCount: number;
  omittedMessageCount: number;
  originalTokens: number;
  keptTokens: number;
  omittedTokens: number;
  expectedSavingsTokens: number;
  expectedSavingsBasisPoints: number;
  targetHistoryTokens: number;
  historyPartitionLossCount: number;
  newlyOrphanedToolGroupCount: number;
  activeUserAnchored: boolean;
  visibleAssistantAnchored: boolean;
  selectionDurationMs: number;
}>;

export type PiCompactionShadowTelemetry = Readonly<{
  event: 'pi_compaction_shadow';
  schemaVersion: 1;
  executedSummaryMode: 'legacy';
  microCompactionEnabled: false;
  legacy: PiCompactionVariantEvaluation;
  lean: PiCompactionVariantEvaluation;
}>;

export type EvaluatePiCompactionVariantsInput = Readonly<{
  messages: AgentMessage[];
  summary: PiSessionSummaryState;
  systemPromptTokens: number;
  contextWindow: number;
  modelMaxTokens: number;
  requestOutputTokens: number;
  toolTokens: number;
  additionalContextTokens?: number;
  modelIdentity?: string;
  selectionMode?: Extract<PiHistorySelectionMode, 'automatic' | 'force'>;
  policy?: PiContextBudgetPolicy;
}>;

function isProjectionOnlyMessage(message: AgentMessage): boolean {
  return message.role === 'compact-break' || message.role === 'composio_auth_required';
}

function lastMatchingMessage(
  messages: readonly AgentMessage[],
  predicate: (message: AgentMessage) => boolean,
): AgentMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (predicate(messages[index])) return messages[index];
  }
  return null;
}

function countPartitionLosses(
  source: readonly AgentMessage[],
  kept: readonly AgentMessage[],
  omitted: readonly AgentMessage[],
): number {
  const expected = new Map<AgentMessage, number>();
  const actual = new Map<AgentMessage, number>();
  for (const message of source) expected.set(message, (expected.get(message) ?? 0) + 1);
  for (const message of [...kept, ...omitted]) {
    actual.set(message, (actual.get(message) ?? 0) + 1);
  }
  const messages = new Set([...expected.keys(), ...actual.keys()]);
  let losses = 0;
  for (const message of messages) {
    losses += Math.abs((expected.get(message) ?? 0) - (actual.get(message) ?? 0));
  }
  return losses;
}

function incompleteToolCallIds(messages: readonly AgentMessage[]): Set<string> {
  return new Set(buildPiHistoryUnits(messages).flatMap((unit) => (
    unit.kind === 'tool_group' && !unit.toolChainComplete ? [...unit.toolCallIds] : []
  )));
}

function evaluateVariant(
  input: EvaluatePiCompactionVariantsInput,
  tailMode: 'legacy' | 'lean',
): PiCompactionVariantEvaluation {
  const startedAt = performance.now();
  const policy = validatePiContextBudgetPolicy({
    ...(input.policy ?? DEFAULT_PI_CONTEXT_BUDGET_POLICY),
    tailMode,
  });
  const composition = composePiHistoryForLlm({
    messages: input.messages,
    summary: input.summary,
    systemPromptTokens: input.systemPromptTokens,
    contextWindow: input.contextWindow,
    modelMaxTokens: input.modelMaxTokens,
    requestOutputTokens: input.requestOutputTokens,
    toolTokens: input.toolTokens,
    additionalContextTokens: input.additionalContextTokens,
    modelIdentity: input.modelIdentity,
    selectionMode: input.selectionMode ?? 'automatic',
    policy,
  });
  const sourceMessages = input.messages.filter((message) => !isProjectionOnlyMessage(message));
  const originalTokens = sourceMessages.reduce(
    (total, message) => total + estimatePiMessageTokens(message),
    0,
  );
  const keptTokens = composition.keptMessages.reduce(
    (total, message) => total + estimatePiMessageTokens(message),
    0,
  );
  const omittedTokens = composition.omittedMessages.reduce(
    (total, message) => total + estimatePiMessageTokens(message),
    0,
  );
  const expectedSavingsTokens = Math.max(0, originalTokens - keptTokens);
  const originalIncompleteIds = incompleteToolCallIds(sourceMessages);
  const keptIncompleteIds = incompleteToolCallIds(composition.keptMessages);
  const activeUser = lastMatchingMessage(sourceMessages, isPiActionableUserMessage);
  const visibleAssistant = lastMatchingMessage(sourceMessages, isPiVisibleAssistantMessage);

  return Object.freeze({
    tailMode,
    messageCount: sourceMessages.length,
    keptMessageCount: composition.keptMessages.length,
    omittedMessageCount: composition.omittedMessages.length,
    originalTokens,
    keptTokens,
    omittedTokens,
    expectedSavingsTokens,
    expectedSavingsBasisPoints: originalTokens > 0
      ? Math.floor(expectedSavingsTokens * 10_000 / originalTokens)
      : 0,
    targetHistoryTokens: composition.targetHistoryTokens,
    historyPartitionLossCount: countPartitionLosses(
      sourceMessages,
      composition.keptMessages,
      composition.omittedMessages,
    ),
    newlyOrphanedToolGroupCount: [...keptIncompleteIds]
      .filter((toolCallId) => !originalIncompleteIds.has(toolCallId)).length,
    activeUserAnchored: activeUser === null || composition.keptMessages.includes(activeUser),
    visibleAssistantAnchored: visibleAssistant === null
      || composition.keptMessages.includes(visibleAssistant),
    selectionDurationMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
  });
}

/** Runs deterministic, content-free legacy/lean selection measurement. */
export function evaluatePiCompactionVariants(
  input: EvaluatePiCompactionVariantsInput,
): Readonly<{
  legacy: PiCompactionVariantEvaluation;
  lean: PiCompactionVariantEvaluation;
}> {
  return Object.freeze({
    legacy: evaluateVariant(input, 'legacy'),
    lean: evaluateVariant(input, 'lean'),
  });
}

export function createPiCompactionShadowTelemetry(
  input: EvaluatePiCompactionVariantsInput,
): PiCompactionShadowTelemetry {
  const variants = evaluatePiCompactionVariants(input);
  return Object.freeze({
    event: 'pi_compaction_shadow',
    schemaVersion: 1,
    executedSummaryMode: 'legacy',
    microCompactionEnabled: false,
    ...variants,
  });
}
