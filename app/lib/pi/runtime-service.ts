import 'server-only';

import fs from 'node:fs/promises';
import path from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { openDb } from '@/app/lib/db';
import { AgentWorkflowError, isAgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import type { AgentExecutionContext } from './agent-execution-context';
import type { ChatMessageSubmissionOptions } from '@/app/lib/chat/message-submission';
import { captureChatMessageAdmissionRequest, type CapturedChatMessageAdmissionRequest } from '@/app/lib/chat/durable-message-contracts';
import { prepareChatMessageAdmission, commitPreparedChatMessageAdmission, commitPreparedChatMessageReplacement,
  readOwnedAcceptedChatMessageQueue, readOwnedChatMessageExecutionSnapshot, type OwnedAcceptedChatMessage } from './durable-message-admission';

import type {
  ChatRequestContext,
  NotebookRequestActiveSurface,
  NotebookRequestContext,
  TodoChatContext,
} from '@/app/lib/chat/types';
import {
  getExistingPiRuntimeStatuses,
  getExistingPiRuntime,
  getOrCreatePiRuntime,
  getOrCreatePiRuntimeWithState,
  getPiRuntimeStatus,
  invalidatePiRuntime,
  type PiRuntimeStatus,
} from '@/app/lib/pi/live-runtime';
import { applyPiRuntimePromptContext } from '@/app/lib/pi/runtime-prompt-context';
import { getStudioOutputsRoot, resolveStudioFilePath } from '@/app/lib/integrations/studio-workspace';
import { canReadStudioOutputPath } from '@/app/lib/integrations/studio-generation-service';
import { createPersistedStudioScope } from '@/app/lib/integrations/studio-scope';
import { assertMessageUploadReferences, compactImageBufferForLlm } from '@/app/lib/pi/message-normalization';
import { normalizeTimeZone } from '@/app/lib/time-zones';
import { getServerPreferredTimeZone } from '@/app/lib/server-settings';
import {
  readStoredAgentWorkspaceOnConnection,
  workspaceToChatRequestWorkspace,
} from '@/app/lib/pi/session-workspace-context';
import { MessageDeliveryError } from '@/app/lib/pi/message-delivery-receipt';
import { withPiSessionOperationLock } from '@/app/lib/pi/session-operation-lock';
import { createOperationTiming } from '@/app/lib/observability/operation-timing';
import {
  getTodo,
  TODO_PRIORITIES,
  TODO_STATUSES,
  TODO_WORKSPACE_TYPES,
} from '@/app/lib/todos/store';

export type UserAgentMessage = Extract<AgentMessage, { role: 'user' }> & { clientMessageId?: string };

export type ControlAction = 'follow_up' | 'steer' | 'promote_queued_to_steer' | 'remove_queued_item' | 'abort' | 'replace' | 'compact';

export type SessionRuntimeStatusSummary = {
  phase: PiRuntimeStatus['phase'];
  activeToolName: string | null;
};

type RuntimeInstance = Awaited<ReturnType<typeof getOrCreatePiRuntime>>;

const STUDIO_IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export class RuntimeServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
  ) {
    super(message);
    this.name = 'RuntimeServiceError';
  }
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown agent error';
}

export function getErrorStatusCode(error: unknown): number {
  return isAgentWorkflowError(error) ? error.status
    : error instanceof RuntimeServiceError || error instanceof MessageDeliveryError ? error.statusCode : 500;
}

export function isValidUserMessage(message: unknown): message is UserAgentMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as AgentMessage;
  if (candidate.role !== 'user') {
    return false;
  }

  return typeof candidate.content === 'string' || Array.isArray(candidate.content);
}

export function resolvePromptMessage(payload: unknown): UserAgentMessage | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if ('message' in payload && isValidUserMessage(payload.message)) {
    return payload.message;
  }

  if (!('messages' in payload) || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return null;
  }

  const lastMessage = payload.messages[payload.messages.length - 1];
  return isValidUserMessage(lastMessage) ? lastMessage : null;
}

