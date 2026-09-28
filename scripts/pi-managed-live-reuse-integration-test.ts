import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { Type } from 'typebox';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import { createPiTestDatabase } from './helpers/pi-test-database';

const model: Model<'openai-completions'> = {
  id: 'managed-reuse-fixture', name: 'Managed Reuse Fixture', api: 'openai-completions',
  provider: 'fixture', baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 1_024,
};

function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content, stopReason, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function completedStream(message: AssistantMessage): Awaited<ReturnType<StreamFn>> {
  return {
    async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; },
    result: async () => message,
  } as unknown as Awaited<ReturnType<StreamFn>>;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pi-managed-live-reuse-'));
  process.env.DATA = root;
  process.env.CANVAS_DATA_ROOT = root;
  const database = await createPiTestDatabase();
  // The SDK publishes an ESM-only entrypoint; the project test runner loads
  // TypeScript through CommonJS. Keep the SDK real while bridging that edge.
  const sdk = await (new Function('return import("@earendil-works/pi-agent-core")')() as Promise<
    typeof import('@earendil-works/pi-agent-core')
  >);
  const piAi = await (new Function('return import("@earendil-works/pi-ai")')() as Promise<
    typeof import('@earendil-works/pi-ai')
  >);
  const modules = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = modules._load;
  const browserSnapshot = {
    revision: 0, running: false, controlMode: 'agent', interactionPolicy: 'exclusive',
    interactionRevision: 0, lastUserInteractionAt: null, activeTabId: null, activeTitle: null,
    activeUrl: null, tabCount: 0, tabs: [], hasPendingDialog: false,
  };
  const executionContext = {
    organizationId: 'managed-org', userId: 'owner', sessionId: 'child', workspaceId: 'managed-workspace',
    agentId: 'research-agent', workspaceType: 'personal' as const, workspaceName: null,
    workspaceDescription: null, customerId: null, projectId: null, workspaceRoot: root,
    workspaceRootRelativePath: null, skillReadRoots: [], canWrite: false, canDelete: false,
    canShare: false, legacy: false, brandContext: null,
  };
  let activeToolsets: () => Promise<string[]> = async () => [];
  let sendCorrectionDuringFirstTool: () => Promise<void> = async () => undefined;
  let correctionReceiptId: string | null = null;
  const executedTools: string[] = [];
  const tool = (name: string): AgentTool => ({
    name, label: name, description: `Fixture ${name}`, parameters: Type.Object({}),
    execute: async () => {
      executedTools.push(name);
      if (name === 'first') await sendCorrectionDuringFirstTool();
      return { content: [{ type: 'text', text: `${name} result` }], details: {} };
    },
  });
  const modelContexts: Array<{ roles: string[]; text: string; toolNames: string[] }> = [];
  let liveRuntime: { dispose: () => void } | null = null;
  let streamCall = 0;
  const streamFn: StreamFn = async (_selectedModel, context) => {
    streamCall += 1;
    const text = JSON.stringify(context.messages);
    modelContexts.push({ roles: context.messages.map(message => message.role), text,
      toolNames: context.tools?.map(item => item.name) ?? [] });
    if (streamCall === 1) {
      assert.ok(context.tools?.some(item => item.name === 'first'));
      assert.ok(!context.tools?.some(item => item.name === 'second'));
      return completedStream(assistant([{ type: 'toolCall', id: 'tool-first', name: 'first', arguments: {} }], 'toolUse'));
    }
    if (streamCall === 2) {
      assert.match(text, /Also check the source notes\./u,
        'the accepted mid-tool correction reaches the next model request');
      return completedStream(assistant([{ type: 'text', text: 'First answer.' }], 'stop'));
    }
    if (streamCall === 3) {
      assert.match(text, /First answer\./u, 'the second managed run keeps the first persisted answer');
      assert.match(text, /first result/u, 'the second managed run keeps the first tool result');
      assert.ok(context.tools?.some(item => item.name === 'second'));
      assert.ok(!context.tools?.some(item => item.name === 'first'));
      return completedStream(assistant([{ type: 'toolCall', id: 'tool-second', name: 'second', arguments: {} }], 'toolUse'));
    }
    assert.equal(streamCall, 4);
    return completedStream(assistant([{ type: 'text', text: 'Second answer.' }], 'stop'));
  };

  modules._load = function loadWithMocks(request, parent, isMain) {
    if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return database;
    if (request === 'server-only') return {};
    if ((request.startsWith('.') || request.startsWith('@/')) && request.endsWith('/auth')) return { auth: {} };
    if (request === '@/app/lib/agents/access') return { requireAgentAccess: async () => undefined };
    if (request === '@earendil-works/pi-agent-core') return sdk;
    if (request === '@earendil-works/pi-ai') return piAi;
    if (request === '@earendil-works/pi-ai/compat') return {
      getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined,
    };
    if (request === '@/app/lib/pi/session-workspace-context') return {
      resolveAgentExecutionContextForSession: async ({ sessionId }: { sessionId: string }) => ({ ...executionContext, sessionId }),
      resolveAgentSessionWorkspaceForUser: async () => ({
        workspaceId: 'managed-workspace', workspaceType: 'personal', organizationId: 'managed-org',
      }),
    };
    if (request === '@/app/lib/agent-runtime-policy/provider-runtime') return {
      resolveAndPinSessionRuntime: async () => ({
        model, streamFn, selection: { selection: { providerId: model.provider, thinkingLevel: 'off' } },
        requiresRecreation: () => false,
      }),
      resolveCompactionSummaryRuntime: async () => null,
    };
    if (request === '@/app/lib/pi/system-prompt-snapshot') return {
      ensurePiSessionSystemPromptSnapshot: async () => ({ systemPrompt: 'You are a fixture worker.' }),
      createPiSystemPromptSnapshot: async () => ({ systemPrompt: 'You are a fixture worker.' }),
    };
    if (request === '@/app/lib/pi/browser/session-state-service') return {
      refreshBrowserSessionSnapshot: async () => browserSnapshot,
    };
    if (request === '@/app/lib/pi/browser/session-state') return {
      subscribeBrowserSessionSnapshot: () => () => undefined,
    };
    if (request === '@/app/lib/pi/browser/runtime') return {
      getBrowserRuntimeContextKey: () => 'fixture-browser',
    };
    if (request === '@/app/lib/pi/tool-registry') return {
      getPiTools: async () => {
        const allowed = await activeToolsets();
        return [
          ...(allowed.includes('file') ? [tool('first')] : []),
          ...(allowed.includes('web') ? [tool('second')] : []),
        ];
      },
    };
    if (request === '@/app/lib/agents/workspace-file-tree-context') return {
      buildWorkspaceFileTreePrompt: async () => ({ promptBlock: '' }),
    };
    if (request === '@/app/lib/memory/prompt-projection') return {
      buildMemoryPromptProjection: async () => '',
    };
    if (request === '@/app/lib/pi/compaction/runtime-policy') return {
      loadPiEffectiveCompactionPolicy: async () => ({
        contextBudgetPolicy: (originalLoad.call(modules, '@/app/lib/pi/context-budget', parent, isMain) as
          typeof import('../app/lib/pi/context-budget')).DEFAULT_PI_CONTEXT_BUDGET_POLICY,
        summaryModel: null, sources: { tailMode: 'default', summaryModel: 'default' },
      }),
    };
    if (request === '@/app/lib/pi/usage-events') return {
      loadLatestPiSessionInputUsage: async () => null,
      persistPiUsageEvents: async () => undefined,
    };
    if (request === '@/app/lib/pi/runtime-event-emitter' || request.endsWith('/runtime-event-emitter')) return {
      getPiRuntimeEventEmitter: () => ({ emitEvent: () => undefined }),
    };
    if (request === '@/app/lib/memory/service') return { scheduleMemoryReviewForSession: async () => ({ scheduled: false }) };
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { db } = database;
    const { user, piSessions, piMessages, piDelegationProgress, piDelegationSteering } = await import('../app/lib/db/schema');
    const { createPiDelegation, claimQueuedPiDelegation, completeRunningPiDelegation } =
      await import('../app/lib/pi/delegation-store');
    const { getDelegatedWorkerToolsets } = await import('../app/lib/pi/delegation-policy');
    const { attachManagedProgressBridge } = await import('../app/lib/pi/delegation-managed-progress');
    const { attachManagedSteeringBridge } = await import('../app/lib/pi/delegation-managed-steering');
    const { acceptPiDelegationSteering } = await import('../app/lib/pi/delegation-steering');
    activeToolsets = () => getDelegatedWorkerToolsets({ userId: 'owner', sessionId: 'child' }).then(value => value ?? []);
    const { getOrCreatePiRuntimeWithState, invalidatePiRuntime } = await import('../app/lib/pi/live-runtime');
    const { loadPiSession } = await import('../app/lib/pi/session-store');
    const now = new Date();
    await db.insert(user).values({ id: 'owner', name: 'Owner', email: 'managed-live@example.test',
      emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(piSessions).values([
      { sessionId: 'parent', userId: 'owner', agentId: 'bradley', provider: model.provider, model: model.id,
        sessionKind: 'conversation', delegationDepth: 0, organizationId: 'managed-org',
        workspaceId: 'managed-workspace', workspaceType: 'personal', createdAt: now, updatedAt: now },
      { sessionId: 'child', userId: 'owner', agentId: 'research-agent', provider: model.provider, model: model.id,
        sessionKind: 'delegation_worker', delegationDepth: 1, parentSessionId: 'parent', delegationId: 'first-task',
        organizationId: 'managed-org', workspaceId: 'managed-workspace', workspaceType: 'personal',
        createdAt: now, updatedAt: now },
    ]);
    await createPiDelegation({ id: 'first-task', userId: 'owner', sourceSessionId: 'parent',
      sourceAgentId: 'bradley', targetAgentId: 'research-agent', workerSessionId: 'child',
      workerType: 'managed', goal: 'First managed task', toolsets: ['file'] });
    await claimQueuedPiDelegation('first-task', 'first-worker');
    assert.deepEqual(await activeToolsets(), ['file']);

    const { runtime: firstRuntime, created } = await getOrCreatePiRuntimeWithState('child', 'owner');
    let runtime = firstRuntime;
    liveRuntime = runtime;
    assert.equal(created, true);
    assert.ok(runtime instanceof (await import('../app/lib/pi/live-runtime')).LivePiRuntime);
    sendCorrectionDuringFirstTool = async () => {
      const accepted = await acceptPiDelegationSteering({
        delegationId: 'first-task', userId: 'owner', sourceSessionId: 'parent',
        idempotencyKey: 'mid-tool-correction', message: 'Also check the source notes.',
      });
      correctionReceiptId = accepted.id;
      assert.equal(accepted.status, 'accepted');
      const deadline = Date.now() + 3_000;
      while (!runtime.getStatus().steeringQueue.some(entry => entry.clientMessageId === accepted.id)) {
        if (Date.now() >= deadline) throw new Error('Managed steering bridge did not queue the correction during the tool.');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    const startAndWait = async (prompt: string) => {
      const completion = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          reject(new Error(`Runtime did not become idle: ${JSON.stringify({
            status: runtime.getStatus(), messages: runtime.agent.state.messages,
          })}`));
        }, 5_000);
        const unsubscribe = runtime.subscribe(event => {
          if (event.type === 'error') { clearTimeout(timeout); unsubscribe(); reject(new Error(event.error)); }
          if (event.type === 'runtime_status' && event.status.phase === 'idle' && !event.status.canAbort) {
            clearTimeout(timeout); unsubscribe(); resolve();
          }
        });
      });
      runtime.startPrompt({ role: 'user', content: prompt, timestamp: Date.now() });
      await completion;
    };
    const progressRequest = (delegationId: string) => ({ delegationId, userId: 'owner' }) as
      Parameters<typeof attachManagedProgressBridge>[1];
    const progressFor = async (delegationId: string) => (await db.select().from(piDelegationProgress)
      .where(eq(piDelegationProgress.delegationId, delegationId)))
      .filter(event => event.kind === 'tool_start' || event.kind === 'tool_end');
    const releaseFirstProgress = attachManagedProgressBridge(runtime, progressRequest('first-task'));
    const releaseFirstSteering = attachManagedSteeringBridge(runtime, {
      ...progressRequest('first-task'), sourceAgentId: 'bradley', sourceSessionId: 'parent',
      targetAgentId: 'research-agent', runOwnerId: 'first-worker', goal: 'First managed task',
      toolsets: ['file'], waitForResult: true, timeoutSeconds: 60,
    }, 'child');
    await startAndWait('First managed task');
    await releaseFirstSteering();
    await releaseFirstProgress();
    assert.ok(correctionReceiptId);
    const receipt = await db.query.piDelegationSteering.findFirst({
      where: eq(piDelegationSteering.id, correctionReceiptId),
    });
    assert.equal(receipt?.status, 'delivered');
    assert.deepEqual((await progressFor('first-task')).map(event => [event.kind, event.preview]),
      [['tool_start', 'first'], ['tool_end', 'first']]);
    const firstHistory = await loadPiSession('child', 'owner', 'research-agent');
    assert.deepEqual(firstHistory?.map(message => message.role), ['user', 'assistant', 'toolResult', 'user', 'assistant']);
    assert.equal((await db.select().from(piMessages)).length, 5);
    assert.deepEqual(executedTools, ['first']);

    await completeRunningPiDelegation({ id: 'first-task', resultStatus: 'ok', resultText: 'First answer.' });
    assert.deepEqual(await activeToolsets(), []);
    await createPiDelegation({ id: 'second-task', userId: 'owner', sourceSessionId: 'parent',
      sourceAgentId: 'bradley', targetAgentId: 'research-agent', workerSessionId: 'child',
      requestedSessionId: 'child', workerType: 'managed', goal: 'Second managed task', toolsets: ['web'] });
    await claimQueuedPiDelegation('second-task', 'second-worker');
    assert.deepEqual(await activeToolsets(), ['web']);
    await runtime.reloadTools();
    assert.deepEqual(runtime.agent.state.tools.map(item => item.name), ['second'],
      'a cached managed runtime drops the prior task toolset on reload');
    const cached = await getOrCreatePiRuntimeWithState('child', 'owner');
    assert.equal(cached.runtime, runtime);
    assert.equal(cached.created, false);
    assert.equal(await invalidatePiRuntime('child', 'owner'), true);
    const restored = await getOrCreatePiRuntimeWithState('child', 'owner');
    assert.equal(restored.created, true);
    assert.notEqual(restored.runtime, firstRuntime);
    runtime = restored.runtime;
    liveRuntime = runtime;
    assert.equal(runtime.agent.state.messages.length, 5, 'a fresh runtime loads the stored first task');
    assert.deepEqual(runtime.agent.state.tools.map(item => item.name), ['second']);
    const releaseSecondProgress = attachManagedProgressBridge(runtime, progressRequest('second-task'));
    await startAndWait('Second managed task with different tools');
    await releaseSecondProgress();
    assert.deepEqual((await progressFor('second-task')).map(event => [event.kind, event.preview]),
      [['tool_start', 'second'], ['tool_end', 'second']]);
    assert.deepEqual((await progressFor('first-task')).map(event => event.preview), ['first', 'first'],
      'the second run cannot append progress to the first delegation');
    const secondHistory = await loadPiSession('child', 'owner', 'research-agent');
    assert.deepEqual(secondHistory?.map(message => message.role), [
      'user', 'assistant', 'toolResult', 'user', 'assistant', 'user', 'assistant', 'toolResult', 'assistant',
    ]);
    assert.equal((await db.select().from(piMessages)).length, 9);
    assert.deepEqual(executedTools, ['first', 'second']);
    assert.equal(modelContexts.length, 4);
    assert.deepEqual(modelContexts[2].toolNames, ['second']);
    assert.match(modelContexts[2].text, /First managed task/u);
    assert.match(modelContexts[2].text, /First answer\./u);
    await completeRunningPiDelegation({ id: 'second-task', resultStatus: 'ok', resultText: 'Second answer.' });
    assert.deepEqual(await activeToolsets(), []);
    runtime.dispose();
    console.log('pi-managed-live-reuse-integration-test: ok');
  } finally {
    liveRuntime?.dispose();
    modules._load = originalLoad;
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
