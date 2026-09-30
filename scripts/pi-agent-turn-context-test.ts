import assert from 'node:assert/strict';
import Module from 'node:module';

import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';

process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
process.env.BETTER_AUTH_BASE_URL ??= 'http://localhost:3000';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';

const modules = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = modules._load;
const historyOperations: Array<{ kind: 'begin' | 'touch' | 'finish'; turnId: string; outcome?: string }> = [];
const savedEvents: unknown[] = [];
modules._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@earendil-works/pi-agent-core') return { Agent: class Agent {} };
  if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') return {
    getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined,
  };
  if (request === '@/app/lib/pi/tool-output-maintenance') return {
    maybeCleanupToolOutputOrphans: async () => undefined,
  };
  if (request === '@/app/lib/file-version-center/agent-turn-history') return {
    agentTurnHistoryService: {
      begin: async ({ turnId }: { turnId: string }) => { historyOperations.push({ kind: 'begin', turnId }); },
      touch: async ({ turnId }: { turnId: string }) => { historyOperations.push({ kind: 'touch', turnId }); },
      finish: async ({ turnId }: { turnId: string }, outcome: string) => {
        historyOperations.push({ kind: 'finish', turnId, outcome });
      },
    },
  };
  return originalLoad(request, parent, isMain);
};

