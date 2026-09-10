import assert from 'node:assert/strict';
import { getModels, streamSimple } from '@earendil-works/pi-ai/compat';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { omitUnsupportedTemperature } from '../app/lib/agent-runtime-policy/request-options';

// Exercise actual SDK adapters without sending model requests. The payload
// callback deliberately stops dispatch; fetch is additionally fail-closed.
const originalFetch = globalThis.fetch;
let fetchAttempts = 0;
globalThis.fetch = async () => { fetchAttempts += 1; throw new Error('Unexpected network dispatch in payload contract'); };
try {
  for (const provider of ['openai', 'anthropic', 'mistral', 'xai', 'google', 'openrouter'] as const) {
    const models = getModels(provider);
    const model = models.find((candidate) => candidate.reasoning && candidate.input.includes('text')) ?? models[0];
    assert.ok(model, `${provider} has a built-in model`);
    let payload: unknown;
    const stream = streamSimple(model, {
      systemPrompt: 'Payload contract fixture.',
      messages: [{ role: 'user', content: 'Inspect', timestamp: 1 }],
      tools: [{ name: 'inspect', description: 'Fixture', parameters: Type.Object({ note: Type.Optional(Type.String()), nullable: Type.Union([Type.String(), Type.Null()]) }) }],
    }, omitUnsupportedTemperature(model, {
      apiKey: 'fixture-only', maxTokens: 128, cacheRetention: 'long',
      onPayload: (value) => { payload = value; throw new Error('fixture payload captured'); },
    }));
    const result = await stream.result();
    assert.ok(payload, `${provider} must assemble its real request payload`);
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage ?? '', /fixture payload captured/);
    assert.ok(JSON.stringify(payload).includes('inspect'), `${provider} must include the tool`);
    console.log(`${provider}: ${model.api} payload captured`);
  }
  assert.equal(fetchAttempts, 0, 'payload checks must stop before provider dispatch');
  const astra = getModels('openai').find((model) => model.id === 'gpt-6-astra');
  const codexAstra = getModels('openai-codex').find((model) => model.id === 'gpt-6-astra');
  assert.ok(astra);
  assert.ok(codexAstra);
  assert.ok(!getSupportedThinkingLevels(astra).includes('off'));
  assert.ok(!getSupportedThinkingLevels(astra).includes('minimal'));
  assert.ok(!getSupportedThinkingLevels(codexAstra).includes('off'));
  assert.ok(getSupportedThinkingLevels(codexAstra).includes('minimal'));
  assert.ok(getModels('xai').some((model) => model.api === 'openai-responses'));
  console.log('Pi provider payload and catalog contracts passed');
} finally { globalThis.fetch = originalFetch; }
