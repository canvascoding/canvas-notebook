import { randomUUID } from 'node:crypto';
import type { AgentContext, AgentMessage, AgentTool, ThinkingLevel } from '@mariozechner/pi-agent-core';
import { Type } from 'typebox';
import { and, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { resolveAgentRuntimeConfig } from '@/app/lib/agents/effective-runtime-config';
import { getAgentProfile, normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { loadManagedAgentSystemPrompt } from '@/app/lib/agents/system-prompt';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { DEFAULT_PI_SESSION_TITLE } from '@/app/lib/pi/session-titles';
import { savePiSession } from '@/app/lib/pi/session-store';
import { PI_TOOLSETS, resolvePiToolsetTools } from '@/app/lib/pi/toolsets';

type DelegateTaskArgs = {
  target_agent_id?: string;
  goal?: string;
  context?: string;
  session_id?: string;
  role?: string;
  toolsets?: string[];
  wait_for_result?: boolean;
  timeout_seconds?: number;
};

export type DelegateTaskRequest = {
  userId: string;
  sourceAgentId: string;
  targetAgentId?: string;
  goal: string;
  context?: string;
  sessionId?: string;
  workerRole?: string;
  toolsets: string[];
  waitForResult: boolean;
  timeoutSeconds: number;
};

export type DelegateTaskResult = {
  status: 'accepted' | 'ok' | 'timeout' | 'error';
  worker_type: 'ephemeral' | 'managed';
  source_agent_id: string;
  target_agent_id?: string;
  session_id: string;
  role?: string;
  toolsets?: string[];
  wait_for_result: boolean;
  timeout_seconds: number;
  reply?: string;
  error?: string;
};

type RuntimeInstance = {
  agent: { state: { messages: AgentMessage[] } };
  getStatus: () => { phase: string; canAbort: boolean };
  subscribe: (subscriber: (event: { type: string; status?: { phase: string; canAbort: boolean }; error?: string }) => void) => () => void;
};

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
const MAX_REPLY_CHARS = 8000;
const DEFAULT_EPHEMERAL_TOOLSETS = ['file', 'terminal', 'web', 'session_search'];
const BLOCKED_CHILD_TOOL_NAMES = new Set(['delegate_task']);

function normalizeAgentId(agentId?: string | null): string {
  try {
    return normalizeManagedAgentId(agentId);
  } catch {
    return DEFAULT_AGENT_ID;
  }
}

function buildDelegatedSessionId(): string {
  return `sess-${Date.now()}-${randomUUID()}`;
}

function clampTimeoutSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  return Math.max(0, Math.min(Math.trunc(value), MAX_TIMEOUT_SECONDS));
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function extractMessageText(message: AgentMessage): string {
  if (!('content' in message)) {
    return '';
  }
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function latestAssistantReplyFromMessages(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant') {
      const text = extractMessageText(message);
      return text ? truncate(text, MAX_REPLY_CHARS) : undefined;
    }
  }
  return undefined;
}

function latestAssistantReply(runtime: RuntimeInstance): string | undefined {
  return latestAssistantReplyFromMessages(runtime.agent.state.messages);
}

function normalizeToolsets(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return DEFAULT_EPHEMERAL_TOOLSETS;
  }

  const seen = new Set<string>();
  const toolsets: string[] = [];
  for (const rawToolset of value) {
    if (typeof rawToolset !== 'string') {
      continue;
    }
    const toolset = rawToolset.trim();
    if (!toolset || seen.has(toolset)) {
      continue;
    }
    if (!(toolset in PI_TOOLSETS)) {
      throw new Error(`Unknown toolset "${toolset}". Available toolsets: ${Object.keys(PI_TOOLSETS).join(', ')}.`);
    }
    seen.add(toolset);
    toolsets.push(toolset);
  }

  return toolsets.length > 0 ? toolsets : DEFAULT_EPHEMERAL_TOOLSETS;
}

