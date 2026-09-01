import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-automation-compaction-'));
process.env.DATA = dataDir;

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
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

async function main(): Promise<void> {
  const { db } = await import('../app/lib/db');
  const { piSessionCompactionAttempts, user } = await import('../app/lib/db/schema');
  const { prepareAutomationHistoryWithCompaction } = await import('../app/lib/automations/history-compaction');
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
  let summaryCalls = 0;
  const summaryStreamFn: StreamFn = async () => {
    summaryCalls += 1;
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Committed automation summary' }],
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
  assert.equal(reloaded?.summary.summaryText, 'Committed automation summary');
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
  console.log('automation-history-compaction-test: ok');
}

main()
  .finally(() => {
    moduleInternals._load = originalLoad;
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
