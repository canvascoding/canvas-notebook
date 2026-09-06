import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { useNotebookToolContext } from '../app/components/notebook/useNotebookToolContext';
import type { RuntimeStatus } from '../app/lib/chat/runtime-status';
import type { BrowserSessionSnapshot } from '../app/lib/pi/browser/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const timers = new Map<number, () => void>();
let timerId = 0;
window.setTimeout = ((callback: () => void) => {
  timers.set(++timerId, callback);
  return timerId;
}) as typeof window.setTimeout;
window.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof window.clearTimeout;

let controller: ReturnType<typeof useNotebookToolContext>;
function current() { return controller; }
const opened: string[] = [];
const closed: string[] = [];
const scopes = { a: { agentId: 'agent-a', sessionId: 'a' }, b: { agentId: 'agent-b', sessionId: 'b' } };
const snapshot: BrowserSessionSnapshot = {
  revision: 1, running: true, controlMode: 'agent', interactionPolicy: 'cooperative',
  interactionRevision: 0, lastUserInteractionAt: null, activeTabId: 'tab-1',
  activeTitle: 'First', activeUrl: 'https://example.com/first', tabCount: 1,
  tabs: [], hasPendingDialog: false,
};

function Harness({ scope, status }: { scope: 'a' | 'b'; status: RuntimeStatus | null }) {
  const value = useNotebookToolContext({
    chatContext: scopes[scope], runtimeStatus: status,
    onOpen: (surface) => opened.push(surface), onClose: (surface) => closed.push(surface),
  });
  useEffect(() => { controller = value; }, [value]);
  return null;
}

function status(scope: 'a' | 'b', browser: BrowserSessionSnapshot | undefined): RuntimeStatus {
  return { sessionId: scope, browser, activeTool: null } as RuntimeStatus;
}

async function flush() {
  await act(async () => {
    for (const [id, callback] of [...timers]) {
      timers.delete(id);
      callback();
    }
  });
}

async function main() {
  const root = createRoot(document.createElement('div'));
  const render = async (scope: 'a' | 'b', browser?: BrowserSessionSnapshot) => {
    await act(async () => root.render(<StrictMode><Harness scope={scope} status={status(scope, browser)} /></StrictMode>));
  };
  await render('a', snapshot);
  await render('a', { ...snapshot, revision: 2, activeTitle: 'Second' });
  await flush();
  assert.deepEqual(opened, ['browser'], 'StrictMode and rapid status updates must open exactly once');
  assert.equal(current().browserContext?.snapshot.activeTitle, 'Second');

  await act(async () => controller.clearBrowser());
  await render('a', { ...snapshot, revision: 3, activeUrl: 'https://example.com/latest' });
  await flush();
  assert.equal(current().browserContext, null, 'status changes must respect a dismissed surface');
  await act(async () => controller.openBrowser());
  assert.equal(current().browserContext?.url, 'https://example.com/latest', 'manual open restores the latest snapshot');
  assert.equal(opened.length, 2);

  await render('b', { ...snapshot, activeTitle: 'Session B' });
  assert.equal(current().browserContext, null, 'old session must disappear before deferred updates run');
  await flush();
  assert.equal(current().browserContext?.sessionId, 'b');
  assert.equal(current().browserContext?.snapshot.activeTitle, 'Session B');
  assert.equal(opened.length, 3);

  await render('b');
  await render('b');
  await flush();
  assert.equal(current().browserContext, null);
  assert.equal(closed.at(-1), 'browser', 'rapid stopped snapshots must close the layout');
  await act(async () => controller.openBrowser());
  assert.equal(current().browserContext, null, 'stopped browsers cannot be reopened from stale state');

  await render('b', snapshot);
  await act(async () => controller.clearBrowser());
  await flush();
  assert.equal(current().browserContext, null, 'manual dismissal wins over pending auto-open');
  assert.equal(opened.length, 3);
  await act(async () => controller.openBrowser());
  assert.equal(current().browserContext?.sessionId, 'b');

  await act(async () => root.unmount());
  assert.equal(timers.size, 0);
  console.log('notebook-browser-lifecycle-test: ok');
}

void main();
