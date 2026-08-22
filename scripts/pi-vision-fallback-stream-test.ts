import assert from 'node:assert/strict';

import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model } from '@earendil-works/pi-ai';

type TestStreamEvent = {
  type: string;
  reason?: string;
  message?: AssistantMessage;
  error?: AssistantMessage;
};

class TestAssistantMessageEventStream {
  private readonly events: unknown[] = [];
  private readonly waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  private done = false;
  private resolveResult!: (message: AssistantMessage) => void;
  private readonly finalResult = new Promise<AssistantMessage>((resolve) => {
    this.resolveResult = resolve;
  });

  push(event: TestStreamEvent) {
    if (this.done) return;
    if (event.type === 'done' || event.type === 'error') {
      this.done = true;
      this.resolveResult(event.message ?? event.error!);
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.events.push(event);
  }

  end() {
    this.done = true;
    while (this.waiters.length > 0) this.waiters.shift()!({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    while (true) {
      if (this.events.length > 0) yield this.events.shift()!;
      else if (this.done) return;
      else {
        const event = await new Promise<IteratorResult<unknown>>((resolve) => this.waiters.push(resolve));
        if (event.done) return;
        yield event.value;
      }
    }
  }

  result() {
    return this.finalResult;
  }
}

const createTestStream = () => new TestAssistantMessageEventStream() as unknown as AssistantMessageEventStream;

const model = {
  id: 'new-model-without-vision-in-its-name',
  name: 'New model',
  provider: 'test',
  api: 'openai-completions',
  baseUrl: 'https://example.test/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
} as unknown as Model<'openai-completions'>;

const imageContext: Context = {
  messages: [{
    role: 'toolResult',
    toolCallId: 'read-1',
    toolName: 'read',
    content: [
      { type: 'text', text: 'Read image.png' },
      { type: 'image', data: Buffer.from('image').toString('base64'), mimeType: 'image/png' },
    ],
    isError: false,
    timestamp: Date.now(),
  }],
};

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'fallback succeeded' }],
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
    ...overrides,
  };
}

function doneStream() {
  const stream = new TestAssistantMessageEventStream();
  queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: message() }));
  return stream;
}

function rejectedImageStream() {
  const stream = new TestAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: 'start', reason: 'start' });
    stream.push({
      type: 'error',
      reason: 'error',
      error: message({
        content: [],
        stopReason: 'error',
        errorMessage: 'This model does not support images.',
      }),
    });
  });
  return stream;
}

async function main() {
  const { createVisionFallbackStreamFn } = await import('../app/lib/pi/vision-fallback-stream');
  const calls: Array<{ model: Model<Api>; context: Context }> = [];
  const baseFallbackStreamFn: StreamFn = async (requestedModel, context) => {
    calls.push({ model: requestedModel as Model<Api>, context });
    return (calls.length === 1 ? rejectedImageStream() : doneStream()) as unknown as AssistantMessageEventStream;
  };
  const fallbackStreamFn = createVisionFallbackStreamFn(baseFallbackStreamFn, createTestStream);

  const fallback = await fallbackStreamFn(model, imageContext);
  const fallbackEvents = [];
  for await (const event of fallback) fallbackEvents.push(event);
  assert.equal(fallbackEvents.length, 1);
  assert.equal(fallbackEvents[0]?.type, 'done');
  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.model.input.includes('image'));
  assert.equal(
    (calls[0]?.context.messages[0]?.content as Array<{ type: string }>).some((part) => part.type === 'image'),
    true,
  );
  assert.equal(calls[1]?.model.input.includes('image'), false);
  const fallbackContent = calls[1]?.context.messages[0]?.content as Array<{ type: string; text?: string }>;
  assert.equal(fallbackContent.some((part) => part.type === 'image'), false);
  assert.match(fallbackContent.map((part) => part.text ?? '').join('\n'), /provider rejected image input/i);

  // The first rejection changes only this executable runtime. Further image
  // turns go straight to text and cannot create a retry loop.
  const cachedFallback = await fallbackStreamFn(model, imageContext);
  await cachedFallback.result();
  assert.equal(calls.length, 3);
  assert.equal(calls[2]?.model.input.includes('image'), false);

  const successfulCalls: Array<Model<Api>> = [];
  const baseOptimisticStreamFn: StreamFn = async (requestedModel) => {
    successfulCalls.push(requestedModel as Model<Api>);
    return doneStream() as unknown as AssistantMessageEventStream;
  };
  const optimisticStreamFn = createVisionFallbackStreamFn(baseOptimisticStreamFn, createTestStream);
  const success = await optimisticStreamFn(model, imageContext);
  await success.result();
  assert.equal(successfulCalls.length, 1);
  assert.ok(successfulCalls[0]?.input.includes('image'));

  console.log('[PI Vision Fallback Stream Test] Passed.');
}

void main();
