import assert from 'node:assert/strict';

import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';

import { testAgentModelConnection } from '../app/lib/agents/model-test';

const fakeModel: Model<Api> = {
  id: 'probe-model',
  name: 'Probe Model',
  provider: 'test-provider',
  api: 'openai-completions',
  baseUrl: 'https://provider.example.test/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

const managedModel: Model<Api> & { managedProvider: string } = {
  ...fakeModel,
  id: 'managed-probe-model',
  provider: 'canvas-control-plane',
  managedProvider: 'openrouter',
};

function assistantText(model: Model<Api>, text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
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
  };
}

async function main() {
  const missingRuntime = await testAgentModelConnection({
    agentId: 'provider-verification',
    provider: '',
    model: fakeModel,
    complete: async () => assistantText(fakeModel, 'OK'),
  });
  assert.equal(missingRuntime.success, false);
  assert.equal(missingRuntime.code, 'MODEL_NOT_CONFIGURED');

  const failed = await testAgentModelConnection({
    agentId: 'provider-verification',
    provider: fakeModel.provider,
    model: fakeModel,
    complete: async () => {
      throw new Error('provider unavailable');
    },
  });
  assert.equal(failed.success, false);
  assert.equal(failed.code, 'MODEL_TEST_FAILED');

  const inexact = await testAgentModelConnection({
    agentId: 'provider-verification',
    provider: fakeModel.provider,
    model: fakeModel,
    complete: async () => assistantText(fakeModel, 'Not OK'),
  });
  assert.equal(inexact.success, false);
  assert.equal(inexact.code, 'MODEL_TEST_UNEXPECTED_RESPONSE');

  const punctuated = await testAgentModelConnection({
    agentId: 'provider-verification',
    provider: fakeModel.provider,
    model: fakeModel,
    complete: async () => assistantText(fakeModel, 'OK.'),
  });
  assert.equal(punctuated.success, true);

  const successful = await testAgentModelConnection({
    agentId: 'provider-verification',
    provider: fakeModel.provider,
    model: fakeModel,
    complete: async () => assistantText(fakeModel, 'OK'),
  });
  assert.equal(successful.success, true);

  let managedAttempts = 0;
  const managedRetry = await testAgentModelConnection({
    agentId: 'provider-verification',
    provider: managedModel.provider,
    model: managedModel,
    sleep: async () => undefined,
    complete: async () => {
      managedAttempts += 1;
      if (managedAttempts === 1) {
        return {
          ...assistantText(managedModel, ''),
          stopReason: 'aborted',
          errorMessage: 'Transient managed timeout',
        };
      }
      return assistantText(managedModel, 'OK');
    },
  });
  assert.equal(managedRetry.success, true);
  assert.equal(managedRetry.attempts, 2);
  assert.equal(managedAttempts, 2);

  const callerAbort = new AbortController();
  callerAbort.abort(new Error('request disconnected'));
  let abortedProviderCalls = 0;
  const aborted = await testAgentModelConnection({
    agentId: 'provider-verification',
    provider: fakeModel.provider,
    model: fakeModel,
    signal: callerAbort.signal,
    complete: async () => {
      abortedProviderCalls += 1;
      return assistantText(fakeModel, 'OK');
    },
  });
  assert.equal(aborted.success, false);
  assert.equal(aborted.code, 'MODEL_TEST_ABORTED');
  assert.equal(abortedProviderCalls, 0);

  let budgetAttempts = 0;
  const totalBudget = await testAgentModelConnection({
    agentId: 'provider-verification',
    provider: managedModel.provider,
    model: managedModel,
    timeoutMs: 5,
    sleep: async () => new Promise((resolve) => setTimeout(resolve, 15)),
    complete: async () => {
      budgetAttempts += 1;
      return {
        ...assistantText(managedModel, ''),
        stopReason: 'aborted',
        errorMessage: 'Transient managed timeout',
      };
    },
  });
  assert.equal(totalBudget.success, false);
  assert.equal(totalBudget.code, 'MODEL_TEST_TIMEOUT');
  assert.equal(totalBudget.attempts, 1);
  assert.equal(budgetAttempts, 1, 'The retry delay must not reset the total probe budget.');

  console.log('agent-model-probe-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
