import assert from 'node:assert/strict';
import { observeOpenedDocumentAuth, invalidateOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { fetchNotebookQuery, getNotebookQueryClient, notebookQueryKey } from '../app/lib/queries/client';
import { resolveNotebookEntry } from '../app/lib/notebook/notebook-entry';

async function main() {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  observeOpenedDocumentAuth({ data: { user: { id: 'u1' }, session: { id: 's1' } } });
  let finish!: (value: string) => void;
  let calls = 0;
  const options = { workspaceId: 'w1', resource: ['test'], queryFn: async () => {
    calls++; return new Promise<string>((resolve) => { finish = resolve; });
  } };
  const controller = new AbortController();
  const first = fetchNotebookQuery({ ...options, signal: controller.signal });
  const second = fetchNotebookQuery(options);
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  finish('one');
  assert.equal(await second, 'one');
  assert.equal(calls, 1, 'panels share a read even if one leaves');
  assert.equal(await fetchNotebookQuery(options), 'one');
  assert.equal(calls, 1, 'fresh scoped data is reused');
  const before = notebookQueryKey('w1', 'test');
  invalidateOpenedDocumentAuth();
  assert.equal(getNotebookQueryClient().getQueryData(before), undefined);
  observeOpenedDocumentAuth({ data: { user: { id: 'u2' }, session: { id: 's2' } } });
  assert.notDeepEqual(notebookQueryKey('w1', 'test'), before);
  assert.equal(getNotebookQueryClient().getQueryCache().getAll().length, 0);
  const input = { intent: { path: null, workspaceId: 'w1', sessionId: 'chat1', shouldOpenChat: true },
    workspaceId: 'w1', workspaceReady: true, hasInitialPrompt: false, restoredPath: 'old.md' };
  assert.deepEqual(resolveNotebookEntry(input), { kind: 'chat' });
  assert.deepEqual(resolveNotebookEntry({ ...input, workspaceId: 'w2' }), { kind: 'waiting' });
  assert.deepEqual(resolveNotebookEntry({ ...input, intent: { ...input.intent, sessionId: null, shouldOpenChat: false, path: 'new.md' } }),
    { kind: 'document', path: 'new.md', revealChat: false });
  assert.deepEqual(resolveNotebookEntry({ ...input, intent: { ...input.intent, path: 'review.md' } }),
    { kind: 'document', path: 'review.md', revealChat: true });
  getNotebookQueryClient().clear();
  console.log('notebook query client and entry tests passed');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
