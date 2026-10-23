import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { act, useState, useSyncExternalStore, type ReactNode } from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import messages from '../messages/en.json';
import { invalidateOpenedDocumentAuth, observeOpenedDocumentAuth, openedDocumentAuthScope } from '../app/lib/collaboration/opened-document-registry';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import { MANUAL_MARKDOWN_CREATE_CODES, parseManualMarkdownCreateCompletion, validManualMarkdownCreateCoordinates,
  type ManualMarkdownCreateCompletion } from '../app/lib/files/markdown-create-result';
import type { ManualMarkdownCreateAttempt } from '../app/lib/files/markdown-create-result';

const requireHere = createRequire(import.meta.url);
const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test/en/notebook' });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'NodeFilter',
  'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
type AuthState = { data: { user: { id: string }; session: { id: string } } | null; isPending: boolean; error: null };
let authState: AuthState = { data: null, isPending: true, error: null };
const authListeners = new Set<() => void>(), atomListeners = new Set<(value: AuthState) => void>();
const authClient = {
  useSession: () => useSyncExternalStore(listener => { authListeners.add(listener); return () => { authListeners.delete(listener); }; }, () => authState, () => authState),
  $store: { atoms: { session: { get: () => authState, listen: (listener: (value: AuthState) => void) => {
    atomListeners.add(listener); return () => { atomListeners.delete(listener); };
  } } }, notify: () => invalidateOpenedDocumentAuth() },
};
function setAuth(userId: string | null, sessionId = 'fixture-session') {
  authState = { data: userId ? { user: { id: userId }, session: { id: sessionId } } : null, isPending: false, error: null };
  observeOpenedDocumentAuth(authState);
  for (const listener of atomListeners) listener(authState);
  for (const listener of authListeners) listener();
}
const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/auth-client' || /\/app\/lib\/auth-client(?:\.ts)?$/u.test(request)) return { authClient };
  return originalLoad(request, parent, isMain);
};
type Request = { path: string; type: string; requestId: string };
const calls: Array<{ url: string; workspace: string | null; body: Request | null }> = [];
let respond: (request: Request, workspace: string | null) => Promise<Response> = async () => { throw new Error('Missing fixture'); };
const completion = (request: Request, workspaceId: string, status: ManualMarkdownCreateCompletion['status'] = 'completed'): ManualMarkdownCreateCompletion => ({
  requestId: request.requestId, workspaceId, targetPath: request.path, status,
  ...(status === 'completed' ? {} : { code: MANUAL_MARKDOWN_CREATE_CODES[status] }),
}) as ManualMarkdownCreateCompletion;
const completed = async (request: Request, workspaceId: string | null) => Response.json({ success: true, completion: completion(request, workspaceId!) });
const pending = (status: Exclude<ManualMarkdownCreateCompletion['status'], 'completed'> = 'projection_pending') =>
  async (request: Request, workspaceId: string | null) => Response.json({ success: false, error: 'Not confirmed', code: MANUAL_MARKDOWN_CREATE_CODES[status],
    completion: completion(request, workspaceId!, status) }, { status: 409 });

