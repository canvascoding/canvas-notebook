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
assert.equal(documentState.chatDocked, false);

const documentOpenedFromFullChatState = reduce({
  type: 'DOCUMENT_OPENED',
  dockChatIfFull: true,
});
assert.equal(documentOpenedFromFullChatState.mainSurface, 'document');
assert.equal(documentOpenedFromFullChatState.documentAvailable, true);
assert.equal(documentOpenedFromFullChatState.chatDocked, true);

const mobileChatState = notebookLayoutReducer(initialNotebookLayoutState, {
  type: 'VIEWPORT_CHANGED',
  viewport: 'mobile',
});
const mobileDocumentOpenedFromChatState = notebookLayoutReducer(mobileChatState, {
  type: 'DOCUMENT_OPENED',
  dockChatIfFull: true,
});
assert.equal(mobileDocumentOpenedFromChatState.mainSurface, 'document');
assert.equal(mobileDocumentOpenedFromChatState.chatDocked, false);

const chatState = notebookLayoutReducer(documentState, { type: 'SHOW_CHAT' });
assert.equal(chatState.mainSurface, 'chat');
assert.equal(chatState.lastWorkSurface, 'document');

const dockedState = notebookLayoutReducer(chatState, { type: 'SET_CHAT_DOCKED', docked: true });
assert.equal(dockedState.mainSurface, 'document');
assert.equal(dockedState.chatDocked, true);

const emptyWorkbenchDockedState = notebookLayoutReducer(initialNotebookLayoutState, {
  type: 'SET_CHAT_DOCKED',
  docked: true,
});
assert.equal(emptyWorkbenchDockedState.mainSurface, 'document');
assert.equal(emptyWorkbenchDockedState.documentAvailable, false);
assert.equal(emptyWorkbenchDockedState.chatDocked, true);

const mobileEmptyWorkbenchState = notebookLayoutReducer(emptyWorkbenchDockedState, {
  type: 'VIEWPORT_CHANGED',
  viewport: 'mobile',
});
assert.equal(mobileEmptyWorkbenchState.mainSurface, 'chat');
assert.equal(mobileEmptyWorkbenchState.chatDocked, false);
assert.equal(mobileEmptyWorkbenchState.explorerOpen, false);
assert.equal(mobileEmptyWorkbenchState.terminalOpen, false);

const compactEmptyWorkbenchState = notebookLayoutReducer(emptyWorkbenchDockedState, {
  type: 'VIEWPORT_CHANGED',
  viewport: 'desktop-compact',
});
assert.equal(compactEmptyWorkbenchState.mainSurface, 'chat');
assert.equal(compactEmptyWorkbenchState.chatDocked, false);

const closedLastDockedDocumentState = notebookLayoutReducer(dockedState, {
  type: 'DOCUMENT_CLOSED',
});
assert.equal(closedLastDockedDocumentState.mainSurface, 'document');
assert.equal(closedLastDockedDocumentState.documentAvailable, false);
assert.equal(closedLastDockedDocumentState.chatDocked, true);

const browserBesideChatState = reduce(
  { type: 'CONTEXT_OPENED', surface: 'browser' },
  { type: 'SET_CHAT_DOCKED', docked: true },
);
assert.equal(browserBesideChatState.mainSurface, 'browser');
assert.equal(browserBesideChatState.browserAvailable, true);
assert.equal(browserBesideChatState.chatDocked, true);

const compactState = notebookLayoutReducer(dockedState, {
  type: 'VIEWPORT_CHANGED',
  viewport: 'desktop-compact',
});
assert.equal(compactState.mainSurface, 'document');
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
}, {
  revision: 1,
  running: true,
  controlMode: 'agent',
  interactionPolicy: 'cooperative',
  interactionRevision: 0,
  lastUserInteractionAt: null,
  activeTabId: 'tab-1',
  activeTitle: 'Example',
  activeUrl: 'https://example.com/',
  tabCount: 1,
  tabs: [{ id: 'tab-1', title: 'Example', url: 'https://example.com/', active: true }],
  hasPendingDialog: false,
});
assert.deepEqual(browserStart, {
  kind: 'browser',
  toolCallId: 'browser-1',
  toolName: 'browser',
  status: 'running',
  agentId: 'canvas-agent',
  sessionId: 'session-a',
  snapshot: {
    revision: 1,
    running: true,
    controlMode: 'agent',
    interactionPolicy: 'cooperative',
    interactionRevision: 0,
    lastUserInteractionAt: null,
    activeTabId: 'tab-1',
    activeTitle: 'Example',
    activeUrl: 'https://example.com/',
    tabCount: 1,
    tabs: [{ id: 'tab-1', title: 'Example', url: 'https://example.com/', active: true }],
    hasPendingDialog: false,
  },
  action: 'navigate',
  url: 'https://example.com/',
});

assert.equal(notebookContextIntentFromAgentEvent({
  type: 'tool_execution_start',
  toolName: 'browser',
  args: { action: 'close' },
} satisfies ChatEvent, {
  agentId: 'canvas-agent',
  sessionId: 'session-a',
}, {
  revision: 1,
  running: true,
  controlMode: 'agent',
  interactionPolicy: 'cooperative',
  interactionRevision: 0,
  lastUserInteractionAt: null,
  activeTabId: 'tab-1',
  activeTitle: 'Example',
  activeUrl: 'https://example.com/',
  tabCount: 1,
  tabs: [{ id: 'tab-1', title: 'Example', url: 'https://example.com/', active: true }],
  hasPendingDialog: false,
}), null);

console.log('notebook-layout-state-test: ok');
