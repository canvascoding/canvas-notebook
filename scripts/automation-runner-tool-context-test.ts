import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-automation-runner-tools-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;
process.env.QMD_ENABLED = 'false';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;

const toolCalls: Array<{
  userId: string | undefined;
  agentId: string | null | undefined;
  sessionId: string | null | undefined;
}> = [];
let agentLoopToolNames: string[] = [];
let agentLoopMode: 'success' | 'heartbeat-ok' | 'no-action' | 'empty-error' = 'success';
let exclusiveMode: 'pass' | 'busy' = 'pass';
let timeoutMode: 'pass' | 'non-quiescent' = 'pass';
let beforeExclusivePreflight: (() => Promise<void>) | null = null;
let workspaceResolutionCalls = 0;
let failWorkspaceResolutionAtCall: number | null = null;
let abortDuringSessionCreate = false;
let activeExecutionAbortController: AbortController | null = null;
const agentLoopStreamFns: unknown[] = [];
const agentLoopThinkingLevels: unknown[] = [];
const agentLoopSystemPrompts: string[] = [];
const agentLoopNextTurnSystemPrompts: string[] = [];
const runtimeResolutionCalls: Array<{
  kind: 'executable' | 'pinned';
  context: Record<string, unknown>;
}> = [];
const quarantinedSettlements: Promise<unknown>[] = [];
let releaseDetachedTimeoutOperation: (() => void) | null = null;
const agentResponsePushCalls: Array<{ userId: string; workspaceId: string; sessionId: string }> = [];
const automationStatusPushCalls: Array<{
  userId: string;
  workspaceId: string;
  runId: string;
  jobName: string;
  status: 'success' | 'failed';
}> = [];
const failurePushCalls: Array<{
  userId: string;
  workspaceId: string;
  entityKind: 'studio' | 'automation';
  entityId: string;
}> = [];

const testModel = {
  id: 'test-model',
  name: 'Test Model',
  provider: 'test-provider',
  api: 'openai-completions',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 1_000,
};
const testSelection = {
  selection: {
    providerInstallationId: `aip_${'a'.repeat(24)}`,
    providerId: 'test-provider',
    modelId: testModel.id,
    thinkingLevel: 'off',
  },
  catalogRevision: 0,
  policyRevision: 0,
  selectionSource: 'app_default',
  credentialScope: 'organization',
};
const testStreamFn = async () => ({ result: async () => undefined });
const testExecutableRuntime = {
  selection: testSelection,
  model: testModel,
  streamFn: testStreamFn,
  getApiKey: async () => undefined,
  requiresRecreation: () => false,
};
class TestPiSessionBusyError extends Error {}
class TestAutomationRunTimeoutError extends Error {}
class TestAutomationLoopShutdownError extends Error {
  readonly loopQuiescent = false;

  constructor(readonly operationSettlement: Promise<void>) {
    super('test automation loop did not stop');
  }
}

moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') {
    return {};
  }

  if (request === '@/app/lib/mobile/push-devices' || request.endsWith('/mobile/push-devices')) {
    return {
      sendAgentResponseReadyPush: async (input: { userId: string; workspaceId: string; sessionId: string }) => {
        agentResponsePushCalls.push(input);
        return { attempted: 1, accepted: 1 };
      },
      sendAutomationRunStatusPush: async (input: {
        userId: string;
        workspaceId: string;
        runId: string;
        jobName: string;
        status: 'success' | 'failed';
      }) => {
        automationStatusPushCalls.push(input);
        return { attempted: 1, accepted: 1 };
      },
      sendFailureAttentionPush: async (input: {
        userId: string;
        workspaceId: string;
        entityKind: 'studio' | 'automation';
        entityId: string;
      }) => {
        failurePushCalls.push(input);
        return { attempted: 1, accepted: 1 };
      },
    };
  }

  if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat' || request === '@earendil-works/pi-ai/oauth') {
    return {
      registerBuiltInApiProviders() {},
      getProviders() {
        return [];
      },
      getModels() {
        return [];
      },
    };
  }

  if (request === '@earendil-works/pi-agent-core') {
    return {
      agentLoop: async function* agentLoopStub(
        messages: unknown[],
        context: { systemPrompt?: string; tools?: Array<{ name: string }> },
        config: {
          thinkingLevel?: unknown;
          prepareNextTurn?: (turnContext: {
            context: { systemPrompt?: string; messages: unknown[]; tools: Array<{ name: string }> };
          }) => Promise<{ context?: { systemPrompt?: string } } | undefined>;
        },
        _signal: AbortSignal | undefined,
        streamFn: unknown,
      ) {
        agentLoopToolNames = context.tools?.map((tool) => tool.name) ?? [];
        agentLoopStreamFns.push(streamFn);
        agentLoopThinkingLevels.push(config.thinkingLevel);
        agentLoopSystemPrompts.push(context.systemPrompt || '');
        const turnUpdate = await config.prepareNextTurn?.({
          context: {
            systemPrompt: context.systemPrompt,
            messages: [],
            tools: context.tools || [],
          },
        });
        agentLoopNextTurnSystemPrompts.push(turnUpdate?.context?.systemPrompt || '');
        if (agentLoopMode === 'empty-error') {
          yield {
            type: 'agent_end',
            messages: [
              ...messages,
              ...messages,
              {
                role: 'assistant',
                content: [],
                api: testModel.api,
                provider: testModel.provider,
                model: testModel.id,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
                stopReason: 'error',
                errorMessage: 'empty model failure',
                timestamp: Date.now(),
              },
            ],
          };
          return;
        }
        if (agentLoopMode === 'heartbeat-ok') {
          yield {
            type: 'agent_end',
            messages: [
              {
                role: 'assistant',
                content: [{ type: 'text', text: 'HEARTBEAT_OK' }],
                api: testModel.api,
                provider: testModel.provider,
                model: testModel.id,
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
              },
            ],
          };
          return;
        }
        if (agentLoopMode === 'no-action') {
          yield {
            type: 'agent_end',
            messages: [
              {
                role: 'assistant',
                content: [{ type: 'text', text: 'NO_ACTION' }],
                api: testModel.api,
                provider: testModel.provider,
                model: testModel.id,
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
              },
            ],
          };
          return;
        }
        yield {
          type: 'agent_end',
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'Automation finished.' }],
              api: testModel.api,
              provider: testModel.provider,
              model: testModel.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              timestamp: Date.now(),
            },
          ],
        };
      },
    };
  }

  if (request === './policy' && parent?.filename?.endsWith('/app/lib/automations/runner.ts')) {
    const policy = originalLoad(request, parent, isMain) as {
      resolveAutomationRunWorkspace: (job: unknown) => Promise<unknown>;
    };
    return {
      ...policy,
      resolveAutomationRunWorkspace: async (job: unknown) => {
        workspaceResolutionCalls += 1;
        if (workspaceResolutionCalls === failWorkspaceResolutionAtCall) {
          throw new Error('workspace permission was revoked');
        }
        return policy.resolveAutomationRunWorkspace(job);
      },
    };
  }

  if (request === './run-timeout') {
    return {
      AutomationLoopShutdownError: TestAutomationLoopShutdownError,
      AutomationRunTimeoutError: TestAutomationRunTimeoutError,
      runWithAutomationTimeout: async (input: {
        operation: (signal: AbortSignal) => Promise<unknown>;
      }) => {
        if (timeoutMode === 'non-quiescent') {
          const operationSettlement = new Promise<void>((resolve) => {
            releaseDetachedTimeoutOperation = resolve;
          });
          throw new TestAutomationLoopShutdownError(operationSettlement);
        }
        const controller = new AbortController();
        activeExecutionAbortController = controller;
        try {
          return await input.operation(controller.signal);
        } finally {
          activeExecutionAbortController = null;
        }
      },
    };
  }

  if (
    (request === '@/app/lib/pi/session-store' || request.endsWith('/pi/session-store'))
    && parent?.filename?.endsWith('/app/lib/automations/runner.ts')
  ) {
    const sessionStore = originalLoad(request, parent, isMain) as {
      createPiSessionWithRuntimeSnapshot: (input: unknown) => Promise<unknown>;
    } & Record<string, unknown>;
    return {
      ...sessionStore,
      createPiSessionWithRuntimeSnapshot: async (input: unknown) => {
        const session = await sessionStore.createPiSessionWithRuntimeSnapshot(input);
        if (abortDuringSessionCreate) {
          abortDuringSessionCreate = false;
          activeExecutionAbortController?.abort();
        }
        return session;
      },
    };
  }

  if (
    request === '@/app/lib/agents/effective-runtime-config' ||
    request === './effective-runtime-config' ||
    request.endsWith('/agents/effective-runtime-config')
  ) {
    throw new Error('Automation runner must not load the legacy runtime resolver.');
  }

  if (
    request === '@/app/lib/agent-runtime-policy/provider-runtime' ||
    request.endsWith('/agent-runtime-policy/provider-runtime')
  ) {
    return {
      resolveExecutableAgentRuntime: async (context: Record<string, unknown>) => {
        runtimeResolutionCalls.push({ kind: 'executable', context });
        return testExecutableRuntime;
      },
      resolveAndPinSessionRuntime: async (context: Record<string, unknown>) => {
        runtimeResolutionCalls.push({ kind: 'pinned', context });
        return testExecutableRuntime;
      },
    };
  }

  if (
    request === '@/app/lib/pi/session-exclusive-execution' ||
    request.endsWith('/pi/session-exclusive-execution')
  ) {
    return {
      PiSessionBusyError: TestPiSessionBusyError,
      withExclusivePiSessionExecution: async (input: {
        beforeRuntimeCheck?: () => Promise<void>;
        operation: (reservation: {
          lease: { holdUntil: (settlement: Promise<unknown>) => void };
          runReserved: <T>(signal: AbortSignal, operation: () => Promise<T>) => Promise<T>;
        }) => Promise<unknown>;
      }) => {
        return input.operation({
          lease: {
            holdUntil: (settlement) => {
              quarantinedSettlements.push(settlement);
            },
          },
          runReserved: async (signal, operation) => {
            const testPreflight = beforeExclusivePreflight;
            beforeExclusivePreflight = null;
            await testPreflight?.();
            await input.beforeRuntimeCheck?.();
            if (signal.aborted) throw new Error('test reservation aborted');
            if (exclusiveMode === 'busy') throw new TestPiSessionBusyError('busy');
            return operation();
          },
        });
      },
    };
  }

  if (request === '@/app/lib/agents/system-prompt' || request.endsWith('/agents/system-prompt')) {
    return {
      loadManagedAgentSystemPrompt: async () => ({
        systemPrompt: '',
        diagnostics: {
          loadedFiles: [],
          includedFiles: [],
          emptyFiles: [],
          usedFallback: false,
        },
      }),
    };
  }

  if (
    request === '@/app/lib/pi/api-key-resolver' ||
    request === './api-key-resolver' ||
    request.endsWith('/pi/api-key-resolver')
  ) {
    throw new Error('Automation runner must not load the legacy API-key resolver.');
  }

  if (request === '@/app/lib/pi/message-normalization' || request.endsWith('/pi/message-normalization')) {
    return {
      normalizePiMessagesForLlm: async (messages: unknown[]) => messages,
      filterImagesForNonVisionModel: (messages: unknown[]) => messages,
    };
  }

  if (request === '@/app/lib/pi/tool-registry' || request.endsWith('/pi/tool-registry')) {
    return {
      getPiTools: async (userId?: string, agentId?: string | null, sessionId?: string | null) => {
        toolCalls.push({ userId, agentId, sessionId });
        return [
          {
            name: 'studio_generate_image',
            label: 'Generating studio image',
            description: 'Test studio image tool',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
          },
          {
            name: 'email_send_draft',
            label: 'Send email draft',
            description: 'This must never reach an automation run.',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: 'sent' }], details: {} }),
          },
          {
            name: 'mcp',
            label: 'External MCP',
            description: 'This must never reach an automation run.',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
          },
          {
            name: 'bash',
            label: 'Shell',
            description: 'This must never reach an email-event automation run.',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
          },
        ];
      },
    };
  }

  if (request === '@/app/lib/pi/model-resolver' || request.endsWith('/pi/model-resolver')) {
    return { CANVAS_CONTROL_PLANE_PROVIDER_ID: 'canvas-control-plane' };
  }

  return originalLoad(request, parent, isMain);
};

