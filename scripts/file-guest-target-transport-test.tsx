import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as React from 'react';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import ts from 'typescript';
import messages from '../messages/en.json';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import type { WorkspaceFileMetadataTarget } from '../app/lib/files/workspace-file-metadata-contract';

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void; paths: string[]; workspaceId?: string | null };
type Request = { pathname: string; path: string | null; method: string; workspaceId: string | null; body: Record<string, unknown> | null };
type Reply = (request: Request) => Promise<Response> | Response;
let PublicShareDialog: React.ComponentType<DialogProps>;
let createRoot: typeof import('react-dom/client').createRoot;
let dom: JSDOM;
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
const workspace = { id: 'guest-target-workspace', name: 'Target fixture', legacy: false,
  permissions: { canRead: true, canWrite: true, canDelete: true, canManageWorkspace: true,
    canCreatePublicLinks: true, canRunAgent: true } } as ClientWorkspaceSummary;
const store = { activeWorkspaceId: workspace.id, workspaces: [workspace], teamFeaturesEnabled: true, databaseProvider: 'postgres' };
const requests: Request[] = [];
let reply: Reply;

// These are transport/React-state checks, not browser or visual acceptance.
// Both product components and the scoped request hook/requester are actual
// source. Presentational dialogs/tabs, unrelated share panels, auth display and
// Next navigation are leaves; only fetch responses supply the file identities.
async function componentModule(filename: string, overrides: Record<string, unknown>) {
  const absolute = path.resolve(filename), load = createRequire(absolute);
  const source = ts.transpileModule(await fs.readFile(absolute, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function('require', 'module', 'exports', source)((name: string) => Object.prototype.hasOwnProperty.call(overrides, name)
    ? overrides[name] : load(name), { exports }, exports);
  return exports;
}

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.test', pretendToBeVisual: true });
  const globals: Record<string, unknown> = { window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  createRoot = (await import('react-dom/client')).createRoot;
  const panel = await componentModule('app/components/file-guests/FileGuestManagementPanel.tsx', {
    '@/app/lib/auth-client': { authClient: { useSession: () => ({ data: { user: { id: 'fixture-owner' } } }) } },
    '@/i18n/navigation': { Link: ({ href, children }: React.PropsWithChildren<{ href: string }>) => <a href={href}>{children}</a> },
    '../file-browser/ShareExpiryField': { ShareExpiryField: () => null },
  });
  const surface = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  const dialog = { Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div>{children}</div> : null,
    DialogContent: surface, DialogDescription: surface, DialogFooter: surface, DialogHeader: surface, DialogTitle: surface };
  const tabs = { Tabs: surface, TabsContent: surface, TabsList: surface, TabsTrigger: surface };
  const actual = await componentModule('app/components/file-browser/PublicShareDialog.tsx', {
    '@/app/store/workspace-store': { useWorkspaceStore: Object.assign((select: (state: typeof store) => unknown) => select(store), { getState: () => store }) },
    '@/components/ui/dialog': dialog, '@/components/ui/tabs': tabs,
    '../file-guests/FileGuestManagementPanel': panel,
    './PublicLinkPanel': { PublicLinkPanel: () => null }, './ShareMarkdownDialog': { ShareMarkdownDialog: () => null },
  });
  // The real scoped requester's store import uses the same fixed workspace.
  const state = await import('../app/store/workspace-store');
  state.useWorkspaceStore.setState({ activeWorkspaceId: workspace.id });
  PublicShareDialog = actual.PublicShareDialog as React.ComponentType<DialogProps>;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'https://canvas.test');
    const request: Request = { pathname: url.pathname, path: url.searchParams.get('path'), method: init?.method ?? 'GET',
      workspaceId: new Headers(init?.headers).get('x-canvas-workspace-id'), body: init?.body ? JSON.parse(String(init.body)) : null };
    requests.push(request); return reply(request);
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  dom?.window.close();
});

const native = (filePath: string, generation = 1): WorkspaceFileMetadataTarget => ({ version: 1, kind: 'native_file',
  workspaceId: workspace.id, path: filePath, documentId: `document-${generation}`, lifecycleGeneration: generation });
const json = (value: unknown, status = 200) => Response.json(value, { status });
function normalReplies(target: () => unknown): Reply {
  return request => request.pathname === '/api/files/info' ? json({ success: true, data: { metadataTarget: target() } })
    : request.method === 'GET' ? json({ success: true, invitations: [] }) : json({ success: true });
}

