import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import { ChatMessageList } from '../app/components/canvas-agent-chat/ChatMessageList';
import type { ChatMessage } from '../app/lib/chat/types';

const root = process.cwd();
const read = (filePath: string) => readFileSync(path.join(root, filePath), 'utf8');

const messageList = read('app/components/canvas-agent-chat/ChatMessageList.tsx');
const chat = read('app/components/canvas-agent-chat/CanvasAgentChat.tsx');
const sessionApi = read('app/lib/chat/session-api.ts');
const germanMessages = JSON.parse(read('messages/de.json')) as { chat: Record<string, string> };
const englishMessages = JSON.parse(read('messages/en.json')) as { chat: Record<string, string> };

assert.match(messageList, /GitFork/u, 'assistant actions must render a fork icon');
assert.match(messageList, /data-testid=\{forkSequence \? `chat-message-fork-\$\{forkSequence\}`/u);
assert.match(messageList, /getChatMessageSequence\(message\) === null/u, 'only persisted messages may be forked');
assert.match(messageList, /message\.status === 'sending'/u, 'streaming responses must not be forkable');
assert.match(messageList, /isAbortedAssistantPiMessage/u, 'aborted responses must not be forkable');
assert.match(messageList, /type === 'toolCall'/u, 'tool-call assistant messages must not be forkable');
assert.match(messageList, /disabled=\{forkDisabled \|\| isForking\}/u, 'fork action must prevent duplicate clicks');

assert.match(sessionApi, /\/api\/sessions\/\$\{encodeURIComponent\(sourceSessionId\)\}\/fork/u);
assert.match(chat, /activeSession\?\.engine === 'pi'/u, 'legacy sessions must not expose the fork action');
assert.match(chat, /clientRequestId: crypto\.randomUUID\(\)/u, 'each UI request must carry an idempotency key');
assert.match(chat, /setHistory\(\(current\) => \[/u, 'the fork must be added to session history');
assert.match(chat, /await loadSession\(forkedSession\)/u, 'the fork must open after creation');
assert.match(chat, /textareaRef\.current\?\.focus\(\)/u, 'the composer must receive focus after opening');

assert.equal(germanMessages.chat.forkChatFromHere, 'Chat ab hier forken');
assert.equal(germanMessages.chat.forkFailed, 'Der Chat konnte nicht geforkt werden.');
assert.equal(englishMessages.chat.forkChatFromHere, 'Fork chat from here');
assert.equal(englishMessages.chat.forkFailed, 'The chat could not be forked.');

function renderMessages(messages: ChatMessage[]): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={englishMessages}>
      <ChatMessageList
        messages={messages}
        assistantName="Bradley"
        assistantAgentId="canvas-agent"
        userProfile={null}
        runtimePhase="idle"
        expandedRunKeys={new Set()}
        toolVerbosity="subtle"
        onToggleRunDisclosure={() => undefined}
        onAttachmentOpen={() => undefined}
        onForkAssistantMessage={async () => undefined}
      />
    </NextIntlClientProvider>,
  );
}

const completedAssistant: ChatMessage = {
  id: '2',
  role: 'assistant',
  content: 'Start with the launch brief.',
  status: 'sent',
  piMessage: {
    role: 'assistant',
    content: [{ type: 'text', text: 'Start with the launch brief.' }],
    provider: 'test-provider',
    model: 'test-model',
    stopReason: 'stop',
    timestamp: Date.now(),
    sequence: 2,
  } as unknown as ChatMessage['piMessage'],
};
const completedHtml = renderMessages([completedAssistant]);
assert.match(completedHtml, /data-testid="chat-message-fork-2"/u);
assert.match(completedHtml, /aria-label="Fork chat from here"/u);

const toolCallHtml = renderMessages([{
  ...completedAssistant,
  id: '4',
  piMessage: {
    ...(completedAssistant.piMessage as object),
    content: [
      { type: 'text', text: 'I will check.' },
      { type: 'toolCall', id: 'tool-1', name: 'read', arguments: {} },
    ],
    stopReason: 'toolUse',
    sequence: 4,
  } as unknown as ChatMessage['piMessage'],
}]);
assert.doesNotMatch(toolCallHtml, /chat-message-fork-/u);

const streamingHtml = renderMessages([{ ...completedAssistant, status: 'sending' }]);
assert.doesNotMatch(streamingHtml, /chat-message-fork-/u);

console.log('[Chat Session Fork UI Test] passed');
