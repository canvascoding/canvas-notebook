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

function toolResultReplacementKey(message: AgentMessage): string | null {
  if (message.role !== 'toolResult') return null;
  const record = message as unknown as Record<string, unknown>;
  const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : '';
  const toolName = typeof record.toolName === 'string' ? record.toolName : '';
  const timestamp = typeof record.timestamp === 'number' ? record.timestamp : 0;
  return toolCallId ? `${toolCallId}\u0000${toolName}\u0000${timestamp}` : null;
}

function isLeanToolResultRecoveryStub(message: AgentMessage): boolean {
  if (message.role !== 'toolResult') return false;
  const record = message as unknown as { content?: unknown; toolName?: unknown };
  if (!Array.isArray(record.content) || record.content.length !== 1) return false;
  const part = record.content[0];
  if (
    !part || typeof part !== 'object'
    || (part as { type?: unknown }).type !== 'text'
    || typeof (part as { text?: unknown }).text !== 'string'
  ) return false;
  const toolName = typeof record.toolName === 'string' && record.toolName.trim()
    ? record.toolName.trim()
    : 'tool';
  const escapedToolName = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const characterCount = '(?:0|[1-9]\\d{0,2}(?:,\\d{3})*)';
  const recoveryHint = "(?: Recover with session_search\\(query='<keywords>', session_id='[A-Za-z0-9._:-]{1,128}'\\)\\.)?";
  const marker = new RegExp(
    `^\\[${escapedToolName}\\] output demoted at compaction — ${characterCount} chars preserved in session history\\.${recoveryHint}$`,
  );
  return marker.test((part as { text: string }).text);
}

/**
 * Counts genuine projection losses. Lean is allowed to replace an old retained
 * tool result with its deterministic recovery stub, but it may never erase a
 * message or use that exception for an arbitrary replacement.
 */
export function countPiCompactionHistoryPartitionLosses(
  source: readonly AgentMessage[],
  kept: readonly AgentMessage[],
  omitted: readonly AgentMessage[],
): number {
  const actual = [...kept, ...omitted];
  const consumed = new Set<number>();
  let unmatchedExpected = 0;
  for (const expected of source) {
    const identicalIndex = actual.findIndex((candidate, index) => (
      !consumed.has(index) && candidate === expected
    ));
    if (identicalIndex >= 0) {
      consumed.add(identicalIndex);
      continue;
    }
    const key = toolResultReplacementKey(expected);
    const replacementIndex = key === null ? -1 : actual.findIndex((candidate, index) => (
      !consumed.has(index)
      && toolResultReplacementKey(candidate) === key
      && isLeanToolResultRecoveryStub(candidate)
    ));
    if (replacementIndex >= 0) {
      consumed.add(replacementIndex);
      continue;
    }
    unmatchedExpected += 1;
  }
  return unmatchedExpected + (actual.length - consumed.size);
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
    historyPartitionLossCount: countPiCompactionHistoryPartitionLosses(
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