export function resolveChatRequestContext(payload: unknown): ChatRequestContext {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  const record = payload as Record<string, unknown>;
  return record.context && typeof record.context === 'object'
    ? record.context as ChatRequestContext
    : record as ChatRequestContext;
}

function normalizeNotebookPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/\\/gu, '/')
    .replace(/^\.\/+|\/+$/gu, '')
    .trim();
  return normalized ? normalized.slice(0, 1_024) : null;
}

function normalizeNotebookActiveSurface(value: unknown): NotebookRequestActiveSurface | null {
  if (!value || typeof value !== 'object') return null;
  const surface = value as Record<string, unknown>;
  if (surface.kind === 'browser' || surface.kind === 'email') {
    return { kind: surface.kind };
  }
  if (surface.kind === 'document') {
    const path = normalizeNotebookPath(surface.path);
    return path ? { kind: 'document', path } : null;
  }
  return null;
}

function normalizeNotebookRequestContext(value: unknown): NotebookRequestContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const context = value as Record<string, unknown>;
  const chatPlacement = context.chatPlacement;
  if (
    chatPlacement !== 'full'
    && chatPlacement !== 'hidden'
    && chatPlacement !== 'overlay'
    && chatPlacement !== 'side'
  ) {
    return undefined;
  }

  const activeSurface = chatPlacement === 'side'
    ? normalizeNotebookActiveSurface(context.activeSurface)
    : null;
  const openDocuments: NotebookRequestContext['openDocuments'] = [];
  if (Array.isArray(context.openDocuments)) {
    for (const candidate of context.openDocuments) {
      if (!candidate || typeof candidate !== 'object') continue;
      const path = normalizeNotebookPath((candidate as Record<string, unknown>).path);
      if (!path || openDocuments.some((document) => document.path === path)) continue;
      openDocuments.push({
        path,
        state: activeSurface?.kind === 'document' && activeSurface.path === path
          ? 'active'
          : 'background',
      });
      if (openDocuments.length === 8) break;
    }
  }

  return { activeSurface, chatPlacement, openDocuments };
}

function normalizeTodoContextId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}

function normalizeTodoStatus(value: unknown): TodoChatContext['status'] {
  return typeof value === 'string'
    ? TODO_STATUSES.find((status) => status === value)
    : undefined;
}

function normalizeTodoPriority(value: unknown): TodoChatContext['priority'] {
  return typeof value === 'string'
    ? TODO_PRIORITIES.find((priority) => priority === value)
    : undefined;
}

function normalizeTodoScopeKind(value: unknown): TodoChatContext['scopeKind'] {
  return value === 'user' || value === 'workspace' ? value : undefined;
}

function normalizeTodoWorkspaceType(value: unknown): NonNullable<TodoChatContext['workspace']>['type'] | undefined {
  return typeof value === 'string'
    ? TODO_WORKSPACE_TYPES.find((type) => type === value)
    : undefined;
}

async function normalizeTodoContext(
  value: unknown,
  userId: string,
): Promise<ChatRequestContext['todoContext'] | undefined> {
  if (!value || typeof value !== 'object') return undefined;
  const todoId = normalizeTodoContextId((value as Record<string, unknown>).todoId);
  if (!todoId) return undefined;

  try {
    // Never use client-supplied to-do metadata. getTodo performs the ownership
    // and workspace-access checks before returning the current record.
    const todo = await getTodo(userId, todoId);
    if (!todo) return undefined;

    return {
      todoId: todo.id,
      title: todo.title,
      description: todo.description,
      status: normalizeTodoStatus(todo.status),
      priority: normalizeTodoPriority(todo.priority),
      categoryName: todo.category?.name ?? null,
      scopeKind: normalizeTodoScopeKind(todo.scopeKind),
      workspace: todo.workspace ? {
        id: todo.workspace.id,
        name: todo.workspace.name,
        type: normalizeTodoWorkspaceType(todo.workspace.type) ?? 'personal',
      } : null,
      assignee: todo.assignee ? {
        id: todo.assignee.id,
        name: todo.assignee.name,
        email: todo.assignee.email,
      } : null,
      dueAt: todo.dueAt?.toISOString() ?? null,
      sourceSessionId: todo.sourceSessionId,
      fileLinks: todo.fileLinks.map((fileLink) => ({
        workspacePath: fileLink.workspacePath,
        label: fileLink.label,
      })),
    };
  } catch (error) {
    // A stale, inaccessible, or malformed selection must not block a chat
    // message. The selected-to-do context is optional and is simply omitted.
    console.warn('[RuntimeService] Skipping unavailable selected todo context:', {
      userId,
      todoId,
      error: getErrorMessage(error),
    });
    return undefined;
  }
}

