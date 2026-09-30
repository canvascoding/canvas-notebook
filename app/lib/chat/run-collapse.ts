import { getChatMessageTimestamp } from '@/app/lib/chat/message-metadata';
import { formatToolArgs, getPiMessageContent, isToolCallPart } from '@/app/lib/chat/message-content';
import { interruptToolMessage } from '@/app/lib/chat/tool-lifecycle';
import type {
  ChatMessage,
  PersistedToolCallPart,
  ToolBatch,
  ToolBatchCall,
  ToolBatchProjection,
} from '@/app/lib/chat/types';

export function formatRunDuration(startedAt: number | null, endedAt: number | null): string | null {
  if (!startedAt || !endedAt || endedAt <= startedAt) {
    return null;
  }

  const totalSeconds = Math.max(1, Math.round((endedAt - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0 && seconds > 0) {
    return `${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

function getAssistantToolCalls(message: ChatMessage): PersistedToolCallPart[] {
  if (message.role !== 'assistant') {
    return [];
  }

  const content = getPiMessageContent(message.piMessage);
  return Array.isArray(content) ? content.filter(isToolCallPart) : [];
}

function isTerminalToolMessage(message: ChatMessage | undefined): boolean {
  return Boolean(message) && message?.status !== 'pending' && message?.status !== 'sending' && message?.status !== 'aborting';
}

function getBatchTiming(
  calls: ToolBatchCall[],
  sourceAssistant?: ChatMessage,
): Pick<ToolBatch, 'startedAt' | 'endedAt'> {
  const messageTimestamps = calls
    .map((call) => getChatMessageTimestamp(call.message))
    .filter((timestamp): timestamp is number => timestamp !== null);
  const sourceTimestamp = getChatMessageTimestamp(sourceAssistant);
  const startedAt = sourceTimestamp ?? messageTimestamps[0] ?? null;
  const isComplete = calls.length > 0 && calls.every((call) => isTerminalToolMessage(call.message));
  const endedAt = isComplete && messageTimestamps.length > 0
    ? Math.max(...messageTimestamps)
    : null;

  return { startedAt, endedAt };
}

function createExplicitBatch(
  sourceAssistant: ChatMessage,
  toolCalls: PersistedToolCallPart[],
  toolMessagesByCallId: Map<string, ChatMessage>,
  assignedMessageIds: Set<string>,
  interrupted: boolean,
  interruptionText: string,
): ToolBatch {
  const calls = toolCalls.map<ToolBatchCall>((toolCall) => {
    const message = toolMessagesByCallId.get(toolCall.id);
    if (message) {
      assignedMessageIds.add(message.id);
    }

    return {
      id: toolCall.id,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      toolArgs: formatToolArgs(toolCall.arguments),
      message: interrupted && !isTerminalToolMessage(message)
        ? interruptToolMessage(message || {
            id: `interrupted-${toolCall.id}`,
            role: 'toolResult',
            content: '',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            toolArgs: formatToolArgs(toolCall.arguments),
          }, interruptionText)
        : message,
    };
  });

  return {
    key: `tool-batch-${sourceAssistant.id}`,
    anchorMessageId: sourceAssistant.id,
    sourceAssistantMessageId: sourceAssistant.id,
    calls,
    ...getBatchTiming(calls, sourceAssistant),
  };
}

function createFallbackBatch(toolMessages: ChatMessage[]): ToolBatch {
  const calls = toolMessages.map<ToolBatchCall>((message) => ({
    id: message.toolCallId || message.id,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    toolArgs: message.toolArgs,
    message,
  }));

  return {
    key: `tool-batch-${calls[0]?.id || toolMessages[0].id}`,
    anchorMessageId: toolMessages[0].id,
    calls,
    ...getBatchTiming(calls),
  };
}

function projectMessageSegment(
  messages: ChatMessage[],
  start: number,
  end: number,
  projection: ToolBatchProjection,
  runtimeActive: boolean | undefined,
  interruptionText: string,
) {
  const assignedMessageIds = new Set<string>();
  const toolMessagesByCallId = new Map<string, ChatMessage>();
  const assignedCallIds = new Set<string>();
  const segmentEnded = runtimeActive === false
    || (end < messages.length && messages[end].status === 'sent')
    || messages.slice(start, end).some((message) => {
      const piMessage = message.piMessage;
      return message.role === 'assistant' && message.status !== 'sending'
        && piMessage?.role === 'assistant'
        && (piMessage.stopReason === 'stop' || piMessage.stopReason === 'error' || piMessage.stopReason === 'aborted');
    });

  for (let index = start; index < end; index += 1) {
    const message = messages[index];
    if (message.role === 'toolResult' && message.toolCallId) {
      toolMessagesByCallId.set(message.toolCallId, message);
    }
  }

  for (let index = start; index < end; index += 1) {
    const message = messages[index];
    const toolCalls = getAssistantToolCalls(message).filter((call) => {
      if (assignedCallIds.has(call.id)) return false;
      assignedCallIds.add(call.id);
      return true;
    });
    if (toolCalls.length === 0) {
      continue;
    }

    const batch = createExplicitBatch(message, toolCalls, toolMessagesByCallId, assignedMessageIds, segmentEnded, interruptionText);
    projection.batchesByAnchorId.set(batch.anchorMessageId, batch);
  }

  let fallbackMessages: ChatMessage[] = [];
  const flushFallbackBatch = () => {
    if (fallbackMessages.length === 0) {
      return;
    }

    const batch = createFallbackBatch(fallbackMessages);
    projection.batchesByAnchorId.set(batch.anchorMessageId, batch);
    fallbackMessages = [];
  };

  for (let index = start; index < end; index += 1) {
    const message = messages[index];
    if (message.role === 'toolResult' && message.toolCallId
      && toolMessagesByCallId.get(message.toolCallId)?.id !== message.id) continue;
    if (message.role === 'toolResult' && !assignedMessageIds.has(message.id)) {
      fallbackMessages.push(segmentEnded && !isTerminalToolMessage(message)
        ? interruptToolMessage(message, interruptionText)
        : message);
      continue;
    }

    flushFallbackBatch();
  }
  flushFallbackBatch();

  for (let index = start; index < end; index += 1) {
    const message = messages[index];
    if (message.role === 'toolResult') {
      projection.hiddenToolMessageIds.add(message.id);
    }
  }
}

/**
 * Builds a presentation-only projection that keeps assistant commentary in the
 * timeline and groups each set of tool calls directly at its source message.
 * Explicit assistant tool-call parts define parallel batch membership and
 * source order. Contiguous tool results are used as a fallback for partial live
 * events and legacy history records without tool-call metadata.
 */
export function buildToolBatchProjection(
  messages: ChatMessage[],
  runtimeActive?: boolean,
  interruptionText = 'The run ended before this tool returned a result. Its completion could not be confirmed.',
): ToolBatchProjection {
  const projection: ToolBatchProjection = {
    batchesByAnchorId: new Map(),
    hiddenToolMessageIds: new Set(),
  };
  let segmentStart = 0;

  for (let index = 0; index <= messages.length; index += 1) {
    if (index < messages.length && messages[index]?.role !== 'user') {
      continue;
    }

    projectMessageSegment(messages, segmentStart, index, projection, runtimeActive, interruptionText);
    segmentStart = index + 1;
  }

  return projection;
}
