import assert from 'node:assert/strict';
import Module from 'node:module';
import { act, useSyncExternalStore } from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { invalidateOpenedDocumentAuth, observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';

const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test/en/notebook' });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'NodeFilter',
  'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
type AuthState = { data: { user: { id: string }; session: { id: string } }; isPending: false; error: null };
let authState: AuthState = { data: { user: { id: 'alice' }, session: { id: 'initial' } }, isPending: false, error: null };
const listeners = new Set<() => void>();
const authClient = {
  useSession: () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => authState, () => authState),
  $store: { atoms: { session: { get: () => authState, listen: () => () => {} } }, notify: () => invalidateOpenedDocumentAuth() },
};
const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => request === 'server-only' ? {}
  : request === '@/app/lib/auth-client' || /\/app\/lib\/auth-client(?:\.ts)?$/u.test(request) ? { authClient }
    : originalLoad(request, parent, isMain);

type DeferredCreate = {
  body: { path: string; type: string; requestId: string };
  workspaceId: string | null;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
};
const completed = (request: DeferredCreate) => Response.json({ success: true, completion: {
  status: 'completed', requestId: request.body.requestId, workspaceId: request.workspaceId, targetPath: request.body.path,
} });
const pending = (request: DeferredCreate) => Response.json({ success: false, error: 'Not confirmed', code: 'MARKDOWN_CREATE_PROJECTION_PENDING', completion: {
  status: 'projection_pending', requestId: request.body.requestId, workspaceId: request.workspaceId, targetPath: request.body.path,
  code: 'MARKDOWN_CREATE_PROJECTION_PENDING',
} }, { status: 409 });

async function main() {
  const originalFetch = globalThis.fetch;
  const requests: DeferredCreate[] = [], opened: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) !== '/api/files/create') throw new Error(`Unexpected request: ${String(input)}`);
    return new Promise<Response>((resolve, reject) => requests.push({
      body: JSON.parse(String(init?.body)), workspaceId: new Headers(init?.headers).get('x-canvas-workspace-id'), resolve, reject,
    }));
  };
  let root: ReturnType<typeof import('react-dom/client').createRoot> | undefined;
  const { useFileStore } = await import('../app/store/file-store');
  const originalRefresh = useFileStore.getState().refreshDirectory, originalOpen = useFileStore.getState().revealAndLoadFile;
  try {
    const { createRoot } = await import('react-dom/client');
    const { fireEvent } = await import('@testing-library/react');
    const { useWorkspaceStore } = await import('../app/store/workspace-store');
    const { useMarkdownCreateStore } = await import('../app/store/markdown-create-store');
    const { CreateItemDialog } = await import('../app/components/file-browser/CreateItemDialog');
    const { useCreateItemDialog } = await import('../app/components/file-browser/useCreateItemDialog');
    const workspace = (id: string): ClientWorkspaceSummary => ({ id, type: 'personal', name: id, color: 'gray' as ClientWorkspaceSummary['color'], status: 'active',
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } });
    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a', workspaces: [workspace('ws-a'), workspace('ws-b')], initialized: true });
    useFileStore.setState({ refreshDirectory: async () => {}, revealAndLoadFile: async path => { opened.push(path); return { status: 'opened', path }; } });
    function Harness() {
      const hook = useCreateItemDialog();
      return <><button onClick={() => hook.openCreateDialog('file')}>Open create</button><CreateItemDialog {...hook.createDialogProps} defaultPath="." /></>;
    }
    const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
    const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
    const click = async (text: string) => { const found = button(text); assert(found); await act(async () => found.click()); await settle(); };
    const input = () => document.getElementById('createItemName') as HTMLInputElement;
    const type = async (value: string) => { await act(async () => { fireEvent.change(input(), { target: { value } }); }); };

    for (const destination of ['ws-b', 'ws-a'] as const) {
      for (const oldResult of ['pending', 'completed', 'throw'] as const) {
        requests.length = 0; opened.length = 0;
        authState = { ...authState, data: { user: { id: 'alice' }, session: { id: `${destination}-${oldResult}` } } };
        observeOpenedDocumentAuth(authState);
        useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' });
        root = createRoot(document.getElementById('root')!);
        await act(async () => root!.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><Harness /></NextIntlClientProvider>));
        await click('Open create'); await type('old'); await click(messages.notebook.createFile);
        assert.equal(requests.length, 1); assert.equal(requests[0].workspaceId, 'ws-a');
        assert.equal(input().disabled, true);

        await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'ws-b' }));
        assert.equal(document.querySelector('[role="dialog"]'), null);
        if (destination === 'ws-a') await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' }));
        await click('Open create'); await type('fresh');
        assert.equal(input().disabled, false);
        await click(messages.notebook.createFile);
        assert.equal(requests.length, 2, 'The new dialog generation must submit while the old request is still deferred.');
        assert.equal(requests[1].workspaceId, destination); assert.equal(requests[1].body.path, 'fresh.md');
        assert.notEqual(requests[0].body.requestId, requests[1].body.requestId);
        assert.equal(input().disabled, true);

        await act(async () => {
          if (oldResult === 'throw') requests[0].reject(new TypeError('Old submitted request lost its response'));
          else requests[0].resolve(oldResult === 'pending' ? pending(requests[0]) : completed(requests[0]));
        });
        await settle();
        assert(document.querySelector('[role="dialog"]'), 'The old completion must not close the new dialog.');
        assert.equal(input().value, 'fresh', 'The old completion must not replace the new name.');
        assert.equal(input().disabled, true, 'The old finally must not release the new request lock.');
        assert.equal(document.querySelector('[role="alert"]'), null, 'The old catch must not write an error into the new dialog.');
        assert.equal(opened.length, 0);
        await act(async () => { fireEvent.keyDown(input(), { key: 'Enter' }); });
        assert.equal(requests.length, 2, 'The new in-flight request still suppresses duplicate submit.');

        await act(async () => requests[1].resolve(completed(requests[1]))); await settle();
        assert.equal(document.querySelector('[role="dialog"]'), null);
        assert.deepEqual(opened, ['fresh.md'], 'The old hook catch cannot erase the new createdRef ownership.');
        assert.equal(requests.length, 2);
        assert.equal(Object.values(useMarkdownCreateStore.getState().attempts).some(entry => entry.targetPath === 'fresh.md'), false);
        await act(async () => root!.unmount()); root = undefined;
        console.log(`dialog-generation: A→B${destination === 'ws-a' ? '→A' : ''}, old ${oldResult}: new request/name/lock/error/close/open ownership passed`);
      }
    }
    console.log('markdown-manual-create-dialog-generation-test: ok (six actual client/store/hook/React cases; HTTP/auth/open boundaries are fixtures).');
  } finally {
    if (root) await act(async () => root!.unmount());
    useFileStore.setState({ refreshDirectory: originalRefresh, revealAndLoadFile: originalOpen });
    (await import('../app/lib/queries/client')).getNotebookQueryClient().clear();
    globalThis.fetch = originalFetch; internals._load = originalLoad; dom.window.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
