import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';
import { WorkspaceStarterInitializationStatus } from '../app/components/settings/WorkspaceStarterInitializationStatus';

const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'http://localhost' });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, name, { value, configurable: true });
}

async function main() {
  const container = document.querySelector('main')!;
  const root = createRoot(container);
  const workspaceId = 'already-created-workspace';
  const initial = { version: 1 as const, workspaceId, status: 'pending' as const };
  const calls: string[] = [];
  let status = 'pending', responseWorkspace = workspaceId, reject = false;
  globalThis.fetch = (async (input, options) => {
    assert.equal(input, `/api/workspaces/${workspaceId}/starter-document-initialization`);
    assert.equal(new Headers(options?.headers).get('x-canvas-workspace-id'), workspaceId);
    assert.equal(options?.body, undefined, 'resume cannot replace saved IDs, source paths or content');
    assert.equal(options?.cache, 'no-store');
    calls.push(options?.method ?? 'GET');
    if (reject) throw new Error('Disconnected');
    return Response.json({ starterDocumentInitialization: { version: 1, workspaceId: responseWorkspace, status } },
      { status: status === 'blocked' ? 409 : status === 'pending' ? 202 : 200 });
  }) as typeof fetch;
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent === label);
    assert.ok(button, `Expected ${label}`);
    await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  };
  try {
    await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <WorkspaceStarterInitializationStatus initial={initial} />
    </NextIntlClientProvider>));
    assert.match(container.textContent!, /workspace has been created/iu);
    assert.equal(calls.length, 0, 'displaying a pending result cannot start a mutation');
    await click('Check status');
    assert.deepEqual(calls, ['GET']);
    assert.match(container.textContent!, /not yet confirmed/iu);
    responseWorkspace = 'another-workspace'; status = 'completed';
    await click('Resume setup');
    assert.ok(container.querySelector('[role="alert"]'), 'a response for another workspace cannot clear the warning');
    assert.match(container.textContent!, /not yet confirmed/iu);
    responseWorkspace = workspaceId; reject = true;
    await click('Check status');
    assert.match(container.textContent!, /workspace is retained/iu);
    reject = false; status = 'blocked';
    await click('Resume setup');
    assert.match(container.textContent!, /setup is blocked/iu);
    assert.equal(container.querySelector('[role="alert"]'), null, 'a confirmed blocked result has its own explanation');
    status = 'completed';
    await click('Resume setup');
    assert.equal(container.textContent, '');
    assert.deepEqual(calls, ['GET', 'POST', 'GET', 'POST', 'POST']);
    console.log('workspace-starter-initialization-ui-test: 7 recovery assertions passed');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
