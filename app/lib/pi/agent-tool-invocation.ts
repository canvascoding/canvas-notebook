import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { getAgentExecutionContext, type AgentExecutionContext } from './agent-execution-context';

declare const invocationBrand: unique symbol;
export type AgentToolInvocation = Readonly<{ [invocationBrand]: true }>;

/** Provenance only. These primitives grant no workspace, document or SQL rights. */
export type AgentToolInvocationOrigin = Readonly<Pick<AgentExecutionContext,
  'userId' | 'sessionId' | 'agentId' | 'workspaceId' | 'organizationId' | 'customerId' | 'projectId'
  | 'workspaceType' | 'workspaceRoot' | 'workspaceRootRelativePath' | 'agentTurnId' | 'legacy'> & {
  toolName: string;
  toolCallId: string;
}>;

export class AgentToolInvocationError extends Error {
  constructor(readonly code: 'AGENT_TOOL_INVOCATION_REQUIRED' | 'AGENT_TOOL_INVOCATION_INVALID'
    | 'AGENT_TOOL_INVOCATION_CLOSED' | 'AGENT_TOOL_INVOCATION_ABORTED'
    | 'AGENT_TOOL_INVOCATION_DETACHED' | 'AGENT_TOOL_INVOCATION_ORIGIN_CHANGED') {
    super('The current agent tool invocation could not be confirmed.');
    this.name = 'AgentToolInvocationError';
  }
}

type Failure = { reason: unknown };
type Capture = {
  handle: AgentToolInvocation;
  origin: AgentToolInvocationOrigin;
  context: AgentExecutionContext;
  parent?: Capture;
  active: boolean;
  accepting: boolean;
  failure?: Failure;
  operationFailure?: Failure;
  pending: Set<Promise<unknown>>;
  signal?: AbortSignal;
};

const invocations = new WeakMap<AgentToolInvocation, Capture>();
const storage = new AsyncLocalStorage<Capture>();
const originKeys = ['userId', 'sessionId', 'agentId', 'workspaceId', 'organizationId', 'customerId', 'projectId',
  'workspaceType', 'workspaceRoot', 'workspaceRootRelativePath', 'agentTurnId', 'legacy'] as const;

function fail(code: AgentToolInvocationError['code'], captured = storage.getStore()): never {
  const failure = { reason: new AgentToolInvocationError(code) };
  if (captured) {
    captured.failure ??= failure;
    throw (captured.operationFailure ?? captured.failure).reason;
  }
  throw failure.reason;
}

function text(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= 4096;
}

function origin(context: AgentExecutionContext, toolName: string, toolCallId: string): AgentToolInvocationOrigin {
  if (!context || typeof context !== 'object' || !text(context.userId) || !text(context.sessionId)
    || !text(context.workspaceId) || !text(context.workspaceRoot) || !text(toolName) || !text(toolCallId)
    || !['personal', 'organization', 'team', 'project'].includes(context.workspaceType)
    || typeof context.legacy !== 'boolean'
    || ['agentId', 'organizationId', 'customerId', 'projectId'].some(key => {
      const value = Reflect.get(context, key); return value !== null && !text(value);
    })
    || context.workspaceRootRelativePath !== null && !text(context.workspaceRootRelativePath, true)
    || context.agentTurnId !== undefined && !text(context.agentTurnId)) fail('AGENT_TOOL_INVOCATION_INVALID');
  return Object.freeze({ userId: context.userId, sessionId: context.sessionId, agentId: context.agentId,
    workspaceId: context.workspaceId, organizationId: context.organizationId, customerId: context.customerId,
    projectId: context.projectId, workspaceType: context.workspaceType, workspaceRoot: context.workspaceRoot,
    workspaceRootRelativePath: context.workspaceRootRelativePath, legacy: context.legacy,
    ...(context.agentTurnId !== undefined ? { agentTurnId: context.agentTurnId } : {}), toolName, toolCallId });
}

function alive(captured: Capture): void {
  if (!captured.active) fail('AGENT_TOOL_INVOCATION_CLOSED', captured);
  if (captured.signal?.aborted) fail('AGENT_TOOL_INVOCATION_ABORTED', captured);
  if (captured.operationFailure ?? captured.failure) throw (captured.operationFailure ?? captured.failure)!.reason;
  if (captured.parent) alive(captured.parent);
  // Under a child ALS the ambient context belongs to the child. Its parent's
  // original private reference, rather than the child's context, stays pinned.
  if (originKeys.some(key => captured.context[key] !== captured.origin[key])) fail('AGENT_TOOL_INVOCATION_ORIGIN_CHANGED', captured);
}