/** Stored assignments only: this read never bootstraps or changes a session. */
async function readSubmissionWorkspace(userId: string, sessionId: string,
  target: { expectedAgentId?: string; expectedWorkspaceId?: string } = {}) {
  const database = await openDb();
  try {
    const sessions = await database.all(`SELECT agent_id,workspace_id FROM pi_sessions
      WHERE user_id=$1 AND session_id=$2 AND archived_at IS NULL LIMIT 2`, [userId, sessionId]) as
      { agent_id: string | null; workspace_id: string | null }[];
    const session = sessions[0];
    if (sessions.length !== 1 || !session?.agent_id || !session.workspace_id
      || target.expectedAgentId !== undefined && session.agent_id !== target.expectedAgentId
      || target.expectedWorkspaceId !== undefined && session.workspace_id !== target.expectedWorkspaceId) {
      throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'The originating chat context is unavailable.', 403);
    }
    const workspace = await readStoredAgentWorkspaceOnConnection(database, { userId, sessionId,
      agentId: session.agent_id, workspaceId: session.workspace_id, permissions: ['canRead', 'canRunAgent'] });
    return { agentId: session.agent_id, workspace };
  } finally { await database.close(); }
}

async function normalizeContext(
  context: ChatRequestContext | undefined,
  userId: string,
  sessionId: string,
  target?: { expectedAgentId?: string; expectedWorkspaceId?: string },
): Promise<ChatRequestContext> {
  const stored = await readSubmissionWorkspace(userId, sessionId, target);
  if (context?.workspace && (context.workspace.workspaceId !== stored.workspace.workspaceId
    || context.workspace.organizationId !== undefined
      && context.workspace.organizationId !== (stored.workspace.organizationId ?? null))) {
    throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'The message belongs to a different workspace.', 403);
  }
  let userTimeZone: string;
  try {
    userTimeZone = await getServerPreferredTimeZone();
  } catch (error) {
    console.warn('[RuntimeService] Failed to resolve user time zone preference:', getErrorMessage(error));
    userTimeZone = normalizeTimeZone(context?.userTimeZone);
  }
  const todoContext = await normalizeTodoContext(context?.todoContext, userId);
  return {
    ...(typeof context?.channelId === 'string' ? { channelId: context.channelId } : {}),
    userTimeZone,
    currentTime: typeof context?.currentTime === 'string' ? context.currentTime : new Date().toISOString(),
    activeFilePath: typeof context?.activeFilePath === 'string' ? context.activeFilePath : null,
    ...(typeof context?.workingDirectory === 'string' ? { workingDirectory: context.workingDirectory } : {}),
    workspace: workspaceToChatRequestWorkspace(stored.workspace),
    planningMode: context?.planningMode === true,
    ...(typeof context?.currentPage === 'string' ? { currentPage: context.currentPage } : {}),
    ...(todoContext ? { todoContext } : {}),
    ...(context?.notebookContext ? { notebookContext: normalizeNotebookRequestContext(context.notebookContext) } : {}),
    ...(context?.studioContext ? { studioContext: context.studioContext } : {}),
    ...(context?.emailContext ? { emailContext: context.emailContext } : {}),
  };
}