function buildDelegationPrompt(request: DelegateTaskRequest): Extract<AgentMessage, { role: 'user' }> {
  const lines = [
    `Delegated task from agent "${request.sourceAgentId}".`,
    request.workerRole ? `Worker role: ${request.workerRole}` : null,
    '',
    'Goal:',
    request.goal,
  ].filter((line): line is string => line !== null);

  if (request.context?.trim()) {
    lines.push('', 'Context:', request.context.trim());
  }

  lines.push(
    '',
    'Return a concise final answer for the delegating agent. Include key findings, files changed, and unresolved blockers if relevant.',
  );

  return {
    role: 'user',
    content: lines.join('\n'),
    timestamp: Date.now(),
  };
}

function buildEphemeralSystemPrompt(baseSystemPrompt: string, request: DelegateTaskRequest, tools: AgentTool[]): string {
  return [
    baseSystemPrompt,
    '',
    '## Delegated Ephemeral Worker',
    'You are a short-lived worker spawned for one focused delegated task.',
    'You do not have the parent conversation history. Use only the goal, explicit context, and tools provided in this worker session.',
    `Worker role: ${request.workerRole || 'generalist'}`,
    `Requested toolsets: ${request.toolsets.join(', ') || 'none'}`,
    `Available tools: ${tools.map((tool) => tool.name).join(', ') || 'none'}`,
    'Do not attempt to delegate further. Finish with a concise summary for the parent agent.',
  ].join('\n');
}

function buildEphemeralSessionTitle(goal: string): string {
  return truncate(`Delegate: ${goal.replace(/\s+/g, ' ').trim()}`, 120);
}

async function resolveEphemeralTools(request: DelegateTaskRequest): Promise<AgentTool[]> {
  const { getPiTools } = await import('@/app/lib/pi/tool-registry');
  const allTools = await getPiTools(request.userId, request.sourceAgentId);
  const allowedToolNames = resolvePiToolsetTools(request.toolsets, allTools.map((tool) => tool.name));
  for (const blockedToolName of BLOCKED_CHILD_TOOL_NAMES) {
    allowedToolNames.delete(blockedToolName);
  }
  return allTools.filter((tool) => allowedToolNames.has(tool.name));
}

