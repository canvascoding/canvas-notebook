import assert from 'node:assert/strict';
import Module from 'node:module';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';

async function main() {
  const moduleLoader = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = function loadWithServerOnlyMock(request, parent, isMain) {
    if (request === 'server-only') {
      return {};
    }

    if (request === '@earendil-works/pi-ai') {
      return {
        registerBuiltInApiProviders: () => undefined,
        getProviders: () => [],
        getModels: () => [],
        completeSimple: async () => ({
          role: 'assistant',
          content: [{ type: 'text', text: 'unused summary' }],
          stopReason: 'stop',
        }),
      };
    }

    if (request === '@earendil-works/pi-ai/oauth') {
      return {};
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  const { preparePiHistoryContext } = await import('../app/lib/pi/session-summary');
  const { composePiHistoryForLlm, getUnsummarizedMessages } = await import('../app/lib/pi/history-budget');

  const model = {
    id: 'summary-test-model',
    name: 'Summary Test Model',
    api: 'openai-completions',
    provider: 'missing-summary-provider',
    baseUrl: 'http://localhost.invalid/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 2000,
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
    },
    systemPromptTokens: 200,
    model,
    toolCount: 0,
    sessionId: 'summary-test',
  });

  assert.equal(result.summaryAttempted, true);
  assert.equal(result.summaryUpdated, false);
  assert.equal(result.summaryFailed, true);
  assert.equal(result.summary.summaryText, null);
  assert.ok(result.unsummarizedMessageCount > 0);
  assert.ok(result.composition.omittedMessages.length > 0);

  const noOmittedResult = await preparePiHistoryContext({
    messages: messages.slice(-2),
    summary: {
      summaryText: null,
      summaryUpdatedAt: null,
      summaryThroughTimestamp: null,
      summaryThroughSequence: null,
    },
    systemPromptTokens: 200,
    model,
    toolCount: 0,
    sessionId: 'summary-test-small',
  });

  assert.equal(noOmittedResult.summaryAttempted, false);
  assert.equal(noOmittedResult.summaryUpdated, false);
  assert.equal(noOmittedResult.summaryFailed, false);
  assert.equal(noOmittedResult.unsummarizedMessageCount, 0);

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
    },
    systemPromptTokens: 200,
    contextWindow: 10_000,
    modelMaxTokens: 512,
    toolCount: 0,
  });
  assert.equal(compactedComposition.includedSummary, true);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