function resolveStudioOutputImage(outputFilePath: string): { imagePath: string; mimeType: string } | null {
  const imagePath = resolveStudioFilePath(outputFilePath, getStudioOutputsRoot());
  if (!imagePath) return null;

  const mimeType = STUDIO_IMAGE_MIME_BY_EXTENSION[path.extname(imagePath).toLowerCase()];
  return mimeType ? { imagePath, mimeType } : null;
}

async function injectStudioImage(
  message: UserAgentMessage | null,
  context: ChatRequestContext,
  userId: string,
): Promise<UserAgentMessage | null> {
  if (!message || !context.studioContext?.outputFilePath) {
    return message;
  }

  try {
    if (!context.workspace?.organizationId) {
      console.warn('[RuntimeService] Skipping Studio image without persisted workspace context.');
      return message;
    }
    const scope = createPersistedStudioScope({
      actorUserId: userId,
      organizationId: context.workspace.organizationId,
      workspaceId: context.workspace.workspaceId,
    });
    const resolved = resolveStudioOutputImage(context.studioContext.outputFilePath);
    if (!resolved) {
      console.warn('[RuntimeService] Skipping invalid studio image reference:', {
        outputFilePath: context.studioContext.outputFilePath,
      });
      return message;
    }

    if (!(await canReadStudioOutputPath(context.studioContext.outputFilePath, scope))) {
      console.warn('[RuntimeService] Skipping unauthorized studio image reference:', {
        outputFilePath: context.studioContext.outputFilePath,
        userId,
      });
      return message;
    }

    const stats = await fs.stat(resolved.imagePath);
    if (!stats.isFile()) {
      return message;
    }

    // Resolve authorized Studio output to image bytes now. Persisting an
    // arbitrary server path in the chat transcript would otherwise allow it to
    // be re-read on every future model turn.
    const imageContent = await compactImageBufferForLlm(
      await fs.readFile(resolved.imagePath),
      path.basename(resolved.imagePath),
      resolved.mimeType,
    );

    if (typeof message.content === 'string') {
      return {
        ...message,
        content: [
          { type: 'text' as const, text: message.content },
          imageContent,
        ],
      };
    }

    if (Array.isArray(message.content)) {
      return {
        ...message,
        content: [
          ...message.content,
          imageContent,
        ],
      };
    }
  } catch (error) {
    console.error('[RuntimeService] Failed to inject studio image:', {
      error: getErrorMessage(error),
      outputFilePath: context.studioContext.outputFilePath,
    });
  }

  return message;
}

/** Reconstruct internal completion presentation from its actual terminal record, never caller metadata. */
export async function attachAcceptedRuntimeMessageMetadata(message: UserAgentMessage,
  context: Pick<AgentExecutionContext, 'userId' | 'sessionId' | 'agentId'>): Promise<UserAgentMessage> {
  const clean = { ...message, delegationCompletion: undefined };
  const prefix = 'delegation-completion:';
  if (!message.clientMessageId?.startsWith(prefix) || !context.agentId) return clean;
  const { getOwnedPiDelegation } = await import('./delegation-store');
  const record = await getOwnedPiDelegation(message.clientMessageId.slice(prefix.length), context.userId);
  if (!record || record.sourceSessionId !== context.sessionId || record.sourceAgentId !== context.agentId
    || !['completed', 'failed', 'cancelled'].includes(record.status)) return clean;
  const { createDelegationCompletionMessage } = await import('./delegation-completion-message');
  const completion = createDelegationCompletionMessage(record, message.timestamp);
  if (completion.content !== message.content) return clean;
  return { ...clean, delegationCompletion: completion.delegationCompletion } as UserAgentMessage;
}

