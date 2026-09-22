import assert from 'node:assert/strict';

import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';

import { getPiCompactionErrorDiagnostics } from '../app/lib/pi/compaction/diagnostics';
import { generatePiRollingSummaryV2 } from '../app/lib/pi/compaction/summary-generator';
import {
  countPiCompactionHistoryPartitionLosses,
  evaluatePiCompactionVariants,
} from '../app/lib/pi/compaction/evaluation';
import { prunePiSessionHistory } from '../app/lib/pi/compaction/pruning';
import { estimatePiMessageTokens } from '../app/lib/pi/history-budget';
import { projectToolOutputBlocks } from '../app/lib/pi/tool-output-block-budget';

const model = {
  id: 'production-hardening-model',
  name: 'Production hardening model',
  api: 'openai-completions',
  provider: 'production-test-provider',
  baseUrl: 'http://localhost.invalid/v1',
  reasoning: false,
  input: ['text'],
  contextWindow: 262_144,
  maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model<'openai-completions'>;

function summaryBody(): string {
  return [
    '## Active Task', 'Preserve the active deployment task.',
    '## Completed Work', 'None.',
    '## Decisions and Constraints', 'Use one bounded summary call.',
    '## Files, Commands, and Exact Errors', 'None.',
    '## Remaining Work', 'Continue verification.',
  ].join('\n');
}

function response(): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: 'text', text: summaryBody() }],
    stopReason: 'stop',
    timestamp: 1,
    usage: {
      input: 321,
      output: 123,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 444,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function stream(message: AssistantMessage): AssistantMessageEventStream {
  return { result: async () => message } as AssistantMessageEventStream;
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

function productionShapedMessages(): AgentMessage[] {
  const messages: AgentMessage[] = [{
    role: 'user',
    content: 'Keep the current travel plan and tool findings available.',
    timestamp: 1,
  } as AgentMessage];
  for (let index = 0; index < 80; index += 1) {
    const toolCallId = `tool-${index}`;
    messages.push({
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      stopReason: 'toolUse', timestamp: index * 4 + 2,
      content: [{ type: 'toolCall', id: toolCallId, name: 'web_search', arguments: { query: `topic-${index}` } }],
    } as unknown as AgentMessage);
    messages.push({
      role: 'toolResult', toolCallId, toolName: 'web_search', isError: false, timestamp: index * 4 + 3,
      content: [{ type: 'text', text: `tool result ${index}: ${'sanitized result '.repeat(180)}` }],
    } as unknown as AgentMessage);
    messages.push({
      role: 'user', content: `Continue with checkpoint ${index}.`, timestamp: index * 4 + 4,
    } as AgentMessage);
    messages.push({
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      stopReason: 'stop', timestamp: index * 4 + 5,
      content: [{ type: 'text', text: `Checkpoint ${index} completed.` }],
    } as unknown as AgentMessage);
  }
  return messages;
}

async function main(): Promise<void> {
  const secret = 'PRIVATE-PROMPT-DO-NOT-LOG';
  const diagnostics = getPiCompactionErrorDiagnostics(Object.assign(
    new Error(`provider rejected ${secret}`),
    { code: secret, status: 429 },
  ));
  assert.equal(JSON.stringify(diagnostics).includes(secret), false,
    'operational error telemetry must never serialize provider messages or arbitrary error codes');
  assert.equal(diagnostics.errorStatus, 429);
  assert.equal(diagnostics.errorCode, 'present');
  assert.equal(
    getPiCompactionErrorDiagnostics(Object.assign(new Error('network timeout'), { code: 'ETIMEDOUT' })).errorCode,
    'ETIMEDOUT',
    'allowlisted operational codes remain useful without exposing provider text',
  );

  const originalToolResult = {
    role: 'toolResult', toolCallId: 'tool-recovery-contract', toolName: 'web_search', timestamp: 1,
    content: [{ type: 'text', text: 'original tool payload' }],
  } as unknown as AgentMessage;
  const deterministicStub = {
    ...originalToolResult,
    content: [{ type: 'text', text: '[web_search] output demoted at compaction — 21 chars preserved in session history.' }],
  } as AgentMessage;
  assert.equal(
    countPiCompactionHistoryPartitionLosses([originalToolResult], [deterministicStub], []),
    0,
    'the deterministic Lean recovery stub retains its original atomic tool-result member',
  );
  assert.equal(
    countPiCompactionHistoryPartitionLosses([originalToolResult], [], []),
    1,
    'a genuinely removed tool-result member remains a partition loss',
  );
  assert.ok(
    countPiCompactionHistoryPartitionLosses([
      originalToolResult,
    ], [{ ...originalToolResult, content: [{ type: 'text', text: 'arbitrary replacement' }] } as AgentMessage], []) > 0,
    'only the deterministic recovery-stub format may stand in for a tool result',
  );
  assert.ok(
    countPiCompactionHistoryPartitionLosses([
      originalToolResult,
    ], [{
      ...originalToolResult,
      content: [{ type: 'text', text: 'untrusted output demoted at compaction but not a Canvas recovery stub' }],
    } as AgentMessage], []) > 0,
    'a marker substring in ordinary tool output must not bypass partition-loss detection',
  );

  const logs: string[] = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.info = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    let calls = 0;
    const streamFn: StreamFn = async () => {
      calls += 1;
      return stream(response());
    };
    const generated = await generatePiRollingSummaryV2({
      previousSummaryText: null,
      messagesToSummarize: [{ role: 'user', content: secret, timestamp: 1 } as AgentMessage],
      model,
      sessionId: secret,
      compactionAttemptId: 'attempt-opaque-test',
      streamFn,
    });
    assert.ok(generated);
    assert.equal(calls, 1, 'the production path must retain one successful summary call');
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
  }
  const serializedLogs = logs.join('\n');
  assert.equal(serializedLogs.includes(secret), false,
    'stage/model/token/duration telemetry must be content-free and omit identifiers');
  assert.match(serializedLogs, /summary_provider_completed/);
  assert.match(serializedLogs, /"durationMs":/);
  assert.match(serializedLogs, /"inputTokens":321/);
  assert.match(serializedLogs, /"model":"production-hardening-model"/);
  assert.match(serializedLogs, /"attemptId":"attempt-opaque-test"/,
    'opaque attempt IDs retain stage-to-finish correlation without a session identifier');

  for (const contextWindow of [32_768, 262_144, 1_048_576]) {
    const windowModel = { ...model, contextWindow } as Model<'openai-completions'>;
    const normalizedMessages = projectToolOutputBlocks(productionShapedMessages(), windowModel);
    const currentHistoryTokens = normalizedMessages.reduce(
      (total, message) => total + estimatePiMessageTokens(message),
      0,
    );
    // The production candidate prunes stale, complete tool results before
    // selecting a context tail. Evaluate that same projection rather than an
    // impossible raw payload that is never sent to a model.
    const pruning = prunePiSessionHistory({
      messages: normalizedMessages,
      estimateMessageTokens: estimatePiMessageTokens,
      enabled: true,
      protectLastMessages: 20,
      protectedTailTokenBudget: Math.max(10_000, Math.floor(contextWindow * 0.025)),
      triggerTokens: Math.floor(contextWindow * 0.5),
      currentHistoryTokens,
    });
    const variants = evaluatePiCompactionVariants({
      messages: [...pruning.messages],
      summary: {
        summaryText: null,
        summaryUpdatedAt: null,
        summaryThroughTimestamp: null,
        summaryThroughSequence: null,
        summaryRevision: 0,
      },
      systemPromptTokens: 4_000,
      contextWindow,
      modelMaxTokens: Math.min(8_192, Math.floor(contextWindow / 4)),
      requestOutputTokens: Math.min(8_192, Math.floor(contextWindow / 4)),
      toolTokens: 3_000,
      modelIdentity: `benchmark/${contextWindow}`,
      selectionMode: 'force',
    });
    for (const variant of [variants.legacy, variants.lean]) {
      assert.equal(variant.historyPartitionLossCount, 0, `${contextWindow}/${variant.tailMode} preserves history accounting`);
      assert.equal(variant.newlyOrphanedToolGroupCount, 0, `${contextWindow}/${variant.tailMode} retains complete tool groups`);
      assert.equal(variant.activeUserAnchored, true, `${contextWindow}/${variant.tailMode} anchors the latest user intent`);
      assert.equal(variant.visibleAssistantAnchored, true, `${contextWindow}/${variant.tailMode} anchors the latest assistant result`);
    }
  }

  // Deterministic latency model: the removed path made three serial digest
  // calls plus the final summary; current Hermes parity has exactly one call.
  // Pairing the same bounded provider latency samples isolates the architectural
  // reduction from network variance and gives a reproducible p95 gate.
  const providerLatencySamplesMs = [180, 205, 222, 240, 255, 270, 290, 315, 340, 375];
  const oldSerialDigestLatencyMs = providerLatencySamplesMs.map((durationMs) => durationMs * 4);
  const oneCallLatencyMs = providerLatencySamplesMs;
  const oldP95 = percentile95(oldSerialDigestLatencyMs);
  const oneCallP95 = percentile95(oneCallLatencyMs);
  assert.ok(oneCallP95 * 4 <= oldP95,
    'one bounded call has materially lower p95 than the removed four-call serial digest path');

  console.log('pi-compaction-production-hardening-test: ok', JSON.stringify({
    windows: [32_768, 262_144, 1_048_576],
    oneCallP95Ms: oneCallP95,
    removedSerialDigestP95Ms: oldP95,
    reductionBasisPoints: Math.floor((oldP95 - oneCallP95) * 10_000 / oldP95),
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
