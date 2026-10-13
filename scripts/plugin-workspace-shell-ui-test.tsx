import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { useMemo, useState, useSyncExternalStore } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import type { PluginWorkspaceCatalogItem, PluginWorkspaceCatalogResponse } from '../app/lib/plugins/plugin-workspace-catalog-contracts';
import type { CapabilityPackageStoreListResponse } from '../app/lib/capabilities/packages/store-contracts';
import type { PackageDetailWorkspaceProps } from '../app/components/plugins/PackageDetailWorkspace';
import type { StorePackageWizardProps } from '../app/components/plugins/StorePackageWizard';
import type { PluginExtensionItem, PluginExtensionSearchResponse } from '../app/lib/plugins/plugin-extension-contracts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/en/plugins', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'localStorage', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement',
  'HTMLSelectElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
Object.defineProperty(globalThis, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
Object.defineProperty(dom.window, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.scrollTo = () => {};
class FixtureResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, 'ResizeObserver', { value: FixtureResizeObserver, configurable: true });

// Actual shell/navigation/history guard/data hook/rows. Controlled SafeDTO transport proves UI behavior, never server authority.
async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch, originalConfirm = window.confirm;
  const navigationEvent = 'plugin-shell-router-fixture', workspaceEvent = 'plugin-shell-workspace-fixture';
  const originalPush = window.history.pushState.bind(window.history), originalReplace = window.history.replaceState.bind(window.history);
  window.history.pushState = (...args) => { originalPush(...args); window.dispatchEvent(new Event(navigationEvent)); };
  window.history.replaceState = (...args) => { originalReplace(...args); window.dispatchEvent(new Event(navigationEvent)); };
  const subscribeNavigation = (callback: () => void) => { window.addEventListener(navigationEvent, callback); window.addEventListener('popstate', callback);
    return () => { window.removeEventListener(navigationEvent, callback); window.removeEventListener('popstate', callback); }; };
  const subscribeWorkspace = (callback: () => void) => { window.addEventListener(workspaceEvent, callback); return () => window.removeEventListener(workspaceEvent, callback); };
  let workspace = { initialized: true, activeWorkspaceId: 'own-workspace', organizationId: 'fixture-org',
    workspaces: [{ id: 'own-workspace', name: 'Own workspace' }, { id: 'other-readable', name: 'Other readable workspace' }, { id: 'new-workspace', name: 'New workspace' }] };
  const rejectsDirty = true;
  const confirmations: string[] = [], detailSelections: PackageDetailWorkspaceProps[] = [], wizardSelections: StorePackageWizardProps[] = [];
  function DetailBoundary(props: PackageDetailWorkspaceProps) {
    const [dirty, setDirty] = useState(false), [pending, setPending] = useState(false);
    useGuard({ dirty, pending }); detailSelections.push(props);
    return <section data-testid="shell-detail-boundary" data-dirty={dirty} data-pending={pending}><output data-testid="detail-ref">{props.resourceRef}</output><output data-testid="detail-workspace">{props.workspaceId}</output>
      <button type="button" onClick={props.onClose}>Back from exact detail</button><button type="button" onClick={() => setDirty(true)}>Make detail dirty</button>
      <button type="button" onClick={() => setPending(true)}>Make detail pending</button><button type="button" onClick={() => { setDirty(false); setPending(false); }}>Clear detail guard</button>
      <button type="button" onClick={() => props.onStoreUpdate({ kind: 'plugin', registryId: 'fixture-store', entryKey: 'design-bundle', version: '2.0.0', checksum: 'b'.repeat(64) },
        props.resourceRef === ownLegacyAlias ? ownRef : props.resourceRef)}>Open reviewed update</button>
    </section>;
  }
  function WizardBoundary(props: StorePackageWizardProps) {
    const [pending, setPending] = useState(false); useGuard({ dirty: false, pending }); wizardSelections.push(props);
    return <section data-testid="shell-wizard-boundary"><output data-testid="wizard-source">{JSON.stringify(props.source)}</output><output data-testid="wizard-workspace">{props.workspaceId}</output>
      <button type="button" onClick={props.onClose}>Close selected source</button><button type="button" onClick={() => setPending(true)}>Make wizard pending</button>
      <button type="button" onClick={() => setPending(false)}>Clear wizard guard</button></section>;
  }
  loader._load = (name, parent, isMain) => {
    if (name === 'next/navigation') return { useSearchParams: () => { const search = useSyncExternalStore(subscribeNavigation, () => window.location.search); return useMemo(() => new URLSearchParams(search), [search]); } };
    if (name === '@/app/store/workspace-store') return { useWorkspaceStore: (select: (value: typeof workspace) => unknown) => select(useSyncExternalStore(subscribeWorkspace, () => workspace)) };
    if (name === '@/i18n/navigation') return { Link: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(function FixtureLink(props, ref) { return <a {...props} ref={ref} />; }) };
    if (/\/(?:PluginWorkspace|PluginExtensionWorkspace)\.tsx$/u.test(parent?.filename ?? '') && /(?:^|\/)PackageDetailWorkspace(?:\.tsx)?$/u.test(name)) return { PackageDetailWorkspace: DetailBoundary };
    if (/\/(?:PluginWorkspace|PluginExtensionWorkspace)\.tsx$/u.test(parent?.filename ?? '') && /(?:^|\/)StorePackageWizard(?:\.tsx)?$/u.test(name)) return { StorePackageWizard: WizardBoundary };
    return originalLoad(name, parent, isMain);
  };
  window.confirm = value => { confirmations.push(value ?? ''); return !rejectsDirty; };
  const { render, screen, fireEvent, waitFor, cleanup, act } = await import('@testing-library/react');
  const { PluginNavigationGuard, usePluginEditorNavigationGuard: useGuard } = await import('../app/components/plugins/plugin-navigation-guard');
  const ownRef = 'canvas-resource:11111111-1111-4111-8111-111111111111', orgRef = 'canvas-resource:22222222-2222-4222-8222-222222222222';
  const ownLegacyAlias = 'canvas-capability:v1:plugin:user:fixture-user:standalone:design-bundle';
  const childRef = 'canvas-resource:33333333-3333-4333-8333-333333333333', teamRef = 'canvas-resource:44444444-4444-4444-8444-444444444444';
  const sourceRef = 'canvas-resource:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', draftRef = 'canvas-package-draft:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const item = (resourceRef: string, name: string, kind: 'plugin' | 'skill', owner: PluginWorkspaceCatalogItem['ownership']): PluginWorkspaceCatalogItem => ({ resourceRef, legacyResourceId: `legacy-${name}-${owner.type}`,
    kind, name, displayName: name === 'design-bundle' ? 'Design bundle' : name, description: 'Safe management metadata', version: '1.0.0', revision: 1, ownership: owner,
    access: { canRead: true, canUse: false, canEdit: false, canManage: false } });
  const rows = [item(ownRef, 'design-bundle', 'plugin', { type: 'user', ownerUserId: 'fixture-user', organizationId: 'fixture-org' }),
    item(orgRef, 'design-bundle', 'plugin', { type: 'organization', organizationId: 'fixture-org' }),
    { ...item(childRef, 'design-context', 'skill', { type: 'user', ownerUserId: 'fixture-user', organizationId: 'fixture-org' }), parentResourceRef: ownRef },
    item(teamRef, 'team-context', 'skill', { type: 'team', organizationId: 'fixture-org', workspaceId: 'readable-team' })];
  type Seen = { url: URL; init?: RequestInit };
  const requests: Seen[] = [];
  const authRequests: Array<{ path: string; method: string }> = [];
  const holds = new Map<string, { promise: Promise<void>; release(): void }>();
  let catalogError = false, storeError = false, omittedExtensionId: string | null = null;
  const hold = (key: string) => { let release!: () => void; holds.set(key, { promise: new Promise<void>(resolve => { release = resolve; }), release }); return release; };
  const success = (data: unknown) => Response.json({ success: true, data });
  const catalog = (url: URL): PluginWorkspaceCatalogResponse => {
    const scope = url.searchParams.get('scope') as PluginWorkspaceCatalogResponse['selection']['scope'], audience = url.searchParams.get('audience') as 'own' | 'shared' | null;
    let items = rows.filter(row => scope === 'user' ? audience === 'shared' ? row.ownership.type !== 'user' : row.ownership.type === 'user'
      : scope === 'organization' ? row.ownership.type === 'organization' : scope === 'team' ? url.searchParams.get('teamId') === 'readable-team' && row.ownership.type === 'team' : true);
    const kind = url.searchParams.get('kind') as 'plugin' | 'skill' | null, q = url.searchParams.get('q') ?? '', page = Number(url.searchParams.get('page')) || 1;
    items = items.filter(row => (!kind || row.kind === kind) && (!q || [row.name, row.displayName].some(value => value.includes(q))));
    const prefix = url.searchParams.get('workspaceId') === 'new-workspace' ? 'New workspace ' : '';
    const legacyLookup = url.searchParams.get('limit') === '50';
    return { schemaVersion: 1, selection: { scope, audience, teamId: url.searchParams.get('teamId'), kind, q, page, limit: 20, selectionRequired: scope === 'team' && !url.searchParams.get('teamId') ? 'team' : null },
      items: items.map(row => ({ ...row, displayName: prefix + row.displayName })), scopes: { choices: ['all', 'user', 'team', 'organization', 'system'], teams: [{ teamId: 'readable-team', label: 'Readable design team' }] },
      pagination: legacyLookup
        ? { page, limit: 50, totalItems: items.length, totalPages: items.length ? 1 : 0, hasNextPage: false, hasPreviousPage: false }
        : { page, limit: 20, totalItems: 21, totalPages: 2, hasNextPage: page < 2, hasPreviousPage: page > 1 } };
  };
  const store = (url: URL): CapabilityPackageStoreListResponse => {
    const current = catalog(url);
    const offeringLabel = `${url.searchParams.get('workspaceId') === 'new-workspace' ? 'New workspace ' : ''}${url.searchParams.get('scope') === 'organization' ? 'Organization ' : ''}Design offering`;
    return { schemaVersion: 1, selection: { ...current.selection, installedState: url.searchParams.get('installedState') === 'updates' ? 'updates' : 'all' }, scopes: current.scopes,
      stores: [{ kind: 'plugin', registry: { id: 'fixture-store', name: 'Store', updatedAt: 'today' }, availability: 'available',
        pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false }, installedResources: [],
        offerings: [{ kind: 'plugin', registryId: 'fixture-store', entryKey: 'design-bundle', displayName: offeringLabel, description: 'Safe public offering', latestVersion: '2.0.0',
          versions: [{ version: '2.0.0', checksum: 'b'.repeat(64), notes: 'Current source release two' },
            { version: '1.0.0', checksum: 'a'.repeat(64), notes: 'Current source release one' }], installedResourceRefs: [], installedRefsTruncated: false }] }],
      installed: { resources: [], pagination: { ...current.pagination, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false },
        summary: { total: 21, updates: 0, modified: 0, unknown: 21, observed: 0, comparison: 'unknown' } } };
  };
  const extensions = (url: URL): PluginExtensionSearchResponse => {
    const current = catalog(url), types = url.searchParams.get('types')?.split(','), stock = url.searchParams.get('stock'), source = url.searchParams.get('source');
    const packages: PluginExtensionItem[] = current.items.map(value => ({ id: value.resourceRef, kind: value.kind, name: value.name,
      displayName: value.displayName, description: value.description, source: 'local', stock: 'installed', ownership: value.ownership,
      access: { canRead: value.access.canRead, canUse: value.access.canUse, canManage: value.access.canManage }, package: value }));
    const offerings: PluginExtensionItem[] = store(url).stores.flatMap(value => value.offerings.map(offer => ({ id: `store:${offer.kind}:${offer.registryId}:${offer.entryKey}`,
      kind: offer.kind, name: offer.entryKey, displayName: offer.displayName, description: offer.description, source: 'store', stock: 'available',
      access: { canRead: true, canUse: false, canManage: false }, offering: offer })));
    const standalone: PluginExtensionItem[] = [{ id: 'composio:canva', kind: 'integration', name: 'canva', displayName: 'Canva integration', description: 'Provider catalog metadata',
      source: 'composio', stock: 'available', access: { canRead: true, canUse: false, canManage: false }, toolkit: { slug: 'canva', noAuth: false }, connections: [] },
    { id: 'mcp-definition:99999999-9999-4999-8999-999999999999', kind: 'mcp', name: 'Canva MCP', displayName: 'Canva MCP', description: 'Approved server',
      source: 'mcp', stock: 'available', access: { canRead: true, canUse: false, canManage: false }, mcp: { template: true, transport: 'http' }, connections: [] }];
    const q = url.searchParams.get('q') ?? '';
    const candidates = [...packages, ...offerings, ...standalone];
    const items = candidates.filter(value => value.id !== omittedExtensionId && (!types || types.includes(value.kind)) && (!stock || stock === 'all' || value.stock === stock)
      && (!source || source === 'all' || value.source === source) && (!q || `${value.name} ${value.displayName}`.toLowerCase().includes(q.toLowerCase())));
    return { schemaVersion: 1, query: { q, types: (types ?? ['plugin', 'skill', 'integration', 'mcp']) as PluginExtensionSearchResponse['query']['types'],
      stock: (stock ?? 'all') as PluginExtensionSearchResponse['query']['stock'], source: (source ?? 'all') as PluginExtensionSearchResponse['query']['source'],
      scope: current.selection.scope, audience: current.selection.audience, teamId: current.selection.teamId, cursor: null, selected: url.searchParams.get('selected'), limit: 20 },
      items, selectedItem: candidates.find(value => value.id === url.searchParams.get('selected')) ?? null, scopes: current.scopes,
      coverage: [{ source: 'packages', status: 'complete' }, { source: 'store', status: storeError ? 'unavailable' : 'complete' }, { source: 'composio', status: 'complete' }, { source: 'mcp', status: 'complete' }],
      pagination: { nextCursor: null, hasNextPage: false, loadedItems: items.length, totalItems: items.length } };
  };
  const uiSession = { user: { id: 'fixture-user', name: 'Fixture user', email: 'fixture@example.test', emailVerified: true, image: null,
    createdAt: new Date(0), updatedAt: new Date(0), role: 'user', banned: false },
  session: { id: 'fixture-shell-session', token: 'CONTROLLED_UI_IDENTITY_ONLY', userId: 'fixture-user', expiresAt: new Date('2099-01-01'), createdAt: new Date(0), updatedAt: new Date(0) } };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/auth/get-session') {
      assert.equal(url.origin, window.location.origin); assert.equal(init?.method ?? 'GET', 'GET');
      authRequests.push({ path: url.pathname, method: init?.method ?? 'GET' }); return Response.json(uiSession);
    }
    requests.push({ url, init });
    const pathname = decodeURIComponent(url.pathname);
    const workspaceId = url.searchParams.get('workspaceId'); assert(workspaceId);
    if (url.pathname === '/api/plugins/search') {
      assert.equal(new Headers(init?.headers).get('x-canvas-workspace-id'), workspaceId);
      const payload = extensions(url); await holds.get(`${url.pathname}:${workspaceId}:${url.searchParams.get('scope')}`)?.promise;
      return success(payload);
    }
    if (url.pathname === '/api/plugins/catalog' || url.pathname === '/api/capabilities/packages/store') {
      assert.equal(new Headers(init?.headers).get('x-canvas-workspace-id'), workspaceId);
      const payload = url.pathname.endsWith('/catalog') ? catalog(url) : store(url);
      const failed = url.pathname.endsWith('/catalog') ? catalogError : storeError;
      const requestKey = `${url.pathname}:${workspaceId}:${url.searchParams.get('scope')}`;
      await (url.searchParams.get('limit') === '50' ? holds.get(`${requestKey}:legacy:${url.searchParams.get('q')}`) : undefined)?.promise;
      await holds.get(requestKey)?.promise;
      return failed ? Response.json({ success: false, code: 'PACKAGE_SNAPSHOT_UNAVAILABLE', error: 'PRIVATE_BACKEND_BODY' }, { status: 503 }) : success(payload);
    }
    if (url.pathname === '/api/capabilities/packages/drafts') return success({ drafts: [{ draftRef, resourceRef: sourceRef, sourceResourceRef: sourceRef,
      kind: 'plugin', name: 'Private draft after source removal', operation: 'edit', draftRevision: 1, targetOwnership: { type: 'organization', organizationId: 'fixture-org' }, createdAt: 1, updatedAt: 1 }], nextCursor: null });
    if (pathname.endsWith(`/${draftRef}/status`)) return success({ status: { draftRef, resourceRef: sourceRef, sourceResourceRef: sourceRef, kind: 'plugin', name: 'Private draft after source removal',
      operation: 'edit', draftRevision: 1, targetOwnership: { type: 'organization', organizationId: 'fixture-org' }, createdAt: 1, updatedAt: 1 } });
    if (pathname === `/api/capabilities/packages/${sourceRef}`) return Response.json({ success: false, code: 'PACKAGE_ACCESS_DENIED' }, { status: 403 });
    throw new Error(`Unexpected UI metadata endpoint: ${url.pathname}`);
  };
  // Actual BetterAuth useSession and session atom, with a controlled authenticated HTTP transport.
  const { PluginWorkspace } = await import('../app/components/plugins/PluginWorkspace');
  const App = ({ locale = 'en' }: { locale?: 'en' | 'de' }) => <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : de} timeZone="UTC">
    <PluginNavigationGuard unsavedChangesMessage={(locale === 'en' ? en : de).skills.drafts.unsavedNavigation} /><PluginWorkspace canManageOrganizationCapabilities={false} />
  </NextIntlClientProvider>;
  const setHref = async (search: string) => { await act(async () => { window.history.pushState(null, '', `/en/plugins${search ? `?${search}` : ''}`); }); };
  const waitRows = async () => { await screen.findByTestId('plugin-extension-results'); await waitFor(() => assert.equal(screen.getByTestId('plugin-extension-results').getAttribute('aria-busy'), 'false')); };
  const refreshButton = () => screen.getByRole('button', { name: screen.queryByTestId('plugin-extension-search-input') ? en.skills.workspace.catalog.refresh : en.skills.workspace.shell.refresh });
  const openRow = (ref: string) => { const row = screen.getAllByTestId('plugin-extension-row-open').find(button => button.getAttribute('data-extension-id') === ref); assert(row); fireEvent.click(row); };
  const scope = async (value: string, audience?: string) => {
    if (!screen.queryByTestId('plugin-extension-scope-filter')) fireEvent.click(screen.getByTestId('plugin-extension-filter-toggle'));
    fireEvent.change(screen.getByTestId('plugin-extension-scope-filter'), { target: { value } }); await waitRows();
    if (audience) { fireEvent.change(screen.getByTestId('plugin-extension-audience-filter'), { target: { value: audience } }); await waitRows(); }
  };
  const { authClient } = await import('../app/lib/auth-client');
  const sessionAtom = authClient.$store.atoms.session, originalSession = sessionAtom.get();
  try {
    const rendered = render(<App />);
    await waitRows(); assert.equal(new URLSearchParams(window.location.search).get('view'), null);
    assert.deepEqual([...new Set(screen.getAllByTestId('plugin-extension-row').map(row => row.getAttribute('data-kind')))].sort(), ['integration', 'mcp', 'plugin', 'skill']);
    assert.equal(screen.getAllByRole('searchbox').length, 1); assert.equal(screen.getByTestId('plugin-extension-search-input').getAttribute('maxlength'), '512');
    assert.equal(screen.queryByTestId('plugin-extension-stock-filter'), null, 'Progressive disclosure keeps advanced filters collapsed initially.');
    assert.equal(requests.some(request => request.url.pathname === '/api/plugins/catalog' || request.url.pathname.endsWith('/store')), false, 'Default browse uses only the unified metadata endpoint.');
    await scope('organization'); assert(screen.getByRole('button', { name: 'Open Design bundle' }));
    await scope('team'); assert(screen.getByTestId('plugin-extension-team-filter'));
    assert.equal(screen.queryByRole('option', { name: 'Private team' }), null);
    fireEvent.change(screen.getByTestId('plugin-extension-team-filter'), { target: { value: 'readable-team' } }); await waitRows();
    assert.equal(new URLSearchParams(window.location.search).get('teamId'), 'readable-team'); assert(screen.getByRole('button', { name: 'Open team-context' }));
    await scope('user', 'own');
    const input = screen.getByTestId('plugin-extension-search-input'); input.focus(); fireEvent.change(input, { target: { value: 'design' } });
    await waitFor(() => assert.equal(new URLSearchParams(window.location.search).get('q'), 'design')); await waitRows();
    assert.equal(document.activeElement, input, 'Debounced query navigation retains the one search input and its focus.');
    fireEvent.click(screen.getByTestId('plugin-extension-kind-plugin')); await waitRows(); assert.equal((input as HTMLInputElement).value, 'design');
    fireEvent.change(screen.getByTestId('plugin-extension-stock-filter'), { target: { value: 'installed' } }); await waitRows();
    fireEvent.change(screen.getByTestId('plugin-extension-source-filter'), { target: { value: 'all' } });
    await setHref(`${window.location.search.slice(1)}&extensionCursor=cursor-fixture`); await waitRows();
    openRow(ownRef); await screen.findByTestId('shell-detail-boundary'); assert.equal(detailSelections.at(-1)?.resourceRef, ownRef);
    assert.equal(new URLSearchParams(window.location.search).get('extensionCursor'), 'cursor-fixture', 'Opening an exact package from a later catalog batch preserves its list cursor.');
    assert.equal(screen.getAllByRole('searchbox').length, 1); assert(screen.getByTestId('plugin-extension-back'));
    await waitFor(() => assert.equal((refreshButton() as HTMLButtonElement).disabled, false));
    fireEvent.click(screen.getByRole('button', { name: 'Make detail dirty' }));
    const dirtyRequests = requests.length, dirtyConfirms = confirmations.length, dirtyHref = window.location.href;
    fireEvent.click(refreshButton());
    fireEvent.click(screen.getByTestId('plugin-extension-back'));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.equal(requests.length, dirtyRequests); assert.equal(confirmations.length, dirtyConfirms + 2); assert.equal(window.location.href, dirtyHref);
    assert.equal(screen.getByTestId('shell-detail-boundary').getAttribute('data-dirty'), 'true');
    await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 40)); });
    await waitFor(() => assert.equal(window.location.href, dirtyHref)); assert(screen.getByTestId('shell-detail-boundary'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear detail guard' })); fireEvent.click(screen.getByTestId('plugin-extension-back')); await waitRows();
    assert.equal((screen.getByTestId('plugin-extension-search-input') as HTMLInputElement).value, 'design');
    assert.equal((document.activeElement as HTMLElement).getAttribute('data-extension-id'), ownRef, 'Back restores focus to the exact originating row.');

    // A detail refresh can still be pending when Back renders its list skeleton.
    // Restore focus only once that same-context response is ready; fall back when the row disappeared.
    for (const removed of [false, true]) {
      openRow(ownRef); await screen.findByTestId('shell-detail-boundary');
      await waitFor(() => assert.equal((refreshButton() as HTMLButtonElement).disabled, false));
      const beforeRefresh = requests.length, releaseFocus = hold('/api/plugins/search:own-workspace:user');
      omittedExtensionId = removed ? ownRef : null;
      fireEvent.click(refreshButton());
      await waitFor(() => assert(requests.slice(beforeRefresh).some(request => request.url.pathname === '/api/plugins/search')));
      const back = screen.getByTestId('plugin-extension-back'); back.focus(); fireEvent.click(back);
      await screen.findByTestId('plugin-extension-results'); assert.equal(screen.getByTestId('plugin-extension-results').getAttribute('aria-busy'), 'true');
      assert.equal(screen.queryByTestId('plugin-extension-row'), null);
      await act(async () => releaseFocus()); holds.clear(); await waitRows();
      await waitFor(() => assert.equal(removed ? document.activeElement : (document.activeElement as HTMLElement).getAttribute('data-extension-id'),
        removed ? screen.getByTestId('plugin-extension-search-input') : ownRef,
        removed ? 'Back falls back to search when the refreshed stock no longer includes its original row.' : 'Back restores the row focus after a delayed refresh, beyond the initial skeleton render.'));
    }
    omittedExtensionId = null;
    await scope('user', 'shared'); openRow(orgRef); await screen.findByTestId('shell-detail-boundary'); assert.equal(detailSelections.at(-1)?.resourceRef, orgRef);
    await waitFor(() => assert.equal((refreshButton() as HTMLButtonElement).disabled, false));
    fireEvent.click(screen.getByRole('button', { name: 'Make detail pending' }));
    const pendingRequests = requests.length, pendingConfirms = confirmations.length, pendingHref = window.location.href;
    fireEvent.click(refreshButton()); fireEvent.click(screen.getByTestId('plugin-extension-kind-skill'));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.equal(requests.length, pendingRequests); assert.equal(confirmations.length, pendingConfirms); assert.equal(window.location.href, pendingHref);
    fireEvent.click(screen.getByRole('button', { name: 'Clear detail guard' })); fireEvent.click(screen.getByTestId('plugin-extension-back')); await waitRows();
    await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 20)); });
    await screen.findByTestId('shell-detail-boundary'); assert.equal(detailSelections.at(-1)?.resourceRef, orgRef);
    await act(async () => { window.history.forward(); await new Promise(resolve => setTimeout(resolve, 20)); }); await waitRows();

    // Ordinary legacy list links resolve to the common catalog, keeping query and selected kind.
    await setHref('view=installed&q=design'); await waitRows();
    assert.equal(new URLSearchParams(window.location.search).get('view'), 'browse'); assert.equal(new URLSearchParams(window.location.search).get('stock'), 'installed');
    assert.equal((screen.getByTestId('plugin-extension-search-input') as HTMLInputElement).value, 'design');
    await setHref('area=skills&view=library&q=design'); await waitRows();
    assert.equal(new URLSearchParams(window.location.search).get('kind'), 'skill'); assert.equal(new URLSearchParams(window.location.search).get('stock'), 'available');
    fireEvent.click(screen.getByTestId('plugin-extension-kind-all')); await waitRows(); assert.equal(new URLSearchParams(window.location.search).get('q'), 'design');

    // Old name/alias links retain their actual exact-ref resolver and never guess an instance.
    await setHref('view=installed&plugin=design-bundle&source=installed'); await screen.findByTestId('shell-detail-boundary');
    assert.equal(detailSelections.at(-1)?.resourceRef, ownRef);
    const uniqueLookup = requests.findLast(request => request.url.searchParams.get('limit') === '50');
    assert.equal(uniqueLookup?.url.pathname, '/api/plugins/catalog'); assert.equal(uniqueLookup?.url.searchParams.get('kind'), 'plugin');
    fireEvent.click(screen.getByRole('button', { name: 'Back from exact detail' })); await waitRows();
    const beforeAmbiguous = detailSelections.length;
    await setHref('view=installed&scope=all&plugin=design-bundle&source=installed'); await screen.findByText(en.skills.workspace.shell.chooseVariant);
    assert.equal(screen.queryByTestId('shell-detail-boundary'), null); assert.equal(detailSelections.length, beforeAmbiguous);
    fireEvent.click(screen.getByRole('button', { name: en.skills.workspace.shell.showVariants })); await waitRows();
    assert.equal(screen.getAllByRole('button', { name: 'Open Design bundle' }).length, 2); assert.equal(new URLSearchParams(window.location.search).get('resourceRef'), null);
    const beforeAbsent = detailSelections.length;
    await setHref('view=installed&scope=all&plugin=missing-package&source=installed'); await screen.findByText(en.skills.workspace.shell.accessError);
    assert.equal(screen.queryByTestId('shell-detail-boundary'), null); assert.equal(detailSelections.length, beforeAbsent);
    const releaseLegacy = hold('/api/plugins/catalog:own-workspace:user:legacy:design-bundle');
    await setHref('view=installed&plugin=design-bundle&source=installed');
    await waitFor(() => assert(requests.findLast(request => request.url.searchParams.get('limit') === '50' && request.url.searchParams.get('scope') === 'user')));
    const delayedLegacy = requests.findLast(request => request.url.searchParams.get('limit') === '50' && request.url.searchParams.get('scope') === 'user')!;
    assert.equal(screen.queryByTestId('shell-detail-boundary'), null);
    await setHref('view=installed&scope=organization&plugin=design-bundle&source=installed'); await screen.findByTestId('shell-detail-boundary');
    assert.equal(detailSelections.at(-1)?.resourceRef, orgRef); const afterNewScope = detailSelections.length;
    await act(async () => releaseLegacy()); holds.clear(); assert.equal(delayedLegacy.init?.signal?.aborted, true);
    assert(detailSelections.slice(afterNewScope).every(selection => selection.resourceRef === orgRef));

    // Store compatibility links preserve the immutable registry/version/checksum selection.
    await setHref('view=discover&plugin=design-bundle&source=store'); await screen.findByTestId('shell-wizard-boundary');
    const source = { kind: 'plugin', registryId: 'fixture-store', entryKey: 'design-bundle', version: '2.0.0', checksum: 'b'.repeat(64) };
    assert.deepEqual(wizardSelections.at(-1)?.source, source); assert.equal(wizardSelections.at(-1)?.releaseNotes, 'Current source release two');
    const picker = await screen.findByRole('combobox', { name: en.skills.workspace.shell.version });
    fireEvent.change(picker, { target: { value: '1.0.0' } });
    await waitFor(() => assert.deepEqual(wizardSelections.at(-1)?.source, { ...source, version: '1.0.0', checksum: 'a'.repeat(64) }));
    assert.equal(wizardSelections.at(-1)?.releaseNotes, 'Current source release one');
    for (const pinned of [{ ...source, registryId: 'another-fixture-store' }, { ...source, checksum: 'c'.repeat(64) }]) {
      await setHref(`view=discover&plugin=design-bundle&source=store&storeRegistryId=${pinned.registryId}&storeVersion=${pinned.version}&storeChecksum=${pinned.checksum}`);
      await waitFor(() => assert.deepEqual(wizardSelections.at(-1)?.source, pinned));
      assert.equal(screen.queryByRole('combobox', { name: en.skills.workspace.shell.version }), null); assert.equal(wizardSelections.at(-1)?.releaseNotes, undefined);
    }
    await setHref(`view=discover&plugin=design-bundle&source=store&storeRegistryId=${source.registryId}&storeVersion=${source.version}&storeChecksum=${source.checksum}`);
    await screen.findByRole('combobox', { name: en.skills.workspace.shell.version });
    rendered.unmount(); const refreshed = render(<App />); await screen.findByTestId('shell-wizard-boundary'); assert.deepEqual(wizardSelections.at(-1)?.source, source);
    fireEvent.click(screen.getByRole('button', { name: 'Make wizard pending' })); const sourceHref = window.location.href;
    fireEvent.click(await screen.findByTestId('plugin-workspace-scope-organization')); assert.equal(window.location.href, sourceHref);
    fireEvent.click(screen.getByRole('button', { name: 'Clear wizard guard' })); fireEvent.click(screen.getByRole('button', { name: 'Close selected source' })); await waitRows();

    await setHref('view=installed&scope=organization&workspaceId=other-readable'); await waitRows(); assert(screen.getByText('Workspace: Other readable workspace'));
    openRow(orgRef); await screen.findByTestId('shell-detail-boundary'); assert.equal(detailSelections.at(-1)?.workspaceId, 'other-readable');
    fireEvent.click(screen.getByRole('button', { name: 'Open reviewed update' })); await screen.findByTestId('shell-wizard-boundary');
    assert.equal(wizardSelections.at(-1)?.workspaceId, 'other-readable'); assert.equal(wizardSelections.at(-1)?.resourceRef, orgRef);
    fireEvent.click(screen.getByRole('button', { name: 'Make wizard pending' })); const updateHref = window.location.href;
    fireEvent.click(screen.getByTestId('plugin-extension-back')); assert.equal(window.location.href, updateHref);
    assert(screen.getByTestId('shell-wizard-boundary'), 'Denied common Back must retain the active update wizard, including its pending state.');
    fireEvent.click(screen.getByRole('button', { name: 'Clear wizard guard' }));
    await scope('user'); assert.equal(screen.queryByTestId('shell-wizard-boundary'), null, 'Changing scope drops the previous selected update.');
    const explicit = requests.filter(request => request.url.searchParams.get('workspaceId') === 'other-readable'); assert(explicit.length > 0);
    assert(explicit.every(request => new Headers(request.init?.headers).get('x-canvas-workspace-id') === 'other-readable'));
    await setHref(`view=installed&resourceRef=${encodeURIComponent(ownLegacyAlias)}`); await screen.findByTestId('shell-detail-boundary');
    fireEvent.click(screen.getByRole('button', { name: 'Open reviewed update' })); await screen.findByTestId('shell-wizard-boundary');
    assert.equal(wizardSelections.at(-1)?.resourceRef, ownRef); assert.equal(new URLSearchParams(window.location.search).get('resourceRef'), ownLegacyAlias);
    fireEvent.click(screen.getByRole('button', { name: 'Close selected source' })); await screen.findByTestId('shell-detail-boundary');
    fireEvent.click(screen.getByRole('button', { name: 'Back from exact detail' })); await waitRows();

    // Late old workspace/scope and actor-session responses must never repaint the current catalog.
    await setHref('view=browse&stock=available&scope=user'); await waitRows();
    const releaseOld = hold('/api/plugins/search:own-workspace:user'); fireEvent.click(refreshButton());
    await waitFor(() => assert(requests.at(-1)?.url.pathname === '/api/plugins/search'));
    await act(async () => { workspace = { ...workspace, activeWorkspaceId: 'new-workspace' }; window.dispatchEvent(new Event(workspaceEvent)); });
    await screen.findByRole('button', { name: 'Open New workspace Design offering' });
    await act(async () => releaseOld()); holds.clear(); assert.equal(screen.queryByRole('button', { name: 'Open Design offering' }), null);
    const releaseScope = hold('/api/plugins/search:new-workspace:user'); fireEvent.click(refreshButton());
    await waitFor(() => assert(requests.at(-1)?.url.searchParams.get('scope') === 'user'));
    await setHref('view=browse&stock=available&scope=organization'); await screen.findByRole('button', { name: 'Open New workspace Organization Design offering' });
    await act(async () => releaseScope()); holds.clear(); assert.equal(screen.queryByRole('button', { name: 'Open New workspace Design offering' }), null);
    const releaseActor = hold('/api/plugins/search:new-workspace:organization'); fireEvent.click(refreshButton());
    await waitFor(() => assert(requests.at(-1)?.url.searchParams.get('scope') === 'organization'));
    const oldActorRequest = requests.at(-1)!;
    await act(async () => sessionAtom.set({ ...sessionAtom.get(), data: null, error: null, isPending: false, isRefetching: false }));
    await screen.findByText(en.skills.workspace.shell.accessError); assert.equal(screen.queryByTestId('plugin-extension-row'), null);
    await act(async () => releaseActor()); holds.clear(); assert.equal(oldActorRequest.init?.signal?.aborted, true); assert.equal(screen.queryByTestId('plugin-extension-row'), null);
    await act(async () => sessionAtom.set({ ...sessionAtom.get(), data: { ...uiSession, session: { ...uiSession.session, id: 'new-fixture-shell-session' } }, error: null, isPending: false, isRefetching: false }));
    await waitRows();

    // Secondary Update/Draft workflows retain partial Store metadata and blocked source recovery.
    await setHref('view=updates&scope=organization'); await screen.findByTestId('plugin-workspace-update-summary');
    assert.equal(screen.getByTestId('plugin-workspace-view-updates').textContent, en.skills.workspace.shell.view_updates);
    storeError = true; fireEvent.click(refreshButton());
    await screen.findByText('The Store comparison is unavailable. Your installed packages remain accessible.');
    fireEvent.keyDown(screen.getByTestId('plugin-workspace-view-installed'), { key: 'Enter' }); await waitRows();
    assert(screen.getByRole('button', { name: 'Open New workspace Design bundle' })); assert(!document.body.textContent?.includes('PRIVATE_BACKEND_BODY')); storeError = false;
    catalogError = true; await setHref('view=drafts&scope=organization');
    await screen.findByText('Private draft after source removal'); fireEvent.click(screen.getByRole('button', { name: en.skills.drafts.open }));
    await screen.findByText(en.skills.packageEditor.accessError); assert(screen.getByTestId('package-discard')); assert(screen.getByRole('button', { name: en.skills.packageEditor.discard }));
    assert.equal(screen.queryByTestId('package-file-content'), null);
    assert.equal(requests.some(request => decodeURIComponent(request.url.pathname).endsWith(`/${draftRef}/tree`) || decodeURIComponent(request.url.pathname).endsWith(`/${draftRef}/file`)), false);
    assert(requests.filter(request => request.url.pathname.includes('/drafts')).every(request => request.url.searchParams.get('workspaceId') === 'new-workspace'));
    assert.equal(requests.some(request => /mcp|composio|accounts|toolkits|env/u.test(request.url.pathname)), false, 'Catalog shell has no direct provider/secret/runtime calls.');
    catalogError = false; await setHref('view=browse'); await waitRows(); refreshed.rerender(<App locale="de" />);
    await screen.findByRole('heading', { name: de.skills.workspace.catalog.title, level: 1 }); assert(screen.getByTestId('plugin-extension-kind-integration'));
    assert(authRequests.length > 0); assert(authRequests.every(request => request.path === '/api/auth/get-session' && request.method === 'GET'));
    console.log('Plugin workspace shell React/history/Intl PASS: one four-kind search, collapsed filters, debounce/focus, typed inventory and legacy-list migration, readonly Org/Team, exact/unique/ambiguous/missing/late legacy identities, dirty/pending Back and Refresh, immutable source tuples, explicit workspace/actor fences, partial Update metadata and blocked private-draft recovery. Controlled HTTP transport only; no server-authority or responsive-browser claims.');
  } finally {
    for (const value of holds.values()) value.release(); cleanup(); sessionAtom.set(originalSession); loader._load = originalLoad; globalThis.fetch = originalFetch; window.confirm = originalConfirm; dom.window.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
