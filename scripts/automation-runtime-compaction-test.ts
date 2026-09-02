import assert from 'node:assert/strict';
import Module from 'node:module';

import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  return originalLoad(request, parent, isMain);
};

const model = {
  id: 'automation-runtime-compaction-model',
  name: 'Automation Runtime Compaction Model',
  api: 'openai-completions',
  provider: 'automation-runtime-test',
  baseUrl: 'http://localhost.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_000,
  maxTokens: 1_000,
} satisfies Model<'openai-completions'>;

function assistantMessage(text: string): AssistantMessage {
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

async function main(): Promise<void> {
  const {
    isAutomationSummaryProjectionMessage,
    recoverAutomationRuntimePayload,
  } = await import('../app/lib/automations/runtime-compaction');
  const { preparePiFinalPayload } = await import('../app/lib/pi/multimodal-preparation');
  const summaryProjection = {
    role: 'user',
    content: 'Internal session summary from earlier turns.\n<internal_session_summary>old projection</internal_session_summary>',
    timestamp: 0,
  } as AgentMessage;
  assert.equal(isAutomationSummaryProjectionMessage(summaryProjection), true);

  const activeRequest = `Finish the current automation result. ${'active tail '.repeat(40)}`;
  const messages = [
    summaryProjection,
    ...Array.from({ length: 32 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: index % 2 === 0
        ? `Automation request ${index}: ${'durable user context '.repeat(32)}`
        : [{ type: 'text', text: `Automation result ${index}: ${'durable tool outcome '.repeat(32)}` }],
      timestamp: 1_000 + index,
      sequence: index + 1,
      ...(index % 2 === 1
        ? { api: 'test', provider: 'test', model: 'test', stopReason: 'stop' }
        : {}),
    } as AgentMessage)),
    { role: 'user', content: activeRequest, timestamp: 2_000, sequence: 33 } as unknown as AgentMessage,
  ];
  const systemPrompt = 'Run the automation safely and preserve the active request.';
  const requestOutputTokenCap = 1_000;
  const initial = await preparePiFinalPayload({
    messages,
    model,
    effectiveInstructions: [{ role: 'system', content: systemPrompt }],
    effectiveTools: [],
    requestOutputTokenCap,
    runtimeContractRevision: 'canvas-pi-automation-v1',
  });
  assert.equal(initial.budgetSnapshot.contextBudgetExceeded, true);

  let summaryCalls = 0;
  const streamFn: StreamFn = async (_requestedModel, _context, options) => {
    summaryCalls += 1;
    const text = options?.sessionId?.includes('summary-digest')
      ? '- Preserved durable automation requests, results, identifiers, and the active tail.'
      : [
          '## Active Task',
          'Finish the current automation result.',
          '## Completed Work',
          '- Preserved prior automation results.',
          '## Decisions and Constraints',
          '- Keep the active tail and exact session boundaries.',
          '## Files, Commands, and Exact Errors',
          '- No exact errors were reported.',
          '## Remaining Work',
          '- Return the final automation result.',
        ].join('\n');
    return { result: async () => assistantMessage(text) } as AssistantMessageEventStream;
  };
  const recovered = await recoverAutomationRuntimePayload({
    messages,
    summary: {
      summaryText: null,
      summaryUpdatedAt: null,
      summaryThroughTimestamp: null,
      summaryThroughSequence: null,
      summaryRevision: 0,
    },
    model,
    tools: [],
    effectiveSystemPrompt: systemPrompt,
    requestOutputTokenCap,
    sessionId: 'automation-runtime-compaction-session',
    signal: new AbortController().signal,
    streamFn,
    initialSnapshot: initial.budgetSnapshot,
  });
  assert.ok(recovered);
  assert.equal(recovered.budgetSnapshot.contextBudgetExceeded, false);
  assert.equal(recovered.budgetSnapshot.payloadBudgetExceeded, false);
  assert.match(recovered.summary.summaryText || '', /canvas-session-summary:v2/);
  assert.ok(summaryCalls >= 2, 'Hermes V2 must run at least one digest and one rolling-summary call');
  assert.ok(
    recovered.messages.some((message) => message.role === 'user' && message.content === activeRequest),
    'the latest automation request must survive transient compaction',
  );
  assert.equal(
    recovered.messages.some((message) => (
      message.role === 'user'
      && typeof message.content === 'string'
      && message.content.includes('old projection')
    )),
    false,
    'the old provider projection must not be summarized or sent twice',
  );

  console.log('automation-runtime-compaction-test: ok');
}

main()
  .finally(() => {
    moduleInternals._load = originalLoad;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
