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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
