import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React from 'react';
import type { PluginNavigation } from '../app/lib/plugins/plugin-navigation';
import type { PluginExtensionItem, PluginExtensionSearchResponse } from '../app/lib/plugins/plugin-extension-contracts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/plugins', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event'])
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function main() {
  const originalFetch = globalThis.fetch;
  const { render, screen, cleanup, waitFor, act } = await import('@testing-library/react');
  let sessionId = 'progressive-session';
  const session = () => ({ user: { id: 'progressive-owner', name: 'Owner', email: 'owner@fixture.invalid', role: 'admin', emailVerified: true, createdAt: new Date(0), updatedAt: new Date(0), banned: false },
    session: { id: sessionId, userId: 'progressive-owner', token: 'CONTROLLED_UI_SESSION', expiresAt: new Date('2099-01-01'), createdAt: new Date(0), updatedAt: new Date(0) } });
  const sessionState = () => ({ data: session(), error: null, isPending: false, isRefetching: false });
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load;
  loader._load = (name, parent, main) => name === '@/app/lib/auth-client'
    ? { authClient: { useSession: sessionState, $store: { atoms: { session: { get: sessionState } } } } }
    : originalLoad(name, parent, main);
  const { usePluginExtensionSearch } = await import('../app/components/plugins/usePluginExtensionSearch');
  const pending: Array<{ url: URL; signal?: AbortSignal | null; resolve(response: Response): void }> = [];
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input), dom.window.location.origin);
    if (url.pathname === '/api/auth/get-session') return Promise.resolve(Response.json(session()));
    assert.equal(url.pathname, '/api/plugins/search');
    return new Promise(resolve => pending.push({ url, signal: init?.signal, resolve }));
  };
  const row = (description: string): PluginExtensionItem => ({ id: 'composio:canva', kind: 'integration', name: 'canva', displayName: 'Canva', description,
    source: 'composio', stock: 'installed', access: { canRead: true, canUse: true, canManage: false }, toolkit: { slug: 'canva', noAuth: false }, connections: [] });
  const response = (read: typeof pending[number], description: string, nextCursor: string | null = null) => Response.json({ success: true, data: {
    schemaVersion: 1, query: { phase: read.url.searchParams.get('phase') as 'local' | 'remote', q: '', types: ['plugin', 'skill', 'integration', 'mcp'], stock: 'all', source: 'all', scope: 'all', audience: null, teamId: null, cursor: null, selected: null, limit: 20 },
    items: [row(description)], selectedItem: null, scopes: { choices: ['all', 'user'], teams: [] },
    coverage: [{ source: 'composio', status: 'complete' }], pagination: { nextCursor, hasNextPage: Boolean(nextCursor), loadedItems: 1, totalItems: nextCursor ? undefined : 1 },
  } satisfies PluginExtensionSearchResponse });
  let navigation: PluginNavigation = { area: 'plugins', view: 'browse', scope: 'all' }, epoch = 0;
  let data: ReturnType<typeof usePluginExtensionSearch>;
  const App = () => { data = usePluginExtensionSearch({ navigation, workspaceId: 'progressive-workspace', epoch });
    return <output data-testid="result">{JSON.stringify({ status: data.status, updating: data.updating, items: data.items, pagination: data.response?.pagination, coverage: data.response?.coverage })}</output>; };
  const result = () => JSON.parse(screen.getByTestId('result').textContent!);
  const rendered = render(<App />);
  try {
    await waitFor(() => assert.equal(pending.length, 2));
    const local = pending.find(read => read.url.searchParams.get('phase') === 'local')!, remote = pending.find(read => read.url.searchParams.get('phase') === 'remote')!;
    await act(async () => local.resolve(response(local, 'Already connected', 'bG9jYWw')));
    await waitFor(() => assert.equal(result().items[0]?.description, 'Already connected'));
    assert.equal(result().status, 'ready'); assert.equal(result().updating, true, 'Local rows are usable while provider metadata is pending.');
    await act(async () => remote.resolve(response(remote, 'Provider description', 'cmVtb3Rl')));
    await waitFor(() => assert.equal(result().updating, false));
    assert.equal(result().items.length, 1, JSON.stringify(result())); assert.equal(result().items[0].description, 'Provider description', 'Remote metadata updates the same canonical identity.');
    const next = result().pagination.nextCursor;
    navigation = { ...navigation, extensionCursor: next }; rendered.rerender(<App />);
    await waitFor(() => assert.equal(pending.length, 4));
    assert.equal(pending[2].url.searchParams.get('cursor'), 'bG9jYWw'); assert.equal(pending[3].url.searchParams.get('cursor'), 'cmVtb3Rl');
    await act(async () => { pending[3].resolve(response(pending[3], 'Remote later page')); pending[2].resolve(response(pending[2], 'Local later page')); });
    await waitFor(() => assert.equal(result().updating, false));
    assert.equal(result().items[0].description, 'Remote later page', 'Completion order cannot replace richer remote metadata with an older local projection.');
    assert.equal(result().pagination.nextCursor, null);
    navigation = { ...navigation, extensionCursor: undefined }; epoch++; rendered.rerender(<App />);
    await waitFor(() => assert.equal(pending.length, 6));
    await act(async () => pending[4].resolve(response(pending[4], 'Local remains visible')));
    await act(async () => pending[5].resolve(Response.json({ success: false, code: 'PLUGIN_SEARCH_UNAVAILABLE' }, { status: 503 })));
    await waitFor(() => assert.equal(result().updating, false));
    assert.equal(result().items[0].description, 'Local remains visible'); assert(result().coverage.some((source: { status: string }) => source.status === 'unavailable'));
    epoch++; rendered.rerender(<App />); await waitFor(() => assert.equal(pending.length, 8));
    await act(async () => { sessionId = 'replacement-session'; rendered.rerender(<App />); }); await waitFor(() => assert.equal(pending.length, 10));
    assert(pending[6].signal?.aborted && pending[7].signal?.aborted); assert.equal(result().items.length, 0);
    await act(async () => { pending[6].resolve(response(pending[6], 'Forbidden old local')); pending[7].resolve(response(pending[7], 'Forbidden old remote')); });
    assert.equal(result().items.length, 0, 'Late responses from either phase cannot cross the actual session fence.');
    console.log('PASS actual progressive Plugin search hook: first local rows before remote completion, canonical merge independent of completion order, separate genuine phase cursors, provider failure preserving local rows and both-phase session cancellation.');
  } finally { cleanup(); loader._load = originalLoad; globalThis.fetch = originalFetch; dom.window.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
