import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-pi-live-compaction-'));
process.env.DATA = dataDir;

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@earendil-works/pi-agent-core') {
    return { Agent: class Agent {} };
  }
  if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
    return {
      getModels: () => [],
      getProviders: () => [],
      registerBuiltInApiProviders: () => undefined,
    };
  }
  return originalLoad(request, parent, isMain);
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function main(): Promise<void> {
  const { db } = await import('../app/lib/db');
  const { piSessionCompactionAttempts, piSessions, user } = await import('../app/lib/db/schema');
  const { LivePiRuntime } = await import('../app/lib/pi/live-runtime');
  const { buildPiSystemPromptSnapshotFromText } = await import('../app/lib/pi/system-prompt-snapshot');
  const { loadPiSessionWithSummary, savePiSession } = await import('../app/lib/pi/session-store');
  const now = new Date('2026-08-27T14:00:00.000Z');
  const userId = 'user-live-compaction';
  const sessionId = 'session-live-compaction';
  await db.insert(user).values({
    id: userId,
    name: 'Live Compaction Tester',
    email: 'live-compaction@example.test',
    emailVerified: true,
    image: null,
    role: null,
    createdAt: now,
    updatedAt: now,
  });

  const messages = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: index % 2 === 0
      ? `User turn ${index}: ${'durable context '.repeat(45)}`
      : [{ type: 'text', text: `Assistant turn ${index}: ${'completed work '.repeat(45)}` }],
    timestamp: now.getTime() + index,
    ...(index % 2 === 1
      ? { api: 'test', provider: 'test', model: 'test', stopReason: 'stop' }
      : {}),
  } as AgentMessage));
  await savePiSession(
    sessionId,
    userId,
    'test-provider',
    'test-model',
    messages,
    undefined,
    { systemPromptSnapshot: buildPiSystemPromptSnapshotFromText('Live compaction system prompt', now) },
  );
  const session = await db.query.piSessions.findFirst({
    where: (table, { eq }) => eq(table.sessionId, sessionId),
  });
  assert.ok(session?.workspaceId);
  const loaded = await loadPiSessionWithSummary(sessionId, userId, session?.agentId);
  assert.ok(loaded);

  const model = {
    id: 'test-model',
    name: 'Live Compaction Model',
    api: 'openai-completions',
    provider: 'test-provider',
    baseUrl: 'http://localhost.invalid/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4_000,
    maxTokens: 1_000,
  } satisfies Model<'openai-completions'>;
  const summaryResult = deferred<AssistantMessage>();
  let summaryCalls = 0;
  const createSummaryMessage = (text: string): AssistantMessage => ({
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
  });
  const summaryStreamFn: StreamFn = async (requestedModel, _context, options) => {
    summaryCalls += 1;
    assert.equal(options?.signal?.aborted, false);
    return {
      result: () => summaryResult.promise,
    } as AssistantMessageEventStream;
  };

  const events: Array<Record<string, unknown>> = [];
  const runtime = Object.create(LivePiRuntime.prototype) as InstanceType<typeof LivePiRuntime> & Record<string, unknown>;
  Object.assign(runtime, {
    sessionId,
    userId,
    agentId: session?.agentId,
    provider: 'test-provider',
    model,
    systemPrompt: 'Live compaction system prompt',
    tools: [],
    executionContext: { workspaceId: session?.workspaceId },
    requestOutputTokenCap: 1_000,
    summary: loaded?.summary,
    lastComposition: null,
    lastFinalPayloadBudgetSnapshot: null,
    lastProviderUsageCalibration: null,
    lastPersistedLength: loaded?.messages.length,
    messageSequenceCheckpoint: loaded?.messages.length,
    compactionGeneration: 0,
    disposed: false,
    isRunning: false,
    abortRequested: false,
    persistPromise: null,
    lastCompactionAt: null,
    lastCompactionKind: null,
    lastCompactionOmittedCount: 0,
    agent: {
      state: {
        isStreaming: false,
        messages: loaded?.messages,
      },
      abort: () => undefined,
    },
    options: { summaryStreamFn },
    getEffectiveSystemPrompt: () => 'Live compaction system prompt',
    getEffectiveTools: () => [],
    getBrowserRuntimeContextTokenEstimate: () => 0,
    persistMessages: async () => 0,
    publish: (event: Record<string, unknown>) => { events.push(event); },
    publishStatus(this: Record<string, unknown>) {
      events.push({ type: 'runtime_status', status: { compactionStatus: this.compactionStatus } });
    },
    getStatus: () => ({ sessionId }),
    touch: () => undefined,
  });

  const compactPromise = runtime.compactNow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(summaryCalls, 1);
  assert.equal(events.filter((event) => event.type === 'context_compacted').length, 0, 'success must not be emitted before the private candidate completes and commits');
  assert.equal(
    (events.at(-1)?.status as { compactionStatus?: { state?: string } } | undefined)?.compactionStatus?.state,
    'running',
  );
  const automaticRace = await (runtime as unknown as {
    coordinateCompaction: (input: {
      kind: 'automatic';
      messages: AgentMessage[];
      additionalContextTokens: number;
      runtimeContext: null;
    }) => Promise<{ state: string; attemptId: string }>;
  }).coordinateCompaction({
    kind: 'automatic',
    messages: runtime.agent.state.messages as AgentMessage[],
    additionalContextTokens: 0,
    runtimeContext: null,
  });
  assert.equal(automaticRace.state, 'already_running');
  assert.equal(summaryCalls, 1, 'manual/automatic races must share one summary provider call');
  summaryResult.resolve(createSummaryMessage('Committed live runtime summary'));
  await compactPromise;

  const reloaded = await loadPiSessionWithSummary(sessionId, userId, session?.agentId);
  assert.equal(reloaded?.summary.summaryText, 'Committed live runtime summary');
  assert.equal(reloaded?.summary.summaryRevision, 1);
  const attempts = await db.select().from(piSessionCompactionAttempts);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, 'succeeded');
  assert.equal(automaticRace.attemptId, attempts[0].id);
  const committedEvents = events.filter((event) => event.type === 'context_compacted');
  assert.equal(committedEvents.length, 1);
  assert.equal(committedEvents[0].attemptId, attempts[0].id);
  assert.ok(events.some((event) => (
    (event.status as { compactionStatus?: { state?: string } } | undefined)?.compactionStatus?.state === 'succeeded'
  )));
  const marker = (runtime.agent.state.messages as AgentMessage[]).at(-1) as unknown as Record<string, unknown>;
  assert.equal(marker.role, 'compact-break');
  assert.equal(marker.attemptId, attempts[0].id);

  const persistedSession = await db.select().from(piSessions);
  assert.equal(persistedSession[0].summaryRevision, 1);

  Reflect.deleteProperty(runtime, 'persistMessages');
  const appendHistoryBatch = (batch: string) => {
    const extraMessages = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: index % 2 === 0
        ? `${batch} user turn ${index}: ${'new durable context '.repeat(45)}`
        : [{ type: 'text', text: `${batch} assistant turn ${index}: ${'new completed work '.repeat(45)}` }],
      timestamp: now.getTime() + 10_000 + runtime.agent.state.messages.length + index,
      ...(index % 2 === 1
        ? { api: 'test', provider: 'test', model: 'test', stopReason: 'stop' }
        : {}),
    } as AgentMessage));
    runtime.agent.state.messages = [...runtime.agent.state.messages, ...extraMessages];
  };

  appendHistoryBatch('abort');
  const abortResult = deferred<AssistantMessage>();
  let abortCalls = 0;
  (runtime as unknown as { options: { summaryStreamFn: StreamFn } }).options = {
    summaryStreamFn: async () => {
      abortCalls += 1;
      return { result: () => abortResult.promise } as AssistantMessageEventStream;
    },
  };
  const abortPromise = runtime.compactNow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(abortCalls, 1);
  await runtime.abort();
  await assert.rejects(abortPromise, /aborted/i);
  abortResult.resolve(createSummaryMessage('Late aborted summary'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.filter((event) => event.type === 'context_compacted').length, 1, 'an aborted late result must not emit another success');
  assert.ok(events.some((event) => (
    (event.status as { compactionStatus?: { state?: string } } | undefined)?.compactionStatus?.state === 'aborted'
  )));
  assert.equal((await loadPiSessionWithSummary(sessionId, userId, session?.agentId))?.summary.summaryRevision, 1);

  appendHistoryBatch('stale');
  const staleResult = deferred<AssistantMessage>();
  let staleCalls = 0;
  (runtime as unknown as { options: { summaryStreamFn: StreamFn } }).options = {
    summaryStreamFn: async () => {
      staleCalls += 1;
      return { result: () => staleResult.promise } as AssistantMessageEventStream;
    },
  };
  const stalePromise = runtime.compactNow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(staleCalls, 1);
  runtime.setPageContext('context-changed-during-compaction');
  await assert.rejects(stalePromise, /stale/i);
  staleResult.resolve(createSummaryMessage('Late stale summary'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.filter((event) => event.type === 'context_compacted').length, 1, 'a stale late result must not emit another success');
  assert.ok(events.some((event) => (
    (event.status as { compactionStatus?: { state?: string } } | undefined)?.compactionStatus?.state === 'stale'
  )));
  assert.equal((await loadPiSessionWithSummary(sessionId, userId, session?.agentId))?.summary.summaryRevision, 1);

  appendHistoryBatch('timeout');
  const timeoutResult = deferred<AssistantMessage>();
  let timeoutCalls = 0;
  (runtime as unknown as {
    options: {
      summaryStreamFn: StreamFn;
      compactionPolicy: { timeoutMs: number; retryDelaysMs: readonly number[] };
    };
  }).options = {
    summaryStreamFn: async () => {
      timeoutCalls += 1;
      return { result: () => timeoutResult.promise } as AssistantMessageEventStream;
    },
    compactionPolicy: { timeoutMs: 10, retryDelaysMs: [0] },
  };
  await assert.rejects(runtime.compactNow(), /failed/i);
  assert.equal(timeoutCalls, 1);
  timeoutResult.resolve(createSummaryMessage('Late timed out summary'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.filter((event) => event.type === 'context_compacted').length, 1, 'a timed-out late result must not emit another success');
  assert.ok(events.some((event) => (
    (event.status as { compactionStatus?: { state?: string } } | undefined)?.compactionStatus?.state === 'failed'
  )));
  assert.equal((await loadPiSessionWithSummary(sessionId, userId, session?.agentId))?.summary.summaryRevision, 1);

  const exactBudgetRuntime = Object.create(LivePiRuntime.prototype) as Record<string, unknown>;
  const initialCandidate = [{ role: 'user', content: 'original candidate', timestamp: 1 }] as unknown as AgentMessage[];
  const compactedCandidate = [{ role: 'user', content: 'compacted candidate', timestamp: 2 }] as unknown as AgentMessage[];
  const compactedSummary = {
    summaryText: 'Exact final payload was compacted.',
    summaryUpdatedAt: new Date(),
    summaryThroughTimestamp: 1,
    summaryThroughSequence: 1,
    summaryRevision: 1,
  };
  const initialComposition = { llmMessages: initialCandidate };
  const retryComposition = { llmMessages: compactedCandidate };
  let preparedPayloadCount = 0;
  let retryAdditionalContextTokens = 0;
  Object.assign(exactBudgetRuntime, {
    summary: { ...compactedSummary, summaryText: null, summaryUpdatedAt: null, summaryThroughTimestamp: null, summaryThroughSequence: null, summaryRevision: 0 },
    lastComposition: null,
    preparedRuntimePayload: null,
    injectRuntimeContext: async (candidate: AgentMessage[]) => candidate,
    buildFinalPayload: async (candidate: AgentMessage[]) => {
      const exceeds = preparedPayloadCount++ === 0;
      return {
        sourceMessages: candidate,
        messages: candidate,
        budgetSnapshot: {
          contextBudgetExceeded: exceeds,
          payloadBudgetExceeded: false,
        },
      };
    },
    cachePreparedRuntimePayload(payload: unknown) {
      this.preparedRuntimePayload = payload;
    },
    getPayloadPressure: () => 1_500,
    coordinateCompaction: async (input: { additionalContextTokens: number }) => {
      retryAdditionalContextTokens = input.additionalContextTokens;
      return {
        state: 'succeeded',
        attemptId: 'exact-payload-retry',
        summary: compactedSummary,
        composition: retryComposition,
      };
    },
    recordCompaction: () => undefined,
    publishStatus: () => undefined,
  });
  const recoveredCandidate = await (exactBudgetRuntime as unknown as {
    finalizeContextCandidate: (input: {
      composition: unknown;
      sourceMessages: AgentMessage[];
      runtimeContext: null;
      additionalContextTokens: number;
    }) => Promise<AgentMessage[]>;
  }).finalizeContextCandidate({
    composition: initialComposition,
    sourceMessages: initialCandidate,
    runtimeContext: null,
    additionalContextTokens: 200,
  });
  assert.equal(retryAdditionalContextTokens, 1_700, 'exact final-payload overflow must reserve room for a retry compaction');
  assert.deepEqual(recoveredCandidate, compactedCandidate, 'the retried, exact-budget-safe candidate must reach the provider');
  assert.equal(preparedPayloadCount, 2, 'the final payload must be checked before and after the retry compaction');

  const finalAttempts = await db.select().from(piSessionCompactionAttempts);
  assert.deepEqual(finalAttempts.map((attempt) => attempt.state), ['succeeded', 'aborted', 'stale', 'timed_out']);
  console.log('pi-live-compaction-integration-test: ok');
}

main()
  .finally(() => rmSync(dataDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
