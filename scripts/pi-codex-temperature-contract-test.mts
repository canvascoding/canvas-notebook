import assert from 'node:assert/strict';
import { getModels, streamSimple } from '@earendil-works/pi-ai/compat';
import { omitUnsupportedTemperature } from '../app/lib/agent-runtime-policy/request-options';

const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Live transport is forbidden in the Codex payload fixture.'); };
// A synthetic, unsigned token is sufficient for the SDK's payload construction.
const fixtureToken = ['fixture', Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url'), 'fixture'].join('.');
try {
  for (const id of ['gpt-6-luna', 'gpt-6-sol']) {
    const model = getModels('openai-codex').find(candidate => candidate.id === id);
    assert.ok(model);
    let payload: Record<string, unknown> | undefined;
    const stream = streamSimple(model, {
      systemPrompt: 'Verify the Codex request contract.', messages: [{ role: 'user', content: 'Reply OK.', timestamp: 1 }],
    }, omitUnsupportedTemperature(model, {
      apiKey: fixtureToken, temperature: 0, maxTokens: 128,
      onPayload: value => { payload = value as Record<string, unknown>; throw new Error('fixture payload captured'); },
    }));
    const result = await stream.result();
    assert.ok(payload, `${id} must reach the real SDK request builder`);
    assert.match(result.errorMessage ?? '', /fixture payload captured/);
    assert.equal('temperature' in payload, false, 'Codex payload must omit unsupported temperature');
    assert.equal(payload.model, id);
    assert.equal(payload.stream, true);
  }
  assert.equal(networkCalls, 0);
  console.log('pi-codex-temperature-contract-test: ok (real SDK payloads, no network)');
} finally { globalThis.fetch = originalFetch; }
