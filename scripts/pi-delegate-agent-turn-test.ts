import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentTurnIdentity } from '../app/lib/file-version-center/agent-turn-history';

type Operation = { kind: string; turnId?: string; outcome?: string };
type WorkerModule = typeof import('../app/lib/pi/delegate-task-tool');
type WorkerParams = Parameters<WorkerModule['runEphemeralWorker']>[0];
type Loop = (prompts: AgentMessage[], context: { tools: WorkerParams['tools'] }, config: unknown,
  emit: (event: AgentEvent) => Promise<void>, signal: AbortSignal) => Promise<AgentMessage[]>;

const require = createRequire(import.meta.url);
const filename = path.resolve('app/lib/pi/delegate-task-tool.ts');
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function harness(options: { finishFails?: boolean; setupFails?: boolean; beforeRunFails?: boolean } = {}) {
  const operations: Operation[] = [];
  const toolContexts: WorkerParams['executionContext'][] = [];
  const timers = new Set<{ callback: () => void; unref: () => void }>();
  let created = false;
  let scopes = 0;
  let loop: Loop = async (prompts) => [...prompts, assistant('stop')];
  const sourceContext: WorkerParams['executionContext'] = {
    userId: 'owner', sessionId: 'parent', agentId: 'canvas-agent', agentTurnId: 'parent-turn',
    workspaceId: 'workspace', workspaceType: 'personal', workspaceName: null,
    organizationId: 'organization', customerId: null, projectId: null,
    workspaceRoot: '/tmp/worker-workspace', workspaceRootRelativePath: null,
    canWrite: true, canDelete: false, canShare: false, legacy: false,
  };
  const runtime = { model: { id: 'test-model' }, selection: { selection: { providerId: 'test', thinkingLevel: 'off' } },
    resolution: { catalogRevision: 1, policyRevision: 1 }, streamFn: async () => undefined };
  const mocks: Record<string, unknown> = {
    'node:crypto': require('node:crypto'),
    typebox: require('typebox'),
    'drizzle-orm': { eq: () => undefined, and: () => undefined },
    './tool-output-block-storage': { finalizeToolOutputBlocks: async (messages: AgentMessage[]) => messages },
    './context-budget': { estimatePiToolSchemaTokens: () => 0, getPiRequestOutputTokenCap: () => 1_000,
      withPiRequestOutputTokenCap: (stream: unknown) => stream },
    '@earendil-works/pi-agent-core': { runAgentLoop: (...args: Parameters<Loop>) => loop(...args) },
    '@earendil-works/pi-ai': { createInitialSystemMessage: () => ({ role: 'system', content: 'system' }),
      toToolDeclaration: (tool: unknown) => tool },
    '@/app/lib/db': { db: { query: { piSessions: { findMany: async (query: { columns: { id?: boolean } }) => {
      if (query.columns.id) return [{ id: 'source-db-row', agentId: 'canvas-agent' }];
      return created ? [{ agentId: 'canvas-agent' }] : [];
    } } } } },
    '@/app/lib/db/schema': { piSessions: {} },
    '@/app/lib/pi/delegation-policy': { requireDelegationSource: async () => undefined },
    '@/app/lib/agent-runtime-policy/session-runtime-service': { prepareSessionRuntimeSnapshot: async () => {
      if (options.setupFails) throw new Error('setup failed');
      return {};
    } },
    '@/app/lib/agent-runtime-policy/provider-runtime': { resolveAndPinSessionRuntime: async () => runtime },
    '@/app/lib/agent-runtime-policy/runtime-store': { RuntimeContextRevisionConflictError: class extends Error {},
      SessionRuntimeContextRevisionConflictError: class extends Error {} },
    '@/app/lib/pi/session-operation-lock': { withPiSessionOperationLock: async (_session: string, _user: string,
      action: () => Promise<unknown>) => action() },
    '@/app/lib/pi/session-exclusive-execution': { withExclusivePiSessionExecution: async (input: {
      beforeRuntimeCheck: () => Promise<void>; operation: (reservation: unknown) => Promise<unknown>;
    }) => {
      if (options.beforeRunFails) throw new Error('reservation failed');
      await input.beforeRuntimeCheck();
      return input.operation({ runReserved: (_signal: AbortSignal, action: () => Promise<unknown>) => action() });
    } },
    '@/app/lib/pi/session-workspace-context': {
      resolveAgentExecutionContextForSession: async () => ({ ...sourceContext, canWrite: ++scopes < 3 }),
      resolveAgentSessionWorkspaceForUser: async () => ({ workspaceId: 'workspace', workspaceType: 'personal',
        organizationId: 'organization' }), workspaceToPiSessionFields: () => ({}),
    },
    '@/app/lib/pi/tool-registry': { getPiTools: async (_user: string, _agent: string, _session: string,
      input: { executionContext: WorkerParams['executionContext'] }) => {
      toolContexts.push(input.executionContext);
      operations.push({ kind: 'tools', turnId: input.executionContext.agentTurnId });
      return [{ name: 'fixture', parameters: {} }];
    } },
    '@/app/lib/pi/toolsets': { resolveDelegatedWorkerToolNames: () => new Set(['fixture']) },
    '@/app/lib/pi/progressive-tool-gateway': { getProgressiveGatewayCapabilityNames: () => [] },
    '@/app/lib/pi/email-agent-policy': { filterToolsToAllowedNames: (tools: unknown) => tools },
    '@/app/lib/agents/system-prompt': { loadManagedAgentSystemPrompt: async () => ({ systemPrompt: 'system' }) },
    '@/app/lib/pi/runtime-prompt-context': { buildActiveWorkspacePromptBlock: () => 'workspace' },
    '@/app/lib/pi/effective-tool-manifest': { appendEffectiveToolCapabilitiesPrompt: (prompt: string) => prompt,
      buildEffectiveToolManifest: () => ({}) },
    '@/app/lib/agents/workspace-file-tree-context': { buildWorkspaceFileTreePrompt: async () => ({ promptBlock: 'tree' }),
      replaceWorkspaceFileTreePromptBlock: (prompt: string) => prompt },
    '@/app/lib/pi/system-prompt-snapshot': { buildPiSystemPromptSnapshotFromText: () => ({}) },
    '@/app/lib/pi/session-store': { createPiSessionWithRuntimeSnapshot: async () => { created = true; },
      savePiSession: async () => { operations.push({ kind: 'save' }); } },
    '@/app/lib/pi/delegation-managed-steering': { extractMessageText: (message: AgentMessage) => {
      if (!('content' in message)) return '';
      return typeof message.content === 'string' ? message.content
        : (message.content as Array<{ text?: string }>).map(part => part.text ?? '').join('');
    } },
    '@/app/lib/pi/compaction/runtime-policy': { loadPiEffectiveCompactionPolicy: async () => ({ summaryModel: null }),
      resolvePiEffectiveCompactionPolicy: () => ({ summaryModel: null }) },
    '@/app/lib/pi/delegation-progress': { appendPiDelegationProgress: async () => true },
    '@/app/lib/file-version-center/agent-turn-history': { agentTurnHistoryService: {
      begin: async (identity: AgentTurnIdentity) => { operations.push({ kind: 'begin', turnId: identity.turnId }); },
      touch: async (identity: AgentTurnIdentity) => { operations.push({ kind: 'touch', turnId: identity.turnId }); },
      finish: async (identity: AgentTurnIdentity, outcome: string) => {
        operations.push({ kind: 'finish', turnId: identity.turnId, outcome });
        if (options.finishFails) throw new Error('history finish failed');
      },
    } },
  };
  const loadedModule = { exports: {} };
  const load = (specifier: string) => {
    if (specifier in mocks) return mocks[specifier];
    if (specifier.startsWith('@/')) return {};
    throw new Error(`Unexpected worker dependency ${specifier}`);
  };
  new Function('require', 'module', 'exports', 'setInterval', 'clearInterval', compiled)(
    load, loadedModule, loadedModule.exports,
    (callback: () => void, delay: number) => {
      assert.equal(delay, 30_000);
      const timer = { callback, unref: () => undefined };
      timers.add(timer);
      return timer;
    }, (timer: { callback: () => void; unref: () => void }) => { timers.delete(timer); },
  );
  const worker = loadedModule.exports as WorkerModule;
  const request = { userId: 'owner', sourceAgentId: 'canvas-agent', sourceSessionId: 'parent',
    goal: 'Edit three places', toolsets: ['file'], waitForResult: true, timeoutSeconds: 5 };
  return { operations, toolContexts, timers, sourceContext, worker, request,
    setLoop: (next: Loop) => { loop = next; },
    direct: (signal = new AbortController().signal) => worker.runEphemeralWorker({
      request, sessionId: 'child', executionContext: { ...sourceContext, sessionId: 'child', agentTurnId: undefined },
      promptMessage: { role: 'user', content: request.goal, timestamp: 1 },
      runtime: runtime as unknown as WorkerParams['runtime'], baseSystemPrompt: 'system', systemPrompt: 'system',
      tools: [], signal,
    }),
  };
}

