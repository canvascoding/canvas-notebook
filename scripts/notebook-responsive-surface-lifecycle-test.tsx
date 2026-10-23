import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { act, StrictMode, useContext, useEffect } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import { NotebookFocusContext } from '../app/components/notebook/NotebookFocusContext';
import { writeNotebookDocumentTabs } from '../app/lib/notebook/document-tabs';
import { getNotebookQueryClient } from '../app/lib/queries/client';
import type { CurrentFile } from '../app/lib/files/types';
import messages from '../messages/en.json';

// This is an actual DashboardShell/AppLayout/viewport-controller reconciliation
// test. Resource stand-ins prove mounting/DOM state only, never native Tiptap,
// collaboration sockets or undo. Those remain the original browser gate.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://canvas.test/en/notebook?path=note.md&workspaceId=workspace', pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'Node', 'MutationObserver',
  'CustomEvent', 'Event', 'HTMLInputElement', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.window, 'innerWidth', { value: 1440, configurable: true });
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.scrollBy = () => {};

type Surface = 'editor' | 'chat' | 'email' | 'browser' | 'terminal';
const mounts = Object.fromEntries(['editor', 'chat', 'email', 'browser', 'terminal'].map(name => [name, { starts: 0, ends: 0 }])) as Record<Surface, { starts: number; ends: number }>;
function useTrackedMount(surface: Surface) {
  useEffect(() => { mounts[surface].starts++; return () => { mounts[surface].ends++; }; }, [surface]);
}
function EditorStandIn() {
  useTrackedMount('editor');
  const focus = useContext(NotebookFocusContext)!;
  return <div data-testid="editor-mount-stand-in">
    <button data-testid="fixture-focus" onClick={() => focus.setFocused(!focus.focused)}>{focus.focused ? 'Exit focus' : 'Focus document'}</button>
    <textarea data-testid="editor-local-state" defaultValue="Initial local editor state" />
  </div>;
}
function ChatStandIn() {
  useTrackedMount('chat');
  return <textarea data-testid="chat-mount-stand-in" defaultValue="Initial chat draft" />;
}
function EmailStandIn() { useTrackedMount('email'); return <div data-testid="email-mount-stand-in" />; }
function BrowserStandIn() { useTrackedMount('browser'); return <div data-testid="browser-mount-stand-in" />; }
function TerminalStandIn() { useTrackedMount('terminal'); return <div data-testid="terminal-mount-stand-in" />; }

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
    if (request === 'sonner') return { toast: { error: noop, success: noop } };
    if (emptyComponents[request]) return { __esModule: true, ...Object.fromEntries(emptyComponents[request].map(name => [name, () => null])) };
    return originalLoad(request, parent, isMain);
  };
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
  const root = createRoot(document.getElementById('root')!);
  const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  const element = <T extends HTMLElement>(id: string) => {
    const node = document.querySelector<T>(`[data-testid="${id}"]`); assert(node, `${id} mounted`); return node;
  };
  const resize = async (width: number) => {
    await act(async () => {
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
      window.dispatchEvent(new Event('resize'));
    });
    await settle();
  };
  const toggleFocus = async () => { await act(async () => element<HTMLButtonElement>('fixture-focus').click()); await settle(); };
  const assertPanelLinks = () => {
    for (const tab of document.querySelectorAll('[role="tab"][aria-controls]')) {
      const controlled = document.getElementById(tab.getAttribute('aria-controls')!);
      assert(controlled, `tabpanel for ${tab.id} exists`);
      assert.equal(controlled.getAttribute('aria-labelledby'), tab.id);
    }
    const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
    assert.equal(new Set(ids).size, ids.length, 'one surface/ARIA ID per actual subtree');
  };
  try {
    window.localStorage.setItem('canvas.notebookLayout.v2', JSON.stringify({ version: 2, explorerOpen: true, explorerWidth: 240, chatDocked: true, chatWidth: 360, terminalOpen: true }));
    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace', initialized: true });
    useFileStore.getState().resetWorkspaceView('workspace');
    writeNotebookDocumentTabs(window.localStorage, 'workspace', { activePath: 'note.md', openPaths: ['note.md'], documentIds: { 'note.md': 'document' } });
    const { DashboardShell } = await import('../app/components/DashboardShell');
    await act(async () => root.render(<StrictMode><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><DashboardShell hintEnabled={false} /></NextIntlClientProvider></StrictMode>));
    await settle(); await settle();
    const editor = element<HTMLTextAreaElement>('editor-local-state');
    const chat = element<HTMLTextAreaElement>('chat-mount-stand-in');
    const email = element('email-mount-stand-in'), browser = element('browser-mount-stand-in'), terminal = element('terminal-mount-stand-in');
    const baseline = structuredClone(mounts);
    editor.value = 'Unpersisted editor-local state'; editor.focus(); editor.setSelectionRange(2, 8);
    chat.value = 'Unsent chat draft';
    const preferences = window.localStorage.getItem('canvas.notebookLayout.v2');
    assertPanelLinks();
    await toggleFocus();
    assert.ok(element('editor-local-state') === editor); assert.ok(element('terminal-mount-stand-in') === terminal);
    assert(document.getElementById('app-layout-terminal')!.parentElement!.hidden, 'focus hides an open terminal without unmounting it');
    assert.equal(window.localStorage.getItem('canvas.notebookLayout.v2'), preferences);
    await toggleFocus();
    editor.focus(); editor.setSelectionRange(2, 8);
    await resize(390);
    assert.ok(element('editor-local-state') === editor, 'actual responsive Dashboard keeps the same editor DOM node across desktop→mobile resize');
    assert.equal(editor.value, 'Unpersisted editor-local state'); assert.equal(editor.selectionStart, 2); assert.equal(editor.selectionEnd, 8);
    assert.ok(element('chat-mount-stand-in') === chat); assert.equal(chat.value, 'Unsent chat draft');
    assert.ok(element('email-mount-stand-in') === email); assert.ok(element('browser-mount-stand-in') === browser);
    assert.equal(document.querySelector('[data-testid="terminal-mount-stand-in"]'), null, 'existing real mobile reducer deliberately closes the terminal');
    assertPanelLinks();
    await toggleFocus();
    assert.ok(element('editor-local-state') === editor);
    assert(element('notebook-header').classList.contains('hidden')); assert(element('notebook-toolbar').classList.contains('hidden'));
    await toggleFocus();
    assert.equal(element('notebook-header').classList.contains('hidden'), false);
    await resize(1440);
    assert.ok(element('editor-local-state') === editor); assert.ok(element('chat-mount-stand-in') === chat);
    assert.ok(element('email-mount-stand-in') === email); assert.ok(element('browser-mount-stand-in') === browser);
    assertPanelLinks();
    for (const surface of ['editor', 'chat', 'email', 'browser'] as const) {
      assert.deepEqual(mounts[surface], baseline[surface], `${surface} never remounts after its first visit when only resize/focus changes`);
      assert.equal(document.querySelectorAll(`[data-testid="${surface === 'editor' ? 'editor-local-state' : `${surface}-mount-stand-in`}"]`).length, 1);
    }
    assert.equal(mounts.terminal.ends, baseline.terminal.ends + 1, 'terminal teardown is solely the existing mobile-close policy');
    const showTerminal = document.querySelector<HTMLButtonElement>('button[aria-label="Show terminal"]');
    assert(showTerminal); await act(async () => showTerminal.click()); await settle();
    const reopenedTerminal = element('terminal-mount-stand-in');
    assert.ok(reopenedTerminal !== terminal, 'explicit reopen after mobile-close creates a new terminal as before');
    await act(async () => window.dispatchEvent(new CustomEvent('terminal-resize', { detail: { action: 'fullscreen' } })));
    assert.equal(document.body.style.overflow, 'hidden');
    await toggleFocus();
    assert.equal(document.body.style.overflow, '', 'hidden fullscreen terminal releases document viewport/body lock');
    assert.ok(element('terminal-mount-stand-in') === reopenedTerminal);
    await toggleFocus();
    assert.equal(document.body.style.overflow, 'hidden', 'visible terminal resumes its existing fullscreen presentation');
    await act(async () => window.dispatchEvent(new CustomEvent('terminal-resize', { detail: { action: 'fullscreen' } })));
    console.log('Actual DashboardShell + AppLayout + real viewport reducer: stable single surface instances across resize/focus; DOM draft/selection and ARIA preserved; hidden terminal fullscreen unlocked; mobile-close policy unchanged. No Tiptap/socket/undo acceptance claim.');
  } finally {
    await act(async () => root.unmount()); internals._load = originalLoad; globalThis.fetch = originalFetch;
    useEditorStore.getState().clear(); useFileStore.getState().resetWorkspaceView(null); useWorkspaceStore.setState({ activeWorkspaceId: null });
    getNotebookQueryClient().clear(); dom.window.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
