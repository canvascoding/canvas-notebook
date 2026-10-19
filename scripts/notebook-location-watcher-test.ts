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
  const requests: { id: string; signal: AbortSignal; resolve: (path: string | null | Response) => void; pending: boolean }[] = [];
  let running = 0, peak = 0, owners = 0, generation = 1;
  const events = Object.assign(new dom.window.EventTarget(), {
    acquire() { owners++; }, releaseConnection() { owners--; },
  });
  let tabs: NotebookDocumentTabsState = { activePath: 'd.md', openPaths: ['a.md', 'b.md', 'c.md', 'd.md'],
    documentIds: { 'a.md': 'a', 'b.md': 'b', 'c.md': 'c', 'd.md': 'd' } };
  const applied: string[] = [];
  globalThis.fetch = async (input, options) => {
    const id = new URL(String(input), 'https://canvas.test').searchParams.get('documentId')!;
    // A physically retained adapter promise is not an active logical request
    // after its AbortSignal ended. Keep the actual two-unaborted-request oracle.
    running = requests.filter(request => request.pending && !request.signal.aborted).length + 1;
    peak = Math.max(peak, running);
    // Deliberately retain responses even after abort to exercise lifetime checks.
    return new Promise(resolve => {
      const request = { id, signal: options!.signal as AbortSignal, pending: true, resolve: (path: string | null | Response) => {
        if (!request.pending) return;
        request.pending = false;
        running = requests.filter(request => request.pending && !request.signal.aborted).length;
        resolve(path instanceof Response ? path : path === null ? new Response('', { status: 404 }) : Response.json({ success: true, workspaceId: 'workspace',
          documentId: id, path, lifecycleGeneration: 1, representation: 'tiptap_blocks' }));
      } };
      requests.push(request);
    });
  };
  const watcher = createNotebookDocumentLocationWatcher({ workspaceId: 'workspace', watcher: events,
    getTabs: () => tabs, isCurrent: () => generation === 1, isActive: path => path === tabs.activePath,
    onLocation: (path, id, location) => { applied.push(`${id}:${location.path}`); tabs = adoptNotebookDocumentLocation(tabs, path, id, location.path); watcher.track(); },
  });
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  const invalidateWorkspace = (detail: unknown) => events.dispatchEvent(new dom.window.CustomEvent('workspace-invalidated', { detail }));
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

    const ignoredTerminalBase = requests.length;
    for (const hint of [null, {}, [], { workspaceId: null }, { workspaceId: 'other' },
      { workspaceId: 'workspace', path: 'a.md' }]) invalidateWorkspace(hint);
    await new Promise(resolve => setTimeout(resolve, 1100)); await flush();
    assert.equal(requests.length, ignoredTerminalBase, 'foreign and malformed terminal hints cannot wake inactive tabs');

    const terminalBase = requests.length;
    invalidateWorkspace({ workspaceId: 'workspace' }); await flush();
    assert.equal(requests.length, terminalBase + 2);
    assert.deepEqual(requests.slice(terminalBase).map(request => request.id).sort(), ['a', 'c']);
    assert.equal(running, 2);
    await flush();
    assert.equal(requests.length, terminalBase + 2, 'the third inactive ID remains queued behind two gated GETs');
    requests[terminalBase].resolve('a.md'); await flush();
    assert.equal(requests.length, terminalBase + 3);
    assert.equal(requests[terminalBase + 2].id, 'b');
    assert.equal(running, 2, 'terminal refreshes use the same two-request bound');
    requests[terminalBase + 1].resolve('c.md');
    requests[terminalBase + 2].resolve('renamed/b.md'); await flush();
    assert.deepEqual(requests.slice(terminalBase).map(request => request.id).sort(), ['a', 'b', 'c']);
    assert.equal(requests.slice(terminalBase).some(request => request.id === 'd'), false, 'the active tab is owned by its editor hook');
    assert.equal(peak, 2, 'terminal hints retain the actual gated concurrency limit');
    assert.equal(running, 0);

    // One hint, a controlled marked read-only 503, then a successful fresh GET.
    // This HTTP adapter does not claim to prove the server's SQL cleanup.
    const retryBase = requests.length;
    invalidateWorkspace({ workspaceId: 'workspace' }); await flush();
    // Respect the existing per-ID one-second request floor.
    await new Promise(resolve => setTimeout(resolve, 1100)); await flush();
    assert.equal(requests.length, retryBase + 2);
    requests[retryBase].resolve(Response.json({ success: false, code: 'FILE_MUTATION_LOCK_BUSY', retryable: true }, { status: 503 }));
    await flush();
    assert.equal(requests.length, retryBase + 3);
    requests[retryBase + 1].resolve('c.md'); requests[retryBase + 2].resolve('renamed/b.md'); await flush();
    await new Promise(resolve => setTimeout(resolve, 1100)); await flush();
    assert.equal(requests.length, retryBase + 4, 'a single terminal hint schedules the marked-busy lookup again');
    assert.equal(requests[retryBase + 3].id, 'a');
    requests[retryBase + 3].resolve('a.md'); await flush();
    const recoveredCount = requests.length;
    await new Promise(resolve => setTimeout(resolve, 1100)); await flush();
    assert.equal(requests.length, recoveredCount, 'successful recovery closes the finite window');
    assert.equal(peak, 2); assert.equal(running, 0);

    const unmarkedBase = requests.length;
    invalidateWorkspace({ workspaceId: 'workspace' }); await flush();
    assert.equal(requests.length, unmarkedBase + 2);
    requests[unmarkedBase].resolve(Response.json({ success: false, code: 'FILE_MUTATION_LOCK_BUSY' }, { status: 503 })); await flush();
    assert.equal(requests.length, unmarkedBase + 3);
    requests[unmarkedBase + 1].resolve('c.md'); requests[unmarkedBase + 2].resolve('renamed/b.md'); await flush();
    await new Promise(resolve => setTimeout(resolve, 1200)); await flush();
    assert.equal(requests.length, unmarkedBase + 3, 'unmarked 503 does not create inactive-tab polling');

    // d was skipped as active since tracking began. Advancing only the fixture
    // clock must not consume its never-started retry window before its first GET.
    const originalNow = Date.now;
    let fixtureClock = originalNow() + 21_000;
    Date.now = () => fixtureClock;
    try {
      const agedActiveBase = requests.length;
      tabs = activateNotebookDocumentTab(tabs, 'a.md'); watcher.track();
      invalidateWorkspace({ workspaceId: 'workspace' }); await flush();
      assert.equal(requests.length, agedActiveBase + 2);
      assert.deepEqual(requests.slice(agedActiveBase).map(request => request.id).sort(), ['c', 'd'],
        'the first single hint after a long active lifetime must read the newly inactive document');
      requests[agedActiveBase].resolve('c.md'); requests[agedActiveBase + 1].resolve('d.md'); await flush();
      assert.equal(requests.length, agedActiveBase + 3);
      requests[agedActiveBase + 2].resolve('renamed/b.md'); await flush();
      assert.equal(peak, 2); assert.equal(running, 0);
      fixtureClock += 1000;

      tabs = activateNotebookDocumentTab(tabs, 'd.md'); watcher.track();
      const authBase = requests.length;
      invalidateWorkspace({ workspaceId: 'workspace' }); await flush();
      assert.equal(requests.length, authBase + 2);
      requests[authBase].resolve(Response.json({ success: false, code: 'FILE_MUTATION_LOCK_BUSY', retryable: true }, { status: 503 })); await flush();
      assert.equal(requests.length, authBase + 3);
      requests[authBase + 1].resolve('c.md'); requests[authBase + 2].resolve('renamed/b.md'); await flush();
      const { invalidateOpenedDocumentAuth } = await import('../app/lib/collaboration/opened-document-registry');
      invalidateOpenedDocumentAuth();
      fixtureClock += 1001; // A surviving timer could now actually pass nextAt.
      await new Promise(resolve => setTimeout(resolve, 1200)); await flush();
      assert.equal(requests.length, authBase + 3, 'auth invalidation cancels pending inactive retries');
    } finally { Date.now = originalNow; tabs = activateNotebookDocumentTab(tabs, 'd.md'); }

    tabs = activateNotebookDocumentTab(rememberNotebookDocumentId(openNotebookDocumentTab(tabs, 'e.md').state, 'e.md', 'e'), 'd.md'); watcher.track(); await flush();
    const late = requests.at(-1)!; assert.equal(late.id, 'e');
    generation = 2; generation = 3; // A→B→A workspace names still have different lifetimes.
    const generationCount = requests.length;
    invalidateWorkspace({ workspaceId: 'workspace' }); await flush();
    assert.equal(requests.length, generationCount, 'terminal hints cannot revive a retired workspace generation');
    late.resolve('foreign/e.md'); await flush();
    assert.equal(tabs.openPaths.includes('foreign/e.md'), false);
    watcher.dispose(); watcher.dispose();
    assert.equal(owners, 0);
    const finalCount = requests.length;
    invalidateWorkspace({ workspaceId: 'workspace' });
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
