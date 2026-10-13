import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import type { PluginNavigation } from '../app/lib/plugins/plugin-navigation';
import type { PluginWorkspaceCatalogItem, PluginWorkspaceCatalogResponse } from '../app/lib/plugins/plugin-workspace-catalog-contracts';
import type { CapabilityPackageStoreListResponse } from '../app/lib/capabilities/packages/store-contracts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/plugins', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Actual React hook; only browser transport is controlled to prove late-response rendering fences.
async function main() {
  const originalFetch = globalThis.fetch;
  const { render, screen, cleanup, waitFor, act } = await import('@testing-library/react');
  const { usePluginWorkspaceData } = await import('../app/components/plugins/usePluginWorkspaceData');
  type Pending = { url: URL; signal?: AbortSignal | null; resolve(response: Response): void };
  const pending: Pending[] = [];
  const response = (data: unknown) => Response.json({ success: true, data });
  const item = (name: string): PluginWorkspaceCatalogItem => ({ resourceRef: `canvas-resource:${name}`, legacyResourceId: `legacy-${name}`,
    kind: 'plugin', name, displayName: name, description: '', version: '1.0.0', revision: 1, ownership: { type: 'organization', organizationId: 'org' },
    access: { canRead: true, canUse: false, canEdit: false, canManage: false } });
  const catalog = (name: string): PluginWorkspaceCatalogResponse => ({ schemaVersion: 1,
    selection: { scope: 'organization', kind: null, audience: null, teamId: null, q: '', page: 1, limit: 20, selectionRequired: null }, items: [item(name)],
    scopes: { choices: ['user', 'team', 'organization'], teams: [{ teamId: 'design', label: 'Design team' }] },
    pagination: { page: 1, limit: 20, totalItems: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false } });
  const store = (): CapabilityPackageStoreListResponse => ({ schemaVersion: 1, selection: { ...catalog('a').selection, installedState: 'all' }, scopes: catalog('a').scopes,
    stores: [], installed: { resources: [], pagination: catalog('a').pagination,
      summary: { total: 0, updates: 0, modified: 0, unknown: 0, observed: 0, comparison: 'known' } } });
  let navigation: PluginNavigation = { area: 'plugins', view: 'installed', scope: 'user' }, workspaceId = 'one', epoch = 0;
  const App = () => {
    const value = usePluginWorkspaceData({ navigation, workspaceId, epoch });
    return <><output data-testid="state">{value.status}</output><output data-testid="error">{value.error ? `${value.error.code}:${value.error.message}` : ''}</output>
      <div>{value.catalog?.items.map(row => <p key={row.resourceRef}>{row.displayName}</p>)}</div><output data-testid="store">{value.store ? 'store-loaded' : ''}</output></>;
  };
  globalThis.fetch = (input, init) => new Promise<Response>(resolve => {
    assert(!init?.method || init.method === 'GET', 'The workspace data hook only reads SafeDTO metadata.');
    const url = new URL(String(input), dom.window.location.origin);
    assert(['/api/plugins/catalog', '/api/capabilities/packages/store'].includes(url.pathname));
    assert.equal(new Headers(init?.headers).get('x-canvas-workspace-id'), url.searchParams.get('workspaceId'));
    pending.push({ url, signal: init?.signal, resolve });
  });
  try {
    const rendered = render(<App />);
    await waitFor(() => assert.equal(pending.length, 1));
    assert.equal(pending[0].url.searchParams.has('kind'), false, 'Plugin area defaults to mixed all kinds.');
    assert.equal(pending[0].url.searchParams.get('audience'), 'own');
    await act(async () => pending[0].resolve(response(catalog('old-workspace'))));
    await screen.findByText('old-workspace'); assert.equal(screen.getByTestId('state').textContent, 'ready');
    epoch += 1; rendered.rerender(<App />);
    assert.equal(screen.queryByText('old-workspace'), null, 'An epoch refresh immediately clears prior visible rows.');
    await waitFor(() => assert.equal(pending.length, 2));
    workspaceId = 'two'; navigation = { ...navigation, scope: 'organization' }; rendered.rerender(<App />);
    assert.equal(screen.queryByText('old-workspace'), null);
    await waitFor(() => assert.equal(pending.length, 3));
    assert.equal(pending[1].signal?.aborted, true);
    await act(async () => pending[2].resolve(response(catalog('current-workspace'))));
    await screen.findByText('current-workspace');
    await act(async () => pending[1].resolve(response(catalog('late-old-response'))));
    assert.equal(screen.queryByText('late-old-response'), null, 'Late previous-workspace success cannot overwrite the current key.');

    const changes: Array<Partial<PluginNavigation>> = [
      { scope: 'team', teamId: 'design' }, { teamId: 'other-team' }, { scope: 'user', audience: 'shared' },
      { kind: 'skill' }, { q: 'narrow' }, { page: 3 },
    ];
    for (const [index, patch] of changes.entries()) {
      const before = pending.length;
      navigation = { ...navigation, ...patch }; rendered.rerender(<App />);
      assert.equal(screen.getByTestId('state').textContent, 'loading');
      assert.equal(screen.queryByText(index ? `selection-${index - 1}` : 'current-workspace'), null, 'Each scope/team/audience/kind/search/page selection clears prior rows before its response.');
      await waitFor(() => assert.equal(pending.length, before + 1));
      const request = pending[before];
      assert.equal(request.url.searchParams.get('scope'), navigation.scope);
      if (navigation.scope !== 'team') assert.equal(request.url.searchParams.has('teamId'), false);
      if (navigation.scope !== 'user') assert.equal(request.url.searchParams.has('audience'), false);
      await act(async () => request.resolve(response(catalog(`selection-${index}`))));
      await screen.findByText(`selection-${index}`);
    }
    const beforeUpdates = pending.length;
    navigation = { area: 'skills', view: 'updates', scope: 'organization', page: 3, q: 'design' }; rendered.rerender(<App />);
    assert.equal(screen.getByTestId('state').textContent, 'loading');
    await waitFor(() => assert.equal(pending.length, beforeUpdates + 2));
    const updateCatalog = pending.find((request, index) => index >= beforeUpdates && request.url.pathname === '/api/plugins/catalog')!;
    const updateStore = pending.find((request, index) => index >= beforeUpdates && request.url.pathname.endsWith('/store'))!;
    assert.equal(updateCatalog.url.searchParams.get('kind'), 'skill');
    assert.equal(updateStore.url.searchParams.get('installedState'), 'updates');
    assert.equal(updateStore.url.searchParams.get('installedPage'), '3'); assert.equal(updateStore.url.searchParams.get('page'), '1');
    await act(async () => updateCatalog.resolve(response(catalog('updates'))));
    assert.equal(screen.queryByText('updates'), null, 'Partial multi-response loads do not show an invented ready Store state.');
    await act(async () => updateStore.resolve(response(store()))); await screen.findByText('updates');
    assert.equal(screen.getByTestId('store').textContent, 'store-loaded');

    const beforeStoreError = pending.length; epoch += 1; rendered.rerender(<App />);
    assert.equal(screen.queryByText('updates'), null); await waitFor(() => assert.equal(pending.length, beforeStoreError + 2));
    await act(async () => {
      for (const request of pending.slice(beforeStoreError)) request.resolve(request.url.pathname.endsWith('/store')
        ? Response.json({ success: false, code: 'PACKAGE_SNAPSHOT_UNAVAILABLE', error: 'SECRET registry failure' }, { status: 503 })
        : response(catalog('current metadata despite Store failure')));
    });
    await screen.findByText('current metadata despite Store failure');
    assert.equal(screen.getByTestId('state').textContent, 'ready'); assert.equal(screen.getByTestId('store').textContent, '');
    assert(screen.getByTestId('error').textContent?.includes('PACKAGE_SNAPSHOT_UNAVAILABLE'));
    assert(!document.body.textContent?.includes('SECRET'));

    const beforeDetail = pending.length;
    navigation = { area: 'plugins', view: 'installed', scope: 'user', q: 'filtered-label', resourceRef: 'canvas-resource:exact' }; rendered.rerender(<App />);
    await waitFor(() => assert.equal(pending.length, beforeDetail + 2));
    const detailStore = pending.find((request, index) => index >= beforeDetail && request.url.pathname.endsWith('/store'))!;
    assert.equal(detailStore.url.searchParams.get('q'), '', 'Exact resource correlation stays independent of list search.');
    await act(async () => { for (const request of pending.slice(beforeDetail)) request.resolve(response(request.url.pathname.endsWith('/store') ? store() : catalog('detail'))); });
    await screen.findByText('detail');

    const beforeNamed = pending.length;
    navigation = { ...navigation, kind: 'all', plugin: 'actual-package-name', page: 3 }; rendered.rerender(<App />);
    assert.equal(screen.queryByText('detail'), null); await waitFor(() => assert.equal(pending.length, beforeNamed + 2));
    const namedStore = pending.find((request, index) => index >= beforeNamed && request.url.pathname.endsWith('/store'))!;
    assert.equal(namedStore.url.searchParams.get('q'), 'actual-package-name');
    assert.equal(namedStore.url.searchParams.get('kind'), 'plugin'); assert.equal(namedStore.url.searchParams.get('page'), '1');
    assert.equal(namedStore.url.searchParams.get('installedPage'), '1', 'An exact named detail from list page3 prioritizes matching metadata on Store page1.');
    await act(async () => { for (const request of pending.slice(beforeNamed)) request.resolve(response(request.url.pathname.endsWith('/store') ? store() : catalog('named-detail'))); });
    await screen.findByText('named-detail');

    const beforeError = pending.length; navigation = { ...navigation, resourceRef: undefined, scope: 'team', teamId: 'revoked' }; rendered.rerender(<App />);
    assert.equal(screen.queryByText('named-detail'), null); await waitFor(() => assert.equal(pending.length, beforeError + 1));
    await act(async () => pending[beforeError].resolve(Response.json({ success: false, code: 'PLUGIN_CATALOG_TEAM_NOT_FOUND', error: 'SECRET backend body' }, { status: 404 })));
    await waitFor(() => assert.equal(screen.getByTestId('state').textContent, 'error'));
    assert(screen.getByTestId('error').textContent?.includes('PLUGIN_CATALOG_TEAM_NOT_FOUND'));
    assert(!document.body.textContent?.includes('SECRET'));
    assert.equal(screen.getByTestId('store').textContent, '');
    const beforeBrowse = pending.length;
    navigation = { area: 'plugins', view: 'browse', scope: 'all', kind: 'integration' }; rendered.rerender(<App />);
    assert.equal(screen.getByTestId('state').textContent, 'ready'); assert.equal(screen.getByTestId('store').textContent, '');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.equal(pending.length, beforeBrowse, 'Common browsing does not duplicate its search with legacy package/Store requests.');
    navigation = { ...navigation, resourceRef: 'canvas-resource:exact' }; rendered.rerender(<App />);
    await waitFor(() => assert.equal(pending.length, beforeBrowse + 2));
    assert.equal(pending[beforeBrowse].url.searchParams.has('kind'), false, 'A cross-kind browse detail reads package data without passing an integration kind to the legacy API.');
    rendered.unmount(); assert(pending.slice(beforeBrowse).every(request => request.signal?.aborted));
    console.log('Plugin workspace data React PASS: selective GETs, immediate context/render fences, late-response denial, mixed kinds, update pagination, exact correlation and safe errors.');
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
