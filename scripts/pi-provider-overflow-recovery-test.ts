import assert from 'node:assert/strict';
import Module from 'node:module';

import type { StreamFn } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
} from '@earendil-works/pi-ai';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
let createAssistantMessageEventStream!: () => AssistantMessageEventStream;

const model = {
  id: 'overflow-test-model',
  name: 'Overflow Test Model',
  api: 'openai-completions',
  provider: 'overflow-test-provider',
  baseUrl: 'http://localhost.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_000,
  maxTokens: 1_000,
} satisfies Model<'openai-completions'>;

const initialContext: Context = {
  systemPrompt: 'Overflow recovery test.',
  messages: [{ role: 'user', content: 'Initial request.', timestamp: 1 }],
};
const recoveredContext: Context = {
  systemPrompt: initialContext.systemPrompt,
  messages: [{ role: 'user', content: 'Compacted request.', timestamp: 2 }],
};

function assistantMessage(input: {
  text?: string;
  stopReason?: 'stop' | 'error';
  errorMessage?: string;
} = {}): AssistantMessage {
  const stopReason = input.stopReason ?? 'stop';
  return {
    role: 'assistant',
    content: input.text ? [{ type: 'text', text: input.text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 100,
      output: input.text?.length ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100 + (input.text?.length ?? 0),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function eventStream(events: AssistantMessageEvent[]) {
  const stream = createAssistantMessageEventStream();
  for (const event of events) stream.push(event);
  return stream;
}

function terminalStream(message: AssistantMessage) {
  const startMessage = { ...message, content: [] } as AssistantMessage;
  return eventStream([
    { type: 'start', partial: startMessage },
    message.stopReason === 'error'
      ? { type: 'error', reason: 'error', error: message }
      : { type: 'done', reason: 'stop', message },
  ]);
}

async function collect(stream: ReturnType<typeof createAssistantMessageEventStream>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

async function main(): Promise<void> {
  const eventStreamModule = await import(
    '../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js'
  );
  const overflowModule = await import(
    '../node_modules/@earendil-works/pi-ai/dist/utils/overflow.js'
  );
  createAssistantMessageEventStream = eventStreamModule.createAssistantMessageEventStream;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
      return {
        createAssistantMessageEventStream,
        isContextOverflow: overflowModule.isContextOverflow,
      };
    }
    return originalLoad(request, parent, isMain);
  };
  const { withPiProviderOverflowRecovery } = await import('../app/lib/pi/provider-overflow-recovery');
  const overflow = assistantMessage({
    stopReason: 'error',
    errorMessage: 'Your input exceeds the context window of this model.',
  });
  const success = assistantMessage({ text: 'Recovered answer.' });
  let calls = 0;
  let recoveries = 0;
  const retryingStream: StreamFn = async (_model, context) => {
    calls += 1;
    assert.equal(context, calls === 1 ? initialContext : recoveredContext);
    return terminalStream(calls === 1 ? overflow : success);
  };
  const retried = await collect(await withPiProviderOverflowRecovery(retryingStream, async () => {
    recoveries += 1;
    return recoveredContext;
  })(model, initialContext));
  assert.equal(calls, 2);
  assert.equal(recoveries, 1);
  assert.equal(retried.result, success);
  assert.deepEqual(retried.events.map((event) => event.type), ['start', 'done']);

  calls = 0;
  recoveries = 0;
  const partial = assistantMessage({ text: 'Visible partial answer.', stopReason: 'error', errorMessage: overflow.errorMessage });
  const partialStream: StreamFn = async () => {
    calls += 1;
    const startMessage = { ...partial, content: [] } as AssistantMessage;
    return eventStream([
      { type: 'start', partial: startMessage },
      { type: 'text_start', contentIndex: 0, partial: startMessage },
      { type: 'text_delta', contentIndex: 0, delta: 'Visible', partial },
      { type: 'error', reason: 'error', error: partial },
    ]);
  };
  const exposed = await collect(await withPiProviderOverflowRecovery(partialStream, async () => {
    recoveries += 1;
    return recoveredContext;
  })(model, initialContext));
  assert.equal(calls, 1);
  assert.equal(recoveries, 0, 'visible output must never be replayed');
  assert.deepEqual(exposed.events.map((event) => event.type), ['start', 'text_start', 'text_delta', 'error']);

  calls = 0;
  recoveries = 0;
  const repeatedOverflow: StreamFn = async () => {
    calls += 1;
    return terminalStream(overflow);
  };
  const bounded = await collect(await withPiProviderOverflowRecovery(repeatedOverflow, async () => {
    recoveries += 1;
    return recoveredContext;
  })(model, initialContext));
  assert.equal(calls, 2);
  assert.equal(recoveries, 1, 'provider overflow recovery must be attempted only once');
  assert.equal(bounded.result.stopReason, 'error');

  calls = 0;
  recoveries = 0;
  const ordinaryError = assistantMessage({ stopReason: 'error', errorMessage: 'Provider authentication failed.' });
  const notOverflow: StreamFn = async () => {
    calls += 1;
    return terminalStream(ordinaryError);
  };
  const unchanged = await collect(await withPiProviderOverflowRecovery(notOverflow, async () => {
    recoveries += 1;
    return recoveredContext;
  })(model, initialContext));
  assert.equal(calls, 1);
  assert.equal(recoveries, 0);
  assert.equal(unchanged.result, ordinaryError);

  calls = 0;
  recoveries = 0;
  const thrownOverflow: StreamFn = async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error(
        'The final serialized request exceeds the selected model context window after instructions, tools, provider overhead, output reserve, multimodal input, and safety margin.',
      );
    }
    return terminalStream(success);
  };
  const thrownRecovered = await collect(await withPiProviderOverflowRecovery(thrownOverflow, async () => {
    recoveries += 1;
    return recoveredContext;
  })(model, initialContext));
  assert.equal(calls, 2);
  assert.equal(recoveries, 1);
  assert.equal(thrownRecovered.result, success);

  console.log('pi-provider-overflow-recovery-test: ok');
}

main()
  .finally(() => {
    moduleInternals._load = originalLoad;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
