import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import messages from '../messages/en.json';
import type * as Overlay from '../app/components/editor/ExcalidrawAgentOperations';

const dom = new JSDOM('<html><body></body></html>', { url: 'https://canvas.test/notebook' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'MouseEvent'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

type Request = { url: string; init: RequestInit; resolve(response: Response): void };
const operations = (label: string, casVersion = 7) => [{ operationId: `operation-${label}`, actorId: label,
  status: 'needs_review', reviewReason: `reason-${label}`, casVersion, updatedAt: 1,
  actions: [{ type: 'update', elementId: 'target' }] }];

async function main() {
  const { render, fireEvent } = await import('@testing-library/react');
  let enabled = true;
  let ready = false;
  const requests: Request[] = [];
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  let timerId = 0;
  let activeWorkspace = 'workspace-unrelated';
  const originalFetch = globalThis.fetch;
  const originalTimeout = window.setTimeout;
  const originalInterval = window.setInterval;
  const originalClearTimeout = window.clearTimeout;
  const originalClearInterval = window.clearInterval;
  window.setTimeout = ((callback: () => void) => { timeouts.set(++timerId, callback); return timerId; }) as typeof window.setTimeout;
  window.setInterval = ((callback: () => void) => { intervals.set(++timerId, callback); return timerId; }) as typeof window.setInterval;
  window.clearTimeout = id => { timeouts.delete(id); };
  window.clearInterval = id => { intervals.delete(id); };
  globalThis.fetch = async (url, init = {}) => new Promise<Response>(resolve => { requests.push({ url: String(url), init, resolve }); });
  const t = (key: string, values?: Record<string, unknown>) => {
    const value = (messages.notebook.collaboration as Record<string, string>)[key];
    assert.equal(typeof value, 'string', `Missing collaboration translation: ${key}`);
    return values ? Object.entries(values).reduce((text, [name, replacement]) => text.replace(`{${name}}`, String(replacement)), value) : value;
  };
  const file = path.resolve('app/components/editor/ExcalidrawAgentOperations.tsx');
  const native = createRequire(file);
  const javascript = ts.transpileModule(await fs.readFile(file, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const exports = {} as typeof Overlay;
  const mocks: Record<string, unknown> = {
    'next-intl': { useTranslations: () => t },
    'lucide-react': new Proxy({}, { get: () => () => null }),
    '@/components/ui/button': { Button: ({ children, size: _size, variant: _variant, ...props }:
      React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => <button {...props}>{children}</button> },
    '@/app/lib/files/client': { workspaceHeaders: (workspaceId?: string) => ({ 'x-canvas-workspace-id': workspaceId ?? activeWorkspace }) },
    '@/app/components/file-version-center/DocumentReviewAvailabilityProvider': { useDocumentReviewAvailability: () => ({
      documentReviewEnabled: enabled, ready, updatedAt: 'same-policy-version', applyAvailability() {},
    }) },
  };
  new Function('require', 'module', 'exports', javascript)((name: string) => name in mocks ? mocks[name] : native(name), { exports }, exports);
  const Component = exports.ExcalidrawAgentOperations;
  const props = { documentId: 'document-a', workspaceId: 'workspace-a', readOnly: false };
  const view = render(<Component {...props} />);
  const initial = async () => { await act(async () => {
    const pending = [...timeouts.values()]; timeouts.clear(); for (const callback of pending) callback();
  }); };
  const respond = async (request: Request, body: unknown) => { await act(async () => {
    request.resolve({ ok: true, json: async () => body } as Response);
  }); };
  const newest = () => { assert.ok(requests.at(-1)); return requests.at(-1)!; };
  const focused = async () => { await act(async () => { fireEvent.focus(window); }); };
  try {
    await initial();
    assert.equal(requests.length, 0, 'Unknown availability fails closed.');
    assert.equal(intervals.size, 0);
    ready = true; enabled = false;
    view.rerender(<Component {...props} />); await initial(); await focused();
    assert.equal(requests.length, 0, 'Disabled review does not fetch or subscribe to focus.');
    assert.equal(intervals.size, 0);

    enabled = true;
    view.rerender(<Component {...props} />); await initial();
    const delayed = newest();
    assert.equal(new Headers(delayed.init.headers).get('x-canvas-workspace-id'), props.workspaceId);
    assert.equal(intervals.size, 1);
    enabled = false; view.rerender(<Component {...props} />);
    assert.equal(delayed.init.signal?.aborted, true, 'Disabling aborts in-flight polling.');
    assert.equal(intervals.size, 0);
    await respond(delayed, { success: true, operations: operations('stale-disabled') }); await focused();
    assert.equal(view.queryByTestId('excalidraw-agent-review'), null);
    assert.equal(requests.length, 1);

    enabled = true; view.rerender(<Component {...props} />);
    assert.equal(view.queryByTestId('excalidraw-agent-review'), null, 'Re-enabling with the same policy timestamp cannot expose an old response.');
    await initial(); await respond(newest(), { success: true, operations: operations('live') });
    assert.ok(view.queryByTestId('excalidraw-agent-review'));
    await act(async () => { fireEvent.click(view.getByRole('button', { name: messages.notebook.collaboration.agentAccept })); });
    const action = newest();
    assert.equal(action.init.method, 'POST');
    assert.equal(JSON.parse(String(action.init.body)).expectedCasVersion, 7);
    assert.equal(new Headers(action.init.headers).get('x-canvas-workspace-id'), props.workspaceId);
    enabled = false; view.rerender(<Component {...props} />);
    assert.equal(action.init.signal?.aborted, true, 'Disabling also aborts an in-flight action.');
    await respond(action, { success: false, error: 'late action error' });
    assert.equal(view.queryByRole('alert'), null);
    assert.equal(view.queryByTestId('excalidraw-agent-review'), null);

    enabled = true; view.rerender(<Component {...props} />); await initial();
    assert.equal(view.queryByTestId('excalidraw-agent-review'), null, 'Previously loaded proposals are hidden until this activation is fetched.');
    const oldDocument = newest();
    activeWorkspace = 'workspace-b';
    const nextProps = { ...props, documentId: 'document-b', workspaceId: 'workspace-b' };
    view.rerender(<Component {...nextProps} />); await initial();
    assert.equal(oldDocument.init.signal?.aborted, true);
    const current = newest();
    assert.match(current.url, /document-b/u);
    assert.equal(new Headers(current.init.headers).get('x-canvas-workspace-id'), 'workspace-b');
    await respond(current, { success: true, operations: operations('current-document', 9) });
    await respond(oldDocument, { success: true, operations: operations('stale-document', 99) });
    assert.match(document.body.textContent ?? '', /current-document/u);
    assert.doesNotMatch(document.body.textContent ?? '', /stale-document/u);

    await focused(); const olderPoll = newest();
    await focused(); const newerPoll = newest();
    await respond(newerPoll, { success: true, operations: operations('newer-poll', 11) });
    await respond(olderPoll, { success: true, operations: operations('older-poll', 10) });
    assert.match(document.body.textContent ?? '', /newer-poll/u);
    assert.doesNotMatch(document.body.textContent ?? '', /older-poll/u);
    view.rerender(<Component {...nextProps} readOnly />);
    const count = requests.length;
    fireEvent.click(view.getByRole('button', { name: messages.notebook.collaboration.agentAccept }));
    assert.equal(requests.length, count, 'Read-only documents cannot submit a review action.');
    ready = false; view.rerender(<Component {...nextProps} />); await focused();
    assert.equal(view.queryByTestId('excalidraw-agent-review'), null);
    assert.equal(intervals.size, 0);
    assert.equal(requests.length, count, 'Loss of policy readiness stops requests immediately.');
    console.log('Excalidraw review UI: fail-closed/default OFF, no disabled polling, activation/context cleanup, action aborts, pinned workspace, CAS and stale-response protection passed.');
  } finally {
    view.unmount();
    globalThis.fetch = originalFetch;
    window.setTimeout = originalTimeout; window.setInterval = originalInterval;
    window.clearTimeout = originalClearTimeout; window.clearInterval = originalClearInterval;
    dom.window.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
