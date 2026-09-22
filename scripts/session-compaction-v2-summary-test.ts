import assert from 'node:assert/strict';
import Module from 'node:module';

import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';

const model = {
  id: 'summary-v2-test-model', name: 'Summary V2 Test Model', api: 'openai-completions', provider: 'summary-test-provider',
  baseUrl: 'http://localhost.invalid/v1', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model<'openai-completions'>;
const auxiliaryModel = { ...model, id: 'summary-v2-fast-model', provider: 'summary-auxiliary' } as Model<'openai-completions'>;

function body(activeTask: string): string {
  return [
    '## Active Task', activeTask,
    '## Completed Work', 'Earlier work remains recorded.',
    '## Decisions and Constraints', 'Preserve exact identifiers and fail closed.',
    '## Files, Commands, and Exact Errors', 'No additional command output.',
    '## Remaining Work', 'Continue implementation.',
  ].join('\n');
}
function message(text: string): AssistantMessage {
  return {
    role: 'assistant', content: text ? [{ type: 'text', text }] : [], api: model.api, provider: model.provider,
    model: model.id, stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
function resultStream(output: AssistantMessage): AssistantMessageEventStream {
  return { result: async () => output } as AssistantMessageEventStream;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function silentStream(): AssistantMessageEventStream {
  return {
    result: async () => new Promise<AssistantMessage>(() => undefined),
  } as AssistantMessageEventStream;
}

async function main() {
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (request, parent, isMain) => request === 'server-only' ? {} : originalLoad(request, parent, isMain);
  try {
    const { summarizePiSessionHistory } = await import('../app/lib/pi/session-summary');
    const { PI_ROLLING_SUMMARY_CONTRACT } = await import('../app/lib/pi/compaction/summary-contract');
    const messages: AgentMessage[] = Array.from({ length: 48 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user', timestamp: index + 1,
      content: index % 2
        ? [{ type: 'text', text: `Completed step ${index}; ${'durable detail '.repeat(300)}` }]
        : `Requested step ${index}; ${'durable user request '.repeat(300)}`,
      ...(index % 2 ? { api: model.api, provider: model.provider, model: model.id, stopReason: 'stop' as const } : {}),
    }) as AgentMessage);

    let v2Calls = 0;
    const v2Stream: StreamFn = async (_requestedModel, context, options) => {
      v2Calls += 1;
      assert.equal(options?.maxTokens, undefined);
      const prompt = String(context.messages[0]?.content ?? '');
      assert.match(prompt, /untrusted_source_segments/);
      return resultStream(message(body('Continue the current request.')));
    };
    const v2 = await summarizePiSessionHistory({
      previousSummaryText: null, messagesToSummarize: messages, model, sessionId: 'v2-single',
      authorizedSessionId: 'v2-single', sessionSearchAvailable: true, summaryMode: 'hermes_v2', streamFn: v2Stream,
    });
    assert.ok(v2?.includes(PI_ROLLING_SUMMARY_CONTRACT));
    assert.equal(v2Calls, 1, 'large V2 history must not cause digest calls');

    let legacyCalls = 0;
    const legacy = await summarizePiSessionHistory({
      previousSummaryText: 'Earlier state.', messagesToSummarize: messages, model, sessionId: 'legacy-single',
      summaryMode: 'legacy',
      streamFn: async (_requestedModel, _context, options) => {
        legacyCalls += 1;
        assert.equal(options?.maxTokens, undefined);
        return resultStream(message('## Active Task\nContinue legacy work.'));
      },
    });
    assert.ok(legacy?.includes('Continue legacy work.'));
    assert.equal(legacyCalls, 1, 'legacy also performs one bounded summary call');

    let auxiliaryCalls = 0;
    let mainCalls = 0;
    const fallback = await summarizePiSessionHistory({
      previousSummaryText: null, messagesToSummarize: messages, model, sessionId: 'legacy-fallback', summaryMode: 'legacy',
      summaryModel: auxiliaryModel,
      summaryStreamFn: async () => { auxiliaryCalls += 1; return resultStream(message('')); },
      streamFn: async () => { mainCalls += 1; return resultStream(message('## Active Task\nMain fallback succeeded.')); },
    });
    assert.ok(fallback?.includes('Main fallback succeeded.'));
    assert.equal(auxiliaryCalls, 1);
    assert.equal(mainCalls, 1);

    let silentAuxiliaryCalls = 0;
    let timeoutMainFallbackCalls = 0;
    let silentAuxiliaryAborted = false;
    const timeoutFallback = await summarizePiSessionHistory({
      previousSummaryText: null, messagesToSummarize: messages, model, sessionId: 'legacy-aux-timeout', summaryMode: 'legacy',
      summaryModel: auxiliaryModel,
      summaryIdleTimeoutMs: 8,
      summaryTotalTimeoutMs: 250,
      summaryStreamFn: async (_requestedModel, _context, options) => {
        silentAuxiliaryCalls += 1;
        options?.signal?.addEventListener('abort', () => { silentAuxiliaryAborted = true; }, { once: true });
        return silentStream();
      },
      streamFn: async () => { timeoutMainFallbackCalls += 1; return resultStream(message('## Active Task\nMain fallback after timeout.')); },
    });
    assert.ok(timeoutFallback?.includes('Main fallback after timeout.'));
    assert.equal(silentAuxiliaryCalls, 1);
    assert.equal(timeoutMainFallbackCalls, 1, 'one silent auxiliary stream gets one main fallback');
    assert.equal(silentAuxiliaryAborted, true, 'legacy timeout aborts the actual auxiliary provider signal');

    const smallMainContext = { ...model, id: 'small-main-context', contextWindow: 32_000, maxTokens: 1_000 } as Model<'openai-completions'>;
    const largeAuxiliaryContext = { ...auxiliaryModel, id: 'large-aux-context', contextWindow: 128_000, maxTokens: 4_096 } as Model<'openai-completions'>;
    let heterogeneousAuxCalls = 0;
    let heterogeneousMainCalls = 0;
    const heterogeneousFallback = await summarizePiSessionHistory({
      previousSummaryText: null, messagesToSummarize: messages, model: smallMainContext,
      sessionId: 'legacy-heterogeneous-context', summaryMode: 'legacy',
      summaryModel: largeAuxiliaryContext,
      summaryIdleTimeoutMs: 8,
      summaryTotalTimeoutMs: 250,
      summaryStreamFn: async () => { heterogeneousAuxCalls += 1; return silentStream(); },
      streamFn: async (requestedModel) => {
        heterogeneousMainCalls += 1;
        assert.equal(requestedModel.id, smallMainContext.id);
        return resultStream(message('## Active Task\nSmall main context fallback succeeded.'));
      },
    });
    assert.ok(heterogeneousFallback?.includes('Small main context fallback succeeded.'));
    assert.equal(heterogeneousAuxCalls, 1);
    assert.equal(heterogeneousMainCalls, 1, 'the bounded shared prompt reaches a smaller main fallback');

    let silentMainCalls = 0;
    const silentMain = await summarizePiSessionHistory({
      previousSummaryText: null, messagesToSummarize: messages, model, sessionId: 'legacy-main-timeout', summaryMode: 'legacy',
      summaryIdleTimeoutMs: 8,
      summaryTotalTimeoutMs: 250,
      streamFn: async () => { silentMainCalls += 1; return silentStream(); },
    });
    assert.equal(silentMain, null, 'a silent main stream fails closed');
    assert.equal(silentMainCalls, 1);

    const progressEvents: string[] = [];
    const idleReset = await summarizePiSessionHistory({
      previousSummaryText: null, messagesToSummarize: messages, model, sessionId: 'legacy-progress', summaryMode: 'legacy',
      summaryIdleTimeoutMs: 15,
      summaryTotalTimeoutMs: 250,
      onSummaryProgress: (event) => progressEvents.push(event.status),
      streamFn: async () => ({
        result: async () => { await sleep(42); return message('## Active Task\nProgress kept the stream alive.'); },
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 4; index += 1) {
            await sleep(8);
            yield { type: 'text_delta' } as never;
          }
        },
      } as unknown as AssistantMessageEventStream),
    });
    assert.ok(idleReset?.includes('Progress kept the stream alive.'));
    assert.ok(progressEvents.filter((status) => status === 'streaming').length >= 4,
      'every stream event resets the idle timer');

    const totalBounded = await summarizePiSessionHistory({
      previousSummaryText: null, messagesToSummarize: messages, model, sessionId: 'legacy-total-timeout', summaryMode: 'legacy',
      summaryIdleTimeoutMs: 100,
      summaryTotalTimeoutMs: 18,
      streamFn: async () => ({
        result: async () => { await sleep(80); return message('## Active Task\nToo late.'); },
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 20; index += 1) {
            await sleep(4);
            yield { type: 'text_delta' } as never;
          }
        },
      } as unknown as AssistantMessageEventStream),
    });
    assert.equal(totalBounded, null, 'progress never extends the total timeout boundary');

    const tokenDenseSmallContext = {
      ...model,
      id: 'small-native-reserve',
      contextWindow: 5_000,
      maxTokens: 4_800,
    } as Model<'openai-completions'>;
    let unsafeCalls = 0;
    const failClosed = await summarizePiSessionHistory({
      previousSummaryText: 'Prior detail '.repeat(2_000),
      messagesToSummarize: messages,
      model: tokenDenseSmallContext,
      sessionId: 'legacy-small-context',
      summaryMode: 'legacy',
      streamFn: async () => {
        unsafeCalls += 1;
        return resultStream(message('## Active Task\nThis must not be called.'));
      },
    });
    assert.equal(failClosed, null, 'native output reserve leaves no safe input budget');
    assert.equal(unsafeCalls, 0, 'legacy never sends an over-budget summary prompt');
  } finally {
    internals._load = originalLoad;
  }
  console.log('V2 and legacy single-call summary regression checks passed');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
