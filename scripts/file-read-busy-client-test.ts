import assert from 'node:assert/strict';
import { readWorkspaceFile } from '../app/lib/files/client';
import { getNotebookQueryClient } from '../app/lib/queries/client';
import { LiveDocumentNetworkError, observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { FILE_READ_BUSY_CODE, isFileReadBusyError } from '../app/lib/files/read-busy';
import { useWorkspaceStore } from '../app/store/workspace-store';

const busy = () => Response.json({ success: false, error: 'Temporary native read contention.', code: FILE_READ_BUSY_CODE }, { status: 503 });
const success = () => Response.json({ success: true, data: { path: 'a.md', content: 'fresh native content' } });
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const originalFetch = globalThis.fetch;

async function main() {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  observeOpenedDocumentAuth({ data: { user: { id: 'user' }, session: { id: 'auth' } } });
  useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' });
  const client = getNotebookQueryClient();
  // A cancelled, detached test query must not retain its browser GC timer.
  client.setQueryDefaults(['notebook'], { gcTime: 0 });
  class ForeignBundleError extends Error { name = 'CollaborationRoomOwnerError'; code = FILE_READ_BUSY_CODE; }
  assert.equal(isFileReadBusyError(new ForeignBundleError()), true, 'class identity is intentionally independent of the server bundle');
  for (const error of [{ name: 'CollaborationRoomOwnerError', code: FILE_READ_BUSY_CODE },
    Object.assign(new Error(), { code: FILE_READ_BUSY_CODE }),
    Object.assign(new ForeignBundleError(), { code: 'ROOM_OWNER_LOST' })]) assert.equal(isFileReadBusyError(error), false);

  try {
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      assert.equal(init?.cache, 'no-store'); assert.equal(new Headers(init?.headers).get('x-canvas-workspace-id'), 'workspace');
      return ++calls === 1 ? busy() : success();
    };
    const departed = new AbortController();
    const first = readWorkspaceFile('a.md', { signal: departed.signal });
    const second = readWorkspaceFile('a.md');
    departed.abort();
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal((await second).content, 'fresh native content');
    assert.equal(calls, 2, 'the retained consumer shares one Busy retry transport');
    client.clear();

    calls = 0;
    globalThis.fetch = async () => { calls++; return busy(); };
    const exhausted = await Promise.allSettled([readWorkspaceFile('a.md'), readWorkspaceFile('a.md')]);
    assert.equal(calls, 4, 'two consumers share at most four actual requests');
    for (const result of exhausted) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') {
        assert.ok(result.reason instanceof Response); assert.equal(result.reason.status, 503);
        assert.equal((await result.reason.json()).code, FILE_READ_BUSY_CODE, 'each consumer retains an unread genuine error body');
        assert.equal(result.reason instanceof LiveDocumentNetworkError, false);
      }
    }
    client.clear();

    const terminal = [
      ...[401, 403, 404, 409, 410, 422, 500].map(status => () => Response.json({ success: false, code: FILE_READ_BUSY_CODE }, { status })),
      ...['ROOM_OWNER_LOST', 'ROOM_OWNER_SCOPE_CHANGED', 'ROOM_OWNER_UNAVAILABLE', 'COLLABORATION_CHECKPOINT_QUARANTINED']
        .map(code => () => Response.json({ success: false, code }, { status: 503 })),
      () => Response.json({ code: FILE_READ_BUSY_CODE }, { status: 503 }),
      () => Response.json({ success: true, code: FILE_READ_BUSY_CODE }, { status: 503 }),
      () => new Response('invalid json', { status: 503 }),
    ];
    for (const response of terminal) {
      calls = 0; globalThis.fetch = async () => { calls++; return response(); };
      await assert.rejects(readWorkspaceFile('a.md'), error => error instanceof Response);
      assert.equal(calls, 1, 'only the precise availability contract can retry'); client.clear();
    }

    calls = 0;
    let transportSignal: AbortSignal | null | undefined;
    globalThis.fetch = async (_url, init) => { calls++; transportSignal = init?.signal; return busy(); };
    const cancelled = readWorkspaceFile('a.md').then(() => assert.fail('cancelled query must not succeed'), error => error);
    await delay(20);
    await client.cancelQueries();
    assert.equal(transportSignal?.aborted, true); await cancelled;
    await delay(150); assert.equal(calls, 1, 'query cancellation interrupts the backoff and prevents another request'); client.clear();

    calls = 0;
    const oldPartition = readWorkspaceFile('a.md').then(() => assert.fail('revoked partition cannot succeed'), error => error);
    await delay(20);
    observeOpenedDocumentAuth({ data: { user: { id: 'other-user' }, session: { id: 'other-auth' } } });
    await oldPartition; await delay(150); assert.equal(calls, 1, 'auth invalidation cancels the old partition retry');
    globalThis.fetch = async () => { calls++; return success(); };
    assert.equal((await readWorkspaceFile('a.md')).content, 'fresh native content'); assert.equal(calls, 2);
    client.clear();

    // The two-second budget limits starts; an already-running fetch is not
    // advertised as forcibly timed out. Its final Busy remains readable.
    calls = 0;
    globalThis.fetch = async () => { calls++; if (calls > 1) await delay(2_050); return busy(); };
    const expired = await readWorkspaceFile('a.md').catch((error: unknown) => error);
    assert.ok(expired instanceof Response); assert.equal((await expired.json()).code, FILE_READ_BUSY_CODE);
    assert.equal(calls, 2, 'a Busy returned after the start budget cannot start a third request'); client.clear();
    calls = 0;
    globalThis.fetch = async () => { calls++; if (calls === 1) return busy(); await delay(2_050); return success(); };
    assert.equal((await readWorkspaceFile('a.md')).content, 'fresh native content'); assert.equal(calls, 2);
    console.log('PASS actual shared document queries: typed Busy recovery/exhaustion, terminal errors, consumer/query/auth cancellation, and finite start budget');
  } finally { globalThis.fetch = originalFetch; client.clear(); observeOpenedDocumentAuth(null); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
