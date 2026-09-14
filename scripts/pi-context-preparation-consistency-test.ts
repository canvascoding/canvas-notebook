import assert from 'node:assert/strict';
import Module from 'node:module';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';

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
  id: 'context-regression', name: 'Context regression', api: 'openai-completions', provider: 'test',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262_144, maxTokens: 8_192,
};
const emptySummary = {
  summaryText: null, summaryUpdatedAt: null, summaryThroughTimestamp: null,
  summaryThroughSequence: null, summaryRevision: 0,
};

function history(): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < 90; i++) {
    messages.push({ role: 'user', content: `Read source ${i}.`, timestamp: i * 3 + 1 });
    messages.push({
      role: 'assistant', content: [{ type: 'toolCall', id: `call-${i}`, name: 'read', arguments: { path: `source-${i}.md` } }],
      api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: i * 3 + 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    messages.push({ role: 'toolResult', toolCallId: `call-${i}`, toolName: 'read',
      content: [{ type: 'text', text: `SOURCE-${i} ${'x'.repeat(8_500)}` }],
      isError: false, timestamp: i * 3 + 3 });
  }
  messages.push({ role: 'user', content: 'Continue the current project.', timestamp: 1_000 });
  return messages;
}

async function main() {
  const { LivePiRuntime } = await import('../app/lib/pi/live-runtime');
  const { preparePiHermesCompactionCandidate, projectPiHermesHistory } = await import('../app/lib/pi/compaction/runtime-engine');
  const { measurePiContextStatus } = await import('../app/lib/pi/context-status-measurement');
  const { estimateTextTokens } = await import('../app/lib/pi/history-budget');
  const messages = history();
  const original = JSON.stringify(messages);
  const systemPrompt = 'system instructions '.repeat(2_000);
  const base = { messages, summary: emptySummary, model, systemPromptTokens: estimateTextTokens(systemPrompt),
    toolTokens: 0, requestOutputTokens: 8_192 };
  const measurementInput = { model, effectiveInstructions: [{ role: 'system' as const, content: systemPrompt }],
    effectiveTools: [], requestOutputTokenCap: 8_192 };
  const unpruned = projectPiHermesHistory({ ...base, selectionMode: 'full', pruningMode: 'disabled' });
  const originalStatus = await measurePiContextStatus(unpruned.composition,
    { ...measurementInput, messages: unpruned.composition.llmMessages });
  assert.ok(originalStatus.contextPressure.percentOfTrigger > 100, 'fixture crosses the soft trigger');
  assert.equal(originalStatus.nextRequestBudgetExceeded, false, 'fixture still fits the hard model window');

  let attempts = 0;
  const runtime = Object.assign(Object.create(LivePiRuntime.prototype), {
    sessionId: 'context-preparation-regression', provider: model.provider, model,
    requestOutputTokenCap: 8_192, summary: { ...emptySummary }, messageContextSnapshots: new Map(),
    agent: { state: { messages } },
    getEffectiveSystemPrompt: () => systemPrompt, getEffectiveTools: () => [],
    getBrowserRuntimeContextTokenEstimate: () => 0, getRuntimeContextBlock: async () => null,
    publishStatus: () => {},
    // Execute the real candidate preparation and summary decision. Only the
    // persistence/status coordinator is replaced in this provider-free fixture.
    coordinateCompaction: async (input: { messages: AgentMessage[]; selectionMode?: 'automatic' | 'force' }) => {
      attempts++;
      const candidate = await preparePiHermesCompactionCandidate({ ...base, messages: input.messages,
        sessionId: 'context-preparation-regression', selectionMode: input.selectionMode,
        signal: new AbortController().signal,
        streamFn: async () => { throw new Error('This history only needs deterministic tool pruning'); } });
      assert.equal(candidate.summaryAttempted, false);
      return { state: 'no_op', reasonCode: 'soft_threshold_not_reached', composition: candidate.composition };
    },
  });
  const outgoing = await runtime.transformContext(messages);
  const sentTokens = runtime.preparedRuntimePayload.budgetSnapshot.estimatedTotalTokens;
  const refreshed = new Promise<void>(resolve => { runtime.publishStatus = resolve; });
  runtime.refreshContextMeasurement();
  await refreshed;
  assert.equal(runtime.contextMeasurementCache.current.nextRequestEstimatedTokens, sentTokens,
    'the displayed next request must equal the actual prepared request after tool pruning');
  assert.equal(attempts, 0, 'pruning below the trigger must not start a summary attempt');
  const prepared = await runtime.prepareFinalPayload(outgoing);
  assert.equal(prepared.length, messages.length, 'all history records and tool pairs remain represented');
  assert.equal(JSON.stringify(messages), original, 'persisted source contents remain unchanged');
  assert.ok(runtime.contextMeasurementCache.current.contextPressure.percentOfTrigger < 100);

  // Reload takes the shared projection without a live runtime or its caches.
  const stored = projectPiHermesHistory({ ...base, selectionMode: 'full' });
  const storedStatus = await measurePiContextStatus(stored.composition,
    { ...measurementInput, messages: stored.composition.llmMessages });
  assert.equal(storedStatus.nextRequestEstimatedTokens, sentTokens);
  await runtime.transformContext(messages);
  assert.equal(attempts, 0, 'a later send must not repeat a no-op summary attempt');
  console.log('pi context preparation consistency tests passed');
}

main().finally(() => { internals._load = originalLoad; }).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
