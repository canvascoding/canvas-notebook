import 'server-only';

import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';

import { loadPiSession } from '@/app/lib/pi/session-store';
import type { DelegateTaskRequest } from '@/app/lib/pi/delegate-task-tool';

export type RuntimeInstance = {
  agentId: string;
  agent: {
    state: { messages: AgentMessage[] };
    subscribe: (subscriber: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>) => () => void;
  };
  getStatus: () => { phase: string; canAbort: boolean; steeringQueue?: Array<{ id: string; clientMessageId?: string }> };
  subscribe: (subscriber: (event: { type: string; status?: { phase: string; canAbort: boolean }; error?: string }) => void) => () => void;
  abort: () => Promise<unknown>;
  reloadTools: () => Promise<void>;
  startPrompt: (message: Extract<AgentMessage, { role: 'user' }>) => void;
  queueSteering: (message: Extract<AgentMessage, { role: 'user' }>) => Promise<unknown>;
  removeQueuedMessage: (id: string) => Promise<unknown>;
};

export function extractMessageText(message: AgentMessage): string {
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

/** Tie a managed runtime's SDK queue to a durable, owner-fenced correction receipt. */
export function attachManagedSteeringBridge(
  runtime: RuntimeInstance,
  request: DelegateTaskRequest,
  sessionId: string,
): () => Promise<void> {
  if (!request.delegationId || !request.runOwnerId) return async () => {};
  const delegationId = request.delegationId;
  const runOwnerId = request.runOwnerId;
  const pending = new Map<string, string>();
  let closed = false;
  let polling: Promise<void> | null = null;
  const poll = async () => {
    if (closed || request.abortSignal?.aborted || !runtime.getStatus().canAbort) return;
    try {
      const { claimNextPiDelegationSteering } = await import('@/app/lib/pi/delegation-steering');
      const command = await claimNextPiDelegationSteering({ delegationId, userId: request.userId, runOwnerId });
      if (!command || closed) return;
      const marker = `[delegation-steer:${command.id}]`;
      const message = {
        role: 'user' as const,
        content: `${marker}\nCorrection for this delegated task:\n${command.message}`,
        timestamp: Date.now(),
        clientMessageId: command.id,
      };
      pending.set(command.id, marker);
      try {
        await runtime.queueSteering(message);
      } catch (error) {
        pending.delete(command.id);
        throw error;
      }
    } catch {
      // A claimed command is reported as missed if the run ends before the
      // runtime can take it. Polling must never fail the worker itself.
    }
  };
  const schedulePoll = () => {
    if (polling) return;
    polling = poll().catch(() => {}).finally(() => { polling = null; });
  };

  // LivePiRuntime's listener is registered first and checkpoints turn_end.
  // Check the stored user message before confirming an actual delivery.
  const unsubscribe = runtime.agent.subscribe(async (event) => {
    if (event.type !== 'turn_end' || pending.size === 0) return;
    try {
      const messages = await loadPiSession(sessionId, request.userId, request.targetAgentId);
      if (!messages) return;
      const { confirmPiDelegationSteeringDelivered } = await import('@/app/lib/pi/delegation-steering');
      for (const [id, marker] of pending) {
        if (!messages.some((message) => message.role === 'user' && extractMessageText(message).includes(marker))) continue;
        const receipt = await confirmPiDelegationSteeringDelivered({ id, delegationId, userId: request.userId, runOwnerId });
        if (receipt?.status === 'delivered') pending.delete(id);
      }
    } catch {
      // Receipt persistence is retried at the next confirmed turn boundary.
    }
  });
  const timer = setInterval(schedulePoll, 500);
  timer.unref?.();
  schedulePoll();
  return async () => {
    closed = true;
    clearInterval(timer);
    await polling;
    unsubscribe();
    const queued = runtime.getStatus().steeringQueue ?? [];
    for (const [id] of pending) {
      const entry = queued.find((item) => item.clientMessageId === id);
      if (entry) {
        try { await runtime.removeQueuedMessage(entry.id); } catch { /* Runtime already closed. */ }
      }
    }
  };
}
