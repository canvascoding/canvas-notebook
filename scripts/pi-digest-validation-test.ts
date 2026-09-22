import assert from 'node:assert/strict';

import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';

import { generatePiRollingSummaryV2 } from '../app/lib/pi/compaction/summary-generator';
import { samplePiCompactionSummaryRecords } from '../app/lib/pi/compaction/recovery';
import { estimateTextTokens } from '../app/lib/pi/history-budget';

const model = {
  id: 'summary-test', name: 'Summary test', api: 'openai-completions', provider: 'main',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model<'openai-completions'>;
const auxiliaryModel = { ...model, id: 'fast-summary', provider: 'auxiliary' } as Model<'openai-completions'>;
const body = [
  '## Active Task', 'Continue the implementation.',
  '## Completed Work', 'None.',
  '## Decisions and Constraints', 'Preserve history.',
  '## Files, Commands, and Exact Errors', 'None.',
  '## Remaining Work', 'Implementation.',
].join('\n');

function response(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: text ? [{ type: 'text', text }] : [], stopReason, timestamp: 1,
    usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 200,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
function stream(message: AssistantMessage): AssistantMessageEventStream {
  return { result: async () => message } as AssistantMessageEventStream;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const records = Array.from({ length: 32 }, (_, index) => (
    `[message ${index + 1}] ${index === 31 ? 'NEWEST' : `record-${index + 1}`}\n${'detail '.repeat(300)}`
  ));
  const sampled = samplePiCompactionSummaryRecords({ records, maximumCharacters: 12_000 });
  assert.ok(sampled.text.length <= 12_000);
  assert.match(sampled.text, /NEWEST/, 'the latest record is always anchored');
  assert.match(sampled.text, /historical records omitted/, 'gaps are explicit recovery hints');
  assert.ok(sampled.sampledCharacters < sampled.inputCharacters);
  assert.equal(sampled.omittedCharacters, sampled.inputCharacters - sampled.sampledCharacters);
  assert.ok(sampled.sampledRecordCount <= 8);
  const tiny = samplePiCompactionSummaryRecords({ records: ['head '.repeat(2_000)], maximumCharacters: 180 });
  assert.ok(tiny.text.length <= 180, 'one oversized newest record remains bounded');

  const messages = [{ role: 'user', content: 'Continue the implementation. '.repeat(600), timestamp: 1 }] as AgentMessage[];
  let calls = 0;
  const streamFn: StreamFn = async (_requestedModel, _context, options) => {
    calls += 1;
    assert.equal(options?.maxTokens, undefined, 'summary calls retain native provider output headroom');
    return stream(response(body));
  };
  const result = await generatePiRollingSummaryV2({
    previousSummaryText: null, messagesToSummarize: messages, model, sessionId: 'one-call', streamFn,
  });
  assert.ok(result);
  assert.equal(calls, 1, 'a normal V2 compaction performs exactly one LLM call');

  const promptMessages = Array.from({ length: 36 }, (_, index) => ({
    role: 'user' as const,
    timestamp: index + 10,
    content: `record-${index + 1} ${index === 35 ? 'NEWEST-RECORD-TAIL' : ''} ${'durable detail '.repeat(700)}`,
  })) as AgentMessage[];
  let sampledPrompt = '';
  await generatePiRollingSummaryV2({
    previousSummaryText: null, messagesToSummarize: promptMessages, model, sessionId: 'prompt-preserves-sample',
    streamFn: async (_requestedModel, context) => {
      sampledPrompt = String(context.messages[0]?.content ?? '');
      return stream(response(body));
    },
  });
  assert.match(sampledPrompt, /NEWEST-RECORD-TAIL/, 'the newest sampled record reaches the LLM intact');
  assert.match(sampledPrompt, /historical records omitted/, 'the LLM receives explicit sampling gaps');

  let auxiliaryCalls = 0;
  let mainCalls = 0;
  const recovered = await generatePiRollingSummaryV2({
    previousSummaryText: null, messagesToSummarize: messages, model, sessionId: 'fallback',
    summaryModel: auxiliaryModel,
    summaryStreamFn: async () => { auxiliaryCalls += 1; return stream(response('')); },
    streamFn: async () => { mainCalls += 1; return stream(response(body)); },
  });
  assert.ok(recovered);
  assert.equal(auxiliaryCalls, 1);
  assert.equal(mainCalls, 1, 'one failed auxiliary attempt receives exactly one main-model fallback');

  let timedOutAuxiliaryCalls = 0;
  let timeoutFallbackCalls = 0;
  const timeoutRecovered = await generatePiRollingSummaryV2({
    previousSummaryText: null, messagesToSummarize: messages, model, sessionId: 'timeout-fallback',
    summaryModel: auxiliaryModel,
    idleTimeoutMs: 5,
    totalTimeoutMs: 500,
    summaryStreamFn: async () => {
      timedOutAuxiliaryCalls += 1;
      return { result: async () => new Promise<AssistantMessage>(() => undefined) } as AssistantMessageEventStream;
    },
    streamFn: async () => { timeoutFallbackCalls += 1; return stream(response(body)); },
  });
  assert.ok(timeoutRecovered);
  assert.equal(timedOutAuxiliaryCalls, 1);
  assert.equal(timeoutFallbackCalls, 1, 'an auxiliary timeout still receives its one main-model fallback');

  const smallMainContext = { ...model, id: 'small-main-context', contextWindow: 32_000, maxTokens: 1_000 } as Model<'openai-completions'>;
  const largeAuxiliaryContext = { ...auxiliaryModel, id: 'large-aux-context', contextWindow: 128_000, maxTokens: 4_096 } as Model<'openai-completions'>;
  let heterogeneousAuxCalls = 0;
  let heterogeneousMainCalls = 0;
  const heterogeneous = await generatePiRollingSummaryV2({
    previousSummaryText: null, messagesToSummarize: promptMessages, model: smallMainContext,
    sessionId: 'v2-heterogeneous-context', summaryModel: largeAuxiliaryContext,
    idleTimeoutMs: 8,
    totalTimeoutMs: 250,
    summaryStreamFn: async () => { heterogeneousAuxCalls += 1; return { result: async () => new Promise<AssistantMessage>(() => undefined) } as AssistantMessageEventStream; },
    streamFn: async (requestedModel) => {
      heterogeneousMainCalls += 1;
      assert.equal(requestedModel.id, smallMainContext.id);
      return stream(response(body));
    },
  });
  assert.ok(heterogeneous);
  assert.equal(heterogeneousAuxCalls, 1);
  assert.equal(heterogeneousMainCalls, 1, 'a small main fallback receives the shared bounded V2 prompt');

  const largeOutputMain = { ...model, id: 'large-output-main', contextWindow: 32_000, maxTokens: 8_000 } as Model<'openai-completions'>;
  const smallOutputAux = { ...auxiliaryModel, id: 'small-output-aux', contextWindow: 128_000, maxTokens: 4_000 } as Model<'openai-completions'>;
  let outputReserveAuxCalls = 0;
  let outputReserveMainCalls = 0;
  const outputReserveFallback = await generatePiRollingSummaryV2({
    previousSummaryText: null, messagesToSummarize: promptMessages, model: largeOutputMain,
    sessionId: 'v2-main-output-reserve', summaryModel: smallOutputAux,
    idleTimeoutMs: 8,
    totalTimeoutMs: 250,
    summaryStreamFn: async () => {
      outputReserveAuxCalls += 1;
      return { result: async () => new Promise<AssistantMessage>(() => undefined) } as AssistantMessageEventStream;
    },
    streamFn: async (requestedModel, context) => {
      outputReserveMainCalls += 1;
      assert.equal(requestedModel.id, largeOutputMain.id);
      const promptTokens = estimateTextTokens(context.systemPrompt ?? '')
        + estimateTextTokens(String(context.messages[0]?.content ?? ''));
      assert.ok(
        largeOutputMain.contextWindow - largeOutputMain.maxTokens - 768 > promptTokens + 32,
        'the common prompt reserves the main model native output allowance',
      );
      return stream(response(body));
    },
  });
  assert.ok(outputReserveFallback);
  assert.equal(outputReserveAuxCalls, 1);
  assert.equal(outputReserveMainCalls, 1, 'auxiliary 4k output cap still leaves room for an 8k main fallback');

  let progressAuxCalls = 0;
  let reservedMainCalls = 0;
  const reservedFallback = await generatePiRollingSummaryV2({
    previousSummaryText: null, messagesToSummarize: messages, model, sessionId: 'v2-aux-progress-ceiling',
    summaryModel: auxiliaryModel,
    idleTimeoutMs: 30,
    totalTimeoutMs: 200,
    summaryStreamFn: async () => {
      progressAuxCalls += 1;
      return {
        result: async () => new Promise<AssistantMessage>(() => undefined),
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 30; index += 1) {
            await sleep(8);
            yield { type: 'text_delta' } as never;
          }
        },
      } as unknown as AssistantMessageEventStream;
    },
    streamFn: async () => { reservedMainCalls += 1; return stream(response(body)); },
  });
  assert.ok(reservedFallback);
  assert.equal(progressAuxCalls, 1);
  assert.equal(reservedMainCalls, 1, 'auxiliary progress cannot consume the primary fallback deadline reserve');

  let accidentalAuxCalls = 0;
  await generatePiRollingSummaryV2({
    previousSummaryText: null, messagesToSummarize: messages, model, sessionId: 'atomic-route',
    summaryModel: auxiliaryModel,
    streamFn: async (requestedModel) => {
      accidentalAuxCalls += 1;
      assert.equal(requestedModel.id, model.id, 'foreign model is never sent through the main route');
      return stream(response(body));
    },
  });
  assert.equal(accidentalAuxCalls, 1);

  const failures = [response(''), response('I cannot safely produce a summary.'), response(body, 'length')];
  for (const failure of failures) {
    let failureCalls = 0;
    const rejected = await generatePiRollingSummaryV2({
      previousSummaryText: null, messagesToSummarize: messages, model,
      streamFn: async () => { failureCalls += 1; return stream(failure); },
    });
    assert.equal(rejected, null);
    assert.equal(failureCalls, 1, 'invalid main-model output fails closed without a repair loop');
  }
  console.log('single-call summary sampling, fallback and validation checks passed');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
