import assert from 'node:assert/strict';

import {
  formatChatRuntimeIdentity,
  indexChatRuntimeChanges,
} from '../app/components/canvas-agent-chat/chatRuntimeChanges';
import type { ChatMessage } from '../app/lib/chat/types';

function user(id: string): ChatMessage {
  return { id, role: 'user', content: id, status: 'sent' };
}

function assistant(
  id: string,
  provider: string,
  model: string,
  stopReason: 'stop' | 'error' = 'stop',
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: id,
    status: stopReason === 'error' ? 'error' : 'sent',
    piMessage: {
      role: 'assistant',
      content: [{ type: 'text', text: id }],
      api: 'openai-completions',
      provider,
      model,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      ...(stopReason === 'error' ? { errorMessage: '502 status code (no body)' } : {}),
      timestamp: Date.now(),
    },
  };
}

const changes = indexChatRuntimeChanges([
  user('old-user'),
  assistant('old-assistant', 'canvas-control-plane', 'anthropic/claude-sonnet-4'),
  user('new-user'),
  assistant('new-error', 'canvas-control-plane', 'deepseek/deepseek-v3.2', 'error'),
  user('same-user'),
  assistant('same-assistant', 'canvas-control-plane', 'deepseek/deepseek-v3.2'),
]);

assert.deepEqual(changes.get('new-user'), {
  from: { provider: 'canvas-control-plane', model: 'anthropic/claude-sonnet-4' },
  to: { provider: 'canvas-control-plane', model: 'deepseek/deepseek-v3.2' },
});
assert.equal(changes.has('same-user'), false, 'the same runtime must not add another separator');
assert.equal(changes.size, 1);
assert.equal(
  formatChatRuntimeIdentity(changes.get('new-user')!.to),
  'Canvas Control Plane / deepseek/deepseek-v3.2',
);

const changeWithoutUserAnchor = indexChatRuntimeChanges([
  assistant('first', 'openrouter', 'first/model'),
  assistant('second', 'groq', 'second-model'),
]);
assert.deepEqual(changeWithoutUserAnchor.get('second'), {
  from: { provider: 'openrouter', model: 'first/model' },
  to: { provider: 'groq', model: 'second-model' },
});

console.log('chat-runtime-change-history-test: ok');
