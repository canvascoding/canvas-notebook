/**
 * Rollout and scorecard invariants adapted from NousResearch/hermes-agent at
 * f293e7206b4ddd66042329442c6afebc19a8808d.
 * Copyright (c) 2025 Nous Research, MIT License.
 */

import assert from 'node:assert/strict';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  createPiCompactionShadowTelemetry,
  evaluatePiCompactionVariants,
} from '../app/lib/pi/compaction/evaluation';
import {
  DEFAULT_PI_COMPACTION_ROLLOUT_MODE,
  getPiCompactionRolloutDecision,
  resolvePiCompactionRolloutMode,
} from '../app/lib/pi/compaction/rollout';
import { preparePiHermesCompactionCandidate } from '../app/lib/pi/compaction/runtime-engine';

function assistantText(text: string, timestamp: number): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'test',
    provider: 'test',
    model: 'test',
    stopReason: 'stop',
    timestamp,
  } as AgentMessage;
}

function representativeSession(): AgentMessage[] {
  const messages: AgentMessage[] = [{
    role: 'user',
    content: 'Implement the session-compaction rollout and preserve deploy code SAFE-ROOT.',
    timestamp: 1,
  }] as AgentMessage[];
  for (let index = 0; index < 60; index += 1) {
    const toolCallId = `call-${index}`;
    messages.push({
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: toolCallId,
        name: 'read_file',
        arguments: { path: `/workspace/fixture-${index}.txt` },
      }],
      api: 'test',
      provider: 'test',
      model: 'test',
      stopReason: 'toolUse',
      timestamp: index * 4 + 2,
    } as unknown as AgentMessage);
    messages.push({
      role: 'toolResult',
      toolCallId,
      toolName: 'read_file',
      content: [{ type: 'text', text: `fixture-${index} ${'representative tool output '.repeat(300)}` }],
      isError: false,
      timestamp: index * 4 + 3,
    } as AgentMessage);
    messages.push({
      role: 'user',
      content: `Continue checkpoint ${index}; exact constraint USER-${index}.`,
      timestamp: index * 4 + 4,
    } as AgentMessage);
    messages.push(assistantText(`Checkpoint ${index} completed.`, index * 4 + 5));
  }
  return messages;
}

assert.equal(DEFAULT_PI_COMPACTION_ROLLOUT_MODE, 'v2');
assert.equal(resolvePiCompactionRolloutMode(undefined), 'v2');
assert.equal(resolvePiCompactionRolloutMode(' V2 '), 'v2');
assert.equal(resolvePiCompactionRolloutMode('shadow'), 'shadow');
assert.equal(resolvePiCompactionRolloutMode('legacy'), 'legacy');
assert.equal(resolvePiCompactionRolloutMode('invalid'), 'v2');
assert.deepEqual(getPiCompactionRolloutDecision('legacy'), {
  mode: 'legacy',
  summaryMode: 'legacy',
  pruningEnabled: false,
  shadowEvaluationEnabled: false,
  microCompactionEnabled: false,
});
assert.deepEqual(getPiCompactionRolloutDecision('shadow'), {
  mode: 'shadow',
  summaryMode: 'legacy',
  pruningEnabled: false,
  shadowEvaluationEnabled: true,
  microCompactionEnabled: false,
});
assert.deepEqual(getPiCompactionRolloutDecision('v2'), {
  mode: 'v2',
  summaryMode: 'hermes_v2',
  pruningEnabled: true,
  shadowEvaluationEnabled: false,
  microCompactionEnabled: false,
});

const messages = representativeSession();
const input = {
  messages,
  summary: {
    summaryText: null,
    summaryUpdatedAt: null,
    summaryThroughTimestamp: null,
    summaryThroughSequence: null,
    summaryRevision: 0,
  },
  systemPromptTokens: 1_500,
  contextWindow: 128_000,
  modelMaxTokens: 8_192,
  requestOutputTokens: 8_192,
  toolTokens: 2_000,
  additionalContextTokens: 500,
  modelIdentity: 'test:openai-completions:rollout-scorecard',
  selectionMode: 'force' as const,
};
const scorecard = evaluatePiCompactionVariants(input);
for (const variant of [scorecard.legacy, scorecard.lean]) {
  assert.equal(variant.historyPartitionLossCount, 0, `${variant.tailMode} must account for all history`);
  assert.equal(variant.newlyOrphanedToolGroupCount, 0, `${variant.tailMode} must keep tool groups atomic`);
  assert.equal(variant.activeUserAnchored, true, `${variant.tailMode} must retain the latest user`);
  assert.equal(variant.visibleAssistantAnchored, true, `${variant.tailMode} must retain the latest assistant`);
  assert(
    variant.expectedSavingsBasisPoints > 500,
    `${variant.tailMode} must project more than five percent savings`,
  );
  assert.equal(
    variant.originalTokens,
    variant.keptTokens + variant.omittedTokens,
    `${variant.tailMode} token accounting must close`,
  );
}
assert(
  scorecard.lean.keptTokens <= scorecard.legacy.keptTokens,
  'lean must never retain more raw history than legacy for the same session',
);

const telemetry = createPiCompactionShadowTelemetry(input);
assert.equal(telemetry.event, 'pi_compaction_shadow');
assert.equal(telemetry.executedSummaryMode, 'legacy');
assert.equal(telemetry.microCompactionEnabled, false);
assert.equal(JSON.stringify(telemetry).includes('SAFE-ROOT'), false, 'shadow telemetry must be content-free');
assert.equal(JSON.stringify(telemetry).includes('USER-59'), false, 'shadow telemetry must not leak user text');

async function verifyRuntimeIntegration(): Promise<void> {
  let runtimeShadowTelemetry: typeof telemetry | null = null;
  const runtimeCandidate = await preparePiHermesCompactionCandidate({
    messages,
    summary: input.summary,
    systemPromptTokens: input.systemPromptTokens,
    model: {
      id: 'rollout-scorecard',
      name: 'Rollout Scorecard',
      api: 'openai-completions',
      provider: 'test',
      baseUrl: 'http://localhost.invalid/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: input.contextWindow,
      maxTokens: input.modelMaxTokens,
    },
    requestOutputTokens: input.requestOutputTokens,
    toolTokens: input.toolTokens,
    additionalContextTokens: input.additionalContextTokens,
    sessionId: 'rollout-shadow-test',
    signal: new AbortController().signal,
    selectionMode: 'force',
    rolloutMode: 'shadow',
    onShadowTelemetry: (event) => {
      runtimeShadowTelemetry = event;
    },
  });
  assert.ok(runtimeShadowTelemetry, 'shadow runtime must emit the content-free comparison');
  assert.equal(runtimeCandidate.pruning.changed, false, 'shadow runtime must execute the V1 pruning path');
  assert.equal(runtimeCandidate.summaryUpdated, false, 'a missing V1 summary provider must fail without state change');

  console.log('session-compaction-v2-rollout-test: ok', JSON.stringify({
    legacy: {
      keptTokens: scorecard.legacy.keptTokens,
      savingsBasisPoints: scorecard.legacy.expectedSavingsBasisPoints,
      selectionDurationMs: scorecard.legacy.selectionDurationMs,
    },
    lean: {
      keptTokens: scorecard.lean.keptTokens,
      savingsBasisPoints: scorecard.lean.expectedSavingsBasisPoints,
      selectionDurationMs: scorecard.lean.selectionDurationMs,
    },
  }));
}

verifyRuntimeIntegration().catch((error) => {
  console.error(error);
  process.exit(1);
});