/** Hydrate only after the runtime has acquired a fresh execution claim and exact turn source. */
export async function prepareAcceptedRuntimePrompt(message: UserAgentMessage, context: ChatRequestContext,
  executionContext: AgentExecutionContext): Promise<{ message: UserAgentMessage; context: ChatRequestContext }> {
  if (!executionContext.agentId) throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'The originating agent is unavailable.', 403);
  const normalized = await normalizeContext(context, executionContext.userId, executionContext.sessionId,
    { expectedAgentId: executionContext.agentId, expectedWorkspaceId: executionContext.workspaceId });
  await assertMessageUploadReferences(message, { uploadOwnerUserId: executionContext.userId,
    uploadWorkspaceId: executionContext.workspaceId });
  const hydrated = await injectStudioImage(message, normalized, executionContext.userId);
  return { message: await attachAcceptedRuntimeMessageMetadata(hydrated ?? message, executionContext), context: normalized };
}

/** Inspect positional legacy transport objects without evaluating a getter. */
function submissionData(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length) throw new RuntimeServiceError('Plain message data is required.', 400);
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!allowedKeys.includes(key) || !('value' in descriptor) || !descriptor.enumerable)
      throw new RuntimeServiceError('Message data properties are required.', 400);
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
  }
  return result;
}

function captureSubmission(sessionId: string, userId: string, message: unknown, context: ChatRequestContext | undefined,
  mode: 'message' | 'steer', submission?: ChatMessageSubmissionOptions,
  target?: { expectedAgentId?: string | null }): CapturedChatMessageAdmissionRequest {
  try {
    const fields = submissionData(message, ['role', 'content', 'timestamp', 'clientMessageId', 'delegationCompletion']);
    const options = submission === undefined ? {} : submissionData(submission,
      ['body', 'selection', 'expectedAgentId', 'expectedWorkspaceId']);
    const oldTarget = target === undefined ? {} : submissionData(target, ['expectedAgentId']);
    if (oldTarget.expectedAgentId !== undefined && options.expectedAgentId !== undefined
      && oldTarget.expectedAgentId !== options.expectedAgentId) throw new Error('The message targets disagree.');
    // The completion payload is already in content. Its UI marker is freshly
    // reconstructed from the actual owned delegation record during dispatch.
    return captureChatMessageAdmissionRequest({ userId, sessionId, clientMessageId: fields.clientMessageId,
      message: { role: fields.role, content: fields.content, timestamp: fields.timestamp }, mode,
      ...(context === undefined ? {} : { context }), ...options,
      ...(oldTarget.expectedAgentId === undefined ? {} : { expectedAgentId: oldTarget.expectedAgentId }) });
  } catch {
    throw new AgentWorkflowError('AGENT_MESSAGE_ADMISSION_INVALID', 'A bounded user message and stable client message ID are required.', 400);
  }
}

async function replayAcceptedMessage(owned: OwnedAcceptedChatMessage): Promise<PiRuntimeStatus | null> {
  const { payload } = readOwnedChatMessageExecutionSnapshot(owned);
  // SQL Use/payload validation was performed by the admission reader. Never
  // instantiate a runtime, resolve model/tools, or re-run replace on replay.
  const runtime = await getExistingPiRuntime(payload.identity.sessionId, payload.identity.userId);
  if (!runtime) return null;
  if (runtime.agentId !== payload.identity.agentId) throw new RuntimeServiceError('The active runtime belongs to a different agent.', 409);
  return runtime.refreshOwnedQueue();
}

