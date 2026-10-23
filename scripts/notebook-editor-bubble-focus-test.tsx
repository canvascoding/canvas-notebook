import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { act, StrictMode, useEffect, useState } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import { writeNotebookDocumentTabs } from '../app/lib/notebook/document-tabs';
import { getNotebookQueryClient } from '../app/lib/queries/client';
import type { CurrentFile } from '../app/lib/files/types';
import messages from '../messages/en.json';

// Actual DashboardShell/controller + local MarkdownEditor/Tiptap/BubbleMenu.
// JSDOM supplies platform geometry only; no UI/menu/keyboard handlers are mocked.
// This proves local focus, native selection/history and DOM identity, not sockets,
// physical mobile geometry or the final owned-browser acceptance gate.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://canvas.test/en/notebook?path=note.md&workspaceId=workspace', pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'Node', 'MutationObserver',
  'CustomEvent', 'Event', 'FocusEvent', 'KeyboardEvent', 'Window', 'Document', 'DOMParser', 'NodeFilter', 'HTMLAnchorElement', 'HTMLButtonElement', 'HTMLTextAreaElement', 'SVGElement', 'HTMLInputElement', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true, CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/gu, char => `\\${char.codePointAt(0)!.toString(16)} `) } });
dom.window.scrollBy = () => {};
Object.defineProperty(dom.window, 'innerWidth', { value: 1440, configurable: true });
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.scrollBy = () => {};

let RealMarkdownEditor: typeof import('../app/components/editor/MarkdownEditor').MarkdownEditor;
let markdown = '# Width check\n\nFirst paragraph\n\n| One | Two | Three | Four | Five | Six | Seven | Last column |\n| :--- | :---: | ---: | --- | --- | --- | --- | --- |\n| A | B | C | D | E | F | G | Last value |';
function EditorStandIn() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [value, setValue] = useState(markdown);
  return <div><header ref={setTarget} data-testid="document-header" />
    <RealMarkdownEditor value={value} mode="rich" layout="document" controlsTarget={target} onChange={setValue} />
  </div>;
}
function ChatStandIn() { return null; }
function EmailStandIn() { return null; }
function BrowserStandIn() { return null; }
function TerminalStandIn() { return null; }

