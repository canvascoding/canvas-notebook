import type {
  AgentContext,
  AgentLoopTurnUpdate,
  AgentTool,
} from '@earendil-works/pi-agent-core';
import { createInitialSystemMessage, toToolDeclaration } from '@earendil-works/pi-ai';

/**
 * Builds the context snapshot used by the agent loop for its next provider
 * request. The loop owns this snapshot independently from Agent.state.
 */
export function replaceNextTurnContext(
  context: AgentContext,
  options: {
    systemPrompt: string;
    tools: AgentTool[];
  },
): AgentLoopTurnUpdate {
  const systemMessage = createInitialSystemMessage(
    options.systemPrompt,
    options.tools.map(toToolDeclaration),
  );
  return {
    context: {
      ...context,
      messages: [
        ...(systemMessage ? [systemMessage] : []),
        ...context.messages.filter((message) => message.role !== 'system'),
      ],
      tools: options.tools,
    },
  };
}
