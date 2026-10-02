import assert from 'node:assert/strict';
import { onlineManager } from '@tanstack/react-query';
import { LiveDocumentNetworkError, observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { getNotebookQueryClient } from '../app/lib/queries/client';
import { readWorkspaceFile, loadWorkspaceTree } from '../app/lib/files/client';
import { useWorkspaceStore } from '../app/store/workspace-store';

async function main() {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  observeOpenedDocumentAuth({ data: { user: { id: 'user' }, session: { id: 'auth' } } });
  useWorkspaceStore.setState({ activeWorkspaceId: 'w1' });
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  const calls: { url: string; headers: Headers; signal?: AbortSignal | null }[] = [];
  let failure = false;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), signal: init?.signal });
    await gate;
    return failure ? Response.json({ error: 'denied' }, { status: 403 }) : Response.json({ data:
      String(url).includes('/tree?') ? [] : { path: 'a.md', content: `revision-${calls.length}` } });
  };
  const controller = new AbortController();
  const first = readWorkspaceFile('a.md', { signal: controller.signal });
  const second = readWorkspaceFile('a.md');
  assert.equal(calls.length, 1, 'parallel opens share transport');
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(calls[0].signal?.aborted, false, 'one departing consumer cannot abort another');
  release();
  await second;
  await readWorkspaceFile('a.md');
  assert.equal(calls.length, 2, 'later opens revalidate authoritative content');
  gate = Promise.resolve();
  await Promise.all([readWorkspaceFile('a.md', { workspaceId: 'w2' }), readWorkspaceFile('a.md', { metaOnly: true })]);
  assert.equal(calls.length, 4, 'metadata and workspace are separate identities');
  await Promise.all([loadWorkspaceTree('.', 0), loadWorkspaceTree('.', 0)]);
  assert.equal(calls.length, 5);
  await Promise.all([loadWorkspaceTree('.', 1), loadWorkspaceTree('.', 0, true), loadWorkspaceTree('.', 0, false, '', 'w1', { includeStats: false })]);
  assert.equal(calls.length, 8, 'depth, refresh and stats are part of the tree identity');
  failure = true;
  const errors = await Promise.allSettled([readWorkspaceFile('error.md'), readWorkspaceFile('error.md')]);
  assert.equal(calls.length, 9);
  for (const result of errors) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') {
      assert.ok(result.reason instanceof Response);
      assert.equal(result.reason.status, 403);
      assert.deepEqual(await result.reason.json(), { error: 'denied' }, 'each consumer owns a readable error body');
    }
  }
  failure = false;
  gate = new Promise<void>(resolve => { release = resolve; });
  const beforeBootstrap = calls.length;
  const ordinaryRead = readWorkspaceFile('quarantined.md');
  const bootstrapRead = readWorkspaceFile('quarantined.md', { collaborationBootstrap: true });
  const sameBootstrapRead = readWorkspaceFile('quarantined.md', { collaborationBootstrap: true });
  assert.equal(calls.length, beforeBootstrap + 2, 'bootstrap and content reads cannot share cached responses');
  assert.equal(calls[beforeBootstrap].url.includes('collaborationBootstrap'), false);
  assert.equal(calls[beforeBootstrap + 1].url.includes('collaborationBootstrap=1'), true);
  release();
  await Promise.all([ordinaryRead, bootstrapRead, sameBootstrapRead]);

  const client = getNotebookQueryClient();
  const previousOnline = onlineManager.isOnline();
  const previousFetch = globalThis.fetch;
  const previousQueryDefaults = client.getQueryDefaults(['notebook']);
  client.setQueryDefaults(['notebook'], { gcTime: 0 });
  client.mount();
  try {
    onlineManager.setOnline(false);
    let offlineCalls = 0;
    globalThis.fetch = async () => { offlineCalls += 1; throw new TypeError('Offline transport'); };
    const offline = readWorkspaceFile('offline-bootstrap.md', { collaborationBootstrap: true })
      .then(() => null, (error: unknown) => error);
    const sameOffline = readWorkspaceFile('offline-bootstrap.md', { collaborationBootstrap: true })
      .then(() => null, (error: unknown) => error);
    await Promise.resolve();
    assert.equal(offlineCalls, 1, 'an offline live bootstrap must attempt the shared transport so native receipt fallback can run');
    for (const error of await Promise.all([offline, sameOffline])) assert.ok(error instanceof LiveDocumentNetworkError);

    const ordinary = readWorkspaceFile('ordinary-online-only.md').then(() => null, (error: unknown) => error);
    const metadata = readWorkspaceFile('metadata-bootstrap-online-only.md', { metaOnly: true, collaborationBootstrap: true })
      .then(() => null, (error: unknown) => error);
    await Promise.resolve();
    assert.equal(offlineCalls, 1, 'ordinary queries retain the existing online policy');
    assert.equal(client.getQueryCache().getAll().find(query => query.queryKey.includes('ordinary-online-only.md'))
      ?.state.fetchStatus, 'paused');
    assert.equal(client.getQueryCache().getAll().find(query => query.queryKey.includes('metadata-bootstrap-online-only.md'))
      ?.state.fetchStatus, 'paused', 'metadata reads cannot opt into full collaboration bootstrap transport');
    onlineManager.setOnline(true);
    for (const error of await Promise.all([ordinary, metadata])) assert.ok(error instanceof LiveDocumentNetworkError);
    assert.equal(offlineCalls, 3);

    client.setQueryDefaults(['notebook'], { gcTime: 0, networkMode: 'always' });
    onlineManager.setOnline(false);
    const configured = await readWorkspaceFile('ordinary-configured-offline.md').then(() => null, (error: unknown) => error);
    assert.ok(configured instanceof LiveDocumentNetworkError);
    assert.equal(offlineCalls, 4, 'an omitted override must preserve the existing query default transport policy');
  } finally {
    onlineManager.setOnline(previousOnline);
    globalThis.fetch = previousFetch;
    client.setQueryDefaults(['notebook'], previousQueryDefaults);
    client.clear();
    client.unmount();
  }
  getNotebookQueryClient().clear();
  console.log('document-query-test: ok');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
