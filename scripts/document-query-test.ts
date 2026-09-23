import assert from 'node:assert/strict';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
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
  getNotebookQueryClient().clear();
  console.log('document-query-test: ok');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
