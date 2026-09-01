import 'server-only';

import fs from 'node:fs/promises';
import path from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type {
  ChatRequestContext,
  NotebookRequestActiveSurface,
  NotebookRequestContext,
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
import {
  assertUnambiguousOwnedPiSessionForRuntime,
  PiSessionRuntimeAccessError,
} from '@/app/lib/pi/session-runtime-access';
import { applyPiRuntimePromptContext } from '@/app/lib/pi/runtime-prompt-context';
import { getStudioOutputsRoot, resolveStudioFilePath } from '@/app/lib/integrations/studio-workspace';
import { canReadStudioOutputPath } from '@/app/lib/integrations/studio-generation-service';
import { createPersistedStudioScope } from '@/app/lib/integrations/studio-scope';
import { compactImageBufferForLlm } from '@/app/lib/pi/message-normalization';
import { normalizeTimeZone } from '@/app/lib/time-zones';
import { getServerPreferredTimeZone } from '@/app/lib/server-settings';
import {
  ensurePiSessionWorkspaceSnapshot,
  requestedWorkspaceIdFromChatContext,
  workspaceToChatRequestWorkspace,
} from '@/app/lib/pi/session-workspace-context';
import { withPiSessionOperationLock } from '@/app/lib/pi/session-operation-lock';
import { createOperationTiming } from '@/app/lib/observability/operation-timing';

export type UserAgentMessage = Extract<AgentMessage, { role: 'user' }>;

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
  return error instanceof RuntimeServiceError ? error.statusCode : 500;
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

async function normalizeContext(
  context: ChatRequestContext | undefined,
  userId: string,
  sessionId: string,
): Promise<ChatRequestContext> {
  let userTimeZone: string;
  try {
    userTimeZone = await getServerPreferredTimeZone();
  } catch (error) {
    console.warn('[RuntimeService] Failed to resolve user time zone preference:', getErrorMessage(error));
    userTimeZone = normalizeTimeZone(context?.userTimeZone);
  }

  let workspace: ChatRequestContext['workspace'] | undefined;
  try {
    const resolvedWorkspace = await ensurePiSessionWorkspaceSnapshot({
      sessionId,
      userId,
      requestedWorkspaceId: requestedWorkspaceIdFromChatContext(context),
    });
    workspace = workspaceToChatRequestWorkspace(resolvedWorkspace);
  } catch (error) {
    console.warn('[RuntimeService] Failed to resolve session workspace context:', {
      sessionId,
      userId,
      error: getErrorMessage(error),
    });
  }

  return {
    channelId: typeof context?.channelId === 'string' ? context.channelId : undefined,
    userTimeZone,
    currentTime: typeof context?.currentTime === 'string' ? context.currentTime : new Date().toISOString(),
    activeFilePath: typeof context?.activeFilePath === 'string' ? context.activeFilePath : null,
    workingDirectory: typeof context?.workingDirectory === 'string' ? context.workingDirectory : undefined,
    workspace,
    planningMode: context?.planningMode === true,
    currentPage: typeof context?.currentPage === 'string' ? context.currentPage : undefined,
    notebookContext: normalizeNotebookRequestContext(context?.notebookContext),
    studioContext: context?.studioContext,
    emailContext: context?.emailContext,
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
  const { runtime: runtimeInstance, created: runtimeCreated } = await getOrCreatePiRuntimeWithState(sessionId, userId);
  timing.mark('getOrCreateRuntime');
  const promptMessage = await injectStudioImage(resolvePromptMessage(payload), context, userId);
  timing.mark('injectStudioImage');
  const status = runtimeInstance.getStatus();

  if (!promptMessage && !status.canAbort) {
    throw new RuntimeServiceError('Prompt message required when no run is active.', 400);
  }

  applyPiRuntimePromptContext(runtimeInstance, context);
  if (!status.canAbort && !runtimeCreated) {
    await runtimeInstance.reloadTools();
  }
  await runtimeInstance.refreshWorkspaceFileTreePrompt();
  timing.mark('applyContextAndReloadTools');

  console.log('[RuntimeService] Runtime status:', {
    sessionId,
    phase: status.phase,
    contextWindow: status.contextWindow,
    hasStudioContext: !!context.studioContext,
    hasEmailContext: !!context.emailContext,
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
): Promise<PiRuntimeStatus> {
  return withPiSessionOperationLock(sessionId, userId, async () => {
    const payload = {
      sessionId,
      ...(message ? { message, messages: [message] } : {}),
      context,
    };
    const prepared = await prepareRuntimePrompt(sessionId, userId, payload);

    if (prepared.promptMessage) {
      if (prepared.status.canAbort) {
        return prepared.runtimeInstance.queueFollowUp(prepared.promptMessage, prepared.context);
      }

      prepared.runtimeInstance.startPrompt(prepared.promptMessage, prepared.context);
    }

    return prepared.runtimeInstance.getStatus();
  });
}

export async function prewarmSessionRuntime(
  sessionId: string,
  userId: string,
): Promise<PiRuntimeStatus> {
  return withPiSessionOperationLock(sessionId, userId, async () => {
    const timing = createOperationTiming();
    const { runtime, created } = await getOrCreatePiRuntimeWithState(sessionId, userId);
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
): Promise<PiRuntimeStatus> {
  return withPiSessionOperationLock(sessionId, userId, async () => {
    const expectedAgentId = target?.expectedAgentId?.trim() || null;
    if (target?.expectedAgentId !== undefined && !expectedAgentId) {
      throw new RuntimeServiceError('Expected agent ID must not be empty.', 400);
    }
    if (expectedAgentId) {
      try {
        await assertUnambiguousOwnedPiSessionForRuntime({ sessionId, userId, agentId: expectedAgentId });
      } catch (error) {
        if (error instanceof PiSessionRuntimeAccessError) {
          throw new RuntimeServiceError(error.message, error.code === 'SESSION_NOT_FOUND' ? 404 : 409);
        }
        throw error;
      }
      const existingRuntime = await getExistingPiRuntime(sessionId, userId);
      if (existingRuntime && existingRuntime.agentId !== expectedAgentId) {
        throw new RuntimeServiceError('The active runtime belongs to a different agent.', 409);
      }
    }

    const payload = {
      sessionId,
      message,
      messages: [message],
      context,
    };
    const prepared = await prepareRuntimePrompt(sessionId, userId, payload);
    if (expectedAgentId && prepared.runtimeInstance.agentId !== expectedAgentId) {
      throw new RuntimeServiceError('The prepared runtime belongs to a different agent.', 409);
    }
    const promptMessage = prepared.promptMessage;

    if (!promptMessage) {
      throw new RuntimeServiceError('Follow-up message required.', 400);
    }

    if (prepared.status.canAbort) {
      return prepared.runtimeInstance.queueFollowUp(promptMessage, prepared.context);
    }

    prepared.runtimeInstance.startPrompt(promptMessage, prepared.context);
    return prepared.runtimeInstance.getStatus();
  });
}

export async function control(
  sessionId: string,
  userId: string,
  action: ControlAction,
  message?: unknown,
  queueItemId?: string,
  requestContext?: ChatRequestContext,
  focusTopic?: string,
): Promise<PiRuntimeStatus> {
  return withPiSessionOperationLock(sessionId, userId, async () => {
    const runtimeInstance = await getOrCreatePiRuntime(sessionId, userId);
    const prepareMessageContext = async () => {
      const context = await normalizeContext(requestContext, userId, sessionId);
      applyPiRuntimePromptContext(runtimeInstance, context);
      return context;
    };

    switch (action) {
      case 'follow_up':
        if (!isValidUserMessage(message)) {
          throw new RuntimeServiceError('User message required for follow_up.', 400);
        }
        {
          const context = await prepareMessageContext();
          await runtimeInstance.refreshWorkspaceFileTreePrompt();
          return runtimeInstance.queueFollowUp(message, context);
        }
      case 'steer':
        if (!isValidUserMessage(message)) {
          throw new RuntimeServiceError('User message required for steer.', 400);
        }
        {
          const context = await prepareMessageContext();
          await runtimeInstance.refreshWorkspaceFileTreePrompt();
          return runtimeInstance.queueSteering(message, context);
        }
      case 'promote_queued_to_steer':
        if (typeof queueItemId !== 'string' || !queueItemId.trim()) {
          throw new RuntimeServiceError('Queue item id required for promote_queued_to_steer.', 400);
        }
        await runtimeInstance.refreshWorkspaceFileTreePrompt();
        return runtimeInstance.promoteQueuedMessageToSteering(queueItemId.trim());
      case 'remove_queued_item':
        if (typeof queueItemId !== 'string' || !queueItemId.trim()) {
          throw new RuntimeServiceError('Queue item id required for remove_queued_item.', 400);
        }
        return runtimeInstance.removeQueuedMessage(queueItemId.trim());
      case 'replace':
        if (!isValidUserMessage(message)) {
          throw new RuntimeServiceError('User message required for replace.', 400);
        }
        {
          const context = await prepareMessageContext();
          await runtimeInstance.refreshWorkspaceFileTreePrompt();
          return runtimeInstance.replace(message, context);
        }
      case 'abort':
        return runtimeInstance.abort();
      case 'compact':
        return runtimeInstance.compactNow(focusTopic);
      default:
        throw new RuntimeServiceError(`Unsupported action: ${String(action)}`, 400);
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
