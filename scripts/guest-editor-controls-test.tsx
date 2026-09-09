import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { Editor } from '@tiptap/core';
import messages from '../messages/en.json';
import { MarkdownEditorAccessContext, type MarkdownEditorAccess } from '../app/components/editor/MarkdownEditorAccess';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
for (const key of ['window', 'Window', 'document', 'DOMParser', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLAnchorElement', 'SVGElement', 'Node', 'NodeFilter', 'Event',
  'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true, CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/gu, char => '\\' + char) } });
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
// JSDOM has no layout. These tests inspect document state and lifecycle, not geometry.
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as unknown as DOMRectList; };

async function main() {
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  // A browser can retain an account workspace when following a guest link.
  const workspace = { activeWorkspaceId: 'private-account-workspace' };
  const files = { currentFile: null };
  internals._load = (request, parent, isMain) => {
    if (request === './CodeEditorClient') return { CodeEditor: () => null };
    if (request === '@/components/ui/mermaid-diagram') return { MermaidDiagram: () => null };
    if (request === '@/app/components/shared/MarkdownRenderer') return { MarkdownRenderer: () => null };
    if (request === '@/app/components/shared/WorkspaceDocumentPreviewDialog') return { WorkspaceDocumentPreviewDialog: () => null };
    if (request === '@/app/store/workspace-store') return { useWorkspaceStore: Object.assign((selector: (value: typeof workspace) => unknown) => selector(workspace), { getState: () => workspace }) };
    if (request === '@/app/store/file-store') return { useFileStore: Object.assign((selector?: (value: typeof files) => unknown) => selector ? selector(files) : files, { getState: () => files }) };
    return originalLoad(request, parent, isMain);
  };
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => { requests.push(String(input)); return Response.json({ error: 'No workspace access' }, { status: 403 }); }) as typeof fetch;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    const { RichMarkdownEditor } = await import('../app/components/editor/MarkdownEditor');
    const guest: MarkdownEditorAccess = { workspace: false, resolveImage: (source) => source === './shared.png' ? '/api/guest/files/invitation/assets/shared.png' : null };
    const value = '# Title\n\nAlpha\n\nBeta\n\n[[private-note]]\n\n![Shared](./shared.png)\n\n![Private](./private.png)\n';
    const render = async (access: MarkdownEditorAccess, readOnly = false) => {
      await act(async () => { root.render(<StrictMode><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <MarkdownEditorAccessContext.Provider value={access}>
          <RichMarkdownEditor key={String(access.workspace)} value={value} filePath="note.md" readOnly={readOnly}
            isMobileKeyboardActive={false} onSourceMode={() => {}} />
        </MarkdownEditorAccessContext.Provider>
      </NextIntlClientProvider></StrictMode>); });
    };
    const editor = () => (container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor;
    const controls = () => Array.from(container.querySelectorAll('[data-testid="markdown-desktop-toolbar"] button')).map(e => e.getAttribute('aria-label'));
    await render(guest);
    const guestControls = controls();
    assert(guestControls.includes('Text style') && guestControls.includes('Insert') && guestControls.includes('Move block'));
    assert.equal(container.querySelectorAll('[data-testid="markdown-image-node"]').length, 2, 'guests use the same resizable image node views');
    assert(container.textContent?.includes(messages.notebook.editorGuest.imageUnavailable), 'private images display an access message');
    assert.equal(editor().state.doc.textContent.includes('Alpha'), true);
    assert(editor().extensionManager.extensions.some(e => e.name === 'canvasBlockMovement'), 'guest editor installs the common block move commands');
    const before = editor().getJSON();
    const bold = container.querySelector<HTMLButtonElement>('button[aria-label="Bold"]')!;
    await act(async () => { editor().commands.setTextSelection({ from: 8, to: 13 }); bold.click(); });
    assert.equal(editor().isActive('bold'), true, 'real toolbar command changes the selection');
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')!.click(); });
    assert.deepEqual(editor().getJSON(), before, 'toolbar undo restores the document');
    await render(guest, true);
    assert.equal(editor().isEditable, false);
    assert.equal(controls().length, 0, 'read-only guest has no formatting controls');
    assert.deepEqual(requests, [], 'no workspace lookup, private embed, preview or import request occurs in guest scope');
    await render({ workspace: true });
    assert.deepEqual(controls(), guestControls, 'account and guest use identical text editing controls');
    console.log('Guest editor: shared toolbar commands/history, read-only access, image controls and no private workspace requests passed.');
  } finally {
    await act(async () => root.unmount()); container.remove(); internals._load = originalLoad; globalThis.fetch = originalFetch; dom.window.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
