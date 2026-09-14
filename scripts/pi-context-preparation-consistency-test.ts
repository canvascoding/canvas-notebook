import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';

const internals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = internals._load;
let testDatabase: Awaited<ReturnType<typeof import('./helpers/pi-test-database').createPiTestDatabase>> | undefined;
const testData = mkdtempSync(path.join(tmpdir(), 'canvas-context-preparation-'));
process.env.DATA = testData;
internals._load = (request, parent, isMain) => {
  if (testDatabase && (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request)
    || /^(?:\.\.\/)+db$/u.test(request))) return testDatabase;
  if (request === 'server-only') return {};
  if ((request.startsWith('.') || request.startsWith('@/')) && request.endsWith('/auth')) return { auth: {} };
  if (request === '@earendil-works/pi-agent-core') return { Agent: class Agent {} };
  if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
    return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
  }
  return originalLoad(request, parent, isMain);
};

const model: Model<'openai-completions'> = {
  id: 'context-regression', name: 'Context regression', api: 'openai-completions', provider: 'test',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262_144, maxTokens: 8_192,
};
const emptySummary = {
  summaryText: null, summaryUpdatedAt: null, summaryThroughTimestamp: null,
  summaryThroughSequence: null, summaryRevision: 0,
};

function history(): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < 90; i++) {
    messages.push({ role: 'user', content: `Read source ${i}.`, timestamp: i * 3 + 1 });
    messages.push({
      role: 'assistant', content: [{ type: 'toolCall', id: `call-${i}`, name: 'read', arguments: { path: `source-${i}.md` } }],
      api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: i * 3 + 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    messages.push({ role: 'toolResult', toolCallId: `call-${i}`, toolName: 'read',
      content: [{ type: 'text', text: `SOURCE-${i} ${'x'.repeat(8_500)}` }],
      isError: false, timestamp: i * 3 + 3 });
  }
  messages.push({ role: 'user', content: 'Continue the current project.', timestamp: 1_000 });
  return messages;
}

async function main() {
  const { createPiTestDatabase } = await import('./helpers/pi-test-database');
  testDatabase = await createPiTestDatabase();
  const { LivePiRuntime } = await import('../app/lib/pi/live-runtime');
  const { projectPiHermesHistory } = await import('../app/lib/pi/compaction/runtime-engine');
  const { user, piSessionCompactionAttempts } = await import('../app/lib/db/schema');
  const { savePiSession, loadPiSessionWithSummary } = await import('../app/lib/pi/session-store');
  const { buildPiSystemPromptSnapshotFromText } = await import('../app/lib/pi/system-prompt-snapshot');
  const { measurePiContextStatus } = await import('../app/lib/pi/context-status-measurement');
  const { estimateTextTokens } = await import('../app/lib/pi/history-budget');
  const messages = history();
  const systemPrompt = 'system instructions '.repeat(2_000);
  const userId = 'context-regression-user';
  const sessionId = 'context-preparation-regression';
  await testDatabase.db.insert(user).values({ id: userId, name: 'Context regression', email: 'context@example.test',
    emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await savePiSession(sessionId, userId, model.provider, model.id, messages, undefined,
    { systemPromptSnapshot: buildPiSystemPromptSnapshotFromText(systemPrompt, new Date()) });
  const session = await testDatabase.db.query.piSessions.findFirst();
  assert.ok(session);
  const loaded = await loadPiSessionWithSummary(sessionId, userId, session.agentId);
  assert.ok(loaded);
  const original = JSON.stringify(messages);
  const base = { messages, summary: emptySummary, model, systemPromptTokens: estimateTextTokens(systemPrompt),
    toolTokens: 0, requestOutputTokens: 8_192 };
  const measurementInput = { model, effectiveInstructions: [{ role: 'system' as const, content: systemPrompt }],
    effectiveTools: [], requestOutputTokenCap: 8_192 };
  const unpruned = projectPiHermesHistory({ ...base, selectionMode: 'full', pruningMode: 'disabled' });
  const originalStatus = await measurePiContextStatus(unpruned.composition,
    { ...measurementInput, messages: unpruned.composition.llmMessages });
  assert.ok(originalStatus.contextPressure.percentOfTrigger > 100, 'fixture crosses the soft trigger');
  assert.equal(originalStatus.nextRequestBudgetExceeded, false, 'fixture still fits the hard model window');

  let attempts = 0;
  const runtime = Object.assign(Object.create(LivePiRuntime.prototype), {
    sessionId, userId, agentId: session.agentId, provider: model.provider, model,
    executionContext: { workspaceId: session.workspaceId },
    compactionGeneration: 0, messageSequenceCheckpoint: messages.length,
    disposed: false, persistMessages: async () => 0,
    options: { summaryStreamFn: async () => { throw new Error('This history only needs deterministic tool pruning'); } },
    requestOutputTokenCap: 8_192, summary: { ...emptySummary }, messageContextSnapshots: new Map(),
    agent: { state: { messages } },
    getEffectiveSystemPrompt: () => systemPrompt, getEffectiveTools: () => [],
    getBrowserRuntimeContextTokenEstimate: () => 0, getRuntimeContextBlock: async () => null,
    publishStatus: () => {},
  });
  // Count attempts without replacing the real coordinator, candidate decision,
  // or transactional store. The transcript is already saved in isolated PG.
  const coordinate = runtime.coordinateCompaction.bind(runtime);
  runtime.coordinateCompaction = (input: Record<string, unknown>) => {
    attempts++;
    return coordinate(input);
  };
  const outgoing = await runtime.transformContext(messages);
  const sentTokens = runtime.preparedRuntimePayload.budgetSnapshot.estimatedTotalTokens;
  const refreshed = new Promise<void>(resolve => { runtime.publishStatus = resolve; });
  runtime.refreshContextMeasurement();
  await refreshed;
  assert.equal(runtime.contextMeasurementCache.current.nextRequestEstimatedTokens, sentTokens,
    'the displayed next request must equal the actual prepared request after tool pruning');
  assert.equal(attempts, 0, 'pruning below the trigger must not start a summary attempt');
  assert.equal((await testDatabase.db.select().from(piSessionCompactionAttempts)).length, 0);
  const prepared = await runtime.prepareFinalPayload(outgoing);
  assert.equal(prepared.length, messages.length, 'all history records and tool pairs remain represented');
  assert.ok(JSON.stringify(messages) === original, 'persisted source contents remain unchanged');
  assert.ok(runtime.contextMeasurementCache.current.contextPressure.percentOfTrigger < 100);

  // Reload takes the shared projection without a live runtime or its caches.
  const stored = projectPiHermesHistory({ ...base, selectionMode: 'full' });
  const storedStatus = await measurePiContextStatus(stored.composition,
    { ...measurementInput, messages: stored.composition.llmMessages });
  assert.equal(storedStatus.nextRequestEstimatedTokens, sentTokens);
  await runtime.transformContext(messages);
  assert.equal(attempts, 0, 'a later send must not repeat a no-op summary attempt');
  runtime.getRuntimeContextBlock = async () => '<runtime_context>Current project context.</runtime_context>';
  runtime.invalidateContextMeasurement();
  await runtime.transformContext(messages);
  const contextualTokens = runtime.preparedRuntimePayload.budgetSnapshot.estimatedTotalTokens;
  const contextualMeasurement = new Promise<void>(resolve => { runtime.publishStatus = resolve; });
  runtime.refreshContextMeasurement();
  await contextualMeasurement;
  assert.equal(runtime.contextMeasurementCache.current.nextRequestEstimatedTokens, contextualTokens,
    'turn context must use the same protected-tail allowance in status and send');
  console.log('pi context preparation consistency tests passed');
}

async function verifyNormalizedTrigger() {
  const { preparePiHermesCompactionCandidate, projectPiHermesHistory } = await import('../app/lib/pi/compaction/runtime-engine');
  const { preparePiFinalPayload } = await import('../app/lib/pi/multimodal-preparation');
  const messages: AgentMessage[] = Array.from({ length: 32 }, (_, i) => ({
    role: 'user', content: `Record ${i}: ${'\\'.repeat(12_000)}`, timestamp: i + 1,
  }));
  const base = { messages, summary: emptySummary, model, systemPromptTokens: 0,
    toolTokens: 0, requestOutputTokens: 8_192, sessionId: 'normalized-trigger-regression',
    signal: new AbortController().signal };
  const projection = projectPiHermesHistory({ ...base, selectionMode: 'full' });
  assert.equal(projection.composition.softThresholdExceeded, false, 'rough estimate misses serialization expansion');
  const prepared = await preparePiFinalPayload({ messages: projection.composition.llmMessages, model,
    effectiveInstructions: [], effectiveTools: [], requestOutputTokenCap: 8_192 });
  assert.equal(prepared.budgetSnapshot.contextBudgetExceeded, false);
  assert.ok(prepared.budgetSnapshot.serializedMessageTokens >= prepared.budgetSnapshot.triggerHistoryTokens);
  let summaryCalls = 0;
  const candidate = await preparePiHermesCompactionCandidate({ ...base,
    triggerSnapshot: prepared.budgetSnapshot,
    streamFn: async () => { summaryCalls++; throw new Error('simulated provider failure'); } });
  assert.ok(summaryCalls > 0, 'confirmed normalized pressure must reach the summary provider');
  assert.equal(candidate.summaryAttempted, true);
  assert.equal(candidate.summaryFailed, true, 'provider failure must remain visible, not become below-trigger');
  console.log('normalized trigger handoff tests passed');
}

main().then(verifyNormalizedTrigger).finally(async () => {
  await testDatabase?.close();
  internals._load = originalLoad;
  rmSync(testData, { recursive: true, force: true });
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