async function main() {
  const userId = 'automation-tool-user';
  const agentId = 'canvas-agent';
  const now = new Date();

  const { db } = await import('../app/lib/db');
  const {
    aiRuntimeDefaults,
    automationRuns,
    piMessages,
    piSessions,
    sessionChannelLinks,
    user,
  } = await import('../app/lib/db/schema');
  const { asc, eq } = await import('drizzle-orm');
  const {
    createAutomationJob,
    getAutomationRun,
    markAutomationRunRetryScheduled,
    scheduleAutomationJobRun,
  } = await import('../app/lib/automations/store');
  const { executeAutomationRun } = await import('../app/lib/automations/runner');

  await db.insert(user).values({
    id: userId,
    name: 'Automation Tool User',
    email: 'automation-tool-user@example.test',
    emailVerified: true,
    image: null,
    role: null,
    createdAt: now,
    updatedAt: now,
  });

  const job = await createAutomationJob(
    {
      name: 'Image Automation',
      prompt: 'Generate an image through Studio.',
      preferredSkill: 'auto',
      workspaceContextPaths: [],
      targetOutputPath: null,
      agentId,
      deliveryMode: 'web',
      deliverySessionMode: 'new_session',
      schedule: { kind: 'interval', every: 1, unit: 'hours', timeZone: 'UTC' },
    },
    userId,
  );
  const run = await scheduleAutomationJobRun(job.id, 'manual', now);
  assert.ok(run);

  await executeAutomationRun(run.id);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(toolCalls, [{ userId, agentId, sessionId: `auto-${run.id.replace(/^run-/, '')}` }]);
  assert.deepEqual(agentLoopToolNames, ['studio_generate_image', 'email_send_draft', 'mcp', 'bash']);
  assert.notEqual(agentLoopStreamFns[0], testStreamFn, 'automation must wrap the provider stream with its explicit output cap');
  assert.equal(agentLoopThinkingLevels[0], 'off');
  assert.match(agentLoopSystemPrompts[0] || '', /<!-- canvas-effective-tools:v1 -->/);
  assert.match(agentLoopSystemPrompts[0] || '', /`studio_generate_image`/);
  assert.doesNotMatch(agentLoopSystemPrompts[0] || '', /## Current Workspace File Tree/);
  assert.match(agentLoopNextTurnSystemPrompts[0] || '', /<!-- canvas-effective-tools:v1 -->/);
  assert.doesNotMatch(agentLoopNextTurnSystemPrompts[0] || '', /## Current Workspace File Tree/);
  assert.deepEqual(runtimeResolutionCalls.slice(0, 2).map((call) => call.kind), ['executable', 'pinned']);
  assert.equal(runtimeResolutionCalls[0].context.userId, userId);
  assert.equal(runtimeResolutionCalls[0].context.agentId, agentId);
  assert.equal(typeof runtimeResolutionCalls[0].context.organizationId, 'string');
  assert.equal(typeof runtimeResolutionCalls[0].context.workspaceId, 'string');

  const finishedRun = await getAutomationRun(run.id);
  assert.equal(finishedRun?.status, 'success');
  assert.equal(finishedRun?.errorMessage, null);
  assert.deepEqual(agentResponsePushCalls, [{ userId, workspaceId: job.workspaceId, sessionId: `auto-${run.id.replace(/^run-/, '')}` }]);
  assert.deepEqual(finishedRun?.metadataJson?.runtime, {
    providerInstallationId: testSelection.selection.providerInstallationId,
    providerId: testSelection.selection.providerId,
    modelId: testSelection.selection.modelId,
    thinkingLevel: testSelection.selection.thinkingLevel,
    credentialScope: testSelection.credentialScope,
    catalogRevision: testSelection.catalogRevision,
    policyRevision: testSelection.policyRevision,
    selectionSource: testSelection.selectionSource,
  });

  const completedLoopCount = agentLoopStreamFns.length;
  const completedRuntimeResolutionCount = runtimeResolutionCalls.length;
  await executeAutomationRun(run.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await getAutomationRun(run.id))?.status, 'success');
  assert.equal(agentLoopStreamFns.length, completedLoopCount);
  assert.equal(runtimeResolutionCalls.length, completedRuntimeResolutionCount);
  assert.equal(agentResponsePushCalls.length, 1, 'a terminal run must not emit a duplicate response push');

  const staleRetry = await markAutomationRunRetryScheduled(
    run.id,
    new Date(now.getTime() + 60_000),
    'stale retry must not win',
    [],
    { status: 'retry_scheduled' },
    { status: 'running', attemptNumber: finishedRun?.attemptNumber ?? 1 },
    null,
  );
  assert.equal(staleRetry, null);
  assert.equal((await getAutomationRun(run.id))?.status, 'success');

  const session = await db.query.piSessions.findFirst({
    where: eq(piSessions.userId, userId),
  });
  assert.ok(session);
  assert.equal(session?.userId, userId);
  assert.equal(session?.agentId, agentId);
  assert.equal(session?.runtimeProviderInstallationId, testSelection.selection.providerInstallationId);
  assert.equal(session?.runtimeCatalogRevision, 0);
  assert.equal(session?.runtimePolicyRevision, 0);
  assert.equal(session?.runtimeSelectionSource, 'app_default');
  assert.equal(session?.thinkingLevel, 'off');
  assert.doesNotMatch(session?.systemPromptSnapshot || '', /## Current Workspace File Tree/);

  /* Legacy heartbeat execution coverage moved to automation-heartbeat-migration-test.ts.
  const heartbeatMessagesBefore = await db.query.piMessages.findMany({
    where: eq(piMessages.piSessionDbId, session.id),
    orderBy: [asc(piMessages.sequence)],
  });
  const heartbeatSessionBefore = await db.query.piSessions.findFirst({
    where: eq(piSessions.id, session.id),
  });
  assert.ok(heartbeatSessionBefore);

  const heartbeatJob = await upsertHeartbeatJob({
    userId,
    agentId,
    enabled: true,
    schedule: { kind: 'interval', every: 1, unit: 'hours', timeZone: 'UTC' },
    deliveryMode: 'web',
    deliveryChannelId: 'web',
    deliverySessionMode: 'fixed_session',
    deliverySessionId: session.sessionId,
  });
  const heartbeatRun = await scheduleAutomationJobRun(heartbeatJob.id, 'manual', now);
  assert.ok(heartbeatRun);

  agentLoopMode = 'heartbeat-ok';
  await executeAutomationRun(heartbeatRun.id);
  agentLoopMode = 'success';

  const finishedHeartbeatRun = await getAutomationRun(heartbeatRun.id);
  assert.equal(finishedHeartbeatRun?.status, 'success');
  assert.equal(finishedHeartbeatRun?.resultText, 'Heartbeat completed without relevant updates.');
  assert.deepEqual(finishedHeartbeatRun?.metadataJson?.heartbeat, {
    outcome: 'no_updates',
    acknowledgement: 'HEARTBEAT_OK',
    deliverySuppressed: true,
  });
  assert.deepEqual((finishedHeartbeatRun?.metadataJson?.delivery as Record<string, unknown>)?.dispatch, {
    attempted: false,
    delivered: false,
    skippedReason: 'heartbeat_ok',
    error: null,
  });

  const heartbeatMessagesAfter = await db.query.piMessages.findMany({
    where: eq(piMessages.piSessionDbId, session.id),
    orderBy: [asc(piMessages.sequence)],
  });
  assert.deepEqual(
    heartbeatMessagesAfter.map(({ role, content, sequence }) => ({ role, content, sequence })),
    heartbeatMessagesBefore.map(({ role, content, sequence }) => ({ role, content, sequence })),
  );
  const heartbeatSessionAfter = await db.query.piSessions.findFirst({
    where: eq(piSessions.id, session.id),
  });
  assert.equal(heartbeatSessionAfter?.title, heartbeatSessionBefore.title);
  assert.equal(heartbeatSessionAfter?.lastMessageAt?.getTime(), heartbeatSessionBefore.lastMessageAt?.getTime());
  assert.equal(agentResponsePushCalls.length, 1, 'a no-op heartbeat must not emit a response push');

  const heartbeatMessageRun = await scheduleAutomationJobRun(heartbeatJob.id, 'manual', now);
  assert.ok(heartbeatMessageRun);
  await executeAutomationRun(heartbeatMessageRun.id);

  const finishedHeartbeatMessageRun = await getAutomationRun(heartbeatMessageRun.id);
  assert.equal(finishedHeartbeatMessageRun?.status, 'success');
  assert.deepEqual(finishedHeartbeatMessageRun?.metadataJson?.heartbeat, {
    outcome: 'message',
    acknowledgement: null,
    deliverySuppressed: false,
  });
  assert.deepEqual((finishedHeartbeatMessageRun?.metadataJson?.delivery as Record<string, unknown>)?.dispatch, {
    attempted: true,
    delivered: true,
    skippedReason: null,
    error: null,
  });
  const heartbeatMessageRows = await db.query.piMessages.findMany({
    where: eq(piMessages.piSessionDbId, session.id),
    orderBy: [asc(piMessages.sequence)],
  });
  assert.equal(heartbeatMessageRows.length, heartbeatMessagesBefore.length + 2);
  assert.ok(heartbeatMessageRows.at(-1)?.content.includes('Automation finished.'));
  const heartbeatMessageSession = await db.query.piSessions.findFirst({
    where: eq(piSessions.id, session.id),
  });
  assert.ok((heartbeatMessageSession?.lastMessageAt?.getTime() || 0) >= (heartbeatSessionBefore.lastMessageAt?.getTime() || 0));
  assert.equal(agentResponsePushCalls.length, 2, 'a heartbeat with a relevant message must emit a response push');

  const newSessionHeartbeatJob = await upsertHeartbeatJob({
    userId,
    agentId,
    enabled: true,
    schedule: { kind: 'interval', every: 1, unit: 'hours', timeZone: 'UTC' },
    deliveryMode: 'web',
    deliveryChannelId: 'web',
    deliverySessionMode: 'new_session',
    deliverySessionId: null,
  });
  const newSessionHeartbeatRun = await scheduleAutomationJobRun(newSessionHeartbeatJob.id, 'manual', now);
  assert.ok(newSessionHeartbeatRun);

  agentLoopMode = 'heartbeat-ok';
  await executeAutomationRun(newSessionHeartbeatRun.id);
  agentLoopMode = 'success';

  const finishedNewSessionHeartbeatRun = await getAutomationRun(newSessionHeartbeatRun.id);
  const newHeartbeatSessionId = `auto-${newSessionHeartbeatRun.id.replace(/^run-/, '')}`;
  assert.equal(finishedNewSessionHeartbeatRun?.status, 'success');
  assert.equal(finishedNewSessionHeartbeatRun?.hasPersistedSession, false);
  assert.equal(await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, newHeartbeatSessionId),
  }), undefined);
  assert.equal(await db.query.sessionChannelLinks.findFirst({
    where: eq(sessionChannelLinks.sessionId, newHeartbeatSessionId),
  }), undefined);
  assert.equal(agentResponsePushCalls.length, 2, 'a new-session no-op heartbeat must not emit a response push');
  */

  const busyJob = await createAutomationJob(
    {
      name: 'Busy Session Automation',
      prompt: 'Wait for the current session execution.',
      preferredSkill: 'auto',
      workspaceContextPaths: [],
      targetOutputPath: null,
      agentId,
      deliveryMode: 'web',
      deliverySessionMode: 'new_session',
      schedule: { kind: 'interval', every: 1, unit: 'hours', timeZone: 'UTC' },
    },
    userId,
  );
  const busyRun = await scheduleAutomationJobRun(busyJob.id, 'manual', now);
  assert.ok(busyRun);
  const runtimeCallsBeforeBusy = runtimeResolutionCalls.length;
  exclusiveMode = 'busy';
  await executeAutomationRun(busyRun.id);
  exclusiveMode = 'pass';
  const delayedBusyRun = await getAutomationRun(busyRun.id);
  assert.equal(delayedBusyRun?.status, 'retry_scheduled');
  assert.equal(delayedBusyRun?.attemptNumber, 2);
  assert.ok(delayedBusyRun?.startedAt, 'the run must be claimed before session reservation can schedule a retry');
  assert.equal(runtimeResolutionCalls.length, runtimeCallsBeforeBusy);

  const lostClaimJob = await createAutomationJob(
    {
      name: 'Lost Claim Automation',
      prompt: 'Do not execute after the run becomes terminal.',
      preferredSkill: 'auto',
      workspaceContextPaths: [],
      targetOutputPath: null,
      agentId,
      deliveryMode: 'web',
      deliverySessionMode: 'new_session',
      schedule: { kind: 'interval', every: 1, unit: 'hours', timeZone: 'UTC' },
    },
    userId,
  );
  const lostClaimRun = await scheduleAutomationJobRun(lostClaimJob.id, 'manual', now);
  assert.ok(lostClaimRun);
  const runtimeCallsBeforeLostClaim = runtimeResolutionCalls.length;
  beforeExclusivePreflight = async () => {
    await db.update(automationRuns)
      .set({ status: 'failed', errorMessage: 'stale claim test', finishedAt: new Date() })
      .where(eq(automationRuns.id, lostClaimRun.id));
  };
  await executeAutomationRun(lostClaimRun.id);
  assert.equal((await getAutomationRun(lostClaimRun.id))?.status, 'failed');
  assert.equal(runtimeResolutionCalls.length, runtimeCallsBeforeLostClaim);
  const lostClaimSessionId = `auto-${lostClaimRun.id.replace(/^run-/, '')}`;
  assert.equal(await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, lostClaimSessionId),
  }), undefined);

  const revokedWorkspaceJob = await createAutomationJob(
    {
      name: 'Revoked Workspace Automation',
      prompt: 'Do not execute with stale workspace permissions.',
      preferredSkill: 'auto',
      workspaceContextPaths: [],
      targetOutputPath: null,
      agentId,
      deliveryMode: 'web',
      deliverySessionMode: 'new_session',
      schedule: { kind: 'interval', every: 1, unit: 'hours', timeZone: 'UTC' },
    },
    userId,
  );
  const revokedWorkspaceRun = await scheduleAutomationJobRun(revokedWorkspaceJob.id, 'manual', now);
  assert.ok(revokedWorkspaceRun);
  const runtimeCallsBeforeRevocation = runtimeResolutionCalls.length;
  failWorkspaceResolutionAtCall = workspaceResolutionCalls + 2;
  await executeAutomationRun(revokedWorkspaceRun.id);
  failWorkspaceResolutionAtCall = null;
  const failedRevokedWorkspaceRun = await getAutomationRun(revokedWorkspaceRun.id);
  assert.equal(failedRevokedWorkspaceRun?.status, 'failed');
  assert.match(failedRevokedWorkspaceRun?.errorMessage || '', /permission was revoked/u);
  assert.equal(runtimeResolutionCalls.length, runtimeCallsBeforeRevocation);
  const revokedWorkspaceSessionId = `auto-${revokedWorkspaceRun.id.replace(/^run-/, '')}`;
  assert.equal(await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, revokedWorkspaceSessionId),
  }), undefined);

  const abortedCreateJob = await createAutomationJob(
    {
      name: 'Aborted Session Create Automation',
      prompt: 'Do not re-resolve a runtime after the deadline.',
      preferredSkill: 'auto',
      workspaceContextPaths: [],
      targetOutputPath: null,
      agentId,
      deliveryMode: 'web',
      deliverySessionMode: 'new_session',
      schedule: { kind: 'interval', every: 1, unit: 'hours', timeZone: 'UTC' },
    },
    userId,
  );
  const abortedCreateRun = await scheduleAutomationJobRun(abortedCreateJob.id, 'manual', now);
  assert.ok(abortedCreateRun);
  const runtimeCallsBeforeAbortedCreate = runtimeResolutionCalls.length;
  const loopCallsBeforeAbortedCreate = agentLoopStreamFns.length;
  abortDuringSessionCreate = true;
  await executeAutomationRun(abortedCreateRun.id);
  const failedAbortedCreateRun = await getAutomationRun(abortedCreateRun.id);
  assert.equal(failedAbortedCreateRun?.status, 'failed');
  assert.deepEqual(
    runtimeResolutionCalls.slice(runtimeCallsBeforeAbortedCreate).map((call) => call.kind),
    ['executable'],
  );
  assert.equal(agentLoopStreamFns.length, loopCallsBeforeAbortedCreate);
  const abortedCreateSessionId = `auto-${abortedCreateRun.id.replace(/^run-/, '')}`;
  assert.equal(await db.query.sessionChannelLinks.findFirst({
    where: eq(sessionChannelLinks.sessionId, abortedCreateSessionId),
  }), undefined);

  const timeoutJob = await createAutomationJob(
    {
      name: 'Non-quiescent Automation',
      prompt: 'Exercise session quarantine.',
      preferredSkill: 'auto',
      workspaceContextPaths: [],
      targetOutputPath: null,
      agentId,
      deliveryMode: 'web',
      deliverySessionMode: 'new_session',
      schedule: { kind: 'interval', every: 1, unit: 'hours', timeZone: 'UTC' },
    },
    userId,
  );
  const timeoutRun = await scheduleAutomationJobRun(timeoutJob.id, 'manual', now);
  assert.ok(timeoutRun);
  const quarantineCountBeforeTimeout = quarantinedSettlements.length;
  timeoutMode = 'non-quiescent';
  await executeAutomationRun(timeoutRun.id);
  timeoutMode = 'pass';
  const failedTimeoutRun = await getAutomationRun(timeoutRun.id);
  assert.equal(failedTimeoutRun?.status, 'failed');
  assert.equal(failedTimeoutRun?.attemptNumber, 1);
  assert.equal(failedTimeoutRun?.metadataJson?.loopQuiescent, false);
  assert.equal(quarantinedSettlements.length, quarantineCountBeforeTimeout + 1);
  assert.ok(releaseDetachedTimeoutOperation);
  releaseDetachedTimeoutOperation();
  await quarantinedSettlements.at(-1);

  agentLoopMode = 'empty-error';
  const failingJob = await createAutomationJob(
    {
      name: 'Failing Automation',
      prompt: 'Trigger an empty assistant error.',
      preferredSkill: 'auto',
      workspaceContextPaths: [],
      targetOutputPath: null,
      agentId,
      deliveryMode: 'web',
      deliverySessionMode: 'new_session',
      schedule: { kind: 'interval', every: 1, unit: 'hours', timeZone: 'UTC' },
    },
    userId,
  );
  const failingRun = await scheduleAutomationJobRun(failingJob.id, 'manual', now);
  assert.ok(failingRun);

  await executeAutomationRun(failingRun.id);

  const retriedRun = await getAutomationRun(failingRun.id);
  assert.equal(retriedRun?.status, 'retry_scheduled');
  assert.equal(retriedRun?.errorMessage, 'empty model failure');

  const failingSessionId = `auto-${failingRun.id.replace(/^run-/, '')}`;
  const failingSession = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, failingSessionId),
    columns: { id: true },
  });
  assert.ok(failingSession);

  const persistedMessages = await db.query.piMessages.findMany({
    where: eq(piMessages.piSessionDbId, failingSession.id),
    orderBy: [asc(piMessages.sequence)],
  });
  assert.equal(persistedMessages.filter((message) => message.role === 'user').length, 1);
  assert.ok(persistedMessages.some((message) => message.content.includes('Automation failed: empty model failure')));

  const runtimeCallsBeforeRetry = runtimeResolutionCalls.length;
  agentLoopMode = 'success';
  await executeAutomationRun(failingRun.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const completedRetry = await getAutomationRun(failingRun.id);
  assert.equal(completedRetry?.status, 'success');
  assert.deepEqual(
    runtimeResolutionCalls.slice(runtimeCallsBeforeRetry).map((call) => call.kind),
    ['pinned'],
  );
  const retrySessions = await db.query.piSessions.findMany({
    where: eq(piSessions.sessionId, failingSessionId),
  });
  assert.equal(retrySessions.length, 1);
  assert.notEqual(agentLoopStreamFns.at(-1), testStreamFn, 'each automation run must use an output-capped stream');
  assert.equal(agentResponsePushCalls.length, 2, 'a successful retry must emit one unread-aware response push');

  const scheduledSuccessJob = await createAutomationJob(
    {
      name: 'Scheduled Success',
      prompt: 'Complete the scheduled work.',
      preferredSkill: 'auto',
      workspaceContextPaths: [],
      targetOutputPath: null,
      agentId,
      deliveryMode: 'web',
      deliverySessionMode: 'new_session',
      schedule: { kind: 'interval', every: 1, unit: 'hours', timeZone: 'UTC' },
    },
    userId,
  );
  const scheduledSuccessRun = await scheduleAutomationJobRun(scheduledSuccessJob.id, 'scheduled', now);
  assert.ok(scheduledSuccessRun);
  const responsePushesBeforeScheduledSuccess = agentResponsePushCalls.length;
  await executeAutomationRun(scheduledSuccessRun.id);
  assert.equal((await getAutomationRun(scheduledSuccessRun.id))?.status, 'success');
  assert.equal(agentResponsePushCalls.length, responsePushesBeforeScheduledSuccess);
  assert.deepEqual(automationStatusPushCalls.at(-1), {
    userId,
    workspaceId: scheduledSuccessJob.workspaceId,
    runId: scheduledSuccessRun.id,
    jobName: scheduledSuccessJob.name,
    status: 'success',
  });

  const scheduledNoActionJob = await createAutomationJob(
    {
      name: 'Scheduled No Action',
      prompt: 'Only report an important update.',
      preferredSkill: 'auto',
      workspaceContextPaths: [],
      targetOutputPath: null,
      agentId,
      deliveryMode: 'web',
      deliverySessionMode: 'new_session',
      resultPolicy: 'deliver_relevant_only',
      schedule: { kind: 'interval', every: 1, unit: 'hours', timeZone: 'UTC' },
    },
    userId,
  );
  const scheduledNoActionRun = await scheduleAutomationJobRun(scheduledNoActionJob.id, 'scheduled', now);
  assert.ok(scheduledNoActionRun);
  const statusPushesBeforeScheduledNoAction = automationStatusPushCalls.length;
  const responsePushesBeforeScheduledNoAction = agentResponsePushCalls.length;
  agentLoopMode = 'no-action';
  await executeAutomationRun(scheduledNoActionRun.id);
  agentLoopMode = 'success';
  const finishedScheduledNoActionRun = await getAutomationRun(scheduledNoActionRun.id);
  assert.equal(finishedScheduledNoActionRun?.status, 'success');
  assert.equal(finishedScheduledNoActionRun?.resultText, 'Automation completed without relevant updates.');
  assert.deepEqual(finishedScheduledNoActionRun?.metadataJson?.automation, {
    outcome: 'no_action',
    acknowledgement: 'NO_ACTION',
    deliverySuppressed: true,
    resultPolicy: 'deliver_relevant_only',
  });
  assert.deepEqual((finishedScheduledNoActionRun?.metadataJson?.delivery as Record<string, unknown>)?.dispatch, {
    attempted: false,
    delivered: false,
    skippedReason: 'no_action',
    error: null,
  });
  assert.equal(agentResponsePushCalls.length, responsePushesBeforeScheduledNoAction);
  assert.equal(automationStatusPushCalls.length, statusPushesBeforeScheduledNoAction);

  const scheduledFailureJob = await createAutomationJob(
    {
      name: 'Scheduled Failure',
      prompt: 'Fail after all scheduled retries.',
      preferredSkill: 'auto',
      workspaceContextPaths: [],
      targetOutputPath: null,
      agentId,
      deliveryMode: 'web',
      deliverySessionMode: 'new_session',
      schedule: { kind: 'interval', every: 1, unit: 'hours', timeZone: 'UTC' },
    },
    userId,
  );
  const scheduledFailureRun = await scheduleAutomationJobRun(scheduledFailureJob.id, 'scheduled', now);
  assert.ok(scheduledFailureRun);
  const statusPushesBeforeScheduledFailure = automationStatusPushCalls.length;
  const failurePushesBeforeScheduledFailure = failurePushCalls.length;
  agentLoopMode = 'empty-error';
  await executeAutomationRun(scheduledFailureRun.id);
  assert.equal((await getAutomationRun(scheduledFailureRun.id))?.status, 'retry_scheduled');
  assert.equal(automationStatusPushCalls.length, statusPushesBeforeScheduledFailure);
  await executeAutomationRun(scheduledFailureRun.id);
  assert.equal((await getAutomationRun(scheduledFailureRun.id))?.status, 'retry_scheduled');
  assert.equal(automationStatusPushCalls.length, statusPushesBeforeScheduledFailure);
  await executeAutomationRun(scheduledFailureRun.id);
  agentLoopMode = 'success';
  assert.equal((await getAutomationRun(scheduledFailureRun.id))?.status, 'failed');
  assert.equal(failurePushCalls.length, failurePushesBeforeScheduledFailure);
  assert.deepEqual(automationStatusPushCalls.slice(statusPushesBeforeScheduledFailure), [{
    userId,
    workspaceId: scheduledFailureJob.workspaceId,
    runId: scheduledFailureRun.id,
    jobName: scheduledFailureJob.name,
    status: 'failed',
  }]);

  const organization = await db.query.canvasOrganizationSettings.findFirst();
  assert.ok(organization);
  const existingDefaults = await db.query.aiRuntimeDefaults.findFirst({
    where: eq(aiRuntimeDefaults.organizationId, organization.organizationId),
  });
  if (existingDefaults) {
    await db.update(aiRuntimeDefaults)
      .set({ catalogRevision: 1, updatedAt: now })
      .where(eq(aiRuntimeDefaults.organizationId, organization.organizationId));
  } else {
    await db.insert(aiRuntimeDefaults).values({
      organizationId: organization.organizationId,
      catalogRevision: 1,
      migrationState: 'configured',
      createdAt: now,
      updatedAt: now,
    });
  }

  const conflictJob = await createAutomationJob(
    {
      name: 'Runtime Conflict Automation',
      prompt: 'Do not create an unpinned session.',
      preferredSkill: 'auto',
      workspaceContextPaths: [],
      targetOutputPath: null,
      agentId,
      deliveryMode: 'web',
      deliverySessionMode: 'new_session',
      schedule: { kind: 'interval', every: 1, unit: 'hours', timeZone: 'UTC' },
    },
    userId,
  );
  const conflictRun = await scheduleAutomationJobRun(conflictJob.id, 'manual', now);
  assert.ok(conflictRun);
  const agentLoopCallsBeforeConflict = agentLoopStreamFns.length;
  await executeAutomationRun(conflictRun.id);
  const conflictedRun = await getAutomationRun(conflictRun.id);
  assert.equal(conflictedRun?.status, 'retry_scheduled');
  assert.match(conflictedRun?.errorMessage || '', /catalog or workspace policy changed/u);
  const conflictSessionId = `auto-${conflictRun.id.replace(/^run-/, '')}`;
  const conflictSession = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, conflictSessionId),
  });
  assert.equal(conflictSession, undefined);
  const conflictLink = await db.query.sessionChannelLinks.findFirst({
    where: eq(sessionChannelLinks.sessionId, conflictSessionId),
  });
  assert.equal(conflictLink, undefined);
  assert.equal(agentLoopStreamFns.length, agentLoopCallsBeforeConflict);

  console.log('automation-runner-tool-context-test: ok');
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