async function main() {
  const { createRoot } = await import('react-dom/client');
  const { useFileStore } = await import('../app/store/file-store');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const { useEditorStore } = await import('../app/store/editor-store');
  const watcher = new class extends dom.window.EventTarget {
    isConnected = true;
    acquire() {}
    releaseConnection() {}
  }();
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load, originalFetch = globalThis.fetch;
  const noop = () => {};
  const context = { emailContext: { status: 'complete', toolName: 'email_read_message', subject: 'Context' },
    browserContext: { agentId: 'agent', sessionId: 'session', status: 'complete', snapshot: { controlMode: 'agent', tabCount: 1, activeTitle: 'Browser context' } },
    clearEmail: noop, clearBrowser: noop, openBrowser: noop };
  function useContextFixture({ onOpen }: { onOpen: (surface: 'email' | 'browser') => void }) {
    useEffect(() => { onOpen('email'); onOpen('browser'); }, [onOpen]);
    return context;
  }
  const emptyComponents: Record<string, string[]> = {
    '@/app/components/navigation/AppBackButton': ['AppBackButton'], '@/app/components/AppLauncher': ['AppLauncher'],
    '@/app/components/file-browser/FileBrowser': ['FileBrowser'], '@/app/components/notifications/NotificationBell': ['NotificationBell'],
  };
  internals._load = (request, parent, isMain) => {
    if (request === 'next/navigation') return { useSearchParams: () => new URLSearchParams(window.location.search) };
    if (request === '@/app/lib/file-watcher/client') return { getFileWatcherClient: () => watcher };
    if (request === '@/app/components/editor/FileEditor') return { FileEditor: EditorStandIn };
    if (request === '@/app/components/canvas-agent-chat/CanvasAgentChat') return { __esModule: true, default: ChatStandIn };
    if (request === '@/app/apps/email/components/EmailClient') return { EmailClient: EmailStandIn };
    if (request === '@/app/components/browser-lab/BrowserLabClient') return { BrowserLabClient: BrowserStandIn };
    if (request === '@/app/components/terminal/Terminal') return { TerminalPanel: TerminalStandIn };
    if (request === '@/app/components/onboarding/HintProvider') return { HintProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> };
    if (request === '@/app/components/terminal/TerminalAvailabilityProvider') return { useTerminalAvailability: () => ({ ready: true, terminalEnabled: true }) };
    if (request === '@/app/components/workspaces/WorkspaceSwitcher') return { WorkspaceSwitcher: () => null, useShouldShowWorkspaceSwitcher: () => false };
    if (request === '@/app/apps/email/context/email-chat-context') return { useEmailChatContext: () => ({ chatContext: null }) };
    if (request === '@/app/components/notebook/useNotebookToolContext') return { useNotebookToolContext: useContextFixture };
    if (request === '@/app/components/canvas-agent-chat/useForcedChatSession') return { useForcedChatSession: () => ({ forceSession: noop, forcedSessionId: null, requestId: 0 }) };
    if (request === '@/components/ui/mermaid-diagram') return { MermaidDiagram: () => null };
    if (request === '@/app/components/ThemeProvider') return { useTheme: () => ({ resolvedTheme: 'light' }) };
    if (request === '@/app/components/shared/WorkspaceDocumentPreviewDialog') return { WorkspaceDocumentPreviewDialog: () => null };
    if (request === 'sonner') return { toast: { error: noop, success: noop } };
    if (emptyComponents[request]) return { __esModule: true, ...Object.fromEntries(emptyComponents[request].map(name => [name, () => null])) };
    return originalLoad(request, parent, isMain);
  };
  RealMarkdownEditor = (await import('../app/components/editor/MarkdownEditor')).MarkdownEditor;
  markdown = (await import('../app/lib/markdown/rich-markdown-codec')).serializeRichMarkdownBody(markdown);
  const file: CurrentFile = { path: 'note.md', content: 'Persisted native content', collaboration: {
    path: 'note.md', strategy: 'crdt_text', crdtCapable: true, sceneCapable: false, lockRequired: false,
    requiresRevisionCheck: false, latestRevision: null, activeLock: null,
    document: { id: 'document', provider: 'yjs', stateVersion: 1, snapshotRevisionId: null, status: 'active' },
  } };
  globalThis.fetch = async input => {
    const url = new URL(String(input), 'https://canvas.test');
    if (url.pathname === '/api/files/read') return Response.json({ success: true, data: file });
    if (url.pathname === '/api/files/collaboration/location') return Response.json({ success: true, workspaceId: 'workspace', documentId: 'document', path: 'note.md', lifecycleGeneration: 1, representation: 'tiptap_blocks' });
    return Response.json({ success: true, data: [] });
  };
  dom.window.Range.prototype.getClientRects = () => [new dom.window.DOMRect(0, 0, 30, 20)] as unknown as DOMRectList;
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 30, 20);
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(0, 0, 120, 30); };
  dom.window.HTMLElement.prototype.getClientRects = function () { return this.isConnected && getComputedStyle(this).visibility !== 'hidden' ? [this.getBoundingClientRect()] as unknown as DOMRectList : [] as unknown as DOMRectList; };
  const root = createRoot(document.getElementById('root')!);
  const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  const resize = async (width: number) => {
    await act(async () => {
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
      window.dispatchEvent(new Event('resize'));
    });
    await settle();
  };
  try {
    window.localStorage.setItem('canvas.notebookLayout.v2', JSON.stringify({ version: 2, explorerOpen: true, explorerWidth: 240, chatDocked: true, chatWidth: 360, terminalOpen: true }));
    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace', initialized: true });
    useFileStore.getState().resetWorkspaceView('workspace');
    writeNotebookDocumentTabs(window.localStorage, 'workspace', { activePath: 'note.md', openPaths: ['note.md'], documentIds: { 'note.md': 'document' } });
    const { DashboardShell } = await import('../app/components/DashboardShell');
    await act(async () => root.render(<StrictMode><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><DashboardShell hintEnabled={false} /></NextIntlClientProvider></StrictMode>));
    await settle(); await settle();
    const richNode = document.querySelector('.ProseMirror') as HTMLElement & { editor: import('@tiptap/core').Editor };
    assert(richNode?.editor, 'actual local Tiptap editor mounted');
    const editor = richNode.editor;
    let cellPos = -1, editPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell' && cellPos < 0) cellPos = pos + 2;
      if (node.type.name === 'paragraph' && node.textContent === 'First paragraph') editPos = pos + 1 + node.content.size;
    });
    assert(cellPos >= 0 && editPos >= 0);
    assert.equal(editor.can().undo(), false, 'local initialization does not create history');
    await act(async () => { editor.view.dispatch(editor.state.tr.insertText(' edited', editPos)); editor.commands.setTextSelection(cellPos + 7); editor.view.focus(); });
    const key = async (target: Element, name: string, keyCode: number, altKey = false) => {
      const event = new dom.window.KeyboardEvent('keydown', { key: name, keyCode, bubbles: true, cancelable: true, altKey });
      await act(async () => target.dispatchEvent(event)); await settle(); return event;
    };
    for (let i = 0; i < 7; i++) await key(richNode, 'Tab', 9);
    const menuSettle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    await menuSettle();
    assert.equal(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to), 'Last value', 'seven actual Tab key events select the final cell');
    assert.equal(editor.state.selection.empty, false);
    const selection = editor.state.selection.toJSON(), documentJson = editor.getJSON();
    assert.equal(editor.can().undo(), true);
    const button = (label: string) => { const found = document.querySelector<HTMLButtonElement>(`[data-testid="document-header"] button[aria-label="${label}"]`); assert(found, label); return found; };
    const focusClick = async (label: string) => { await act(async () => { const node = button(label); node.focus(); node.click(); }); await settle(); };
    const focusValue = () => document.querySelector('[data-document-focus]')?.getAttribute('data-document-focus');
    const selectionMenu = () => document.querySelector<HTMLElement>('[data-testid="markdown-selection-menu"]');
    const tableMenu = () => document.querySelector<HTMLElement>('[data-testid="markdown-table-menu"]');
    const assertSelection = () => {
      assert.ok(document.querySelector('.ProseMirror') === richNode, 'same actual editor DOM');
      assert.deepEqual(editor.state.selection.toJSON(), selection, 'focus transitions preserve native selection');
      assert.deepEqual(editor.getJSON(), documentJson, 'focus metadata does not mutate the native document');
      assert.equal(editor.can().undo(), true, 'native local undo remains available');
    };
    assert(selectionMenu()?.isConnected, 'actual selection bubble initially visible');
    await resize(390);
    await focusClick('Focus document');
    assert.equal(editor.isFocused, false);
    assert.equal(selectionMenu()?.isConnected ?? false, false, 'outside header focus hides the body-mounted selection menu');
    await focusClick('Exit focus'); await focusClick('Focus document');
    const headerEscape = await key(document.activeElement!, 'Escape', 27);
    assert.equal(headerEscape.defaultPrevented, false);
    assert.equal(focusValue(), 'false', 'second mobile focus entry exits on actual header Escape');
    assertSelection();

    await focusClick('Focus document');
    await act(async () => editor.view.focus()); await menuSettle();
    assert(selectionMenu()?.isConnected);
    const popupEscape = await key(richNode, 'Escape', 27);
    assert.equal(popupEscape.defaultPrevented, true);
    assert.equal(selectionMenu()?.isConnected ?? false, false, 'first editor Escape dismisses the owned selection bubble');
    assert.equal(focusValue(), 'true', 'owned popup Escape never also exits document focus');
    await key(richNode, 'Escape', 27);
    assert.equal(focusValue(), 'false', 'next caret Escape exits focus after popup dismissal');
    assertSelection();

    await focusClick('Focus document'); await act(async () => editor.view.focus());
    await key(richNode, 'F10', 121, true); await menuSettle();
    assert(selectionMenu()?.isConnected);
    assert(selectionMenu()!.contains(document.activeElement), 'actual Alt+F10 focuses the menu button');
    assert.equal(editor.isFocused, false);
    assert.equal(focusValue(), 'true');
    await act(async () => button('Exit focus').focus()); await settle();
    assert.equal(selectionMenu()?.isConnected ?? false, false, 'leaving keyboard menu focus for header hides it');
    assertSelection();
    await key(document.activeElement!, 'Escape', 27); assert.equal(focusValue(), 'false');

    await focusClick('Focus document');
    await act(async () => { editor.commands.setTextSelection(editor.state.selection.from); editor.view.focus(); }); await menuSettle();
    const table = tableMenu(); assert(table?.isConnected, 'actual table bubble for collapsed cell caret');
    const tableSelection = editor.state.selection.toJSON();
    const row = table.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]'); assert(row);
    await act(async () => row.focus()); await key(row, 'Enter', 13); await settle();
    const popup = document.querySelector<HTMLElement>('[role="menu"]'); assert(popup?.isConnected, 'real Radix row dropdown opens');
    assert.equal(table.contains(popup), false, 'dropdown is portaled outside its owning table bubble');
    assert(popup.contains(document.activeElement), 'real dropdown auto-focus enters its own portal');
    assert(table.isConnected, 'owned dropdown focus preserves the table bubble');
    assert.equal(focusValue(), 'true');
    const dropdownEscape = await key(document.activeElement!, 'Escape', 27);
    assert.equal(dropdownEscape.defaultPrevented, true);
    assert.equal(popup.isConnected, false);
    assert(table.isConnected); assert.equal(editor.isFocused, true);
    assert.equal(focusValue(), 'true', 'dropdown dismissal alone never leaves focus mode');
    await act(async () => button('Exit focus').focus()); await settle();
    assert.equal(table.isConnected, false, 'outside header focus hides the body-mounted table bubble');
    assert.equal(editor.isFocused, false, 'outside hiding does not force focus back into the editor');
    assert.deepEqual(editor.state.selection.toJSON(), tableSelection);
    assert.deepEqual(editor.getJSON(), documentJson);
    assert.ok(document.querySelector('.ProseMirror') === richNode);
    await key(document.activeElement!, 'Escape', 27); assert.equal(focusValue(), 'false');
    await act(async () => { assert(editor.commands.undo()); });
    assert.equal(editor.getText().includes('First paragraph edited'), false, 'actual native undo reverses the pre-focus edit');
    await act(async () => { assert(editor.commands.redo()); });
    assert.equal(editor.getText().includes('First paragraph edited'), true, 'native redo restores it');
    console.log('Actual Dashboard + local Tiptap/BubbleMenus: seven-Tab/header Escape, first-popup/second-caret Escape, Alt+F10/outside blur, owned Radix table portal focus/Escape, stable editor DOM/selection/native history passed. JSDOM geometry only; no socket/browser/device acceptance claim.');
  } finally {
    await act(async () => root.unmount()); internals._load = originalLoad; globalThis.fetch = originalFetch;
    useEditorStore.getState().clear(); useFileStore.getState().resetWorkspaceView(null); useWorkspaceStore.setState({ activeWorkspaceId: null });
    getNotebookQueryClient().clear(); dom.window.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
