import 'server-only';

import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { projectChatBodyText } from '@/app/lib/chat/chat-body-contracts';
import { contentToString, extractMessageAttachments, stripAttachmentBlocks } from '@/app/lib/chat/message-content';
import type { ChatQueueBlocker, ChatQueueRecoveryStatus } from '@/app/lib/chat/queue-recovery';
import type { RuntimeQueueItem } from '@/app/lib/chat/runtime-status';
import { readOwnedAcceptedChatMessage, readOwnedAcceptedChatMessageQueue, readOwnedChatMessageExecutionSnapshot,
  type OwnedAcceptedChatMessage, type OwnedAcceptedChatMessageQueue } from './durable-message-admission';
import { cancelOwnedQueuedChatMessages, resumeOwnedQueuedChatMessages } from './durable-message-queue';
import { withPiSessionOperationLock } from './session-operation-lock';

export type ChatQueueRecoveryIdentity = { userId: string; sessionId: string; expectedWorkspaceId: string };
type RecoveryAction = { action: 'resume' | 'cancel'; queueItemId: string; executionRevision: number };

function invalid(): never {
  throw new AgentWorkflowError('CHAT_QUEUE_RECOVERY_INVALID', 'Choose one exact queued message and its current revision.', 400);
}
function conflict(): never {
  throw new AgentWorkflowError('MESSAGE_EXECUTION_CONFLICT', 'The queued message changed. Refresh its current state before continuing.', 409);
}
function plainData(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), result = Object.create(null);
  if (Object.keys(descriptors).length !== keys.length) invalid();
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function exactId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || value !== value.trim() || /[\p{Cc}\p{Cf}]/u.test(value)) invalid();
  return value;
}
function captureIdentity(value: ChatQueueRecoveryIdentity): ChatQueueRecoveryIdentity {
  const data = plainData(value, ['userId', 'sessionId', 'expectedWorkspaceId']);
  return { userId: exactId(data.userId), sessionId: exactId(data.sessionId), expectedWorkspaceId: exactId(data.expectedWorkspaceId) };
}
function captureAction(value: unknown): RecoveryAction {
  const data = plainData(value, ['action', 'queueItemId', 'executionRevision']);
  if (!['resume', 'cancel'].includes(data.action as string) || !Number.isSafeInteger(data.executionRevision)
    || (data.executionRevision as number) < 1) invalid();
  return { action: data.action as RecoveryAction['action'], queueItemId: exactId(data.queueItemId),
    executionRevision: data.executionRevision as number };
}

/** Builds a safe original-message preview; this DTO cannot be used to execute. */
export function projectOwnedQueuedChatMessage(message: OwnedAcceptedChatMessage): RuntimeQueueItem {
  const { payload, executionRevision, queue, phase, runtimeToken } = readOwnedChatMessageExecutionSnapshot(message);
  if (phase !== 'queued' || runtimeToken !== 'unclaimed') conflict();
  const attachments = extractMessageAttachments(payload.message.content) ?? [];
  const images = Array.isArray(payload.message.content)
    ? payload.message.content.filter(part => part.type === 'image').length : 0;
  return { id: payload.serverMessageId, clientMessageId: payload.clientMessageId,
    text: payload.body ? projectChatBodyText(payload.body) : stripAttachmentBlocks(contentToString(payload.message.content)),
    messageTimestamp: payload.message.timestamp, executionRevision, queue: queue ? { ...queue } : null,
    attachments, attachmentCount: Math.max(attachments.length, images),
    ...(payload.body === undefined ? {} : { body: structuredClone(payload.body) }) };
}

function projectQueue(sessionId: string, current: OwnedAcceptedChatMessageQueue, activeId?: string): ChatQueueRecoveryStatus {
  const items: RuntimeQueueItem[] = [], blocked: ChatQueueBlocker[] = [...current.blocked];
  for (const message of current.messages) {
    const snapshot = readOwnedChatMessageExecutionSnapshot(message);
    if (snapshot.phase === 'queued') items.push(projectOwnedQueuedChatMessage(message));
    else if (['dispatching', 'running'].includes(snapshot.phase) && snapshot.payload.serverMessageId !== activeId) {
      blocked.push({ clientMessageId: snapshot.payload.clientMessageId, reason: 'execution_in_progress' });
    }
  }
  items.sort((left, right) => (left.queue?.ordinal ?? Number.MAX_SAFE_INTEGER) - (right.queue?.ordinal ?? Number.MAX_SAFE_INTEGER));
  return { sessionId, items, blocked };
}

