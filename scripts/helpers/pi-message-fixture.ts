import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';

// Leading and embedded slashes deliberately resemble paths. These fields are
// opaque replay data, not user-visible text or filesystem locations.
export const piMetadataFixture: AssistantMessage = {
  role: 'assistant', api: 'openai-responses', provider: 'openai', model: 'fixture-model',
  content: [
    { type: 'thinking', thinking: 'Inspecting.', thinkingSignature: '/opaque/provider+signature/==' },
    { type: 'text', text: 'Checking.', textSignature: '{"id":"/opaque/message/id","phase":"commentary"}' },
    { type: 'toolCall', id: 'metadata-call', name: 'inspect', namespace: 'workspace_tools', arguments: {}, thoughtSignature: '/opaque/tool/signature==' },
  ],
  providerThinkingLevel: 'high', endTurn: false, stopReason: 'toolUse', timestamp: 1_000,
  usage: {
    input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17,
    cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
  },
};

export const piToolMetadataFixture: ToolResultMessage = {
  role: 'toolResult', toolCallId: 'metadata-call', toolName: 'inspect',
  content: [{ type: 'text', text: 'Ready.' }], details: {}, isError: false,
  addedToolNames: ['loaded_lookup'], timestamp: 1_001,
};
