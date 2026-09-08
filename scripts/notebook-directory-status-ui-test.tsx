import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'Event'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
Object.defineProperty(globalThis, 'getComputedStyle', { value: dom.window.getComputedStyle.bind(dom.window), configurable: true });
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: dom.window.requestAnimationFrame.bind(dom.window), configurable: true });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: dom.window.cancelAnimationFrame.bind(dom.window), configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });

async function main() {
  const { FileTreeNode } = await import('../app/components/file-browser/FileTreeNode');
  const { SidebarProvider, SidebarMenu } = await import('../components/ui/sidebar');
  const { useFileStore } = await import('../app/store/file-store');
  useFileStore.getState().resetWorkspaceView();
  useFileStore.setState({ expandedDirs: new Set(['docs']), fileTree: [{ name: 'docs', path: 'docs', type: 'directory', children: [
    { path: 'docs/retained.txt', name: 'retained.txt', type: 'file' },
  ] }] });
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <SidebarProvider><SidebarMenu><FileTreeNode node={useFileStore.getState().fileTree[0]} /></SidebarMenu></SidebarProvider>
    </NextIntlClientProvider>,
  ));
  const child = document.querySelector('[data-file-path="docs/retained.txt"]');
  assert.ok(child, 'expanded folder renders the cached child');
  const group = document.querySelector('[role="group"]')!;
  const childCount = group.children.length;
  await act(async () => useFileStore.setState({ loadingDirs: new Set(['docs']), directoryLoadStates: { docs: 'refreshing' } }));
  assert.equal(document.querySelector('[data-file-path="docs/retained.txt"]'), child, 'refresh keeps the same child DOM node mounted');
  assert.equal(group.children.length, childCount, 'refresh adds no visible row before existing children');
  assert.ok(!document.body.textContent?.includes('Updating folder'), 'short background reads stay quiet');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 230)); });
  assert.ok(document.body.textContent?.includes('Updating folder'));
  assert.equal(group.children.length, childCount, 'delayed refresh indicator stays in the existing header');
  await act(async () => useFileStore.setState({ loadingDirs: new Set(), directoryLoadStates: { docs: 'error' }, directoryErrors: { docs: 'Retry this folder' } }));
  assert.equal(document.querySelector('[data-file-path="docs/retained.txt"]'), child, 'error also retains the visible snapshot');
  assert.ok(document.body.textContent?.includes('Retry this folder'));
  await act(async () => root.unmount());
  dom.window.close();
  console.log('notebook-directory-status-ui-test: ok');
}
main().catch((error) => { console.error(error); dom.window.close(); process.exitCode = 1; });
