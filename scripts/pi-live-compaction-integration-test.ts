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
  const { loadLatestPiSessionInputUsage, persistPiUsageEvents } = await import('../app/lib/pi/usage-events');
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

  const providerUsageMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Provider usage anchor.' }],
    api: 'openai-completions',
    provider: 'test-provider',
    model: 'test-model',
    usage: {
      input: 1_420,
      output: 12,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1_432,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: now.getTime() + 99,
  } as AssistantMessage;
  await persistPiUsageEvents({ sessionId, userId, messages: [providerUsageMessage] });
  assert.deepEqual(await loadLatestPiSessionInputUsage(sessionId, userId), {
    inputTokens: 1_420,
    assistantTimestamp: new Date(Math.floor(providerUsageMessage.timestamp / 1_000) * 1_000),
  }, 'the last provider-reported input usage must survive runtime recreation');

  const model = {
    id: 'test-model',
    name: 'Live Compaction Model',
    api: 'openai-completions',
    provider: 'test-provider',
    baseUrl: 'http://localhost.invalid/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 6_000,
    maxTokens: 1_000,
  } satisfies Model<'openai-completions'>;
  const summaryResult = deferred<AssistantMessage>();
  let summaryCalls = 0;
  let lastSummaryContext = '';
  const createSummaryMessage = (label: string): AssistantMessage => ({
    role: 'assistant',
    content: [{
      type: 'text',
      text: [
        '## Active Task',
        label,
        '## Completed Work',
        '- Preserved completed work from the compacted range.',
        '## Decisions and Constraints',
        '- Keep exact session boundaries and the protected tail.',
        '## Files, Commands, and Exact Errors',
        '- No exact errors were reported.',
        '## Remaining Work',
        '- Continue from the durable rolling summary.',
      ].join('\n'),
    }],
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
  const summaryStreamFn: StreamFn = async (requestedModel, context, options) => {
    summaryCalls += 1;
    lastSummaryContext = JSON.stringify(context);
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
    lastProviderInputUsage: null,
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

  const statusRuntime = Object.create(LivePiRuntime.prototype) as Record<string, unknown>;
  Object.assign(statusRuntime, {
    sessionId,
    userId,
    model: { contextWindow: 262_000 },
    summary: { summaryUpdatedAt: null },
    lastComposition: {
      estimatedHistoryTokens: 100_000,
      availableHistoryTokens: 200_000,
      triggerHistoryTokens: 120_000,
      targetHistoryTokens: 24_000,
      includedSummary: false,
      omittedMessages: [],
    },
    lastFinalPayloadBudgetSnapshot: {
      estimatedTotalTokens: 185_000,
      effectiveInstructionTokens: 12_000,
      toolSchemaTokens: 4_000,
      runtimeProviderOverheadTokens: 64,
      multimodalTokens: 0,
      safetyReserveTokens: 5_936,
      outputReserveTokens: 20_000,
      hardHistoryTokens: 220_000,
      triggerHistoryTokens: 110_000,
      targetTailTokens: 22_000,
      contextBudgetExceeded: false,
      payloadBudgetExceeded: false,
    },
    lastProviderInputUsage: {
      inputTokens: 140_000,
      assistantTimestamp: now,
    },
    isRunning: false,
    abortRequested: false,
    activeTool: null,
    pendingReplace: null,
    agent: { state: { pendingToolCalls: new Set() } },
    compactionStatus: {
      state: 'idle', attemptId: null, trigger: null, reasonCode: null, retryAfter: null, omittedMessageCount: 0,
    },
    lastCompactionAt: null,
    lastCompactionKind: null,
    lastCompactionOmittedCount: 0,
    statusRevision: 1,
    getCompactionScope: () => ({ sessionId, userId, agentId: 'canvas-agent', workspaceId: null }),
  });
  Object.defineProperties(statusRuntime, {
    followUpQueue: { value: [] },
    steeringQueue: { value: [] },
  });
  const idleStatus = (statusRuntime as { getStatus: () => Record<string, unknown> }).getStatus();
  assert.equal(idleStatus.lastProviderInputTokens, 140_000);
  assert.equal(idleStatus.nextRequestEstimatedTokens, 162_000, 'idle status must expose a fresh rough request projection instead of the stale payload');
  assert.equal((idleStatus.contextPressure as { source: string }).source, 'rough_estimate');
  assert.equal((idleStatus.contextPressure as { percentOfTrigger: number }).percentOfTrigger, 83);
  statusRuntime.isRunning = true;
  const activeStatus = (statusRuntime as { getStatus: () => Record<string, unknown> }).getStatus();
  assert.equal(activeStatus.lastProviderInputTokens, 140_000);
  assert.equal(activeStatus.nextRequestEstimatedTokens, 185_000, 'active status must expose the next serialized-request estimate separately');
  assert.equal((activeStatus.contextPressure as { source: string }).source, 'serialized_request');
  statusRuntime.abortRequested = true;
  const abortingStatus = (statusRuntime as { getStatus: () => Record<string, unknown> }).getStatus();
  assert.equal(abortingStatus.nextRequestEstimatedTokens, 162_000, 'an aborted request must fall back to the current rough projection');
  assert.equal(abortingStatus.finalRequestTokens, null, 'an aborted request payload must not remain exposed as the final request');
  statusRuntime.abortRequested = false;
  statusRuntime.pendingReplace = { id: 'replacement-request' };
  const replacingStatus = (statusRuntime as { getStatus: () => Record<string, unknown> }).getStatus();
  assert.equal(replacingStatus.nextRequestEstimatedTokens, 162_000, 'a replacement must fall back to the current rough projection');
  assert.equal(replacingStatus.finalRequestTokens, null, 'the replaced request payload must not remain exposed during replacement');
  statusRuntime.pendingReplace = null;

  const eventRuntime = Object.create(LivePiRuntime.prototype) as Record<string, unknown>;
  Object.assign(eventRuntime, {
    model,
    sessionId,
    userId,
    lastFinalPayloadBudgetSnapshot: {
      estimatedInputTokens: 1_000,
      contractFingerprint: 'provider-usage-test',
    },
    lastProviderUsageCalibration: null,
    lastProviderInputUsage: null,
    thinkingFilterState: { buffer: '', inThinkingBlock: false, thinkingContent: '' },
    touch: () => undefined,
    publishStatus: () => undefined,
  });
  await (eventRuntime as { onAgentEvent: (event: unknown) => Promise<void> }).onAgentEvent({
    type: 'message_end',
    message: providerUsageMessage,
  });
  assert.equal(
    (eventRuntime.lastProviderInputUsage as { inputTokens: number } | null)?.inputTokens,
    1_420,
    'message_end must immediately expose provider-reported input usage to the runtime status',
  );

  const calibratedPreflight = {
    softThresholdExceeded: false,
    contextBudgetExceeded: false,
    omittedMessages: [],
  };
  const calibrationRuntime = Object.create(LivePiRuntime.prototype) as Record<string, unknown>;
  Object.assign(calibrationRuntime, {
    provider: 'test-provider',
    model,
    requestOutputTokenCap: 1_000,
    summary: { summaryText: null, summaryThroughSequence: null },
    lastProviderInputUsage: { inputTokens: 200, assistantTimestamp: now },
    messageContextSnapshots: new Map(),
    getRuntimeContextBlock: async () => null,
    getEffectiveSystemPrompt: () => 'calibration prompt',
    getEffectiveTools: () => [],
    composeHistory: () => calibratedPreflight,
    finalizeContextCandidate: async ({ sourceMessages }: { sourceMessages: AgentMessage[] }) => sourceMessages,
    coordinateCompaction: async () => {
      throw new Error('a request below the cheap gate must not compact');
    },
  });
  const calibrationCandidate = [{ role: 'user', content: 'calibrated prompt', timestamp: now.getTime() }] as AgentMessage[];
  assert.deepEqual(await (calibrationRuntime as {
    transformContext: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
  }).transformContext(calibrationCandidate), calibrationCandidate);

  const focusTopic = 'database migration safety';
  const compactPromise = runtime.compactNow(focusTopic);
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
      cause: 'threshold';
      messages: AgentMessage[];
      additionalContextTokens: number;
      runtimeContext: null;
    }) => Promise<{ state: string; attemptId: string }>;
  }).coordinateCompaction({
    kind: 'automatic',
    cause: 'threshold',
    messages: runtime.agent.state.messages as AgentMessage[],
    additionalContextTokens: 0,
    runtimeContext: null,
  });
  assert.equal(automaticRace.state, 'already_running');
  assert.equal(summaryCalls, 1, 'manual/automatic races must share one summary provider call');
  summaryResult.resolve(createSummaryMessage(`Committed live runtime summary for ${focusTopic}`));
  await compactPromise;
  assert.match(lastSummaryContext, /database migration safety/);

  const reloaded = await loadPiSessionWithSummary(sessionId, userId, session?.agentId);
  assert.match(reloaded?.summary.summaryText || '', /canvas-session-summary:v2/);
  assert.match(reloaded?.summary.summaryText || '', /## Rolling Summary/);
  assert.match(reloaded?.summary.summaryText || '', /Committed live runtime summary/);
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
  const succeededStatus = events.findLast((event) => (
    (event.status as { compactionStatus?: { state?: string } } | undefined)?.compactionStatus?.state === 'succeeded'
  ))?.status as {
    compactionStatus?: {
      cause?: string;
      beforeTokens?: number;
      afterTokens?: number;
      triggerTokens?: number;
      targetTokens?: number;
      focusApplied?: boolean;
    };
  } | undefined;
  assert.equal(succeededStatus?.compactionStatus?.cause, 'manual');
  assert.equal(succeededStatus?.compactionStatus?.focusApplied, true);
  assert.ok((succeededStatus?.compactionStatus?.beforeTokens ?? 0) > 0);
  assert.ok((succeededStatus?.compactionStatus?.afterTokens ?? 0) > 0);
  assert.ok((succeededStatus?.compactionStatus?.triggerTokens ?? 0) > 0);
  assert.ok((succeededStatus?.compactionStatus?.targetTokens ?? 0) > 0);
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
  await assert.rejects(runtime.compactNow(), /total time ceiling/i);
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
  let retryKind: 'manual' | 'automatic' | null = null;
  let retryBypassesCooldown = false;
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
          estimatedTotalTokens: exceeds ? 9_500 : 7_500,
          contextWindowTokens: 8_000,
          serializedMessageBytes: 0,
          hardHistoryBytes: 1,
          multimodalBytes: 0,
          totalImageBytesLimit: 1,
          contextBudgetExceeded: exceeds,
          payloadBudgetExceeded: false,
        },
      };
    },
    cachePreparedRuntimePayload(payload: unknown) {
      this.preparedRuntimePayload = payload as null;
    },
    coordinateCompaction: async (input: { kind: 'manual' | 'automatic'; bypassCooldown?: boolean; additionalContextTokens: number }) => {
      retryKind = input.kind;
      retryBypassesCooldown = input.bypassCooldown === true;
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
  assert.equal(retryKind, 'automatic', 'an exact final-payload retry must remain an automatic compaction');
  assert.equal(retryBypassesCooldown, true, 'an exact final-payload retry must use its dedicated bounded cooldown bypass');
  assert.equal(retryAdditionalContextTokens, 1_700, 'exact final-payload overflow must reserve room for a retry compaction');
  assert.deepEqual(recoveredCandidate, compactedCandidate, 'the retried, exact-budget-safe candidate must reach the provider');
  assert.equal(preparedPayloadCount, 2, 'the final payload must be checked before and after the retry compaction');

  const exactSnapshot = (estimatedTotalTokens: number) => ({
    estimatedTotalTokens,
    contextWindowTokens: 8_000,
    serializedMessageBytes: 0,
    hardHistoryBytes: 1,
    multimodalBytes: 0,
    totalImageBytesLimit: 1,
    contextBudgetExceeded: estimatedTotalTokens > 8_000,
    payloadBudgetExceeded: false,
  });
  const createProgressRuntime = (loads: number[]) => {
    const candidateRuntime = Object.create(LivePiRuntime.prototype) as Record<string, unknown>;
    let payloadIndex = 0;
    let compactionCalls = 0;
    Object.assign(candidateRuntime, {
      summary: compactedSummary,
      lastComposition: null,
      preparedRuntimePayload: null,
      injectRuntimeContext: async (candidate: AgentMessage[]) => candidate,
      buildFinalPayload: async (candidate: AgentMessage[]) => ({
        sourceMessages: candidate,
        messages: candidate,
        budgetSnapshot: exactSnapshot(loads[Math.min(payloadIndex++, loads.length - 1)]),
      }),
      cachePreparedRuntimePayload(payload: unknown) {
        this.preparedRuntimePayload = payload as null;
      },
      coordinateCompaction: async () => {
        compactionCalls += 1;
        return {
          state: 'succeeded',
          attemptId: `progress-${compactionCalls}`,
          summary: compactedSummary,
          composition: retryComposition,
        };
      },
      applyAutomaticCompactionResult: () => true,
    });
    return { candidateRuntime, getCompactionCalls: () => compactionCalls };
  };
  const noProgressRuntime = createProgressRuntime([10_000, 9_600, 7_900]);
  await assert.rejects(
    (noProgressRuntime.candidateRuntime as unknown as {
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
      additionalContextTokens: 0,
    }),
    /still exceeds/i,
  );
  assert.equal(noProgressRuntime.getCompactionCalls(), 1, 'a retry with at most 5% reduction must stop');

  const progressingRuntime = createProgressRuntime([10_000, 9_000, 7_900]);
  await (progressingRuntime.candidateRuntime as unknown as {
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
    additionalContextTokens: 0,
  });
  assert.equal(progressingRuntime.getCompactionCalls(), 2, 'retries may continue only after material progress');

  const idleRuntime = Object.create(LivePiRuntime.prototype) as Record<string, unknown>;
  let idleCompactionCalls = 0;
  let idlePersistCalls = 0;
  Object.assign(idleRuntime, {
    options: { idleCompaction: true, idleCompactionDelayMs: 0 },
    idleCompactionTimer: null,
    disposed: false,
    isRunning: false,
    pendingReplace: null,
    agent: { state: { isStreaming: false, messages: compactedCandidate } },
    getBrowserRuntimeContextTokenEstimate: () => 0,
    coordinateCompaction: async (input: { kind: string; selectionMode?: string }) => {
      idleCompactionCalls += 1;
      assert.equal(input.kind, 'automatic');
      assert.equal(input.selectionMode, 'force');
      return { state: 'succeeded', summary: compactedSummary, composition: retryComposition };
    },
    applyAutomaticCompactionResult: () => true,
    persistMessages: async () => {
      idlePersistCalls += 1;
      return 1;
    },
    composeHistory: () => retryComposition,
    touch: () => undefined,
    publishStatus: () => undefined,
  });
  (idleRuntime as { scheduleIdleCompaction: () => void }).scheduleIdleCompaction();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(idleCompactionCalls, 1);
  assert.equal(idlePersistCalls, 1);
  idleRuntime.options = { idleCompaction: false, idleCompactionDelayMs: 0 };
  (idleRuntime as { scheduleIdleCompaction: () => void }).scheduleIdleCompaction();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(idleCompactionCalls, 1, 'idle compaction must remain disabled unless explicitly enabled');

  let disposedTimerFired = false;
  const disposeRuntime = Object.create(LivePiRuntime.prototype) as Record<string, unknown>;
  Object.assign(disposeRuntime, {
    disposed: false,
    idleCompactionTimer: setTimeout(() => { disposedTimerFired = true; }, 10),
    browserSnapshotUnsubscribe: null,
    agentUnsubscribe: null,
    subscribers: new Set(),
    getCompactionScope: () => ({ sessionId: 'dispose-idle', userId, agentId: 'canvas-agent', workspaceId: null }),
  });
  (disposeRuntime as { dispose: () => void }).dispose();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disposedTimerFired, false, 'disposing a runtime must cancel pending idle compaction');

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
