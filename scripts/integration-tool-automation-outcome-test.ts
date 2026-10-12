import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AfterToolCallContext, AgentContext, AgentLoopConfig, AgentMessage } from '@earendil-works/pi-agent-core';
import { createPiTestDatabase } from './helpers/pi-test-database';
import type { IntegrationUncertainTurnContext } from '../app/lib/integration-tools/uncertain-turns';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-integration-automation-outcome-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;
process.env.QMD_ENABLED = 'false';
process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
process.env.BASE_URL = 'http://127.0.0.1:3001';
let testDatabase: Awaited<ReturnType<typeof createPiTestDatabase>> | undefined;
type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;
type Mode = 'unknown-empty' | 'unknown-prefix' | 'unknown-mixed-abort' | 'native-error' | 'spoof-native';
let mode: Mode = 'unknown-empty';
let loopCalls = 0;
let deliveryCalls = 0;
let successPushCalls = 0;
let abortController: AbortController | undefined;
let verifyDurableBarrier: (() => Promise<void>) | undefined;
const trustedAutomationTurns = new Map<string, IntegrationUncertainTurnContext>();
const testModel = {
  id: 'test-model', name: 'Test Model', provider: 'test-provider', api: 'openai-completions',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000, maxTokens: 1_000,
};
const testSelection = {
  selection: { providerInstallationId: `aip_${'a'.repeat(24)}`, providerId: 'test-provider', modelId: testModel.id, thinkingLevel: 'off' },
  catalogRevision: 0, policyRevision: 0, selectionSource: 'app_default', credentialScope: 'organization',
};
const runtime = {
  selection: testSelection, model: testModel, streamFn: async () => ({ result: async () => undefined }),
  getApiKey: async () => undefined, requiresRecreation: () => false,
};
class TestPiSessionBusyError extends Error {}
class TestAutomationRunTimeoutError extends Error {}
class TestAutomationLoopShutdownError extends Error {}

const assistant = (text: string, error?: string) => ({
  role: 'assistant' as const, content: text ? [{ type: 'text' as const, text }] : [],
  api: testModel.api, provider: testModel.provider, model: testModel.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: error ? 'error' : 'stop', ...(error ? { errorMessage: error } : {}), timestamp: Date.now(),
});

