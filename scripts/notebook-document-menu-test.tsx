import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

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
  await act(async () => {
    root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={{ notebook: {
      openDocuments: 'Open documents', noOpenDocuments: 'No documents open',
      reopenClosedDocument: 'Reopen closed tab', workspaceRoot: 'Workspace root',
    } }}>
      <NotebookDocumentMenu paths={Array.from({ length: 9 }, (_, i) => `folder-${i}/index.md`)}
        activePath="folder-8/index.md" canReopen onSelect={(path) => { selected = path; }} onReopen={() => { reopened = true; }} />
    </NextIntlClientProvider>);
  });
  async function openMenu() {
    await act(async () => {
      document.querySelector('button')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
  }
  await openMenu();
  const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  assert.equal(items.length, 10, 'all nine documents and the reopen action must be reachable');
  assert.ok(items[8].textContent?.includes('folder-8'));
  await act(async () => { items[8].click(); });
  assert.equal(selected, 'folder-8/index.md');
  await openMenu();
  await act(async () => {
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).at(-1)!.click();
  });
  assert.equal(reopened, true);
  await act(async () => root.unmount());
  console.log('notebook-document-menu-test: ok');
}
void main();
