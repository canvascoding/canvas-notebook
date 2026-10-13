import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { Editor } from '@tiptap/core';
import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/en/notebook' });
for (const key of ['window', 'Window', 'document', 'DOMParser', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLAnchorElement', 'HTMLDetailsElement', 'SVGElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.scrollBy = () => {};
dom.window.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as unknown as DOMRectList; };

async function main() {
  const { fireEvent, screen, cleanup, waitFor } = await import('@testing-library/react');
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const original = internals._load;
  const workspace = { activeWorkspaceId: 'workspace-a' }, files = { currentFile: null };
  const navigations: unknown[] = [], errors: string[] = [], external: Array<{ url: string; target: string; features: string; window: { opener: unknown } }> = [];
  internals._load = (request, parent, isMain) => {
    if (request === './CodeEditorClient') return original('./CodeEditor', parent, isMain);
    if (request === '@/components/ui/mermaid-diagram') return { MermaidDiagram: () => null };
    if (request === '@/app/components/ThemeProvider') return { useTheme: () => ({ resolvedTheme: 'light' }) };
    if (request === '@/app/components/shared/WorkspaceDocumentPreviewDialog') return { WorkspaceDocumentPreviewDialog: () => null };
    if (request === '@/app/store/workspace-store') return { useWorkspaceStore: Object.assign((selector: (value: typeof workspace) => unknown) => selector(workspace), { getState: () => workspace }) };
    if (request === '@/app/store/file-store') return { useFileStore: Object.assign((selector?: (value: typeof files) => unknown) => selector ? selector(files) : files, { getState: () => files }) };
    if (request === '@/app/lib/markdown/workspace-markdown-navigation-client') return {
      openWorkspaceMarkdownTarget: async (input: unknown) => { navigations.push(input); return { status: 'opened', path: 'Shared.md' }; },
    };
    if (request === 'sonner') return { toast: { error: (message: string) => errors.push(message) } };
    return original(request, parent, isMain);
  };
  dom.window.open = ((url: string, target: string, features: string) => {
    const opened = { opener: {} }; external.push({ url, target, features, window: opened }); return opened;
  }) as typeof dom.window.open;
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  let mounted = true;
  try {
    const { MarkdownEditor } = await import('../app/components/editor/MarkdownEditor');
    const { MarkdownEditorAccessContext } = await import('../app/components/editor/MarkdownEditorAccess');
    const { serializeRichMarkdownBody } = await import('../app/lib/markdown/rich-markdown-codec');
    const content = serializeRichMarkdownBody('[Internal](../Shared.md#Section%20A)\n\n[External](https://example.test/docs)\n');
    const mutations: string[] = [];
    const show = async (guest = false, readOnly = false) => act(async () => {
      root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <MarkdownEditorAccessContext.Provider value={guest ? { workspace: false, resolveImage: () => null } : { workspace: true }}>
          <MarkdownEditor value={content} onChange={value => mutations.push(value)} filePath="Notes/Start.md" layout="field" mode="rich" readOnly={readOnly} />
        </MarkdownEditorAccessContext.Provider>
      </NextIntlClientProvider>);
    });
    const editor = () => (container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor;
    const internal = () => container.querySelector<HTMLAnchorElement>('a[href="../Shared.md#Section%20A"]')!;
    await show(); await waitFor(() => assert(internal()));
    const before = editor().getJSON();
    editor().view.posAtCoords = () => ({ pos: 2, inside: 1 });
    editor().view.coordsAtPos = () => ({ left: 10, right: 20, top: 10, bottom: 20 });
    await act(async () => { fireEvent.click(internal()); });
    await waitFor(() => assert(screen.getByRole('dialog', { name: messages.notebook.markdownEditorLinkMenu })));
    assert.equal(navigations.length, 0, 'ordinary writer click stays in the editor');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: messages.notebook.markdownEditorLinkOpen })); });
    assert.deepEqual(navigations.at(-1), { sourcePath: 'Notes/Start.md', syntax: 'markdown', target: '../Shared.md#Section%20A', workspaceId: 'workspace-a' });
    assert.equal(screen.queryByRole('dialog', { name: messages.notebook.markdownEditorLinkMenu }), null);
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) await act(async () => { fireEvent.click(internal(), modifier); });
    assert.equal(navigations.length, 3); assert.equal(external.length, 0, 'workspace href never reaches window.open');
    await act(async () => { fireEvent.click(container.querySelector('a[href="https://example.test/docs"]')!, { ctrlKey: true }); });
    assert.deepEqual(external[0], { url: 'https://example.test/docs', target: '_blank', features: 'noopener,noreferrer', window: { opener: null } });
    assert.deepEqual(editor().getJSON(), before); assert.equal(mutations.length, 0, 'link actions never replace content or create undo history');
    assert.equal(editor().can().undo(), false);
    internal().setAttribute('href', 'javascript:alert(1)');
    await act(async () => { fireEvent.click(container.querySelector('a[href="javascript:alert(1)"]')!, { ctrlKey: true }); });
    assert.equal(navigations.length, 3); assert.equal(external.length, 1); assert(errors.length > 0);
    container.querySelector('a[href="javascript:alert(1)"]')!.setAttribute('href', '../Shared.md#Section%20A');
    await show(true); await waitFor(() => assert(internal()));
    await act(async () => { fireEvent.click(internal(), { metaKey: true }); });
    assert.equal(navigations.length, 3, 'guest cannot navigate private workspace paths');
    await show(false, true); await waitFor(() => assert(internal()));
    assert.equal(editor().isEditable, false);
    await act(async () => { fireEvent.click(internal()); });
    assert.equal(navigations.length, 4, 'permission-derived reader can follow links without an edit control');
    await show(); await waitFor(() => assert(internal()));
    await act(async () => { assert.equal(fireEvent.contextMenu(internal(), { ctrlKey: true, button: 0 }), false); });
    assert.equal(navigations.length, 5, 'macOS Control-left contextmenu uses the guarded Open action');
    assert.deepEqual(navigations.at(-1), { sourcePath: 'Notes/Start.md', syntax: 'markdown', target: '../Shared.md#Section%20A', workspaceId: 'workspace-a' });
    for (const input of [{ button: 2 }, { ctrlKey: true, button: 2 }, { metaKey: true, button: 2 }, { button: 0 }]) {
      await act(async () => { assert.equal(fireEvent.contextMenu(internal(), input), true); });
    }
    await act(async () => { assert.equal(fireEvent.contextMenu(container.querySelector('.ProseMirror')!, { ctrlKey: true, button: 0 }), true); });
    assert.equal(navigations.length, 5, 'right-click, keyboard and non-link context menus do not navigate');
    await act(async () => { fireEvent.contextMenu(container.querySelector('a[href="https://example.test/docs"]')!, { ctrlKey: true, button: 0 }); });
    assert.deepEqual(external[1], external[0]);
    internal().setAttribute('href', 'javascript:alert(1)');
    const priorErrors = errors.length;
    await act(async () => { fireEvent.contextMenu(container.querySelector('a[href="javascript:alert(1)"]')!, { ctrlKey: true, button: 0 }); });
    assert.equal(navigations.length, 5); assert.equal(external.length, 2); assert.equal(errors.length, priorErrors + 1);
    container.querySelector('a[href="javascript:alert(1)"]')!.setAttribute('href', '../Shared.md#Section%20A');
    await show(true); await waitFor(() => assert(internal()));
    const priorGuestErrors = errors.length;
    await act(async () => { fireEvent.contextMenu(internal(), { ctrlKey: true, button: 0 }); });
    assert.equal(navigations.length, 5, 'guest contextmenu cannot navigate private workspace paths');
    assert.equal(errors.length, priorGuestErrors + 1); assert.equal(external.length, 2);
    await show(false, true); await waitFor(() => assert(internal()));
    for (const input of [{ button: 2 }, { ctrlKey: true, button: 2 }, { button: 0 }]) {
      await act(async () => { assert.equal(fireEvent.contextMenu(internal(), input), true); });
    }
    assert.equal(navigations.length, 5, 'reader context menus retain ordinary browser behavior');
    await act(async () => { fireEvent.contextMenu(internal(), { ctrlKey: true, button: 0 }); });
    assert.equal(navigations.length, 6, 'permission-derived reader also handles macOS Control-left');
    assert.deepEqual(editor().getJSON(), before); assert.equal(mutations.length, 0); assert.equal(editor().can().undo(), false);
    const detachedAnchor = internal();
    await act(async () => root.unmount()); mounted = false;
    await act(async () => { assert.equal(fireEvent.contextMenu(detachedAnchor, { ctrlKey: true, button: 0 }), true); });
    assert.equal(navigations.length, 6, 'unmount removes the contextmenu capture listener');
    console.log('Rich editor link UI: ordinary edit menu, modifier/Open and macOS Control-left scoped navigation, preserved context menus, safe external protocols, guest/read-only gates, unchanged state/undo passed. Browser/server authorization remains separate.');
  } finally { if (mounted) await act(async () => root.unmount()); cleanup(); container.remove(); internals._load = original; dom.window.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
