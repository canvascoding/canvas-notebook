import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import messages from '../messages/en.json';
import type { CollaborationDocument } from '../app/lib/collaboration/client';
import { createInitialTextCollaborationClientState } from '../app/lib/collaboration/client-state';
import type { CurrentFile } from '../app/lib/files/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
for (const key of ['window', 'Window', 'document', 'DOMParser', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLAnchorElement', 'SVGElement', 'Node', 'NodeFilter', 'Event',
  'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();

async function main() {
  const { EditorView } = await import('@codemirror/view');
  const { Transaction } = await import('@codemirror/state');
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  const workspace = { activeWorkspaceId: 'test-workspace' };
  const files = { currentFile: { path: 'note.txt', content: 'AAA', editorIdentity: 'source-open',
    collaboration: { path: 'note.txt', strategy: 'crdt_text', crdtCapable: true, sceneCapable: false,
      lockRequired: false, requiresRevisionCheck: false, latestRevision: null, activeLock: null,
      document: { id: 'source-document', provider: 'yjs', stateVersion: 1, snapshotRevisionId: null, status: 'active' } } } as CurrentFile,
  currentFileWorkspaceId: workspace.activeWorkspaceId, treeGeneration: 1, openFileRequestId: 1, fileLoadRequestId: 1 };
  let sessionError: string | null = null;
  let retries = 0;
  let checkpointRetries = 0;
  const blobs: Blob[] = [];
  const originalCreateUrl = URL.createObjectURL;
  const originalRevokeUrl = URL.revokeObjectURL;
  const originalAnchorClick = dom.window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob: Blob | MediaSource) => { assert(blob instanceof Blob); blobs.push(blob); return 'blob:test-recovery'; };
  URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  internals._load = (request, parent, isMain) => {
    if (request === '@/app/components/ThemeProvider') return { useTheme: () => ({ resolvedTheme: 'light' }) };
    if (request === '@/app/components/shared/WorkspaceDocumentPreviewDialog') return { WorkspaceDocumentPreviewDialog: () => null };
    if (request === '@/app/lib/collaboration/client') return { useCollaborationDocument: () => null,
      useTextCollaborationSession: () => ({ session: null, loading: false, error: sessionError, retry: () => { retries++; } }) };
    if (request === '@/app/store/workspace-store') return { useWorkspaceStore: Object.assign((selector: (value: typeof workspace) => unknown) => selector(workspace), { getState: () => workspace }) };
    if (request === '@/app/store/file-store') return { useFileStore: Object.assign((selector?: (value: typeof files) => unknown) => selector ? selector(files) : files, { getState: () => files }) };
    return originalLoad(request, parent, isMain);
  };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const documentState = new Y.Doc();
  const text = documentState.getText('content'); text.insert(0, 'AAA');
  const awareness = new Awareness(documentState);
  const collaboration = { registryKey: 'test-workspace\0source-lifecycle', doc: documentState, provider: { awareness },
    session: { permission: 'write', documentId: 'source-document', lifecycleGeneration: 1, representation: 'plain_text' },
    ready: true, status: 'saved', connection: 'live', durability: 'checkpointed_file',
    clientState: { ...createInitialTextCollaborationClientState(), ready: true, indexedDbHydrated: true,
      remoteSynced: true, connection: 'live', durability: 'checkpointed_file' }, setComposition: () => {},
    requestCheckpoint: async () => { checkpointRetries++; } } as unknown as CollaborationDocument;
  try {
    const { CodeEditor } = await import('../app/components/editor/CodeEditor');
    const changes: string[] = [];
    let mounted = true;
    let readOnly = false;
    let suppliedDocument = true;
    let externallyManagedIssues = false;
    const render = () => root.render(<StrictMode><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      {mounted && <CodeEditor value={text.toString()} onChange={(value) => changes.push(value)} path="note.txt"
        readOnly={readOnly} collaborationEnabled collaborationDocument={suppliedDocument ? collaboration : undefined}
        collaborationIssuesManagedExternally={externallyManagedIssues} />}
    </NextIntlClientProvider></StrictMode>);
    const view = () => EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
    const shortcut = (shiftKey = false) => view().contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: shiftKey ? 'Z' : 'z', keyCode: 90, code: 'KeyZ', ctrlKey: true, shiftKey, bubbles: true, cancelable: true,
    }));
    await act(async () => { render(); });
    const quietView = view();
    for (const status of ['saved', 'persisting', 'live', 'offline', 'reconnecting'] as const) {
      await act(async () => { collaboration.status = status; render(); });
      assert.equal(view(), quietView, 'ordinary collaboration updates retain the live EditorView');
      assert.equal(container.querySelector('[data-testid="markdown-save-state"]'), null,
        'ordinary sync and reconnect states render no save-status panel');
    }
    const privateError = 'Internal projection error must stay in diagnostics';
    await act(async () => {
      collaboration.status = 'saved';
      collaboration.error = privateError;
      collaboration.clientState.projectionError = { code: 'roundtrip_unstable', sequence: 1 };
      render();
    });
    assert.equal(container.querySelector('[data-testid="markdown-save-state"]'), null);
    assert.equal(container.textContent?.includes(privateError), false);
    await act(async () => {
      dom.window.history.replaceState(null, '', '?collaborationDebug=1');
      dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
    });
    assert(container.querySelector('[data-testid="markdown-save-state"] pre')?.textContent?.includes(privateError));
    assert.equal(view(), quietView, 'enabling diagnostic details does not replace the editor');
    await act(async () => {
      dom.window.history.replaceState(null, '', '/');
      dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
      collaboration.status = 'degraded'; collaboration.durability = 'degraded';
      collaboration.clientState.failure = { kind: 'storage', code: 'COLLABORATION_YJS_PERSISTENCE_FAILED' };
      render();
    });
    assert.equal(container.querySelector('[role="alert"]')?.textContent, messages.notebook.editorModes.failure.storage);
    assert.equal(container.textContent?.includes(privateError), false, 'a user sees a clear failure message instead of internals');
    const action = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === label);
    assert(action(messages.notebook.editorModes.recoverCopy), 'standalone source offers the shared recovery action');
    assert(action(messages.notebook.editorModes.retry), 'standalone source offers the shared retry action');
    await act(async () => { action(messages.notebook.editorModes.retry)!.click(); });
    assert.equal(checkpointRetries, 1);
    await act(async () => { action(messages.notebook.editorModes.backup)!.click(); });
    assert.equal(await blobs.at(-1)!.text(), text.toString(), 'text backup uses the live Yjs content');
    await act(async () => { collaboration.ready = false; collaboration.connection = 'offline'; render(); });
    assert(action(messages.notebook.editorModes.snapshot), 'hydrated offline startup retains complete Yjs backup');
    await act(async () => { action(messages.notebook.editorModes.snapshot)!.click(); });
    const recovered = new Y.Doc();
    try {
      Y.applyUpdate(recovered, new Uint8Array(await blobs.at(-1)!.arrayBuffer()));
      assert.equal(recovered.getText('content').toString(), text.toString());
    } finally { recovered.destroy(); }
    await act(async () => { collaboration.ready = true; collaboration.connection = 'live'; render(); });
    await act(async () => { externallyManagedIssues = true; render(); });
    assert.equal(container.querySelector('[data-testid="markdown-save-state"]'), null,
      'Markdown source delegates its failure panel to the surrounding document view');
    assert.equal(container.querySelector('[role="alert"]'), null);
    await act(async () => {
      externallyManagedIssues = false; collaboration.status = 'saved'; collaboration.durability = 'checkpointed_file';
      collaboration.clientState.failure = null; collaboration.clientState.projectionError = null; collaboration.error = null;
      render();
    });
    await act(async () => {
      view().dispatch({ selection: { anchor: 3 } });
      view().dispatch({ ...view().state.replaceSelection('x'), annotations: Transaction.userEvent.of('input.type') });
      documentState.transact(() => text.insert(0, 'Peer '), 'peer');
      shortcut();
    });
    assert.equal(text.toString(), 'Peer AAA', 'keyboard undo removes only local input and preserves a remote insertion');
    await act(async () => { shortcut(true); });
    assert.equal(text.toString(), 'Peer AAAx');
    const originalView = view();
    await act(async () => { mounted = false; render(); });
    await act(async () => { mounted = true; render(); });
    assert.notEqual(view(), originalView);
    await act(async () => { shortcut(); });
    assert.equal(text.toString(), 'Peer AAA', 'the same document retains undo after replacing its source view');
    assert.equal(view().state.selection.main.anchor, 'Peer AAA'.length, 'relative history selection survives a new view and remote insertion');
    await act(async () => { readOnly = true; render(); });
    await act(async () => { shortcut(true); });
    assert.equal(text.toString(), 'Peer AAA', 'readonly views cannot redo shared history');
    await act(async () => { readOnly = false; render(); });
    await act(async () => { shortcut(true); });
    assert.equal(text.toString(), 'Peer AAAx');
    suppliedDocument = false;
    sessionError = 'The renamed file session could not be loaded.';
    await act(async () => { render(); });
    assert.equal(container.querySelector('[role="alert"]')?.textContent, messages.notebook.editorModes.failure.startup);
    assert.equal(container.textContent?.includes(sessionError), false);
    await act(async () => { container.querySelector<HTMLButtonElement>('button')!.click(); });
    assert.equal(retries, 1, 'an unresolved text session offers a working retry');
    await act(async () => { externallyManagedIssues = true; render(); });
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.equal(container.querySelector('button'), null, 'the enclosing Markdown panel owns its recovery actions');
    console.log('Collaborative source keyboard history retains peer edits, document lifetime and permissions.');
  } finally {
    await act(async () => root.unmount());
    internals._load = originalLoad;
    URL.createObjectURL = originalCreateUrl;
    URL.revokeObjectURL = originalRevokeUrl;
    dom.window.HTMLAnchorElement.prototype.click = originalAnchorClick;
    awareness.destroy(); documentState.destroy(); dom.window.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
