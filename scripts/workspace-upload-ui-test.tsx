import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { WorkspaceUploadProgress } from '../app/components/file-browser/WorkspaceUploadProgress';
import { beginUploadJob, beginUploadCollection, finishUploadJob, updateUploadItem, updateUploadJob, useUploadStore } from '../app/store/upload-store';
import { useWorkspaceStore } from '../app/store/workspace-store';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'navigator'] as const) Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

async function main() {
  useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' });
  const files = Array.from({ length: 100 }, (_, index) => new File(['x'], `${index}.txt`));
  const job = beginUploadJob(files, 'docs', 'ws-a');
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <WorkspaceUploadProgress />
  </NextIntlClientProvider>));
  const progress = document.querySelector('[role="progressbar"]');
  assert.ok(progress);
  for (let index = 0; index < files.length; index++) {
    await act(async () => {
      updateUploadJob(job, { phase: 'uploading' });
      updateUploadItem(job, { ...useUploadStore.getState().jobs[job.id].items[index], status: 'completed', uploadedBytes: 1 });
    });
    assert.equal(document.querySelector('[role="progressbar"]'), progress, 'same progress element spans every file');
  }
  await act(async () => updateUploadJob(job, { phase: 'reconciling' }));
  assert.equal(progress.getAttribute('aria-valuenow'), '99');
  assert.match(document.body.textContent || '', /Reconciling files/);
  await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'ws-b' }));
  assert.equal(document.querySelector('[role="progressbar"]'), null, 'a different workspace does not show the old job');
  await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' }));
  assert.ok(document.querySelector('[role="progressbar"]'), 'returning restores the running job');
  await act(async () => finishUploadJob(job));
  assert.equal(document.querySelector('[role="progressbar"]'), null);
  let collecting!: ReturnType<typeof beginUploadJob>;
  await act(async () => { collecting = beginUploadJob([], '.', 'ws-a', undefined, 'collecting'); });
  const collection = beginUploadCollection(collecting);
  await act(async () => updateUploadJob(collecting, { collection: { files: 120, directories: 7, bytes: 120 } }));
  assert.match(document.body.textContent || '', /120 files · 7 folders collected/);
  await act(async () => document.querySelector('button')!.click());
  assert.equal(collection.signal.aborted, true);
  assert.equal(document.querySelector('[role="progressbar"]'), null);
  await act(async () => {
    const failed = beginUploadJob([files[0]], '.', 'ws-a');
    finishUploadJob(failed, new Error('Could not read folder.'));
  });
  assert.match(document.querySelector('[role="alert"]')?.textContent || '', /Could not read folder/);
  await act(async () => root.unmount());
  dom.window.close();
  console.log('workspace-upload-ui-test: ok');
}
main().catch((error) => { console.error(error); dom.window.close(); process.exitCode = 1; });
