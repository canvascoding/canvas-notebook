import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { useWorkspaceStore } from '../app/store/workspace-store';
import type { ChatFileReference } from '../app/lib/chat/tool-file-references';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'HTMLInputElement', 'MouseEvent'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
Object.defineProperty(globalThis, 'React', { value: React, configurable: true });
let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('References must not fetch during rendering'); };
const opened: string[] = [];
const modules = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = modules._load;
modules._load = (request, parent, isMain) => {
  if (request.endsWith('/useOpenChatFileReference')) return { useOpenChatFileReference: () => async (path: string) => { opened.push(path); } };
  return originalLoad(request, parent, isMain);
};

async function main() {
  const { FileReferenceCard } = await import('../app/components/canvas-agent-chat/FileReferenceCard');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-a' });
  const results: ChatFileReference[] = Array.from({ length: 14 }, (_, index) => ({ workspaceId: 'workspace-a', path: `reports/file-${index}.docx`, kind: index === 0 ? 'review_required' : 'created', toolCallId: `call-${index}` }));
  const reads: ChatFileReference[] = Array.from({ length: 12 }, (_, index) => ({ workspaceId: 'workspace-a', path: `sources/source-${index}.pdf`, kind: 'read', toolCallId: `read-${index}` }));
  const render = async (references = [...results, ...reads], omittedCount = 0) => {
    await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><FileReferenceCard references={references} omittedCount={omittedCount} /></NextIntlClientProvider>));
  };
  const items = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="chat-file-reference-item"]')];
  const button = (testId: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
  const click = async (element: HTMLElement) => { await act(async () => element.click()); };
  await render();
  assert.equal(items().length, 3);
  assert.match(document.body.textContent!, /Change proposed/);
  assert.equal(button('chat-file-references-expand').getAttribute('aria-expanded'), 'false');
  assert.equal(button('chat-read-references-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('[data-testid="chat-file-references-search"]'), null);
  assert.equal(fetches, 0);
  await click(items()[0]);
  assert.deepEqual(opened, ['reports/file-0.docx']);
  await click(button('chat-file-references-expand'));
  assert.equal(items().length, 14);
  const search = document.querySelector<HTMLInputElement>('[data-testid="chat-file-references-search"]')!;
  assert.ok(search.id && document.querySelector(`label[for="${search.id}"]`));
  assert.ok(items()[0].closest('ul')?.classList.contains('max-h-72'));
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'file-13');
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    search.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  assert.equal(items().length, 1);
  await render([...results, { ...results[1], path: 'reports/file-130.docx' }, ...reads], 2);
  assert.equal(items().length, 2);
  assert.equal(button('chat-file-references-expand').getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelector<HTMLInputElement>('[data-testid="chat-file-references-search"]')!.value, 'file-13');
  assert.match(document.body.textContent!, /2 additional files/);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(search, '');
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await click(button('chat-read-references-toggle'));
  assert.equal(items().length, 27);
  assert.equal(button('chat-read-references-toggle').getAttribute('aria-expanded'), 'true');
  await click(button('chat-file-references-expand'));
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'file-13');
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  assert.equal(items().length, 2, 'shared search includes results beyond the collapsed preview');
  await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-b' }));
  assert.equal(items().every(item => item.disabled), true);
  await click(items()[0]);
  assert.equal(opened.length, 1);
  assert.equal(fetches, 0);
  await render([]);
  assert.equal(document.querySelector('[data-testid="chat-file-references"]'), null);
  await act(async () => root.unmount());
  modules._load = originalLoad;
  console.log('chat file reference card tests passed');
}
void main();
