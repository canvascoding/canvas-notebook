import assert from 'node:assert/strict';

import { getChatMessageRenderKey } from '../app/lib/chat/message-render-key';
import type { ChatMessage } from '../app/lib/chat/types';

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'fallback-id',
    role: 'assistant',
    content: '',
    ...overrides,
  };
}

function main(): void {
  const liveToolResult = message({
    id: 'tool-live-random',
    role: 'toolResult',
    toolCallId: 'call_create_todo_42',
  });
  const savedToolResult = message({
    id: '9812',
    role: 'toolResult',
    toolCallId: 'call_create_todo_42',
  });
  assert.equal(
    getChatMessageRenderKey(liveToolResult),
    getChatMessageRenderKey(savedToolResult),
    'persisting a tool result must not replace its React subtree',
  );

  const liveAssistant = message({
    id: 'assistant-live-random',
    piMessage: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call_create_todo_42', name: 'create_todo', arguments: {} }],
      timestamp: 1_726_000_000_000,
    } as ChatMessage['piMessage'],
  });
  const savedAssistant = message({
    id: '9811',
    piMessage: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call_create_todo_42', name: 'create_todo', arguments: {} }],
      timestamp: 1_726_000_000_100,
    } as ChatMessage['piMessage'],
  });
  assert.equal(
    getChatMessageRenderKey(liveAssistant),
    getChatMessageRenderKey(savedAssistant),
    'assistant tool-call containers should use the stable call id before timestamps',
  );

  const liveText = message({
    id: 'assistant-live-random',
    content: 'partial',
    piMessage: {
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      timestamp: 1_726_000_000_200,
    } as ChatMessage['piMessage'],
  });
  const savedText = message({
    id: '9813',
    content: 'final response',
    piMessage: {
      role: 'assistant',
      content: [{ type: 'text', text: 'final response' }],
      timestamp: 1_726_000_000_200,
    } as ChatMessage['piMessage'],
  });
  assert.equal(
    getChatMessageRenderKey(liveText),
    getChatMessageRenderKey(savedText),
    'streaming content changes must not change the React key',
  );

  assert.notEqual(
    getChatMessageRenderKey(message({ id: 'local-a', piMessage: undefined })),
    getChatMessageRenderKey(message({ id: 'local-b', piMessage: undefined })),
    'messages without stable runtime metadata must retain distinct fallback keys',
  );

  console.log('chat-message-render-key-test: ok');
}

main();
