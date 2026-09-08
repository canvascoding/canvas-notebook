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
  const files = { currentFile: null };
  internals._load = (request, parent, isMain) => {
    if (request === '@/app/components/ThemeProvider') return { useTheme: () => ({ resolvedTheme: 'light' }) };
    if (request === '@/app/components/shared/WorkspaceDocumentPreviewDialog') return { WorkspaceDocumentPreviewDialog: () => null };
    if (request === '@/app/lib/collaboration/client') return { useCollaborationDocument: () => null };
    if (request === '@/app/store/workspace-store') return { useWorkspaceStore: Object.assign((selector: (value: typeof workspace) => unknown) => selector(workspace), { getState: () => workspace }) };
    if (request === '@/app/store/file-store') return { useFileStore: Object.assign((selector?: (value: typeof files) => unknown) => selector ? selector(files) : files, { getState: () => files }) };
    return originalLoad(request, parent, isMain);
  };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const documentState = new Y.Doc();
  const text = documentState.getText('content'); text.insert(0, 'AAA');
  const awareness = new Awareness(documentState);
  const collaboration = { registryKey: 'source-lifecycle', doc: documentState, provider: { awareness },
    session: { permission: 'write' }, ready: true, status: 'saved', setComposition: () => {} } as unknown as CollaborationDocument;
  try {
    const { CodeEditor } = await import('../app/components/editor/CodeEditor');
    const changes: string[] = [];
    let mounted = true;
    let readOnly = false;
    const render = () => root.render(<StrictMode><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      {mounted && <CodeEditor value={text.toString()} onChange={(value) => changes.push(value)} path="note.txt"
        readOnly={readOnly} collaborationEnabled collaborationDocument={collaboration} />}
    </NextIntlClientProvider></StrictMode>);
    const view = () => EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
    const shortcut = (shiftKey = false) => view().contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: shiftKey ? 'Z' : 'z', keyCode: 90, code: 'KeyZ', ctrlKey: true, shiftKey, bubbles: true, cancelable: true,
    }));
    await act(async () => { render(); });
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
    console.log('Collaborative source keyboard history retains peer edits, document lifetime and permissions.');
  } finally {
    await act(async () => root.unmount());
    internals._load = originalLoad;
    awareness.destroy(); documentState.destroy(); dom.window.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
