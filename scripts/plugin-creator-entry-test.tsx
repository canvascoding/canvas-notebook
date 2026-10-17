import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { parseChatBody, projectChatBodyText } from '../app/lib/chat/chat-body-contracts';
import { CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY } from '../app/lib/chat/constants';
import { persistComposePromptHandoff } from '../app/lib/chat/composer-handoff';
import { composerDraftScope, loadComposerDraftBody } from '../app/lib/chat/draft-storage';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://canvas.test/en/plugins', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'localStorage', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node',
  'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
Object.defineProperty(globalThis, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

/** Actual menu, public body parsing and normal handoff. Controlled transport proves client behavior, not server authorization. */
async function main() {
  const loader = Module as typeof Module & { _load(name: string, parent: NodeModule | null, main: boolean): unknown };
  const original = loader._load, originalFetch = globalThis.fetch;
  const navigations: unknown[] = [], requests: Array<{ method: string; workspaceId: string | null; body?: Record<string, unknown> }> = [];
  loader._load = (name, parent, isMain) => name === '@/i18n/navigation' ? { useRouter: () => ({ push: (href: unknown) => navigations.push(href) }) } : original(name, parent, isMain);
  observeOpenedDocumentAuth({ data: { user: { id: 'entry-user' }, session: { id: 'entry-session' } } });
  let canCreate = true, failStart = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://canvas.test'), method = init?.method ?? 'GET';
    assert.equal(url.pathname, '/api/capabilities/packages/creator', 'The entry never sends a message or creates a Session.');
    assert.equal(init?.cache, 'no-store'); assert.equal(init?.credentials, 'same-origin');
    const workspaceId = url.searchParams.get('workspaceId'), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, workspaceId, body });
    if (method === 'GET') return Response.json({ success: true, data: { schemaVersion: 1, workspaceId, canCreate,
      ownership: { type: 'organization', organizationId: 'entry-org' }, creators: [{ kind: 'plugin', available: canCreate }, { kind: 'skill', available: canCreate }] } });
    if (failStart) return Response.json({ success: false, code: 'PACKAGE_ACCESS_DENIED', error: 'Do not display arbitrary server text' }, { status: 403 });
    const kind = body?.kind, coreKind = kind === 'plugin' ? 'core_plugin' : 'core_skill';
    const chatBody = parseChatBody({ version: 1, parts: [{ type: 'extension_reference', occurrenceId: 'creator-occurrence', bundleId: 'creator-bundle' },
      { type: 'text', text: '\n\nPurpose: ' }], bundles: [{ id: 'creator-bundle', caption: kind === 'plugin' ? 'Plugin Creator' : 'Skill Creator',
      primary: { selection: { kind: coreKind, coreSource: { resourceRef: kind === 'plugin' ? 'canvas-capability:v1:plugin:system:core:plugin-creator'
        : 'canvas-capability:v1:skill:system:core:skill-creator', coreRevision: '1.0.0', checksum: 'a'.repeat(64) } }, requirement: 'optional', toolCap: null },
      supporting: [], packageConnections: [] }] });
    return Response.json({ success: true, data: { schemaVersion: 1, workspaceId, agentId: 'canvas-agent', kind, mode: 'compose', body: chatBody, prompt: projectChatBodyText(chatBody) } });
  };
  const root = createRoot(document.getElementById('root')!);
  const { PluginCreatorMenu } = await import('../app/components/plugins/PluginCreatorMenu');
  const tick = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const render = async (workspaceId: string) => {
    await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><PluginCreatorMenu key={workspaceId} workspaceId={workspaceId} /></NextIntlClientProvider>));
    await tick();
  };
  const button = () => document.querySelector<HTMLButtonElement>('[data-testid="plugin-creator-menu"]')!;
  const choose = async (kind: 'plugin' | 'skill') => {
    await act(async () => button().dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true })));
    const item = document.querySelector<HTMLElement>(`[data-testid="plugin-creator-start-${kind}"]`); assert(item);
    await act(async () => item.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await tick();
  };
  try {
    await render('entry-workspace'); assert.equal(button().disabled, false);
    await choose('plugin');
    assert.equal(navigations.length, 1);
    const handoff = JSON.parse(window.sessionStorage.getItem(CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY)!);
    assert.equal(handoff.mode, 'compose'); assert.equal(handoff.auth.userId, 'entry-user'); assert.equal(handoff.workspaceId, 'entry-workspace');
    assert.equal(handoff.body.bundles[0].primary.selection.kind, 'core_plugin');
    assert.deepEqual(persistComposePromptHandoff(handoff, 'entry-workspace'), handoff.body);
    assert.deepEqual(loadComposerDraftBody('__new__', composerDraftScope('entry-workspace')), handoff.body,
      'An immediate reload can recover the exact inline body before the 300ms autosave timer.');
    assert.throws(() => persistComposePromptHandoff(handoff, 'another-workspace'), /context/);
    const storagePrototype = Object.getPrototypeOf(window.localStorage), originalSetItem = storagePrototype.setItem, originalWarn = console.warn;
    const newerBody = parseChatBody({ ...handoff.body, parts: [...handoff.body.parts, { type: 'text', text: 'New purpose' }] });
    try {
      storagePrototype.setItem = () => { throw new Error('Fixture storage quota'); }; console.warn = () => {};
      assert.throws(() => persistComposePromptHandoff({ ...handoff, body: newerBody, prompt: projectChatBodyText(newerBody) }, 'entry-workspace'), /could not be saved/,
        'A storage failure cannot acknowledge an unsaved composer body.');
    } finally { storagePrototype.setItem = originalSetItem; console.warn = originalWarn; }
    await choose('skill'); assert.equal(navigations.length, 2);
    assert.equal(JSON.parse(window.sessionStorage.getItem(CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY)!).body.bundles[0].primary.selection.kind, 'core_skill');
    assert.deepEqual(requests.filter(request => request.method === 'POST').map(request => request.body?.operation), ['create', 'create']);
    failStart = true; await choose('plugin');
    assert.equal(navigations.length, 2, 'Revoked rights cannot navigate with a stale successful handoff.');
    assert(document.body.textContent?.includes(messages.skills.creator.startError));
    assert(!document.body.textContent?.includes('arbitrary server text'));
    canCreate = false; await render('member-workspace'); assert.equal(button().disabled, true);
    const posts = requests.filter(request => request.method === 'POST').length;
    await act(async () => button().click()); await tick();
    assert.equal(requests.filter(request => request.method === 'POST').length, posts);
    console.log('PASS Creator menu: actual accessible dropdown/client handoff, both precise inline kinds, no AutoSend/Session request, current workspace, denied-state rendering and safe failure without navigation.');
  } finally { await act(async () => root.unmount()); loader._load = original; globalThis.fetch = originalFetch; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