async function submitCapturedMessage(captured: CapturedChatMessageAdmissionRequest,
  action: 'message' | 'follow_up' | 'steer' | 'replace'): Promise<PiRuntimeStatus | null> {
  return withPiSessionOperationLock(captured.sessionId, captured.userId, async () => {
    const prepared = await prepareChatMessageAdmission(captured);
    if (prepared.kind === 'replay') return replayAcceptedMessage(prepared.message);
    const stored = await readSubmissionWorkspace(captured.userId, captured.sessionId, captured);
    await assertMessageUploadReferences(captured.message, { uploadOwnerUserId: captured.userId,
      uploadWorkspaceId: stored.workspace.workspaceId });
    let cancelled: Awaited<ReturnType<typeof commitPreparedChatMessageReplacement>>['cancelled'] | undefined;
    let owned: OwnedAcceptedChatMessage;
    if (action === 'replace') {
      const queue = await readOwnedAcceptedChatMessageQueue({ userId: captured.userId, sessionId: captured.sessionId,
        expectedAgentId: stored.agentId, expectedWorkspaceId: stored.workspace.workspaceId });
      const targets = queue.messages.filter(candidate => {
        const snapshot = readOwnedChatMessageExecutionSnapshot(candidate);
        return snapshot.phase === 'queued' && snapshot.runtimeToken === 'unclaimed';
      });
      const result = await commitPreparedChatMessageReplacement(prepared.admission, targets);
      owned = result.message; cancelled = result.cancelled;
    } else {
      owned = await commitPreparedChatMessageAdmission(prepared.admission,
        { lane: action === 'steer' ? 'steer' : action === 'follow_up' ? 'follow_up' : 'prompt' });
    }
    const snapshot = readOwnedChatMessageExecutionSnapshot(owned);
    // Another process may have committed/dispatched the same logical send after
    // prepare. It remains a replay, including the replace case.
    if (snapshot.phase !== 'queued' || snapshot.runtimeToken !== 'unclaimed') return replayAcceptedMessage(owned);
    const { runtime } = await getOrCreatePiRuntimeWithState(captured.sessionId, captured.userId,
      { metadataOnlyExternal: true, initialPlanningMode: captured.context.planningMode === true });
    if (runtime.agentId !== snapshot.payload.identity.agentId) throw new RuntimeServiceError('The active runtime belongs to a different agent.', 409);
    return runtime.acceptOwnedMessage(owned, action === 'replace' ? { cancelled, replace: true } : undefined);
  });
}

export async function prepareRuntimePrompt(
  sessionId: string,
  userId: string,
  payload: unknown,
): Promise<{
  runtimeInstance: RuntimeInstance;
  promptMessage: UserAgentMessage | null;
  status: PiRuntimeStatus;
  context: ChatRequestContext;
}> {
  const timing = createOperationTiming();
  const context = await normalizeContext(resolveChatRequestContext(payload), userId, sessionId);
  timing.mark('normalizeContext');
  const { runtime: runtimeInstance, created: runtimeCreated } = await getOrCreatePiRuntimeWithState(sessionId, userId, {
    initialPlanningMode: context.planningMode === true,
  });
  timing.mark('getOrCreateRuntime');
  const promptMessage = await injectStudioImage(resolvePromptMessage(payload), context, userId);
  timing.mark('injectStudioImage');
  let status = runtimeInstance.getStatus();

  if (!promptMessage && !status.canAbort) {
    throw new RuntimeServiceError('Prompt message required when no run is active.', 400);
  }

  applyPiRuntimePromptContext(runtimeInstance, context);
  if (!status.canAbort && !runtimeCreated) {
    await runtimeInstance.reloadTools();
  }
  if (!status.canAbort) {
    await runtimeInstance.reloadCompactionPolicyForNextRequest();
    status = runtimeInstance.getStatus();
  }
  await runtimeInstance.refreshWorkspaceFileTreePrompt();
  timing.mark('applyContextAndReloadTools');

  console.log('[RuntimeService] Runtime status:', {
    sessionId,
    phase: status.phase,
    contextWindow: status.contextWindow,
    hasStudioContext: !!context.studioContext,
    hasEmailContext: !!context.emailContext,
    hasTodoContext: !!context.todoContext,
    runtimeCreated,
    workspaceId: context.workspace?.workspaceId,
    workspaceType: context.workspace?.workspaceType,
    studioOutputPath: context.studioContext?.outputFilePath,
    timing: timing.snapshot(),
  });

  return {
    runtimeInstance,
    promptMessage,
    status,
    context,
  };
}

export async function sendMessage(
  sessionId: string,
  userId: string,
  message: UserAgentMessage | null,
  context?: ChatRequestContext,
  submission?: ChatMessageSubmissionOptions,
): Promise<PiRuntimeStatus | null> {
  if (message === null) {
    await readSubmissionWorkspace(userId, sessionId);
    return (await getExistingPiRuntime(sessionId, userId))?.getStatus() ?? null;
  }
  const captured = captureSubmission(sessionId, userId, message, context, 'message', submission);
  return submitCapturedMessage(captured, 'message');
}

