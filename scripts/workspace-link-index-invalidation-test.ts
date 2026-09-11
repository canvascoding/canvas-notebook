import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { invalidateWorkspaceLinkIndexCache, loadWorkspaceLinkIndex,
  subscribeWorkspaceLinkIndexInvalidation } from '../app/lib/markdown/workspace-link-index-client';

const flush = async () => { for (let step = 0; step < 20; step++) await Promise.resolve(); };
const response = (version: string) => Response.json({ success: true,
  index: { documents: [], edges: [], backlinks: {}, brokenLinks: [], omittedDocuments: [], generatedAt: version } });
async function main() {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ started: number; resolve: (response: Response) => void }> = [];
  let invalidations = 0;
  const unsubscribe = subscribeWorkspaceLinkIndexInvalidation(() => { invalidations++; });
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  globalThis.fetch = (async () => new Promise<Response>((resolve) => requests.push({ started: Date.now(), resolve }))) as typeof fetch;
  try {
    const first = loadWorkspaceLinkIndex('burst');
    const concurrent = loadWorkspaceLinkIndex('burst');
    for (let change = 0; change < 100; change++) invalidateWorkspaceLinkIndexCache('burst');
    let freshCompleted = false;
    const fresh = loadWorkspaceLinkIndex('burst').then((index) => { freshCompleted = true; return index; });
    assert.equal(requests.length, 1, 'invalidating an in-flight request must not open another request');
    mock.timers.tick(250); await flush();
    assert.equal(invalidations, 1, 'a burst notifies subscribers once');
    requests[0].resolve(response('old-snapshot')); await flush();
    assert.equal((await first).generatedAt, 'old-snapshot');
    assert.equal(await first, await concurrent, 'existing readers complete with the same actual snapshot despite ongoing edits');
    assert.equal(freshCompleted, false, 'readers arriving after invalidation must not receive the older in-flight result');
    await flush();
    assert.equal(requests.length, 1, 'a stale completion cannot bypass the request interval');
    for (let change = 0; change < 20; change++) {
      invalidateWorkspaceLinkIndexCache('burst');
      mock.timers.tick(250); await flush();
    }
    mock.timers.tick(4750); await flush();
    assert.equal(requests.length, 2, 'continuous invalidations coalesce into one bounded follow-up');
    invalidateWorkspaceLinkIndexCache('burst');
    requests[1].resolve(response('second-snapshot')); await flush();
    assert.equal((await fresh).generatedAt, 'second-snapshot', 'continuously changing workspaces must not starve awaiting consumers');
    const latest = loadWorkspaceLinkIndex('burst');
    mock.timers.tick(10_000); await flush();
    assert.equal(requests.length, 3, 'a response invalidated in flight is never reused as a fresh cached value');
    requests[2].resolve(response('latest')); await flush();
    assert.equal((await latest).generatedAt, 'latest');
    assert.equal((await loadWorkspaceLinkIndex('burst')).generatedAt, 'latest');
    assert.equal(requests.length, 3);
    assert.ok(requests.slice(1).every((request, index) => request.started - requests[index].started >= 10_000));

    const throttled = loadWorkspaceLinkIndex('rate-limited');
    const rejection = assert.rejects(throttled, /Too many requests/);
    requests[3].resolve(Response.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '60' } }));
    await rejection;
    for (let change = 0; change < 25; change++) invalidateWorkspaceLinkIndexCache('rate-limited');
    const retry = loadWorkspaceLinkIndex('rate-limited');
    mock.timers.tick(59_999); await flush();
    assert.equal(requests.length, 4, 'Retry-After is respected while file changes continue');
    mock.timers.tick(1); await flush();
    assert.equal(requests.length, 5);
    requests[4].resolve(response('recovered')); await flush();
    assert.equal((await retry).generatedAt, 'recovered');
  } finally {
    unsubscribe(); globalThis.fetch = originalFetch;
    mock.timers.runAll(); mock.timers.reset();
  }
  console.log('workspace-link-index-invalidation-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
