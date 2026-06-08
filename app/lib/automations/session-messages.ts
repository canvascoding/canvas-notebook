import type { AgentMessage } from '@earendil-works/pi-agent-core';

function serializeContent(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function getMessageContent(message: AgentMessage): unknown {
  return 'content' in message ? message.content : null;
}

function sameMessageContent(left: AgentMessage, right: AgentMessage): boolean {
  return left.role === right.role && serializeContent(getMessageContent(left)) === serializeContent(getMessageContent(right));
}

function startsWithMessagePrefix(messages: AgentMessage[], prefix: AgentMessage[]): boolean {
  if (prefix.length > messages.length) {
    return false;
  }

  return prefix.every((message, index) => sameMessageContent(messages[index], message));
}

function isPromptMessage(message: AgentMessage | undefined, promptMessage: AgentMessage): boolean {
  return Boolean(message && sameMessageContent(message, promptMessage));
}

function collapseRepeatedPromptPrefix(messages: AgentMessage[], promptMessage: AgentMessage): AgentMessage[] {
  let promptPrefixLength = 0;
  while (isPromptMessage(messages[promptPrefixLength], promptMessage)) {
    promptPrefixLength += 1;
  }

  if (promptPrefixLength <= 1) {
    return messages;
  }

  return [messages[0], ...messages.slice(promptPrefixLength)];
}

export function buildPersistedAutomationMessages(input: {
  existingMessages: AgentMessage[];
  promptMessage: AgentMessage;
  runMessages: AgentMessage[];
}): AgentMessage[] {
  const runTail = startsWithMessagePrefix(input.runMessages, input.existingMessages)
    ? input.runMessages.slice(input.existingMessages.length)
    : input.runMessages;
  const dedupedRunTail = collapseRepeatedPromptPrefix(runTail, input.promptMessage);
  const normalizedRunTail = isPromptMessage(dedupedRunTail[0], input.promptMessage)
    ? dedupedRunTail
    : [input.promptMessage, ...dedupedRunTail];

  return [...input.existingMessages, ...normalizedRunTail];
}

export function getAutomationPersistedLength(input: {
  existingMessagesLength: number;
  promptPersistedBeforeRun: boolean;
}): number {
  return input.existingMessagesLength + (input.promptPersistedBeforeRun ? 1 : 0);
}
