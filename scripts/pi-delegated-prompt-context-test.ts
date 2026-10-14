import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { HeldDelegatedExtensionSource } from '../app/lib/capabilities/extensions/delegation-source';

// Real LivePiRuntime methods and dispatch lifecycle, with controlled source and
// SQL/history boundaries. Actual source/ACL/WeakMap authority is proved by the
// separate extension-delegation-source-test native fixture, not this script.
process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
process.env.BETTER_AUTH_BASE_URL ??= 'http://localhost:3000';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
const operations: Array<{ kind: string; turnId?: string; delegated?: boolean }> = [];
const originalContext: AgentExecutionContext = { userId: 'owner', sessionId: 'child', agentId: 'worker',
  workspaceId: 'workspace', workspaceType: 'personal', workspaceName: null, organizationId: 'organization', projectId: null, customerId: null,
  workspaceRoot: '/owned-fixture/workspace', workspaceRootRelativePath: null, canWrite: true, canDelete: false, canShare: false, legacy: false };
const source = Object.freeze({ kind: 'delegated_extension_source' as const, fingerprint: 'actual-controlled-source' });
const controlledSources = new WeakSet<object>([source]);
let sourceAvailable = true;
let releaseSource: (() => void) | undefined;
let sourceGate: Promise<void> | undefined;
const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (name, parent, main) => {
  if (name === 'server-only') return {};
  if (name === '@earendil-works/pi-agent-core') return { Agent: class Agent {} };
  if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
    getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined,
  };
  if (name === '@/app/lib/pi/tool-output-maintenance') return { maybeCleanupToolOutputOrphans: async () => undefined };
  if (name === '@/app/lib/file-version-center/agent-turn-history') return { agentTurnHistoryService: {
    begin: async (identity: { turnId: string }) => { operations.push({ kind: 'begin', turnId: identity.turnId }); },
    touch: async () => undefined,
    finish: async (identity: { turnId: string }) => { operations.push({ kind: 'finish', turnId: identity.turnId }); },
  } };
  if (name === '@/app/lib/capabilities/extensions/turn-runtime' || /\/extensions\/turn-runtime(?:\.ts)?$/u.test(name)) return {
    resolveDelegatedExtensionContextSource: async (holder: HeldDelegatedExtensionSource, context: AgentExecutionContext,
      options: { delegationId: string }) => {
      assert.equal(options.delegationId, 'stored-task');
      assert.equal(context.sessionId, 'child');
      assert.match(context.agentTurnId ?? '', /^[a-f0-9-]{36}$/u);
      assert(operations.some(item => item.kind === 'begin' && item.turnId === context.agentTurnId), 'History begins before source issuance.');
      operations.push({ kind: 'source', turnId: context.agentTurnId });
      if (sourceGate) await sourceGate;
      if (!controlledSources.has(holder) || !sourceAvailable) throw Object.assign(new Error('Source denied'), { code: 'provider_denied' });
      return { ...context, delegatedExtensionSource: holder,
        turnExtensions: { version: 1, origin: 'turn_reference', selections: [] },
        turnExtensionSource: Object.freeze({ kind: 'accepted_turn_runtime_selection', fingerprint: context.agentTurnId }),
        effectiveExtensions: Object.freeze({ kind: 'effective_extension_context', fingerprint: `delegated:${context.agentTurnId}` }),
        skillReadRoots: ['/owned-fixture/exact-parent'], skillPackageBindings: [] };
    },
  };
  if (name === '@/app/lib/pi/session-workspace-context') return {
    resolveAgentExecutionContextForSession: async (input: { sessionId: string; userId: string; agentId: string }) => {
      assert.equal(input.sessionId, originalContext.sessionId);
      operations.push({ kind: 'own-context' });
      return { ...originalContext, effectiveExtensions: Object.freeze({ kind: 'effective_extension_context', fingerprint: 'own' }),
        skillReadRoots: ['/owned-fixture/own'], skillPackageBindings: [] };
    },
  };
  if (name === '@/app/lib/pi/system-prompt-snapshot') return {
    createPiSystemPromptSnapshot: async (_agent: string, _scope: unknown, options: { executionContext: AgentExecutionContext }) => {
      operations.push({ kind: 'foundation', turnId: options.executionContext.agentTurnId,
        delegated: Boolean(options.executionContext.delegatedExtensionSource) });
      return { systemPrompt: 'Fresh private foundation' };
    },
  };
  if (name === '@/app/lib/pi/tool-registry') return {
    getPiTools: async (_user: string, _agent: string, _session: string, options: { executionContext: AgentExecutionContext }) => {
      operations.push({ kind: 'tools', turnId: options.executionContext.agentTurnId,
        delegated: Boolean(options.executionContext.delegatedExtensionSource) });
      return [{ name: options.executionContext.delegatedExtensionSource ? 'finite-source-tool' : 'own-tool' }];
    },
  };
  return originalLoad.call(loader, name, parent, main);
};

