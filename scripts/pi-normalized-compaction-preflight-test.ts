import assert from 'node:assert/strict';
import Module from 'node:module';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';

// No provider, database, browser, or session writes: exercise the real runtime
// transformation and payload normalization, intercepting only compaction work.
const internals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if ((request.startsWith('.') || request.startsWith('@/')) && request.endsWith('/auth')) return { auth: {} };
  if (request === '@earendil-works/pi-agent-core') return { Agent: class Agent {} };
  if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
    return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
  }
  return originalLoad(request, parent, isMain);
};

const model: Model<'openai-completions'> = {
  id: 'test', name: 'test', api: 'openai-completions', provider: 'test',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262_144, maxTokens: 262_144,
};
const summary = {
  summaryText: null, summaryUpdatedAt: null, summaryThroughTimestamp: null,
  summaryThroughSequence: null, summaryRevision: 0,
};

function toolHistory(resultSize: number): AgentMessage[] {
  const messages: AgentMessage[] = [{ role: 'user', content: 'Compare six web sources.', timestamp: 1 }];
  for (let index = 0; index < 6; index += 1) {
    messages.push({
      role: 'assistant', content: [{ type: 'toolCall', id: `tool-${index}`, name: 'web_search', arguments: { query: 'example' } }],
      api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: index * 2 + 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    messages.push({
      role: 'toolResult', toolCallId: `tool-${index}`, toolName: 'web_search',
      content: [{ type: 'text', text: `SOURCE-${index} ${'x'.repeat(resultSize)} RAW-TAIL-${index}` }],
      isError: false, timestamp: index * 2 + 3,
    });
  }
  return messages;
}

async function main() {
  const { LivePiRuntime } = await import('../app/lib/pi/live-runtime');
  const { composePiHistoryForLlm, isPiHistoryCompositionSendable } = await import('../app/lib/pi/history-budget');
  const { measurePiContextStatus } = await import('../app/lib/pi/context-status-measurement');
  const { inspectPiRuntimeCompactionPressure } = await import('../app/lib/pi/compaction/runtime-engine');
  const stopAtCompaction = new Error('compaction intercepted');
  const createRuntime = (overrides: Record<string, unknown> = {}) => {
    const calls: AgentMessage[][] = [];
    const runtime = Object.assign(Object.create(LivePiRuntime.prototype), {
      sessionId: 'normalized-preflight-test', provider: model.provider, model,
      requestOutputTokenCap: 8_192, summary: { ...summary }, messageContextSnapshots: new Map(),
      getRuntimeContextBlock: async () => null,
      getEffectiveSystemPrompt: () => 'system instructions', getEffectiveTools: () => [],
      lastProviderInputUsage: { inputTokens: 250_000, assistantTimestamp: new Date() },
      coordinateCompaction: async ({ messages }: { messages: AgentMessage[] }) => {
        calls.push(messages);
        throw stopAtCompaction;
      },
      ...overrides,
    });
    return { runtime, calls };
  };

  const messages = toolHistory(130_000);
  const before = JSON.stringify(messages);
  const raw = composePiHistoryForLlm({
    messages, summary, contextWindow: model.contextWindow, modelMaxTokens: model.maxTokens,
    systemPromptTokens: 11_214, toolTokens: 12_615, additionalContextTokens: 327,
    requestOutputTokens: 8_192,
  });
  assert.ok(raw.omittedMessages.length > 0, 'fixture reproduces premature raw-size selection');
  assert.equal(isPiHistoryCompositionSendable(raw, summary), false);

  const { runtime, calls } = createRuntime();
  const candidate = await runtime.transformContext(messages);
  assert.equal(calls.length, 0, 'large raw search results must not trigger a summary when their normalized payload fits');
  assert.equal(candidate.length, messages.length, 'keep every call/result pair, not just a selected tail');
  const cached = runtime.preparedRuntimePayload;
  assert.equal(cached.sourceMessages, candidate);
  const prepared = await runtime.prepareFinalPayload(candidate);
  assert.equal(prepared, cached.messages, 'reuse exactly the measured provider payload without normalizing again');
  assert.equal(runtime.preparedRuntimePayload, null);
  assert.equal(JSON.stringify(messages), before, 'raw state remains intact for persistence and compaction');
  for (let index = 0; index < 6; index += 1) {
    const result = prepared.find((message: AgentMessage) => message.role === 'toolResult' && message.toolCallId === `tool-${index}`);
    assert.ok(result, 'each result survives');
    assert.ok(JSON.stringify(result.content).includes(`SOURCE-${index}`));
    assert.ok(JSON.stringify(result.content).length < 13_000, 'use the existing bounded context projection');
  }
  const measurement = await measurePiContextStatus(runtime.lastComposition, {
    messages: candidate, model, effectiveInstructions: [{ role: 'system', content: 'system instructions' }],
    effectiveTools: [], requestOutputTokenCap: 8_192,
  });
  const pressure = inspectPiRuntimeCompactionPressure({ messages: candidate, model,
    outputReserveTokens: 8_192, fixedRequestTokens: 0, finalSnapshot: cached.budgetSnapshot });
  assert.equal(measurement.contextPressure.pressureTokens, pressure.pressure.authoritativeHistoryTokens,
    'status and compaction must use the same normalized history pressure');
  assert.ok(measurement.contextPressure.percentOfTrigger < 20);

  // Exceed even the raw byte guard: text projection must happen before full
  // composition, otherwise an empty/overflow projection could be measured.
  const huge = toolHistory(1_600_000);
  const hugeRuntime = createRuntime();
  const hugeCandidate = await hugeRuntime.runtime.transformContext(huge);
  assert.equal(hugeRuntime.calls.length, 0);
  assert.equal(hugeCandidate.length, huge.length);
  const measured = new Promise<void>((resolve) => {
    Object.assign(hugeRuntime.runtime, {
      agent: { state: { messages: huge } },
      getBrowserRuntimeContextTokenEstimate: () => 0,
      publishStatus: resolve,
    });
  });
  hugeRuntime.runtime.refreshContextMeasurement();
  await measured;
  assert.equal(hugeRuntime.runtime.contextMeasurementCache.metadata.state, 'current');
  assert.equal(hugeRuntime.runtime.contextMeasurementCache.current.nextRequestBudgetExceeded, false,
    'the actual live status must not treat raw tool bytes as an overflow');
  assert.equal(hugeRuntime.runtime.contextMeasurementCache.current.nextRequestEstimatedTokens,
    hugeRuntime.runtime.preparedRuntimePayload.budgetSnapshot.estimatedTotalTokens,
    'live status and send decision agree even above the raw byte guard');

  const thresholdHistory: AgentMessage[] = [{ role: 'user', content: 'x'.repeat(770_000), timestamp: 1 }];
  const thresholdRuntime = createRuntime();
  await assert.rejects(thresholdRuntime.runtime.transformContext(thresholdHistory), (error) => error === stopAtCompaction);
  assert.equal(thresholdRuntime.calls[0], thresholdHistory, 'real normalized pressure still compacts the original history');
  assert.equal(thresholdRuntime.runtime.lastFinalPayloadBudgetSnapshot.contextBudgetExceeded, false,
    'soft trigger must be enforced before the hard limit');

  const overflowHistory: AgentMessage[] = [{ role: 'user', content: 'x'.repeat(1_100_000), timestamp: 1 }];
  const overflowRuntime = createRuntime();
  await assert.rejects(overflowRuntime.runtime.transformContext(overflowHistory), (error) => error === stopAtCompaction);
  assert.equal(overflowRuntime.runtime.lastFinalPayloadBudgetSnapshot.contextBudgetExceeded, true);

  const byteOverflow = createRuntime();
  await assert.rejects(byteOverflow.runtime.transformContext([
    { role: 'user', content: 'x'.repeat(9_000_000), timestamp: 1 },
  ]), (error) => error === stopAtCompaction, 'an oversized full projection must never send an empty request');

  // Existing summary coverage still replaces only the covered prefix.
  const summarized = createRuntime({ summary: {
    summaryText: 'Earlier search completed.', summaryUpdatedAt: new Date(),
    summaryThroughTimestamp: 5, summaryThroughSequence: null, summaryRevision: 1,
  } });
  const compactedHistory: AgentMessage[] = [
    { role: 'user', content: 'old content', timestamp: 1 },
    { role: 'compact-break' } as AgentMessage,
    { role: 'user', content: 'new content', timestamp: 10 },
  ];
  const summarizedCandidate = await summarized.runtime.transformContext(compactedHistory);
  assert.equal(summarized.calls.length, 0);
  assert.ok(JSON.stringify(summarizedCandidate).includes('Earlier search completed.'));
  assert.ok(JSON.stringify(summarizedCandidate).includes('new content'));
  assert.ok(!JSON.stringify(summarizedCandidate).includes('old content'));
  console.log('pi normalized compaction preflight tests passed');
}

main().finally(() => { internals._load = originalLoad; }).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