async function runEphemeralWorker(params: {
  request: DelegateTaskRequest;
  sessionId: string;
  promptMessage: Extract<AgentMessage, { role: 'user' }>;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  tools: AgentTool[];
}): Promise<DelegateTaskResult> {
  let finalMessages: AgentMessage[] = [params.promptMessage];
  try {
    const [{ agentLoop }, { resolvePiApiKey }] = await Promise.all([
      import('@mariozechner/pi-agent-core'),
      import('@/app/lib/pi/api-key-resolver'),
    ]);
    const context: AgentContext = {
      systemPrompt: params.systemPrompt,
      messages: [],
      tools: params.tools,
    };
    const config = {
      model: (await resolveAgentRuntimeConfig(params.request.sourceAgentId)).model,
      thinkingLevel: params.thinkingLevel,
      convertToLlm: async (messages: AgentMessage[]) => {
        const { normalizePiMessagesForLlm } = await import('@/app/lib/pi/message-normalization');
        return normalizePiMessagesForLlm(
          messages.filter((message) => message.role !== 'compact-break' && message.role !== 'composio_auth_required'),
        );
      },
      getApiKey: resolvePiApiKey,
      sessionId: params.sessionId,
    };

    for await (const event of agentLoop([params.promptMessage], context, config, undefined)) {
      if (event.type === 'agent_end') {
        finalMessages = event.messages;
      }
    }

    await savePiSession(
      params.sessionId,
      params.request.userId,
      params.provider,
      params.modelId,
      finalMessages,
      undefined,
      {
        titleOverride: buildEphemeralSessionTitle(params.request.goal),
        agentId: params.request.sourceAgentId,
      },
    );

    return {
      status: 'ok',
      worker_type: 'ephemeral',
      source_agent_id: params.request.sourceAgentId,
      session_id: params.sessionId,
      role: params.request.workerRole,
      toolsets: params.request.toolsets,
      wait_for_result: params.request.waitForResult,
      timeout_seconds: params.request.timeoutSeconds,
      reply: latestAssistantReplyFromMessages(finalMessages),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown delegated worker error';
    await savePiSession(
      params.sessionId,
      params.request.userId,
      params.provider,
      params.modelId,
      finalMessages,
      undefined,
      {
        titleOverride: buildEphemeralSessionTitle(params.request.goal),
        agentId: params.request.sourceAgentId,
      },
    );
    return {
      status: 'error',
      worker_type: 'ephemeral',
      source_agent_id: params.request.sourceAgentId,
      session_id: params.sessionId,
      role: params.request.workerRole,
      toolsets: params.request.toolsets,
      wait_for_result: params.request.waitForResult,
      timeout_seconds: params.request.timeoutSeconds,
      error: message,
    };
  }
}

function timeoutResult(request: DelegateTaskRequest, sessionId: string): DelegateTaskResult {
  return {
    status: 'timeout',
    worker_type: 'ephemeral',
    source_agent_id: request.sourceAgentId,
    session_id: sessionId,
    role: request.workerRole,
    toolsets: request.toolsets,
    wait_for_result: true,
    timeout_seconds: request.timeoutSeconds,
    error: 'Delegated task did not finish before timeout. The worker may continue in the background.',
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(onTimeout());
    }, timeoutMs);
    timer.unref?.();

    promise.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function startEphemeralDelegatedRun(request: DelegateTaskRequest): Promise<DelegateTaskResult> {
  if (request.sessionId) {
    throw new Error('session_id is only supported when target_agent_id is set.');
  }

  const effectiveConfig = await resolveAgentRuntimeConfig(request.sourceAgentId);
  const provider = effectiveConfig.activeProvider;
  const providerConfig = effectiveConfig.providerConfig;
  const model = effectiveConfig.model;
  const tools = await resolveEphemeralTools(request);
  const { systemPrompt: baseSystemPrompt } = await loadManagedAgentSystemPrompt(request.sourceAgentId);
  const systemPrompt = buildEphemeralSystemPrompt(baseSystemPrompt, request, tools);
  const sessionId = buildDelegatedSessionId();
  const promptMessage = buildDelegationPrompt(request);

  await savePiSession(
    sessionId,
    request.userId,
    provider,
    model.id,
    [promptMessage],
    undefined,
    {
      titleOverride: buildEphemeralSessionTitle(request.goal),
      agentId: request.sourceAgentId,
    },
  );

  const runPromise = runEphemeralWorker({
    request,
    sessionId,
    promptMessage,
    provider,
    modelId: model.id,
    thinkingLevel: (providerConfig?.thinking || effectiveConfig.thinkingLevel || 'off') as ThinkingLevel,
    systemPrompt,
    tools,
  });

  if (!request.waitForResult || request.timeoutSeconds === 0) {
    void runPromise.catch((error) => {
      console.error('[delegate_task] Ephemeral worker failed after accepted result:', error);
    });
    return {
      status: 'accepted',
      worker_type: 'ephemeral',
      source_agent_id: request.sourceAgentId,
      session_id: sessionId,
      role: request.workerRole,
      toolsets: request.toolsets,
      wait_for_result: false,
      timeout_seconds: request.timeoutSeconds,
    };
  }

  return withTimeout(
    runPromise,
    request.timeoutSeconds * 1000,
    () => timeoutResult(request, sessionId),
  );
}

async function ensureManagedDelegatedSession(request: DelegateTaskRequest): Promise<string> {
  if (!request.targetAgentId) {
    throw new Error('target_agent_id is required for managed delegation.');
  }

  const requestedSessionId = request.sessionId?.trim();
  const sessionId = requestedSessionId || buildDelegatedSessionId();
  const existing = await db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.sessionId, sessionId),
      eq(piSessions.userId, request.userId),
      eq(piSessions.agentId, request.targetAgentId),
    ),
  });

  if (existing) {
    return sessionId;
  }

  if (requestedSessionId) {
    throw new Error('Target session not found for this user and agent.');
  }

  const effectiveConfig = await resolveAgentRuntimeConfig(request.targetAgentId);
  const provider = effectiveConfig.activeProvider;
  const providerConfig = effectiveConfig.providerConfig;

  await db.insert(piSessions).values({
    sessionId,
    userId: request.userId,
    agentId: request.targetAgentId,
    provider,
    model: providerConfig?.model || effectiveConfig.model.id,
    thinkingLevel: providerConfig?.thinking || effectiveConfig.thinkingLevel || 'off',
    title: DEFAULT_PI_SESSION_TITLE,
    channelId: 'app',
    channelSessionKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return sessionId;
}

function waitForRuntimeIdle(runtime: RuntimeInstance, timeoutSeconds: number): Promise<{ status: 'ok' | 'timeout' | 'error'; error?: string }> {
  const timeoutMs = timeoutSeconds * 1000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { status: 'ok' | 'timeout' | 'error'; error?: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };

    const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
    timer.unref?.();

    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === 'error') {
        finish({ status: 'error', error: event.error });
        return;
      }
      if (event.type === 'runtime_status' && event.status && event.status.phase === 'idle' && !event.status.canAbort) {
        finish({ status: 'ok' });
      }
    });
  });
}

