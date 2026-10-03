import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';
import messages from '../messages/en.json';
import { deleteWorkspacePaths } from '../app/lib/files/client';
import { useTrashUndo } from '../app/components/file-browser/useTrashUndo';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { useWorkspaceOperationReviewStore } from '../app/store/workspace-operation-review-store';
import { useWorkspacePathOperationStore } from '../app/store/workspace-path-operation-store';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { WORKSPACE_ID_HEADER } from '../app/lib/workspaces/constants';
import { createDocumentReviewUiFixture } from './helpers/document-review-ui-fixture';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
  CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
let remove!: ReturnType<typeof useTrashUndo>;
function Harness() {
  const callback = useTrashUndo();
  useEffect(() => { remove = callback; }, [callback]);
  return null;
}

async function main() {
  useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' });
  useFileStore.getState().resetWorkspaceView('ws-a');
  const node = { path: 'docs/target.md', name: 'target.md', type: 'file' as const };
  const tree = [node];
  const selection = new Set([node.path]);
  let appliedDeletes = 0;
  let refreshed = 0;
  let cleared = 0;
  useFileStore.setState({ fileTree: tree, selectedNode: node, multiSelectPaths: selection,
    isMultiSelectMode: true, applyPathsDeleted: () => { appliedDeletes++; },
    refreshDirectory: async () => { refreshed++; }, clearMultiSelect: () => { cleared++; } });
  const required = { reviewId: 'manual-review-12345678', planId: 'manual-plan', workspaceId: 'ws-a', status: 'blocked' as const };
  let status = 409;
  let result: unknown = { deleted: [], failed: [], trashEntries: [], reviewRequired: required };
  globalThis.fetch = (async (input, init) => {
    assert.equal(input, '/api/files/delete');
    assert.equal(init?.method, 'DELETE');
    assert.equal(new Headers(init?.headers).get(WORKSPACE_ID_HEADER), 'ws-a');
    assert.deepEqual(JSON.parse(String(init?.body)), { path: [node.path] });
    return Response.json(result, { status });
  }) as typeof fetch;
  assert.deepEqual((await deleteWorkspacePaths([node.path], 'ws-a')).reviewRequired, required,
    'a blocked review on HTTP 409 is a review result, not an ordinary delete failure');
  const root = createRoot(document.createElement('div'));
  const ReviewAvailability = await createDocumentReviewUiFixture();
  await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><ReviewAvailability enabled><Harness /></ReviewAvailability></NextIntlClientProvider>));
  const toastCount = toast.getHistory().length;
  await act(async () => { await remove(node.path); });
  assert.deepEqual(useWorkspaceOperationReviewStore.getState().request,
    { mode: 'detail', reviewId: required.reviewId, workspaceId: 'ws-a' });
  assert.equal(useFileStore.getState().fileTree, tree, 'opening review must preserve the visible file');
  assert.equal(useFileStore.getState().selectedNode, node);
  assert.equal(useFileStore.getState().multiSelectPaths, selection, 'selection survives until approval');
  assert.equal(appliedDeletes, 0);
  assert.equal(refreshed, 0);
  assert.equal(cleared, 0);
  assert.equal(toast.getHistory().length, toastCount, 'no trash success or undo before approval');
  status = 200;
  result = { deleted: [], failed: [], trashEntries: [], reviewRequired: { ...required, status: 'pending' } };
  await act(async () => { await remove(node.path); });
  assert.equal(appliedDeletes + refreshed + cleared, 0, 'ready reviews also leave files and selection untouched');
  result = { reviewRequired: { ...required, workspaceId: 'different-workspace' } };
  await assert.rejects(deleteWorkspacePaths([node.path], 'ws-a'), /Invalid file action review response/);
  result = { reviewRequired: required, deleted: [node.path] };
  await assert.rejects(deleteWorkspacePaths([node.path], 'ws-a'), /Invalid file action review response/);
  status = 409;
  result = { error: 'Path locked' };
  await assert.rejects(deleteWorkspacePaths([node.path], 'ws-a'), /Path locked/,
    'ordinary conflicts keep the existing error behavior');
  useWorkspaceOperationReviewStore.setState({ request: null });
  let respond!: (response: Response) => void;
  globalThis.fetch = (async () => new Promise<Response>((resolve) => { respond = resolve; })) as typeof fetch;
  await act(async () => {
    const pending = remove(node.path);
    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-b' });
    respond(Response.json({ deleted: [], failed: [], trashEntries: [], reviewRequired: required }, { status: 409 }));
    await pending;
  });
  assert.equal(useWorkspaceOperationReviewStore.getState().request, null,
    'a late review response must not open over the newly selected workspace');
  assert.equal(appliedDeletes + refreshed + cleared, 0);

  await act(async () => { useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a', hydrateWorkspaces: async () => {} }); });
  observeOpenedDocumentAuth({ data: { user: { id: 'user-a' }, session: { id: 'session-a' } } });
  await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><ReviewAvailability enabled><Harness /></ReviewAvailability></NextIntlClientProvider>));
  let pending!: Promise<unknown>;
  await act(async () => { pending = remove(node.path); });
  await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><ReviewAvailability enabled={false}><Harness /></ReviewAvailability></NextIntlClientProvider>));
  await act(async () => {
    respond(Response.json({ deleted: [], failed: [], trashEntries: [], reviewRequired: required }, { status: 409 }));
    await pending;
  });
  assert.equal(useWorkspaceOperationReviewStore.getState().request, null, 'a response after disabling never opens Review Center');
  assert.equal(useWorkspacePathOperationStore.getState().request?.reviewId, required.reviewId,
    'the original pending review opens in the independent status dialog after disabling');

  useWorkspacePathOperationStore.setState({ request: null });
  await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><ReviewAvailability enabled><Harness /></ReviewAvailability></NextIntlClientProvider>));
  await act(async () => { pending = remove(node.path); });
  observeOpenedDocumentAuth({ data: { user: { id: 'user-b' }, session: { id: 'session-b' } } });
  await act(async () => {
    respond(Response.json({ deleted: [], failed: [], trashEntries: [], reviewRequired: required }, { status: 409 }));
    await pending;
  });
  assert.equal(useWorkspaceOperationReviewStore.getState().request, null, 'a late response cannot open a review under another auth identity');
  assert.equal(useWorkspacePathOperationStore.getState().request, null);
  assert.equal(appliedDeletes + refreshed + cleared, 0);
  await act(async () => root.unmount());
  dom.window.close();
  console.log('workspace-operation-manual-delete-ui-test: ok');
}
main().catch((error) => { console.error(error); dom.window.close(); process.exitCode = 1; });
