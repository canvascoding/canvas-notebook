import type { ChatMessage } from '@/app/lib/chat/types';

export function interruptToolMessage(message: ChatMessage, explanation: string): ChatMessage {
  return {
    ...message,
    status: 'error',
    type: 'tool_result',
    content: message.content ? `${message.content}\n\n${explanation}` : explanation,
  };
}

/** Settle live entries when the runtime confirms that the run has ended. */
export function settleInterruptedToolMessages(messages: ChatMessage[], explanation: string): ChatMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== 'toolResult'
      || (message.status !== 'pending' && message.status !== 'sending' && message.status !== 'aborting')) {
      return message;
    }
    changed = true;
    return interruptToolMessage(message, explanation);
  });
  return changed ? next : messages;
}
