import { type AgentMessage, type AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from 'typebox';
import { and, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { resolveAgentRuntimeConfig } from '@/app/lib/agents/effective-runtime-config';
import { getAgentProfile, normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { DEFAULT_PI_SESSION_TITLE } from '@/app/lib/pi/session-titles';

type DelegateTaskArgs = {
  target_agent_id?: string;
  goal?: string;
  context?: string;
  session_id?: string;
  wait_for_result?: boolean;
  timeout_seconds?: number;
};

export type DelegateTaskRequest = {
  userId: string;
  sourceAgentId: string;
  targetAgentId: string;
  goal: string;
  context?: string;
  sessionId?: string;
  waitForResult: boolean;
  timeoutSeconds: number;
};

export type DelegateTaskResult = {
  status: 'accepted' | 'ok' | 'timeout' | 'error';
  source_agent_id: string;
  target_agent_id: string;
  session_id: string;
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

function normalizeAgentId(agentId?: string | null): string {
  try {
    return normalizeManagedAgentId(agentId);
  } catch {
    return DEFAULT_AGENT_ID;
  }
}

function buildDelegatedSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

function latestAssistantReply(runtime: RuntimeInstance): string | undefined {
  for (let index = runtime.agent.state.messages.length - 1; index >= 0; index -= 1) {
    const message = runtime.agent.state.messages[index];
    if (message.role === 'assistant') {
      const text = extractMessageText(message);
      return text ? truncate(text, MAX_REPLY_CHARS) : undefined;
    }
  }
  return undefined;
}

function buildDelegationPrompt(request: DelegateTaskRequest): Extract<AgentMessage, { role: 'user' }> {
  const lines = [
    `Delegated task from agent "${request.sourceAgentId}".`,
    '',
    'Goal:',
    request.goal,
  ];

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

async function ensureDelegatedSession(request: DelegateTaskRequest): Promise<string> {
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

export async function startDelegatedRun(request: DelegateTaskRequest): Promise<DelegateTaskResult> {
  const { dispatchPiRuntimeUserMessage, getOrCreatePiRuntime } = await import('@/app/lib/pi/live-runtime');
  const sessionId = await ensureDelegatedSession(request);
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
      source_agent_id: request.sourceAgentId,
      target_agent_id: request.targetAgentId,
      session_id: sessionId,
      wait_for_result: false,
      timeout_seconds: request.timeoutSeconds,
    };
  }

  const completion = await waitPromise;
  if (completion.status === 'ok') {
    return {
      status: 'ok',
      source_agent_id: request.sourceAgentId,
      target_agent_id: request.targetAgentId,
      session_id: sessionId,
      wait_for_result: true,
      timeout_seconds: request.timeoutSeconds,
      reply: latestAssistantReply(runtime),
    };
  }

  return {
    status: completion.status,
    source_agent_id: request.sourceAgentId,
    target_agent_id: request.targetAgentId,
    session_id: sessionId,
    wait_for_result: true,
    timeout_seconds: request.timeoutSeconds,
    error: completion.error || 'Delegated task did not finish before timeout.',
  };
}

function formatDelegateTaskResult(result: DelegateTaskResult): string {
  if (result.status === 'accepted') {
    return `Delegated task accepted by ${result.target_agent_id} in session ${result.session_id}.`;
  }
  if (result.status === 'ok') {
    return [
      `Delegated task completed by ${result.target_agent_id} in session ${result.session_id}.`,
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
      'Delegate a focused task to another managed Canvas Agent. The child agent gets a fresh or specified session, ' +
      'does not receive the parent conversation automatically, and returns only its final reply to this tool call.',
    parameters: Type.Object({
      target_agent_id: Type.String({ description: 'Managed target agent ID, e.g. research-agent.' }),
      goal: Type.String({ description: 'The concrete task the target agent should complete.' }),
      context: Type.Optional(Type.String({ description: 'Relevant context to pass to the target agent. The parent chat history is not included automatically.' })),
      session_id: Type.Optional(Type.String({ description: 'Optional existing target-agent session ID. Omit to create a fresh delegated session.' })),
      wait_for_result: Type.Optional(Type.Boolean({ description: 'Wait for the target agent final reply. Default true. Set false for background fire-and-forget.' })),
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

        const targetAgentId = normalizeManagedAgentId(args.target_agent_id);
        if (targetAgentId === sourceAgentId) {
          throw new Error('delegate_task requires a different target_agent_id.');
        }

        const goal = args.goal?.trim();
        if (!goal) {
          throw new Error('goal is required.');
        }

        const targetAgent = await getAgentProfile(targetAgentId);
        if (!targetAgent) {
          throw new Error(`Target agent "${targetAgentId}" not found.`);
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