function assistant(stopReason: string, toolCallId?: string): AgentMessage {
  return { role: 'assistant', content: toolCallId ? [{ type: 'toolCall', id: toolCallId, name: 'fixture', arguments: {} }]
    : [{ type: 'text', text: 'done' }], stopReason, timestamp: 2 } as AgentMessage;
}

async function main() {
  const completed = harness();
  completed.setLoop(async (prompts, _context, _config, emit) => {
    assert.equal(completed.operations[0].kind, 'begin', 'the turn begins before tools are constructed');
    for (const timer of completed.timers) timer.callback();
    await Promise.resolve();
    const messages = [...prompts];
    for (let index = 1; index <= 3; index += 1) {
      const message = assistant('toolUse', `edit-${index}`);
      const result = { role: 'toolResult', toolCallId: `edit-${index}`, toolName: 'fixture', content: [],
        details: {}, isError: false, timestamp: 3 } as AgentMessage;
      await emit({ type: 'message_end', message });
      await emit({ type: 'tool_execution_start', toolCallId: `edit-${index}`, toolName: 'fixture', args: {} });
      await emit({ type: 'message_end', message: result });
      await emit({ type: 'turn_end', message, toolResults: [result] } as AgentEvent);
      messages.push(message, result);
    }
    messages.push(assistant('stop'));
    return messages;
  });
  const result = await completed.worker.startDelegatedRun(completed.request);
  assert.equal(result.status, 'ok');
  assert.equal(completed.toolContexts.length, 2, 'permission changes rebuild the worker tools');
  const turnId = completed.toolContexts[0].agentTurnId;
  assert.match(turnId ?? '', /^[0-9a-f-]{36}$/u);
  assert.notEqual(turnId, 'parent-turn');
  assert.ok(completed.toolContexts.every(context => context.agentTurnId === turnId));
  assert.equal(completed.sourceContext.agentTurnId, 'parent-turn', 'child identity does not modify parent scope');
  assert.equal(completed.operations.filter(op => op.kind === 'begin').length, 1);
  assert.deepEqual(completed.operations.filter(op => op.kind === 'touch'), [{ kind: 'touch', turnId }]);
  assert.deepEqual(completed.operations.at(-1), { kind: 'finish', turnId, outcome: 'completed' });
  assert.equal(completed.timers.size, 0);

  const next = harness();
  assert.equal((await next.worker.startDelegatedRun(next.request)).status, 'ok');
  assert.notEqual(next.toolContexts[0].agentTurnId, turnId, 'every delegated task has its own identity');

  for (const reason of ['error', 'aborted']) {
    const terminal = harness();
    terminal.setLoop(async (prompts) => [...prompts, assistant(reason)]);
    assert.equal((await terminal.direct()).status, 'error');
    assert.equal(terminal.operations.at(-1)?.outcome, reason === 'aborted' ? 'cancelled' : 'failed');
    assert.equal(terminal.timers.size, 0);
  }
  const aborted = harness();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await aborted.direct(controller.signal)).status, 'error');
  assert.equal(aborted.operations.at(-1)?.outcome, 'cancelled');

  const interrupted = harness();
  interrupted.setLoop(async (_prompts, _context, _config, emit) => {
    await emit({ type: 'message_end', message: assistant('toolUse', 'unfinished') });
    await emit({ type: 'tool_execution_start', toolCallId: 'unfinished', toolName: 'fixture', args: {} });
    throw new Error('SDK stream interrupted');
  });
  assert.equal((await interrupted.direct()).status, 'error');
  assert.equal(interrupted.operations.some(op => op.kind === 'finish'), false,
    'an unresolved tool leaves the lease available for checkpoint recovery');
  assert.equal(interrupted.timers.size, 0);

  const incompleteReturn = harness();
  incompleteReturn.setLoop(async (prompts) => [...prompts, assistant('toolUse', 'missing-result')]);
  assert.equal((await incompleteReturn.direct()).status, 'error');
  assert.equal(incompleteReturn.operations.some(op => op.kind === 'finish'), false,
    'incomplete returned messages also leave the lease open even without SDK tool events');
  assert.equal(incompleteReturn.timers.size, 0);

  const failedFinish = harness({ finishFails: true });
  assert.equal((await failedFinish.direct()).status, 'error', 'worker success waits for version finalization');
  assert.equal(failedFinish.timers.size, 0);
  for (const options of [{ setupFails: true }, { beforeRunFails: true }]) {
    const setup = harness(options);
    await assert.rejects(setup.worker.startDelegatedRun(setup.request), /failed/);
    assert.equal(setup.operations.at(-1)?.outcome, 'failed');
    assert.equal(setup.operations.filter(op => op.kind === 'finish').length, 1);
    assert.equal(setup.timers.size, 0);
  }
  console.log('pi-delegate-agent-turn-test: ok');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
