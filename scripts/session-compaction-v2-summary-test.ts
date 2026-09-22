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
    let legacyTailV2Prompt = '';
    const v2Stream: StreamFn = async (_requestedModel, context, options) => {
      v2Calls += 1;
      assert.equal(options?.maxTokens, undefined);
      const prompt = context.messages.map((entry) => String(entry.content ?? '')).join('\n');
      legacyTailV2Prompt = prompt;
      assert.match(prompt, /untrusted_source_segments/);
      return resultStream(message(body('Continue the current request.')));
    };
    const v2 = await summarizePiSessionHistory({
      previousSummaryText: null, messagesToSummarize: messages, model, sessionId: 'v2-single',
      authorizedSessionId: 'v2-single', sessionSearchAvailable: true, summaryMode: 'hermes_v2', streamFn: v2Stream,
    });
    assert.ok(v2?.includes(PI_ROLLING_SUMMARY_CONTRACT));
    assert.equal(v2Calls, 1, 'large V2 history must not cause digest calls');
    assert.doesNotMatch(legacyTailV2Prompt, /untrusted_exact_anchors|untrusted_historical_user_excerpts/,
      'V2 generator with the legacy tail keeps Hermes bounded head/tail input only');
    assert.doesNotMatch(v2!, /## Anchor Index|## User Messages|## Context Recovery/,
      'legacy tail never stores Lean continuity appendices');

    let leanTailV2Calls = 0;
    let leanTailV2Prompt = '';
    const leanTail = await summarizePiSessionHistory({
      previousSummaryText: null,
      messagesToSummarize: [...messages, {
        role: 'user', timestamp: 49,
        content: 'Keep app/lib/pi/tail.ts and issue #1234 available for recovery.',
      } as AgentMessage],
      model,
      sessionId: 'v2-lean-single',
      authorizedSessionId: 'v2-lean-single',
      sessionSearchAvailable: true,
      summaryMode: 'hermes_v2',
      tailMode: 'lean',
      streamFn: async (_requestedModel, context, options) => {
        leanTailV2Calls += 1;
        assert.equal(options?.maxTokens, undefined);
        leanTailV2Prompt = context.messages.map((entry) => String(entry.content ?? '')).join('\n');
        return resultStream(message(body('Continue the current lean request.')));
      },
    });
    assert.equal(leanTailV2Calls, 1, 'Lean V2 uses one bounded summary call');
    assert.match(leanTailV2Prompt, /untrusted_exact_anchors/);
    assert.match(leanTailV2Prompt, /untrusted_historical_user_excerpts/);
    assert.ok(leanTail?.includes('## Anchor Index'));
    assert.ok(leanTail?.includes('## User Messages'));
    assert.ok(leanTail?.includes('## Context Recovery'));

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

    const boundedLegacyModel = {
      ...model,
      id: 'legacy-bounded-head-tail',
      contextWindow: 64_000,
    } as Model<'openai-completions'>;
    let boundedLegacyPrompt = '';
    const boundedLegacy = await summarizePiSessionHistory({
      previousSummaryText: null,
      messagesToSummarize: messages,
      model: boundedLegacyModel,
      sessionId: 'legacy-bounded-head-tail',
      summaryMode: 'legacy',
      streamFn: async (_requestedModel, context) => {
        boundedLegacyPrompt = context.messages.map((entry) => String(entry.content ?? '')).join('\n');
        return resultStream(message('## Active Task\nLegacy bounded history succeeded.'));
      },
    });
    assert.ok(boundedLegacy?.includes('Legacy bounded history succeeded.'));
    assert.match(boundedLegacyPrompt, /Requested step 0/);
    assert.match(boundedLegacyPrompt, /Completed step 47/);
    assert.match(boundedLegacyPrompt, /summary input truncated/,
      'legacy keeps Hermes bounded head/tail records instead of Lean sampling gaps');
    assert.doesNotMatch(boundedLegacyPrompt, /historical records omitted/);

    let legacySummaryLeanTailCalls = 0;
    const legacySummaryLeanTail = await summarizePiSessionHistory({
      previousSummaryText: null,
      messagesToSummarize: messages,
      model,
      sessionId: 'legacy-summary-lean-tail',
      summaryMode: 'legacy',
      tailMode: 'lean',
      streamFn: async () => {
        legacySummaryLeanTailCalls += 1;
        return resultStream(message('## Active Task\nLegacy summary remains on its rollout path.'));
      },
    });
    assert.equal(legacySummaryLeanTailCalls, 1,
      'tail policy does not change the selected legacy summary generator');
    assert.equal((legacySummaryLeanTail ?? '').includes(PI_ROLLING_SUMMARY_CONTRACT), false,
      'only hermes_v2 produces the rolling-summary contract');

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
