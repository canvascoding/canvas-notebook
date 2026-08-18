import assert from 'node:assert/strict';

import type { Api, Model } from '@earendil-works/pi-ai';

import { omitUnsupportedTemperature } from '../app/lib/agent-runtime-policy/request-options';

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: 'test-model',
    name: 'Test model',
    provider: 'test',
    api: 'openai-completions',
    baseUrl: 'https://example.test/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_000,
    maxTokens: 1_000,
    ...overrides,
  } as Model<Api>;
}

const requested = { temperature: 0.2, maxTokens: 128, sessionId: 'email-harness' };

assert.deepEqual(
  omitUnsupportedTemperature(model({
    api: 'anthropic-messages',
    compat: { supportsTemperature: false },
  }), requested),
  { maxTokens: 128, sessionId: 'email-harness' },
);

assert.deepEqual(
  omitUnsupportedTemperature(model({ id: 'gpt-5.4', api: 'openai-responses', reasoning: true }), requested),
  { maxTokens: 128, sessionId: 'email-harness' },
);

assert.deepEqual(
  omitUnsupportedTemperature(model({ id: 'gpt-4.1', api: 'openai-responses' }), requested),
  requested,
);

assert.equal(omitUnsupportedTemperature(model(), undefined), undefined);

console.log('agent runtime temperature compatibility tests passed');
