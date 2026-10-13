import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import type { PluginNavigation } from '../app/lib/plugins/plugin-navigation';
import type { PluginExtensionItem, PluginExtensionSearchResponse } from '../app/lib/plugins/plugin-extension-contracts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/plugins', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Element', 'Node', 'MutationObserver', 'Event', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Actual search hook and mixed result UI. Only HTTP transport is controlled here.
async function main() {
  const originalFetch = globalThis.fetch;
  const { render, screen, cleanup, waitFor, act, fireEvent } = await import('@testing-library/react');
  const { usePluginExtensionSearch } = await import('../app/components/plugins/usePluginExtensionSearch');
  const { PluginExtensionSearchResults } = await import('../app/components/plugins/PluginExtensionSearchResults');
  type Pending = { url: URL; signal?: AbortSignal | null; resolve(response: Response): void };
  const pending: Pending[] = [];
  const item = (id: string, kind: PluginExtensionItem['kind'] = 'integration'): PluginExtensionItem => {
    const common = { id, name: id, displayName: id, description: 'Public metadata', stock: 'available' as const, access: { canRead: true, canUse: false, canManage: false } };
    return kind === 'integration' ? { ...common, kind, source: 'composio', toolkit: { slug: 'canva', noAuth: false }, connections: [] }
      : kind === 'mcp' ? { ...common, kind, source: 'mcp', mcp: { transport: 'unknown', template: true }, connections: [] }
        : { ...common, kind, source: 'local' };
  };
  const response = (items: PluginExtensionItem[], patch: Partial<PluginExtensionSearchResponse> = {}) => Response.json({ success: true,
    data: { schemaVersion: 1, query: { q: '', types: ['plugin', 'skill', 'integration', 'mcp'], stock: 'all', source: 'all', scope: 'all', audience: null, teamId: null, cursor: null, selected: null, limit: 20 },
      items, selectedItem: null, scopes: { choices: ['all', 'user', 'team', 'organization'], teams: [{ teamId: 'design', label: 'Design team' }] },
      coverage: [{ source: 'packages', status: 'complete' }, { source: 'composio', status: 'partial' }],
      pagination: { nextCursor: 'page-two', hasNextPage: true, loadedItems: items.length }, ...patch } });
  let navigation: PluginNavigation = { area: 'plugins', view: 'browse', scope: 'all' }, workspaceId = 'one', epoch = 0;
  const App = () => {
    const data = usePluginExtensionSearch({ navigation, workspaceId, epoch });
    return <NextIntlClientProvider locale="en" messages={en} timeZone="UTC"><output data-testid="selected">{data.selectedItem?.id ?? ''}</output>
      <output data-testid="coverage-state">{JSON.stringify(data.response?.coverage ?? [])}</output><output data-testid="pagination-state">{JSON.stringify(data.response?.pagination ?? {})}</output>
      <PluginExtensionSearchResults data={data} onOpen={() => {}} onMore={cursor => { navigation = { ...navigation, extensionCursor: cursor }; rendered.rerender(<App />); }} onRetry={data.retry} />
    </NextIntlClientProvider>;
  };
  globalThis.fetch = (input, init) => new Promise<Response>(resolve => {
    const url = new URL(String(input), dom.window.location.origin);
    assert.equal(url.pathname, '/api/plugins/search'); assert.equal(new Headers(init?.headers).get('x-canvas-workspace-id'), url.searchParams.get('workspaceId'));
    assert(!init?.method || init.method === 'GET'); pending.push({ url, signal: init?.signal, resolve });
  });
  const rendered = render(<App />);
  try {
    await waitFor(() => assert.equal(pending.length, 1));
    assert.equal(pending[0].url.searchParams.has('types'), false); assert.equal(pending[0].url.searchParams.get('scope'), 'all');
    await act(async () => pending[0].resolve(response([item('Plugin', 'plugin'), item('Skill', 'skill'), item('Canva'), item('MCP', 'mcp')], {
      coverage: [{ source: 'packages', status: 'complete' }, { source: 'store', status: 'unavailable', error: { code: 'STORE_UNAVAILABLE', message: 'Public error', retryable: true } }, { source: 'composio', status: 'partial' }],
    })));
    await screen.findByText('Canva'); assert.equal(screen.getAllByTestId('plugin-extension-row').length, 4);
    assert.equal(screen.getByTestId('plugin-extension-results').getAttribute('aria-busy'), 'false');
    assert.equal(screen.getAllByTestId('plugin-extension-coverage').length, 2);
    fireEvent.click(screen.getByTestId('plugin-extension-more'));
    await waitFor(() => assert.equal(pending.length, 2)); assert.equal(pending[1].url.searchParams.get('cursor'), 'page-two');
    assert(screen.getByText('Canva')); assert.equal(screen.getByTestId('plugin-extension-results').getAttribute('aria-busy'), 'true');
    await act(async () => pending[1].resolve(response([item('Canva'), item('GitHub')], {
      coverage: [{ source: 'composio', status: 'complete' }], pagination: { nextCursor: 'page-three', hasNextPage: true, loadedItems: 2, totalItems: 2 },
    })));
    await screen.findByText('GitHub'); assert.equal(screen.getAllByTestId('plugin-extension-row').length, 5, 'Overlapping source batches dedupe exact identities.');
    const coverage = JSON.parse(screen.getByTestId('coverage-state').textContent!);
    assert.equal(coverage.find((source: { source: string }) => source.source === 'packages').status, 'complete');
    assert.equal(coverage.find((source: { source: string }) => source.source === 'store').status, 'unavailable', 'Omitted sources cannot become healthy after another source completes.');
    assert.equal(coverage.find((source: { source: string }) => source.source === 'composio').status, 'complete');
    const pagination = JSON.parse(screen.getByTestId('pagination-state').textContent!);
    assert.equal(pagination.loadedItems, 5); assert.equal(pagination.totalItems, undefined, 'A later source batch total is not a global catalog total.');
    fireEvent.click(screen.getByTestId('plugin-extension-more')); await waitFor(() => assert.equal(pending.length, 3));
    await act(async () => pending[2].resolve(Response.json({ success: false, code: 'PLUGIN_SEARCH_UNAVAILABLE', error: 'PRIVATE_BODY' }, { status: 503 })));
    await screen.findByTestId('plugin-extension-page-error'); assert.equal(screen.getAllByTestId('plugin-extension-row').length, 5);
    assert.equal(screen.getByTestId('plugin-extension-results').getAttribute('aria-busy'), 'false'); assert(!document.body.textContent?.includes('PRIVATE_BODY'));
    fireEvent.click(screen.getAllByTestId('plugin-extension-retry')[0]); await waitFor(() => assert.equal(pending.length, 4));
    assert.equal(pending[3].url.searchParams.get('cursor'), 'page-three'); assert.equal(screen.getByTestId('plugin-extension-results').getAttribute('aria-busy'), 'true');
    await act(async () => pending[3].resolve(response([item('DuckDuckGo')], { coverage: [{ source: 'composio', status: 'complete' }], pagination: { nextCursor: null, hasNextPage: false, loadedItems: 1, totalItems: 1 } })));
    await screen.findByText('DuckDuckGo'); assert.equal(screen.getAllByTestId('plugin-extension-row').length, 6); assert.equal(screen.queryByTestId('plugin-extension-page-error'), null);
    assert.equal(JSON.parse(screen.getByTestId('pagination-state').textContent!).totalItems, undefined);

    navigation = { ...navigation, q: 'different', extensionCursor: undefined }; rendered.rerender(<App />);
    assert.equal(screen.queryByText('Canva'), null); await waitFor(() => assert.equal(pending.length, 5));
    workspaceId = 'two'; rendered.rerender(<App />); await waitFor(() => assert.equal(pending.length, 6)); assert.equal(pending[4].signal?.aborted, true);
    await act(async () => pending[5].resolve(response([item('Current workspace')]))); await screen.findByText('Current workspace');
    await act(async () => pending[4].resolve(response([item('Late old workspace')]))); assert.equal(screen.queryByText('Late old workspace'), null);
    navigation = { ...navigation, extensionId: 'composio:canva' }; rendered.rerender(<App />); assert.equal(screen.getByTestId('selected').textContent, '');
    await waitFor(() => assert.equal(pending.length, 7)); assert.equal(pending[6].url.searchParams.get('selected'), 'composio:canva'); assert.equal(pending[6].url.searchParams.get('q'), 'different');
    await act(async () => pending[6].resolve(response([item('Current workspace')], { selectedItem: item('composio:canva') })));
    await waitFor(() => assert.equal(screen.getByTestId('selected').textContent, 'composio:canva'));
    navigation = { ...navigation, extensionCursor: 'page-next' }; rendered.rerender(<App />); await waitFor(() => assert.equal(pending.length, 8));
    await act(async () => pending[7].resolve(Response.json({ success: false, code: 'PLUGIN_SEARCH_ACCESS_DENIED' }, { status: 403 })));
    await waitFor(() => assert.equal(screen.queryByText('Current workspace'), null)); assert.equal(screen.getByTestId('selected').textContent, '', 'Late access denial clears retained results and exact selection.');
    epoch += 1; rendered.rerender(<App />); await waitFor(() => assert.equal(pending.length, 9)); rendered.unmount(); assert.equal(pending[8].signal?.aborted, true);
    console.log('Plugin extension search React PASS: four-kind rows, partial source coverage, exact-ID batch dedupe, cumulative counts, safe retry preserving rows, selected projection, immediate context fences and late response/access denial. Controlled HTTP transport only.');
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