async function startManagedDelegatedRun(request: DelegateTaskRequest): Promise<DelegateTaskResult> {
  if (!request.targetAgentId) {
    throw new Error('target_agent_id is required for managed delegation.');
  }

  const { dispatchPiRuntimeUserMessage, getOrCreatePiRuntime } = await import('@/app/lib/pi/live-runtime');
  const sessionId = await ensureManagedDelegatedSession(request);
  const runtime = await getOrCreatePiRuntime(sessionId, request.userId);
  const currentStatus = runtime.getStatus();
  if (currentStatus.canAbort || currentStatus.phase !== 'idle') {
    throw new Error('Target session is already running. Pick another session or wait for it to finish.');
  }

  const waitPromise = request.waitForResult && request.timeoutSeconds > 0
    ? waitForRuntimeIdle(runtime, request.timeoutSeconds)
    : null;

  await dispatchPiRuntimeUserMessage(
    sessionId,
    request.userId,
    buildDelegationPrompt(request),
    undefined,
    runtime,
  );

  if (!waitPromise) {
    return {
      status: 'accepted',
      worker_type: 'managed',
      source_agent_id: request.sourceAgentId,
      target_agent_id: request.targetAgentId,
      session_id: sessionId,
      role: request.workerRole,
      wait_for_result: false,
      timeout_seconds: request.timeoutSeconds,
    };
  }

  const completion = await waitPromise;
  if (completion.status === 'ok') {
    return {
      status: 'ok',
      worker_type: 'managed',
      source_agent_id: request.sourceAgentId,
      target_agent_id: request.targetAgentId,
      session_id: sessionId,
      role: request.workerRole,
      wait_for_result: true,
      timeout_seconds: request.timeoutSeconds,
      reply: latestAssistantReply(runtime),
    };
  }

  return {
    status: completion.status,
    worker_type: 'managed',
    source_agent_id: request.sourceAgentId,
    target_agent_id: request.targetAgentId,
    session_id: sessionId,
    role: request.workerRole,
    wait_for_result: true,
    timeout_seconds: request.timeoutSeconds,
    error: completion.error || 'Delegated task did not finish before timeout.',
  };
}

export async function startDelegatedRun(request: DelegateTaskRequest): Promise<DelegateTaskResult> {
  if (request.targetAgentId) {
    return startManagedDelegatedRun(request);
  }
  return startEphemeralDelegatedRun(request);
}