async function main() {
  const selectedP2 = process.env.CANVAS_WEB_CREATE_P2_ONLY;
  assert(!selectedP2 || ['size', 'oversized', 'retention'].includes(selectedP2));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input), workspace = new Headers(init?.headers).get('x-canvas-workspace-id');
    const body = init?.body ? JSON.parse(String(init.body)) as Request : null;
    calls.push({ url, workspace, body });
    if (url === '/api/files/create') return respond(body!, workspace);
    if (url.startsWith('/api/files/tree?')) return Response.json({ success: true, data: [] });
    if (url.startsWith('/api/files/quick-access?')) return Response.json({ success: true, data: { files: [], total: 0, workspaceFileCount: 0 } });
    if (url.startsWith('/api/home/chats?')) return Response.json({ success: true, data: { chats: [], hasMore: false } });
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  let root: ReturnType<typeof import('react-dom/client').createRoot> | undefined;
  try {
    const client = await import('../app/lib/files/client');
    const store = await import('../app/store/markdown-create-store');
    const { useFileStore } = await import('../app/store/file-store');
    const { useWorkspaceStore } = await import('../app/store/workspace-store');
    const { CreateItemDialog } = await import('../app/components/file-browser/CreateItemDialog');
    const { useCreateItemDialog } = await import('../app/components/file-browser/useCreateItemDialog');
    const { HomeNewNoteDialog } = await import('../app/components/home/HomeNewNoteDialog');
    const { MarkdownCreatePendingAttempts } = await import('../app/components/file-browser/MarkdownCreatePendingAttempts');
    const { fireEvent } = await import('@testing-library/react');
    const { createRoot } = await import('react-dom/client');
    const ownWorkspace: ClientWorkspaceSummary = { id: 'ws-a', type: 'personal', name: 'Own workspace', color: 'gray' as ClientWorkspaceSummary['color'], status: 'active',
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
    setAuth('alice');
    useWorkspaceStore.setState({ activeWorkspaceId: ownWorkspace.id, workspaces: [ownWorkspace], initialized: true });
    const creates = () => calls.filter(call => call.url === '/api/files/create');
    const attempts = () => Object.values(store.useMarkdownCreateStore.getState().attempts);
    const storageKey = 'canvas-markdown-create-resumes:v1:alice';
    const reset = () => { store.useMarkdownCreateStore.setState({ attempts: {} }); calls.length = 0; };
    let release!: (response: Response) => void;

    if (!selectedP2) {
    for (const status of ['projection_pending', 'recovery_required', 'unavailable'] as const) {
      reset(); respond = pending(status);
      await assert.rejects(client.createWorkspacePath('docs/new.md', 'file', { workspaceId: 'ws-a' }), (error: unknown) => {
        assert(error instanceof client.WorkspaceMarkdownCreatePendingError); assert.equal(error.attempt.status, status); return true;
      });
      const original = creates()[0];
      assert.deepEqual(Object.keys(original.body!).sort(), ['path', 'requestId', 'type']);
      assert.match(original.body!.requestId, /^[a-f0-9-]{36}$/u);
      assert.equal(original.workspace, 'ws-a');
      assert.equal(attempts()[0].busy, false);
      const persisted = dom.window.localStorage.getItem(storageKey)!;
      assert.equal(JSON.parse(persisted).attempts[0].requestId, original.body!.requestId);
      assert.doesNotMatch(persisted, /sessionId|token|receipt|claim|fingerprint|content|scope|busy/u);
      respond = completed;
      await client.createWorkspacePath('docs/new.md', 'file', { workspaceId: 'ws-a' });
      assert.deepEqual(creates()[1], original, 'Explicit retry reuses the original request UUID, workspace and target.');
      assert.equal(attempts().length, 0);
    }
    for (const response of [async () => { throw new TypeError('Lost submitted response'); },
      async () => Response.json({ success: true }), async () => Response.json(null),
      async (request: Request) => Response.json({ success: true, completion: { ...completion(request, 'ws-a'), requestId: crypto.randomUUID() } }),
      async (request: Request) => Response.json({ success: true, completion: { ...completion(request, 'ws-a'), workspaceId: 'foreign' } }),
      async (request: Request) => Response.json({ success: true, completion: { ...completion(request, 'ws-a'), targetPath: 'foreign.md' } }),
      async (request: Request) => Response.json({ success: true, completion: completion(request, 'ws-a') }, { status: 202 }),
      async (request: Request) => Response.json({ success: true, completion: completion(request, 'ws-a', 'projection_pending') }),
      async () => new Response('not-json', { status: 502 })]) {
      reset(); respond = response;
      await assert.rejects(client.createWorkspacePath('uncertain.MARKDOWN', 'file', { workspaceId: 'ws-a' }), client.WorkspaceMarkdownCreatePendingError);
      assert.equal(attempts()[0].status, 'unconfirmed'); assert.equal(attempts()[0].busy, false);
      assert.equal(creates().length, 1);
    }
    const expected = { requestId: crypto.randomUUID(), workspaceId: 'ws-a', targetPath: 'a.md' };
    for (const status of ['toString', '__proto__', { toString: 'invalid' }, null]) {
      assert.equal(parseManualMarkdownCreateCompletion({ ...expected, status, code: 'x' }, expected), null);
    }
    for (const targetPath of ['../a.md', '/a.md', 'a\\b.md', 'a\u0000.md', `${'x'.repeat(4096)}.md`]) {
      assert.equal(validManualMarkdownCreateCoordinates({ ...expected, targetPath }), false);
    }
    assert(validManualMarkdownCreateCoordinates({ ...expected, targetPath: `${'x'.repeat(4093)}.md` }));
    console.log('Manual create transport: strict completed/409 pending; fixed UUID; lost/malformed/stale identity and parser boundaries passed.');

    // A real in-flight request owns its UUID before fetch runs and cannot be submitted twice.
    reset();
    respond = async request => {
      assert.equal(JSON.parse(dom.window.localStorage.getItem(storageKey)!).attempts[0].requestId, request.requestId);
      return new Promise(resolve => { release = resolve; });
    };
    const inFlight = client.createWorkspacePath('once.md', 'file', { workspaceId: 'ws-a' });
    await assert.rejects(client.createWorkspacePath('once.md', 'file', { workspaceId: 'ws-a' }), store.MarkdownCreateAttemptError);
    assert.equal(creates().length, 1);
    store.hideMarkdownCreateAttempt(attempts()[0]);
    assert.equal(attempts().length, 1, 'An in-flight lookup cannot be hidden.');
    release(await completed(creates()[0].body!, 'ws-a')); await inFlight;
    }

    const navigations: string[] = [], opened: string[] = [];
    const router = { push: (url: string) => { navigations.push(url); }, replace: () => {}, prefetch: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, hmrRefresh: () => {}, bfcacheId: 'manual-create' };
    const wrap = (children: ReactNode) => <AppRouterContext.Provider value={router}><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>{children}</NextIntlClientProvider></AppRouterContext.Provider>;
    const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); };
    const click = async (button: HTMLButtonElement) => { assert(button); await act(async () => button.click()); await settle(); };
    const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
    const type = async (id: string, value: string) => { await act(async () => { fireEvent.change(document.getElementById(id)!, { target: { value } }); }); };
    const mount = async (children: ReactNode) => {
      root = createRoot(document.getElementById('root')!); await act(async () => root!.render(wrap(children))); await settle();
    };
    const unmount = async () => { if (root) await act(async () => root!.unmount()); root = undefined; };
    const fresh = (session: string) => {
      setAuth('alice', session);
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a', workspaces: [ownWorkspace, { ...ownWorkspace, id: 'ws-b', name: 'Second workspace' }] });
      reset(); dom.window.localStorage.removeItem(storageKey);
    };
    const quotePath = (index: number) => `${Array.from({ length: 16 }, () => '"'.repeat(250)).join('/')}/${'"'.repeat(75)}${String(index).padStart(2, '0')}.md`;
    const publicRecord = (entries: ManualMarkdownCreateAttempt[]) => JSON.stringify({ version: 1, accountId: 'alice', attempts: entries });
    const longAttempts = () => Array.from({ length: 16 }, (_, index): ManualMarkdownCreateAttempt => ({
      requestId: crypto.randomUUID(), workspaceId: 'ws-a', targetPath: quotePath(index), status: 'unconfirmed',
    }));
    const limit = (error: unknown) => error instanceof store.MarkdownCreateAttemptError && error.code === 'MARKDOWN_CREATE_LIMIT';
    const pendingResume = (): ((attempt: ManualMarkdownCreateAttempt) => Promise<void>) => {
      // Exercise each actual consumer callback even when the real UI button is
      // disabled. No substitute component or product-only test hook is needed.
      const region = document.querySelector(`[aria-label="${messages.notebook.markdownCreatePendingTitle}"]`)!;
      assert(region);
      const key = Object.keys(region).find(value => value.startsWith('__reactFiber$')); assert(key);
      type Fiber = { type?: unknown; memoizedProps?: { onResume?: (attempt: ManualMarkdownCreateAttempt) => Promise<void> }; return?: Fiber | null };
      let fiber = Reflect.get(region, key) as Fiber | null;
      while (fiber && fiber.type !== MarkdownCreatePendingAttempts) fiber = fiber.return ?? null;
      assert(fiber?.memoizedProps?.onResume, 'The actual PendingUI consumer callback must be observed.');
      return fiber.memoizedProps.onResume;
    };
    let p2Families = 0;
    const p2 = async (name: string, run: () => Promise<void>) => {
      if (selectedP2 && selectedP2 !== name) return;
      await run(); p2Families++; console.log(`Web create P2 ${name}: passed`);
    };
    await p2('size', async () => {
      fresh('p2-size'); respond = pending();
      for (let index = 0; index < 15; index++) {
        const path = quotePath(index); assert.equal(path.length, 4096);
        assert(validManualMarkdownCreateCoordinates({ requestId: crypto.randomUUID(), workspaceId: 'ws-a', targetPath: path }));
        await assert.rejects(client.createWorkspacePath(path, 'file'), client.WorkspaceMarkdownCreatePendingError);
      }
      const raw = dom.window.localStorage.getItem(storageKey)!, before = attempts();
      assert(raw.length <= 128 * 1024); assert.equal(before.length, 15); assert(before.every(entry => !entry.busy));
      const proposal = [...JSON.parse(raw).attempts, { requestId: crypto.randomUUID(), workspaceId: 'ws-a', targetPath: quotePath(15), status: 'unconfirmed' }];
      assert(publicRecord(proposal).length > 128 * 1024, 'This valid16th tuple must exceed the real escaped raw budget.');
      let failure: unknown;
      try { await client.createWorkspacePath(quotePath(15), 'file'); } catch (error) { failure = error; }
      assert(limit(failure), JSON.stringify({ family: 'size', code: failure && typeof failure === 'object' ? Reflect.get(failure, 'code') ?? null : null,
        createPosts: creates().length, entries: attempts().length, busy: attempts().some(entry => entry.busy), rawPreserved: dom.window.localStorage.getItem(storageKey) === raw }));
      assert.equal(creates().length, 15, 'Known oversized reservation cannot dispatch HTTP.');
      assert.deepEqual(attempts(), before, 'No oversized entry or busy flag may be published.');
      assert.equal(dom.window.localStorage.getItem(storageKey), raw, 'The last bounded record is preserved byte for byte.');
      delete requireHere.cache[requireHere.resolve('../app/store/markdown-create-store')];
      const reloaded = requireHere('../app/store/markdown-create-store') as typeof store;
      reloaded.hydrateMarkdownCreateAttempts(openedDocumentAuthScope()!);
      const resumed = reloaded.reserveMarkdownCreateAttempt({ workspaceId: 'ws-a', targetPath: quotePath(0) });
      assert.equal(resumed.requestId, before[0].requestId, 'A fresh store resumes the readable reservation with its original UUID.');
      reloaded.settleMarkdownCreateAttempt(resumed, 'projection_pending');
      store.hideMarkdownCreateAttempt(before[14]);
      await assert.rejects(client.createWorkspacePath(quotePath(15), 'file'), client.WorkspaceMarkdownCreatePendingError);
      assert.equal(creates().length, 16); assert.equal(attempts().length, 15);

      fresh('p2-status'); const values = longAttempts();
      let remaining = publicRecord(values).length - (128 * 1024 - 2); assert(remaining > 0);
      values[15].targetPath = values[15].targetPath.replace(/"/gu, value => remaining-- > 0 ? 'x' : value);
      const bounded = publicRecord(values); assert.equal(bounded.length, 128 * 1024 - 2);
      assert(values.every(validManualMarkdownCreateCoordinates)); dom.window.localStorage.setItem(storageKey, bounded);
      store.hydrateMarkdownCreateAttempts(openedDocumentAuthScope()!);
      store.settleMarkdownCreateAttempt(attempts()[0], 'recovery_required');
      assert.equal(attempts()[0].status, 'recovery_required');
      assert.equal(dom.window.localStorage.getItem(storageKey), bounded, 'A longer status cannot overwrite a readable record with oversized JSON.');
      store.hideMarkdownCreateAttempt(attempts()[1]);
      assert(dom.window.localStorage.getItem(storageKey)!.length <= 128 * 1024);
      assert.equal(JSON.parse(dom.window.localStorage.getItem(storageKey)!).attempts.length, 15);

      const prototype = Object.getPrototypeOf(dom.window.localStorage) as Storage;
      for (const method of ['getItem', 'setItem'] as const) {
        fresh(`p2-storage-${method}`); const actual = prototype[method];
        Reflect.set(prototype, method, () => { throw new Error('Browser storage unavailable'); });
        try {
          await assert.rejects(client.createWorkspacePath(`unavailable-${method}.md`, 'file'), client.WorkspaceMarkdownCreatePendingError);
          assert.equal(creates().length, 1); assert.equal(attempts().length, 1); assert.equal(attempts()[0].busy, false);
        } finally { Reflect.set(prototype, method, actual); }
      }
    });
    await p2('oversized', async () => {
      fresh('p2-existing-oversized'); const values = longAttempts(), raw = publicRecord(values);
      assert(values.every(validManualMarkdownCreateCoordinates)); assert(raw.length > 128 * 1024);
      dom.window.localStorage.setItem(storageKey, raw); calls.length = 0;
      const ownRandom = Object.getOwnPropertyDescriptor(crypto, 'randomUUID'), actualRandom = crypto.randomUUID.bind(crypto); let minted = 0;
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => { minted++; return actualRandom(); } });
      try {
        await mount(<HomeNewNoteDialog workspaceId="ws-a" onClose={() => {}} />);
        assert.equal(attempts().length, 0, 'Hydration effect retains an oversized record without publishing it or throwing.');
        let failure: unknown;
        try { await client.createWorkspacePath(values[0].targetPath, 'file'); } catch (error) { failure = error; }
        assert(limit(failure), JSON.stringify({ family: 'oversized', minted, createPosts: creates().length,
          entries: attempts().length, rawPreserved: dom.window.localStorage.getItem(storageKey) === raw }));
        assert.equal(minted, 0, 'A known oversized record must block before minting a replacement UUID.');
        assert.equal(creates().length, 0); assert.equal(attempts().length, 0);
        const prototype = Object.getPrototypeOf(dom.window.localStorage) as Storage, get = prototype.getItem;
        Reflect.set(prototype, 'getItem', () => { throw new Error('Known oversized storage is temporarily unreadable'); });
        try { await assert.rejects(client.createWorkspacePath('another.md', 'file'), limit); }
        finally { Reflect.set(prototype, 'getItem', get); }
        assert.equal(minted, 0); assert.equal(creates().length, 0);
        store.useMarkdownCreateStore.setState({ attempts: {} });
        assert.equal(dom.window.localStorage.getItem(storageKey), raw, 'Cleanup cannot replace the retained oversized record.');
      } finally {
        if (ownRandom) Object.defineProperty(crypto, 'randomUUID', ownRandom); else Reflect.deleteProperty(crypto, 'randomUUID');
        await unmount();
      }
    });
    await p2('retention', async () => {
      fresh('p2-retention');
      for (let index = 0; index < 16; index++) {
        const entry = store.reserveMarkdownCreateAttempt({ workspaceId: 'ws-a', targetPath: `foreign-${index}.md` });
        store.settleMarkdownCreateAttempt(entry, 'unconfirmed');
      }
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-b' });
      await assert.rejects(client.createWorkspacePath('new-in-b.md', 'file'), limit); assert.equal(creates().length, 0);
      let resumed = 0;
      await mount(<MarkdownCreatePendingAttempts workspaceId="ws-b" onResume={async () => { resumed++; }} />);
      const resumes = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(item => item.textContent === messages.notebook.markdownCreateResume);
      assert.equal(resumes.length, 16, JSON.stringify({ family: 'retention', accountEntries: attempts().length, visibleRows: resumes.length, createPosts: creates().length }));
      assert(resumes.every(item => item.disabled));
      assert.equal([...document.querySelectorAll('p')].filter(item => item.textContent === messages.notebook.markdownCreateOtherWorkspace).length, 16);
      await click(resumes[0]); assert.equal(resumed, 0);
      await click(button(messages.notebook.markdownCreateHide)); assert.equal(attempts().length, 15); assert.equal(creates().length, 0);
      respond = pending(); await assert.rejects(client.createWorkspacePath('new-in-b.md', 'file'), client.WorkspaceMarkdownCreatePendingError);
      assert.equal(creates().length, 1); assert.equal(creates()[0].workspace, 'ws-b'); await unmount();
      store.hideMarkdownCreateAttempt(attempts().find(entry => entry.workspaceId === 'ws-a')!);
      assert.equal(attempts().length, 15); assert.equal(creates().length, 1, 'The direct consumer guard is tested with genuine free dispatch capacity.');
      const foreign = attempts().find(entry => entry.workspaceId === 'ws-a')!;
      calls.length = 0; let created = 0;
      await mount(<HomeNewNoteDialog workspaceId="ws-b" onClose={() => {}} />);
      await act(async () => pendingResume()(foreign)); assert.equal(creates().length, 0, 'Home cannot reinterpret a foreign pending tuple in its current workspace.'); await unmount();
      await mount(<CreateItemDialog open onOpenChange={() => {}} type="file" defaultPath="." workspaceId="ws-b" onCreate={async () => { created++; }} />);
      await act(async () => pendingResume()(foreign)); assert.equal(created, 0, 'FileBrowser consumer also rejects a direct foreign callback.'); await unmount();

      fresh('p2-duplicate-uuid'); const requestId = crypto.randomUUID();
      for (const workspaceId of ['ws-a', 'ws-b']) {
        const entry = store.reserveMarkdownCreateAttempt({ workspaceId, targetPath: 'same-name.md', requestId });
        store.settleMarkdownCreateAttempt(entry, 'unconfirmed');
      }
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-b' });
      const consoleError = console.error, keyErrors: string[] = [];
      console.error = (...args) => { if (/same key|unique.*key/iu.test(String(args[0]))) keyErrors.push(String(args[0])); else consoleError(...args); };
      try {
        await mount(<MarkdownCreatePendingAttempts workspaceId="ws-b" onResume={async attempt => { assert.equal(attempt.workspaceId, 'ws-b'); resumed++; }} />);
        const rows = [...document.querySelectorAll('p')].filter(item => item.textContent === 'same-name.md').map(item => item.parentElement!);
        assert.equal(rows.length, 2); assert.equal(keyErrors.length, 0, 'Same UUID in separate workspaces needs separate React keys.');
        assert.equal(rows[0].querySelector('button')!.disabled, true); assert.equal(rows[1].querySelector('button')!.disabled, false);
        await click(rows[0].querySelectorAll('button')[1]); assert.equal(attempts().length, 1); assert.equal(attempts()[0].workspaceId, 'ws-b');
        await click(button(messages.notebook.markdownCreateResume)); assert.equal(resumed, 1); assert.equal(creates().length, 0);
      } finally { console.error = consoleError; await unmount(); }
    });
    assert.equal(p2Families, selectedP2 ? 1 : 3);
    fresh('legacy-ui');
    if (!selectedP2) {
    const originalRefresh = useFileStore.getState().refreshDirectory, originalOpen = useFileStore.getState().revealAndLoadFile;
    useFileStore.setState({ refreshDirectory: async () => { throw new Error('Independent tree refresh failed'); },
      revealAndLoadFile: async path => { opened.push(path); return { status: 'superseded', path }; } });
    function BrowserHarness({ defaultPath }: { defaultPath: string }) {
      const hook = useCreateItemDialog();
      return <><button onClick={() => hook.openCreateDialog('file')}>Open create</button><CreateItemDialog {...hook.createDialogProps} defaultPath={defaultPath} /></>;
    }
    reset();
    respond = async () => new Promise(resolve => { release = resolve; });
    await mount(<BrowserHarness defaultPath="docs" />); await click(button('Open create')); await type('createItemName', 'first');
    await act(async () => { button(messages.notebook.createFile).click(); button(messages.notebook.createFile).click(); });
    assert.equal(creates().length, 1);
    const initial = creates()[0];
    await act(async () => root!.render(wrap(<BrowserHarness defaultPath="changed" />)));
    assert.equal((document.getElementById('createItemName') as HTMLInputElement).value, 'first');
    assert.equal((document.getElementById('createItemTargetDir') as HTMLInputElement).value, 'docs');
    assert.equal((document.getElementById('createItemName') as HTMLInputElement).disabled, true);
    await act(async () => release(await pending()(initial.body!, 'ws-a'))); await settle();
    assert.equal(opened.length, 0); assert(document.querySelector('[role="dialog"]'));
    assert(button(messages.notebook.markdownCreateResume));
    respond = completed; await click(button(messages.notebook.markdownCreateResume));
    assert.deepEqual(creates()[1], initial);
    assert.deepEqual(opened, ['docs/first.md'], 'Confirmed create follows the actual open hook even if the independent tree refresh throws.');
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(attempts().length, 0, 'A blocked/superseded open does not turn a confirmed create into a pending creation.');
    assert.equal(creates().length, 2, 'Opening uses no additional Create request.');
    await unmount();
    for (const change of ['workspace', 'session'] as const) {
      reset(); setAuth('alice', `browser-${change}`); useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' });
      let releaseRefresh!: () => void;
      useFileStore.setState({ refreshDirectory: async () => new Promise<void>(resolve => { releaseRefresh = resolve; }) });
      respond = completed; await mount(<BrowserHarness defaultPath="docs" />); await click(button('Open create'));
      await type('createItemName', `refresh-${change}`); await click(button(messages.notebook.createFile));
      assert(releaseRefresh); assert.equal(attempts().length, 0, 'The server-confirmed file stays confirmed during an independent tree refresh.');
      const beforeOpen: number = opened.length;
      if (change === 'workspace') await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'ws-b' }));
      else await act(async () => setAuth('alice', 'browser-new-session'));
      await act(async () => releaseRefresh()); await settle();
      assert.equal(opened.length, beforeOpen, 'A deferred refresh cannot open the previous auth/workspace document.');
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.equal(creates().length, 1, 'A confirmed file is never created again by the refresh/open follow-up.');
      await unmount();
    }
    setAuth('alice', 'home-ready'); useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' });
    useFileStore.setState({ refreshDirectory: originalRefresh, revealAndLoadFile: originalOpen });

    function HomeHarness() {
      const [open, setOpen] = useState(true);
      return <><button onClick={() => setOpen(true)}>Open note</button>{open ? <HomeNewNoteDialog workspaceId="ws-a" onClose={() => setOpen(false)} /> : null}</>;
    }
    reset(); respond = pending('recovery_required'); await mount(<HomeHarness />);
    await type('home-note-name', 'Home'); await click(button(messages.home.start.createAndOpen));
    const firstHome = creates()[0]; assert.equal(navigations.length, 0);
    await click(button(messages.home.start.cancel)); assert.equal(document.querySelector('[role="dialog"]'), null);
    await click(button('Open note')); assert(button(messages.notebook.markdownCreateResume));
    assert.equal(creates().length, 1, 'Reopening a dialog does not submit a request.');
    respond = completed; await click(button(messages.notebook.markdownCreateResume));
    assert.deepEqual(creates()[1], firstHome); assert.equal(navigations.length, 1);
    assert.match(navigations[0], /path=Home.md&workspaceId=ws-a/u); assert.equal(attempts().length, 0);
    await unmount();

    reset(); respond = pending(); await mount(<HomeHarness />);
    await type('home-note-name', 'hide-local'); await click(button(messages.home.start.createAndOpen));
    const beforeHide = creates().length;
    await click(button(messages.notebook.markdownCreateHide));
    assert.equal(creates().length, beforeHide, 'Hiding a local lookup cannot change or delete a server operation.');
    assert.equal(attempts().length, 0); assert.equal(navigations.length, 1);
    assert.equal(document.querySelector('[role="dialog"]') !== null, true);
    await unmount();

    // Actual late Home completions: workspace switch, new session, foreign account and unmount.
    for (const change of ['workspace', 'session', 'account', 'unmount'] as const) {
      reset(); await act(async () => { setAuth('alice', `late-${change}`); useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' }); });
      respond = async () => new Promise(resolve => { release = resolve; });
      await mount(<HomeHarness />); await type('home-note-name', change); await click(button(messages.home.start.createAndOpen));
      const submitted = creates()[0], beforeNavigation: number = navigations.length;
      if (change === 'workspace') await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'ws-b' }));
      if (change === 'session') await act(async () => setAuth('alice', 'different-session'));
      if (change === 'account') await act(async () => setAuth('bob', 'different-account'));
      if (change === 'unmount') await unmount();
      await act(async () => release(await completed(submitted.body!, 'ws-a'))); await settle();
      assert.equal(navigations.length, beforeNavigation, `${change}: a stale completed response cannot navigate.`);
      if (change === 'workspace') {
        assert.equal(attempts()[0].status, 'unconfirmed');
        const count = creates().length;
        await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' }));
        assert.equal(creates().length, count, 'Returning to the workspace never retries automatically.');
        respond = completed; await click(button(messages.notebook.markdownCreateResume));
        assert.deepEqual(creates()[1], submitted);
      }
      if (change === 'session' || change === 'account') assert.equal(attempts().length, 0);
      await unmount();
    }
    console.log('Real CreateItemDialog/hook/Home: reentrancy/defaultPath/pending resume, refresh/open failure and auth/workspace/unmount fences passed.');

    await act(async () => { setAuth('alice', 'reload'); useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' }); });
    reset(); respond = pending(); await assert.rejects(client.createWorkspacePath('reload.md', 'file'), client.WorkspaceMarkdownCreatePendingError);
    const saved = dom.window.localStorage.getItem(storageKey)!;
    delete requireHere.cache[requireHere.resolve('../app/store/markdown-create-store')];
    const restored = requireHere('../app/store/markdown-create-store') as typeof store;
    calls.length = 0; restored.hydrateMarkdownCreateAttempts(openedDocumentAuthScope()!);
    assert.equal(Object.keys(restored.useMarkdownCreateStore.getState().attempts).length, 1);
    assert.equal(creates().length, 0);
    const value = JSON.parse(saved);
    for (const bad of ['{bad', 'x'.repeat(128 * 1024 + 1), JSON.stringify({ ...value, accountId: 'foreign' }),
      JSON.stringify({ ...value, attempts: [{ ...value.attempts[0], token: 'not-allowed' }] }),
      JSON.stringify({ ...value, attempts: [value.attempts[0], value.attempts[0]] }),
      JSON.stringify({ ...value, attempts: Array.from({ length: 17 }, () => value.attempts[0]) })]) {
      restored.useMarkdownCreateStore.setState({ attempts: {} }); dom.window.localStorage.setItem(storageKey, bad);
      restored.hydrateMarkdownCreateAttempts(openedDocumentAuthScope()!);
      assert.equal(Object.keys(restored.useMarkdownCreateStore.getState().attempts).length, 0);
    }
    restored.useMarkdownCreateStore.setState({ attempts: {} }); dom.window.localStorage.removeItem(storageKey);
    for (let index = 0; index < 16; index++) {
      const entry = restored.reserveMarkdownCreateAttempt({ targetPath: `bounded-${index}.md`, workspaceId: 'ws-a' });
      restored.settleMarkdownCreateAttempt(entry, 'unconfirmed');
    }
    assert.throws(() => restored.reserveMarkdownCreateAttempt({ targetPath: 'overflow.md', workspaceId: 'ws-a' }), restored.MarkdownCreateAttemptError);
    assert.equal(JSON.parse(dom.window.localStorage.getItem(storageKey)!).attempts.length, 16);
    const hidden = Object.values(restored.useMarkdownCreateStore.getState().attempts)[0];
    restored.hideMarkdownCreateAttempt(hidden);
    assert.equal(Object.keys(restored.useMarkdownCreateStore.getState().attempts).length, 15);
    const replacement = restored.reserveMarkdownCreateAttempt({ targetPath: 'after-hide.md', workspaceId: 'ws-a' });
    restored.settleMarkdownCreateAttempt(replacement, 'unconfirmed');
    assert.equal(Object.keys(restored.useMarkdownCreateStore.getState().attempts).length, 16, 'Explicit local hiding releases capacity without silently evicting another lookup.');
    invalidateOpenedDocumentAuth();
    assert.equal(dom.window.localStorage.getItem(storageKey), null); assert.equal(Object.keys(restored.useMarkdownCreateStore.getState().attempts).length, 0);
    assert.equal(calls.length, 0, 'Storage, hydration, bounds and auth invalidation cannot send requests.');
    }
    console.log('markdown-manual-create-client-test: ok (real client/store/React, fixture HTTP/auth/open boundaries; no route/PG/browser proof).',
      { selectedP2: selectedP2 ?? null, p2Families, legacySuite: !selectedP2 });
  } finally {
    if (root) await act(async () => root!.unmount());
    (await import('../app/lib/queries/client')).getNotebookQueryClient().clear();
    globalThis.fetch = originalFetch; internals._load = originalLoad; dom.window.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
