import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Agent,
  agentLoop,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';

// Exercise public ESM exports and the actual SDK, replacing only the transport.
// No provider registration, credentials, database, or network is required.
const model: Model<'openai-responses'> = {
  id: 'canvas-contract-model', name: 'Canvas contract model',
  provider: 'canvas-contract', api: 'openai-responses',
  baseUrl: 'https://unused.invalid', reasoning: true, input: ['text'],
  contextWindow: 32_000, maxTokens: 4_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const prompt = { role: 'user', content: 'Run the contract test.', timestamp: 1 } satisfies Message;
const convertToLlm = (messages: AgentMessage[]): Message[] => messages.filter(
  (message): message is Message => ['user', 'assistant', 'toolResult'].includes(message.role),
);

function response(content: AssistantMessage['content'] = [{ type: 'text', text: 'Done.' }],
  stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    stopReason, timestamp: 2,
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function streamResponse(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'start', partial: { ...message, content: [] } });
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    stream.push({ type: 'error', reason: message.stopReason, error: message });
  } else {
    assert.notEqual(message.stopReason, 'pending');
    stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message });
  }
  return stream;
}

function scriptedStream(messages: AssistantMessage[]) {
  const requests: Array<{ context: Context; options?: SimpleStreamOptions }> = [];
  const streamFn: StreamFn = (_model, context, options) => {
    requests.push({ context: {
      ...context,
      messages: structuredClone(context.messages),
      tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })),
    }, options: { ...options } });
    const message = messages.shift();
    assert.ok(message, 'the agent must not start an unexpected extra model request');
    return streamResponse(message);
  };
  return { requests, streamFn };
}

test('public compatibility entrypoint remains importable', async () => {
  const compat = await import('@earendil-works/pi-ai/compat');
  assert.equal(typeof compat.getModels, 'function');
  assert.equal(typeof compat.getProviders, 'function');
});

for (const level of ['off', 'low', 'high', 'max'] satisfies ThinkingLevel[]) {
  test(`Agent and agentLoop forward ${level} reasoning`, { timeout: 10_000 }, async () => {
    const expected = level === 'off' ? undefined : level;
    const lowLevel = scriptedStream([response()]);
    const config = { model, reasoning: expected, convertToLlm } satisfies AgentLoopConfig;
    const events = [];
    const loop = agentLoop([prompt], { systemPrompt: '', messages: [], tools: [] }, config, undefined, lowLevel.streamFn);
    for await (const event of loop) events.push(event);
    assert.equal(lowLevel.requests.length, 1);
    assert.equal(lowLevel.requests[0].options?.reasoning, expected);
    assert.equal(events.at(-1)?.type, 'agent_end');
    assert.deepEqual((await loop.result()).map((message) => message.role), ['user', 'assistant']);

    const stateful = scriptedStream([response()]);
    const agent = new Agent({ initialState: { model, thinkingLevel: level }, streamFn: stateful.streamFn });
    await agent.prompt(prompt);
    assert.equal(stateful.requests.length, 1);
    assert.equal(stateful.requests[0].options?.reasoning, expected);
    assert.equal(agent.state.isStreaming, false);
  });
}

test('thinkingLevel is not an initial low-level reasoning option', { timeout: 10_000 }, async () => {
  const transport = scriptedStream([response()]);
  // Reproduce the old Canvas bug: structural assignment accepts an extra key,
  // but the provider never receives a reasoning value for it.
  const legacyConfig = { model, thinkingLevel: 'high', convertToLlm };
  const loop = agentLoop([prompt], { systemPrompt: '', messages: [], tools: [] }, legacyConfig, undefined, transport.streamFn);
  for await (const _event of loop) { /* drain the real loop */ }
  assert.equal(transport.requests[0].options?.reasoning, undefined);
});

test('Agent waits for final persistence before prompt and waitForIdle settle', { timeout: 10_000 }, async () => {
  const reachedEnd = Promise.withResolvers<void>();
  const releasePersistence = Promise.withResolvers<void>();
  const transport = scriptedStream([response()]);
  const agent = new Agent({ initialState: { model }, streamFn: transport.streamFn });
  const order: string[] = [];
  agent.subscribe(async (event) => {
    if (event.type === 'turn_end') order.push('turn_end');
    if (event.type === 'agent_end') {
      order.push('agent_end');
      reachedEnd.resolve();
      await releasePersistence.promise;
      order.push('persisted');
    }
  });
  const run = agent.prompt(prompt).then(() => { order.push('prompt_settled'); });
  await reachedEnd.promise;
  const idle = agent.waitForIdle().then(() => { order.push('idle'); });
  try {
    await Promise.resolve();
    assert.deepEqual(order, ['turn_end', 'agent_end']);
    assert.equal(agent.state.isStreaming, true);
  } finally {
    releasePersistence.resolve();
  }
  await Promise.all([run, idle]);
  assert.equal(order.filter((event) => event === 'agent_end').length, 1);
  assert.ok(order.indexOf('persisted') < order.indexOf('prompt_settled'));
  assert.ok(order.indexOf('persisted') < order.indexOf('idle'));
  assert.equal(agent.state.isStreaming, false);
});