function current(handle: AgentToolInvocation, accepting = false): Capture {
  const captured = invocations.get(handle);
  if (!captured || storage.getStore() !== captured) fail('AGENT_TOOL_INVOCATION_REQUIRED');
  if (accepting && !captured.accepting) fail('AGENT_TOOL_INVOCATION_CLOSED', captured);
  alive(captured);
  const context = getAgentExecutionContext();
  if (!context || originKeys.some(key => context[key] !== captured.origin[key])) fail('AGENT_TOOL_INVOCATION_ORIGIN_CHANGED', captured);
  return captured;
}

/** Internal runtime entry, called by the actual tool wrapper. An ordinary
 * AgentExecutionContext ALS scope alone never creates an invocation handle.
 * Nested tool wrappers establish independent children and restore their parent. */
export async function withAgentToolInvocation<T>(context: AgentExecutionContext,
  input: { toolName: string; toolCallId: string; signal?: AbortSignal }, operation: () => Promise<T>): Promise<T> {
  if (getAgentExecutionContext() !== context || !input || typeof operation !== 'function'
    || input.signal !== undefined && !(input.signal instanceof AbortSignal)) fail('AGENT_TOOL_INVOCATION_INVALID');
  const parent = storage.getStore();
  if (parent) {
    if (!parent.accepting) fail('AGENT_TOOL_INVOCATION_CLOSED', parent);
    alive(parent);
  }
  const identity = origin(context, input.toolName, input.toolCallId);
  const handle = Object.freeze({}) as AgentToolInvocation;
  const captured: Capture = { handle, origin: identity, context, parent, active: true, accepting: true, pending: new Set(), signal: input.signal };
  invocations.set(handle, captured);
  const abort = () => { captured.failure ??= { reason: new AgentToolInvocationError('AGENT_TOOL_INVOCATION_ABORTED') }; };
  input.signal?.addEventListener('abort', abort, { once: true });
  // Dispatch on the next microtask so a real child is registered in its parent
  // before any child callback or asynchronous authority acquisition can start.
  const pending = Promise.resolve().then(() => storage.run(captured, async () => {
      let result: T | undefined, operationFailure: Failure | undefined;
      try { current(handle, true); result = await operation(); }
      catch (error) { operationFailure = { reason: error }; captured.failure ??= operationFailure; }
      captured.accepting = false;
      if (captured.pending.size) {
        captured.failure ??= { reason: new AgentToolInvocationError('AGENT_TOOL_INVOCATION_DETACHED') };
        await Promise.allSettled([...captured.pending]);
      }
      // Later cleanup failures must survive an earlier swallowed guard poison.
      if (operationFailure) throw operationFailure.reason;
      if (captured.operationFailure ?? captured.failure) throw (captured.operationFailure ?? captured.failure)!.reason;
      current(handle);
      return result as T;
    })).finally(() => {
    captured.active = false;
    captured.accepting = false;
    invocations.delete(handle);
    input.signal?.removeEventListener('abort', abort);
  });
  if (parent) {
    parent.pending.add(pending);
    void pending.then(() => parent.pending.delete(pending), error => {
      parent.pending.delete(pending);
      // Preserve a later child cleanup failure when a failed parent had to
      // drain it. A normally awaited and handled child error is still local.
      if (parent.failure && error !== parent.failure.reason) parent.operationFailure ??= { reason: error };
    });
  }
  return pending;
}

export function captureCurrentAgentToolInvocation(): AgentToolInvocation {
  const captured = storage.getStore();
  if (!captured) fail('AGENT_TOOL_INVOCATION_REQUIRED');
  current(captured.handle, true);
  return captured.handle;
}

export function assertCurrentAgentToolInvocation(handle: AgentToolInvocation): AgentToolInvocationOrigin {
  return current(handle).origin;
}

/** A future principal holds this scope for its complete awaited transaction and
 * cleanup. Detached work is drained and rejects the invocation's outer result. */
export function withCapturedAgentToolInvocation<T>(handle: AgentToolInvocation,
  operation: (assertCurrent: () => AgentToolInvocationOrigin) => Promise<T>): Promise<T> {
  let captured: Capture;
  try {
    captured = current(handle, true);
    if (typeof operation !== 'function') fail('AGENT_TOOL_INVOCATION_INVALID', captured);
  } catch (error) { return Promise.reject(error); }
  let active = true;
  // Register before dispatching the callback or its first asynchronous step.
  const pending = Promise.resolve().then(async () => {
    try {
      const assertCurrent = () => {
        if (!active) fail('AGENT_TOOL_INVOCATION_CLOSED', captured);
        return current(handle).origin;
      };
      assertCurrent();
      const result = await operation(assertCurrent);
      assertCurrent();
      return result;
    } catch (error) {
      captured.operationFailure ??= { reason: error };
      captured.failure ??= captured.operationFailure;
      throw error;
    } finally { active = false; }
  });
  captured.pending.add(pending);
  void pending.then(() => captured.pending.delete(pending), () => captured.pending.delete(pending));
  return pending;
}
