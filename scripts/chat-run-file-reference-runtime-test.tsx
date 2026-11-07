import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { ChatMessageList } from '../app/components/canvas-agent-chat/ChatMessageList';
import type { ChatMessage } from '../app/lib/chat/types';
import type { RuntimeStatus } from '../app/lib/chat/runtime-status';

const translations = JSON.parse(readFileSync('messages/en.json', 'utf8'));
const user = (id: string): ChatMessage => ({ id, role: 'user', content: 'Read the document.', status: 'sent' });
const answer = (id: string): ChatMessage => ({ id, role: 'assistant', content: 'Document observed.', status: 'sent' });
const read = (id: string): ChatMessage => ({
  id, role: 'toolResult', toolName: 'read', toolCallId: id, content: 'Observed document.', status: 'sent',
  piMessage: {
    role: 'toolResult', toolName: 'read', toolCallId: id, isError: false, content: [], timestamp: 1,
    details: { chatFileReferences: { version: 1, references: [
      { workspaceId: 'ws-test', path: 'observed.txt', kind: 'read', toolCallId: id },
    ] } },
  } as ChatMessage['piMessage'],
});
const messages = [user('u1'), read('r1'), answer('a1'), user('u2'), read('r2'), answer('a2')];

function summaryCount(phase: RuntimeStatus['phase'] | null | undefined): number {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={translations}>
      <ChatMessageList messages={messages}
        toolOutputScope={{ workspaceId: 'ws-test', sessionId: 'chat-test', agentId: 'bradley' }}
        assistantName="Bradley" assistantAgentId="bradley" userProfile={null}
        runtimePhase={phase} expandedRunKeys={new Set()} toolVerbosity="subtle"
        onToggleRunDisclosure={() => undefined} onAttachmentOpen={() => undefined} />
    </NextIntlClientProvider>,
  );
  return (html.match(/data-testid="chat-file-references"/gu) ?? []).length;
}

assert.equal(summaryCount(undefined), 1, 'Unknown runtime must retain only the earlier completed run.');
assert.equal(summaryCount(null), 1, 'Missing runtime must not count as a completed current run.');
assert.equal(summaryCount('streaming'), 1, 'Streaming must retain earlier summaries without exposing the current one.');
assert.equal(summaryCount('idle'), 2, 'Confirmed completion must also expose the current summary.');
console.log('chat-run-file-reference-runtime-test: unknown/null/streaming/idle actual component PASS');
