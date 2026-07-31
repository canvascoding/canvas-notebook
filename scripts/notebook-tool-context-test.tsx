import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { useNotebookToolContext } from '../app/components/notebook/useNotebookToolContext';
import type { ChatEvent } from '../app/lib/chat/types';
import type { NotebookChatContext } from '../app/lib/notebook/context-surface';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
});
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.defineProperty(globalThis, 'Event', { value: dom.window.Event, configurable: true });
Object.defineProperty(globalThis, 'CustomEvent', { value: dom.window.CustomEvent, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

type ToolContextController = ReturnType<typeof useNotebookToolContext>;

let latestController: ToolContextController | null = null;
const openedSurfaces: string[] = [];

function HookHarness({
  chatContext,
}: {
  chatContext: NotebookChatContext | null;
}) {
  const controller = useNotebookToolContext({
    chatContext,
    onOpen: (surface) => openedSurfaces.push(surface),
  });
  useEffect(() => {
    latestController = controller;
  }, [controller]);
  return null;
}

function controller(): ToolContextController {
  assert.ok(latestController, 'tool context hook should be rendered');
  return latestController;
}

async function dispatchAgentEvent(sessionId: string, event: ChatEvent) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent('agent_event', {
      detail: { sessionId, event },
    }));
  });
}

async function main() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const sessionA = { agentId: 'agent-a', sessionId: 'session-a' };
  const sessionB = { agentId: 'agent-b', sessionId: 'session-b' };

  await act(async () => {
    root.render(<HookHarness chatContext={sessionA} />);
  });

  await dispatchAgentEvent('another-session', {
    type: 'tool_execution_start',
    toolCallId: 'ignored-email',
    toolName: 'email_search',
    args: { query: 'ignored' },
  });
  assert.equal(controller().emailContext, null);
  assert.deepEqual(openedSurfaces, []);

  await dispatchAgentEvent(sessionA.sessionId, {
    type: 'tool_execution_start',
    toolCallId: 'email-1',
    toolName: 'email_search',
    args: {
      accountId: 'account-a',
      folder: 'INBOX',
      query: 'quarterly review',
    },
  });
  assert.equal(controller().emailContext?.status, 'running');
  assert.equal(controller().emailContext?.query, 'quarterly review');
  assert.deepEqual(openedSurfaces, ['email']);

  await dispatchAgentEvent(sessionA.sessionId, {
    type: 'tool_execution_update',
    toolCallId: 'email-1',
    toolName: 'email_search',
    args: { accountId: 'account-a' },
    partialResult: {
      details: {
        account: { id: 'account-a' },
      },
    },
  });
  assert.equal(controller().emailContext?.folder, 'INBOX');
  assert.equal(controller().emailContext?.query, 'quarterly review');
  assert.deepEqual(openedSurfaces, ['email'], 'updates must not steal focus again');

  await dispatchAgentEvent(sessionA.sessionId, {
    type: 'tool_execution_end',
    toolCallId: 'email-1',
    toolName: 'email_search',
    args: { accountId: 'account-a' },
    result: {
      details: {
        account: { id: 'account-a' },
      },
    },
  });
  assert.equal(controller().emailContext?.status, 'complete');
  assert.equal(controller().emailContext?.query, 'quarterly review');
  assert.deepEqual(openedSurfaces, ['email'], 'completion must not reopen the surface');

  await act(async () => {
    controller().clearEmail();
  });
  assert.equal(controller().emailContext, null);

  await dispatchAgentEvent(sessionA.sessionId, {
    type: 'tool_execution_end',
    toolCallId: 'email-1',
    toolName: 'email_search',
    args: { accountId: 'account-a' },
  });
  assert.equal(
    controller().emailContext,
    null,
    'a dismissed tool call must remain dismissed when late events arrive',
  );

  await dispatchAgentEvent(sessionA.sessionId, {
    type: 'tool_execution_start',
    toolCallId: 'email-2',
    toolName: 'email_read',
    args: {
      accountId: 'account-a',
      folder: 'Archive',
      messageId: 'message-a',
    },
  });
  assert.equal(controller().emailContext?.messageId, 'message-a');
  assert.deepEqual(openedSurfaces, ['email', 'email']);

  await act(async () => {
    root.render(<HookHarness chatContext={sessionB} />);
  });
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(controller().emailContext, null, 'changing chat session must clear email context');
  assert.equal(controller().browserContext, null, 'changing chat session must clear browser context');

  await dispatchAgentEvent(sessionB.sessionId, {
    type: 'tool_execution_start',
    toolCallId: 'browser-1',
    toolName: 'browser',
    args: {
      action: 'navigate',
      url: 'https://example.com',
    },
  });
  assert.deepEqual(controller().browserContext, {
    kind: 'browser',
    toolCallId: 'browser-1',
    toolName: 'browser',
    status: 'running',
    agentId: sessionB.agentId,
    sessionId: sessionB.sessionId,
    action: 'navigate',
    url: 'https://example.com',
  });
  assert.deepEqual(openedSurfaces, ['email', 'email', 'browser']);

  await dispatchAgentEvent(sessionB.sessionId, {
    type: 'tool_execution_update',
    toolCallId: 'browser-1',
    toolName: 'browser',
    args: { action: 'snapshot' },
  });
  assert.equal(controller().browserContext?.url, 'https://example.com');
  assert.equal(controller().browserContext?.action, 'snapshot');
  assert.deepEqual(openedSurfaces, ['email', 'email', 'browser']);

  await act(async () => {
    controller().clearBrowser();
  });
  await dispatchAgentEvent(sessionB.sessionId, {
    type: 'tool_execution_end',
    toolCallId: 'browser-1',
    toolName: 'browser',
    args: { action: 'snapshot' },
  });
  assert.equal(controller().browserContext, null);

  await act(async () => {
    root.unmount();
  });
  container.remove();

  console.log('notebook-tool-context-test: ok');
}

void main();
