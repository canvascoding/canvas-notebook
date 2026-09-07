import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (filePath: string) => readFileSync(path.join(root, filePath), 'utf8');

const canvasAgentChat = read('app/components/canvas-agent-chat/CanvasAgentChat.tsx');
const chatHeader = read('app/components/canvas-agent-chat/ChatHeader.tsx');
const controlActions = read('app/components/canvas-agent-chat/useChatControlActions.ts');
const germanMessages = JSON.parse(read('messages/de.json')) as { chat: Record<string, string> };
const englishMessages = JSON.parse(read('messages/en.json')) as { chat: Record<string, string> };

assert.match(controlActions, /keepHistoryOpen\?: boolean/);
assert.match(controlActions, /!options\?\.keepHistoryOpen && \(isMobile \|\| shouldShowHistoryAsOverlay\)/);
assert.match(canvasAgentChat, /startNewChat\(undefined, \{ keepHistoryOpen: showHistory \}\)/);

assert.match(chatHeader, /data-testid="chat-delete-session"/);
assert.match(chatHeader, /className="text-destructive focus:text-destructive"/);
assert.match(chatHeader, /onSelect=\{onDeleteSession\}/);
assert.match(chatHeader, /disabled=\{!sessionId\}/);
assert.match(canvasAgentChat, /if \(sessionId\) void deleteSession\(sessionId\)/);

assert.equal(germanMessages.chat.deleteSession, 'Chat löschen');
assert.equal(germanMessages.chat.deleteSessionConfirm, 'Möchtest du diesen Chat wirklich löschen?');
assert.equal(englishMessages.chat.deleteSession, 'Delete chat');
assert.equal(englishMessages.chat.deleteSessionConfirm, 'Are you sure you want to delete this chat?');

console.log('chat-delete-ui-contract-test: ok');
