import assert from 'node:assert/strict';

import { buildToolBatchProjection } from '../app/lib/chat/run-collapse';
import type { ChatMessage } from '../app/lib/chat/types';

function message(input: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role'>): ChatMessage {
  return {
    content: '',
    status: 'sent',
    ...input,
  };
}

function assistantWithTools(
  id: string,
  text: string,
  calls: Array<{ id: string; name: string; arguments?: unknown }>,
  timestamp: number,
): ChatMessage {
  return message({
    id,
    role: 'assistant',
    content: text,
    piMessage: {
      role: 'assistant',
      content: [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...calls.map((call) => ({
          type: 'toolCall' as const,
          id: call.id,
          name: call.name,
          arguments: call.arguments || {},
        })),
      ],
      stopReason: 'toolUse',
      timestamp,
    } as ChatMessage['piMessage'],
  });
}

function toolResult(id: string, toolCallId: string, toolName: string, timestamp: number, status: ChatMessage['status'] = 'sent'): ChatMessage {
  return message({
    id,
    role: 'toolResult',
    toolCallId,
    toolName,
    status,
    content: `${toolName} output`,
    piMessage: {
      role: 'toolResult',
      toolCallId,
      toolName,
      content: [{ type: 'text', text: `${toolName} output` }],
      timestamp,
    } as ChatMessage['piMessage'],
  });
}

{
  const messages = [
    message({ id: 'user-1', role: 'user', content: 'Inspect files' }),
    assistantWithTools('assistant-tools', 'I will inspect the files.', [
      { id: 'call-a', name: 'search', arguments: { query: 'chat' } },
      { id: 'call-b', name: 'read', arguments: { path: 'Chat.tsx' } },
    ], 1000),
    toolResult('tool-b', 'call-b', 'read', 1300),
    toolResult('tool-a', 'call-a', 'search', 1200),
    message({ id: 'assistant-final', role: 'assistant', content: 'Done.' }),
  ];

  const projection = buildToolBatchProjection(messages);
  const batch = projection.batchesByAnchorId.get('assistant-tools');

  assert.ok(batch, 'assistant tool-call message should anchor a batch');
  assert.deepEqual(batch.calls.map((call) => call.toolCallId), ['call-a', 'call-b'], 'parallel calls should keep assistant source order');
  assert.deepEqual(batch.calls.map((call) => call.message?.id), ['tool-a', 'tool-b']);
  assert.equal(batch.startedAt, 1000);
  assert.equal(batch.endedAt, 1300);
  assert.deepEqual([...projection.hiddenToolMessageIds].sort(), ['tool-a', 'tool-b']);
}

{
  const messages = [
    message({ id: 'user-2', role: 'user', content: 'Run two batches' }),
    assistantWithTools('assistant-batch-1', 'First I will search.', [{ id: 'call-1', name: 'search' }], 2000),
    toolResult('tool-1', 'call-1', 'search', 2100),
    assistantWithTools('assistant-batch-2', 'Now I will read.', [{ id: 'call-2', name: 'read' }], 2200),
    toolResult('tool-2', 'call-2', 'read', 2300),
    message({ id: 'assistant-final-2', role: 'assistant', content: 'Finished.' }),
  ];

  const projection = buildToolBatchProjection(messages);
  assert.deepEqual([...projection.batchesByAnchorId.keys()], ['assistant-batch-1', 'assistant-batch-2']);
  assert.equal(projection.batchesByAnchorId.get('assistant-batch-1')?.calls.length, 1);
  assert.equal(projection.batchesByAnchorId.get('assistant-batch-2')?.calls.length, 1);
}

{
  const messages = [
    message({ id: 'user-3', role: 'user', content: 'Legacy run' }),
    toolResult('legacy-a', 'legacy-call-a', 'search', 3000),
    toolResult('legacy-b', 'legacy-call-b', 'read', 3100),
    message({ id: 'assistant-commentary', role: 'assistant', content: 'I need another check.' }),
    toolResult('legacy-c', 'legacy-call-c', 'read', 3200),
    message({ id: 'assistant-final-3', role: 'assistant', content: 'Finished.' }),
  ];

  const projection = buildToolBatchProjection(messages);
  assert.deepEqual([...projection.batchesByAnchorId.keys()], ['legacy-a', 'legacy-c'], 'assistant commentary should split fallback batches');
  assert.equal(projection.batchesByAnchorId.get('legacy-a')?.calls.length, 2);
  assert.equal(projection.batchesByAnchorId.get('legacy-c')?.calls.length, 1);
}

{
  const messages = [
    message({ id: 'user-4', role: 'user', content: 'Live run' }),
    assistantWithTools('assistant-live', '', [
      { id: 'live-a', name: 'search' },
      { id: 'live-b', name: 'read' },
    ], 4000),
    toolResult('live-message-a', 'live-a', 'search', 4100, 'sending'),
  ];

  const projection = buildToolBatchProjection(messages);
  const batch = projection.batchesByAnchorId.get('assistant-live');
  assert.ok(batch);
  assert.equal(batch.calls.length, 2);
  assert.equal(batch.calls[0]?.message?.status, 'sending');
  assert.equal(batch.calls[1]?.message, undefined, 'not-yet-started parallel calls should remain in the live batch');
  assert.equal(batch.endedAt, null);
}

console.log('chat tool batch projection tests passed');
