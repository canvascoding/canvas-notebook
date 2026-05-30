import 'server-only';

import fs from 'node:fs/promises';
import path from 'node:path';

import type { AgentMessage } from '@mariozechner/pi-agent-core';

import type { ChatRequestContext } from '@/app/lib/chat/types';
import {
  getOrCreatePiRuntime,
  getPiRuntimeStatus,
  invalidatePiRuntime,
  type PiRuntimeStatus,
} from '@/app/lib/pi/live-runtime';
import { getStudioOutputsRoot } from '@/app/lib/integrations/studio-workspace';

export type UserAgentMessage = Extract<AgentMessage, { role: 'user' }>;

export type ControlAction = 'follow_up' | 'steer' | 'promote_queued_to_steer' | 'remove_queued_item' | 'abort' | 'replace' | 'compact';

type RuntimeInstance = Awaited<ReturnType<typeof getOrCreatePiRuntime>>;

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

function normalizeContext(context?: ChatRequestContext): ChatRequestContext {
  return {
    userTimeZone: typeof context?.userTimeZone === 'string' ? context.userTimeZone : undefined,
    currentTime: typeof context?.currentTime === 'string' ? context.currentTime : undefined,
    activeFilePath: typeof context?.activeFilePath === 'string' ? context.activeFilePath : null,
    workingDirectory: typeof context?.workingDirectory === 'string' ? context.workingDirectory : undefined,
    planningMode: context?.planningMode === true,
    currentPage: typeof context?.currentPage === 'string' ? context.currentPage : undefined,
    studioContext: context?.studioContext,
  };
}

async function injectStudioImage(
  message: UserAgentMessage | null,
  context: ChatRequestContext,
): Promise<UserAgentMessage | null> {
  if (!message || !context.studioContext?.outputFilePath) {
    return message;
  }

  try {
    const imagePath = path.join(getStudioOutputsRoot(), context.studioContext.outputFilePath);
    const imageBuffer = await fs.readFile(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const ext = path.extname(context.studioContext.outputFilePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.webp' ? 'image/webp'
          : ext === '.gif' ? 'image/gif'
            : 'image/png';

    const imageContent = {
      type: 'image' as const,
      data: base64Image,
      mimeType,
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

function applyPromptContext(runtimeInstance: RuntimeInstance, context: ChatRequestContext): void {
  if (context.userTimeZone && context.currentTime) {
    runtimeInstance.setTimeZoneContext(context.userTimeZone, context.currentTime);
  }

  runtimeInstance.setActiveFileContext(context.activeFilePath ?? null);
  runtimeInstance.setPlanningMode(context.planningMode === true);
  runtimeInstance.setPageContext(context.currentPage);
  runtimeInstance.setStudioContext(context.studioContext);
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
  const context = normalizeContext(resolveChatRequestContext(payload));
  const runtimeInstance = await getOrCreatePiRuntime(sessionId, userId);
  const promptMessage = await injectStudioImage(resolvePromptMessage(payload), context);
  const status = runtimeInstance.getStatus();

  if (!promptMessage && !status.canAbort) {
    throw new RuntimeServiceError('Prompt message required when no run is active.', 400);
  }

  applyPromptContext(runtimeInstance, context);

  console.log('[RuntimeService] Runtime status:', {
    sessionId,
    phase: status.phase,
    contextWindow: status.contextWindow,
    hasStudioContext: !!context.studioContext,
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
      return prepared.runtimeInstance.queueSteering(prepared.promptMessage);
    }

    prepared.runtimeInstance.startPrompt(prepared.promptMessage);
  }

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

export async function invalidateRuntime(sessionId: string, userId: string): Promise<boolean> {
  return invalidatePiRuntime(sessionId, userId);
}