test('next-turn refresh updates the actual provider context after a tool', { timeout: 10_000 }, async () => {
  const tool: AgentTool = {
    name: 'inspect', label: 'Inspect', description: 'Contract fixture', parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'Inspected.' }], details: {} }),
  };
  const transport = scriptedStream([
    response([{ type: 'toolCall', id: 'call-1', name: 'inspect', arguments: {} }], 'toolUse'),
    response(),
  ]);
  let prepared = 0;
  const agent = new Agent({
    initialState: { model, systemPrompt: 'Before tool', tools: [tool] },
    streamFn: transport.streamFn,
    prepareNextTurnWithContext: async ({ context }) => {
      prepared += 1;
      return { context: { ...context, systemPrompt: 'After tool', tools: [] } };
    },
  });
  await agent.prompt(prompt);
  assert.equal(transport.requests.length, 2);
  assert.equal(transport.requests[0].context.systemPrompt, 'Before tool');
  assert.equal(transport.requests[1].context.systemPrompt, 'After tool');
  assert.deepEqual(transport.requests[1].context.tools, []);
  assert.equal(transport.requests[1].context.messages.at(-1)?.role, 'toolResult');
  assert.equal(prepared, 1);
});

test('tool termination and shouldStopAfterTurn prevent another request', { timeout: 10_000 }, async () => {
  for (const stopWith of ['tool', 'hook']) {
    const transport = scriptedStream([
      response([{ type: 'toolCall', id: 'call-stop', name: 'finish', arguments: {} }], 'toolUse'),
    ]);
    const agent = new Agent({
      initialState: { model, tools: [{
        name: 'finish', label: 'Finish', description: 'Contract fixture', parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text', text: 'Finished.' }], details: {}, terminate: stopWith === 'tool' }),
      }] },
      streamFn: transport.streamFn,
      shouldStopAfterTurn: stopWith === 'hook' ? async () => true : undefined,
      prepareNextTurnWithContext: async () => { assert.fail('stopped turn must not prepare'); },
    });
    await agent.prompt(prompt);
    assert.equal(transport.requests.length, 1);
    assert.equal(agent.state.messages.at(-1)?.role, 'toolResult');
    assert.equal(agent.state.isStreaming, false);
  }
});

test('terminal provider errors and aborts finish the run', { timeout: 10_000 }, async () => {
  for (const stopReason of ['error', 'aborted'] as const) {
    const message = { ...response([], stopReason), errorMessage: `Fixture ${stopReason}` };
    const transport = scriptedStream([message]);
    const agent = new Agent({ initialState: { model }, streamFn: transport.streamFn });
    const events: string[] = [];
    agent.subscribe((event) => { events.push(event.type); });
    await agent.prompt(prompt);
    assert.equal(events.filter((type) => type === 'agent_end').length, 1);
    assert.equal(events.at(-1), 'agent_end');
    assert.equal(agent.state.isStreaming, false);
    assert.equal((agent.state.messages.at(-1) as AssistantMessage).stopReason, stopReason);
  }
});

test('final answers never prepare an unused next turn', { timeout: 10_000 }, async () => {
  const transport = scriptedStream([response()]);
  const agent = new Agent({
    initialState: { model }, streamFn: transport.streamFn,
    prepareNextTurnWithContext: async () => { assert.fail('final answer must not prepare another turn'); },
  });
  await agent.prompt(prompt);
  assert.equal(transport.requests.length, 1);
});

test('steering queued during preparation reaches the very next request', { timeout: 10_000 }, async () => {
  const preparing = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const transport = scriptedStream([
    response([{ type: 'toolCall', id: 'steer-call', name: 'inspect', arguments: {} }], 'toolUse'),
    response(),
  ]);
  const agent = new Agent({
    initialState: { model, tools: [{
      name: 'inspect', label: 'Inspect', description: 'Fixture', parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: 'Ready' }], details: {} }),
    }] },
    streamFn: transport.streamFn,
    prepareNextTurnWithContext: async () => {
      preparing.resolve();
      await resume.promise;
      return { thinkingLevel: 'high' };
    },
  });
  const run = agent.prompt(prompt);
  await preparing.promise;
  const steering = { role: 'user', content: 'Use the updated instruction.', timestamp: 3 } satisfies Message;
  try { agent.steer(steering); } finally { resume.resolve(); }
  await run;
  assert.equal(transport.requests.length, 2);
  assert.deepEqual(transport.requests[1].context.messages.at(-1), steering);
  assert.equal(transport.requests[1].options?.reasoning, 'high');
});

test('one follow-up is consumed once before final persistence', { timeout: 10_000 }, async () => {
  const transport = scriptedStream([response(), response()]);
  let prepared = 0;
  let ended = 0;
  const agent = new Agent({
    initialState: { model }, streamFn: transport.streamFn,
    prepareNextTurnWithContext: async () => { prepared += 1; },
  });
  const followUp = { role: 'user', content: 'One follow-up.', timestamp: 4 } satisfies Message;
  agent.followUp(followUp);
  agent.subscribe((event) => { if (event.type === 'agent_end') ended += 1; });
  await agent.prompt(prompt);
  assert.equal(prepared, 1);
  assert.equal(ended, 1);
  assert.equal(transport.requests.length, 2);
  assert.deepEqual(transport.requests[1].context.messages.at(-1), followUp);
  assert.equal(agent.state.messages.filter((message) => message.role === 'user' && message.timestamp === 4).length, 1);
});

test('abort reaches the active provider and the run settles exactly once', { timeout: 10_000 }, async () => {
  const started = Promise.withResolvers<void>();
  let ended = 0;
  let requestSignal: AbortSignal | undefined;
  const agent = new Agent({ initialState: { model }, streamFn: (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    requestSignal = options?.signal;
    requestSignal?.addEventListener('abort', () => {
      stream.push({ type: 'error', reason: 'aborted', error: response([], 'aborted') });
    }, { once: true });
    started.resolve();
    return stream;
  } });
  agent.subscribe((event) => { if (event.type === 'agent_end') ended += 1; });
  const run = agent.prompt(prompt);
  await started.promise;
  agent.abort();
  await run;
  await agent.waitForIdle();
  assert.equal(requestSignal?.aborted, true);
  assert.equal(ended, 1);
  assert.equal(agent.state.isStreaming, false);
});
