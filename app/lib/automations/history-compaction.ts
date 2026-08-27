import 'server-only';

import { createHash } from 'node:crypto';
import type { AgentMessage, AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';

import {
  estimatePiToolSchemaTokens,
  serializePiEffectiveToolSchemas,
} from '@/app/lib/pi/context-budget';
import {
  composePiHistoryForLlm,
  isPiHistoryCompositionSendable,
  type PiHistoryComposition,
  type PiSessionSummaryState,
} from '@/app/lib/pi/history-budget';
import { MAX_LLM_HISTORY_BYTES } from '@/app/lib/pi/llm-payload-limits';
import { runPiSessionCompaction } from '@/app/lib/pi/session-compaction-coordinator';
import { preparePiHistoryContext } from '@/app/lib/pi/session-summary';

export type PrepareAutomationHistoryInput = Readonly<{
  sessionId: string;
  userId: string;
  agentId: string;
  workspaceId: string;
  messages: AgentMessage[];
  promptMessage: AgentMessage;
  summary: PiSessionSummaryState;
  persistedMessageCheckpoint: number;
  model: Model<Api>;
  tools: AgentTool[];
  effectiveSystemPrompt: string;
  systemPromptBudgetTokens: number;
  requestOutputTokens: number;
  runtimeCatalogRevision: number;
  runtimePolicyRevision: number;
  signal: AbortSignal;
  streamFn: StreamFn;
}>;

export type PreparedAutomationHistory = Readonly<{
  summary: PiSessionSummaryState;
  composition: PiHistoryComposition;
  attemptId: string | null;
  compactionState: 'not_needed' | 'succeeded' | 'no_op' | 'deferred' | 'fallback';
}>;

function assertPromptRetained(composition: PiHistoryComposition, promptMessage: AgentMessage): void {
  if (composition.llmMessages[composition.llmMessages.length - 1] !== promptMessage) {
    throw new Error('Automation prompt could not be retained inside the model context budget.');
  }
}

export async function prepareAutomationHistoryWithCompaction(
  input: PrepareAutomationHistoryInput,
): Promise<PreparedAutomationHistory> {
  const toolTokens = estimatePiToolSchemaTokens(input.tools);
  const compose = (selectionMode: 'automatic' | 'hard_limit' = 'automatic') => composePiHistoryForLlm({
    messages: input.messages,
    summary: input.summary,
    systemPromptTokens: input.systemPromptBudgetTokens,
    contextWindow: input.model.contextWindow,
    modelMaxTokens: input.model.maxTokens,
    requestOutputTokens: input.requestOutputTokens,
    toolTokens,
    selectionMode,
  });
  const preflight = compose();
  if (
    !preflight.softThresholdExceeded
    && !preflight.contextBudgetExceeded
    && isPiHistoryCompositionSendable(preflight, input.summary)
  ) {
    assertPromptRetained(preflight, input.promptMessage);
    return {
      summary: input.summary,
      composition: preflight,
      attemptId: null,
      compactionState: 'not_needed',
    };
  }

  const generationHash = createHash('sha256');
  generationHash.update(JSON.stringify({
    provider: input.model.provider,
    model: input.model.id,
    contextWindow: input.model.contextWindow,
    modelMaxTokens: input.model.maxTokens,
    requestOutputTokens: input.requestOutputTokens,
    summaryRevision: input.summary.summaryRevision,
    summaryThroughSequence: input.summary.summaryThroughSequence,
    messageSequenceCheckpoint: input.persistedMessageCheckpoint,
    workspaceId: input.workspaceId,
    runtimeCatalogRevision: input.runtimeCatalogRevision,
    runtimePolicyRevision: input.runtimePolicyRevision,
  }));
  generationHash.update(input.effectiveSystemPrompt);
  generationHash.update(serializePiEffectiveToolSchemas(input.tools));
  generationHash.update(JSON.stringify(input.promptMessage));
  const generation = generationHash.digest('hex');
  const result = await runPiSessionCompaction({
    sessionId: input.sessionId,
    userId: input.userId,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    trigger: 'automation',
    generation,
    expectedSummaryRevision: input.summary.summaryRevision,
    expectedThroughSequence: input.summary.summaryThroughSequence,
    provider: input.model.provider,
    model: input.model.id,
    contractFingerprint: generation,
    metrics: {
      beforeEstimatedTokens: preflight.estimatedHistoryTokens,
      beforeEstimatedBytes: preflight.estimatedHistoryBytes,
    },
    signal: input.signal,
    isGenerationCurrent: (candidateGeneration) => (
      !input.signal.aborted && candidateGeneration === generation
    ),
    prepareCandidate: (candidateSignal) => preparePiHistoryContext({
      messages: input.messages.slice(),
      summary: { ...input.summary },
      systemPromptTokens: input.systemPromptBudgetTokens,
      model: input.model,
      requestOutputTokens: input.requestOutputTokens,
      toolTokens,
      sessionId: input.sessionId,
      signal: candidateSignal,
      streamFn: input.streamFn,
    }),
  });
  if (result.state === 'succeeded' && result.summary && result.composition) {
    assertPromptRetained(result.composition, input.promptMessage);
    return {
      summary: result.summary,
      composition: result.composition,
      attemptId: result.attemptId,
      compactionState: 'succeeded',
    };
  }
  if (
    (result.state === 'no_op' || result.state === 'deferred')
    && result.composition
    && isPiHistoryCompositionSendable(result.composition, input.summary)
  ) {
    assertPromptRetained(result.composition, input.promptMessage);
    return {
      summary: input.summary,
      composition: result.composition,
      attemptId: result.attemptId,
      compactionState: result.state,
    };
  }
  if (result.reasonCode === 'payload_bytes_exceeded') {
    throw new Error(
      `Automation request exceeds the ${Math.floor(MAX_LLM_HISTORY_BYTES / (1024 * 1024))}MB LLM transfer budget. `
      + 'Shorten the latest prompt or attachments.',
    );
  }
  if (result.reasonCode === 'fixed_context_too_large') {
    throw new Error('Automation context exceeds the selected model window. Use a larger-context model or start a new automation session.');
  }
  if (result.state === 'aborted' || input.signal.aborted) {
    throw new Error('Automation context compaction was aborted.');
  }
  if (result.state === 'stale') {
    throw new Error('Automation context changed while compaction was running. Retry the automation.');
  }

  const fallback = compose('hard_limit');
  if (isPiHistoryCompositionSendable(fallback, input.summary)) {
    assertPromptRetained(fallback, input.promptMessage);
    return {
      summary: input.summary,
      composition: fallback,
      attemptId: result.attemptId,
      compactionState: 'fallback',
    };
  }
  if (result.state === 'cooldown_active') {
    throw new Error(
      `Automation context compaction is cooling down${result.retryAt ? ` until ${result.retryAt.toISOString()}` : ''}, and the complete history no longer fits.`,
    );
  }
  if (result.state === 'already_running') {
    throw new Error('Automation context compaction is already running, and the complete history cannot be sent safely yet.');
  }
  if (result.reasonCode === 'summary_timeout') {
    throw new Error('Automation context compaction timed out, and the complete history cannot be sent safely.');
  }
  if (result.reasonCode === 'summary_provider_error') {
    throw new Error('Automation context compaction could not update the summary, and the complete history cannot be sent safely.');
  }
  throw new Error('Automation context compaction could not preserve complete history coverage inside the selected model window.');
}
