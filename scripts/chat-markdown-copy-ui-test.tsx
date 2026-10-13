import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import type { ChatHeader as Header } from '../app/components/canvas-agent-chat/ChatHeader';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.test/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
Object.defineProperty(dom.window, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: (callback: () => void) => setTimeout(callback, 0), configurable: true });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: clearTimeout, configurable: true });
dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
dom.window.HTMLElement.prototype.setPointerCapture = () => {};
dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

async function main() {
  const directory = await mkdtemp(path.join(process.cwd(), 'node_modules/.cache-chat-markdown-'));
  const notifications: string[] = [];
  Object.defineProperty(globalThis, '__chatMarkdownToasts', { value: notifications, configurable: true });
  try {
    const outfile = path.join(directory, 'header.cjs');
    await build({
      stdin: { contents: "export { ChatHeader } from './app/components/canvas-agent-chat/ChatHeader';", resolveDir: process.cwd(), loader: 'tsx' },
      outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      plugins: [{ name: 'unrelated-header-services', setup(builder) {
        builder.onResolve({ filter: /^sonner$/ }, () => ({ path: 'toast', namespace: 'toast-spy' }));
        builder.onLoad({ filter: /.*/, namespace: 'toast-spy' }, () => ({ contents: `export const toast=Object.fromEntries(['success','error','warning'].map(kind=>[kind,message=>globalThis.__chatMarkdownToasts.push(kind+':'+message)]));` }));
        builder.onResolve({ filter: /(@\/i18n\/navigation|AppBackButton|ChatAgentSelector|ChatLiveBrowserLink|WorkspaceSwitcher)$/ }, (args) => ({ path: args.path, namespace: 'header-stubs' }));
        builder.onLoad({ filter: /.*/, namespace: 'header-stubs' }, () => ({
          contents: `import React from 'react'; export const Link=({children,...props})=>React.createElement('a',props,children);
            export const AppBackButton=()=>null; export const ChatAgentSelector=()=>null; export const ChatLiveBrowserLink=()=>null;
            export const WorkspaceSwitcher=()=>null; export const useShouldShowWorkspaceSwitcher=()=>false;`,
          loader: 'jsx', resolveDir: process.cwd(),
        }));
      } }],
    });
    const { ChatHeader } = createRequire(import.meta.url)(outfile) as { ChatHeader: typeof Header };
    const { render, fireEvent, cleanup } = await import('@testing-library/react');
    const props: React.ComponentProps<typeof Header> = {
      activeAgentDisplayName: 'Bradley', activeSessionAgentId: 'agent-a', chatAgentOptions: [], contextDetailedLabel: '', contextTooltip: '',
      hideNavHeader: true, isHistoryOverlayOpen: false, isMobile: false, isSessionTitleGenerating: false, onCompact: () => {},
      onDeleteSession: () => {}, onSelectAgent: () => {}, onReloadAgents: async () => {}, onSetShowHistory: () => {}, onStartNewChat: () => {},
      runtimeStatus: null, sessionDisplayLabel: 'Debug chat', sessionId: 'chat/a', workspaceId: 'workspace-a',
      showHistory: false, showSkillsLink: false, showWorkspaceSwitcher: false, totalUnreadCount: 0,
    };
    const tree = (changes: Partial<typeof props> = {}, locale = 'en') => <NextIntlClientProvider locale={locale} timeZone="UTC" messages={locale === 'de' ? de : en}><ChatHeader {...props} {...changes} /></NextIntlClientProvider>;
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { writes.push(text); } } });
    let resolveResponse: (response: Response) => void = () => {};
    let requests = 0;
    let signal: AbortSignal | null = null;
    globalThis.fetch = async (url, options) => {
      requests++;
      assert.equal(String(url), '/api/sessions/chat%2Fa/export?agentId=agent-a&workspaceId=workspace-a');
      assert.equal(options?.cache, 'no-store'); assert.equal(options?.credentials, 'include');
      signal = options?.signal ?? null;
      return new Promise<Response>((resolve) => { resolveResponse = resolve; });
    };
    const view = render(tree());
    const open = () => fireEvent.pointerDown(view.getByTestId('chat-header-menu-trigger'), { button: 0, ctrlKey: false });
    open();
    assert(view.getByRole('menuitem', { name: en.chat.copyChatMarkdown }));
    assert(view.getByTestId('chat-delete-session'), 'the existing delete action remains available');
    await act(async () => { fireEvent.click(view.getByTestId('chat-copy-markdown')); });
    assert.equal(requests, 1);
    assert.equal(writes.length, 0);
    open();
    assert.equal(view.getByTestId('chat-copy-markdown').getAttribute('aria-disabled'), 'true');
    assert(view.getByTestId('chat-copy-markdown').textContent?.includes(en.chat.copyingChatMarkdown));
    await act(async () => { resolveResponse(Response.json({ markdown: '# Chat\n\nTool input\n\nFull tool output', hasWarnings: false })); });
    assert.deepEqual(writes, ['# Chat\n\nTool input\n\nFull tool output']);
    assert(notifications.includes(`success:${en.chat.chatMarkdownCopied}`));

    fireEvent.keyDown(view.getByRole('menu'), { key: 'Escape' });
    view.rerender(tree({ sessionId: null }, 'de'));
    open();
    assert.equal(view.getByRole('menuitem', { name: de.chat.copyChatMarkdown }).getAttribute('aria-disabled'), 'true');
    fireEvent.keyDown(view.getByRole('menu'), { key: 'Escape' });
    view.rerender(tree({ runtimeStatus: { phase: 'streaming' } as NonNullable<typeof props.runtimeStatus> }));
    open();
    assert.equal(view.getByTestId('chat-copy-markdown').getAttribute('aria-disabled'), 'true', 'a streaming partial response cannot be presented as a full export');
    fireEvent.keyDown(view.getByRole('menu'), { key: 'Escape' });
    view.rerender(tree());
    open();
    await act(async () => { fireEvent.click(view.getByTestId('chat-copy-markdown')); });
    await act(async () => { view.rerender(tree({ sessionId: 'other-chat' })); });
    assert.equal((signal as unknown as AbortSignal).aborted, true);
    await act(async () => { resolveResponse(Response.json({ markdown: 'late wrong-chat export' })); });
    assert.equal(writes.length, 1, 'switching chats aborts a stale clipboard export');

    view.rerender(tree());
    open();
    await act(async () => { fireEvent.click(view.getByTestId('chat-copy-markdown')); });
    await act(async () => { resolveResponse(new Response('', { status: 500 })); });
    assert.equal(writes.length, 1, 'missing archive/server errors never copy a partial chat');
    assert(notifications.includes(`error:${en.chat.chatMarkdownCopyFailed}`));

    let clipboardWriteStarted = false;
    let promisedBlob: Promise<Blob> | null = null;
    class PromiseClipboardItem {
      constructor(public data: Record<string, Promise<Blob>>) {}
    }
    Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: PromiseClipboardItem });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async (items: PromiseClipboardItem[]) => {
      clipboardWriteStarted = true;
      promisedBlob = items[0].data['text/plain'];
      writes.push(await (await promisedBlob).text());
    } } });
    open();
    await act(async () => { fireEvent.click(view.getByTestId('chat-copy-markdown')); });
    assert(clipboardWriteStarted, 'start clipboard.write before awaiting HTTP to preserve user activation');
    assert(promisedBlob);
    await act(async () => { resolveResponse(Response.json({ markdown: 'Promise-backed export', hasWarnings: true })); });
    assert.equal(writes.at(-1), 'Promise-backed export');
    assert(notifications.includes(`warning:${en.chat.chatMarkdownCopiedIncomplete}`));

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async () => { throw new Error('Permission denied'); } } });
    open();
    const previousWrites = writes.length;
    await act(async () => { fireEvent.click(view.getByTestId('chat-copy-markdown')); });
    assert.equal((signal as unknown as AbortSignal).aborted, true);
    await act(async () => { resolveResponse(new Response('', { status: 500 })); });
    assert.equal(writes.length, previousWrites, 'permission denial does not claim successful copying');
    open();
    assert.notEqual(view.getByTestId('chat-copy-markdown').getAttribute('aria-disabled'), 'true', 'failures allow retry');
    cleanup();
    console.log('[Chat Markdown Copy UI Test] passed (DOM interaction, no browser)');
  } finally {
    await rm(directory, { recursive: true, force: true });
    dom.window.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
