import type {
  AgentContext,
  AgentLoopTurnUpdate,
  AgentTool,
} from '@earendil-works/pi-agent-core';

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
  return {
    context: {
      ...context,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
    },
  };
}
