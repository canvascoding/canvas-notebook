import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { useFileStore } from '../app/store/file-store';
import { buildWorkspaceLinkIndexFromDocuments } from '../app/lib/markdown/workspace-link-index-core';
import { invalidateWorkspaceLinkIndexCache, loadWorkspaceLinkIndex,
  loadWorkspaceMarkdownEmbed } from '../app/lib/markdown/workspace-link-index-client';
import { openWorkspaceMarkdownTarget } from '../app/lib/markdown/workspace-markdown-navigation-client';

// Client scheduling only: controlled HTTP replies convey no database authority.
const flush = async () => { for (let step = 0; step < 30; step++) await Promise.resolve(); };
const indexResponse = (version: string) => Response.json({ success: true,
  index: { ...buildWorkspaceLinkIndexFromDocuments([{ path: 'Target.md', content: '# Target\n\nPreview body.\n' }]),
    generatedAt: version } });
type Request = { path: string; started: number; settled: boolean; resolve: (value: Response) => void };

async function main() {
  const originalFetch = globalThis.fetch;
  const originalReveal = useFileStore.getState().revealAndLoadFile;
  const requests: Request[] = [];
  const tasks: Array<{ promise: Promise<unknown>; settled: boolean }> = [];
  const track = <T>(promise: Promise<T>) => {
    const task = { promise, settled: false }; tasks.push(task);
    void promise.then(() => { task.settled = true; }, () => { task.settled = true; });
    return promise;
  };
  const respond = (request: Request, response = indexResponse('fixture')) => {
    request.settled = true; request.resolve(response);
  };
  const fileResponse = () => Response.json({ success: true, data: { path: 'Target.md',
    content: '# Target\n\nPreview body.\n', stats: { size: 24, modified: 1, permissions: '100644' } } });
  let opens = 0, groups = 0;
  useFileStore.setState({ revealAndLoadFile: async path => { opens++; return { status: 'opened', path }; } });
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  globalThis.fetch = (async input => new Promise<Response>(resolve => {
    requests.push({ path: new URL(String(input), 'http://localhost').pathname,
      started: Date.now(), settled: false, resolve });
  })) as typeof fetch;
  const warm = async (workspace: string) => {
    const before = requests.length, pending = track(loadWorkspaceLinkIndex(workspace));
    assert.equal(requests.length, before + 1); respond(requests[before]); await pending;
  };
  try {
    await warm('interactive-navigation');
    invalidateWorkspaceLinkIndexCache('interactive-navigation');
    let before = requests.length;
    const background = track(loadWorkspaceLinkIndex('interactive-navigation'));
    await flush(); assert.equal(requests.length, before, 'background refresh retains its local interval');
    const navigation = track(openWorkspaceMarkdownTarget({ workspaceId: 'interactive-navigation',
      sourcePath: 'Source.md', syntax: 'markdown', target: 'Target.md' }));
    await flush();
    assert.equal(requests.length, before + 1,
      'A user opening a link must promote the existing queued refresh without waiting ten seconds.');
    respond(requests[before]);
    assert.equal((await navigation).status, 'opened'); await background;
    assert.equal(opens, 1); assert.equal(requests.length, before + 1); groups++;

    await warm('interactive-preview'); invalidateWorkspaceLinkIndexCache('interactive-preview');
    before = requests.length;
    const embedded = track(loadWorkspaceMarkdownEmbed('interactive-preview', 'Target.md'));
    await flush(); assert.equal(requests.length, before);
    const preview = track(loadWorkspaceMarkdownEmbed('interactive-preview', 'Target.md', null, { priority: 'interactive' }));
    await flush();
    assert.equal(requests.length, before + 1, 'A user preview promotes a cached embed waiting for the shared index.');
    respond(requests[before]); await flush();
    assert.equal(requests.length, before + 2); assert.equal(requests[before + 1].path, '/api/files/read');
    respond(requests[before + 1], fileResponse());
    assert.deepEqual(await preview, await embedded); assert.equal((await preview).content, '# Target\n\nPreview body.\n');
    assert.equal(requests.length, before + 2, 'The shared preview performs one actual document read.'); groups++;

    await warm('interactive-cached'); before = requests.length;
    await loadWorkspaceLinkIndex('interactive-cached', { priority: 'interactive' });
    assert.equal(requests.length, before, 'A valid fresh index remains reusable for explicit navigation.'); groups++;

    before = requests.length;
    const limited = track(loadWorkspaceLinkIndex('interactive-retry-after', { priority: 'interactive' }));
    const denied = assert.rejects(limited, /Too many requests/);
    respond(requests[before], Response.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '60' } }));
    await denied;
    const retryBackground = track(loadWorkspaceLinkIndex('interactive-retry-after'));
    const retryInteractive = track(loadWorkspaceLinkIndex('interactive-retry-after', { priority: 'interactive' }));
    mock.timers.tick(59_999); await flush();
    assert.equal(requests.length, before + 1, 'Interactive demand cannot bypass the server Retry-After.');
    mock.timers.tick(1); await flush(); assert.equal(requests.length, before + 2);
    respond(requests[before + 1]); await Promise.all([retryBackground, retryInteractive]); groups++;

    before = requests.length;
    const old = track(loadWorkspaceLinkIndex('interactive-inflight'));
    invalidateWorkspaceLinkIndexCache('interactive-inflight');
    let freshCompleted = false;
    const fresh = track(loadWorkspaceLinkIndex('interactive-inflight', { priority: 'interactive' }))
      .then(value => { freshCompleted = true; return value; });
    await flush(); assert.equal(requests.length, before + 1, 'Interactive demand never opens a parallel request.');
    respond(requests[before], indexResponse('old')); await flush();
    assert.equal((await old).generatedAt, 'old'); assert.equal(freshCompleted, false);
    assert.equal(requests.length, before + 2, 'The post-invalidation reader gets one immediate fresh successor.');
    respond(requests[before + 1], indexResponse('fresh'));
    assert.equal((await fresh).generatedAt, 'fresh'); groups++;

    before = requests.length;
    const unlabelled = track(loadWorkspaceLinkIndex('interactive-unlabelled-limit', { priority: 'interactive' }));
    const unlabelledDenied = assert.rejects(unlabelled, /Too many requests/);
    respond(requests[before], Response.json({ error: 'Too many requests' }, { status: 429 })); await unlabelledDenied;
    const boundedRetry = track(loadWorkspaceLinkIndex('interactive-unlabelled-limit', { priority: 'interactive' }));
    mock.timers.tick(9_999); await flush(); assert.equal(requests.length, before + 1);
    mock.timers.tick(1); await flush(); assert.equal(requests.length, before + 2);
    respond(requests[before + 1]); await boundedRetry; groups++;
  } finally {
    // Drain real promises under the controlled transport before restoring globals,
    // including the intentionally red comparison against the preceding product.
    for (let step = 0; step < 20 && tasks.some(task => !task.settled); step++) {
      mock.timers.runAll(); await flush();
      for (const request of requests.filter(request => !request.settled)) {
        respond(request, request.path === '/api/files/read' ? fileResponse() : indexResponse('cleanup'));
      }
      await flush();
    }
    assert(tasks.every(task => task.settled), 'All controlled client requests must settle.');
    await Promise.allSettled(tasks.map(task => task.promise));
    mock.timers.runAll(); mock.timers.reset();
    globalThis.fetch = originalFetch; useFileStore.setState({ revealAndLoadFile: originalReveal });
  }
  console.log(JSON.stringify({ suite: 'workspace-link-index-interactive', groups,
    concurrentFetchesPrevented: true, backgroundIntervalPreserved: true, serverBackoffPreserved: true }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
