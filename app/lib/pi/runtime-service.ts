import 'server-only';

import fs from 'node:fs/promises';
import path from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type { ChatRequestContext } from '@/app/lib/chat/types';
import {
  getExistingPiRuntimeStatuses,
  getOrCreatePiRuntime,
  getPiRuntimeStatus,
  invalidatePiRuntime,
  type PiRuntimeStatus,
} from '@/app/lib/pi/live-runtime';
import { applyPiRuntimePromptContext } from '@/app/lib/pi/runtime-prompt-context';
import { getStudioOutputsRoot } from '@/app/lib/integrations/studio-workspace';
import { normalizeTimeZone } from '@/app/lib/time-zones';
import { getServerPreferredTimeZone } from '@/app/lib/server-settings';
import {
  ensurePiSessionWorkspaceSnapshot,
  requestedWorkspaceIdFromChatContext,
  workspaceToChatRequestWorkspace,
} from '@/app/lib/pi/session-workspace-context';

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
    studioContext: context?.studioContext,
    emailContext: context?.emailContext,
  };
}

function resolveStudioOutputImage(outputFilePath: string): { imagePath: string; mimeType: string } | null {
  const outputRoot = path.resolve(getStudioOutputsRoot());
  const normalizedOutputPath = outputFilePath
    .replace(/^\/+/, '')
    .replace(/^studio\/outputs\//, '');
  const imagePath = path.resolve(outputRoot, normalizedOutputPath);
  const relativePath = path.relative(outputRoot, imagePath);

  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  const mimeType = STUDIO_IMAGE_MIME_BY_EXTENSION[path.extname(imagePath).toLowerCase()];
  return mimeType ? { imagePath, mimeType } : null;
}

async function injectStudioImage(
  message: UserAgentMessage | null,
  context: ChatRequestContext,
): Promise<UserAgentMessage | null> {
  if (!message || !context.studioContext?.outputFilePath) {
    return message;
  }

  try {
    const resolved = resolveStudioOutputImage(context.studioContext.outputFilePath);
    if (!resolved) {
      console.warn('[RuntimeService] Skipping invalid studio image reference:', {
        outputFilePath: context.studioContext.outputFilePath,
      });
      return message;
    }

    const stats = await fs.stat(resolved.imagePath);
    if (!stats.isFile()) {
      return message;
    }

    const imageContent = {
      type: 'image' as const,
      data: resolved.imagePath,
      mimeType: resolved.mimeType,
    };

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
  const context = await normalizeContext(resolveChatRequestContext(payload), userId, sessionId);
  const runtimeInstance = await getOrCreatePiRuntime(sessionId, userId);
  const promptMessage = await injectStudioImage(resolvePromptMessage(payload), context);
  const status = runtimeInstance.getStatus();

  if (!promptMessage && !status.canAbort) {
    throw new RuntimeServiceError('Prompt message required when no run is active.', 400);
  }

  applyPiRuntimePromptContext(runtimeInstance, context);
  if (!status.canAbort) {
    await runtimeInstance.reloadTools();
  }

  console.log('[RuntimeService] Runtime status:', {
    sessionId,
    phase: status.phase,
    contextWindow: status.contextWindow,
    hasStudioContext: !!context.studioContext,
    hasEmailContext: !!context.emailContext,
    workspaceId: context.workspace?.workspaceId,
    workspaceType: context.workspace?.workspaceType,
    studioOutputPath: context.studioContext?.outputFilePath,
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
  const payload = {
    sessionId,
    ...(message ? { message, messages: [message] } : {}),
    context,
  };
  const prepared = await prepareRuntimePrompt(sessionId, userId, payload);

  if (prepared.promptMessage) {
    if (prepared.status.canAbort) {
      return prepared.runtimeInstance.queueFollowUp(prepared.promptMessage);
    }

    prepared.runtimeInstance.startPrompt(prepared.promptMessage);
  }

  return prepared.runtimeInstance.getStatus();
}

export async function sendFollowUpMessage(
  sessionId: string,
  userId: string,
  message: UserAgentMessage,
  context?: ChatRequestContext,
): Promise<PiRuntimeStatus> {
  const payload = {
    sessionId,
    message,
    messages: [message],
    context,
  };
  const prepared = await prepareRuntimePrompt(sessionId, userId, payload);
  const promptMessage = prepared.promptMessage;

  if (!promptMessage) {
    throw new RuntimeServiceError('Follow-up message required.', 400);
  }

  if (prepared.status.canAbort) {
    return prepared.runtimeInstance.queueFollowUp(promptMessage);
  }

  prepared.runtimeInstance.startPrompt(promptMessage);
  return prepared.runtimeInstance.getStatus();
}

export async function control(
  sessionId: string,
  userId: string,
  action: ControlAction,
  message?: unknown,
  queueItemId?: string,
): Promise<PiRuntimeStatus> {
  const runtimeInstance = await getOrCreatePiRuntime(sessionId, userId);

  switch (action) {
    case 'follow_up':
      if (!isValidUserMessage(message)) {
        throw new RuntimeServiceError('User message required for follow_up.', 400);
      }
      return runtimeInstance.queueFollowUp(message);
    case 'steer':
      if (!isValidUserMessage(message)) {
        throw new RuntimeServiceError('User message required for steer.', 400);
      }
      return runtimeInstance.queueSteering(message);
    case 'promote_queued_to_steer':
      if (typeof queueItemId !== 'string' || !queueItemId.trim()) {
        throw new RuntimeServiceError('Queue item id required for promote_queued_to_steer.', 400);
      }
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
      return runtimeInstance.replace(message);
    case 'abort':
      return runtimeInstance.abort();
    case 'compact':
      return runtimeInstance.compactNow();
    default:
      throw new RuntimeServiceError(`Unsupported action: ${String(action)}`, 400);
  }
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
