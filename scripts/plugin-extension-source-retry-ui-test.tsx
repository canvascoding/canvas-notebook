import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import type { PluginNavigation } from '../app/lib/plugins/plugin-navigation';
import type { PluginExtensionCoverage, PluginExtensionItem, PluginExtensionSearchResponse } from '../app/lib/plugins/plugin-extension-contracts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://source-retry.fixture.invalid/plugins', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Element', 'Node', 'MutationObserver', 'Event', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Actual Hook -> mixed Results -> source-group retry. Only auth state and HTTP transport are controlled;
 * no browser layout, SQL, source authority, accounts, provider calls or runtime is exercised. */
async function main() {
  const originalFetch = globalThis.fetch;
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load;
  let sessionId = 'retry-session';
  const sessionState = () => ({ data: { user: { id: 'retry-actor' }, session: { id: sessionId } }, error: null, isPending: false });
  loader._load = (name, parent, isMain) => name === '@/app/lib/auth-client'
    ? { authClient: { useSession: sessionState, $store: { atoms: { session: { get: sessionState } } } } }
    : originalLoad(name, parent, isMain);
  const { render, screen, within, cleanup, waitFor, act, fireEvent } = await import('@testing-library/react');
  const { usePluginExtensionSearch } = await import('../app/components/plugins/usePluginExtensionSearch');
  const { PluginExtensionSearchResults } = await import('../app/components/plugins/PluginExtensionSearchResults');
  type Pending = { url: URL; signal?: AbortSignal | null; resolve: (response: Response) => void };
  let pending: Pending[] = [];
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input), dom.window.location.origin);
    assert.equal(url.pathname, '/api/plugins/search');
    assert.equal(new Headers(init?.headers).get('x-canvas-workspace-id'), url.searchParams.get('workspaceId'));
    return new Promise<Response>(resolve => pending.push({ url, signal: init?.signal, resolve }));
  };
  const local: PluginExtensionItem = { id: 'local-plugin', name: 'local-plugin', displayName: 'Local plugin', description: 'Exact local row', kind: 'plugin',
    source: 'local', stock: 'installed', access: { canRead: true, canUse: true, canManage: false } };
  const mcp: PluginExtensionItem = { id: 'mcp-row', name: 'mcp-row', displayName: 'Own MCP', description: 'Exact own connection', kind: 'mcp', source: 'mcp', stock: 'installed',
    access: { canRead: true, canUse: true, canManage: false }, mcp: { transport: 'http', template: false }, connections: [] };
  const remote: PluginExtensionItem = { id: 'composio:canva', name: 'canva', displayName: 'Canva', description: 'Remote catalogue', kind: 'integration', source: 'composio', stock: 'available',
    access: { canRead: true, canUse: false, canManage: false }, toolkit: { slug: 'canva', noAuth: false }, connections: [] };
  const complete = (source: PluginExtensionCoverage['source']): PluginExtensionCoverage => ({ source, status: 'complete' });
  const unavailable = (source: PluginExtensionCoverage['source']): PluginExtensionCoverage => ({ source, status: 'unavailable',
    error: { code: 'CONTROLLED_SOURCE_UNAVAILABLE', message: 'Controlled static source error.', retryable: true } });
  const response = (read: Pending, items: PluginExtensionItem[], coverage: PluginExtensionCoverage[], nextCursor: string | null = null) => Response.json({ success: true, data: {
    schemaVersion: 1, query: { phase: read.url.searchParams.get('phase') as 'local' | 'remote', q: '', types: ['plugin', 'skill', 'integration', 'mcp'], stock: 'all', source: 'all',
      scope: 'all', audience: null, teamId: null, cursor: read.url.searchParams.get('cursor'), selected: null, limit: 20 },
    items, selectedItem: null, scopes: { choices: ['all', 'user'], teams: [] }, coverage,
    pagination: { nextCursor, hasNextPage: Boolean(nextCursor), loadedItems: items.length, ...(nextCursor ? {} : { totalItems: items.length }) },
  } satisfies PluginExtensionSearchResponse });
  let navigation: PluginNavigation = { area: 'plugins', view: 'browse', scope: 'all' }, workspaceId = 'retry-workspace';
  let data!: ReturnType<typeof usePluginExtensionSearch>, rerender = () => {};
  function App() {
    data = usePluginExtensionSearch({ navigation, workspaceId, epoch: 0 });
    return <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}><PluginExtensionSearchResults data={data} workspaceId={workspaceId}
      onOpen={() => {}} onRetry={data.retry} onMore={cursor => { navigation = { ...navigation, extensionCursor: cursor }; rerender(); }} /></NextIntlClientProvider>;
  }
  const mount = async () => {
    cleanup(); pending = []; navigation = { area: 'plugins', view: 'browse', scope: 'all' }; workspaceId = 'retry-workspace'; sessionId = 'retry-session';
    const view = render(<App />); rerender = () => view.rerender(<App />);
    await waitFor(() => assert.equal(pending.length, 2)); return view;
  };
  const sourceButton = (source: PluginExtensionCoverage['source']) => within(screen.getAllByTestId('plugin-extension-coverage')
    .find(element => element.getAttribute('data-source') === source)!).getByTestId('plugin-extension-retry') as HTMLButtonElement;
  let cases = 0;
  const check = (description: string) => { cases += 1; console.log(`PASS ${description}`); };
  try {
    await mount();
    await act(async () => pending[0].resolve(response(pending[0], [], [complete('packages'), complete('mcp')])));
    await waitFor(() => assert.equal(data.status, 'ready'));
    assert(data.updating); assert(screen.getByTestId('plugin-extension-loading'));
    assert.equal(screen.queryByText(en.skills.workspace.catalog.empty), null, 'A completed empty local phase is not a completed empty catalogue.');
    await act(async () => pending[1].resolve(response(pending[1], [], [complete('store'), complete('composio')])));
    await waitFor(() => assert.equal(data.updating, false));
    assert.equal(screen.queryByTestId('plugin-extension-loading'), null); assert(screen.getByText(en.skills.workspace.catalog.empty));
    check('empty local results remain Loading while the independent remote request is pending; final empty appears only after both complete');

    await mount();
    await act(async () => pending[0].resolve(response(pending[0], [local], [complete('packages'), complete('mcp')], 'bG9jYWwtMg')));
    await act(async () => pending[1].resolve(Response.json({ success: false, code: 'CONTROLLED_REMOTE_UNAVAILABLE' }, { status: 503 })));
    await waitFor(() => assert.equal(data.updating, false));
    const localButton = screen.getByTestId('plugin-extension-row-open'); localButton.focus();
    await act(async () => { fireEvent.click(sourceButton('composio')); data.retry('composio'); data.retry('store'); });
    await waitFor(() => assert.equal(pending.length, 3));
    assert.equal(pending[2].url.searchParams.get('phase'), 'remote'); assert.equal(pending[2].url.searchParams.has('cursor'), false);
    assert.equal(pending[0].signal?.aborted, false); assert.equal(pending[1].signal?.aborted, false);
    assert.equal(screen.getByText('Local plugin').closest('button'), localButton); assert.equal(document.activeElement, localButton);
    assert(sourceButton('composio').disabled && sourceButton('store').disabled);
    await act(async () => pending[2].resolve(response(pending[2], [remote], [complete('store'), complete('composio')], 'cmVtb3RlLTI')));
    await waitFor(() => assert.equal(data.updating, false));
    assert(screen.getByText('Local plugin') && screen.getByText('Canva')); assert.equal(document.activeElement, localButton);
    check('failed remote-group retry starts one remote request, coalesces double clicks and keeps current local rows and focus without restarting them');

    await act(async () => { fireEvent.click(screen.getByTestId('plugin-extension-more')); });
    await waitFor(() => assert.equal(pending.length, 5));
    assert.equal(pending[3].url.searchParams.get('phase'), 'local'); assert.equal(pending[3].url.searchParams.get('cursor'), 'bG9jYWwtMg');
    assert.equal(pending[4].url.searchParams.get('phase'), 'remote'); assert.equal(pending[4].url.searchParams.get('cursor'), 'cmVtb3RlLTI');
    await act(async () => { pending[4].resolve(response(pending[4], [remote], [complete('composio')])); pending[3].resolve(response(pending[3], [local], [complete('packages'), complete('mcp')])); });
    await waitFor(() => assert.equal(data.updating, false));
    assert.equal(data.items.length, 2); assert.equal(data.response?.pagination.nextCursor, null);
    check('the existing phase cursor envelope carries the unchanged local cursor and freshly retried remote cursor and appends without duplicate rows');

    const beforeRefresh = pending.length;
    await act(async () => data.retry()); await waitFor(() => assert.equal(pending.length, beforeRefresh + 2));
    assert.deepEqual(pending.slice(beforeRefresh).map(read => read.url.searchParams.get('phase')), ['local', 'remote']);
    check('the existing retry() API remains a full refresh of both current phase requests');

    await mount();
    await act(async () => pending[0].resolve(response(pending[0], [local], [complete('packages'), unavailable('mcp')])));
    await waitFor(() => assert.equal(data.status, 'ready')); assert(data.updating);
    const pendingRemote = pending[1], retainedLocal = screen.getByTestId('plugin-extension-row-open'); retainedLocal.focus();
    assert.equal(sourceButton('mcp').disabled, false, 'A different source group still loading must not disable this retry.');
    await act(async () => { fireEvent.click(sourceButton('mcp')); data.retry('mcp'); });
    await waitFor(() => assert.equal(pending.length, 3));
    assert.equal(pending[2].url.searchParams.get('phase'), 'local'); assert.equal(pendingRemote.signal?.aborted, false);
    assert.equal(screen.getByText('Local plugin').closest('button'), retainedLocal); assert.equal(document.activeElement, retainedLocal);
    await act(async () => pending[2].resolve(response(pending[2], [local, mcp], [complete('packages'), complete('mcp')])));
    await waitFor(() => assert(screen.getByText('Own MCP'))); assert(data.updating); assert.equal(pending.length, 3);
    await act(async () => pendingRemote.resolve(response(pendingRemote, [remote], [complete('store'), complete('composio')])));
    await waitFor(() => assert.equal(data.updating, false));
    assert.equal(data.items.length, 3); assert.equal(document.activeElement, retainedLocal);
    check('a partial local failure can retry while the original remote request is pending; valid rows, focus and the remote request survive');

    for (const lateRemote of [false, true]) {
      await mount();
      await act(async () => {
        pending[0].resolve(response(pending[0], [local], [complete('packages'), complete('mcp')], 'bG9jYWwtMg'));
        pending[1].resolve(response(pending[1], [], [complete('store'), complete('composio')], lateRemote ? 'cmVtb3RlLTI' : null));
      });
      await waitFor(() => assert.equal(data.updating, false));
      const pageOneButton = screen.getByTestId('plugin-extension-row-open'); pageOneButton.focus();
      await act(async () => fireEvent.click(screen.getByTestId('plugin-extension-more')));
      await waitFor(() => assert.equal(pending.length, lateRemote ? 4 : 3));
      const pageTwoLocal = pending[2], pageTwoRemote = lateRemote ? pending[3] : undefined;
      await act(async () => pageTwoLocal.resolve(response(pageTwoLocal, [mcp], [complete('packages'), unavailable('mcp')])));
      await waitFor(() => assert(screen.getByText('Own MCP')));
      const retryIndex: number = pending.length;
      await act(async () => fireEvent.click(sourceButton('mcp')));
      await waitFor(() => assert.equal(pending.length, retryIndex + 1));
      const retriedLocal: Pending = pending[retryIndex];
      assert.equal(retriedLocal.url.searchParams.get('phase'), 'local');
      assert.equal(retriedLocal.url.searchParams.get('cursor'), 'bG9jYWwtMg');
      await act(async () => retriedLocal.resolve(response(retriedLocal, [], [complete('packages'), complete('mcp')])));
      await waitFor(() => assert.equal(Boolean(screen.queryByText('Own MCP')), false, 'Retry must remove the withdrawn current-page MCP row.'));
      assert.deepEqual(data.items.map(row => row.id), [local.id]);
      assert.equal(screen.getByText('Local plugin').closest('button'), pageOneButton);
      assert.equal(document.activeElement, pageOneButton);
      if (pageTwoRemote) {
        assert.equal(pageTwoRemote.signal?.aborted, false); assert(data.updating);
        await act(async () => pageTwoRemote.resolve(response(pageTwoRemote, [remote], [complete('store'), complete('composio')])));
        await waitFor(() => assert.equal(data.updating, false));
        assert.deepEqual(data.items.map(row => row.id), [local.id, remote.id]);
        assert.equal(Boolean(screen.queryByText('Own MCP')), false);
        assert.equal(document.activeElement, pageOneButton);
      } else assert.equal(data.updating, false);
      check(lateRemote
        ? 'a late independent remote page merges after local cursor retry without restoring a withdrawn current-page row'
        : 'retry replaces current cursor-page rows while retaining earlier-page rows and their focus');
    }

    await mount();
    await act(async () => pending[0].resolve(response(pending[0], [local], [complete('packages'), unavailable('mcp')])));
    await waitFor(() => assert.equal(data.status, 'ready'));
    await act(async () => data.retry('mcp')); await waitFor(() => assert.equal(pending.length, 3));
    const oldReads = [...pending], staleRetry = data.retry;
    await act(async () => { workspaceId = 'replacement-workspace'; sessionId = 'replacement-session'; rerender(); });
    await waitFor(() => assert.equal(pending.length, 5)); assert(oldReads.every(read => read.signal?.aborted));
    assert.equal(screen.queryByText('Local plugin'), null);
    await act(async () => { staleRetry('mcp'); oldReads[1].resolve(response(oldReads[1], [remote], [complete('composio')]));
      oldReads[2].resolve(response(oldReads[2], [local, mcp], [complete('packages'), complete('mcp')])); });
    assert.equal(pending.length, 5); assert.equal(data.items.length, 0);
    check('source retries and both original phases retain actor/session/workspace generation fences; late results and old retry callbacks cannot cross scopes');
    console.log(JSON.stringify({ status: 'PASS', cases, browser: false, database: false, provider: false, authority: false }));
  } finally { cleanup(); loader._load = originalLoad; globalThis.fetch = originalFetch; dom.window.close(); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