async function main() {
  // Compile the current source to CJS so its dynamic service imports honor the
  // same controlled Module boundary; native ESM caches otherwise bypass it.
  const sourcePath = require.resolve('../app/lib/pi/live-runtime');
  const compiled = new Module(sourcePath, module) as Module & { paths: string[]; _compile: (code: string, filename: string) => void };
  compiled.filename = sourcePath;
  compiled.paths = (Module as typeof Module & { _nodeModulePaths: (directory: string) => string[] })._nodeModulePaths(path.dirname(sourcePath));
  compiled._compile(ts.transpileModule(readFileSync(sourcePath, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, sourcePath);
  const { LivePiRuntime } = compiled.exports as typeof import('../app/lib/pi/live-runtime');
  const context = { ...originalContext };
  const runtime = Object.create(LivePiRuntime.prototype) as InstanceType<typeof LivePiRuntime> & Record<string, unknown>;
  const state = runtime as unknown as { tools: AgentTool[]; isRunning: boolean; disposed: boolean; agentTurnTransition: Promise<void> };
  const errors: unknown[] = [];
  const messages: Extract<AgentMessage, { role: 'user' }>[] = [];
  const agent = { state: { tools: [] as AgentTool[], systemPrompt: '', pendingToolCalls: new Set<string>(), messages: [] as AgentMessage[], isStreaming: false },
    prompt: async (message: Extract<AgentMessage, { role: 'user' }>) => {
      operations.push({ kind: 'model', turnId: context.agentTurnId, delegated: Boolean(context.delegatedExtensionSource) });
      messages.push(message);
    } };
  Object.assign(runtime, { sessionId: context.sessionId, userId: context.userId, agentId: context.agentId,
    executionContext: context, agent, options: {}, model: { id: 'test-model' }, disposed: false,
    isRunning: false, abortRequested: false, activeTool: null, browserToolMode: 'dormant', planningMode: false,
    agentTurnTransition: Promise.resolve(), activeAgentTurn: null, pendingAgentTurnTouch: null,
    messageQueues: { consume: () => undefined }, rememberMessageContext: () => undefined,
    maybeCreateInitialToolTailContinuation: () => null, touch: () => undefined, invalidateContextBudget: () => undefined,
    publishStatus: () => undefined, publishError: (error: unknown) => { errors.push(error); },
    getEffectiveTools: () => state.tools,
    getEffectiveSystemPrompt: () => String(context.effectiveExtensions?.fingerprint ?? 'admission-pending'),
    updateAgentSystemPrompt: () => { agent.state.systemPrompt = String(context.effectiveExtensions?.fingerprint ?? 'admission-pending'); },
    persistMessages: async () => 0 });
  const message = (text: string, timestamp = Date.now()) => ({ role: 'user' as const, content: text, timestamp });

  sourceGate = new Promise(resolve => { releaseSource = resolve; });
  const start = runtime.startDelegatedPrompt(message('Run exact parent source'), source, 'stored-task', async issued => {
    assert.equal(issued, context, 'The real tool closure context object retains its identity.');
    assert.equal(issued.delegatedExtensionSource, source);
    assert(issued.turnExtensionSource && issued.effectiveExtensions);
    assert.equal(agent.state.tools[0].name, 'finite-source-tool');
    operations.push({ kind: 'handoff', turnId: issued.agentTurnId });
    return message('Approved handoff with current exact source');
  });
  await (runtime as unknown as { agentTurnTransition: Promise<void> }).agentTurnTransition;
  await Promise.resolve();
  assert.equal(messages.length, 0, 'The model cannot start while source admission is pending.');
  assert.equal(operations.some(item => item.kind === 'tools'), false, 'Final tools cannot be compiled before the source.');
  releaseSource!();
  await start;
  sourceGate = undefined;
  const firstTurn = context.agentTurnId;
  assert.deepEqual(operations.filter(item => ['begin', 'source', 'foundation', 'tools', 'handoff', 'model'].includes(item.kind))
    .map(item => item.kind), ['begin', 'source', 'foundation', 'tools', 'handoff', 'model']);
  assert.equal(messages[0].content, 'Approved handoff with current exact source');
  await runtime.onAgentEvent({ type: 'message_start', message: messages[0] });
  assert.equal(context.agentTurnId, firstTurn, 'The approved replacement message retains the admitted turn.');
  await runtime.onAgentEvent({ type: 'message_start', message: message('Correction within the same task', 2) });
  assert.notEqual(context.agentTurnId, firstTurn);
  assert.equal(context.delegatedExtensionSource, source, 'Task steering retains its finite parent ceiling.');
  assert.match(context.effectiveExtensions!.fingerprint, /^delegated:/u);
  const sourceCount = operations.filter(item => item.kind === 'source').length;
  assert.equal(sourceCount, 2, 'Steering reissues against the new durable child turn.');

  state.isRunning = false;
  runtime.startPrompt(message('Ordinary subsequent message', 3));
  await (runtime as unknown as { agentTurnTransition: Promise<void> }).agentTurnTransition;
  for (let index = 0; index < 15 && messages.length < 2; index++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 2);
  assert.equal(context.delegatedExtensionSource, undefined);
  assert.equal(context.turnExtensionSource, undefined);
  assert.equal(context.turnExtensions, undefined);
  assert.equal(context.effectiveExtensions?.fingerprint, 'own');
  assert.deepEqual(context.skillReadRoots, ['/owned-fixture/own']);
  assert.equal(agent.state.tools[0].name, 'own-tool');
  assert.equal(operations.at(-1)?.delegated, false, 'An ordinary message uses current own context, not a stale parent ceiling.');

  state.isRunning = false;
  const beforeDenial = messages.length;
  await assert.rejects(runtime.startDelegatedPrompt(message('Copied holder'), structuredClone(source), 'stored-task'), { code: 'provider_denied' });
  assert.equal(messages.length, beforeDenial);
  assert.equal(state.isRunning, false, 'Admission failure publishes the error and closes the failed run.');
  assert.equal(errors.length, 1);
  sourceAvailable = false;
  await assert.rejects(runtime.startDelegatedPrompt(message('Revoked parent'), source, 'stored-task'), { code: 'provider_denied' });
  assert.equal(messages.length, beforeDenial);
  sourceAvailable = true;
  await assert.rejects(runtime.startDelegatedPrompt(message('Missing task'), source, ''), /stored delegated task/u);
  state.isRunning = true;
  await assert.rejects(runtime.startDelegatedPrompt(message('Concurrent private admission'), source, 'stored-task'), /idle runtime/u);
  state.isRunning = false;
  state.disposed = true;
  await assert.rejects(runtime.startDelegatedPrompt(message('Disposed'), source, 'stored-task'), /replaced/u);
  state.disposed = false;
  (runtime as unknown as { stopAgentTurnHeartbeat: () => void }).stopAgentTurnHeartbeat();
  console.log('PASS actual LivePiRuntime delegated admission lifecycle: new durable child turn, source before tools/model, approved handoff, same-task steering, own-context cleanup and closed errors. Source/SQL authority is controlled here.');
}

void main().finally(() => { loader._load = originalLoad; }).catch(error => { console.error(error); process.exitCode = 1; });
