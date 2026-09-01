import type { AgentMessage, AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Message, Model } from '@earendil-works/pi-ai';

import {
  DEFAULT_PI_CONTEXT_BUDGET_POLICY,
  estimatePiToolSchemaTokens,
  type PiContextBudgetSnapshot,
} from '@/app/lib/pi/context-budget';
import {
  getPiFinalPayloadRetryLoad,
  preparePiHermesCompactionCandidate,
} from '@/app/lib/pi/compaction/runtime-engine';
import { sessionCompactionWarrantsAnotherPass } from '@/app/lib/pi/compaction/policy';
import { estimateTextTokens, type PiSessionSummaryState } from '@/app/lib/pi/history-budget';
import type { PiMessageNormalizationOptions } from '@/app/lib/pi/message-normalization';
import { preparePiFinalPayload } from '@/app/lib/pi/multimodal-preparation';

export type AutomationRuntimePayloadRecovery = Readonly<{
  messages: Message[];
  budgetSnapshot: PiContextBudgetSnapshot;
  summary: PiSessionSummaryState;
}>;

export function isAutomationSummaryProjectionMessage(message: AgentMessage): boolean {
  return message.role === 'user'
    && 'timestamp' in message
    && message.timestamp === 0
    && 'content' in message
    && typeof message.content === 'string'
    && message.content.includes('<internal_session_summary>');
}

function withoutPersistedMessageSequence(message: AgentMessage): AgentMessage {
  const clone = { ...message } as AgentMessage & { sequence?: number };
  delete clone.sequence;
  return clone;
}

/**
 * Builds an in-run automation recovery payload without advancing the durable
 * summary watermark. The raw run messages are persisted normally after the
 * automation completes, while this transient summary only protects the current
 * provider request from context overflow.
 */
export async function recoverAutomationRuntimePayload(input: {
  messages: AgentMessage[];
  summary: PiSessionSummaryState;
  model: Model<Api>;
  tools: AgentTool[];
  effectiveSystemPrompt: string;
  requestOutputTokenCap: number;
  sessionId: string;
  signal: AbortSignal;
  streamFn: StreamFn;
  imageNormalizationOptions?: PiMessageNormalizationOptions;
  initialSnapshot?: PiContextBudgetSnapshot | null;
}): Promise<AutomationRuntimePayloadRecovery | null> {
  const compactionMessages = input.messages
    .filter((message) => !isAutomationSummaryProjectionMessage(message))
    .map(withoutPersistedMessageSequence);
  let summary: PiSessionSummaryState = {
    ...input.summary,
    summaryThroughSequence: null,
  };
  let previousLoad = input.initialSnapshot
    ? getPiFinalPayloadRetryLoad(input.initialSnapshot)
    : input.model.contextWindow;
  const maximumAttempts = DEFAULT_PI_CONTEXT_BUDGET_POLICY.maxCompactionAttempts ?? 3;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const candidate = await preparePiHermesCompactionCandidate({
      messages: compactionMessages,
      summary,
      systemPromptTokens: estimateTextTokens(input.effectiveSystemPrompt),
      model: input.model,
      requestOutputTokens: input.requestOutputTokenCap,
      toolTokens: estimatePiToolSchemaTokens(input.tools),
      sessionId: input.sessionId,
      signal: input.signal,
      streamFn: input.streamFn,
      selectionMode: 'force',
    });
    summary = candidate.summary;
    const exact = await preparePiFinalPayload({
      messages: candidate.composition.llmMessages,
      model: input.model,
      effectiveInstructions: [{ role: 'system', content: input.effectiveSystemPrompt }],
      effectiveTools: input.tools,
      requestOutputTokenCap: input.requestOutputTokenCap,
      runtimeContractRevision: 'canvas-pi-automation-v1',
    }, input.imageNormalizationOptions);
    if (
      !exact.budgetSnapshot.payloadBudgetExceeded
      && !exact.budgetSnapshot.contextBudgetExceeded
    ) {
      return Object.freeze({ ...exact, summary });
    }
    const nextLoad = getPiFinalPayloadRetryLoad(exact.budgetSnapshot);
    if (!sessionCompactionWarrantsAnotherPass({
      originalTokens: previousLoad,
      newTokens: nextLoad,
      thresholdTokens: exact.budgetSnapshot.contextWindowTokens,
    })) break;
    previousLoad = nextLoad;
  }
  return null;
}
