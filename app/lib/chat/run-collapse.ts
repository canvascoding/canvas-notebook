import { getChatMessageTimestamp } from '@/app/lib/chat/message-metadata';
import type { ChatMessage, CollapsedRun } from '@/app/lib/chat/types';

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

/**
 * Groups completed agent steps under their final assistant response.
 *
 * An open tool detail view has to stay mounted while a late runtime-status
 * update arrives. `protectedStepIds` lets the caller defer that one visual
 * compaction until the user closes the detail view, without changing how
 * already-collapsed historical runs are rendered.
 */
export function buildCollapsedRunMap(
  messages: ChatMessage[],
  isRuntimeBusy: boolean,
  protectedStepIds: ReadonlySet<string> = new Set(),
): Map<string, CollapsedRun> {
  const runs = new Map<string, CollapsedRun>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'user') {
      continue;
    }

    let runEnd = messages.length;
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      if (messages[cursor]?.role === 'user') {
        runEnd = cursor;
        break;
      }
    }

    if (isRuntimeBusy && runEnd === messages.length) {
      continue;
    }

    let finalAssistantIndex = -1;
    for (let cursor = runEnd - 1; cursor > index; cursor -= 1) {
      if (messages[cursor]?.role === 'assistant') {
        finalAssistantIndex = cursor;
        break;
      }
    }

    if (finalAssistantIndex === -1) {
      index = runEnd - 1;
      continue;
    }

    const steps = messages.slice(index + 1, finalAssistantIndex).filter((step) => (
      step.type !== 'compact_break' &&
      step.type !== 'composio_auth_required' &&
      (step.role === 'assistant' || step.role === 'toolResult' || step.role === 'system')
    ));

    if (steps.length > 0 && !steps.some((step) => protectedStepIds.has(step.id))) {
      const finalAssistant = messages[finalAssistantIndex];
      runs.set(finalAssistant.id, {
        key: `${message.id}-${finalAssistant.id}`,
        finalAssistantId: finalAssistant.id,
        steps,
        startedAt: getChatMessageTimestamp(message),
        endedAt: getChatMessageTimestamp(finalAssistant) || getChatMessageTimestamp(steps[steps.length - 1]),
      });
    }

    index = runEnd - 1;
  }

  return runs;
}
