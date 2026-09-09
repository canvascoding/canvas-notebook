import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createNotebookDocumentLocationWatcher } from '../app/lib/notebook/document-location-watcher';
import { activateNotebookDocumentTab, adoptNotebookDocumentLocation, closeNotebookDocumentTab,
  openNotebookDocumentTab, rememberNotebookDocumentId, type NotebookDocumentTabsState } from '../app/lib/notebook/document-tabs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });

async function main() {
  const originalFetch = globalThis.fetch;
  const requests: { id: string; signal: AbortSignal; resolve: (path: string | null) => void; pending: boolean }[] = [];
  let running = 0, peak = 0, owners = 0, generation = 1;
  const events = Object.assign(new dom.window.EventTarget(), {
    acquire() { owners++; }, releaseConnection() { owners--; },
  });
  let tabs: NotebookDocumentTabsState = { activePath: 'd.md', openPaths: ['a.md', 'b.md', 'c.md', 'd.md'],
    documentIds: { 'a.md': 'a', 'b.md': 'b', 'c.md': 'c', 'd.md': 'd' } };
  const applied: string[] = [];
  globalThis.fetch = async (input, options) => {
    const id = new URL(String(input), 'https://canvas.test').searchParams.get('documentId')!;
    running++; peak = Math.max(peak, running);
    // Deliberately retain responses even after abort to exercise lifetime checks.
    return new Promise(resolve => {
      const request = { id, signal: options!.signal as AbortSignal, pending: true, resolve: (path: string | null) => {
        if (!request.pending) return;
        request.pending = false; running--;
        resolve(path === null ? new Response('', { status: 404 }) : Response.json({ success: true, workspaceId: 'workspace',
          documentId: id, path, lifecycleGeneration: 1, representation: 'tiptap_blocks' }));
      } };
      requests.push(request);
    });
  };
  const watcher = createNotebookDocumentLocationWatcher({ workspaceId: 'workspace', watcher: events,
    getTabs: () => tabs, isCurrent: () => generation === 1, isActive: path => path === 'd.md',
    onLocation: (path, id, location) => { applied.push(`${id}:${location.path}`); tabs = adoptNotebookDocumentLocation(tabs, path, id, location.path); watcher.track(); },
  });
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    await flush();
    assert.equal(requests.length, 2); assert.equal(owners, 1);
    assert.deepEqual(requests.map(request => request.id), ['a', 'b']);
    const oldB = requests[1];
    tabs = closeNotebookDocumentTab(tabs, 'b.md'); watcher.track();
    tabs = activateNotebookDocumentTab(rememberNotebookDocumentId(openNotebookDocumentTab(tabs, 'b.md').state, 'b.md', 'b'), 'd.md');
    watcher.track();
    assert(oldB.signal.aborted, 'close revokes the old request even when the same identity is reopened');
    requests[0].resolve('a.md'); await flush();
    assert.equal(requests[2].id, 'c');
    requests[2].resolve('c.md'); await flush();
    assert.equal(requests[3].id, 'b');
    oldB.resolve('stale/b.md'); await flush();
    assert.equal(applied.some(value => value === 'b:stale/b.md'), false);
    requests[3].resolve('renamed/b.md'); await flush();
    assert.equal(tabs.documentIds?.['renamed/b.md'], 'b');
    assert.equal(tabs.openPaths.includes('stale/b.md'), false);
    assert.equal(peak, 2, 'all lookups share the two-request bound');

    // A rename introduces a new tracked path. A failed resolution keeps it intact.
    const freshB = requests.find(request => request.pending && request.id === 'b')!;
    assert(freshB); freshB.resolve(null); await flush();
    assert(tabs.openPaths.includes('renamed/b.md'));
    const count = requests.length;
    events.dispatchEvent(new dom.window.CustomEvent('filechange', { detail: { workspaceId: 'other', type: 'unlinkDir', relativePath: 'renamed' } }));
    await flush(); assert.equal(requests.length, count);
    events.dispatchEvent(new dom.window.CustomEvent('filechange', { detail: { workspaceId: 'workspace', type: 'change', relativePath: 'renamed/b.md' } }));
    await flush(); assert.equal(requests.length, count, 'content changes do not trigger location lookups');

    tabs = rememberNotebookDocumentId(openNotebookDocumentTab(tabs, 'e.md').state, 'e.md', 'e'); watcher.track(); await flush();
    const late = requests.at(-1)!; assert.equal(late.id, 'e');
    generation = 2; generation = 3; // A→B→A workspace names still have different lifetimes.
    late.resolve('foreign/e.md'); await flush();
    assert.equal(tabs.openPaths.includes('foreign/e.md'), false);
    watcher.dispose(); watcher.dispose();
    assert.equal(owners, 0);
    const finalCount = requests.length;
    events.dispatchEvent(new dom.window.Event('connected'));
    dom.window.dispatchEvent(new dom.window.Event('focus'));
    watcher.track(); await flush();
    assert.equal(requests.length, finalCount, 'disposed callbacks cannot start requests');
    console.log('Inactive location watcher bounds requests, preserves missing tabs, rejects retained responses across close/reopen and workspace lifetimes, and releases its connection.');
  } finally {
    watcher.dispose();
    for (const request of requests) if (request.pending) request.resolve(`${request.id}.md`);
    await flush(); globalThis.fetch = originalFetch; dom.window.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
