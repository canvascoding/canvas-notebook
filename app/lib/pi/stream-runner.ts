import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import { isContextOverflow } from '@mariozechner/pi-ai';

type RunStreamAttempt = (aggressive: boolean) => AsyncIterable<AgentEvent>;
type ForwardEvent = (event: AgentEvent) => void | Promise<void>;

export type RunPiStreamWithRetryOptions = {
  runAttempt: RunStreamAttempt;
  forwardEvent: ForwardEvent;
  contextWindow: number;
};

export type RunPiStreamWithRetryResult = {
  finalMessages: AgentMessage[];
  retriedForOverflow: boolean;
};

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === 'assistant';
}

function isVisibleEvent(event: AgentEvent): boolean {
  if (event.type === 'message_update') {
    return true;
  }

  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
    return true;
  }

  if (event.type === 'message_end' && isAssistantMessage(event.message)) {
    return event.message.stopReason !== 'error' && event.message.stopReason !== 'aborted';
  }

  return false;
}

function getLastAssistantMessage(messages: AgentMessage[]): AssistantMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isAssistantMessage(message)) {
      return message;
    }
  }

  return null;
}

async function flushBufferedEvents(bufferedEvents: AgentEvent[], forwardEvent: ForwardEvent): Promise<void> {
  for (const event of bufferedEvents) {
    await forwardEvent(event);
  }
}

export async function runPiStreamWithOverflowRetry({
  runAttempt,
  forwardEvent,
  contextWindow,
}: RunPiStreamWithRetryOptions): Promise<RunPiStreamWithRetryResult> {
  let retriedForOverflow = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const aggressive = attempt === 1;
    const bufferedEvents: AgentEvent[] = [];
    let hasFlushedBufferedEvents = false;
    let finalMessages: AgentMessage[] = [];

    for await (const event of runAttempt(aggressive)) {
      if (event.type === 'agent_end') {
        finalMessages = event.messages;
      }

      if (!hasFlushedBufferedEvents) {
        bufferedEvents.push(event);

        if (isVisibleEvent(event)) {
          hasFlushedBufferedEvents = true;
          await flushBufferedEvents(bufferedEvents, forwardEvent);
        }

        continue;
      }

      await forwardEvent(event);
    }

    const lastAssistantMessage = getLastAssistantMessage(finalMessages);
    const overflowDetected =
      lastAssistantMessage !== null && isContextOverflow(lastAssistantMessage, contextWindow);

    if (overflowDetected && !hasFlushedBufferedEvents && attempt === 0) {
      retriedForOverflow = true;
      continue;
    }

    if (!hasFlushedBufferedEvents) {
      await flushBufferedEvents(bufferedEvents, forwardEvent);
    }

    return {
      finalMessages,
      retriedForOverflow,
    };
  }

  throw new Error('PI stream retry loop exhausted without a final result.');
}
