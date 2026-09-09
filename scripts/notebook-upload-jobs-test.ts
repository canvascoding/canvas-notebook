import assert from 'node:assert/strict';
import { beginUploadJob, createUploadProgressReporter, finishUploadJob, updateUploadItem, updateUploadJob, uploadJobPercent, useUploadStore } from '../app/store/upload-store';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { WORKSPACE_ID_HEADER } from '../app/lib/workspaces/constants';

async function main() {
  const files = [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')];
  const first = beginUploadJob(files, 'docs', 'ws-a');
  const second = beginUploadJob(files, 'other', 'ws-b');
  const reporter = createUploadProgressReporter(first, [1]);
  reporter.report({ index: 0, path: 'b.txt', size: 1, uploadedBytes: 1, status: 'uploading', attempt: 1 });
  assert.equal(useUploadStore.getState().jobs[first.id].items[1].uploadedBytes, 0, 'byte progress is batched');
  reporter.report({ index: 0, path: 'b.txt', size: 1, uploadedBytes: 1, status: 'completed', attempt: 1 });
  assert.equal(useUploadStore.getState().jobs[first.id].items[1].status, 'completed', 'completion is immediate');
  updateUploadItem(first, { ...useUploadStore.getState().jobs[first.id].items[0], status: 'skipped' });
  updateUploadJob(first, { phase: 'reconciling' });
  assert.equal(uploadJobPercent(useUploadStore.getState().jobs[first.id]), 99, 'transfer is not final completion');
  finishUploadJob(first);
  assert.equal(uploadJobPercent(useUploadStore.getState().jobs[first.id]), 100);
  reporter.report({ index: 0, path: 'b.txt', size: 1, uploadedBytes: 0, status: 'retrying', attempt: 2 });
  assert.equal(useUploadStore.getState().jobs[first.id].items[1].status, 'completed', 'late callbacks cannot reopen a job');
  assert.equal(useUploadStore.getState().jobs[second.id].phase, 'preparing', 'other jobs retain their status');

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; workspace: string | null }> = [];
  useWorkspaceStore.setState({ activeWorkspaceId: 'ws-b' });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), workspace: new Headers(init?.headers).get(WORKSPACE_ID_HEADER) });
    if (String(input) === '/api/files/uploads') return Response.json({ success: true, upload: { id: 'session',
      files: [{ id: 'file', sourceIndex: 0, uploadedBytes: 0 }] } });
    return Response.json({ success: true });
  }) as typeof fetch;
  try {
    const empty = new File([], 'empty.txt');
    const pinned = beginUploadJob([empty], 'original', 'ws-a');
    await useFileStore.getState().uploadFile(empty, 'original', undefined, undefined, { job: pinned, refreshTree: false });
    assert.ok(calls.length >= 3);
    assert.ok(calls.every((call) => call.workspace === 'ws-a'), 'all requests retain the captured workspace');
    assert.equal(useUploadStore.getState().jobs[pinned.id].items[0].status, 'completed');
    assert.equal(useUploadStore.getState().jobs[second.id].phase, 'preparing');
    finishUploadJob(pinned);
  } finally { globalThis.fetch = originalFetch; }
  console.log('notebook-upload-jobs-test: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
