import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import en from '../messages/en.json';
import { buildWorkspaceLinkIndexFromDocuments } from '../app/lib/markdown/workspace-link-index-core';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event'] as const) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

async function main() {
  const [{ ObsidianWikiLink }, client, { useWorkspaceStore }] = await Promise.all([
    import('../app/components/shared/ObsidianWikiLink'),
    import('../app/lib/markdown/workspace-link-index-client'),
    import('../app/store/workspace-store'),
  ]);
  const root = createRoot(document.getElementById('root')!);
  const originalFetch = globalThis.fetch;
  const originalWorkspace = useWorkspaceStore.getState().activeWorkspaceId;
  const workspace = 'controlled-visible-wiki-priority';
  const requests: string[] = [];
  const index = buildWorkspaceLinkIndexFromDocuments([
    { path: 'A.md', content: '[[B]]\n' },
    { path: 'B.md', content: '# Original\n' },
    { path: 'C.md', content: '# Renamed\n' },
  ]);
  const router = { back() {}, forward() {}, refresh() {}, hmrRefresh() {}, bfcacheId: 'controlled',
    push() {}, replace() {}, async prefetch() {} };
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const render = async (target: string, markdownHref?: string) => act(async () => {
    root.render(<AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/en/notebook">
        <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
          <ObsidianWikiLink target={target} markdownHref={markdownHref} sourcePath="A.md">First</ObsidianWikiLink>
          <ObsidianWikiLink target={target} markdownHref={markdownHref} sourcePath="A.md">Second</ObsidianWikiLink>
        </NextIntlClientProvider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>);
    await flush();
  });
  const resolved = () => assert.equal(document.querySelectorAll('[data-canvas-wiki-status="resolved"]').length, 2);
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  globalThis.fetch = (async input => {
    const url = new URL(String(input), 'http://localhost');
    assert.equal(url.pathname, '/api/markdown/link-index'); requests.push(url.pathname);
    return Response.json({ success: true, index });
  }) as typeof fetch;
  useWorkspaceStore.setState({ activeWorkspaceId: workspace });
  try {
    await client.loadWorkspaceLinkIndex(workspace);
    assert.equal(requests.length, 1);
    client.invalidateWorkspaceLinkIndexCache(workspace);
    await render('B');
    assert.equal(requests.length, 2, 'Newly displayed links expedite their one shared index fetch within the background interval.');
    resolved();

    await act(async () => {
      client.invalidateWorkspaceLinkIndexCache(workspace);
      mock.timers.tick(250); await flush();
    });
    assert.equal(requests.length, 2, 'Repeated invalidation of an unchanged visible link stays background-paced.');
    await render('/C');
    assert.equal(requests.length, 3, 'A changed target promotes an already scheduled background request immediately.');
    resolved();
    assert.match(document.querySelector('button')?.getAttribute('aria-label') ?? '', /Renamed/u);

    await act(async () => {
      client.invalidateWorkspaceLinkIndexCache(workspace);
      mock.timers.tick(250); await flush();
    });
    assert.equal(requests.length, 3);
    await render('C', 'C.md');
    assert.equal(requests.length, 4, 'An exact Markdown reference receives the same interactive priority.');
    resolved();
    await act(async () => {
      client.invalidateWorkspaceLinkIndexCache(workspace);
      client.invalidateWorkspaceLinkIndexCache(workspace);
      mock.timers.tick(500); await flush();
    });
    assert.equal(requests.length, 4, 'Neither duplicate links nor repeated save hints bypass background pacing.');
    resolved();
    console.log(JSON.stringify({ suite: 'workspace-wiki-link-priority', newVisibleAndChangedTargetsImmediate: true,
      wikiAndMarkdown: true, duplicateLinksCoalesced: true, repeatedInvalidationBackgroundPaced: true,
      controlledClientTransportOnly: true }));
  } finally {
    await act(async () => root.unmount());
    for (let i = 0; i < 5; i++) { mock.timers.runAll(); await flush(); }
    mock.timers.reset(); globalThis.fetch = originalFetch;
    useWorkspaceStore.setState({ activeWorkspaceId: originalWorkspace });
    const { getNotebookQueryClient } = await import('../app/lib/queries/client');
    getNotebookQueryClient().clear(); dom.window.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
