import assert from 'node:assert/strict';
import type { Model } from '@earendil-works/pi-ai';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composePiHistoryForLlm } from '../app/lib/pi/history-budget';
import { getContextStatusPresentation } from '../app/components/canvas-agent-chat/contextStatusDisplay';
import type { RuntimeStatus } from '../app/lib/chat/runtime-status';

const model: Model<'openai-completions'> = {
  id: 'test', name: 'test', api: 'openai-completions', provider: 'test',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_000, maxTokens: 20_000,
};
const messages = [{ role: 'user' as const, content: 'hello '.repeat(1000), timestamp: 100 }];
const composition = composePiHistoryForLlm({
  messages, summary: { summaryText: null, summaryUpdatedAt: null, summaryThroughTimestamp: null,
    summaryThroughSequence: null, summaryRevision: 0 },
  systemPromptTokens: 10, contextWindow: model.contextWindow, modelMaxTokens: model.maxTokens,
  requestOutputTokens: 20_000, selectionMode: 'full',
});
const input = { messages: composition.llmMessages, model,
  effectiveInstructions: [{ role: 'system' as const, content: 'System' }], effectiveTools: [],
  requestOutputTokenCap: 20_000 };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function main() {
  const { ContextStatusMeasurementCache, measurePiContextStatus } = await import('../app/lib/pi/context-status-measurement');
  const { measureStoredPiContextStatus } = await import('../app/lib/pi/stored-context-measurement');
  const value = await measurePiContextStatus(composition, input);
  assert.equal(value.nextRequestEstimateSource, 'serialized_request');
  const cold = await measureStoredPiContextStatus('user:workspace:session', composition, input);
  assert.deepEqual(cold.projection, value, 'reload uses the identical serialization algorithm');
  assert.equal(await measureStoredPiContextStatus('user:workspace:session', composition, input), cold,
    'unchanged status reads reuse normalized measurement and timestamp');
  assert.notEqual(await measureStoredPiContextStatus('different-user', composition, input), cold);
  const changed = await measureStoredPiContextStatus('user:workspace:session', composition, {
    ...input, effectiveInstructions: [{ role: 'system', content: 'System '.repeat(500) }],
  });
  assert.notEqual(changed.projection.nextRequestEstimatedTokens, cold.projection.nextRequestEstimatedTokens);
  const oversized = await measurePiContextStatus({
    ...composition, llmMessages: [], payloadBudgetExceeded: true, minimumRequiredTokens: 900_000,
  }, { ...input, messages: [] });
  assert.equal(oversized.nextRequestBudgetExceeded, true);
  assert.equal(oversized.contextPressure.pressureTokens, 900_000);

  const cache = new ContextStatusMeasurementCache();
  let calls = 0;
  let publications = 0;
  const measure = async () => { calls += 1; return value; };
  const publish = () => { publications += 1; };
  for (let i = 0; i < 100; i++) cache.refresh(measure, publish);
  await flush();
  assert.equal(calls, 1, 'stream deltas/status reads do not renormalize');
  assert.equal(cache.metadata.state, 'current');
  const previous = cache.current;
  const timestamp = cache.metadata.measuredAt;
  cache.invalidate();
  assert.equal(cache.metadata.state, 'updating');
  assert.equal(cache.current, previous, 'retain old value, explicitly marked updating');
  let release!: (result: typeof value) => void;
  cache.refresh(() => new Promise((resolve) => { release = resolve; }), publish);
  await flush();
  cache.invalidate(); // model/tools/summary/abort replacement changed during normalization
  const newer = { ...value, nextRequestEstimatedTokens: value.nextRequestEstimatedTokens + 10 };
  cache.refresh(async () => newer, publish);
  await flush();
  release(value);
  await flush();
  assert.equal(cache.current, newer, 'late result must never overwrite a newer context revision');
  assert.equal(cache.metadata.measuredRevision, 2);
  assert.equal(publications, 2, 'stale completions do not publish');
  assert.ok(timestamp);
  cache.invalidate();
  cache.refresh(async () => { throw new Error('normalization failed'); }, publish);
  await flush();
  assert.equal(cache.metadata.state, 'unavailable');
  assert.equal(cache.current, newer);
  cache.refresh(measure, publish);
  await flush();
  assert.equal(calls, 1, 'failure must not retry on every status read');
  cache.invalidate();
  cache.refresh(() => new Promise((resolve) => { release = resolve; }), publish);
  await flush();
  cache.dispose();
  release(value);
  await flush();
  assert.equal(cache.current, newer, 'disposed runtime ignores pending measurement');

  const base = { phase: 'streaming', contextWindow: 262_000, estimatedHistoryTokens: 108_000,
    availableHistoryTokens: 230_000, contextUsagePercent: 47,
    contextPressure: { pressureTokens: 169_540, triggerTokens: 173_000, targetTokens: 35_000,
      effectiveInputBudgetTokens: 230_000, percentOfTrigger: 98, source: 'serialized_request' },
    nextRequestEstimatedTokens: 210_000, lastProviderInputTokens: 108_000,
  } as RuntimeStatus;
  assert.deepEqual(getContextStatusPresentation(base), getContextStatusPresentation({ ...base, phase: 'idle' }));
  assert.equal(getContextStatusPresentation(base).severity, 'warning');
  const required = getContextStatusPresentation({ ...base,
    contextPressure: { ...base.contextPressure!, percentOfTrigger: 110 } });
  assert.equal(required.severity, 'warning');
  assert.equal(required.needsCompaction, true);
  assert.equal(required.percent, 110);
  assert.equal(required.progressPercent, 100);
  assert.equal(getContextStatusPresentation({ ...base, nextRequestBudgetExceeded: true }).severity, 'critical');
  assert.equal(getContextStatusPresentation({ ...base, nextRequestBudgetExceeded: true,
    contextMeasurement: { revision: 2, measuredRevision: 1, measuredAt: null, state: 'updating' },
  }).severity, null, 'old overflow must not be presented as a current failure');
  const legacy = { ...base, contextPressure: undefined, nextRequestEstimatedTokens: undefined };
  assert.equal(getContextStatusPresentation(legacy).percent, 47, 'provider actual is never substituted for current context');
  console.log('pi-context-measurement-test: ok');
}
const testData = mkdtempSync(path.join(tmpdir(), 'canvas-context-measurement-'));
process.env.DATA = testData;
void main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => rmSync(testData, { recursive: true, force: true }));