/** SQL/Use only. Reading never initializes a model, claims or resumes a message. */
export async function getChatQueueRecovery(input: ChatQueueRecoveryIdentity): Promise<ChatQueueRecoveryStatus> {
  const identity = captureIdentity(input);
  const { getResolvedPiRuntime } = await import('./live-runtime');
  const current = await readOwnedAcceptedChatMessageQueue(identity);
  const existing = await getResolvedPiRuntime(identity.sessionId, identity.userId);
  return projectQueue(identity.sessionId, current, existing?.getActiveDurableMessageId());
}

/** One explicit user operation. A lost response is reconciled by GET, never an automatic POST retry. */
export async function controlChatQueueRecovery(input: ChatQueueRecoveryIdentity, value: unknown) {
  const identity = captureIdentity(input), action = captureAction(value);
  const execute = async () => {
    const current = await readOwnedAcceptedChatMessageQueue(identity);
    const owned = current.messages.find(message => readOwnedChatMessageExecutionSnapshot(message).payload.serverMessageId === action.queueItemId);
    if (!owned) conflict();
    const original = readOwnedChatMessageExecutionSnapshot(owned);
    if (original.phase !== 'queued' || original.runtimeToken !== 'unclaimed' || original.executionRevision !== action.executionRevision) conflict();
    const { getResolvedPiRuntime, getOrCreatePiRuntimeWithState } = await import('./live-runtime');
    const existing = await getResolvedPiRuntime(identity.sessionId, identity.userId);
    if (action.action === 'cancel') {
      await cancelOwnedQueuedChatMessages([owned]);
      // Confirmed SQL cancellation does not depend on a RAM/model projection.
      if (existing) await existing.refreshOwnedQueue().catch(() => undefined);
      return { queue: await getChatQueueRecovery(identity) };
    }
    const projected = projectQueue(identity.sessionId, current, existing?.getActiveDurableMessageId());
    if (projected.blocked.some(blocker => blocker.reason !== 'unknown_queue_position')) {
      throw new AgentWorkflowError('MESSAGE_EXECUTION_UNCERTAIN', 'Check the unresolved earlier execution in the chat. It cannot be repeated or resumed.', 409);
    }
    let expectedRevision = original.executionRevision;
    if (!original.queue || original.queue.disposition === 'suspended') {
      const [updated] = await resumeOwnedQueuedChatMessages([owned]);
      expectedRevision = updated.executionRevision;
    }
    const fresh = await readOwnedAcceptedChatMessage({ ...identity, clientMessageId: original.payload.clientMessageId,
      expectedAgentId: original.payload.identity.agentId });
    if (!fresh) conflict();
    const snapshot = readOwnedChatMessageExecutionSnapshot(fresh);
    if (snapshot.phase !== 'queued' || snapshot.runtimeToken !== 'unclaimed'
      || snapshot.executionRevision !== expectedRevision || snapshot.queue?.disposition !== 'ready') conflict();
    const { runtime } = await getOrCreatePiRuntimeWithState(identity.sessionId, identity.userId, { metadataOnlyExternal: true });
    if (runtime.agentId !== snapshot.payload.identity.agentId) conflict();
    const status = await runtime.acceptOwnedMessage(fresh);
    return { queue: await getChatQueueRecovery(identity), status };
  };
  // Cancellation has its own actual SQL session/receipt locks and may race a
  // claim safely. A stalled model initializer holding the runtime-operation
  // lock must not prevent cancellation of a still-unclaimed stored message.
  return action.action === 'cancel' ? execute()
    : withPiSessionOperationLock(identity.sessionId, identity.userId, execute);
}
