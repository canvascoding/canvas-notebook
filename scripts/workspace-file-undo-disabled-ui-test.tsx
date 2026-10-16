import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { toast, Toaster } from 'sonner';
import messages from '../messages/en.json';
import { useTrashUndo } from '../app/components/file-browser/useTrashUndo';
import { MOBILE_FILE_ACTION_TOASTER_ID } from '../app/components/file-browser/FileActionToastScope';
import { WorkspaceDeletePartialError, type DeleteWorkspacePathsResult } from '../app/lib/files/client';
import { WORKSPACE_FILE_UNDO_ENABLED } from '../app/lib/files/workspace-file-undo-policy';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';

const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, name, { value, configurable: true });
Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: () => ({ matches: false,
  addEventListener() {}, removeEventListener() {} }) });

let remove!: ReturnType<typeof useTrashUndo>;
function Harness({ mobile }: { mobile: boolean }) {
  const callback = useTrashUndo(mobile ? { toasterId: MOBILE_FILE_ACTION_TOASTER_ID } : {});
  useEffect(() => { remove = callback; }, [callback]);
  return mobile ? <div data-slot="sheet-content" data-state="open">
    <div data-file-action-toast-scope={MOBILE_FILE_ACTION_TOASTER_ID}><Toaster id={MOBILE_FILE_ACTION_TOASTER_ID} /></div>
  </div> : <Toaster />;
}

/** Actual hook, stores, translations and Sonner rendering. Only deletion and
 * network effects are controlled; this does not claim browser/API acceptance. */
async function main(): Promise<void> {
  assert.equal(WORKSPACE_FILE_UNDO_ENABLED, false, 'the genuine shared release policy is disabled');
  const root = createRoot(document.querySelector('main')!);
  const originalFetch = globalThis.fetch, originalFiles = useFileStore.getState(), originalWorkspace = useWorkspaceStore.getState();
  const calls: Array<{ paths: string | string[]; workspaceId: string | null | undefined }> = [];
  let result: DeleteWorkspacePathsResult = {}, failure: unknown, hasFailure = false, refreshes = 0, networkCalls = 0, cases = 0;
  globalThis.fetch = (async () => { networkCalls++; throw new Error('A disabled file Undo must never dispatch restore/recovery requests.'); }) as typeof fetch;
  useWorkspaceStore.setState({ activeWorkspaceId: 'undo-disabled-workspace' });
  useFileStore.setState({ deletePath: async (paths, workspaceId) => {
    calls.push({ paths, workspaceId }); if (hasFailure) throw failure; return result;
  }, refreshDirectory: async () => { refreshes++; } });
  const trash = (filePath: string, itemType: 'file' | 'directory' = 'file') => ({ id: 'owned-trash-entry', originalPath: filePath,
    itemType, sizeBytes: 4, expiresAt: '2030-01-01T00:00:00.000Z' });
  const assertToast = async (before: number, mobile: boolean) => {
    const notifications = toast.getHistory().slice(before); assert.equal(notifications.length, 1);
    const notification = notifications[0];
    assert('title' in notification, 'the genuine Sonner entry must be a success toast, not a dismiss signal');
    assert.equal(notification.title, '1 item was moved to trash.');
    assert.equal(notification.duration, 8000);
    assert.equal(notification.action, undefined, 'the success notification must not construct any Undo action');
    assert.equal(notification.toasterId, mobile ? MOBILE_FILE_ACTION_TOASTER_ID : undefined);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    assert.match(document.querySelector('main')!.textContent!, /1 item was moved to trash\./u);
    assert.equal(document.querySelector('main')!.querySelectorAll('[data-button] button,button[data-button]').length, 0);
    assert.equal(Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Undo'), false);
    await act(async () => { toast.dismiss(notification.id); });
  };
  try {
    for (const mobile of [false, true]) {
      await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><Harness mobile={mobile} /></NextIntlClientProvider>));
      // Legacy physical file deletion previously exposed direct Trash restore.
      result = { deleted: ['photo.png'], trashEntries: [trash('photo.png')] };
      let before = toast.getHistory().length;
      await act(async () => { assert.equal(await remove('photo.png'), result); });
      await assertToast(before, mobile); cases++;
      // A completed native batch previously exposed batch Undo instead.
      result = { deleted: ['note.md'], trashEntries: [trash('note.md')], operation: { batchId: 'owned-batch', planId: 'a'.repeat(64),
        workspaceId: 'undo-disabled-workspace', kind: 'delete', status: 'applied', errorCode: null,
        phase: 'complete', completedActions: 1, totalActions: 1, selections: [{ sourcePath: 'note.md' }] } };
      before = toast.getHistory().length;
      await act(async () => { assert.equal(await remove('note.md'), result); });
      await assertToast(before, mobile); cases++;
      // Partial success keeps its success toast and the identical partial error.
      const partial = new WorkspaceDeletePartialError({ deleted: ['docs'], failed: [{ path: 'locked', error: 'locked' }],
        trashEntries: [trash('docs', 'directory')] });
      hasFailure = true; failure = partial; before = toast.getHistory().length;
      await act(async () => { await assert.rejects(remove(['docs', 'locked']), error => error === partial); });
      await assertToast(before, mobile); cases++;
      hasFailure = false;
      result = { deleted: [], trashEntries: [] }; before = toast.getHistory().length;
      await act(async () => { assert.equal(await remove('already-missing.bin'), result); });
      assert.equal(toast.getHistory().length, before, 'a no-trash result still has no success or Undo toast'); cases++;
      const expected = new Error('ordinary deletion failure'); hasFailure = true; failure = expected;
      await act(async () => { await assert.rejects(remove('locked'), error => error === expected); });
      assert.equal(toast.getHistory().length, before, 'failed deletion still publishes no success'); cases++;
      hasFailure = false;
    }
    assert.equal(cases, 10); assert.equal(calls.length, 10);
    assert(calls.every(call => call.workspaceId === 'undo-disabled-workspace'), 'deletion retains the selected workspace');
    assert.deepEqual(calls.map(call => call.paths), ['photo.png', 'note.md', ['docs', 'locked'], 'already-missing.bin', 'locked',
      'photo.png', 'note.md', ['docs', 'locked'], 'already-missing.bin', 'locked']);
    assert.equal(networkCalls, 0); assert.equal(refreshes, 0, 'no restore-only refresh runs while file Undo is disabled');
    console.log('workspace-file-undo-disabled-ui-test: 10 Desktop/Mobile hook cases passed');
  } finally {
    await act(async () => { toast.dismiss(); root.unmount(); });
    globalThis.fetch = originalFetch; useFileStore.setState(originalFiles); useWorkspaceStore.setState(originalWorkspace); dom.window.close();
  }
}
main().catch(error => { console.error(error); dom.window.close(); process.exitCode = 1; });