async function main() {
  const [{ LivePiRuntime }, { wrapToolWithExecutionContext }, { getAgentExecutionContext },
    { createRuntimeContinuationMessage }, { getPiRuntimeEventEmitter }] = await Promise.all([
    import('../app/lib/pi/live-runtime'),
    import('../app/lib/pi/tool-runtime-helpers'),
    import('../app/lib/pi/agent-execution-context'),
    import('../app/lib/pi/custom-messages'),
    import('../app/lib/pi/runtime-event-emitter'),
  ]);
  getPiRuntimeEventEmitter().onAgentEvent(({ event }) => {
    if (event.type === 'message_saved') savedEvents.push(event);
  });
  const context = {
    userId: 'turn-user', sessionId: 'turn-session', agentId: null,
    workspaceId: 'turn-workspace', workspaceType: 'personal' as const,
    workspaceName: null, organizationId: null, customerId: null, projectId: null,
    workspaceRoot: '/tmp/turn-workspace', workspaceRootRelativePath: null,
    canWrite: true, canDelete: false, canShare: false, legacy: false,
    agentTurnId: undefined as string | undefined,
  };
  const runtime = Object.create(LivePiRuntime.prototype) as InstanceType<typeof LivePiRuntime> & Record<string, unknown>;
  let promptStarts = 0;
  const publishedErrors: unknown[] = [];
  const agent = {
    state: { tools: [] as AgentTool[], systemPrompt: '', pendingToolCalls: new Set<string>(), messages: [] as AgentMessage[] },
    prompt: async () => { promptStarts += 1; },
  };
  Object.assign(runtime, {
    sessionId: context.sessionId,
    userId: context.userId,
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
    publishError: (error: unknown) => { publishedErrors.push(error); },
    getEffectiveTools: () => [],
    getEffectiveSystemPrompt: () => '',
    persistMessages: async () => 0,
    scheduleIdleCompaction: () => undefined,
    agentTurnTransition: Promise.resolve(),
    activeAgentTurn: null,
    pendingAgentTurnTouch: null,
    pendingReplace: null,
    abortRequested: false,
    activeTool: null,
  });

  const first = { role: 'user' as const, content: 'Edit the document', timestamp: 100,
    clientMessageId: 'first-message' };
  runtime.startPrompt(first);
  const firstTurnId = context.agentTurnId;
  assert.match(firstTurnId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(promptStarts, 0, 'the agent waits for a persisted turn before starting');
  await (runtime as unknown as { agentTurnTransition: Promise<void> }).agentTurnTransition;
  await Promise.resolve();
  assert.equal(promptStarts, 1);
  await runtime.onAgentEvent({ type: 'message_start', message: first });
  assert.equal(context.agentTurnId, firstTurnId, 'the first message event must retain the ID assigned at dispatch');
  assert.deepEqual(historyOperations, [{ kind: 'begin', turnId: firstTurnId }],
    'the first prompt must have a durable turn before it reaches the agent');
  await runtime.onAgentEvent({ type: 'message_start', message: createRuntimeContinuationMessage('intermediate_ack', 'Continue', 101) });
  assert.equal(context.agentTurnId, firstTurnId, 'synthetic continuation must retain the user turn ID');
  assert.equal(historyOperations.length, 1, 'synthetic continuation must not create a second turn');

  const second = { role: 'user' as const, content: 'Also fix the heading', timestamp: 102,
    clientMessageId: 'follow-up-message' };
  await runtime.onAgentEvent({ type: 'message_start', message: second });
  const secondTurnId = context.agentTurnId;
  assert.ok(secondTurnId && secondTurnId !== firstTurnId, 'a queued follow-up starts a new turn');
  assert.deepEqual(historyOperations.slice(-2), [
    { kind: 'finish', turnId: firstTurnId, outcome: 'interrupted' },
    { kind: 'begin', turnId: secondTurnId },
  ], 'a new user message closes the previous turn before opening its own');

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
  agent.state.pendingToolCalls.add('probe-1');
  const third = { role: 'user' as const, content: 'Start another task', timestamp: 103,
    clientMessageId: 'third-message' };
  await runtime.onAgentEvent({ type: 'message_start', message: third });
  assert.notEqual(context.agentTurnId, secondTurnId);
  release();
  await inFlight;
  agent.state.pendingToolCalls.delete('probe-1');
  assert.deepEqual(observed, [secondTurnId, secondTurnId],
    'a running tool keeps the turn identity captured at invocation');
  assert.deepEqual(historyOperations.at(-1), { kind: 'begin', turnId: context.agentTurnId });
  assert.equal(historyOperations.some((operation) => operation.kind === 'finish' && operation.turnId === secondTurnId), false,
    'a turn with an in-flight tool must remain open for lease recovery');

  const thirdTurnId = context.agentTurnId!;
  const terminalEvent = (stopReason: string): AgentEvent => ({
    type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason }],
  } as unknown as AgentEvent);
  agent.state.messages.push({ role: 'assistant', content: [], stopReason: 'stop' } as unknown as AgentMessage);
  await runtime.onAgentEvent(terminalEvent('stop'));
  assert.deepEqual(historyOperations.at(-1), { kind: 'finish', turnId: thirdTurnId, outcome: 'completed' });
  assert.equal(savedEvents.filter((event) => (event as { type?: string }).type === 'message_saved').length, 1);
  agent.state.messages.length = 0;

  const fourth = { role: 'user' as const, content: 'Check error handling', timestamp: 104,
    clientMessageId: 'fourth-message' };
  runtime.startPrompt(fourth);
  await (runtime as unknown as { agentTurnTransition: Promise<void> }).agentTurnTransition;
  const fourthTurnId = context.agentTurnId!;
  await runtime.onAgentEvent(terminalEvent('error'));
  assert.deepEqual(historyOperations.at(-1), { kind: 'finish', turnId: fourthTurnId, outcome: 'failed' });

  const fifth = { role: 'user' as const, content: 'Check cancellation', timestamp: 105,
    clientMessageId: 'fifth-message' };
  runtime.startPrompt(fifth);
  await (runtime as unknown as { agentTurnTransition: Promise<void> }).agentTurnTransition;
  const fifthTurnId = context.agentTurnId!;
  Object.assign(runtime, { abortRequested: true });
  await runtime.onAgentEvent(terminalEvent('aborted'));
  assert.deepEqual(historyOperations.at(-1), { kind: 'finish', turnId: fifthTurnId, outcome: 'cancelled' });

  const sixth = { role: 'user' as const, content: 'Check incomplete tool', timestamp: 106,
    clientMessageId: 'sixth-message' };
  runtime.startPrompt(sixth);
  await (runtime as unknown as { agentTurnTransition: Promise<void> }).agentTurnTransition;
  const sixthTurnId = context.agentTurnId!;
  agent.state.pendingToolCalls.add('unfinished-tool');
  agent.state.messages.push({ role: 'assistant', content: [], stopReason: 'stop' } as unknown as AgentMessage);
  await runtime.onAgentEvent(terminalEvent('stop'));
  assert.equal(historyOperations.some((operation) => operation.kind === 'finish' && operation.turnId === sixthTurnId), false,
    'agent_end must leave a turn open while a tool can still write');
  assert.equal(savedEvents.filter((event) => (event as { type?: string }).type === 'message_saved').length, 1,
    'an incomplete turn must not emit message_saved');
  agent.state.pendingToolCalls.delete('unfinished-tool');
  agent.state.messages.length = 0;

  const seventh = { role: 'user' as const, content: 'Check error while tool runs', timestamp: 107,
    clientMessageId: 'seventh-message' };
  runtime.startPrompt(seventh);
  await (runtime as unknown as { agentTurnTransition: Promise<void> }).agentTurnTransition;
  const seventhTurnId = context.agentTurnId!;
  agent.state.pendingToolCalls.add('error-tool');
  const internals = runtime as unknown as { activeAgentTurn: unknown; persistMessagesOnError: (turn: unknown) => Promise<void> };
  await internals.persistMessagesOnError(internals.activeAgentTurn);
  assert.equal(historyOperations.some((operation) => operation.kind === 'finish' && operation.turnId === seventhTurnId), false,
    'the error path must leave a turn open while a tool can still stage a snapshot');
  agent.state.pendingToolCalls.delete('error-tool');

  const eighth = { role: 'user' as const, content: 'Check active tool rotation', timestamp: 108,
    clientMessageId: 'eighth-message' };
  runtime.startPrompt(eighth);
  await (runtime as unknown as { agentTurnTransition: Promise<void> }).agentTurnTransition;
  const eighthTurnId = context.agentTurnId!;
  Object.assign(runtime, { activeTool: { toolCallId: 'active-tool', name: 'probe' } });
  const ninth = { role: 'user' as const, content: 'Next while active', timestamp: 109,
    clientMessageId: 'ninth-message' };
  await runtime.onAgentEvent({ type: 'message_start', message: ninth });
  assert.equal(historyOperations.some((operation) => operation.kind === 'finish' && operation.turnId === eighthTurnId), false,
    'an active tool also prevents premature finalization during turn rotation');
  Object.assign(runtime, { activeTool: null });
  await runtime.onAgentEvent(terminalEvent('stop'));

  let rejectLatePrompt!: (error: Error) => void;
  agent.prompt = async () => new Promise<void>((_resolve, reject) => { rejectLatePrompt = reject; });
  const tenth = { role: 'user' as const, content: 'Late failing prompt', timestamp: 110,
    clientMessageId: 'tenth-message' };
  runtime.startPrompt(tenth);
  await (runtime as unknown as { agentTurnTransition: Promise<void> }).agentTurnTransition;
  await Promise.resolve();
  const staleTurn = (runtime as unknown as { activeAgentTurn: unknown }).activeAgentTurn;
  agent.prompt = async () => undefined;
  const eleventh = { role: 'user' as const, content: 'Current prompt', timestamp: 111,
    clientMessageId: 'eleventh-message' };
  runtime.startPrompt(eleventh);
  await (runtime as unknown as { agentTurnTransition: Promise<void> }).agentTurnTransition;
  const current = runtime as unknown as {
    activeAgentTurn: { identity: { turnId: string } };
    agentTurnHeartbeatTimer: ReturnType<typeof setInterval>;
    isRunning: boolean;
    activeTool: { toolCallId: string } | null;
    persistMessagesOnError: (turn: unknown) => Promise<void>;
  };
  const currentTurnId = current.activeAgentTurn.identity.turnId;
  const currentHeartbeat = current.agentTurnHeartbeatTimer;
  Object.assign(runtime, { activeTool: { toolCallId: 'new-tool', name: 'probe' } });
  rejectLatePrompt(new Error('The previous prompt failed late'));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await current.persistMessagesOnError(staleTurn);
  assert.equal(current.isRunning, true, 'a stale error must not end the new prompt');
  assert.equal(current.activeTool?.toolCallId, 'new-tool', 'a stale error must not clear the new active tool');
  assert.equal(current.activeAgentTurn.identity.turnId, currentTurnId);
  assert.equal(current.agentTurnHeartbeatTimer, currentHeartbeat, 'a stale error must not stop the new heartbeat');
  assert.deepEqual(publishedErrors, [], 'a stale error must not appear as an error for the current prompt');
  Object.assign(runtime, { activeTool: null });
  await runtime.onAgentEvent(terminalEvent('stop'));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
