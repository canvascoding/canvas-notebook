import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';
import { createPiTestDatabase } from './helpers/pi-test-database';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-automation-compaction-'));
process.env.DATA = dataDir;

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
let testDatabase: Awaited<ReturnType<typeof createPiTestDatabase>> | undefined;
moduleInternals._load = (request, parent, isMain) => {
  if (testDatabase && (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request))) return testDatabase;
  if (request === 'server-only') return {};
  if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
    return {
      getModels: () => [],
      getProviders: () => [],
      registerBuiltInApiProviders: () => undefined,
    };
  }
  return originalLoad(request, parent, isMain);
};

function toolCall(id: string, query: string, timestamp: number): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'web_search', arguments: { query } }],
    api: 'test',
    provider: 'test-provider',
    model: 'test-model',
    stopReason: 'toolUse',
    timestamp,
  } as unknown as AgentMessage;
}

function toolResult(id: string, text: string, timestamp: number): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'web_search',
    content: [{ type: 'text', text }],
    timestamp,
  } as unknown as AgentMessage;
}

function messageText(message: AgentMessage): string {
  const content = (message as unknown as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => (
    part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
      ? [part.text]
      : []
  )).join('\n');
}

async function main(): Promise<void> {
  testDatabase = await createPiTestDatabase();
  const { db } = testDatabase;
  const { piSessionCompactionAttempts, user } = await import('../app/lib/db/schema');
  const { prepareAutomationHistoryWithCompaction } = await import('../app/lib/automations/history-compaction');
  const { recoverAutomationRuntimePayload } = await import('../app/lib/automations/runtime-compaction');
  const { DEFAULT_PI_CONTEXT_BUDGET_POLICY } = await import('../app/lib/pi/context-budget');
  const { estimateTextTokens } = await import('../app/lib/pi/history-budget');
  const { buildPiSystemPromptSnapshotFromText } = await import('../app/lib/pi/system-prompt-snapshot');
  const { loadPiSessionWithSummary, savePiSession } = await import('../app/lib/pi/session-store');

  const now = new Date('2026-08-27T15:00:00.000Z');
  const userId = 'automation-compaction-user';
  const agentId = 'canvas-agent';
  const sessionId = 'automation-compaction-session';
  await db.insert(user).values({
    id: userId,
    name: 'Automation Compaction User',
    email: 'automation-compaction@example.test',
    emailVerified: true,
    image: null,
    role: null,
    createdAt: now,
    updatedAt: now,
  });

  const messages = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: index % 2 === 0
      ? `Automation user turn ${index}: ${'durable context '.repeat(45)}`
      : [{ type: 'text', text: `Automation assistant turn ${index}: ${'completed work '.repeat(45)}` }],
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
    {
      agentId,
      systemPromptSnapshot: buildPiSystemPromptSnapshotFromText('Automation compaction prompt', now),
    },
  );
  const loaded = await loadPiSessionWithSummary(sessionId, userId, agentId);
  assert.ok(loaded);
  const session = await db.query.piSessions.findFirst({
    where: (table, { eq }) => eq(table.sessionId, sessionId),
  });
  assert.ok(session?.workspaceId);

  const model = {
    id: 'test-model',
    name: 'Automation Compaction Model',
    api: 'openai-completions',
    provider: 'test-provider',
    baseUrl: 'http://localhost.invalid/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 6_000,
    maxTokens: 1_000,
  } satisfies Model<'openai-completions'>;
  const summaryBody = [
    '## Active Task',
    'Continue the automation from durable session state.',
    '## Completed Work',
    '- Preserved the completed automation work.',
    '## Decisions and Constraints',
    '- Keep the current prompt and session boundaries.',
    '## Files, Commands, and Exact Errors',
    '- No exact errors were reported.',
    '## Remaining Work',
    '- Run the next automation step.',
  ].join('\n');
  let summaryCalls = 0;
  const summaryStreamFn: StreamFn = async () => {
    summaryCalls += 1;
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: summaryBody }],
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
    return { result: async () => message } as AssistantMessageEventStream;
  };
  const systemPrompt = 'Automation compaction prompt';
  const promptMessage: AgentMessage = {
    role: 'user',
    content: `Run the current automation and preserve this prompt. ${'new durable automation context '.repeat(180)}`,
    timestamp: now.getTime() + 100,
  };
  const prepared = await prepareAutomationHistoryWithCompaction({
    sessionId,
    userId,
    agentId,
    workspaceId: session.workspaceId,
    messages: [...loaded.messages, promptMessage],
    promptMessage,
    summary: loaded.summary,
    persistedMessageCheckpoint: loaded.messages.length,
    model,
    tools: [],
    effectiveSystemPrompt: systemPrompt,
    systemPromptBudgetTokens: estimateTextTokens(systemPrompt),
    requestOutputTokens: 1_000,
    runtimeCatalogRevision: 7,
    runtimePolicyRevision: 11,
    signal: new AbortController().signal,
    streamFn: summaryStreamFn,
  });
  assert.equal(prepared.compactionState, 'succeeded');
  assert.ok(prepared.attemptId);
  assert.ok(summaryCalls > 0);
  const summaryCallsAfterCommit = summaryCalls;
  assert.equal(prepared.composition.llmMessages.at(-1), promptMessage);
  assert.equal(prepared.summary.summaryRevision, 1);

  const savedPrompt = await savePiSession(
    sessionId,
    userId,
    model.provider,
    model.id,
    [...loaded.messages, promptMessage],
    undefined,
    {
      agentId,
      persistedLength: loaded.messages.length,
    },
  );
  assert.equal(savedPrompt.summaryRevision, 1, 'saving the prompt must not recommit the coordinator summary');

  const reloaded = await loadPiSessionWithSummary(sessionId, userId, agentId);
  assert.match(reloaded?.summary.summaryText || '', /canvas-session-summary:v2/);
  assert.match(reloaded?.summary.summaryText || '', /## Rolling Summary/);
  assert.match(reloaded?.summary.summaryText || '', /Continue the automation from durable session state\./);
  assert.equal(reloaded?.summary.summaryRevision, 1);
  const nextPrompt: AgentMessage = {
    role: 'user',
    content: 'Continue the next automation run from the committed summary.',
    timestamp: now.getTime() + 200,
  };
  const resumed = await prepareAutomationHistoryWithCompaction({
    sessionId,
    userId,
    agentId,
    workspaceId: session.workspaceId,
    messages: [...(reloaded?.messages || []), nextPrompt],
    promptMessage: nextPrompt,
    summary: reloaded?.summary || prepared.summary,
    persistedMessageCheckpoint: reloaded?.messages.length || 0,
    model,
    tools: [],
    effectiveSystemPrompt: systemPrompt,
    systemPromptBudgetTokens: estimateTextTokens(systemPrompt),
    requestOutputTokens: 1_000,
    runtimeCatalogRevision: 7,
    runtimePolicyRevision: 11,
    signal: new AbortController().signal,
    streamFn: summaryStreamFn,
  });
  assert.equal(resumed.compactionState, 'succeeded');
  assert.equal(resumed.summary.summaryRevision, 2);
  assert.ok(summaryCalls > summaryCallsAfterCommit);
  assert.ok(
    (resumed.summary.summaryThroughSequence || 0) > (prepared.summary.summaryThroughSequence || 0),
    'reload compaction must advance from the committed watermark instead of covering the same range twice',
  );
  assert.equal(resumed.composition.llmMessages.at(-1), nextPrompt);

  const attempts = await db.select().from(piSessionCompactionAttempts);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((attempt) => attempt.state), ['succeeded', 'succeeded']);
  assert.ok(attempts.every((attempt) => attempt.trigger === 'automation'));
  assert.equal(attempts[1].baseThroughSequence, attempts[0].committedThroughSequence);
  assert.ok((attempts[1].committedThroughSequence || 0) > (attempts[0].committedThroughSequence || 0));

  // Exercise the production automation entry points with the Lean projection.
  // These records deliberately remain in SQLite unchanged: only the candidate
  // sent to the provider may receive deterministic tail stubs.
  const leanModel = { ...model, contextWindow: 64_000 } satisfies Model<'openai-completions'>;
  const leanEffectivePolicy = {
    contextBudgetPolicy: {
      ...DEFAULT_PI_CONTEXT_BUDGET_POLICY,
      tailMode: 'lean' as const,
      protectFirstMessages: 0,
      protectLastMessages: 0,
    },
    summaryModel: null,
    sources: { tailMode: 'persisted' as const, summaryModel: 'default' as const },
  };
  const buildLeanToolHistory = (prefix: string, startedAt: number): AgentMessage[] => {
    const history: AgentMessage[] = [{
      role: 'user',
      content: `${prefix} research is required before the final automation action.`,
      timestamp: startedAt,
    } as AgentMessage];
    for (let index = 0; index < 50; index += 1) {
      const callId = `${prefix}-tool-${index}`;
      history.push(
        toolCall(callId, `${prefix} query ${index}`, startedAt + index * 2 + 1),
        toolResult(
          callId,
          `${prefix} durable raw tool result ${index}: ${'evidence '.repeat(360)}`,
          startedAt + index * 2 + 2,
        ),
      );
    }
    return history;
  };
  const findSessionWorkspaceId = async (targetSessionId: string): Promise<string> => {
    const target = await db.query.piSessions.findFirst({
      where: (table, { eq }) => eq(table.sessionId, targetSessionId),
    });
    assert.ok(target?.workspaceId);
    return target.workspaceId;
  };

  // P1: no effective session_search capability means neither the committed
  // automation projection nor the in-run recovery payload may advertise it.
  const disabledSessionId = 'automation-lean-without-session-search';
  const disabledRawMessages = buildLeanToolHistory('disabled-lean', now.getTime() + 20_000);
  const disabledRawText = messageText(disabledRawMessages[2]);
  await savePiSession(disabledSessionId, userId, model.provider, model.id, disabledRawMessages, undefined, {
    agentId,
    systemPromptSnapshot: buildPiSystemPromptSnapshotFromText(systemPrompt, now),
  });
  const disabledLoaded = await loadPiSessionWithSummary(disabledSessionId, userId, agentId);
  assert.ok(disabledLoaded);
  const disabledPrompt: AgentMessage = {
    role: 'user', content: 'Finish the disabled-capability automation run.', timestamp: now.getTime() + 30_000,
  };
  const disabledPrepared = await prepareAutomationHistoryWithCompaction({
    sessionId: disabledSessionId,
    userId,
    agentId,
    workspaceId: await findSessionWorkspaceId(disabledSessionId),
    messages: [...disabledLoaded.messages, disabledPrompt],
    promptMessage: disabledPrompt,
    summary: disabledLoaded.summary,
    persistedMessageCheckpoint: disabledLoaded.messages.length,
    model: leanModel,
    tools: [],
    effectiveSystemPrompt: systemPrompt,
    systemPromptBudgetTokens: estimateTextTokens(systemPrompt),
    requestOutputTokens: 1_000,
    runtimeCatalogRevision: 7,
    runtimePolicyRevision: 12,
    signal: new AbortController().signal,
    streamFn: summaryStreamFn,
    effectiveCompactionPolicy: leanEffectivePolicy,
    force: true,
  });
  assert.equal(disabledPrepared.compactionState, 'succeeded');
  const disabledFollowUp: AgentMessage = {
    role: 'user', content: 'Continue with the same bounded disabled-capability history.', timestamp: now.getTime() + 31_000,
  };
  const disabledFollowUpPrepared = await prepareAutomationHistoryWithCompaction({
    sessionId: disabledSessionId,
    userId,
    agentId,
    workspaceId: await findSessionWorkspaceId(disabledSessionId),
    messages: [...disabledLoaded.messages, disabledFollowUp],
    promptMessage: disabledFollowUp,
    summary: disabledPrepared.summary,
    persistedMessageCheckpoint: disabledLoaded.messages.length,
    model: leanModel,
    tools: [],
    effectiveSystemPrompt: systemPrompt,
    systemPromptBudgetTokens: estimateTextTokens(systemPrompt),
    requestOutputTokens: 1_000,
    runtimeCatalogRevision: 7,
    runtimePolicyRevision: 12,
    signal: new AbortController().signal,
    streamFn: summaryStreamFn,
    effectiveCompactionPolicy: leanEffectivePolicy,
    force: true,
  });
  const disabledStub = disabledFollowUpPrepared.composition.llmMessages.find((message) => (
    message.role === 'toolResult' && messageText(message).includes('output demoted at compaction')
  ));
  assert.doesNotMatch(JSON.stringify(disabledFollowUpPrepared.composition.llmMessages), /session_search/u,
    'the real automation prompt must not advertise a disabled recovery tool');
  if (disabledStub) assert.doesNotMatch(messageText(disabledStub), /session_search/u);
  const disabledRecovery = await recoverAutomationRuntimePayload({
    messages: [...disabledLoaded.messages, disabledPrompt],
    summary: disabledPrepared.summary,
    model: leanModel,
    tools: [],
    effectiveSystemPrompt: systemPrompt,
    requestOutputTokenCap: 1_000,
    sessionId: disabledSessionId,
    signal: new AbortController().signal,
    streamFn: summaryStreamFn,
    effectiveCompactionPolicy: leanEffectivePolicy,
  });
  assert.ok(disabledRecovery, 'the real recovery path must return a payload for the bounded Lean candidate');
  assert.doesNotMatch(JSON.stringify(disabledRecovery.messages), /session_search/u);
  assert.equal(messageText((await loadPiSessionWithSummary(disabledSessionId, userId, agentId))!.messages[2]), disabledRawText,
    'the disabled-capability projection must not mutate raw tool text persisted for later search');

  // P3: two successful committed automation cycles retain their same-session
  // recovery authority, while the durable raw tool result remains searchable.
  const cycleSessionId = 'automation-lean-two-cycle-session';
  const cycleRawMessages = buildLeanToolHistory('cycle-lean', now.getTime() + 40_000);
  const cycleRawText = messageText(cycleRawMessages[2]);
  const sessionSearchTool = [{
    name: 'session_search',
    label: 'Session search',
    description: 'Recover authorized session history.',
    parameters: { type: 'object', properties: {} },
  }] as unknown as Parameters<typeof prepareAutomationHistoryWithCompaction>[0]['tools'];
  await savePiSession(cycleSessionId, userId, model.provider, model.id, cycleRawMessages, undefined, {
    agentId,
    systemPromptSnapshot: buildPiSystemPromptSnapshotFromText(systemPrompt, now),
  });
  const cycleLoaded = await loadPiSessionWithSummary(cycleSessionId, userId, agentId);
  assert.ok(cycleLoaded);
  const cyclePrompt: AgentMessage = {
    role: 'user', content: 'Finish the authorized Lean automation run.', timestamp: now.getTime() + 50_000,
  };
  const firstCycle = await prepareAutomationHistoryWithCompaction({
    sessionId: cycleSessionId,
    userId,
    agentId,
    workspaceId: await findSessionWorkspaceId(cycleSessionId),
    messages: [...cycleLoaded.messages, cyclePrompt],
    promptMessage: cyclePrompt,
    summary: cycleLoaded.summary,
    persistedMessageCheckpoint: cycleLoaded.messages.length,
    model: leanModel,
    tools: sessionSearchTool,
    effectiveSystemPrompt: systemPrompt,
    systemPromptBudgetTokens: estimateTextTokens(systemPrompt),
    requestOutputTokens: 1_000,
    runtimeCatalogRevision: 7,
    runtimePolicyRevision: 12,
    signal: new AbortController().signal,
    streamFn: summaryStreamFn,
    effectiveCompactionPolicy: leanEffectivePolicy,
    force: true,
  });
  assert.equal(firstCycle.compactionState, 'succeeded');
  assert.equal(firstCycle.summary.summaryRevision, 1);
  await savePiSession(cycleSessionId, userId, model.provider, model.id, [...cycleLoaded.messages, cyclePrompt], undefined, {
    agentId,
    persistedLength: cycleLoaded.messages.length,
  });
  const cycleReloaded = await loadPiSessionWithSummary(cycleSessionId, userId, agentId);
  assert.ok(cycleReloaded);
  const secondCycleMessages = buildLeanToolHistory('cycle-lean-second', now.getTime() + 60_000);
  const cycleSecondPrompt: AgentMessage = {
    role: 'user', content: 'Complete the second authorized Lean cycle.', timestamp: now.getTime() + 70_000,
  };
  const secondCycle = await prepareAutomationHistoryWithCompaction({
    sessionId: cycleSessionId,
    userId,
    agentId,
    workspaceId: await findSessionWorkspaceId(cycleSessionId),
    messages: [...cycleReloaded.messages, ...secondCycleMessages, cycleSecondPrompt],
    promptMessage: cycleSecondPrompt,
    summary: cycleReloaded.summary,
    persistedMessageCheckpoint: cycleReloaded.messages.length,
    model: leanModel,
    tools: sessionSearchTool,
    effectiveSystemPrompt: systemPrompt,
    systemPromptBudgetTokens: estimateTextTokens(systemPrompt),
    requestOutputTokens: 1_000,
    runtimeCatalogRevision: 7,
    runtimePolicyRevision: 12,
    signal: new AbortController().signal,
    streamFn: summaryStreamFn,
    effectiveCompactionPolicy: leanEffectivePolicy,
    force: true,
  });
  assert.equal(secondCycle.compactionState, 'succeeded');
  assert.equal(secondCycle.summary.summaryRevision, 2);
  assert.ok(
    (secondCycle.summary.summaryThroughSequence || 0) > (firstCycle.summary.summaryThroughSequence || 0),
    'the second committed Lean cycle must advance the durable summary watermark',
  );
  const finalCycleStore = await loadPiSessionWithSummary(cycleSessionId, userId, agentId);
  assert.ok(finalCycleStore);
  const { projectPiHermesHistory } = await import('../app/lib/pi/compaction/runtime-engine');
  const laterLeanProjection = projectPiHermesHistory({
    messages: [...finalCycleStore.messages, ...secondCycleMessages, cycleSecondPrompt],
    summary: secondCycle.summary,
    systemPromptTokens: estimateTextTokens(systemPrompt),
    model: leanModel,
    requestOutputTokens: 1_000,
    toolTokens: estimateTextTokens(JSON.stringify(sessionSearchTool)),
    sessionId: cycleSessionId,
    authorizedSessionId: cycleSessionId,
    sessionSearchAvailable: true,
    selectionMode: 'force',
    pruningMode: 'disabled',
    policy: leanEffectivePolicy.contextBudgetPolicy,
  });
  const authorizedStub = laterLeanProjection.composition.llmMessages.find((message) => (
    message.role === 'toolResult' && messageText(message).includes('output demoted at compaction')
  ));
  assert.ok(authorizedStub);
  assert.match(messageText(authorizedStub), new RegExp(`session_id='${cycleSessionId}'`, 'u'),
    'Lean recovery stubs retain the exact authorized session scope');
  assert.ok(finalCycleStore.messages.some((message) => messageText(message) === cycleRawText),
    'the large raw tool result remains persisted and searchable after both committed cycles');
  console.log('automation-history-compaction-test: ok');
}

main()
  .finally(async () => {
    moduleInternals._load = originalLoad;
    await testDatabase?.close();
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
