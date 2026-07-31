import assert from 'node:assert/strict';

import type { ChatEvent } from '../app/lib/chat/types';
import {
  NOTEBOOK_LAYOUT_STORAGE_KEY,
  initialNotebookLayoutState,
  notebookLayoutReducer,
  readNotebookLayoutPreferences,
  writeNotebookLayoutPreferences,
} from '../app/lib/notebook/layout-state';
import {
  notebookContextIntentFromAgentEvent,
} from '../app/lib/notebook/context-surface';

function reduce(...actions: Parameters<typeof notebookLayoutReducer>[1][]) {
  return actions.reduce(notebookLayoutReducer, initialNotebookLayoutState);
}

const documentState = reduce({ type: 'DOCUMENT_OPENED' });
assert.equal(documentState.mainSurface, 'document');
assert.equal(documentState.documentAvailable, true);

const chatState = notebookLayoutReducer(documentState, { type: 'SHOW_CHAT' });
assert.equal(chatState.mainSurface, 'chat');
assert.equal(chatState.lastWorkSurface, 'document');

const dockedState = notebookLayoutReducer(chatState, { type: 'SET_CHAT_DOCKED', docked: true });
assert.equal(dockedState.mainSurface, 'document');
assert.equal(dockedState.chatDocked, true);

const compactState = notebookLayoutReducer(dockedState, {
  type: 'VIEWPORT_CHANGED',
  viewport: 'desktop-compact',
});
assert.equal(compactState.mainSurface, 'chat');
assert.equal(compactState.chatDocked, false);

const contextualState = reduce(
  { type: 'DOCUMENT_OPENED' },
  { type: 'CONTEXT_OPENED', surface: 'email' },
  { type: 'CONTEXT_OPENED', surface: 'browser' },
);
assert.equal(contextualState.mainSurface, 'browser');
assert.equal(contextualState.emailAvailable, true);
assert.equal(contextualState.browserAvailable, true);

const closedBrowserState = notebookLayoutReducer(contextualState, {
  type: 'CONTEXT_CLOSED',
  surface: 'browser',
});
assert.equal(closedBrowserState.mainSurface, 'document');
assert.equal(closedBrowserState.browserAvailable, false);

const closedDocumentState = notebookLayoutReducer(documentState, { type: 'DOCUMENT_CLOSED' });
assert.equal(closedDocumentState.mainSurface, 'chat');
assert.equal(closedDocumentState.documentAvailable, false);

const values = new Map<string, string>([
  ['canvas.notebookDesktopSidebarVisible', 'false'],
  ['canvas.leftSidebarWidth', '510'],
  ['canvas.notebookChatWidth', '480'],
  ['canvas.terminalVisible', 'true'],
]);
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
  clear: () => values.clear(),
  key: (index: number) => Array.from(values.keys())[index] ?? null,
  get length() { return values.size; },
} satisfies Storage;

const migrated = readNotebookLayoutPreferences(storage);
assert.deepEqual(migrated, {
  version: 2,
  explorerOpen: false,
  explorerWidth: 510,
  chatWidth: 480,
  terminalOpen: true,
});
writeNotebookLayoutPreferences(storage, migrated);
assert.equal(JSON.parse(values.get(NOTEBOOK_LAYOUT_STORAGE_KEY) || '{}').version, 2);

const emailStart = notebookContextIntentFromAgentEvent({
  type: 'tool_execution_start',
  toolCallId: 'email-1',
  toolName: 'email_read',
  args: {
    accountId: 'account-a',
    messageId: 'message-a',
    folder: 'INBOX',
  },
} satisfies ChatEvent, null);
assert.deepEqual(emailStart, {
  kind: 'email',
  toolCallId: 'email-1',
  toolName: 'email_read',
  status: 'running',
  accountId: 'account-a',
  folder: 'INBOX',
  messageId: 'message-a',
  draftId: undefined,
  query: undefined,
  subject: undefined,
});

const emailEnd = notebookContextIntentFromAgentEvent({
  type: 'tool_execution_end',
  toolCallId: 'email-1',
  toolName: 'email_read',
  args: {
    accountId: 'account-a',
    messageId: 'message-a',
  },
  result: {
    details: {
      message: {
        id: 'message-a',
        folder: 'Archive',
        subject: 'Quarterly review',
      },
    },
  },
} satisfies ChatEvent, null);
assert.equal(emailEnd?.kind, 'email');
assert.equal(emailEnd?.status, 'complete');
assert.equal(emailEnd?.folder, 'Archive');
assert.equal(emailEnd?.subject, 'Quarterly review');

const browserStart = notebookContextIntentFromAgentEvent({
  type: 'tool_execution_start',
  toolCallId: 'browser-1',
  toolName: 'browser',
  args: {
    action: 'navigate',
    url: 'https://example.com',
  },
} satisfies ChatEvent, {
  agentId: 'canvas-agent',
  sessionId: 'session-a',
});
assert.deepEqual(browserStart, {
  kind: 'browser',
  toolCallId: 'browser-1',
  toolName: 'browser',
  status: 'running',
  agentId: 'canvas-agent',
  sessionId: 'session-a',
  action: 'navigate',
  url: 'https://example.com',
});

assert.equal(notebookContextIntentFromAgentEvent({
  type: 'tool_execution_start',
  toolName: 'browser',
  args: { action: 'close' },
} satisfies ChatEvent, {
  agentId: 'canvas-agent',
  sessionId: 'session-a',
}), null);

console.log('notebook-layout-state-test: ok');
