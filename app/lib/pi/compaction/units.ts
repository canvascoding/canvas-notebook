import type { AgentMessage } from '@earendil-works/pi-agent-core';

export type PiHistoryUnit = Readonly<{
  kind: 'message' | 'tool_group';
  messages: readonly AgentMessage[];
  toolCallIds: readonly string[];
  toolChainComplete: boolean;
}>;

function getAssistantToolCallIds(message: AgentMessage): string[] {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part) => {
    if (!part || typeof part !== 'object' || !('type' in part) || part.type !== 'toolCall') return [];
    const id = 'id' in part && typeof part.id === 'string' ? part.id.trim() : '';
    return id ? [id] : [];
  });
}

function getToolResultCallId(message: AgentMessage): string | null {
  if (message.role !== 'toolResult') return null;
  const toolCallId = (message as unknown as { toolCallId?: unknown }).toolCallId;
  return typeof toolCallId === 'string' && toolCallId.trim() ? toolCallId.trim() : null;
}

/** Groups history before selection so a cut cannot split a tool transaction. */
export function buildPiHistoryUnits(messages: readonly AgentMessage[]): PiHistoryUnit[] {
  const toolCallsByIndex = new Map<number, string[]>();
  const resultIndexesByCallId = new Map<string, number[]>();
  messages.forEach((message, index) => {
    const toolCallIds = getAssistantToolCallIds(message);
    if (toolCallIds.length > 0) toolCallsByIndex.set(index, toolCallIds);
    const resultId = getToolResultCallId(message);
    if (resultId) {
      const indexes = resultIndexesByCallId.get(resultId) ?? [];
      indexes.push(index);
      resultIndexesByCallId.set(resultId, indexes);
    }
  });

  const units: PiHistoryUnit[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const toolCallIds = toolCallsByIndex.get(index) ?? [];
    if (toolCallIds.length === 0) {
      units.push(Object.freeze({
        kind: 'message',
        messages: Object.freeze([message]),
        toolCallIds: Object.freeze([]),
        toolChainComplete: message.role !== 'toolResult',
      }));
      continue;
    }

    const groupedToolCallIds = new Set(toolCallIds);
    let endIndex = toolCallIds.reduce((latestIndex, id) => {
      const resultIndexes = resultIndexesByCallId.get(id) ?? [];
      return Math.max(latestIndex, ...resultIndexes.filter((resultIndex) => resultIndex > index));
    }, index);
    for (let nestedIndex = index + 1; nestedIndex <= endIndex; nestedIndex += 1) {
      const nestedToolCallIds = toolCallsByIndex.get(nestedIndex) ?? [];
      for (const nestedId of nestedToolCallIds) {
        groupedToolCallIds.add(nestedId);
        const resultIndexes = resultIndexesByCallId.get(nestedId) ?? [];
        endIndex = Math.max(endIndex, ...resultIndexes.filter((resultIndex) => resultIndex > nestedIndex));
      }
    }
    const groupedMessages = messages.slice(index, endIndex + 1);
    const observedResultIds = new Set(
      groupedMessages.map(getToolResultCallId).filter((id): id is string => id !== null),
    );
    units.push(Object.freeze({
      kind: 'tool_group',
      messages: Object.freeze(groupedMessages),
      toolCallIds: Object.freeze([...groupedToolCallIds]),
      toolChainComplete: [...groupedToolCallIds].every((id) => observedResultIds.has(id)),
    }));
    index = endIndex;
  }
  return units;
}
