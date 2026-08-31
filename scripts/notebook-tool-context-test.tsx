import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { useNotebookToolContext } from '../app/components/notebook/useNotebookToolContext';
import type { RuntimeStatus } from '../app/lib/chat/runtime-status';
import type { ChatEvent } from '../app/lib/chat/types';
import type { NotebookChatContext } from '../app/lib/notebook/context-surface';
import type { BrowserSessionSnapshot } from '../app/lib/pi/browser/types';

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
const closedSurfaces: string[] = [];

function HookHarness({
  chatContext,
  runtimeStatus = null,
}: {
  chatContext: NotebookChatContext | null;
  runtimeStatus?: RuntimeStatus | null;
}) {
  const controller = useNotebookToolContext({
    chatContext,
    runtimeStatus,
    onOpen: (surface) => openedSurfaces.push(surface),
    onClose: (surface) => closedSurfaces.push(surface),
  });
  useEffect(() => {
    latestController = controller;
  }, [controller]);
  return null;
}

function createRuntimeStatus(
  sessionId: string,
  browser?: BrowserSessionSnapshot,
  activeTool: RuntimeStatus['activeTool'] = null,
): RuntimeStatus {
  return {
    sessionId,
    ...(browser ? { browser } : {}),
    phase: activeTool ? 'running_tool' : 'idle',
    activeTool,
    pendingToolCalls: 0,
    followUpQueue: [],
    steeringQueue: [],
    canAbort: Boolean(activeTool),
    contextWindow: 128_000,
    estimatedHistoryTokens: 1_000,
    availableHistoryTokens: 100_000,
    contextUsagePercent: 1,
    includedSummary: false,
    omittedMessageCount: 0,
    summaryUpdatedAt: null,
    lastCompactionAt: null,
    lastCompactionKind: null,
    lastCompactionOmittedCount: 0,
  };
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

async function flushDeferredContextUpdates() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
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
    toolName: 'email_search_messages',
    args: { query: 'ignored' },
  });
  assert.equal(controller().emailContext, null);
  assert.deepEqual(openedSurfaces, []);

  await dispatchAgentEvent(sessionA.sessionId, {
    type: 'tool_execution_start',
    toolCallId: 'email-1',
    toolName: 'email_search_messages',
    args: {
      mailboxId: 'mailbox-a',
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
    toolName: 'email_search_messages',
    args: { mailboxId: 'mailbox-a' },
    partialResult: {
      details: {
        uiIntent: {
          view: 'message-list',
          mailboxId: 'mailbox-a',
          accountId: 'account-a',
          emailAddress: 'finance@example.com',
          scope: 'workspace',
          workspaceId: 'workspace-a',
        },
      },
    },
  });
  assert.equal(controller().emailContext?.folder, 'INBOX');
  assert.equal(controller().emailContext?.query, 'quarterly review');
  assert.equal(controller().emailContext?.accountId, 'account-a');
  assert.equal(controller().emailContext?.emailAddress, 'finance@example.com');
  assert.deepEqual(openedSurfaces, ['email'], 'updates must not steal focus again');

  await dispatchAgentEvent(sessionA.sessionId, {
    type: 'tool_execution_end',
    toolCallId: 'email-1',
    toolName: 'email_search_messages',
    args: { mailboxId: 'mailbox-a' },
    result: {
      details: {
        uiIntent: {
          view: 'message-list',
          mailboxId: 'mailbox-a',
          accountId: 'account-a',
          emailAddress: 'finance@example.com',
          scope: 'workspace',
          workspaceId: 'workspace-a',
        },
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
    toolName: 'email_search_messages',
    args: { mailboxId: 'mailbox-a' },
  });
  assert.equal(
    controller().emailContext,
    null,
    'a dismissed tool call must remain dismissed when late events arrive',
  );

  await dispatchAgentEvent(sessionA.sessionId, {
    type: 'tool_execution_start',
    toolCallId: 'email-2',
    toolName: 'email_read_message',
    args: {
      mailboxId: 'mailbox-a',
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
  assert.equal(
    controller().browserContext,
    null,
    'tool events must not create a browser surface before runtime confirms an active browser session',
  );

  const browserSnapshot: BrowserSessionSnapshot = {
    revision: 4,
    running: true,
    controlMode: 'agent',
    interactionPolicy: 'cooperative',
    interactionRevision: 0,
    lastUserInteractionAt: null,
    activeTabId: 'tab-2',
    activeTitle: 'Example',
    activeUrl: 'https://example.com/',
    tabCount: 2,
    tabs: [
      { id: 'tab-1', title: 'Docs', url: 'https://docs.example.com/', active: false },
      { id: 'tab-2', title: 'Example', url: 'https://example.com/', active: true },
    ],
    hasPendingDialog: false,
  };
  await act(async () => {
    root.render(
      <HookHarness
        chatContext={sessionB}
        runtimeStatus={createRuntimeStatus(
          sessionB.sessionId,
          browserSnapshot,
          { toolCallId: 'browser-1', name: 'browser' },
        )}
      />,
    );
  });
  await flushDeferredContextUpdates();
  assert.equal(controller().browserContext?.snapshot.activeTabId, 'tab-2');
  assert.equal(controller().browserContext?.status, 'running');
  assert.equal(controller().browserContext?.url, 'https://example.com/');
  assert.deepEqual(openedSurfaces, ['email', 'email', 'browser']);

  await dispatchAgentEvent(sessionB.sessionId, {
    type: 'tool_execution_start',
    toolCallId: 'browser-1',
    toolName: 'browser',
    args: { action: 'navigate', url: 'https://example.com/dashboard' },
  });
  assert.equal(
    controller().browserContext?.url,
    'https://example.com/',
    'the notebook surface should use the redacted runtime URL instead of raw tool arguments',
  );
  assert.equal(controller().browserContext?.action, 'navigate');
  assert.deepEqual(openedSurfaces, ['email', 'email', 'browser']);

  await act(async () => {
    controller().clearBrowser();
  });
  await act(async () => {
    root.render(
      <HookHarness
        chatContext={sessionB}
        runtimeStatus={createRuntimeStatus(sessionB.sessionId, { ...browserSnapshot })}
      />,
    );
  });
  await flushDeferredContextUpdates();
  assert.equal(controller().browserContext, null, 'the same runtime revision must stay dismissed');

  await act(async () => {
    root.render(
      <HookHarness
        chatContext={sessionB}
        runtimeStatus={createRuntimeStatus(sessionB.sessionId, {
          ...browserSnapshot,
          revision: browserSnapshot.revision + 1,
          activeTitle: 'Dashboard',
        })}
      />,
    );
  });
  await flushDeferredContextUpdates();
  assert.equal(
    controller().browserContext,
    null,
    'viewer-only runtime changes must not reopen a browser surface dismissed by the user',
  );

  await act(async () => {
    root.render(
      <HookHarness
        chatContext={sessionB}
        runtimeStatus={createRuntimeStatus(
          sessionB.sessionId,
          {
            ...browserSnapshot,
            revision: browserSnapshot.revision + 1,
            activeTitle: 'Dashboard',
          },
          { toolCallId: 'browser-2', name: 'browser' },
        )}
      />,
    );
  });
  await flushDeferredContextUpdates();
  assert.equal(controller().browserContext?.snapshot.activeTitle, 'Dashboard');
  assert.deepEqual(openedSurfaces, ['email', 'email', 'browser', 'browser']);

  await act(async () => {
    root.render(
      <HookHarness
        chatContext={sessionB}
        runtimeStatus={createRuntimeStatus(sessionB.sessionId)}
      />,
    );
  });
  await flushDeferredContextUpdates();
  assert.equal(controller().browserContext, null, 'runtime close must remove the browser surface');
  assert.equal(closedSurfaces.at(-1), 'browser');

  await act(async () => {
    root.unmount();
  });
  container.remove();

  console.log('notebook-tool-context-test: ok');
}

void main();