export async function prewarmSessionRuntime(
  sessionId: string,
  userId: string,
): Promise<PiRuntimeStatus> {
  return withPiSessionOperationLock(sessionId, userId, async () => {
    const timing = createOperationTiming();
    const { runtime, created } = await getOrCreatePiRuntimeWithState(sessionId, userId, { metadataOnlyExternal: true });
    timing.mark('getOrCreateRuntime');
    const status = runtime.getStatus();

    console.log('[AgentRuntimeTiming] session_prewarmed', {
      sessionId,
      created,
      phase: status.phase,
      timing: timing.snapshot(),
    });
    return status;
  });
}

export async function sendFollowUpMessage(
  sessionId: string,
  userId: string,
  message: UserAgentMessage,
  context?: ChatRequestContext,
  target?: { expectedAgentId?: string | null },
  submission?: ChatMessageSubmissionOptions,
): Promise<PiRuntimeStatus | null> {
  const captured = captureSubmission(sessionId, userId, message, context, 'message', submission, target);
  return submitCapturedMessage(captured, 'follow_up');
}

export async function control(
  sessionId: string,
  userId: string,
  action: ControlAction,
  message?: unknown,
  queueItemId?: string,
  requestContext?: ChatRequestContext,
  focusTopic?: string,
  submission?: ChatMessageSubmissionOptions,
): Promise<PiRuntimeStatus | null> {
  if (action === 'follow_up' || action === 'steer' || action === 'replace') {
    const captured = captureSubmission(sessionId, userId, message, requestContext,
      action === 'steer' ? 'steer' : 'message', submission);
    return submitCapturedMessage(captured, action);
  }
  return withPiSessionOperationLock(sessionId, userId, async () => {
    // Queue/control commands do not install a new message's descriptive context.
    await readSubmissionWorkspace(userId, sessionId);
    const { runtime: runtimeInstance } = await getOrCreatePiRuntimeWithState(sessionId, userId, { metadataOnlyExternal: true });
    switch (action) {
      case 'promote_queued_to_steer':
      case 'remove_queued_item':
        if (typeof queueItemId !== 'string' || !queueItemId || queueItemId !== queueItemId.trim())
          throw new RuntimeServiceError('An exact queue item ID is required.', 400);
        return action === 'promote_queued_to_steer'
          ? runtimeInstance.promoteQueuedMessageToSteering(queueItemId)
          : runtimeInstance.removeQueuedMessage(queueItemId);
      case 'abort': return runtimeInstance.abort();
      case 'compact': return runtimeInstance.startCompaction(focusTopic);
      default: throw new RuntimeServiceError(`Unsupported action: ${String(action)}`, 400);
    }
  });
}

export async function getStatus(
  sessionId: string,
  userId: string,
): Promise<PiRuntimeStatus | null> {
  return getPiRuntimeStatus(sessionId, userId);
}

export async function getActiveRuntimeStatusSummaries({
  sessionIds,
  userId,
}: {
  sessionIds: string[];
  userId: string;
}): Promise<Record<string, SessionRuntimeStatusSummary>> {
  const statuses = await getExistingPiRuntimeStatuses(sessionIds, userId);
  const summaries: Record<string, SessionRuntimeStatusSummary> = {};

  for (const [sessionId, status] of statuses) {
    if (status.phase === 'idle') {
      continue;
    }

    summaries[sessionId] = {
      phase: status.phase,
      activeToolName: status.activeTool?.name ?? null,
    };
  }

  return summaries;
}

export async function invalidateRuntime(sessionId: string, userId: string): Promise<boolean> {
  return invalidatePiRuntime(sessionId, userId);
}

export async function withRuntimeSessionOperation<T>(
  sessionId: string,
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withPiSessionOperationLock(sessionId, userId, operation);
}
