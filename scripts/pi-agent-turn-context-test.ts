import assert from 'node:assert/strict';
import Module from 'node:module';

import type { AgentTool } from '@earendil-works/pi-agent-core';

process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
process.env.BETTER_AUTH_BASE_URL ??= 'http://localhost:3000';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';

const modules = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = modules._load;
modules._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@earendil-works/pi-agent-core') return { Agent: class Agent {} };
  if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') return {
    getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined,
  };
  if (request === '@/app/lib/pi/tool-output-maintenance') return {
    maybeCleanupToolOutputOrphans: async () => undefined,
  };
  return originalLoad(request, parent, isMain);
};

async function main() {
  const [{ LivePiRuntime }, { wrapToolWithExecutionContext }, { getAgentExecutionContext },
    { createRuntimeContinuationMessage }] = await Promise.all([
    import('../app/lib/pi/live-runtime'),
    import('../app/lib/pi/tool-runtime-helpers'),
    import('../app/lib/pi/agent-execution-context'),
    import('../app/lib/pi/custom-messages'),
  ]);
  const context = {
    userId: 'turn-user', sessionId: 'turn-session', agentId: null,
    workspaceId: 'turn-workspace', workspaceType: 'personal' as const,
    workspaceName: null, organizationId: null, customerId: null, projectId: null,
    workspaceRoot: '/tmp/turn-workspace', workspaceRootRelativePath: null,
    canWrite: true, canDelete: false, canShare: false, legacy: false,
    agentTurnId: undefined as string | undefined,
  };
  const runtime = Object.create(LivePiRuntime.prototype) as InstanceType<typeof LivePiRuntime> & Record<string, unknown>;
  const agent = { state: { tools: [] as AgentTool[], systemPrompt: '' }, prompt: async () => undefined };
  Object.assign(runtime, {
    sessionId: context.sessionId,
    executionContext: context,
    agent,
    options: { resetToolLoopGuard: () => undefined },
    model: { id: 'test-model' },
    messageQueues: { consume: () => undefined },
    rememberMessageContext: () => undefined,
    maybeCreateInitialToolTailContinuation: () => null,
    touch: () => undefined,
    invalidateContextBudget: () => undefined,
    publishStatus: () => undefined,
    getEffectiveTools: () => [],
    getEffectiveSystemPrompt: () => '',
  });

  const first = { role: 'user' as const, content: 'Edit the document', timestamp: 100,
    clientMessageId: 'first-message' };
  runtime.startPrompt(first);
  const firstTurnId = context.agentTurnId;
  assert.match(firstTurnId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  await runtime.onAgentEvent({ type: 'message_start', message: first });
  assert.equal(context.agentTurnId, firstTurnId, 'the first message event must retain the ID assigned at dispatch');
  await runtime.onAgentEvent({ type: 'message_start', message: createRuntimeContinuationMessage('intermediate_ack', 'Continue', 101) });
  assert.equal(context.agentTurnId, firstTurnId, 'synthetic continuation must retain the user turn ID');

  const second = { role: 'user' as const, content: 'Also fix the heading', timestamp: 102,
    clientMessageId: 'follow-up-message' };
  await runtime.onAgentEvent({ type: 'message_start', message: second });
  const secondTurnId = context.agentTurnId;
  assert.ok(secondTurnId && secondTurnId !== firstTurnId, 'a queued follow-up starts a new turn');

  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const observed: Array<string | undefined> = [];
  const probe = wrapToolWithExecutionContext({
    name: 'turn_probe', label: 'Turn probe', description: '', parameters: { type: 'object' } as AgentTool['parameters'],
    execute: async () => {
      observed.push(getAgentExecutionContext()?.agentTurnId);
      started();
      await gate;
      observed.push(getAgentExecutionContext()?.agentTurnId);
      return { content: [{ type: 'text', text: 'ok' }], details: {} };
    },
  }, context);
  const inFlight = probe.execute('probe-1', {});
  await startedPromise;
  const third = { role: 'user' as const, content: 'Start another task', timestamp: 103,
    clientMessageId: 'third-message' };
  await runtime.onAgentEvent({ type: 'message_start', message: third });
  assert.notEqual(context.agentTurnId, secondTurnId);
  release();
  await inFlight;
  assert.deepEqual(observed, [secondTurnId, secondTurnId],
    'a running tool keeps the turn identity captured at invocation');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
