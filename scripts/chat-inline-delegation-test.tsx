import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import { ChatMessageList } from '../app/components/canvas-agent-chat/ChatMessageList';
import { mapPersistedChatMessages } from '../app/components/canvas-agent-chat/chatMessageMapping';
import { getSpawnDelegationId } from '../app/lib/chat/delegation-inline';
import type { ChatMessage, PersistedChatMessage, ToolBatchCall } from '../app/lib/chat/types';

const en = JSON.parse(readFileSync('messages/en.json', 'utf8')) as { chat: Record<string, string> };

function result(callId: string, delegationId: string, status = 'accepted'): ChatMessage {
  return {
    id: `result-${callId}`,
    role: 'toolResult',
    content: 'Delegated task accepted.',
    status: 'sent',
    toolCallId: callId,
    toolName: 'delegate_task',
    piMessage: {
      role: 'toolResult',
      toolCallId: callId,
      toolName: 'delegate_task',
      content: [{ type: 'text', text: 'Delegated task accepted.' }],
      details: { status, delegation_id: delegationId },
      timestamp: Date.now(),
    } as unknown as ChatMessage['piMessage'],
  };
}

function call(id: string, message: ChatMessage, toolName = 'delegate_task'): ToolBatchCall {
  return { id, toolCallId: id, toolName, toolArgs: '{}', message };
}

assert.equal(getSpawnDelegationId(call('a', result('a', 'task-a'))), 'task-a');
assert.equal(getSpawnDelegationId(call('a', result('a', 'task-a', 'completed'))), null);
assert.equal(getSpawnDelegationId(call('a', result('a', 'task-a'), 'read_file')), null);
assert.equal(getSpawnDelegationId({ id: 'a', toolName: 'delegate_task', toolArgs: '{"goal":"same"}' }), null);

const assistant: ChatMessage = {
  id: 'assistant-tools',
  role: 'assistant',
  content: '',
  status: 'sent',
  piMessage: {
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'a', name: 'delegate_task', arguments: { goal: 'Same goal' } },
      { type: 'toolCall', id: 'b', name: 'delegate_task', arguments: { goal: 'Same goal' } },
    ],
    provider: 'test', model: 'test', stopReason: 'toolUse', timestamp: Date.now(),
  } as unknown as ChatMessage['piMessage'],
};

const html = renderToStaticMarkup(
  <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
    <ChatMessageList
      messages={[assistant, result('a', 'task-a'), result('b', 'task-b')]}
      toolOutputScope={{ sessionId: 'parent-one', agentId: 'bradley', workspaceId: 'workspace-one' }}
      assistantName="Bradley"
      assistantAgentId="bradley"
      userProfile={null}
      runtimePhase="idle"
      expandedRunKeys={new Set()}
      toolVerbosity="minimal"
      onToggleRunDisclosure={() => undefined}
      onAttachmentOpen={() => undefined}
    />
  </NextIntlClientProvider>,
);

assert.match(html, /data-delegation-id="task-a"/u);
assert.match(html, /data-delegation-id="task-b"/u);
assert.equal((html.match(/data-testid="chat-inline-delegation"/gu) ?? []).length, 2);
assert.doesNotMatch(html, /data-delegation-id="same goal"/u);

const persisted = mapPersistedChatMessages([
  { ...assistant.piMessage, id: 1, sequence: 1 } as PersistedChatMessage,
  { ...result('a', 'task-a').piMessage, id: 2, sequence: 2 } as PersistedChatMessage,
  { ...result('b', 'task-b').piMessage, id: 3, sequence: 3 } as PersistedChatMessage,
  { role: 'compact-break', kind: 'automatic', timestamp: Date.now(), omittedMessageCount: 3, id: 4, sequence: 4 } as unknown as PersistedChatMessage,
], 'Stopped');
const reloadedHtml = renderToStaticMarkup(
  <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
    <ChatMessageList
      messages={persisted}
      toolOutputScope={{ sessionId: 'parent-one', agentId: 'bradley', workspaceId: 'workspace-one' }}
      assistantName="Bradley"
      assistantAgentId="bradley"
      userProfile={null}
      runtimePhase="idle"
      expandedRunKeys={new Set()}
      toolVerbosity="minimal"
      onToggleRunDisclosure={() => undefined}
      onAttachmentOpen={() => undefined}
    />
  </NextIntlClientProvider>,
);
assert.match(reloadedHtml, /data-delegation-id="task-a"/u);
assert.match(reloadedHtml, /data-delegation-id="task-b"/u);
assert.match(reloadedHtml, /data-testid="chat-compaction-break"/u);

console.log('[Chat Inline Delegation Test] passed');
