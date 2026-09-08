import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'Event', 'HTMLInputElement'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
Object.defineProperty(globalThis, 'getComputedStyle', { value: dom.window.getComputedStyle.bind(dom.window), configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const root = createRoot(document.getElementById('root')!);
let selected = '';
let reopened = false;
async function main() {
  const { NotebookDocumentMenu } = await import('../app/components/notebook/NotebookDocumentMenu');
  let closeCalls = 0;
  let resolveClose!: (result: boolean) => void;
  function Harness() {
    const [paths, setPaths] = useState(Array.from({ length: 100 }, (_, i) => `folder-${i}/index.md`));
    return <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <NotebookDocumentMenu paths={paths} activePath="folder-99/index.md" canReopen
        onSelect={(path) => { selected = path; }} onReopen={() => { reopened = true; }}
        onCloseAll={async () => {
          closeCalls += 1;
          const result = await new Promise<boolean>((resolve) => { resolveClose = resolve; });
          if (result) setPaths([]);
          return result;
        }} />
    </NextIntlClientProvider>;
  }
  await act(async () => {
    root.render(<Harness />);
  });
  async function openMenu() {
    await act(async () => {
      document.querySelector('button')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
  }
  await openMenu();
  const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  assert.equal(items.length, 102, 'all 100 documents, close all, and reopen must be reachable');
  assert.ok(items[9].textContent?.includes('folder-8'));
  await act(async () => { items[9].click(); });
  assert.equal(selected, 'folder-8/index.md');
  await openMenu();
  await act(async () => {
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).at(-1)!.click();
  });
  assert.equal(reopened, true);
  const trigger = () => document.querySelector<HTMLButtonElement>('[data-testid="notebook-documents-menu"]')!;
  const closeAll = () => document.querySelector<HTMLButtonElement>('[data-testid="notebook-close-all-documents"]')!;
  assert.equal(trigger().getAttribute('aria-label'), 'Open documents: 100');
  await openMenu();
  assert.ok(closeAll().className.includes('text-destructive'));
  await act(async () => closeAll().click());
  assert.equal(closeCalls, 1);
  assert.equal(closeAll().disabled, true);
  assert.equal(closeAll().getAttribute('aria-busy'), 'true');
  assert.ok(closeAll().textContent?.includes('Closing'));
  await act(async () => closeAll().click());
  assert.equal(closeCalls, 1, 'double clicks must not start two close operations');
  await act(async () => resolveClose(false));
  assert.equal(trigger().getAttribute('aria-expanded'), 'true', 'failed close keeps the document list available');
  assert.equal(closeAll().disabled, false);
  assert.equal(trigger().getAttribute('aria-label'), 'Open documents: 100');
  await act(async () => closeAll().click());
  await act(async () => { resolveClose(true); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, trigger(), 'successful cleanup returns keyboard focus to the menu trigger');
  assert.equal(trigger().getAttribute('aria-label'), 'Open documents: 0');
  await openMenu();
  assert.equal(closeAll().disabled, true);
  await act(async () => closeAll().click());
  assert.equal(closeCalls, 2, 'an empty list must not invoke close all');
  await act(async () => root.unmount());
  console.log('notebook-document-menu-test: ok');
}
void main();