function formatDelegateTaskResult(result: DelegateTaskResult): string {
  const workerLabel = result.worker_type === 'managed'
    ? result.target_agent_id || 'managed agent'
    : `ephemeral ${result.role || 'worker'}`;
  if (result.status === 'accepted') {
    return `Delegated task accepted by ${workerLabel} in session ${result.session_id}.`;
  }
  if (result.status === 'ok') {
    return [
      `Delegated task completed by ${workerLabel} in session ${result.session_id}.`,
      result.reply ? `Reply:\n${result.reply}` : 'No assistant reply was produced.',
    ].join('\n\n');
  }
  return `Delegated task ${result.status} in session ${result.session_id}: ${result.error || 'Unknown error'}`;
}

export function createDelegateTaskTool(deps: {
  userId?: string;
  sourceAgentId?: string | null;
  startDelegatedRunFn?: (request: DelegateTaskRequest) => Promise<DelegateTaskResult>;
} = {}): AgentTool {
  return {
    name: 'delegate_task',
    label: 'Delegating task',
    description:
      'Spawn a short-lived subagent for a focused task. By default this creates an ephemeral worker from goal/context/toolsets, ' +
      'with no parent history and no recursive delegate_task access. Optionally set target_agent_id to send the task to an existing managed Canvas Agent.',
    parameters: Type.Object({
      target_agent_id: Type.Optional(Type.String({ description: 'Optional managed target agent ID. Omit to spawn an ephemeral worker.' })),
      goal: Type.String({ description: 'The concrete task the worker should complete.' }),
      context: Type.Optional(Type.String({ description: 'Relevant context to pass to the worker. The parent chat history is not included automatically.' })),
      role: Type.Optional(Type.String({ description: 'Short worker role hint, e.g. researcher, coder, reviewer, planner. Ephemeral workers only.' })),
      toolsets: Type.Optional(Type.Array(Type.String(), { description: `Ephemeral worker toolsets. Defaults to ${DEFAULT_EPHEMERAL_TOOLSETS.join(', ')}.` })),
      session_id: Type.Optional(Type.String({ description: 'Optional existing session ID. Only supported together with target_agent_id.' })),
      wait_for_result: Type.Optional(Type.Boolean({ description: 'Wait for the worker final reply. Default true. Set false for background fire-and-forget.' })),
      timeout_seconds: Type.Optional(Type.Number({ description: 'Max seconds to wait when wait_for_result is true. Default 120, max 600. Use 0 to start in background.' })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        if (!deps.userId) {
          throw new Error('User ID is required for delegate_task.');
        }
        const args = (params || {}) as DelegateTaskArgs;
        const sourceAgentId = normalizeAgentId(deps.sourceAgentId);
        if (sourceAgentId !== DEFAULT_AGENT_ID) {
          throw new Error('Only the main Canvas Agent can use delegate_task.');
        }

        const targetAgentId = args.target_agent_id?.trim()
          ? normalizeManagedAgentId(args.target_agent_id)
          : undefined;
        if (targetAgentId === sourceAgentId) {
          throw new Error('delegate_task requires a different target_agent_id when target_agent_id is set.');
        }

        const goal = args.goal?.trim();
        if (!goal) {
          throw new Error('goal is required.');
        }

        if (targetAgentId) {
          const targetAgent = await getAgentProfile(targetAgentId);
          if (!targetAgent) {
            throw new Error(`Target agent "${targetAgentId}" not found.`);
          }
        }

        const timeoutSeconds = clampTimeoutSeconds(args.timeout_seconds);
        const waitForResult = args.wait_for_result === false || timeoutSeconds === 0 ? false : true;
        const request: DelegateTaskRequest = {
          userId: deps.userId,
          sourceAgentId,
          targetAgentId,
          goal,
          context: args.context?.trim() || undefined,
          sessionId: args.session_id?.trim() || undefined,
          workerRole: args.role?.trim() || undefined,
          toolsets: normalizeToolsets(args.toolsets),
          waitForResult,
          timeoutSeconds,
        };

        const result = await (deps.startDelegatedRunFn || startDelegatedRun)(request);
        return {
          content: [{ type: 'text', text: formatDelegateTaskResult(result) }],
          details: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown delegate_task error';
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { status: 'error', error: message },
        };
      }
    },
  };
}
