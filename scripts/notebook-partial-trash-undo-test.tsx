import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';
import messages from '../messages/en.json';
import { useTrashUndo } from '../app/components/file-browser/useTrashUndo';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { WorkspaceDeletePartialError } from '../app/lib/files/client';
import { WORKSPACE_ID_HEADER } from '../app/lib/workspaces/constants';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
let remove!: ReturnType<typeof useTrashUndo>;
function Harness() {
  const callback = useTrashUndo();
  useEffect(() => { remove = callback; }, [callback]);
  return null;
}
async function main() {
  useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' });
  useFileStore.setState({ deletePath: async () => { throw new WorkspaceDeletePartialError({
    deleted: ['docs'], failed: [{ path: 'locked', error: 'locked' }],
    trashEntries: [{ id: 'undo-docs', originalPath: 'docs', itemType: 'directory', sizeBytes: 1, expiresAt: new Date().toISOString() }],
  }); } });
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><Harness /></NextIntlClientProvider>));
  await act(async () => { await assert.rejects(remove(['docs', 'locked']), WorkspaceDeletePartialError); });
  const notification = toast.getHistory().findLast((entry) => 'action' in entry && entry.action && typeof entry.action === 'object' && 'onClick' in entry.action);
  assert.ok(notification && 'action' in notification && notification.action && typeof notification.action === 'object' && 'onClick' in notification.action, 'successful partial deletes still expose undo');
  const action = notification.action;
  let restoredWorkspace: string | null = null;
  let refreshCount = 0;
  await act(async () => useFileStore.setState({ refreshDirectory: async () => { refreshCount++; } }));
  globalThis.fetch = (async (_input, init) => {
    restoredWorkspace = new Headers(init?.headers).get(WORKSPACE_ID_HEADER);
    return Response.json({ restored: { originalPath: 'docs' } });
  }) as typeof fetch;
  await act(async () => {
    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-b' });
    action.onClick({} as React.MouseEvent<HTMLButtonElement>);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(restoredWorkspace, 'ws-a', 'undo stays bound to the original workspace');
  assert.equal(refreshCount, 0, 'undo must not refresh the newly selected workspace');
  await act(async () => root.unmount());
  dom.window.close();
  console.log('notebook-partial-trash-undo-test: ok');
}
main().catch((error) => { console.error(error); dom.window.close(); process.exitCode = 1; });