// Only the external model/notification boundaries are controlled. The runner,
// workspace/agent policy, claim CAS, sessions and queue transitions are production code.
moduleInternals._load = (request, parent, isMain) => {
  if (testDatabase && (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request))) return testDatabase;
  if (request === 'server-only') return {};
  if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat' || request === '@earendil-works/pi-ai/oauth') return {
    ...originalLoad(require.resolve('../node_modules/@earendil-works/pi-ai/dist/index.js'), parent, isMain) as object,
    registerBuiltInApiProviders() {}, getProviders: () => [], getModels: () => [],
  };
  if (request === '@earendil-works/pi-agent-core') return {
    runAgentLoop: async (messages: AgentMessage[], context: AgentContext, config: AgentLoopConfig,
      onEvent: (event: unknown) => Promise<void>) => {
      loopCalls += 1;
      const { getAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
      const trusted = getAgentExecutionContext();
      assert.ok(trusted);
      assert.ok(trusted.agentTurnId?.startsWith('automation-run:'), 'the actual runner supplies source-run provenance to initial and refreshed context');
      trustedAutomationTurns.set(trusted.sessionId, { ...trusted });
      if (mode === 'native-error') {
        const final = assistant('', 'ordinary model failure');
        await onEvent({ type: 'message_end', message: final });
        return [...messages, final];
      }
      const { INTEGRATION_GATEWAY_ERROR_MESSAGES } = await import('../app/lib/integration-tools/agent-errors');
      const toolName = mode === 'spoof-native' ? 'studio_generate_image' : 'integrations';
      const details = { integrationError: { version: 1, error: {
        code: 'outcome_unknown', message: INTEGRATION_GATEWAY_ERROR_MESSAGES.outcome_unknown,
      }, nextActions: [] } };
      const toolCall = { type: 'toolCall' as const, id: 'uncertain-action', name: toolName, arguments: {} };
      const assistantMessage = { ...assistant(mode === 'unknown-empty' ? '' : 'I am about to create the requested design.'), stopReason: 'toolUse', content: [toolCall] };
      const result = { content: [{ type: 'text' as const, text: 'Execution result requires review.' }], details };
      const override = await config.afterToolCall?.({
        toolCall, result, isError: false, assistantMessage, context,
      } as AfterToolCallContext);
      if (mode === 'spoof-native') assert.equal(override, undefined, 'native provider data cannot impersonate the gateway marker');
      else {
        assert.equal(override?.isError, true);
        assert.equal(override?.terminate, true);
        await verifyDurableBarrier?.();
      }
      const toolResult = { role: 'toolResult' as const, toolCallId: toolCall.id, toolName,
        content: result.content, details, isError: override?.isError ?? false, timestamp: Date.now() };
      await onEvent({ type: 'message_end', message: toolResult });
      if (mode === 'unknown-mixed-abort') {
        const metadataCall = { type: 'toolCall' as const, id: 'metadata-action', name: 'integration_metadata', arguments: {} };
        assert.equal(await config.afterToolCall?.({ toolCall: metadataCall,
          result: { content: [{ type: 'text', text: 'metadata' }], details: {} }, isError: false,
          assistantMessage, context } as AfterToolCallContext), undefined);
        abortController?.abort();
        throw new Error('mixed tool batch was interrupted after its external result');
      }
      const final = assistant(mode === 'unknown-empty' ? '' : 'I am about to create the requested design.');
      await onEvent({ type: 'message_end', message: final });
      return [...messages, toolResult, final];
    },
  };
  if (request === '@/app/lib/agent-runtime-policy/provider-runtime' || request.endsWith('/agent-runtime-policy/provider-runtime')) return {
    resolveExecutableAgentRuntime: async () => runtime, resolveAndPinSessionRuntime: async () => runtime,
    resolveCompactionSummaryRuntime: async () => null,
  };
  if (request === '@/app/lib/pi/session-exclusive-execution' || request.endsWith('/pi/session-exclusive-execution')) return {
    PiSessionBusyError: TestPiSessionBusyError,
    withExclusivePiSessionExecution: async (input: {
      beforeRuntimeCheck?: () => Promise<void>;
      operation: (reservation: { lease: { holdUntil: () => void }; runReserved: (signal: AbortSignal, operation: () => Promise<unknown>) => Promise<unknown> }) => Promise<unknown>;
    }) => input.operation({ lease: { holdUntil() {} }, runReserved: async (signal, operation) => {
      await input.beforeRuntimeCheck?.();
      if (signal.aborted) throw new Error('reservation aborted');
      return operation();
    } }),
  };
  if (request === './run-timeout' && parent?.filename.endsWith('/automations/runner.ts')) return {
    AutomationLoopShutdownError: TestAutomationLoopShutdownError, AutomationRunTimeoutError: TestAutomationRunTimeoutError,
    runWithAutomationTimeout: async (input: { operation: (signal: AbortSignal) => Promise<unknown> }) => {
      abortController = new AbortController();
      try { return await input.operation(abortController.signal); } finally { abortController = undefined; }
    },
  };
  if (request === '@/app/lib/mobile/push-devices' || request.endsWith('/mobile/push-devices')) return {
    sendAgentResponseReadyPush: async () => { successPushCalls += 1; return { attempted: 0, accepted: 0 }; },
    sendAutomationRunStatusPush: async (input: { status: string }) => { if (input.status === 'success') successPushCalls += 1; return { attempted: 0, accepted: 0 }; },
    sendFailureAttentionPush: async () => ({ attempted: 0, accepted: 0 }),
  };
  if (request === './delivery' && parent?.filename.endsWith('/automations/runner.ts')) return {
    ...originalLoad(request, parent, isMain) as object,
    dispatchAutomationResult: async () => { deliveryCalls += 1; return { delivered: true }; },
  };
  if (request === '@/app/lib/agents/system-prompt' || request.endsWith('/agents/system-prompt')) return {
    loadManagedAgentSystemPrompt: async () => ({ systemPrompt: '', diagnostics: { loadedFiles: [], includedFiles: [], emptyFiles: [], usedFallback: false } }),
  };
  if (request === '@/app/lib/pi/tool-registry' || request.endsWith('/pi/tool-registry')) return {
    getPiTools: async () => ['integrations', 'integration_metadata', 'studio_generate_image'].map((name) => ({
      name, label: name, description: 'Fixture tool for runner state tests', parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'fixture' }], details: {} }),
    })),
  };
  if (request === '@/app/lib/pi/message-normalization' || request.endsWith('/pi/message-normalization')) return {
    normalizePiMessagesForLlm: async (messages: unknown[]) => messages,
    filterImagesForNonVisionModel: (messages: unknown[]) => messages,
  };
  if (request.endsWith('/agents/effective-runtime-config') || request === './effective-runtime-config'
    || request.endsWith('/pi/api-key-resolver') || request === './api-key-resolver') {
    throw new Error('The automation hook must not load legacy credential/runtime resolution.');
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  testDatabase = await createPiTestDatabase();
  const { db } = testDatabase;
  const { user, automationRuns } = await import('../app/lib/db/schema');
  const { eq } = await import('drizzle-orm');
  const store = await import('../app/lib/automations/store');
  let { executeAutomationRun } = await import('../app/lib/automations/runner');
  const userId = 'integration-automation-user';
  await db.insert(user).values({ id: userId, name: 'Integration Automation User', email: 'integration-automation@example.test',
    emailVerified: true, image: null, role: null, createdAt: new Date(), updatedAt: new Date() });
  const makeJob = (name: string) => store.createAutomationJob({ name, prompt: 'Create a design through the configured integration.',
    preferredSkill: 'auto', workspaceContextPaths: [], targetOutputPath: null, agentId: 'canvas-agent',
    deliveryMode: 'web', deliverySessionMode: 'new_session',
    schedule: { kind: 'interval', every: 1, unit: 'hours', timeZone: 'UTC' } }, userId);
  for (const nextMode of ['unknown-empty', 'unknown-prefix', 'unknown-mixed-abort'] as const) {
    mode = nextMode;
    const job = await makeJob(nextMode);
    const run = await store.scheduleAutomationJobRun(job.id, 'manual', new Date());
    assert.ok(run);
    const pending = await store.createPendingAutomationRun(job.id, 'manual');
    const retry = await store.createPendingAutomationRun(job.id, 'manual');
    await db.update(automationRuns).set({ status: 'retry_scheduled', attemptNumber: 2,
      scheduledFor: new Date(Date.now() + 60_000) }).where(eq(automationRuns.id, retry.id));
    verifyDurableBarrier = async () => {
      const persistedJob = await store.getAutomationJob(job.id);
      assert.equal(persistedJob?.status, 'paused', 'pause must already be durable when the tool hook returns');
      assert.equal(persistedJob?.nextRunAt, null);
      assert.equal(persistedJob?.revision, job.revision + 1);
      for (const id of [run.id, pending.id, retry.id]) assert.equal((await store.getAutomationRun(id))?.status, 'failed');
    };
    const deliveryBefore = deliveryCalls;
    const successPushBefore = successPushCalls;
    await executeAutomationRun(run.id);
    await verifyDurableBarrier();
    const finished = await store.getAutomationRun(run.id);
    assert.equal(finished?.metadataJson?.integrationErrorCode, 'outcome_unknown');
    assert.equal(finished?.metadataJson?.retryAt, null);
    assert.equal(finished?.metadataJson?.automationPaused, true);
    assert.match(finished?.resultText ?? '', /Execution may have completed/);
    assert.doesNotMatch(finished?.resultText ?? '', /about to create/);
    assert.equal(deliveryCalls, deliveryBefore, 'uncertain action must never deliver a success result');
    assert.equal(successPushCalls, successPushBefore);
    assert.ok(!(await store.listDueAutomationJobs(new Date(Date.now() + 24 * 3_600_000))).some((entry) => entry.id === job.id));
    assert.ok(!(await store.listExecutableAutomationRuns(new Date(Date.now() + 24 * 3_600_000))).some((entry) => entry.jobId === job.id));
    await assert.rejects(store.scheduleAutomationJobRun(job.id, 'manual', new Date()), /not active/);
    // Remove all in-process module state: the PostgreSQL queue barrier must still prevent reexecution.
    delete require.cache[require.resolve('../app/lib/automations/runner')];
    ({ executeAutomationRun } = originalLoad(require.resolve('../app/lib/automations/runner'), module, false) as typeof import('../app/lib/automations/runner'));
    const beforeRestart = loopCalls;
    for (const id of [run.id, pending.id, retry.id]) await executeAutomationRun(id);
    assert.equal(loopCalls, beforeRestart, 'restart must not retry either the uncertain action or its queued siblings');
  }
  verifyDurableBarrier = undefined;
  mode = 'native-error';
  const nativeJob = await makeJob('ordinary-native-error');
  const nativeRun = await store.scheduleAutomationJobRun(nativeJob.id, 'manual', new Date());
  assert.ok(nativeRun);
  await executeAutomationRun(nativeRun.id);
  assert.equal((await store.getAutomationRun(nativeRun.id))?.status, 'retry_scheduled');
  assert.equal((await store.getAutomationJob(nativeJob.id))?.status, 'active');
  assert.equal((await store.getAutomationJob(nativeJob.id))?.revision, nativeJob.revision);
  mode = 'spoof-native';
  const spoofJob = await makeJob('native-marker-cannot-pause');
  const spoofRun = await store.scheduleAutomationJobRun(spoofJob.id, 'manual', new Date());
  assert.ok(spoofRun);
  await executeAutomationRun(spoofRun.id);
  assert.equal((await store.getAutomationRun(spoofRun.id))?.status, 'success');
  assert.equal((await store.getAutomationJob(spoofJob.id))?.status, 'active');

  // A real completed parent run can outlive a delegated business action.
  // Its server-issued provenance, rather than a historical shared session match,
  // must atomically quarantine the owning job when the background result becomes unknown.
  const completed = await store.getAutomationRun(spoofRun.id);
  assert.ok(completed?.piSessionId);
  const parentTurn = trustedAutomationTurns.get(completed.piSessionId);
  assert.ok(parentTurn);
  assert.equal(parentTurn.agentTurnId, store.automationRunIntegrationTurnId(spoofRun.id));
  const backgroundPending = await store.createPendingAutomationRun(spoofJob.id, 'manual');
  const backgroundRetry = await store.createPendingAutomationRun(spoofJob.id, 'manual');
  await db.update(automationRuns).set({ status: 'retry_scheduled', scheduledFor: new Date(Date.now() + 60_000) })
    .where(eq(automationRuns.id, backgroundRetry.id));
  const { persistIntegrationTurnUncertain, isPersistedIntegrationTurnUncertain } = await import('../app/lib/integration-tools/uncertain-turn-store');
  await db.insert(user).values({ id: 'different-actor', name: 'Different Actor', email: 'different-actor@example.test',
    emailVerified: true, image: null, role: null, createdAt: new Date(), updatedAt: new Date() });
  for (const unrelated of [
    { ...parentTurn, agentTurnId: 'later-human-turn-in-the-same-shared-chat' },
    { ...parentTurn, userId: 'different-actor' },
    { ...parentTurn, workspaceId: 'foreign-workspace' },
    { ...parentTurn, agentId: 'foreign-agent' },
    { ...parentTurn, sessionId: 'foreign-session' },
    { ...parentTurn, agentTurnId: 'automation-run:foreign-run' },
  ]) {
    await persistIntegrationTurnUncertain(unrelated);
    assert.equal((await store.getAutomationJob(spoofJob.id))?.status, 'active', 'unrelated or human contexts cannot pause a historical shared-session job');
    assert.equal((await store.getAutomationRun(backgroundPending.id))?.status, 'pending');
    assert.equal((await store.getAutomationRun(backgroundRetry.id))?.status, 'retry_scheduled');
  }
  const raw = await testDatabase.openDb();
  await raw.run(`CREATE FUNCTION block_uncertainty_pause() RETURNS trigger AS $$
    BEGIN
      IF NEW.status = 'paused' THEN RAISE EXCEPTION 'atomic pause failure fixture'; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`);
  await raw.run('CREATE TRIGGER block_uncertainty_pause BEFORE UPDATE ON automation_jobs FOR EACH ROW EXECUTE FUNCTION block_uncertainty_pause()');
  await assert.rejects(persistIntegrationTurnUncertain(parentTurn), (error: unknown) => {
    const cause = error instanceof Error ? error.cause : undefined;
    return cause instanceof Error && cause.message.includes('atomic pause failure fixture');
  });
  assert.equal(await isPersistedIntegrationTurnUncertain(parentTurn), false, 'durable insertion rolls back if its owning job pause fails');
  assert.equal((await store.getAutomationJob(spoofJob.id))?.status, 'active');
  await raw.run('DROP TRIGGER block_uncertainty_pause ON automation_jobs');
  await persistIntegrationTurnUncertain(parentTurn);
  assert.equal(await isPersistedIntegrationTurnUncertain(parentTurn), true);
  assert.equal((await store.getAutomationJob(spoofJob.id))?.status, 'paused');
  assert.equal((await store.getAutomationJob(spoofJob.id))?.revision, spoofJob.revision + 1);
  assert.equal((await store.getAutomationJob(spoofJob.id))?.nextRunAt, null);
  assert.equal((await store.getAutomationRun(spoofRun.id))?.status, 'success', 'the already completed parent history stays intact');
  for (const id of [backgroundPending.id, backgroundRetry.id]) assert.equal((await store.getAutomationRun(id))?.status, 'failed');
  await persistIntegrationTurnUncertain(parentTurn);
  assert.equal((await store.getAutomationJob(spoofJob.id))?.revision, spoofJob.revision + 1, 'duplicate late results increment the job revision only once');
  const cacheHost = globalThis as typeof globalThis & { __canvasIntegrationUncertainTurnsV1?: { clear(): void } };
  cacheHost.__canvasIntegrationUncertainTurnsV1?.clear();
  delete require.cache[require.resolve('../app/lib/integration-tools/uncertain-turn-store')];
  const restartedStore = originalLoad(require.resolve('../app/lib/integration-tools/uncertain-turn-store'), module, false) as typeof import('../app/lib/integration-tools/uncertain-turn-store');
  assert.equal(await restartedStore.isPersistedIntegrationTurnUncertain(parentTurn), true);
  const callsBeforeRestart = loopCalls;
  for (const id of [backgroundPending.id, backgroundRetry.id]) await executeAutomationRun(id);
  assert.equal(loopCalls, callsBeforeRestart);
  await assert.rejects(store.scheduleAutomationJobRun(spoofJob.id, 'manual', new Date()), /not active/);
  assert.ok(!(await store.listDueAutomationJobs(new Date(Date.now() + 24 * 3_600_000))).some(job => job.id === spoofJob.id));
  assert.ok(!(await store.listExecutableAutomationRuns(new Date(Date.now() + 24 * 3_600_000))).some(run => run.jobId === spoofJob.id));
  assert.equal((await store.getAutomationJob(nativeJob.id))?.status, 'active', 'another job remains active');
  const staleJob = await makeJob('lost-claim-cannot-pause');
  const staleRun = await store.createPendingAutomationRun(staleJob.id, 'manual');
  assert.equal(await store.markAutomationRunFinished(staleRun.id, { status: 'failed', eventsLog: [], metadataJson: {},
    expectation: { status: 'running', attemptNumber: 1 }, pauseJobForUnknownOutcome: true }), null);
  assert.equal((await store.getAutomationJob(staleJob.id))?.status, 'active');
  assert.equal((await store.getAutomationRun(staleRun.id))?.status, 'pending');
  await assert.rejects(store.markAutomationRunFinished(staleRun.id, { status: 'success', eventsLog: [], metadataJson: {},
    expectation: { status: 'pending', attemptNumber: 1 }, pauseJobForUnknownOutcome: true }), /must finish as failed/);
  console.log('PASS integration automation durable outcome barrier: empty/prefix/mixed-abort, late completed parent, atomic queue pause, exact trusted provenance, restart, native retry and spoof denial');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  moduleInternals._load = originalLoad;
  await testDatabase?.close();
  rmSync(dataDir, { recursive: true, force: true });
});
