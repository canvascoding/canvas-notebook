import assert from 'node:assert/strict';
import Module from 'node:module';

import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';

async function main() {
  const moduleLoader = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = function loadWithServerOnlyMock(request, parent, isMain) {
    if (request === 'server-only') {
      return {};
    }

    if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
      return {
        registerBuiltInApiProviders: () => undefined,
        getProviders: () => [],
        getModels: () => [],
      };
    }

    if (request === '@earendil-works/pi-ai/oauth') {
      return {};
    }

    if (request.endsWith('/pi/api-key-resolver')) {
      throw new Error('Session summaries must not load the legacy API-key resolver.');
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  const { preparePiHistoryContext, summarizePiSessionHistory } = await import('../app/lib/pi/session-summary');
  const { composePiHistoryForLlm, estimateTextTokens, getUnsummarizedMessages } = await import('../app/lib/pi/history-budget');
  const { MAX_LLM_HISTORY_BYTES } = await import('../app/lib/pi/llm-payload-limits');

  const model = {
    id: 'summary-test-model',
    name: 'Summary Test Model',
    api: 'openai-completions',
    provider: 'missing-summary-provider',
    baseUrl: 'http://localhost.invalid/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4_000,
    maxTokens: 512,
  } satisfies Model<'openai-completions'>;

  const messages: AgentMessage[] = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: index % 2 === 0
      ? `User turn ${index}: ${'older context '.repeat(30)}`
      : [{ type: 'text', text: `Assistant turn ${index}: ${'tool findings '.repeat(30)}` }],
    timestamp: 1_000 + index,
    ...(index % 2 === 1
      ? {
          api: 'test',
          provider: 'test',
          model: 'test',
          stopReason: 'stop',
        }
      : {}),
  } as AgentMessage));

  const result = await preparePiHistoryContext({
    messages,
    summary: {
      summaryText: null,
      summaryUpdatedAt: null,
      summaryThroughTimestamp: null,
      summaryThroughSequence: null,
      summaryRevision: 0,
    },
    systemPromptTokens: 200,
    model,
    toolTokens: 0,
    sessionId: 'summary-test',
  });

  assert.equal(result.summaryAttempted, true);
  assert.equal(result.summaryUpdated, false);
  assert.equal(result.summaryFailed, true);
  assert.equal(result.summary.summaryText, null);
  assert.ok(result.unsummarizedMessageCount > 0);
  assert.ok(result.composition.omittedMessages.length > 0);
  assert.equal(result.safeToSend, false);

  const summaryStreamCalls: Array<{ modelId: string; sessionId?: string; messageCount: number }> = [];
  const summaryStreamFn: StreamFn = async (requestedModel, context, options) => {
    summaryStreamCalls.push({
      modelId: requestedModel.id,
      sessionId: options?.sessionId,
      messageCount: context.messages.length,
    });
    return {
      result: async () => ({
        role: 'assistant',
        content: [{ type: 'text', text: 'Scoped runtime summary' }],
        api: requestedModel.api,
        provider: requestedModel.provider,
        model: requestedModel.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      } as AssistantMessage),
    } as AssistantMessageEventStream;
  };
  const scopedResult = await preparePiHistoryContext({
    messages,
    summary: {
      summaryText: null,
      summaryUpdatedAt: null,
      summaryThroughTimestamp: null,
      summaryThroughSequence: null,
      summaryRevision: 0,
    },
    systemPromptTokens: 200,
    model: { ...model, contextWindow: 4_000, maxTokens: 1_000 },
    toolTokens: 0,
    sessionId: 'summary-scoped-runtime-test',
    streamFn: summaryStreamFn,
  });
  assert.equal(scopedResult.summaryAttempted, true);
  assert.equal(scopedResult.summaryUpdated, true);
  assert.equal(scopedResult.summaryFailed, false);
  assert.equal(scopedResult.summary.summaryText, 'Scoped runtime summary');
  assert.equal(scopedResult.safeToSend, true);
  assert.deepEqual(
    scopedResult.composition.keptMessages.slice(0, 3),
    messages.slice(0, 3),
    'the first three messages remain verbatim through the first compaction result',
  );
  assert.ok(summaryStreamCalls.length > 0);
  assert.equal(summaryStreamCalls[0].modelId, model.id);
  assert.equal(summaryStreamCalls[0].sessionId, 'summary-scoped-runtime-test:summary');
  assert.ok(summaryStreamCalls[0].messageCount > 1);

  const summaryAbortController = new AbortController();
  let abortedSummaryStreamCalls = 0;
  const abortingSummaryStreamFn: StreamFn = async (requestedModel, context, options) => {
    abortedSummaryStreamCalls += 1;
    assert.equal(options?.signal, summaryAbortController.signal);
    assert.ok(context.messages.length < 9, 'the test input must require more than one summary batch');
    summaryAbortController.abort();
    return {
      result: async () => ({
        role: 'assistant',
        content: [{ type: 'text', text: 'This batch should not permit another provider call.' }],
        api: requestedModel.api,
        provider: requestedModel.provider,
        model: requestedModel.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      } as AssistantMessage),
    } as AssistantMessageEventStream;
  };
  const multiBatchSummaryMessages = Array.from({ length: 8 }, (_, index) => ({
    role: 'user' as const,
    content: `Summary batch ${index}: ${'large historical record '.repeat(300)}`,
    timestamp: 20_000 + index,
  }));
  await assert.rejects(
    summarizePiSessionHistory({
      previousSummaryText: null,
      messagesToSummarize: multiBatchSummaryMessages,
      model: { ...model, contextWindow: 4_000, maxTokens: 512 },
      sessionId: 'summary-abort-between-batches',
      signal: summaryAbortController.signal,
      streamFn: abortingSummaryStreamFn,
    }),
    /Summary generation was aborted/u,
  );
  assert.equal(
    abortedSummaryStreamCalls,
    1,
    'an aborted multi-batch summary must not start another provider request',
  );
  await assert.rejects(
    preparePiHistoryContext({
      messages,
      summary: {
        summaryText: null,
        summaryUpdatedAt: null,
        summaryThroughTimestamp: null,
        summaryThroughSequence: null,
        summaryRevision: 0,
      },
      systemPromptTokens: 200,
      model: { ...model, contextWindow: 4_000, maxTokens: 512 },
      toolTokens: 0,
      sessionId: 'summary-aborted-candidate',
      signal: summaryAbortController.signal,
      streamFn: abortingSummaryStreamFn,
    }),
    /Summary generation was aborted/u,
  );

  const noOmittedResult = await preparePiHistoryContext({
    messages: messages.slice(-1),
    summary: {
      summaryText: null,
      summaryUpdatedAt: null,
      summaryThroughTimestamp: null,
      summaryThroughSequence: null,
      summaryRevision: 0,
    },
    systemPromptTokens: 200,
    model,
    toolTokens: 0,
    sessionId: 'summary-test-small',
  });

  assert.equal(noOmittedResult.summaryAttempted, false);
  assert.equal(noOmittedResult.summaryUpdated, false);
  assert.equal(noOmittedResult.summaryFailed, false);
  assert.equal(noOmittedResult.unsummarizedMessageCount, 0);
  assert.equal(noOmittedResult.safeToSend, true);

  const softLimitMessages = Array.from({ length: 10 }, (_, index) => ({
    role: 'user' as const,
    content: `Soft limit turn ${index}: ${'context '.repeat(100)}`,
    timestamp: 30_000 + index,
  }));
  const safeFallbackResult = await preparePiHistoryContext({
    messages: softLimitMessages,
    summary: {
      summaryText: null,
      summaryUpdatedAt: null,
      summaryThroughTimestamp: null,
      summaryThroughSequence: null,
      summaryRevision: 0,
    },
    systemPromptTokens: 200,
    model: { ...model, contextWindow: 4_000, maxTokens: 1_000 },
    requestOutputTokens: 800,
    toolTokens: 0,
    sessionId: 'summary-hard-fallback',
  });
  assert.equal(safeFallbackResult.summaryAttempted, true);
  assert.equal(safeFallbackResult.summaryFailed, true);
  assert.equal(safeFallbackResult.safeToSend, true);
  assert.equal(safeFallbackResult.composition.omittedMessages.length, 0);

  const outOfOrderOmittedMessages = [
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'summarized earlier' }],
      api: 'test',
      provider: 'test',
      model: 'test',
      stopReason: 'stop',
      timestamp: 5_000,
      sequence: 1,
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'newer in db order, older timestamp' }],
      api: 'test',
      provider: 'test',
      model: 'test',
      stopReason: 'stop',
      timestamp: 4_000,
      sequence: 2,
    },
  ] as unknown as AgentMessage[];

  const unsummarized = getUnsummarizedMessages(outOfOrderOmittedMessages, 5_000, 1);
  assert.equal(unsummarized.length, 1);
  assert.equal((unsummarized[0] as unknown as { sequence: number }).sequence, 2);

  const atomicUnsummarized = getUnsummarizedMessages([
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-boundary', name: 'read', arguments: {} }],
      api: 'test',
      provider: 'test',
      model: 'test',
      stopReason: 'toolUse',
      timestamp: 6_000,
      sequence: 1,
    },
    {
      role: 'toolResult',
      toolCallId: 'call-boundary',
      toolName: 'read',
      content: [{ type: 'text', text: 'new result' }],
      timestamp: 6_001,
      sequence: 2,
    },
  ] as unknown as AgentMessage[], 6_000, 1);
  assert.equal(atomicUnsummarized.length, 2, 'summary input must not split a tool call/result unit');

  const compactedComposition = composePiHistoryForLlm({
    messages: [
      { role: 'user', content: 'current visible turn', timestamp: 1_000, sequence: 3 } as unknown as AgentMessage,
      { role: 'compact-break', kind: 'manual', timestamp: '2026-06-05T10:00:00.000Z', omittedMessageCount: 12 } as unknown as AgentMessage,
    ],
    summary: {
      summaryText: 'Prior compacted context',
      summaryUpdatedAt: new Date('2026-06-05T10:00:00.000Z'),
      summaryThroughTimestamp: 5_000,
      summaryThroughSequence: 2,
      summaryRevision: 1,
    },
    systemPromptTokens: 200,
    contextWindow: 10_000,
    modelMaxTokens: 512,
    toolTokens: 0,
  });
  assert.equal(compactedComposition.includedSummary, true);
  assert.equal(compactedComposition.llmMessages.some((message) => message.role === 'compact-break'), false);

  const firstMessage = 'Recherchier im internet einmal nach einem marp präsentations doku um eine test marp präsi zu erstellen';
  assert.equal(estimateTextTokens(firstMessage), Math.ceil(firstMessage.length / 4));
  const initialMessageComposition = composePiHistoryForLlm({
    messages: [{ role: 'user', content: firstMessage, timestamp: 8_000 } as unknown as AgentMessage],
    summary: {
      summaryText: null,
      summaryUpdatedAt: null,
      summaryThroughTimestamp: null,
      summaryThroughSequence: null,
      summaryRevision: 0,
    },
    systemPromptTokens: 12_000,
    contextWindow: 32_000,
    modelMaxTokens: 32_000,
    toolTokens: 6_000,
    additionalContextTokens: 200,
  });
  assert.equal(initialMessageComposition.contextBudgetExceeded, false);
  assert.equal(initialMessageComposition.llmMessages.length, 1);
  assert.ok(initialMessageComposition.availableHistoryTokens >= initialMessageComposition.estimatedHistoryTokens);

  const oversizedComposition = composePiHistoryForLlm({
    messages: [{ role: 'user', content: 'x'.repeat(8_000), timestamp: 9_000 } as unknown as AgentMessage],
    summary: {
      summaryText: null,
      summaryUpdatedAt: null,
      summaryThroughTimestamp: null,
      summaryThroughSequence: null,
      summaryRevision: 0,
    },
    systemPromptTokens: 1_500,
    contextWindow: 4_096,
    modelMaxTokens: 2_048,
    toolTokens: 1_000,
    additionalContextTokens: 200,
  });
  assert.equal(oversizedComposition.contextBudgetExceeded, true);
  assert.equal(oversizedComposition.llmMessages.length, 0);
  assert.ok(oversizedComposition.minimumRequiredTokens > oversizedComposition.availableHistoryTokens);

  const payloadOversizedComposition = composePiHistoryForLlm({
    messages: [{ role: 'user', content: 'x'.repeat(MAX_LLM_HISTORY_BYTES + 1), timestamp: 10_000 } as unknown as AgentMessage],
    summary: {
      summaryText: null,
      summaryUpdatedAt: null,
      summaryThroughTimestamp: null,
      summaryThroughSequence: null,
      summaryRevision: 0,
    },
    systemPromptTokens: 0,
    contextWindow: MAX_LLM_HISTORY_BYTES * 2,
    modelMaxTokens: 1,
    toolTokens: 0,
  });
  assert.equal(payloadOversizedComposition.contextBudgetExceeded, true);
  assert.equal(payloadOversizedComposition.payloadBudgetExceeded, true);
  assert.equal(payloadOversizedComposition.llmMessages.length, 0);
  assert.ok(payloadOversizedComposition.minimumRequiredBytes > payloadOversizedComposition.availableHistoryBytes);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