async function settle(check: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt++) {
    await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
    if (check()) return;
  }
  assert.fail('The actual components did not reach the expected transport state.');
}
async function harness(filePath: string, run: (container: HTMLElement, render: (filePath: string, open?: boolean) => Promise<void>) => Promise<void>) {
  requests.length = 0;
  const container = document.createElement('div'); document.body.append(container);
  const root: Root = createRoot(container);
  const render = async (currentPath: string, open = true) => {
    await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <PublicShareDialog open={open} onOpenChange={() => undefined} paths={[currentPath]} workspaceId={workspace.id} />
    </NextIntlClientProvider>));
  };
  try { await render(filePath); await run(container, render); }
  finally { await act(async () => root.unmount()); container.remove(); }
}
function invite(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.type === 'submit' && button.form?.querySelector('input[type="email"]')) ?? null;
}
async function submit(container: HTMLElement) {
  const email = container.querySelector<HTMLInputElement>('input[type="email"]'); assert(email);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set; assert(setter);
    setter.call(email, 'target@example.invalid'); email.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  assert.equal(invite(container)?.disabled, false);
  await act(async () => { email.form!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
  await settle(() => requests.some(request => request.pathname === '/api/security/file-guests' && request.method === 'POST'));
}

test('actual native Info classification shares one initial request and transports an exact outer-space renamed target', async () => {
  const filePath = ' renamed-native.bin ', target = native(filePath); reply = normalReplies(() => target);
  await harness(filePath, async container => {
    await settle(() => !!invite(container));
    assert.equal(requests.filter(request => request.pathname === '/api/files/info').length, 1);
    await submit(container);
    const created = requests.find(request => request.method === 'POST'); assert(created);
    assert.deepEqual(created.body?.expectedTarget, target); assert.equal(created.body?.path, filePath);
    assert(requests.every(request => request.workspaceId === workspace.id));
  });
});

test('physical legacy Markdown still submits its actual filesystem target and reloads a bootstrapped native target', async () => {
  const filePath = 'legacy.md'; let target: WorkspaceFileMetadataTarget = { version: 1, kind: 'filesystem', workspaceId: workspace.id,
    path: filePath, fileVersion: '1:2:3:4:5', entryType: 'file' };
  reply = request => {
    if (request.method === 'POST') { target = native(filePath); return json({ success: true }); }
    return normalReplies(() => target)(request);
  };
  await harness(filePath, async container => {
    await settle(() => !!invite(container)); await submit(container);
    const created = requests.find(request => request.method === 'POST'); assert(created);
    assert.equal((created.body?.expectedTarget as WorkspaceFileMetadataTarget).kind, 'filesystem');
    await settle(() => requests.filter(request => request.pathname === '/api/files/info').length === 2 && !!invite(container));
  });
});

test('failed or mismatched Info never falls back to a path-only invitation', async () => {
  const filePath = 'note.md';
  for (const badTarget of [undefined, { ...native(filePath), version: 2 }, { ...native(filePath), workspaceId: 'other' },
    { ...native(filePath), path: 'other.md' }]) {
    reply = normalReplies(() => badTarget);
    await harness(filePath, async container => {
      await settle(() => !!container.querySelector('[role="alert"]'));
      assert.equal(invite(container), null); assert.equal(requests.some(request => request.method === 'POST'), false);
    });
  }
  reply = () => json({ success: false, error: 'Info unavailable' }, 503);
  await harness(filePath, async container => {
    await settle(() => !!container.querySelector('[role="alert"]'));
    assert.equal(invite(container), null); assert.equal(requests.some(request => request.method === 'POST'), false);
  });
});

test('a delayed previous-path Info response cannot overwrite the current exact target', async () => {
  let resolveOld!: (response: Response) => void;
  const old = new Promise<Response>(resolve => { resolveOld = resolve; });
  reply = request => request.pathname === '/api/files/info' && request.path === 'old.md' ? old
    : normalReplies(() => native('current.md'))(request);
  await harness('old.md', async (container, render) => {
    await settle(() => requests.some(request => request.path === 'old.md'));
    await render('current.md'); await settle(() => !!invite(container));
    await act(async () => { resolveOld(json({ success: true, data: { metadataTarget: native('old.md') } })); });
    await submit(container);
    assert.deepEqual(requests.find(request => request.method === 'POST')?.body?.expectedTarget, native('current.md'));
  });
});

test('closing and reopening the same path requires a new Info response and rejects the previous opening result', async () => {
  const filePath = 'reopened.md'; let resolveOld!: (response: Response) => void, infoRequests = 0;
  const old = new Promise<Response>(resolve => { resolveOld = resolve; });
  reply = request => {
    if (request.pathname === '/api/files/info' && ++infoRequests === 1) return old;
    return normalReplies(() => native(filePath, 2))(request);
  };
  await harness(filePath, async (container, render) => {
    await settle(() => infoRequests === 1);
    await render(filePath, false); await render(filePath);
    await settle(() => !!invite(container));
    await act(async () => { resolveOld(json({ success: true, data: { metadataTarget: native(filePath) } })); });
    assert.equal(infoRequests, 2); await submit(container);
    assert.deepEqual(requests.find(request => request.method === 'POST')?.body?.expectedTarget, native(filePath, 2));
  });
});

test('an invitation-list failure clears the create target and retry rereads Info before enabling a write', async () => {
  const filePath = 'retry.md'; let failList = true, generation = 1;
  reply = request => request.pathname === '/api/security/file-guests' && request.method === 'GET' && failList
    ? json({ success: false, error: 'List unavailable' }, 503) : normalReplies(() => native(filePath, generation))(request);
  await harness(filePath, async container => {
    await settle(() => !!container.querySelector('[role="alert"]'));
    assert.equal(invite(container)?.disabled, true);
    failList = false; generation = 2;
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === messages.fileSharing.retry); assert(retry);
    await act(async () => retry.click());
    await settle(() => requests.filter(request => request.pathname === '/api/files/info').length === 2 && !container.querySelector('[role="alert"]'));
    await submit(container);
    assert.deepEqual(requests.find(request => request.method === 'POST')?.body?.expectedTarget, native(filePath, 2));
  });
});
